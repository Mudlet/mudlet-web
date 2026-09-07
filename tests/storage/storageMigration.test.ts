import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Renaming the storage namespace from `mudix_*` to `mudlet_*`.
 *
 * The keys *are* the user's data: get this wrong and every existing profile
 * becomes unreachable while the app presents itself as a fresh install. So the
 * cases that matter here are not the happy path but the ones where something
 * goes wrong halfway — an interrupted copy, a database that will not open, a
 * value already present under the new name — and in every one of them the rule
 * is the same: never delete the old copy until the new one is known good, and
 * never write the marker unless the whole pass succeeded.
 */

import {
    migrateLocalStorageNames,
    whenIdbNamesMigrated,
    resetStorageMigrationForTests,
} from '../../src/storage/storageMigration';

// ---------------------------------------------------------------------------
// A Map-backed IndexedDB with enough fidelity for a rename: schema on open,
// getAllKeys/get/put/count, deleteDatabase, and the ability to fail on demand.
// ---------------------------------------------------------------------------
interface FakeStore {
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
    records: Map<IDBValidKey, unknown>;
}
type FakeDb = { version: number; stores: Map<string, FakeStore> };

function fakeIndexedDB() {
    const dbs = new Map<string, FakeDb>();
    /** Databases whose write transactions fail, to interrupt a copy. */
    const failWrites = new Set<string>();
    const fire = (fn: unknown) => { if (typeof fn === 'function') queueMicrotask(() => (fn as () => void)()); };

    function makeStore(db: FakeDb, name: string) {
        const store = db.stores.get(name)!;
        const req = <T>(result: T) => {
            const r: Record<string, unknown> = { result };
            fire(() => (r.onsuccess as (() => void) | undefined)?.());
            return r;
        };
        return {
            get keyPath() { return store.keyPath; },
            get autoIncrement() { return store.autoIncrement; },
            indexNames: [...store.indexes.map(i => i.name)],
            index: (n: string) => store.indexes.find(i => i.name === n)!,
            createIndex: (n: string, keyPath: string | string[], opts?: IDBIndexParameters) => {
                store.indexes.push({
                    name: n, keyPath,
                    unique: !!opts?.unique, multiEntry: !!opts?.multiEntry,
                });
            },
            getAllKeys: () => req([...store.records.keys()]),
            get: (key: IDBValidKey) => req(store.records.get(key)),
            count: () => req(store.records.size),
            put: (value: unknown, key?: IDBValidKey) => {
                const k = key ?? (store.keyPath ? (value as Record<string, IDBValidKey>)[store.keyPath as string] : undefined);
                store.records.set(k!, value);
            },
        };
    }

    const api = {
        databases: async () => [...dbs.keys()].map(name => ({ name, version: dbs.get(name)!.version })),
        open(name: string, version?: number) {
            const req: Record<string, unknown> = {};
            const isNew = !dbs.has(name);
            if (isNew) dbs.set(name, { version: version ?? 1, stores: new Map() });
            const db = dbs.get(name)!;
            req.result = {
                name,
                get version() { return db.version; },
                get objectStoreNames() {
                    const names = [...db.stores.keys()];
                    return Object.assign(names, { contains: (n: string) => db.stores.has(n) });
                },
                close: () => {},
                createObjectStore: (n: string, opts?: IDBObjectStoreParameters) => {
                    db.stores.set(n, {
                        keyPath: (opts?.keyPath as string | null) ?? null,
                        autoIncrement: !!opts?.autoIncrement,
                        indexes: [],
                        records: new Map(),
                    });
                    return makeStore(db, n);
                },
                transaction: (names: string | string[]) => {
                    const tx: Record<string, unknown> = {
                        error: null,
                        objectStore: (n: string) => makeStore(db, n),
                    };
                    void names;
                    fire(() => {
                        if (failWrites.has(name)) (tx.onerror as (() => void) | undefined)?.();
                        else (tx.oncomplete as (() => void) | undefined)?.();
                    });
                    return tx;
                },
            };
            queueMicrotask(() => {
                if (isNew) (req.onupgradeneeded as (() => void) | undefined)?.();
                (req.onsuccess as (() => void) | undefined)?.();
            });
            return req;
        },
        deleteDatabase(name: string) {
            const req: Record<string, unknown> = {};
            queueMicrotask(() => {
                dbs.delete(name);
                (req.onsuccess as (() => void) | undefined)?.();
            });
            return req;
        },
    };
    return { api, dbs, failWrites };
}

function seedDb(idb: ReturnType<typeof fakeIndexedDB>, name: string, stores: Record<string, {
    keyPath?: string | null;
    autoIncrement?: boolean;
    indexes?: { name: string; keyPath: string; unique: boolean; multiEntry: boolean }[];
    records: [IDBValidKey, unknown][];
}>) {
    const db: FakeDb = { version: 1, stores: new Map() };
    for (const [storeName, spec] of Object.entries(stores)) {
        db.stores.set(storeName, {
            keyPath: spec.keyPath ?? null,
            autoIncrement: !!spec.autoIncrement,
            indexes: spec.indexes ?? [],
            records: new Map(spec.records),
        });
    }
    idb.dbs.set(name, db);
}

const records = (idb: ReturnType<typeof fakeIndexedDB>, db: string, store: string) =>
    idb.dbs.get(db)?.stores.get(store)?.records;

let idb: ReturnType<typeof fakeIndexedDB>;

beforeEach(() => {
    localStorage.clear();
    resetStorageMigrationForTests();
    idb = fakeIndexedDB();
    vi.stubGlobal('indexedDB', idb.api);
});

afterEach(() => {
    resetStorageMigrationForTests();
});

// ---------------------------------------------------------------------------

describe('migrateLocalStorageNames', () => {
    it('moves every key the old namespace used', () => {
        localStorage.setItem('mudix_v1', '{"state":{}}');
        localStorage.setItem('mudix_vault_v1', 'vault');
        localStorage.setItem('mudix_analytics_opt_out', '1');
        localStorage.setItem('mudix_stopwatches_abc', '{}');
        localStorage.setItem('mudix.debugGmcp', '1');

        migrateLocalStorageNames();

        expect(localStorage.getItem('mudlet_v1')).toBe('{"state":{}}');
        expect(localStorage.getItem('mudlet_vault_v1')).toBe('vault');
        expect(localStorage.getItem('mudlet_analytics_opt_out')).toBe('1');
        expect(localStorage.getItem('mudlet_stopwatches_abc')).toBe('{}');
        expect(localStorage.getItem('mudlet.debugGmcp')).toBe('1');
        expect(localStorage.getItem('mudix_v1')).toBeNull();
    });

    // Command history was the one key with no project prefix at all, which is
    // exactly how it got missed the first time round.
    it('moves command history, prefixed and bare', () => {
        localStorage.setItem('cmd.history.conn-1', '["look"]');
        localStorage.setItem('cmd.history', '["connect"]');

        migrateLocalStorageNames();

        expect(localStorage.getItem('mudlet_history_conn-1')).toBe('["look"]');
        expect(localStorage.getItem('mudlet_history')).toBe('["connect"]');
        expect(localStorage.getItem('cmd.history.conn-1')).toBeNull();
        expect(localStorage.getItem('cmd.history')).toBeNull();
    });

    it('leaves keys that are already current alone', () => {
        localStorage.setItem('mudlet_v1', 'new');
        localStorage.setItem('mudix_v1', 'old');

        migrateLocalStorageNames();

        // The new key is the live one; a leftover old key must not overwrite it.
        expect(localStorage.getItem('mudlet_v1')).toBe('new');
        expect(localStorage.getItem('mudix_v1')).toBeNull();
    });

    it('does not touch anything on a second run', () => {
        localStorage.setItem('mudix_v1', 'first');
        migrateLocalStorageNames();
        resetStorageMigrationForTests();

        localStorage.setItem('mudix_v1', 'a stale leftover');
        migrateLocalStorageNames();

        expect(localStorage.getItem('mudlet_v1')).toBe('first');
    });
});

describe('whenIdbNamesMigrated', () => {
    it('renames each database, keeping its records', async () => {
        seedDb(idb, 'mudix_maps', { maps: { records: [['conn-1', new Uint8Array([1, 2, 3])]] } });
        seedDb(idb, 'mudix_vfs_conn-1', { 'mudix_vfs_conn-1': { records: [[0, new Uint8Array([9])], [7, new Uint8Array([8])]] } });

        await whenIdbNamesMigrated();

        expect(records(idb, 'mudlet_maps', 'maps')?.get('conn-1')).toEqual(new Uint8Array([1, 2, 3]));
        // The store inside a profile database shares its name, so it is renamed too.
        expect(records(idb, 'mudlet_vfs_conn-1', 'mudlet_vfs_conn-1')?.size).toBe(2);
        expect(idb.dbs.has('mudix_maps')).toBe(false);
        expect(idb.dbs.has('mudix_vfs_conn-1')).toBe(false);
    });

    it('carries the store schema across, not just the rows', async () => {
        seedDb(idb, 'mudix_logs', {
            sessions: { keyPath: 'id', records: [['s1', { id: 's1' }]] },
            entries: {
                keyPath: 'id',
                autoIncrement: true,
                indexes: [{ name: 'sessionId', keyPath: 'sessionId', unique: false, multiEntry: false }],
                records: [[1, { id: 1, sessionId: 's1' }]],
            },
        });

        await whenIdbNamesMigrated();

        const entries = idb.dbs.get('mudlet_logs')!.stores.get('entries')!;
        expect(entries.keyPath).toBe('id');
        expect(entries.autoIncrement).toBe(true);
        expect(entries.indexes[0]).toMatchObject({ name: 'sessionId', keyPath: 'sessionId' });
        // An in-line key lives in the value; writing it back out separately throws.
        expect(entries.records.get(1)).toEqual({ id: 1, sessionId: 's1' });
    });

    it('records the pass so a second load does no work', async () => {
        seedDb(idb, 'mudix_maps', { maps: { records: [['c', 1]] } });
        await whenIdbNamesMigrated();
        expect(localStorage.getItem('mudlet_idb_names_migrated')).toBe('1');

        // A stale legacy database appearing later is not touched: the pass is done.
        resetStorageMigrationForTests();
        seedDb(idb, 'mudix_maps', { maps: { records: [['later', 2]] } });
        await whenIdbNamesMigrated();
        expect(idb.dbs.has('mudix_maps')).toBe(true);
    });

    // The one thing this must never do is lose data. A failed copy keeps the
    // original and leaves the marker unwritten, so the next load tries again.
    it('keeps the original when the copy fails, and retries next time', async () => {
        seedDb(idb, 'mudix_maps', { maps: { records: [['conn-1', 'the only copy']] } });
        idb.failWrites.add('mudlet_maps');

        await whenIdbNamesMigrated();

        expect(idb.dbs.has('mudix_maps')).toBe(true);
        expect(records(idb, 'mudix_maps', 'maps')?.get('conn-1')).toBe('the only copy');
        expect(localStorage.getItem('mudlet_idb_names_migrated')).toBeNull();

        // Second load, without the fault: it completes.
        idb.failWrites.clear();
        resetStorageMigrationForTests();
        await whenIdbNamesMigrated();

        expect(records(idb, 'mudlet_maps', 'maps')?.get('conn-1')).toBe('the only copy');
        expect(idb.dbs.has('mudix_maps')).toBe(false);
        expect(localStorage.getItem('mudlet_idb_names_migrated')).toBe('1');
    });

    // An interrupted run can leave a partial target. It must be discarded rather
    // than mistaken for a finished rename.
    it('discards the wreckage of an interrupted attempt', async () => {
        seedDb(idb, 'mudix_maps', { maps: { records: [['a', 1], ['b', 2]] } });
        seedDb(idb, 'mudlet_maps', { maps: { records: [['a', 'half-written']] } });

        await whenIdbNamesMigrated();

        expect(records(idb, 'mudlet_maps', 'maps')?.get('a')).toBe(1);
        expect(records(idb, 'mudlet_maps', 'maps')?.size).toBe(2);
    });

    it('never rejects, whatever IndexedDB does', async () => {
        vi.stubGlobal('indexedDB', {
            databases: () => Promise.reject(new Error('nope')),
            open: () => { throw new Error('nope'); },
            deleteDatabase: () => { throw new Error('nope'); },
        });
        await expect(whenIdbNamesMigrated()).resolves.toBeUndefined();
    });

    it('does nothing when there is nothing to rename', async () => {
        seedDb(idb, 'mudlet_maps', { maps: { records: [['c', 1]] } });
        await whenIdbNamesMigrated();
        expect(records(idb, 'mudlet_maps', 'maps')?.get('c')).toBe(1);
        expect([...idb.dbs.keys()]).toEqual(['mudlet_maps']);
    });
});
