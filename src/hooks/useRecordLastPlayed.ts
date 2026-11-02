import { useEffect } from 'react';
import type { MudSession } from '../mud/MudSession';
import { useAppStore } from '../storage';

/**
 * Stamp `lastConnectedAt` on the profile each time its session reaches the
 * game, so the launcher can lead with the profile played most recently.
 *
 * `client.established`, not `client.connect`: the latter fires when the
 * WebSocket to the proxy opens, before the proxy has reached the game — a
 * profile whose server is down would still jump to the front of the list.
 */
export function useRecordLastPlayed(session: MudSession | null, connectionId: string): void {
    useEffect(() => {
        if (!session) return;
        return session.events.on('client.established', () => {
            useAppStore.getState().patchConnection(connectionId, { lastConnectedAt: Date.now() });
        });
    }, [session, connectionId]);
}
