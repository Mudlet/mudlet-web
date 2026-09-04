import { describe, it, expect, beforeEach, vi } from 'vitest';

// Nothing here should reach a real IndexedDB — logStorage's index-driven session
// sweep is exercised elsewhere; here we only care that profile deletion asks for
// it, scoped to the profile being deleted.
const deletedSessionsFor: string[] = [];
vi.mock('../../src/storage/logStorage', () => ({
    deleteSessionsForConnection: async (id: string) => { deletedSessionsFor.push(id); },
}));

import { deleteProfileStorage, profileVfsDatabaseName, MIGRATION_BACKUP_KEY } from '../../src/storage/profileStorage';
import { useAppStore } from '../../src/storage/appStore';
import { historyStorageKey } from '../../src/ui/commandHistory';
import { stopwatchStorageKey } from '../../src/scripting/StopwatchManager';

/**
 * Deleting a profile used to drop it from the connection list and from the
 * localStorage store blob and stop there. Everything else keyed by connection id
 * survived — above all `mudix_vfs_<id>`, the profile's entire ZenFS database.
 * The next profile gets a fresh id, so those are unreachable orphans that only
 * accumulate against the origin's quota, holding whatever the user had typed
 * into their scripts. Desktop Mudlet deletes the profile directory, which is
 * what the confirmation dialog here promises too.
 */

// ---------------------------------------------------------------------------
// A Map-backed IndexedDB good enough for mapStorage and folderHandleStore:
// open/upgrade, one readwrite transaction, put/get/delete, deleteDatabase.
// ---------------------------------------------------------------------------
type Store = Map<string, unknown>;
type Db = Map<string, Store>;

function fakeIndexedDB() {
    const dbs = new Map<string, Db>();
    const deletedDatabases: string[] = [];
    /** Databases whose delete request reports `blocked` instead of succeeding. */
    const blocked = new Set<string>();

    const fire = (fn: unknown) => { if (typeof fn === 'function') queueMicrotask(() => (fn as () => void)()); };

    const objectStore = (store: Store) => ({
        put: (value: unknown, key: string) => { store.set(key, value); },
        get: (key: string) => {
            const req: Record<string, unknown> = { result: store.get(key) };
            fire(() => { (req.onsuccess as (() => void) | undefined)?.(); });
            return req;
        },
        delete: (key: string) => { store.delete(key); },
    });

    const api = {
        open(name: string) {
            const req: Record<string, unknown> = {};
            let db = dbs.get(name);
            const isNew = !db;
            if (!db) { db = new Map(); dbs.set(name, db); }
            const handle = {
                transaction: (names: string | string[], _mode?: string) => {
                    const first = Array.isArray(names) ? names[0] : names;
                    const tx: Record<string, unknown> = {
                        objectStore: (n: string) => {
                            if (!db!.has(n)) db!.set(n, new Map());
                            return objectStore(db!.get(n)!);
                        },
                    };
                    void first;
                    fire(() => { (tx.oncomplete as (() => void) | undefined)?.(); });
                    return tx;
                },
                createObjectStore: (n: string) => { db!.set(n, new Map()); return objectStore(db!.get(n)!); },
            };
            req.result = handle;
            queueMicrotask(() => {
                if (isNew) (req.onupgradeneeded as (() => void) | undefined)?.();
                (req.onsuccess as (() => void) | undefined)?.();
            });
            return req;
        },
        deleteDatabase(name: string) {
            const req: Record<string, unknown> = {};
            queueMicrotask(() => {
                if (blocked.has(name)) { (req.onblocked as (() => void) | undefined)?.(); return; }
                dbs.delete(name);
                deletedDatabases.push(name);
                (req.onsuccess as (() => void) | undefined)?.();
            });
            return req;
        },
    };
    return { api, dbs, deletedDatabases, blocked };
}

const KEEP = 'other-profile';
const DOOMED = 'doomed-profile';

function seed(idb: ReturnType<typeof fakeIndexedDB>) {
    idb.dbs.set(profileVfsDatabaseName(DOOMED), new Map([['store', new Map([['f', 1]])]]));
    idb.dbs.set(profileVfsDatabaseName(KEEP), new Map([['store', new Map([['f', 1]])]]));
    idb.dbs.set('mudix_maps', new Map([['maps', new Map<string, unknown>([[DOOMED, 'map-a'], [KEEP, 'map-b']])]]));
    idb.dbs.set('mudix_folder_handles', new Map([['handles', new Map<string, unknown>([[DOOMED, 'h-a'], [KEEP, 'h-b']])]]));

    localStorage.setItem(historyStorageKey(DOOMED), '["look"]');
    localStorage.setItem(historyStorageKey(KEEP), '["score"]');
    localStorage.setItem(stopwatchStorageKey(DOOMED), '{}');
    localStorage.setItem(stopwatchStorageKey(KEEP), '{}');
    localStorage.setItem(MIGRATION_BACKUP_KEY, JSON.stringify({ [DOOMED]: { profile: {} }, [KEEP]: { profile: {} } }));
}

describe('deleteProfileStorage', () => {
    let idb: ReturnType<typeof fakeIndexedDB>;

    beforeEach(() => {
        deletedSessionsFor.length = 0;
        idb = fakeIndexedDB();
        (globalThis as { indexedDB?: unknown }).indexedDB = idb.api;
        localStorage.clear();
        seed(idb);
    });

    it('deletes the profile VFS database outright', async () => {
        await deleteProfileStorage(DOOMED);
        expect(idb.deletedDatabases).toEqual([profileVfsDatabaseName(DOOMED)]);
        expect(idb.dbs.has(profileVfsDatabaseName(DOOMED))).toBe(false);
    });

    it('drops the profile map, folder handle and logs', async () => {
        await deleteProfileStorage(DOOMED);
        expect(idb.dbs.get('mudix_maps')!.get('maps')!.has(DOOMED)).toBe(false);
        expect(idb.dbs.get('mudix_folder_handles')!.get('handles')!.has(DOOMED)).toBe(false);
        expect(deletedSessionsFor).toEqual([DOOMED]);
    });

    it('drops the profile localStorage keys', async () => {
        await deleteProfileStorage(DOOMED);
        expect(localStorage.getItem(historyStorageKey(DOOMED))).toBeNull();
        expect(localStorage.getItem(stopwatchStorageKey(DOOMED))).toBeNull();
        expect(JSON.parse(localStorage.getItem(MIGRATION_BACKUP_KEY)!)).toEqual({ [KEEP]: { profile: {} } });
    });

    it('leaves every other profile untouched', async () => {
        await deleteProfileStorage(DOOMED);
        expect(idb.dbs.has(profileVfsDatabaseName(KEEP))).toBe(true);
        expect(idb.dbs.get('mudix_maps')!.get('maps')!.get(KEEP)).toBe('map-b');
        expect(idb.dbs.get('mudix_folder_handles')!.get('handles')!.get(KEEP)).toBe('h-b');
        expect(localStorage.getItem(historyStorageKey(KEEP))).toBe('["score"]');
        expect(localStorage.getItem(stopwatchStorageKey(KEEP))).toBe('{}');
    });

    it('does not hang when another connection blocks the database delete', async () => {
        idb.blocked.add(profileVfsDatabaseName(DOOMED));
        await deleteProfileStorage(DOOMED);
        // The delete stays queued in the browser; the rest of the sweep still ran.
        expect(deletedSessionsFor).toEqual([DOOMED]);
    });

    // The regression proper: removing a connection has to trigger the sweep.
    it('removeConnection erases the profile it removes, and only that one', async () => {
        const store = useAppStore.getState();
        const doomed = store.addConnection({
            name: 'qa-doomed', mode: 'mud', host: 'example.com', port: 23,
        } as Parameters<typeof store.addConnection>[0]);
        const keep = store.addConnection({
            name: 'qa-keep', mode: 'mud', host: 'example.com', port: 23,
        } as Parameters<typeof store.addConnection>[0]);
        idb.dbs.set(profileVfsDatabaseName(doomed), new Map());
        idb.dbs.set(profileVfsDatabaseName(keep), new Map());

        useAppStore.getState().removeConnection(doomed);
        // The sweep is fire-and-forget; let its microtasks settle.
        await new Promise(r => setTimeout(r, 0));

        expect(idb.dbs.has(profileVfsDatabaseName(doomed))).toBe(false);
        expect(idb.dbs.has(profileVfsDatabaseName(keep))).toBe(true);
        expect(useAppStore.getState().connections.map(c => c.id)).not.toContain(doomed);

        useAppStore.getState().removeConnection(keep);
        await new Promise(r => setTimeout(r, 0));
    });
});
