import { useCallback, useEffect, useRef, useState } from 'react';
import { addToHistory as addImpl, DEFAULT_HISTORY_SAVE_SIZE, historyStorageKey, loadHistory, saveHistory } from './commandHistory';

/** Reactive MRU command history wrapper around localStorage. History is scoped
 *  to `connectionId` so each profile keeps its own. `saveSize` caps how many
 *  entries are persisted (Mudlet's `commandLineHistorySaveSize`); `persist`
 *  is Mudlet's per-command-line `setSaveCommandHistory`, which stops the writing
 *  without touching the history this session already has. */
export function useCommandHistory(
    connectionId: string | null,
    saveSize: number = DEFAULT_HISTORY_SAVE_SIZE,
    persist = true,
) {
    const key = historyStorageKey(connectionId);
    const [history, setHistory] = useState<string[]>(() => loadHistory(key));
    // Held in refs so `add` stays referentially stable while still seeing the
    // latest cap/key (a changed cap or profile shouldn't churn every consumer).
    const saveSizeRef = useRef(saveSize);
    saveSizeRef.current = saveSize;
    const keyRef = useRef(key);
    keyRef.current = key;
    const persistRef = useRef(persist);
    persistRef.current = persist;

    const add = useCallback((item: string) => {
        if (!item) return;
        setHistory(prev => {
            const next = addImpl(prev, item);
            if (persistRef.current) saveHistory(next, keyRef.current, saveSizeRef.current);
            return next;
        });
    }, []);

    // Reload when the active profile changes — each profile has its own history.
    useEffect(() => {
        setHistory(loadHistory(key));
    }, [key]);

    // Re-persist with the new cap when the user changes the save size, so a
    // lowered limit truncates the stored history promptly (not just on next add).
    useEffect(() => {
        if (persist) saveHistory(loadHistory(key), key, saveSize);
    }, [key, saveSize, persist]);

    // Stay in sync when another tab edits this profile's history.
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === key) setHistory(loadHistory(key));
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [key]);

    return { history, add };
}
