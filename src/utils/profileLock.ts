// Single-owner guard for a profile across browser tabs.
//
// A profile's on-disk state — its ProfileVFS (ZenFS/IndexedDB), the SQLite
// db files, the binary map, and the script/alias/trigger trees — is written
// with a single-writer assumption. If the same profile were open in two tabs
// at once, their independent in-memory caches would clobber each other on the
// shared IndexedDB/OPFS storage. So a profile (keyed by connectionId) may be
// open in only one tab at a time.
//
// We enforce that with the Web Locks API: a tab holds an exclusive lock named
// after the profile for as long as it has the profile open. The browser
// auto-releases the lock when the tab is closed, navigated away, or crashes —
// no stale locks to clean up — and a second tab that requested the same lock
// is granted ownership automatically the moment the first releases it.

/** Shared prefix for every per-profile Web Lock name. */
export const PROFILE_LOCK_PREFIX = 'mudlet:profile:';

/** Web Lock name for a profile. */
export const profileLockName = (connectionId: string) => `${PROFILE_LOCK_PREFIX}${connectionId}`;

/** Inverse of {@link profileLockName}: the connectionId encoded in a lock name,
 *  or null when the name isn't a profile lock. Used to enumerate which profiles
 *  are open across tabs from `navigator.locks.query()`. */
export const connectionIdFromLockName = (name: string): string | null =>
    name.startsWith(PROFILE_LOCK_PREFIX) ? name.slice(PROFILE_LOCK_PREFIX.length) : null;

/** Best-effort check whether some tab currently holds the profile's lock. Used
 *  only to pick the initial "waiting for the other tab" message; the actual
 *  hand-off is the queued request in {@link acquireProfileLock}. */
export async function isProfileLockHeld(connectionId: string): Promise<boolean> {
    if (!navigator.locks?.query) return false;
    try {
        const { held } = await navigator.locks.query();
        const name = profileLockName(connectionId);
        return Boolean(held?.some(l => l.name === name));
    } catch {
        return false;
    }
}

export interface ProfileLockHandle {
    /** Resolves once this tab owns the profile — immediately when the lock is
     *  free, or later when the owning tab releases it. Rejects with AbortError
     *  if the signal fires before ownership is granted. */
    readonly acquired: Promise<void>;
    /** Release ownership. Idempotent; safe to call before `acquired` resolves
     *  (it then cancels the pending request via the same signal path). */
    release(): void;
}

/** Acquire the profile's exclusive lock, queuing behind another tab if one
 *  already holds it. Pass an AbortSignal to stop waiting (e.g. the user backs
 *  out to the connection screen). Degrades to a no-op guard when the Web Locks
 *  API is unavailable (legacy browser or insecure context). */
export function acquireProfileLock(connectionId: string, signal: AbortSignal): ProfileLockHandle {
    // No Web Locks (old browser / non-secure context): cannot guard, so grant
    // immediately rather than block the user out of their profile.
    if (!navigator.locks?.request) {
        return { acquired: Promise.resolve(), release: () => {} };
    }

    let releaseLock: (() => void) | null = null;
    let acquired = false;

    const acquiredPromise = new Promise<void>((resolveAcquired, rejectAcquired) => {
        navigator.locks
            .request(
                profileLockName(connectionId),
                { signal },
                () =>
                    // Hold the lock for as long as this promise is unresolved.
                    // We resolve it from release(), which frees the lock.
                    new Promise<void>(release => {
                        acquired = true;
                        releaseLock = release;
                        resolveAcquired();
                    }),
            )
            // AbortError when the signal fires before/while queued.
            .catch(rejectAcquired);
    });

    return {
        acquired: acquiredPromise,
        release: () => {
            if (acquired) releaseLock?.();
            // If not yet acquired, the caller is expected to also abort the
            // signal it passed in, which rejects the queued request.
        },
    };
}
