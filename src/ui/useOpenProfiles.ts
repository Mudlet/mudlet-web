import { useEffect, useState } from 'react';
import { connectionIdFromLockName } from '../utils/profileLock';

/**
 * Connection ids currently open in *another* browser tab.
 *
 * Every open profile holds an exclusive Web Lock named `mudix:profile:<id>`
 * (see profileLock.ts), and `navigator.locks.query()` lists held locks across
 * all same-origin tabs — so the held profile locks are exactly the open set.
 * The connection screen renders with no profile active, so this tab holds no
 * profile lock of its own and every hit belongs to someone else; no
 * self-filtering is needed.
 *
 * Polled, because Web Locks has no change event. The refresh is also driven by
 * focus/visibility so returning to the launcher tab after closing a profile
 * elsewhere updates immediately instead of waiting out the interval.
 *
 * Returns an empty set where the API is unavailable (legacy browser, insecure
 * context, test env) — the same "can't tell, so don't claim anything" fallback
 * the lock itself uses.
 */
/** The profile ids among a `navigator.locks.query()` held-lock list. Non-profile
 *  locks (any other feature using Web Locks) and unnamed entries are ignored. */
export function openProfileIds(held: readonly { name?: string }[] | undefined): Set<string> {
    const ids = new Set<string>();
    for (const lock of held ?? []) {
        const id = lock.name ? connectionIdFromLockName(lock.name) : null;
        if (id) ids.add(id);
    }
    return ids;
}

/** Whether two id sets hold the same members — used to skip no-op state updates. */
export const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
    a.size === b.size && [...b].every(id => a.has(id));

export function useOpenProfiles(enabled = true, refreshMs = 2000): Set<string> {
    const [open, setOpen] = useState<Set<string>>(() => new Set());

    useEffect(() => {
        if (!enabled || typeof navigator === 'undefined' || !navigator.locks?.query) return;
        let cancelled = false;

        const refresh = async () => {
            try {
                const { held } = await navigator.locks.query();
                if (cancelled) return;
                const next = openProfileIds(held);
                // Replace only on a real change so the grid doesn't re-render (and
                // re-run its FLIP layout effect) on every poll tick.
                setOpen(prev => (sameIds(prev, next) ? prev : next));
            } catch {
                /* transient query failure — keep the last snapshot */
            }
        };

        void refresh();
        const timer = setInterval(() => { void refresh(); }, refreshMs);
        const onFocus = () => { void refresh(); };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
        };
    }, [enabled, refreshMs]);

    return open;
}
