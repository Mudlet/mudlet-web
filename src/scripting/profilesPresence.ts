import { connectionIdFromLockName } from '../utils/profileLock';

/** Presence message exchanged between tabs over the BroadcastChannel. */
type PresenceMsg =
    | { t: 'state'; id: string; connected: boolean }
    | { t: 'query' }
    | { t: 'bye'; id: string };

/**
 * Cross-tab view of which profiles are open and which are connected — backs
 * Mudlet's `getProfiles()`. Mudlet Web runs one profile per browser tab, so two
 * cross-tab signals are combined:
 *
 *  - **loaded** (open & editable): every open profile holds an exclusive Web
 *    Lock named `mudlet:profile:<id>` (see profileLock.ts). `navigator.locks
 *    .query()` lists held locks across all same-origin tabs, so the held
 *    profile locks ARE the loaded set. Authoritative and crash-safe (the browser
 *    auto-releases a lock when its tab closes/crashes). Polled on a slow interval
 *    since the query is async but `getProfiles()` is a synchronous Lua call.
 *
 *  - **connected** (playing): not observable through Web Locks, so each tab
 *    announces its own live connection state over a `BroadcastChannel`. A tab
 *    announces on connect/disconnect and answers a `query` from a newly-opened
 *    tab; `bye` on teardown clears it eagerly (a crash is caught by the loaded
 *    set dropping). The owning tab's own state is always read live.
 *
 * Degrades gracefully where the platform lacks these APIs (legacy browser,
 * insecure context, or the Node test environment): no Web Locks → loaded is just
 * this profile; no BroadcastChannel → connected is just this profile's live
 * state. That matches the old single-profile `getProfiles()` behaviour.
 */
export class ProfilesPresence {
    private channel: BroadcastChannel | null = null;
    private lockTimer: ReturnType<typeof setInterval> | null = null;
    /** Loaded profile ids from Web Locks (authoritative; always includes self). */
    private loaded: Set<string>;
    /** Last-announced connected state of OTHER tabs' profiles. */
    private readonly remoteConnected = new Map<string, boolean>();

    constructor(
        private readonly ownId: string,
        /** This tab's live connected state, read whenever we announce. */
        private readonly localConnected: () => boolean,
        refreshMs = 3000,
    ) {
        this.loaded = new Set([ownId]);
        if (typeof BroadcastChannel !== 'undefined') {
            this.channel = new BroadcastChannel('mudlet:profiles-presence');
            this.channel.onmessage = (e: MessageEvent) => this.onMessage(e.data as PresenceMsg);
            this.channel.postMessage({ t: 'query' } satisfies PresenceMsg); // ask peers to announce
            this.announce();                                                 // and announce ourselves
        }
        // Only poll when the Web Locks query API exists; otherwise the loaded set
        // stays {ownId} and we never spin an interval (keeps the Node test env —
        // and legacy browsers — leak-free).
        const hasLockQuery = typeof navigator !== 'undefined' && !!navigator.locks?.query;
        if (hasLockQuery) {
            void this.refreshLoaded();
            this.lockTimer = setInterval(() => { void this.refreshLoaded(); }, refreshMs);
        }
    }

    /** Broadcast this tab's current connected state to peers. Call on connect/
     *  disconnect. No-op without a channel. */
    announce(): void {
        this.channel?.postMessage({ t: 'state', id: this.ownId, connected: this.localConnected() } satisfies PresenceMsg);
    }

    /** Connection ids of all loaded profiles (best-effort snapshot, always
     *  including this profile's own id). */
    loadedIds(): string[] {
        return [...this.loaded];
    }

    /** Connected state for a profile id: own → live, others → last announced
     *  (false when never announced). Callers gate this on `loaded` so a crashed
     *  tab's stale "connected" can't outlive its lock. */
    isConnected(id: string): boolean {
        return id === this.ownId ? this.localConnected() : (this.remoteConnected.get(id) ?? false);
    }

    private onMessage(m: PresenceMsg): void {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'query') { this.announce(); return; }        // a peer joined — re-announce
        if (m.t === 'bye') { this.remoteConnected.delete(m.id); return; }
        if (m.t === 'state' && m.id !== this.ownId) {
            this.remoteConnected.set(m.id, !!m.connected);
        }
    }

    private async refreshLoaded(): Promise<void> {
        try {
            const { held } = await navigator.locks.query();
            const next = new Set<string>([this.ownId]);
            for (const lock of held ?? []) {
                const id = lock.name ? connectionIdFromLockName(lock.name) : null;
                if (id) next.add(id);
            }
            this.loaded = next;
        } catch {
            /* keep the last snapshot on a transient query failure */
        }
    }

    destroy(): void {
        if (this.lockTimer) {
            clearInterval(this.lockTimer);
            this.lockTimer = null;
        }
        if (this.channel) {
            try { this.channel.postMessage({ t: 'bye', id: this.ownId } satisfies PresenceMsg); } catch { /* closing */ }
            this.channel.onmessage = null;
            this.channel.close();
            this.channel = null;
        }
    }
}
