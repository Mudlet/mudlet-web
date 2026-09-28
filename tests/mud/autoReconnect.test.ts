import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MudSession } from '../../src/mud/MudSession';
import { useAutoReconnect, SETTLED_SESSION_MS } from '../../src/hooks/useAutoReconnect';
import { failedConnectionRetryDelayMs } from '../../src/mud/MudSession';

/**
 * Mudlet's "Reconnect automatically" (`autoreconnect`), which is a different
 * profile option from the one Mudlet Web has always called `autoReconnect` — that
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
    /** What a redial does. Counting only, unless a test needs it to dial. */
    let onRedial: () => void;

    /** Mount the hook against the live session. Re-callable to change `enabled`
     *  mid-connection, the way flipping the profile toggle would. */
    const mount = () => {
        const Probe = () => {
            useAutoReconnect({ session, enabled, redial: () => { redials += 1; onRedial(); } });
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
        onRedial = () => {};
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
    // session from there turned a dead server into an immediate redial loop.
    // It is a failed attempt, and gets the failed attempt's waited retry.
    it('does not count the proxy accepting us as reaching the game', async () => {
        act(() => { session.connect(PROXY_URL); });
        const sock = socket();
        act(() => { sock.onopen?.({}); });
        vi.advanceTimersByTime(30_000);
        await drop(sock);
        expect(redials).toBe(0);
        vi.advanceTimersByTime(4_999);
        expect(redials).toBe(0);
        vi.advanceTimersByTime(1);
        expect(redials).toBe(1);
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

    // Dialling again tears a settled session down first, and that teardown is
    // a `client.disconnect` like any other. It is not a drop to recover from:
    // the dial that caused it is already under way.
    it('does not redial on top of a dial already under way', async () => {
        settle();
        vi.advanceTimersByTime(60_000);
        await act(async () => { session.connect(PROXY_URL); });
        expect(redials).toBe(0);
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

// cTelnet::handleFailedConnection (issue #237): an attempt that never reached
// the game is retried after 5 s, then 10, 20, 40, and 60 from then on, each one
// announced with "Trying again in N seconds...".
describe('reconnect automatically: attempts that fail', () => {
    let realWebSocket: unknown;
    let session: MudSession;
    let root: Root;
    let redials: number;
    let enabled: boolean;
    let messages: string[];

    const lines = () => messages.map(m => m.replace(/\x1b\[[0-9;]*m/g, ''));
    const socket = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

    const mount = () => {
        const Probe = () => {
            useAutoReconnect({
                session, enabled,
                redial: () => { redials += 1; session.connect(PROXY_URL); },
            });
            return null;
        };
        act(() => { root.render(createElement(Probe)); });
    };

    /** The proxy answers, then reports the game refused it. */
    const refuse = async () => {
        const sock = socket();
        await act(async () => {
            sock.onopen?.({});
            sock.onclose?.({ code: 1011, reason: 'Proxy: connect to achaea.com:23 failed: ECONNREFUSED', wasClean: true });
        });
    };

    beforeEach(() => {
        vi.useFakeTimers();
        realWebSocket = g.WebSocket;
        g.WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        redials = 0;
        enabled = true;
        messages = [];
        session = new MudSession();
        session.events.on('message', (text) => { if (typeof text === 'string') messages.push(text); });
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

    it('computes the delay the way cTelnet does', () => {
        expect([1, 2, 3, 4, 5, 6, 7, 20].map(failedConnectionRetryDelayMs))
            .toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
    });

    it('retries a refused attempt after five seconds, and says so', async () => {
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        expect(lines()).toContain('[ INFO ]  - Trying again in 5 seconds...');
        vi.advanceTimersByTime(4_999);
        expect(redials).toBe(0);
        vi.advanceTimersByTime(1);
        expect(redials).toBe(1);
        expect(MockWebSocket.instances).toHaveLength(2);
    });

    // The notice comes after the attempt's error, as handleFailedConnection
    // posts it last.
    it('announces the retry after the error', async () => {
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        const error = lines().findIndex(l => l.startsWith('[ ERROR ]'));
        const retry = lines().findIndex(l => l.startsWith('[ INFO ]  - Trying again'));
        expect(error).toBeGreaterThan(-1);
        expect(retry).toBeGreaterThan(error);
    });

    it('doubles the wait with each failure in a row', async () => {
        act(() => { session.connect(PROXY_URL); });
        const waits: number[] = [];
        for (let i = 0; i < 6; i++) {
            messages = [];
            await refuse();
            const m = /Trying again in (\d+) seconds/.exec(lines().join('\n'));
            waits.push(Number(m?.[1]));
            await act(async () => { vi.advanceTimersByTime(waits[i] * 1000); });
        }
        expect(waits).toEqual([5, 10, 20, 40, 60, 60]);
        expect(redials).toBe(6);
    });

    it('starts again from five seconds once a connection is made', async () => {
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        await act(async () => { vi.advanceTimersByTime(5_000); });
        await refuse();
        await act(async () => { vi.advanceTimersByTime(10_000); });
        // This one gets through, then is turned away inside five seconds.
        const sock = socket();
        await act(async () => {
            sock.onopen?.({});
            sock.onmessage?.({ data: JSON.stringify({ type: 'game.connected' }) });
        });
        expect(session.failedConnections).toBe(0);
        messages = [];
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        expect(lines()).toContain('[ INFO ]  - Trying again in 5 seconds...');
    });

    it('is called off by Disconnect', async () => {
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        act(() => { session.disconnect(); });
        vi.advanceTimersByTime(120_000);
        expect(redials).toBe(0);
    });

    it('is called off by a Connect of the player\'s own', async () => {
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        act(() => { session.connect(PROXY_URL); });
        vi.advanceTimersByTime(120_000);
        expect(redials).toBe(0);
    });

    it('is called off by closing the profile', async () => {
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        session.destroy();
        vi.advanceTimersByTime(120_000);
        expect(redials).toBe(0);
    });

    // connect() tears the old socket down before it dials. An attempt still
    // under way is abandoned, not failed: nothing to report, nothing to retry —
    // a retry here would be a second dial on top of the one just made.
    it('does not retry an attempt abandoned for a new dial', async () => {
        act(() => { session.connect(PROXY_URL); });
        act(() => { socket().onopen?.({}); });
        await act(async () => { session.connect(PROXY_URL); });
        vi.advanceTimersByTime(120_000);
        expect(redials).toBe(0);
        expect(MockWebSocket.instances).toHaveLength(2);
        expect(lines().some(l => l.includes('Trying again'))).toBe(false);
    });

    // disconnectIt resets the count; the attempt it calls off must not then
    // count as the first failure of the next run.
    it('starts from five seconds after a Disconnect during an attempt', async () => {
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        await act(async () => { vi.advanceTimersByTime(5_000); });
        act(() => { socket().onopen?.({}); });
        await act(async () => { session.disconnect(); });
        expect(session.failedConnections).toBe(0);
        messages = [];
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        expect(lines()).toContain('[ INFO ]  - Trying again in 5 seconds...');
    });

    it('does not retry when the profile has the option off', async () => {
        enabled = false;
        mount();
        act(() => { session.connect(PROXY_URL); });
        await refuse();
        vi.advanceTimersByTime(120_000);
        expect(redials).toBe(0);
        expect(lines().some(l => l.includes('Trying again'))).toBe(false);
    });

    // A rejected certificate raises dontReconnect before the close arrives.
    it('does not retry an attempt that must not be retried', async () => {
        act(() => { session.connect(PROXY_URL); });
        session.dontReconnect = true;
        await refuse();
        vi.advanceTimersByTime(120_000);
        expect(redials).toBe(0);
    });
});
