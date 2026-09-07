/**
 * Renaming the browser storage namespace from `mudix_*` to `mudlet_*`.
 *
 * The project was donated to Mudlet and renamed, but its storage kept the old
 * name for one reason: the keys *are* the user's data. Change `mudix_v1` to
 * `mudlet_v1` with nothing else, and every existing profile becomes unreachable
 * — the app looks at the new name, finds nothing, and presents itself as a fresh
 * install while the real data sits in the old keys until the browser evicts it.
 * That is why CLAUDE.md forbade renaming these opportunistically.
 *
 * This module is what lifts that: it moves the data to the new names before
 * anything reads them, once, per browser. What it covers:
 *
 *   localStorage   mudix_v1, mudix_vault_v1, mudix_analytics_opt_out,
 *                  mudix_profile_migration_v21, mudix_stopwatches_<id>,
 *                  mudix.debug*, and cmd.history.<id> (never prefixed at all)
 *   IndexedDB      mudix_vfs_<connectionId> (one per profile), mudix_maps,
 *                  mudix_logs, mudix_folder_handles
 *
 * The `.mudix/` directory *inside* each profile's filesystem is not here. It can
 * only be touched with the profile mounted, so it is migrated lazily on open —
 * see profileVfsData.ts.
 *
 * ## Ordering
 *
 * The two halves run at different times because they are read at different
 * times, and both have to be in place before their first reader:
 *
 *   - **localStorage is synchronous and is read during module evaluation.**
 *     Zustand's `persist` hydrates the store when appStore.ts is imported, and
 *     the vault and analytics read their keys just as eagerly. So
 *     {@link migrateLocalStorageNames} is synchronous and is called at the top
 *     of each of those modules, before the read. It is memoised, so the call is
 *     free after the first. Getting this wrong is not a cosmetic bug: the store
 *     would hydrate empty and then persist that emptiness over the real data.
 *
 *   - **IndexedDB is asynchronous and is never read during import.** Every
 *     database in the app is opened through one `openDb()` per module, so those
 *     await {@link whenIdbNamesMigrated} and the rename lands before any reader.
 *
 * Doing it this way rather than in `main.tsx` is deliberate: branded builds
 * import `MudletWebApp` directly and never run that entry, and they have the
 * same data to protect.
 *
 * ## Interruption
 *
 * A copy is not a move, and a browser tab can close mid-way. Each database is
 * therefore copied, verified, and only then is the original deleted — and the
 * target is deleted before the copy starts, so a half-finished attempt from a
 * previous run cannot be mistaken for a good one. Interrupted at any point, the
 * next run either redoes that database or finds it already done. The completion
 * markers are written last.
 */

const LOCAL_MARKER = 'mudlet_names_migrated';
const IDB_MARKER = 'mudlet_idb_names_migrated';

/** Fixed one-to-one localStorage renames. */
const LOCAL_KEY_RENAMES: [legacy: string, current: string][] = [
    ['mudix_v1', 'mudlet_v1'],
    ['mudix_vault_v1', 'mudlet_vault_v1'],
    ['mudix_analytics_opt_out', 'mudlet_analytics_opt_out'],
    ['mudix_profile_migration_v21', 'mudlet_profile_migration_v21'],
    // The connection screen's history, which has no profile to be keyed by and
    // so is stored under the bare prefix — not caught by the prefix rule below.
    ['cmd.history', 'mudlet_history'],
];

/** Prefix renames, for the keys that carry a connection id or a flag name. */
const LOCAL_PREFIX_RENAMES: [legacy: string, current: string][] = [
    ['mudix_stopwatches_', 'mudlet_stopwatches_'],
    // Command history was never prefixed with the project name at all.
    ['cmd.history.', 'mudlet_history_'],
    ['mudix.debug', 'mudlet.debug'],
];

/** Fixed IndexedDB database renames. The per-profile `mudix_vfs_<id>` databases
 *  are found at run time. */
const DATABASE_RENAMES: [legacy: string, current: string][] = [
    ['mudix_maps', 'mudlet_maps'],
    ['mudix_logs', 'mudlet_logs'],
    ['mudix_folder_handles', 'mudlet_folder_handles'],
];

const LEGACY_VFS_PREFIX = 'mudix_vfs_';
const CURRENT_VFS_PREFIX = 'mudlet_vfs_';

/** Records moved per transaction when copying a database. Bounds peak memory on
 *  a big log store, which can hold hundreds of thousands of rows. */
const COPY_BATCH = 250;

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

let localDone = false;

/**
 * Move every legacy localStorage key to its new name. Synchronous, idempotent
 * and memoised — call it at the top of any module that reads storage during
 * import, and as often as you like.
 *
 * A key already present under the new name wins: it is the live one, and an
 * abandoned legacy key left over from an older build must not overwrite it.
 */
export function migrateLocalStorageNames(): void {
    if (localDone) return;
    localDone = true;
    if (typeof localStorage === 'undefined') return;

    try {
        if (localStorage.getItem(LOCAL_MARKER)) return;

        for (const [legacy, current] of LOCAL_KEY_RENAMES) moveKey(legacy, current);

        // Snapshot the key list: moving keys mutates it while we walk.
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) keys.push(k);
        }
        for (const key of keys) {
            for (const [legacy, current] of LOCAL_PREFIX_RENAMES) {
                if (key.startsWith(legacy)) {
                    moveKey(key, current + key.slice(legacy.length));
                    break;
                }
            }
        }

        localStorage.setItem(LOCAL_MARKER, '1');
    } catch {
        // Storage blocked (private mode, or a browser configured to refuse it).
        // Nothing to migrate and nothing that can be persisted anyway.
    }
}

function moveKey(legacy: string, current: string): void {
    const value = localStorage.getItem(legacy);
    if (value === null) return;
    if (localStorage.getItem(current) === null) localStorage.setItem(current, value);
    localStorage.removeItem(legacy);
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

let idbPromise: Promise<void> | null = null;

/**
 * Resolves once every legacy database has been renamed. Awaited by each module's
 * `openDb()`, so no reader can see the old names.
 *
 * Never rejects: a browser that cannot complete the rename should still open the
 * app. A database that failed to move keeps its old name and is retried on the
 * next load, because the marker is only written on a clean pass.
 */
export function whenIdbNamesMigrated(): Promise<void> {
    if (!idbPromise) idbPromise = runIdbMigration().catch(err => {
        console.warn('[storage] database rename did not complete:', err);
    });
    return idbPromise;
}

async function runIdbMigration(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    if (typeof localStorage !== 'undefined' && localStorage.getItem(IDB_MARKER)) return;

    const legacyNames = await findLegacyDatabases();
    let complete = true;

    for (const legacy of legacyNames) {
        const current = legacy.startsWith(LEGACY_VFS_PREFIX)
            ? CURRENT_VFS_PREFIX + legacy.slice(LEGACY_VFS_PREFIX.length)
            : DATABASE_RENAMES.find(([from]) => from === legacy)?.[1];
        if (!current) continue;
        try {
            await renameDatabase(legacy, current);
        } catch (err) {
            console.warn(`[storage] could not rename ${legacy}:`, err);
            complete = false;
        }
    }

    if (complete && typeof localStorage !== 'undefined') {
        try { localStorage.setItem(IDB_MARKER, '1'); } catch { /* not fatal */ }
    }
}

/**
 * Legacy databases that actually exist.
 *
 * `indexedDB.databases()` is the direct answer where it exists. Firefox has no
 * such method, so there the names are derived from the profile list instead —
 * and {@link openIfExists} drops any that turn out not to be there.
 */
async function findLegacyDatabases(): Promise<string[]> {
    const isLegacy = (name: string) =>
        name.startsWith(LEGACY_VFS_PREFIX) || DATABASE_RENAMES.some(([from]) => from === name);

    if (typeof indexedDB.databases === 'function') {
        try {
            const list = await indexedDB.databases();
            return list.map(d => d.name).filter((n): n is string => !!n && isLegacy(n));
        } catch { /* fall through to the derived list */ }
    }

    const derived = DATABASE_RENAMES.map(([from]) => from);
    try {
        // By now the store blob has been renamed, but read either — this runs
        // before the app has necessarily touched localStorage at all.
        const raw = localStorage.getItem('mudlet_v1') ?? localStorage.getItem('mudix_v1');
        const parsed = raw ? JSON.parse(raw) as { state?: { connections?: { id?: string }[] } } : null;
        for (const c of parsed?.state?.connections ?? []) {
            if (c?.id) derived.push(LEGACY_VFS_PREFIX + c.id);
        }
    } catch { /* no profile list; the fixed names still apply */ }

    const present: string[] = [];
    for (const name of derived) {
        const db = await openIfExists(name);
        if (db) { db.close(); present.push(name); }
    }
    return present;
}

/**
 * How long any single IndexedDB call is given before the migration gives up on
 * it. Every reader in the app waits behind this, so it must not be possible for
 * a wedged or half-implemented IndexedDB to keep the app from starting: a step
 * that times out leaves the marker unwritten and is retried on the next load.
 */
const STEP_TIMEOUT_MS = 10000;

function withTimeout<T>(work: Promise<T>, fallback: T, what: string): Promise<T> {
    return new Promise<T>(resolve => {
        let settled = false;
        const done = (value: T) => { if (!settled) { settled = true; resolve(value); } };
        const timer = setTimeout(() => {
            console.warn(`[storage] ${what} did not answer in ${STEP_TIMEOUT_MS}ms`);
            done(fallback);
        }, STEP_TIMEOUT_MS);
        work.then(value => { clearTimeout(timer); done(value); },
            () => { clearTimeout(timer); done(fallback); });
    });
}

/** Open a database only if it already exists — `indexedDB.open` on an unknown
 *  name creates an empty one, which would leave litter for every guess. */
function openIfExists(name: string): Promise<IDBDatabase | null> {
    return withTimeout(new Promise<IDBDatabase | null>(resolve => {
        let fresh = false;
        let req: IDBOpenDBRequest;
        try {
            req = indexedDB.open(name);
        } catch {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => { fresh = true; };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
        req.onsuccess = () => {
            // Anything in here that throws would leave this promise pending
            // forever, and every reader in the app waiting on it.
            try {
                const db = req.result;
                if (fresh) {
                    db.close();
                    indexedDB.deleteDatabase(name);
                    resolve(null);
                    return;
                }
                resolve(db);
            } catch {
                resolve(null);
            }
        };
    }), null, `opening ${name}`);
}

/** A source store plus the name it is copied to: a profile filesystem lives in
 *  a store named after its database, so both change together. */
interface RenamedStore extends StoreSchema {
    target: string;
}

interface StoreSchema {
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
}

/**
 * Copy `legacy` to `current`, verify it, then delete `legacy`.
 *
 * IndexedDB has no rename, and no transaction can span two databases, so this
 * cannot be atomic. It is instead ordered so that every interruption point
 * leaves the data readable from one name or the other, and re-running finishes
 * the job.
 */
async function renameDatabase(legacy: string, current: string): Promise<void> {
    const source = await openIfExists(legacy);
    if (!source) return;

    let schema: StoreSchema[];
    let sourceVersion: number;
    try {
        sourceVersion = source.version;
        schema = readSchema(source);
    } finally {
        source.close();
    }

    // A profile's filesystem lives in a store named after its database, because
    // that is the one name ZenFS is given (`storeName`, see ProfileVFS). Renaming
    // the database alone would leave the data in a store nothing looks in, and
    // the profile would open empty — so the store is renamed with it.
    const renamed = schema.map(store => ({
        ...store,
        target: store.name === legacy ? current : store.name,
    }));

    // Any target is either a completed earlier rename or the wreckage of an
    // interrupted one, and the two are indistinguishable — so start clean. The
    // legacy database still holds everything at this point.
    await deleteDatabase(current);

    const target = await createDatabase(current, sourceVersion,
        renamed.map(s => ({ ...s, name: s.target })));
    try {
        for (const store of renamed) {
            await copyStore(legacy, store.name, store.target, target);
        }
    } finally {
        target.close();
    }

    await verifyCopy(legacy, current, renamed);
    await deleteDatabase(legacy);
}

function readSchema(db: IDBDatabase): StoreSchema[] {
    const names = Array.from(db.objectStoreNames);
    if (!names.length) return [];
    const tx = db.transaction(names, 'readonly');
    return names.map(name => {
        const store = tx.objectStore(name);
        return {
            name,
            keyPath: store.keyPath as string | string[] | null,
            autoIncrement: store.autoIncrement,
            indexes: Array.from(store.indexNames).map(i => {
                const index = store.index(i);
                return {
                    name: index.name,
                    keyPath: index.keyPath as string | string[],
                    unique: index.unique,
                    multiEntry: index.multiEntry,
                };
            }),
        };
    });
}

function createDatabase(name: string, version: number, schema: StoreSchema[]): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => {
            const db = req.result;
            for (const store of schema) {
                const created = db.createObjectStore(store.name, {
                    keyPath: store.keyPath as string | string[] | undefined,
                    autoIncrement: store.autoIncrement,
                });
                for (const index of store.indexes) {
                    created.createIndex(index.name, index.keyPath, {
                        unique: index.unique,
                        multiEntry: index.multiEntry,
                    });
                }
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error(`another tab is holding ${name} open`));
    });
}

/**
 * Move one store's records across in batches.
 *
 * Keys are read up front (they are small) and the values fetched a batch at a
 * time, so a log store with hundreds of thousands of rows never has to fit in
 * memory all at once. The source is reopened per batch because a transaction
 * cannot stay alive across an await on another database.
 */
async function copyStore(legacyDb: string, sourceStore: string, targetStore: string, target: IDBDatabase): Promise<void> {
    const source = await openIfExists(legacyDb);
    if (!source) return;
    let keys: IDBValidKey[];
    try {
        keys = await request<IDBValidKey[]>(
            source.transaction(sourceStore, 'readonly').objectStore(sourceStore).getAllKeys());
    } finally {
        source.close();
    }

    for (let i = 0; i < keys.length; i += COPY_BATCH) {
        const slice = keys.slice(i, i + COPY_BATCH);
        const batch = await readBatch(legacyDb, sourceStore, slice);
        await writeBatch(target, targetStore, slice, batch);
    }
}

async function readBatch(legacyName: string, storeName: string, keys: IDBValidKey[]): Promise<unknown[]> {
    const db = await openIfExists(legacyName);
    if (!db) return [];
    try {
        const store = db.transaction(storeName, 'readonly').objectStore(storeName);
        return await Promise.all(keys.map(key => request<unknown>(store.get(key))));
    } finally {
        db.close();
    }
}

function writeBatch(target: IDBDatabase, storeName: string, keys: IDBValidKey[], values: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = target.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (let i = 0; i < values.length; i++) {
            if (values[i] === undefined) continue;
            // An in-line key is part of the value; passing it separately throws.
            if (store.keyPath === null) store.put(values[i], keys[i]);
            else store.put(values[i]);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
    });
}

/** Refuse to delete the original until the copy holds as much as it did. */
async function verifyCopy(legacy: string, current: string, schema: RenamedStore[]): Promise<void> {
    const before = await countRecords(legacy, schema.map(s => s.name));
    const after = await countRecords(current, schema.map(s => s.target));
    for (const store of schema) {
        if ((after[store.target] ?? -1) < (before[store.name] ?? 0)) {
            throw new Error(`${current}/${store.target} has ${after[store.target]} of `
                + `${before[store.name]} records; keeping ${legacy}`);
        }
    }
}

async function countRecords(name: string, stores: string[]): Promise<Record<string, number>> {
    const db = await openIfExists(name);
    if (!db) return {};
    try {
        const counts: Record<string, number> = {};
        for (const store of stores) {
            if (!db.objectStoreNames.contains(store)) { counts[store] = 0; continue; }
            counts[store] = await request<number>(
                db.transaction(store, 'readonly').objectStore(store).count());
        }
        return counts;
    } finally {
        db.close();
    }
}

function deleteDatabase(name: string): Promise<void> {
    return withTimeout(new Promise<void>(resolve => {
        let req: IDBOpenDBRequest;
        try {
            req = indexedDB.deleteDatabase(name);
        } catch {
            resolve();
            return;
        }
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        // Held open elsewhere. The request stays queued and completes when that
        // connection closes; not worth blocking the app's start on.
        req.onblocked = () => resolve();
    }), undefined, `deleting ${name}`);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Test seam: forget that the migration has run. */
export function resetStorageMigrationForTests(): void {
    localDone = false;
    idbPromise = null;
}

/**
 * Test seam: declare the rename already done.
 *
 * Every `openDb()` in the app now waits on this migration, so a test that hands
 * the code a stand-in IndexedDB would otherwise have to satisfy the migration's
 * schema-reading and copying as well as whatever it is actually testing. Tests
 * that are not about the rename say so with this.
 */
export function markStorageMigrationDoneForTests(): void {
    localDone = true;
    idbPromise = Promise.resolve();
}
