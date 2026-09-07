import { useEffect, useRef } from 'react';
import type { MudSession } from '../mud/MudSession';

/**
 * Mudlet's "Reconnect automatically" profile option, ported from `cTelnet`.
 *
 * The whole of it is three lines at the end of `slot_socketDisconnected`
 * (ctelnet.cpp:918-923):
 *
 * ```cpp
 * if (mAutoReconnect && !mDontReconnect && timeOffset >= 5000) {
 *     connectIt(mHostUrl, mHostPort);
 * }
 * mDontReconnect = false;
 * ```
 *
 * Three conditions, and each one matters:
 *
 * - **`mAutoReconnect`** is the profile's own `autoreconnect` flag — here
 *   `MudConnection.reconnectOnDrop`, a *different* option from the badly-named
 *   `autoReconnect`, which is Mudlet's `autologin` and only decides whether
 *   opening the profile dials.
 * - **`!mDontReconnect`** — a disconnect the player asked for is never undone.
 *   {@link MudSession.dontReconnect} is that flag: raised by `disconnect()`, so
 *   it covers the toolbar button, Lua `disconnect()` and closing the profile
 *   alike, and raised again by a rejected certificate and a failed GMCP login
 *   exactly as Mudlet does (ctelnet.cpp:819, GMCPAuthenticator.cpp:613) —
 *   neither of those gets better by being retried.
 * - **`timeOffset >= 5000`** — the session has to have *settled*. `timeOffset`
 *   is `mConnectionTimer`, started when the game socket connects, so a dial that
 *   never landed leaves it invalid and nothing is retried. Mudlet does not retry
 *   failed connection attempts at all: a game that is down stays down, and the
 *   player asked for a client, not a doorbell.
 *
 * What happens then is deliberately unremarkable: **one** redial, immediately,
 * with nothing printed. No backoff, no countdown, no console line — a session
 * that ran for an hour and blipped should come back without narrating it. If the
 * redial also drops inside five seconds, that is the end of it until the player
 * clicks Connect.
 *
 * (An earlier attempt at this bolted a 5s→60s backoff and a `Trying again in %n
 * second(s)...` notice onto the *other* flag; neither the message nor the
 * symbols it was credited to exist in Mudlet. It was reverted — see issue #130.)
 */

/** Mudlet's `timeOffset >= 5000`: how long the game link has to have been up
 *  for its loss to count as a drop worth redialing rather than an attempt that
 *  never really got anywhere. Shares its value, and its reasoning, with
 *  MudSession's `CONNECTION_REJECTED_WINDOW_MS`. */
export const SETTLED_SESSION_MS = 5_000;

interface Options {
    session: MudSession;
    /** The profile's `reconnectOnDrop`. */
    enabled: boolean;
    /** Dial again, from the connection as it stands in the store — Mudlet
     *  redials `mHostUrl`/`mHostPort`, i.e. the address as last dialled, which
     *  after a TLS upgrade is not the one the profile started with. */
    redial: () => void;
}

export function useAutoReconnect({ session, enabled, redial }: Options): void {
    // Refs, so the subscription survives a re-render (and the option changing)
    // without being torn down and rebuilt underneath a live connection.
    const establishedAt = useRef<number | null>(null);
    const latest = useRef({ enabled, redial });
    latest.current = { enabled, redial };

    useEffect(() => {
        // The session's own `connectedAt` is the same clock, but it is cleared
        // by the disconnect notice — which is subscribed first and so has
        // already run by the time we are asked. Keep our own copy.
        const onEstablished = () => { establishedAt.current = Date.now(); };

        const onDisconnect = () => {
            const openedAt = establishedAt.current;
            establishedAt.current = null;
            if (!latest.current.enabled) return;
            // Mudlet clears mDontReconnect right here; ours is cleared by
            // MudSession.connect(), which comes to the same thing — it is only
            // ever read on the disconnect it was raised for.
            if (session.dontReconnect) return;
            // Tearing the profile down disconnects on the way out. That is not a
            // drop to recover from, and the session is already unusable.
            if (session.destroyed) return;
            if (openedAt === null) return;
            if (Date.now() - openedAt < SETTLED_SESSION_MS) return;
            // Mudlet redials at the *end* of slot_socketDisconnected, once its
            // own cleanup has run. Ours is one listener among several on the
            // same event — the ping tracker, the scripting engine's
            // sysDisconnectionEvent, the login and TLS handlers — and dialling
            // from inside the dispatch would build the next connection while
            // they were still tearing the last one down. A microtask puts the
            // redial after the whole chain, and no later.
            queueMicrotask(() => {
                if (!latest.current.enabled) return;
                if (session.destroyed) return;
                latest.current.redial();
            });
        };

        const off1 = session.events.on('client.established', onEstablished);
        const off2 = session.events.on('client.disconnect', onDisconnect);
        return () => { off1(); off2(); };
    }, [session]);
}
