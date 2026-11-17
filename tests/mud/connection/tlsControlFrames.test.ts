// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';

/** Minimal stand-in for the browser WebSocket. Unlike the other suites' mock
 *  this one can deliver *text* frames too, which is the proxy control channel. */
class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    sent: Uint8Array[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send(bytes: Uint8Array) { this.sent.push(bytes); }
    close() { this.readyState = MockWebSocket.CLOSED; }

    /** A binary frame — i.e. real game bytes. */
    deliverBinary(byteString: string) {
        const buf = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) buf[i] = byteString.charCodeAt(i) & 0xff;
        this.onmessage?.({ data: buf.buffer });
    }
    /** A text frame — i.e. a proxy control message. */
    deliverControl(payload: unknown) {
        this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }
    closeWith(ev: { code?: number; reason?: string; wasClean?: boolean } = {}) {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code: ev.code ?? 1006, reason: ev.reason ?? '', wasClean: ev.wasClean ?? false });
    }
}

const TLS_URL = 'ws://proxy.invalid/?host=mud.example.org&port=4443&tls=1';
const PLAIN_URL = 'ws://proxy.invalid/?host=mud.example.org&port=23';
const OFFER = { type: 'session.offer', offerId: 'offer-1' };
/** A session the mock relay took over from cursors (0, 0). */
const MARKER = { type: 'session.enabled', sessionId: 'session-1', secret: 'c2VjcmV0', input: '0', output: '0' };
const RESUMED = { type: 'session.resumed', input: '0', backendConnected: false };

describe('proxy TLS control frames', () => {
    let realWebSocket: unknown;
    let realAddEventListener: unknown;

    beforeEach(() => {
        realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
        realAddEventListener = (globalThis as Record<string, unknown>).addEventListener;
        (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
        (globalThis as Record<string, unknown>).addEventListener = () => {};
        MockWebSocket.instances = [];
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
        (globalThis as Record<string, unknown>).addEventListener = realAddEventListener;
    });

    function connected(url = TLS_URL) {
        const bus = new EventBus<MudClientEvents>();
        const client = new MudClient({ url }, bus);
        client.connect();
        const sock = MockWebSocket.instances[0];
        sock.onopen?.({});
        return { client, sock, bus };
    }

    function retain(sock: MockWebSocket): void {
        sock.deliverControl(OFFER);
        sock.deliverControl(MARKER);
    }

    function resume(client: MudClient): MockWebSocket {
        client.resumeTransport();
        const dial = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        dial.onopen?.({});
        dial.deliverControl(RESUMED);
        return dial;
    }

    it('emits tls.established from a control frame, with the cert details', () => {
        const { sock, bus } = connected();
        const seen: unknown[] = [];
        bus.on('tls.established', (info) => seen.push(info));

        sock.deliverControl({
            type: 'tls.established',
            protocol: 'TLSv1.3',
            cipher: 'TLS_AES_256_GCM_SHA384',
            cert: { subject: 'mud.example.org', issuer: 'Example CA', validTo: 'Jan 1 2027', serial: 'AB12' },
            acceptedDespite: [],
            unsupportedOptions: [],
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            protocol: 'TLSv1.3',
            certInspection: true,
            acceptedDespite: [],
        });
        expect((seen[0] as { cert: { issuer: string } }).cert.issuer).toBe('Example CA');
    });

    it('reports tolerated faults so the UI can say "encrypted but unverified"', () => {
        const { sock, bus } = connected();
        let info: { acceptedDespite: string[] } | null = null;
        bus.on('tls.established', (i) => { info = i as typeof info; });

        sock.deliverControl({
            type: 'tls.established',
            cert: null,
            acceptedDespite: ['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED'],
        });

        expect(info!.acceptedDespite).toEqual(['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED']);
    });

    it('flags a proxy that cannot inspect certificates at all', () => {
        const { sock, bus } = connected();
        let info: { certInspection: boolean; unsupportedOptions: string[] } | null = null;
        bus.on('tls.established', (i) => { info = i as typeof info; });

        // What the Cloudflare Worker proxy sends: TLS is on, but its runtime
        // exposes no peer certificate and cannot waive validation errors.
        sock.deliverControl({
            type: 'tls.established',
            certInspection: false,
            cert: null,
            acceptedDespite: [],
            unsupportedOptions: ['tlsIgnoreSelfSigned'],
        });

        expect(info!.certInspection).toBe(false);
        expect(info!.unsupportedOptions).toEqual(['tlsIgnoreSelfSigned']);
    });

    it('emits tls.error with every blocking fault', () => {
        const { sock, bus } = connected();
        let err: { code: string; codes: string[] } | null = null;
        bus.on('tls.error', (e) => { err = e as typeof err; });

        sock.deliverControl({
            type: 'tls.error',
            code: 'CERT_HAS_EXPIRED',
            message: 'certificate expired on Jan 1 2021',
            codes: ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'],
            cert: null,
        });

        expect(err!.code).toBe('CERT_HAS_EXPIRED');
        expect(err!.codes).toEqual(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
    });

    it('never feeds a control frame into the telnet stream', () => {
        const { sock, bus } = connected();
        const lines: unknown[] = [];
        bus.on('flushLines', (g) => lines.push(g));
        bus.on('socket.incoming', (d) => lines.push(d));

        sock.deliverControl({ type: 'tls.established', cert: null });
        vi.advanceTimersByTime(1000);

        expect(lines).toHaveLength(0);
    });

    it('ignores malformed or unknown control frames rather than throwing', () => {
        const { sock } = connected();
        expect(() => sock.deliverControl('not json at all')).not.toThrow();
        expect(() => sock.deliverControl({ nope: true })).not.toThrow();
        expect(() => sock.deliverControl({ type: 'tls.somethingNew' })).not.toThrow();
    });

    describe('handshake deadline', () => {
        it('reports tls.timeout when a TLS connection stays silent', () => {
            const { bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            vi.advanceTimersByTime(11_000);
            expect(timeouts).toHaveLength(0);   // still within the grace period
            vi.advanceTimersByTime(2_000);

            expect(timeouts).toEqual([{ host: 'mud.example.org', port: 4443 }]);
        });

        it('policing survives a detached transport and restarts its standard grace on resume', () => {
            const { client, sock, bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            retain(sock);                        // the session is retained; the handshake is still open
            sock.closeWith({ code: 1006 });                     // the phone loses its network
            vi.advanceTimersByTime(120_000);
            expect(timeouts).toHaveLength(0);                   // nothing is policed while away — and the deadline was not lost with the transport

            resume(client);
            vi.advanceTimersByTime(11_000);
            expect(timeouts).toHaveLength(0);                   // still within the standard grace
            vi.advanceTimersByTime(1_000);
            expect(timeouts).toEqual([{ host: 'mud.example.org', port: 4443 }]);   // said once, as an attached silent handshake always was
        });

        it('restored policing settles on a verdict seen during the catch-up, with no late warning', () => {
            const { client, sock, bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            retain(sock);
            sock.closeWith({ code: 1006 });
            const dial = resume(client);
            dial.deliverControl({ type: 'tls.established', cert: null });   // the verdict replays, mid catch-up
            vi.advanceTimersByTime(120_000);
            expect(timeouts).toHaveLength(0);
            dial.deliverControl({ type: 'tls.established', cert: null });   // a repeated verdict is idempotent
            vi.advanceTimersByTime(120_000);
            expect(timeouts).toHaveLength(0);
        });

        it('does not arm the deadline when TLS was never requested', () => {
            const { bus } = connected(PLAIN_URL);
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            vi.advanceTimersByTime(60_000);
            expect(timeouts).toHaveLength(0);
        });

        it('a tls.established frame cancels the deadline', () => {
            const { sock, bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            sock.deliverControl({ type: 'tls.established', cert: null });
            vi.advanceTimersByTime(60_000);

            expect(timeouts).toHaveLength(0);
        });

        it('game bytes cancel the deadline even without a control frame', () => {
            // An older proxy that understands &tls=1 but sends no control frames
            // still proves itself by delivering decrypted traffic.
            const { sock, bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            sock.deliverBinary('Welcome to the MUD\r\n');
            vi.advanceTimersByTime(60_000);

            expect(timeouts).toHaveLength(0);
        });

        it('a reported tls.error supersedes the timeout', () => {
            const { sock, bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            sock.deliverControl({ type: 'tls.error', code: 'CERT_HAS_EXPIRED', cert: null });
            vi.advanceTimersByTime(60_000);

            expect(timeouts).toHaveLength(0);
        });

        it('closing before any traffic reports the failure immediately', () => {
            // The out-of-date-proxy case: it ignored &tls=1, opened a plaintext
            // socket to the TLS port, and the game hung up without a byte.
            const { sock, bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            sock.closeWith({ code: 1006 });

            expect(timeouts).toEqual([{ host: 'mud.example.org', port: 4443 }]);
        });

        it('a clean close after real traffic is not a TLS failure', () => {
            const { sock, bus } = connected();
            const timeouts: unknown[] = [];
            bus.on('tls.timeout', (i) => timeouts.push(i));

            sock.deliverBinary('Welcome\r\n');
            sock.closeWith({ code: 1000, wasClean: true });

            expect(timeouts).toHaveLength(0);
        });
    });
});
