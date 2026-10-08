// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MudClient, IDLE_PROBE_MS } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';

class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    bufferedAmount = 0;
    sent: Uint8Array[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send(bytes: Uint8Array) { this.sent.push(bytes); }
    close() { this.readyState = MockWebSocket.CLOSED; }

    deliverBinary(byteString: string) {
        const buf = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) buf[i] = byteString.charCodeAt(i) & 0xff;
        this.onmessage?.({ data: buf.buffer });
    }
    deliverControl(payload: unknown) {
        this.onmessage?.({ data: JSON.stringify(payload) });
    }
    closeWith(ev: { code?: number; reason?: string; wasClean?: boolean } = {}) {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({ code: ev.code ?? 1006, reason: ev.reason ?? '', wasClean: ev.wasClean ?? false });
    }
    /** Every outbound IAC NOP. */
    nops(): number {
        return this.sent.filter(b => b.length === 2 && b[0] === 0xff && b[1] === 0xf1).length;
    }
}

const DIRECT_URL = 'wss://mud.example.org/ws';
const PROXY_URL = 'ws://proxy.invalid/?host=mud.example.org&port=23';
// IAC WILL ECHO — any telnet command shows the server speaks telnet.
const TELNET_HELLO = '\xff\xfb\x01Welcome\r\n';

/** Issue #454: a game host that dies without closing must not leave the
 *  client sitting on a connection it believes is live. */
describe('idle connection probe (issue #454)', () => {
    let realWebSocket: unknown;
    let realAddEventListener: unknown;

    beforeEach(() => {
        realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
        realAddEventListener = (globalThis as Record<string, unknown>).addEventListener;
        (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
        (globalThis as Record<string, unknown>).addEventListener = () => {};
        MockWebSocket.instances = [];
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    });
    afterEach(() => {
        vi.useRealTimers();
        (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
        (globalThis as Record<string, unknown>).addEventListener = realAddEventListener;
    });

    function open(url = DIRECT_URL) {
        const bus = new EventBus<MudClientEvents>();
        const client = new MudClient({ url }, bus);
        client.connect();
        const sock = MockWebSocket.instances[0];
        sock.onopen?.({});
        return { client, sock, bus };
    }

    function settle() {
        // Let the inbound pump (MessageChannel/timeouts) handle what arrived.
        vi.advanceTimersByTime(0);
    }

    it('sends IAC NOP once the game has been silent for the probe interval', () => {
        const { sock } = open();
        sock.deliverBinary(TELNET_HELLO);
        settle();

        vi.advanceTimersByTime(IDLE_PROBE_MS - 1000);
        expect(sock.nops()).toBe(0);
        const before = sock.sent.length;
        vi.advanceTimersByTime(1000);
        expect(sock.nops()).toBe(1);
        // A NOP and nothing else: no command reaches the game.
        expect(sock.sent.length).toBe(before + 1);
    });

    it('keeps probing while the silence lasts', () => {
        const { sock } = open();
        sock.deliverBinary(TELNET_HELLO);
        settle();
        vi.advanceTimersByTime(IDLE_PROBE_MS * 3);
        expect(sock.nops()).toBe(3);
    });

    it('game output pushes the next probe back', () => {
        const { sock } = open();
        sock.deliverBinary(TELNET_HELLO);
        settle();
        vi.advanceTimersByTime(IDLE_PROBE_MS - 10_000);
        sock.deliverBinary('A rat scurries past.\r\n');
        settle();
        vi.advanceTimersByTime(IDLE_PROBE_MS - 10_000);
        expect(sock.nops()).toBe(0);
        vi.advanceTimersByTime(10_000);
        expect(sock.nops()).toBe(1);
    });

    it('never probes a server that has not spoken telnet', () => {
        const { sock } = open();
        sock.deliverBinary('plain text only\r\n');
        settle();
        vi.advanceTimersByTime(IDLE_PROBE_MS * 3);
        expect(sock.nops()).toBe(0);
    });

    it('through a proxy, waits for the game leg and starts after the proxy keepalive would have', () => {
        const { sock } = open(PROXY_URL);
        // Proxy accepted us but has not reached the game: nothing to probe.
        vi.advanceTimersByTime(IDLE_PROBE_MS * 2);
        expect(sock.nops()).toBe(0);

        sock.deliverControl({ type: 'game.connected' });
        sock.deliverBinary(TELNET_HELLO);
        settle();
        // The proxy's keepalive finds a dead game in ~70 s; the probe is later.
        expect(IDLE_PROBE_MS).toBeGreaterThan(70_000);
        vi.advanceTimersByTime(IDLE_PROBE_MS);
        expect(sock.nops()).toBe(1);
    });

    it('stops probing once the connection closes, and a dead socket ends in a disconnect', () => {
        const { sock, bus } = open();
        let disconnects = 0;
        bus.on('client.disconnect', () => { disconnects++; });
        sock.deliverBinary(TELNET_HELLO);
        settle();
        vi.advanceTimersByTime(IDLE_PROBE_MS);
        expect(sock.nops()).toBe(1);

        // The probe's bytes hit the dead peer; the browser reports the failure.
        sock.closeWith({ code: 1006 });
        expect(disconnects).toBe(1);
        vi.advanceTimersByTime(IDLE_PROBE_MS * 3);
        expect(sock.nops()).toBe(1);
    });

    it('stops probing after disconnect()', () => {
        const { client, sock } = open();
        sock.deliverBinary(TELNET_HELLO);
        settle();
        client.disconnect();
        vi.advanceTimersByTime(IDLE_PROBE_MS * 3);
        expect(sock.nops()).toBe(0);
    });

    it('a redial starts the count afresh and forgets the old server spoke telnet', () => {
        const { client, sock } = open();
        sock.deliverBinary(TELNET_HELLO);
        settle();
        client.connect();
        const next = MockWebSocket.instances[1];
        next.onopen?.({});
        next.deliverBinary('no telnet here\r\n');
        settle();
        vi.advanceTimersByTime(IDLE_PROBE_MS * 2);
        expect(sock.nops() + next.nops()).toBe(0);
    });
});
