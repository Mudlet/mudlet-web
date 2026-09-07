import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Importing a whole-origin backup taken from the address Mudlet Web used to
 * live at.
 *
 * The interesting work is not reading the file — it is re-addressing what comes
 * out of it. Every piece of a profile's data is keyed by connection id, and the
 * importer deliberately does not reuse the old ids: profiles are created
 * through the store so they get fresh ones and non-clashing names, which is
 * what makes importing into a browser that is already in use (or importing the
 * same file twice) additive instead of destructive. So most of what is asserted
 * here is that every one of those keys followed the profile to its new id.
 *
 * mapStorage and logStorage are mocked: they own their own IndexedDB access and
 * are exercised elsewhere. What matters here is *what* the importer asks them
 * to store.
 */

const savedMaps: { id: string; bytes: number[] }[] = [];
vi.mock('../../src/storage/mapStorage', () => ({
    saveMap: async (connectionId: string, data: ArrayBuffer) => {
        savedMaps.push({ id: connectionId, bytes: [...new Uint8Array(data)] });
    },
}));

const createdSessions: { id: string; connectionId: string; connectionName: string }[] = [];
const appendedEntries: { id?: number; sessionId: string; plain: string }[] = [];
vi.mock('../../src/storage/logStorage', () => ({
    createSession: async (s: { id: string; connectionId: string; connectionName: string }) => {
        createdSessions.push(s);
    },
    appendEntries: async (entries: { id?: number; sessionId: string; plain: string }[]) => {
        appendedEntries.push(...entries);
    },
}));

import {
    parseBackup,
    summariseBackup,
    importBackup,
    decodeBackupValue,
    BACKUP_FORMAT,
    type MudletWebBackup,
} from '../../src/import/backupImport';
import { useAppStore } from '../../src/storage/appStore';
import { profileVfsDatabaseName } from '../../src/storage/profileStorage';
import { historyStorageKey } from '../../src/ui/commandHistory';
import { stopwatchStorageKey } from '../../src/scripting/StopwatchManager';
import { VAULT_STORAGE_KEY } from '../../src/vault/vaultRecord';

// ---------------------------------------------------------------------------
// A Map-backed IndexedDB, enough for the one thing the importer opens itself:
// creating a profile's ZenFS database and writing records into it.
// ---------------------------------------------------------------------------
type Store = Map<IDBValidKey, unknown>;
type Db = Map<string, Store>;

function fakeIndexedDB() {
    const dbs = new Map<string, Db>();
    const deletedDatabases: string[] = [];
    /** Databases whose write transaction fails, to exercise the rollback. */
    const failWrites = new Set<string>();
    /** Set to fail the next database opened, whatever it turns out to be named
     *  — the importer picks the name from an id the store has just minted. */
    const state = { failNextOpen: false };
    const fire = (fn: unknown) => { if (typeof fn === 'function') queueMicrotask(() => (fn as () => void)()); };

    const api = {
        open(name: string) {
            if (state.failNextOpen) { state.failNextOpen = false; failWrites.add(name); }
            const req: Record<string, unknown> = {};
            let db = dbs.get(name);
            const isNew = !db;
            if (!db) { db = new Map(); dbs.set(name, db); }
            req.result = {
                objectStoreNames: { contains: (n: string) => db!.has(n) },
                createObjectStore: (n: string) => { db!.set(n, new Map()); },
                close: () => {},
                transaction: (names: string | string[]) => {
                    const first = Array.isArray(names) ? names[0] : names;
                    const tx: Record<string, unknown> = {
                        error: null,
                        objectStore: (n: string) => ({
                            put: (value: unknown, key: IDBValidKey) => {
                                if (!db!.has(n)) db!.set(n, new Map());
                                db!.get(n)!.set(key, value);
                            },
                        }),
                    };
                    void first;
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
        // Rolling a failed profile back goes through removeConnection, which
        // deletes the profile's storage for real.
        deleteDatabase(name: string) {
            const req: Record<string, unknown> = {};
            queueMicrotask(() => {
                dbs.delete(name);
                deletedDatabases.push(name);
                (req.onsuccess as (() => void) | undefined)?.();
            });
            return req;
        },
    };
    return { api, dbs, deletedDatabases, failWrites, state };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OLD_A = 'old-achaea';
const OLD_B = 'old-aetolia';

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const view = (bytes: number[]) => ({ $: 'View', ctor: 'Uint8Array', v: b64(bytes) });

function vfsDatabase(oldId: string, bytes: number[]) {
    const name = `mudix_vfs_${oldId}`;
    return {
        [name]: {
            version: 1,
            stores: {
                [name]: {
                    keyPath: null,
                    autoIncrement: false,
                    records: [
                        { key: 0, value: view([1, 2, 3]) },
                        { key: 7, value: view(bytes) },
                    ],
                },
            },
        },
    };
}

function backupFixture(): MudletWebBackup {
    return parseBackup(JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        createdAt: '2026-09-07T10:00:00.000Z',
        origin: 'https://mudlet-web.mudlet.org',
        localStorage: {
            mudix_v1: JSON.stringify({
                state: {
                    connections: [
                        { id: OLD_A, name: 'Achaea', host: 'achaea.com', port: 23, mode: 'mud' },
                        { id: OLD_B, name: 'Aetolia', host: 'aetolia.com', port: 23, mode: 'mud' },
                    ],
                    client: { theme: 'solarized' },
                },
                version: 21,
            }),
            [`cmd.history.${OLD_A}`]: '["look","score"]',
            [`mudix_stopwatches_${OLD_A}`]: '{"sw":1}',
            [VAULT_STORAGE_KEY]: '{"version":1,"unlockers":[]}',
        },
        indexedDB: {
            ...vfsDatabase(OLD_A, [10, 20, 30]),
            ...vfsDatabase(OLD_B, [40, 50]),
            mudix_maps: {
                version: 1,
                stores: {
                    maps: {
                        keyPath: null,
                        autoIncrement: false,
                        records: [{ key: OLD_A, value: { $: 'ArrayBuffer', v: b64([200, 201, 202]) } }],
                    },
                },
            },
            mudix_logs: {
                version: 1,
                stores: {
                    sessions: {
                        keyPath: 'id',
                        autoIncrement: false,
                        records: [{
                            key: 's1',
                            value: { id: 's1', connectionId: OLD_A, connectionName: 'Achaea', startedAt: 1, endedAt: 2, entryCount: 1 },
                        }],
                    },
                    entries: {
                        keyPath: 'id',
                        autoIncrement: true,
                        records: [{
                            key: 41,
                            value: { id: 41, sessionId: 's1', seq: 0, timestamp: 1, type: 'mud', html: '<i>hi</i>', plain: 'hi' },
                        }],
                    },
                },
            },
        },
        skipped: [{ where: 'mudix_folder_handles', why: 'linked local folders are a browser permission' }],
    }));
}

let idb: ReturnType<typeof fakeIndexedDB>;

beforeEach(() => {
    savedMaps.length = 0;
    createdSessions.length = 0;
    appendedEntries.length = 0;
    localStorage.clear();
    useAppStore.setState({ connections: [] });
    idb = fakeIndexedDB();
    vi.stubGlobal('indexedDB', idb.api);
});

// ---------------------------------------------------------------------------

describe('parseBackup', () => {
    it('rejects a file that is not a backup, by name', () => {
        expect(() => parseBackup('not json at all')).toThrow(/valid JSON/);
        expect(() => parseBackup('{"hello":1}')).toThrow(/mudlet-web-backup/);
    });

    it('refuses a version it does not understand rather than guessing', () => {
        expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99 })))
            .toThrow(/newer than this client understands/);
    });

    it('tolerates a backup with nothing in it', () => {
        const b = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1 }));
        expect(b.localStorage).toEqual({});
        expect(b.indexedDB).toEqual({});
    });
});

describe('decodeBackupValue', () => {
    it('undoes each tag the exporter writes', () => {
        expect([...(decodeBackupValue({ $: 'View', ctor: 'Uint8Array', v: b64([1, 2, 255]) }) as Uint8Array)])
            .toEqual([1, 2, 255]);
        expect([...new Uint8Array(decodeBackupValue({ $: 'ArrayBuffer', v: b64([9]) }) as ArrayBuffer)])
            .toEqual([9]);
        expect(decodeBackupValue({ $: 'Date', v: '2026-01-02T03:04:05.000Z' }))
            .toEqual(new Date('2026-01-02T03:04:05.000Z'));
        expect(decodeBackupValue({ $: 'Map', v: [['k', 1]] })).toEqual(new Map([['k', 1]]));
        expect(decodeBackupValue({ $: 'Set', v: [1, 2] })).toEqual(new Set([1, 2]));
    });

    it('walks into nested structures', () => {
        const decoded = decodeBackupValue({ outer: [{ inner: { $: 'View', ctor: 'Uint8Array', v: b64([7]) } }] }) as
            { outer: { inner: Uint8Array }[] };
        expect([...decoded.outer[0].inner]).toEqual([7]);
    });

    // One field the export could not carry must not cost the record it is in.
    it('turns a value that could not be exported into undefined, not a throw', () => {
        expect(decodeBackupValue({ $: 'unsupported', kind: 'Blob' })).toBeUndefined();
    });
});

describe('summariseBackup', () => {
    it('lists what is in the file without touching anything', () => {
        const s = summariseBackup(backupFixture());
        expect(s.profiles.map(p => p.name)).toEqual(['Achaea', 'Aetolia']);
        expect(s.maps).toBe(1);
        expect(s.logSessions).toBe(1);
        expect(useAppStore.getState().connections).toEqual([]);
    });

    it('says up front that saved logins and linked folders do not come across', () => {
        const s = summariseBackup(backupFixture());
        expect(s.warnings.join(' ')).toMatch(/Saved logins are not imported/);
        expect(s.warnings.join(' ')).toMatch(/Linked local folders/);
    });

    // A truncated store blob must not bury the profile data that is still there.
    it('offers a profile whose connection row is missing but whose files survive', () => {
        const b = backupFixture();
        b.localStorage.mudix_v1 = JSON.stringify({ state: { connections: [] }, version: 21 });
        const s = summariseBackup(b);
        expect(s.profiles.map(p => p.id).sort()).toEqual([OLD_A, OLD_B].sort());
        expect(s.profiles.every(p => p.name === 'Recovered profile')).toBe(true);
    });
});

describe('importBackup', () => {
    it('creates each profile under a fresh id, not the one from the old address', async () => {
        const result = await importBackup(backupFixture());

        expect(result.imported.map(p => p.name)).toEqual(['Achaea', 'Aetolia']);
        const ids = useAppStore.getState().connections.map(c => c.id);
        expect(ids).not.toContain(OLD_A);
        expect(ids).not.toContain(OLD_B);
        expect(useAppStore.getState().connections[0].host).toBe('achaea.com');
    });

    it('restores each profile database under the name its new id gives it', async () => {
        const result = await importBackup(backupFixture());
        const achaea = result.imported[0].id;

        const dbName = profileVfsDatabaseName(achaea);
        const store = idb.dbs.get(dbName)?.get(dbName);
        expect(store).toBeDefined();
        // The ZenFS store is keyed by inode number and its records are byte
        // arrays; both have to survive the round trip exactly.
        expect([...(store!.get(7) as Uint8Array)]).toEqual([10, 20, 30]);
        expect([...(store!.get(0) as Uint8Array)]).toEqual([1, 2, 3]);
        expect(idb.dbs.has(profileVfsDatabaseName(OLD_A))).toBe(false);
    });

    it('re-addresses the map, logs, history and stopwatches to the new id', async () => {
        const result = await importBackup(backupFixture());
        const achaea = result.imported[0].id;

        expect(savedMaps).toEqual([{ id: achaea, bytes: [200, 201, 202] }]);
        expect(createdSessions).toHaveLength(1);
        expect(createdSessions[0].connectionId).toBe(achaea);
        expect(localStorage.getItem(historyStorageKey(achaea))).toBe('["look","score"]');
        expect(localStorage.getItem(stopwatchStorageKey(achaea))).toBe('{"sw":1}');
        // The old keys are not written back under their old names.
        expect(localStorage.getItem(historyStorageKey(OLD_A))).toBeNull();
    });

    // Entry ids are assigned by IndexedDB. Carrying one over would collide with
    // a row this browser already has.
    it('drops log entry ids so the store assigns fresh ones', async () => {
        await importBackup(backupFixture());
        expect(appendedEntries).toHaveLength(1);
        expect(appendedEntries[0].plain).toBe('hi');
        expect('id' in appendedEntries[0]).toBe(false);
    });

    it('never restores the credential vault', async () => {
        const result = await importBackup(backupFixture());
        expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBeNull();
        expect(result.warnings.join(' ')).toMatch(/Saved logins are not imported/);
    });

    it('adds alongside existing profiles instead of replacing them', async () => {
        useAppStore.getState().addConnection({ name: 'Achaea', url: 'ws://existing' } as never);
        const result = await importBackup(backupFixture());

        const names = useAppStore.getState().connections.map(c => c.name);
        expect(names).toEqual(['Achaea', 'Achaea (2)', 'Aetolia']);
        expect(result.imported.map(p => p.name)).toEqual(['Achaea (2)', 'Aetolia']);
        // The profile that was already here keeps its own connection details.
        expect(useAppStore.getState().connections[0].url).toBe('ws://existing');
    });

    it('runs twice without losing the first import', async () => {
        await importBackup(backupFixture());
        await importBackup(backupFixture());
        expect(useAppStore.getState().connections.map(c => c.name))
            .toEqual(['Achaea', 'Aetolia', 'Achaea (2)', 'Aetolia (2)']);
    });

    // Global settings are the one thing that is not per-profile, so there is no
    // id to re-address and no way to merge them without guessing.
    it('adopts client settings only into a browser with no profiles of its own', async () => {
        await importBackup(backupFixture());
        expect(useAppStore.getState().client.theme).toBe('solarized');
    });

    it('leaves client settings alone when the browser is already in use', async () => {
        useAppStore.getState().addConnection({ name: 'Mine', url: 'ws://x' } as never);
        useAppStore.getState().patchClient({ theme: 'dark' });
        const result = await importBackup(backupFixture());

        expect(useAppStore.getState().client.theme).toBe('dark');
        expect(result.warnings.join(' ')).toMatch(/Client settings .* were left as they are here/);
    });

    // A connection with no files behind it is worse than none: it looks like a
    // working profile and opens empty.
    it('rolls back the connection when a profile database cannot be written', async () => {
        idb.state.failNextOpen = true;   // the first profile's database write fails

        const result = await importBackup(backupFixture());

        expect(result.imported.map(p => p.name)).toEqual(['Aetolia']);
        expect(useAppStore.getState().connections.map(c => c.name)).toEqual(['Aetolia']);
        expect(result.warnings.join(' ')).toMatch(/Achaea: its files could not be restored/);
    });

    it('refuses a backup with no profiles in it', async () => {
        const empty = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1 }));
        await expect(importBackup(empty)).rejects.toThrow(/no profiles/);
    });
});
