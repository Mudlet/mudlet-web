import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MudSession } from '../../src/mud/MudSession';
import { useAutoReconnect, SETTLED_SESSION_MS } from '../../src/hooks/useAutoReconnect';

/**
 * Mudlet's "Reconnect automatically" (`autoreconnect`), which is a different
 * profile option from the one mudix has always called `autoReconnect` — that
 * one is Mudlet's `autologin` and only decides whether opening a profile dials.
 *
 * All of the behaviour under test is ctelnet.cpp:918-923:
 *
 *     if (mAutoReconnect && !mDontReconnect && timeOffset >= 5000) {
 *         connectIt(mHostUrl, mHostPort);
 *     }
 *
 * The interesting half is `timeOffset`, because through the telnet proxy the
 * obvious clock is the wrong one: the proxy accepts our WebSocket first and
 * only then dials the game, so `client.connect` fires for a game that is down.
 * A previous attempt at this feature measured exactly that socket and retried
 * for ever against a dead server (issue #130). The clock here runs from
 * `client.established` instead — the proxy's `game.connected` frame, or the
 * first byte of game traffic from a proxy too old to send one.
 */

class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    protocol = '';
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send() {}
    close() { this.readyState = MockWebSocket.CLOSED; }
}

const PROXY_URL = 'wss://proxy.invalid/?host=achaea.com&port=23';
const DIRECT_URL = 'wss://mud.example.org:4000/ws';

const g = globalThis as Record<string, unknown>;

describe('reconnect automatically', () => {
    let realWebSocket: unknown;
    let session: MudSession;
    let root: Root;
    let redials: number;
    let enabled: boolean;

    /** Mount the hook against the live session. Re-callable to change `enabled`
     *  mid-connection, the way flipping the profile toggle would. */
    const mount = () => {
        const Probe = () => {
            useAutoReconnect({ session, enabled, redial: () => { redials += 1; } });
            return null;
        };
        act(() => { root.render(createElement(Probe)); });
    };

    const socket = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

    /** Dial, open the WebSocket, and have the proxy report it reached the game. */
    const settle = (url = PROXY_URL) => {
        act(() => { session.connect(url); });
        const sock = socket();
        act(() => {
            sock.onopen?.({});
            sock.onmessage?.({ data: JSON.stringify({ type: 'game.connected' }) });
        });
        return sock;
    };

    /** Close the socket and let the redial's microtask run — the hook dials
     *  after the disconnect dispatch has unwound, not from inside it. */
    const drop = async (sock: MockWebSocket) => {
        await act(async () => { sock.onclose?.({ code: 1006, reason: '', wasClean: false }); });
    };

    beforeEach(() => {
        vi.useFakeTimers();
        realWebSocket = g.WebSocket;
        g.WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        redials = 0;
        enabled = true;
        session = new MudSession();
        document.body.replaceChildren();
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        mount();
    });

    afterEach(() => {
        act(() => root.unmount());
        try { session.destroy(); } catch { /* teardown best-effort */ }
        g.WebSocket = realWebSocket;
        vi.useRealTimers();
    });

    it('redials a settled session that dropped, at once', async () => {
        const sock = settle();
        vi.advanceTimersByTime(SETTLED_SESSION_MS);
        await drop(sock);
        expect(redials).toBe(1);
    });

    // Mudlet never retries an attempt that failed to connect: mConnectionTimer
    // was never started, so timeOffset is 0 and the guard rejects it.
    it('leaves a connection that never settled alone', async () => {
        const sock = settle();
        vi.advanceTimersByTime(SETTLED_SESSION_MS - 1);
        await drop(sock);
        expect(redials).toBe(0);
    });

    // The bug the first attempt at this shipped: in proxy mode the WebSocket
    // opens against the *proxy*, which then fails to reach the game. Timing the
    // session from there turned a dead server into an endless retry loop.
    it('does not count the proxy accepting us as reaching the game', async () => {
        act(() => { session.connect(PROXY_URL); });
        const sock = socket();
        act(() => { sock.onopen?.({}); });
        vi.advanceTimersByTime(30_000);
        await drop(sock);
        expect(redials).toBe(0);
    });

    // A proxy predating the `game.connected` frame says nothing, so the first
    // byte the game sends has to start the clock instead — every MUD greets.
    it('starts the clock on the first game byte from an older proxy', async () => {
        act(() => { session.connect(PROXY_URL); });
        const sock = socket();
        act(() => { sock.onopen?.({}); });
        act(() => { sock.onmessage?.({ data: new TextEncoder().encode('Welcome!\r\n').buffer }); });
        vi.advanceTimersByTime(SETTLED_SESSION_MS);
        await drop(sock);
        expect(redials).toBe(1);
    });

    // A direct ws(s):// connection has only the one leg, so opening it *is*
    // reaching the game and there is no frame to wait for.
    it('treats a direct websocket opening as reaching the game', async () => {
        const sock = (() => {
            act(() => { session.connect(DIRECT_URL); });
            const s = socket();
            act(() => { s.onopen?.({}); });
            return s;
        })();
        vi.advanceTimersByTime(SETTLED_SESSION_MS);
        await drop(sock);
        expect(redials).toBe(1);
    });

    it('does nothing when the profile has the option off', async () => {
        enabled = false;
        mount();
        const sock = settle();
        vi.advanceTimersByTime(60_000);
        await drop(sock);
        expect(redials).toBe(0);
    });

    // Mudlet's !mDontReconnect. Covers the toolbar button, Lua disconnect() and
    // closing the profile alike, since all three go through session.disconnect().
    it('never undoes a disconnect the user asked for', async () => {
        settle();
        vi.advanceTimersByTime(60_000);
        await act(async () => { session.disconnect(); });
        expect(redials).toBe(0);
    });

    // ctelnet.cpp:819 / GMCPAuthenticator.cpp:613 — a rejected certificate or a
    // rejected login is a standing condition, and redialing just repeats it.
    it('honours a dontReconnect raised by a certificate or login failure', async () => {
        const sock = settle();
        vi.advanceTimersByTime(60_000);
        session.dontReconnect = true;
        await drop(sock);
        expect(redials).toBe(0);
    });

    // Mudlet clears mDontReconnect at the end of every disconnect cycle; ours is
    // cleared by connect(), which comes to the same thing — the suppression must
    // not outlive the one drop it was raised for.
    it('reconnects again after a suppressed cycle', async () => {
        const first = settle();
        vi.advanceTimersByTime(60_000);
        session.dontReconnect = true;
        await drop(first);
        expect(redials).toBe(0);

        const second = settle();
        vi.advanceTimersByTime(60_000);
        await drop(second);
        expect(redials).toBe(1);
    });

    // One redial, not a queue of them: nothing is scheduled, so there is no
    // pending timer to fire after the session is gone.
    it('says nothing on the console about any of it', async () => {
        const messages: string[] = [];
        session.events.on('message', (text) => { if (typeof text === 'string') messages.push(text); });
        const sock = settle();
        vi.advanceTimersByTime(60_000);
        messages.length = 0;
        await drop(sock);
        expect(messages.some(m => /trying again|reconnect/i.test(m))).toBe(false);
        expect(redials).toBe(1);
    });
});
