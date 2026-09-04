import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventBus } from '../../src/core/EventBus';
import type { MudSession } from '../../src/mud/MudSession';
import {
    useAutoReconnect, retryDelayMs, RETRY_BASE_MS, RETRY_MAX_MS, SETTLED_SESSION_MS,
} from '../../src/hooks/useAutoReconnect';

/**
 * `autoReconnect` used to mean only "dial when the profile is opened": dropping
 * the socket retried nothing and the session stayed dead until the user clicked
 * Connect (issue #56). This is Mudlet's `cTelnet` behaviour, ported.
 *
 * (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)
 */

describe('retryDelayMs', () => {
    it('doubles for each consecutive failure, then caps', () => {
        expect(retryDelayMs(1)).toBe(5_000);
        expect(retryDelayMs(2)).toBe(10_000);
        expect(retryDelayMs(3)).toBe(20_000);
        expect(retryDelayMs(4)).toBe(40_000);
        expect(retryDelayMs(5)).toBe(RETRY_MAX_MS);   // 80s, capped to 60s
        expect(retryDelayMs(6)).toBe(RETRY_MAX_MS);
        expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
    });

    it('treats the first failure as the base delay however it is counted', () => {
        expect(retryDelayMs(0)).toBe(RETRY_BASE_MS);
        expect(retryDelayMs(-3)).toBe(RETRY_BASE_MS);
    });
});

/** Only the three members the hook touches. Spelled out rather than `Pick`ed
 *  from MudSession, whose `destroyed` is a getter and so read-only. */
interface FakeSession {
    deliberateDisconnect: boolean;
    destroyed: boolean;
    events: EventBus<{ 'client.connect': void; 'client.disconnect': void }>;
}

describe('useAutoReconnect', () => {
    let host: HTMLDivElement;
    let root: Root;
    let session: FakeSession;
    let redials: number;
    let messages: string[];

    function mount(enabled = true) {
        function Probe() {
            useAutoReconnect({
                session: session as unknown as MudSession,
                enabled,
                redial: () => { redials += 1; },
                postInfo: text => { messages.push(text); },
            });
            return null;
        }
        act(() => { root.render(createElement(Probe)); });
    }

    const connect = () => act(() => { session.events.emit('client.connect'); });
    const drop = () => act(() => { session.events.emit('client.disconnect'); });

    beforeEach(() => {
        vi.useFakeTimers();
        redials = 0;
        messages = [];
        session = { deliberateDisconnect: false, destroyed: false, events: new EventBus() };
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => { root.unmount(); });
        host.remove();
        vi.useRealTimers();
    });

    it('does nothing at all while the option is off', () => {
        mount(false);
        drop();
        act(() => { vi.advanceTimersByTime(RETRY_MAX_MS * 2); });
        expect(redials).toBe(0);
        expect(messages).toEqual([]);
    });

    // Mudlet's `handleFailedConnection`: an attempt that never opened waits, and
    // says how long for.
    it('waits and announces after an attempt that never connected', () => {
        mount();
        drop();

        expect(messages).toEqual(['Trying again in 5 seconds...']);
        expect(redials).toBe(0);
        act(() => { vi.advanceTimersByTime(RETRY_BASE_MS - 1); });
        expect(redials).toBe(0);
        act(() => { vi.advanceTimersByTime(1); });
        expect(redials).toBe(1);
    });

    it('backs off further with each consecutive failure', () => {
        mount();
        for (const expected of [5_000, 10_000, 20_000]) {
            drop();
            act(() => { vi.advanceTimersByTime(expected); });
        }
        expect(messages).toEqual([
            'Trying again in 5 seconds...',
            'Trying again in 10 seconds...',
            'Trying again in 20 seconds...',
        ]);
        expect(redials).toBe(3);
    });

    it('starts the backoff over once a connection is made', () => {
        mount();
        drop();
        act(() => { vi.advanceTimersByTime(RETRY_BASE_MS); });
        connect();
        act(() => { vi.advanceTimersByTime(SETTLED_SESSION_MS); });
        drop();
        expect(messages[messages.length - 1]).toBe('Trying again in 5 seconds...');
    });

    // Mudlet's `slot_socketDisconnected`, guarded by `timeOffset >= 5000`: a
    // session that was up for a while and dropped is a blip, so it redials at
    // once and says nothing.
    it('redials immediately and silently when a settled session drops', () => {
        mount();
        connect();
        act(() => { vi.advanceTimersByTime(SETTLED_SESSION_MS); });
        drop();

        expect(redials).toBe(1);
        expect(messages).toEqual([]);
    });

    it('treats a connection that barely opened as a failed attempt', () => {
        mount();
        connect();
        act(() => { vi.advanceTimersByTime(SETTLED_SESSION_MS - 1); });
        drop();

        expect(redials).toBe(0);
        expect(messages).toEqual(['Trying again in 5 seconds...']);
    });

    // Mudlet's mDontReconnect. Covers the toolbar button, Lua disconnect() and
    // closing the profile, since all three go through MudSession.disconnect().
    it('never undoes a disconnect the user asked for', () => {
        mount();
        connect();
        act(() => { vi.advanceTimersByTime(SETTLED_SESSION_MS); });
        session.deliberateDisconnect = true;
        drop();

        act(() => { vi.advanceTimersByTime(RETRY_MAX_MS * 2); });
        expect(redials).toBe(0);
        expect(messages).toEqual([]);
    });

    it('does not dial a session that has been torn down', () => {
        mount();
        drop();
        session.destroyed = true;
        act(() => { vi.advanceTimersByTime(RETRY_MAX_MS * 2); });
        expect(redials).toBe(0);
    });

    it('cancels a pending retry when the profile is closed', () => {
        mount();
        drop();
        act(() => { root.unmount(); });
        act(() => { vi.advanceTimersByTime(RETRY_MAX_MS * 2); });
        expect(redials).toBe(0);
        // The afterEach unmount has to stay safe after this one.
        root = createRoot(host);
    });

    it('cancels a pending retry when the option is turned off mid-wait', () => {
        mount(true);
        drop();
        expect(messages).toHaveLength(1);
        mount(false);
        act(() => { vi.advanceTimersByTime(RETRY_MAX_MS * 2); });
        expect(redials).toBe(0);
    });
});
