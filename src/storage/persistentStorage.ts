// Everything a profile owns — its filesystem, maps, logs, the connection index —
// lives in browser storage, which a browser is free to evict under storage
// pressure. Asking for persistence tells it not to. It's a request, not a
// setting: Chromium and WebKit decide silently from the user's interaction
// history with the origin, Firefox raises a permission prompt, and a browser
// without the API can't grant it at all. So this is best-effort by construction
// — the honest fallback is still "export your profiles", which is what
// docs/help/storage.md tells people.

type Persistable = Pick<StorageManager, 'persist' | 'persisted'>;

function storageManager(): Persistable | null {
    const s = typeof navigator === 'undefined' ? undefined : navigator.storage;
    return typeof s?.persist === 'function' && typeof s.persisted === 'function' ? s : null;
}

/** Whether this browser can be asked at all. */
export function persistenceSupported(): boolean {
    return storageManager() !== null;
}

/** Whether the origin's storage is already exempt from eviction. Never throws. */
export async function isPersisted(): Promise<boolean> {
    const storage = storageManager();
    if (!storage) return false;
    try {
        return await storage.persisted();
    } catch {
        return false;
    }
}

// One attempt per page session, denial included. Firefox turns this into a
// permission prompt, and re-asking on every profile open would be nagging; a
// user who wants to revisit the decision does it through the browser's own site
// permissions, not by clicking around in here.
let attempt: Promise<boolean> | null = null;

/** Ask the browser to exempt this origin's storage from eviction, at most once
 *  per page session. Resolves to whether storage is persistent afterwards —
 *  `false` on refusal or on a browser without the API. Never throws. */
export function ensurePersistentStorage(): Promise<boolean> {
    attempt ??= runRequest();
    return attempt;
}

async function runRequest(): Promise<boolean> {
    const storage = storageManager();
    if (!storage) return false;
    try {
        if (await storage.persisted()) return true;
        const granted = await storage.persist();
        if (granted) {
            console.info('[persistentStorage] granted — profiles are exempt from eviction');
        } else {
            console.info('[persistentStorage] not granted — profiles can be evicted under storage pressure; export to back up');
        }
        return granted;
    } catch {
        return false;
    }
}

/** Test seam: forget the one-per-session attempt. */
export function resetPersistenceRequest(): void {
    attempt = null;
}
