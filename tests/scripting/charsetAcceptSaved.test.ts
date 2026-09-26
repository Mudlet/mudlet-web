// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { useAppStore, selectProfileField } from '../../src/storage';
import { MudSession } from '../../src/mud/MudSession';
import { savedServerEncoding } from '../../src/mud/protocol';
import {
    CHARSET_WILL, OPT_CHARSET, CHARSET_REQUEST, CHARSET_ACCEPTED, CHARSET_REJECTED,
} from '../../src/mud/protocol/constants';

/** Captures what the client writes, so the CHARSET reply can be read back. */
class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    protocol = '';
    sent: string[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send(bytes: Uint8Array) { this.sent.push(String.fromCharCode(...bytes)); }
    close() { this.readyState = MockWebSocket.CLOSED; }

    deliver(byteString: string) {
        const buf = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) buf[i] = byteString.charCodeAt(i) & 0xff;
        this.onmessage?.({ data: buf.buffer });
    }
}

const request = (list: string) => '\xFF\xFA' + OPT_CHARSET + CHARSET_REQUEST + list + '\xFF\xF0';

/**
 * An encoding agreed by accepting a server's CHARSET REQUEST is saved to the
 * profile, as Mudlet's cTelnet does with `setEncoding(acceptedEncoding, true)`
 * — so the next connection opens on it (follow-up to Mudlet/mudlet-web#191).
 * Mudlet saves only then: not for a REJECTED request, not for a server's
 * ACCEPTED reply, and not when the name accepted is the one already in use.
 */
describe('CHARSET encoding accepted from the server', () => {
    let t: TestRuntime;
    let realWebSocket: unknown;
    const saved = () => selectProfileField(useAppStore.getState(), TEST_CONNECTION_ID, 'serverEncoding');

    /** Dial the test session and let the server enable CHARSET. */
    const dial = (session: MudSession = t.session) => {
        session.connect('ws://game.invalid');
        const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        sock.onopen?.({});
        sock.deliver(CHARSET_WILL);
        sock.sent.length = 0;
        return sock;
    };

    beforeEach(async () => {
        realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
        vi.stubGlobal('WebSocket', MockWebSocket);
        MockWebSocket.instances = [];
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { serverEncoding: undefined });
        t = await createTestRuntime();
    });
    afterEach(() => {
        t.session.disconnect();
        t.dispose();
        vi.unstubAllGlobals();
        (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
    });

    it('saves an ACCEPTED encoding to the profile, in the list\'s own spelling', () => {
        const sock = dial();
        sock.deliver(request(';iso-8859-2'));
        expect(sock.sent.join('')).toBe('\xFF\xFA' + OPT_CHARSET + CHARSET_ACCEPTED + 'iso-8859-2' + '\xFF\xF0');
        expect(saved()).toBe('ISO 8859-2');
        sock.deliver(request(';IBM866'));
        expect(saved()).toBe('CP866');
    });

    it('saves nothing for a REJECTED request', () => {
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { serverEncoding: 'KOI8-R' });
        const sock = dial();
        sock.deliver(request(';CP1161;X-NOT-A-CHARSET'));
        expect(sock.sent.join('')).toBe('\xFF\xFA' + OPT_CHARSET + CHARSET_REJECTED + '\xFF\xF0');
        expect(saved()).toBe('KOI8-R');
    });

    it('saves nothing when the encoding accepted is already the one in use', () => {
        // cTelnet::setEncoding writes the profile only when the name changes.
        const sock = dial();
        sock.deliver(request(';ASCII;UTF-8'));
        expect(sock.sent.join('')).toContain(CHARSET_ACCEPTED + 'UTF-8');
        expect(saved()).toBeUndefined();
    });

    it('saves nothing for a server\'s ACCEPTED reply, which Mudlet ignores', () => {
        const sock = dial();
        sock.deliver('\xFF\xFA' + OPT_CHARSET + CHARSET_ACCEPTED + 'KOI8-R' + '\xFF\xF0');
        expect(saved()).toBeUndefined();
    });

    it('starts the next connection on the saved encoding', () => {
        const sock = dial();
        sock.deliver(request(';CP866'));
        expect(saved()).toBe('CP866');

        const readLine = (session: MudSession, s: MockWebSocket) => {
            const lines: string[] = [];
            const off = session.events.on('flushLines', groups => lines.push(...groups.map(g => g.text)));
            // "Привет" in CP866, sent with no CHARSET exchange on this socket.
            s.deliver('\x8F\xE0\xA8\xA2\xA5\xE2\r\n');
            off();
            return lines.join('\n');
        };

        // A reconnect of the same session.
        t.session.disconnect();
        const again = MockWebSocket.instances.length;
        expect(t.session.reconnect()).toBe(true);
        const sock2 = MockWebSocket.instances[again];
        sock2.onopen?.({});
        expect(t.session.getServerEncoding()).toBe('CP866');
        expect(readLine(t.session, sock2)).toContain('Привет');

        // A fresh session, seeded from the profile the way ProfileSession does.
        const fresh = new MudSession();
        fresh.setServerEncoding(savedServerEncoding(saved()!));
        fresh.connect('ws://game.invalid');
        const sock3 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        sock3.onopen?.({});
        expect(fresh.getServerEncoding()).toBe('CP866');
        expect(readLine(fresh, sock3)).toContain('Привет');
        fresh.disconnect();
        fresh.destroy?.();
    });
});
