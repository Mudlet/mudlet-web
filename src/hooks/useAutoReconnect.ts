import { useEffect, useRef } from 'react';
import type { MudSession } from '../mud/MudSession';

/**
 * Mudlet's automatic reconnection, ported from `cTelnet`.
 *
 * The profile option existed before this and did nothing of the kind: it only
 * meant "dial when the profile is opened", so a dropped socket left the session
 * dead until the player clicked Connect (issue #56). Mudlet's `mAutoReconnect`
 * does that *and* keeps trying, which is what the name promises.
 *
 * Two cases, and they behave differently in Mudlet:
 *
 * - **A connection that was up and dropped** (`slot_socketDisconnected`, guarded
 *   by `timeOffset >= 5000`) redials at once and says nothing. A session that
 *   lasted a while and then dropped is a blip; announcing it is noise.
 * - **A connection attempt that never succeeded** (`handleFailedConnection`)
 *   waits, doubling for each consecutive failure, and says so. A game that is
 *   down tends to stay down, and a fixed retry would spend the evening
 *   announcing that over whatever the player is reading.
 *
 * A disconnect the player asked for is never undone —
 * {@link MudSession.deliberateDisconnect} is Mudlet's `mDontReconnect`, and it
 * covers the toolbar button, Lua `disconnect()` and closing the profile alike.
 */

/** `FAILED_CONNECTION_RETRY_DELAY` in ctelnet.cpp. */
export const RETRY_BASE_MS = 5_000;
/** `FAILED_CONNECTION_RETRY_MAX_DELAY` in ctelnet.cpp. */
export const RETRY_MAX_MS = 60_000;
/** Mudlet's `timeOffset >= 5000`: how long a session has to have lasted for its
 *  loss to count as a drop to redial rather than an attempt that failed. */
export const SETTLED_SESSION_MS = 5_000;

/** The wait before retry number `failures` (1-based), doubling and then capped —
 *  5s, 10s, 20s, 40s, 60s, 60s… Mudlet caps the shift at 5 as well as capping
 *  the result, so the arithmetic cannot run away on a long outage. */
export function retryDelayMs(failures: number): number {
    const shift = Math.min(Math.max(failures, 1) - 1, 5);
    return Math.min(RETRY_BASE_MS * 2 ** shift, RETRY_MAX_MS);
}

interface Options {
    session: MudSession;
    /** The profile's `autoReconnect`. Turning it off cancels a pending retry. */
    enabled: boolean;
    /** Dial again, from the connection as it stands in the store. */
    redial: () => void;
    /** Post a console line, in Mudlet's `[ INFO ]  - …` house style. */
    postInfo: (text: string) => void;
}

export function useAutoReconnect({ session, enabled, redial, postInfo }: Options): void {
    // Held in refs so the subscription does not need to be torn down and
    // rebuilt — and so the retry count survives the re-render each attempt
    // causes.
    const failures = useRef(0);
    const connectedAt = useRef<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = useRef({ enabled, redial, postInfo });
    latest.current = { enabled, redial, postInfo };

    useEffect(() => {
        const cancel = () => {
            if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
        };

        const onConnect = () => {
            // A connection has been made, so whatever ended the last one is
            // spent (Mudlet resets mFailedConnectionCount here too).
            failures.current = 0;
            connectedAt.current = Date.now();
            cancel();
        };

        const onDisconnect = () => {
            const openedAt = connectedAt.current;
            connectedAt.current = null;
            cancel();
            if (!latest.current.enabled) return;
            if (session.deliberateDisconnect) return;
            if (session.destroyed) return;

            if (openedAt !== null && Date.now() - openedAt >= SETTLED_SESSION_MS) {
                failures.current = 0;
                latest.current.redial();
                return;
            }

            failures.current += 1;
            const delay = retryDelayMs(failures.current);
            const seconds = Math.round(delay / 1000);
            postInfoNow(`Trying again in ${seconds} second${seconds === 1 ? '' : 's'}...`);
            timer.current = setTimeout(() => {
                timer.current = null;
                if (!latest.current.enabled || session.destroyed) return;
                latest.current.redial();
            }, delay);
        };

        const postInfoNow = (text: string) => latest.current.postInfo(text);

        const u1 = session.events.on('client.connect', onConnect);
        const u2 = session.events.on('client.disconnect', onDisconnect);
        return () => { u1(); u2(); cancel(); };
    }, [session]);

    // Turning the option off mid-wait should stop the wait, not just the dial
    // after it — otherwise the console keeps its promise to retry and doesn't.
    useEffect(() => {
        if (enabled) return;
        if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
        failures.current = 0;
    }, [enabled]);
}
