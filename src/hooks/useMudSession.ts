import { useEffect, useState, useCallback } from 'react';
import { MudSession, type SessionStatus, type MudSessionOptions } from '../mud/MudSession';

export function useMudSession(options?: MudSessionOptions) {
    const [session, setSession] = useState(() => new MudSession(options));

    const [status, setStatus] = useState<SessionStatus>('disconnected');
    const [ping, setPing] = useState<number | null>(null);
    const [passwordMode, setPasswordMode] = useState(false);

    useEffect(() => {
        // StrictMode dev re-runs the effect cleanup-then-setup on mount. Our
        // cleanup destroys the session, so on the synthetic remount the session
        // is dead — swap in a fresh one. In production this branch never fires.
        if (session.destroyed) {
            setSession(new MudSession(options));
            return;
        }
        const offStatus = session.events.on('status', setStatus);
        const offPing   = session.events.on('ping', setPing);
        const offEcho   = session.events.on('telnet.echo', setPasswordMode);
        return () => {
            offStatus(); offPing(); offEcho();
            session.destroy();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session]);

    const connect = useCallback((url: string) => session.connect(url), [session]);
    const disconnect = useCallback(() => session.disconnect(), [session]);
    const send = useCallback(
        (text: string, echo = true, isGameCommand = true) => session.send(text, echo, isGameCommand),
        [session],
    );

    return { session, status, ping, passwordMode, connect, disconnect, send };
}
