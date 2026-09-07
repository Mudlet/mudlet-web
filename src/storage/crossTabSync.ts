// Cross-tab reconciliation for the persisted store.
//
// Per-profile data (automation + UI/settings/layout) now lives in each
// profile's VFS, single-writer via the cross-tab lock — so the only state left
// in localStorage is the global index: the connection list and global client
// settings. Both tabs can edit those (add a connection, change the launcher
// theme or proxy URL), so we keep them in sync.
//
// Zustand's `persist` writes each tab's state to localStorage but never reads
// other tabs' writes back. We close that gap by listening for the `storage`
// event — fired in *other* tabs when localStorage changes — and adopting the
// incoming connections + client.
//
// Limitation: two tabs editing the connection list inside the same ~5s debounce
// window is a last-writer-wins race that can drop one edit. Sequential edits
// across tabs are safe (the second tab reconciles the first's change before it
// writes), and deletions always propagate.

import type { AppSchema } from './schema';
import { useAppStore, MUDLET_STORE_NAME, MUDLET_STORE_VERSION } from './appStore';

type PersistedSubset = Pick<AppSchema, 'connections' | 'client'>;

interface PersistedEnvelope {
    state?: Partial<PersistedSubset>;
    version?: number;
}

/** Last raw value we reconciled, to skip reprocessing an identical event. */
let lastReconciledRaw: string | null = null;

function reconcile(rawNewValue: string): void {
    let parsed: PersistedEnvelope | null = null;
    try {
        parsed = JSON.parse(rawNewValue) as PersistedEnvelope;
    } catch {
        return;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return;
    // Ignore writes from a different schema version (e.g. another tab still on an
    // old build during a deploy) — merging mismatched shapes could corrupt state.
    if (parsed.version !== MUDLET_STORE_VERSION) return;
    const incoming = parsed.state;

    const patch: Partial<PersistedSubset> = {};
    if ('connections' in incoming) patch.connections = incoming.connections;
    if ('client' in incoming) patch.client = incoming.client;
    if (Object.keys(patch).length > 0) useAppStore.setState(patch);
}

let attached = false;

/** Begin listening for other tabs' persisted-store writes and merging them in.
 *  Idempotent; safe to call more than once (e.g. across HMR reloads). */
export function initCrossTabSync(): void {
    if (attached || typeof window === 'undefined') return;
    attached = true;
    window.addEventListener('storage', e => {
        if (e.key !== MUDLET_STORE_NAME || e.newValue == null) return;
        if (e.newValue === lastReconciledRaw) return; // dedupe identical events
        lastReconciledRaw = e.newValue;
        reconcile(e.newValue);
    });
}

// Activate on import. App.tsx imports from the storage barrel, so the listener
// attaches at startup — reconciling even on the connection screen.
initCrossTabSync();
