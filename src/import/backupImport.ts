/**
 * Importing a whole-origin backup taken from a previous Mudlet Web address.
 *
 * Browser storage is keyed per address. When the client moved from
 * `mudlet-web.mudlet.org` to `web.mudlet.org` every profile, script, package
 * and map stayed behind on the old origin, reachable by nothing — the app that
 * could read them was no longer served there. The holding page left at the old
 * address (Mudlet/mudlet-web-moved) writes all of it to one `mudlet-web-backup`
 * JSON file; this module is the other half, and reads that file back in.
 *
 * The file is a verbatim dump of the old origin's storage, so nothing here has
 * to understand the *meaning* of a profile's data. What it does have to do is
 * re-address it:
 *
 *   - Every profile is created through {@link AppSchema.addConnection}, so it
 *     gets a fresh id and a non-clashing name from the store rather than being
 *     forced in under the old one. Importing into a browser that already has
 *     profiles is therefore additive: nothing existing is overwritten, and
 *     importing the same file twice yields "Achaea" and "Achaea (2)" rather
 *     than a silent clobber.
 *   - Everything keyed by the *old* connection id is rewritten to the new one:
 *     the profile's ZenFS database, its map, its logs, its command history and
 *     its stopwatches. `profileStorage.ts` holds the same inventory from the
 *     deletion side; the two must stay in step.
 *
 * A profile's ZenFS database is restored by copying its records verbatim into a
 * database named for the new id. The store is keyed by inode number and holds
 * no reference to its own name, so the copy is the same filesystem — verified
 * in a browser against the real ProfileVFS before this was written. Everything
 * per-profile that is not the connection row itself (settings, layout, and the
 * automation trees in `.mudix/profile.json`) rides along inside it.
 */

import { useAppStore, type MudConnection, type ClientSettings } from '../storage';
import { profileVfsDatabaseName } from '../storage/profileStorage';
import { saveMap } from '../storage/mapStorage';
import { createSession, appendEntries, type LogSession, type LogEntry } from '../storage/logStorage';
import { historyStorageKey } from '../ui/commandHistory';
import { stopwatchStorageKey } from '../scripting/StopwatchManager';
import { VAULT_STORAGE_KEY } from '../vault/vaultRecord';

/** The `format` string every backup file carries. */
export const BACKUP_FORMAT = 'mudlet-web-backup';
/** The highest `version` this importer understands. */
export const BACKUP_MAX_VERSION = 1;

const STORE_KEY = 'mudix_v1';
const MAPS_DB = 'mudix_maps';
const LOGS_DB = 'mudix_logs';
const VFS_DB_PREFIX = 'mudix_vfs_';

// ---------------------------------------------------------------------------
// File shape
// ---------------------------------------------------------------------------

interface BackupRecord {
    key: unknown;
    value: unknown;
}

interface BackupStore {
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    records: BackupRecord[];
}

interface BackupDatabase {
    version: number;
    stores: Record<string, BackupStore>;
}

export interface MudletWebBackup {
    format: string;
    version: number;
    createdAt?: string;
    origin?: string;
    localStorage: Record<string, string>;
    indexedDB: Record<string, BackupDatabase>;
    skipped?: { where: string; why: string }[];
}

/** What a file holds, for the confirmation the user sees before committing. */
export interface BackupSummary {
    createdAt: string | null;
    origin: string | null;
    /** Profiles in the file, in the order they will be created. */
    profiles: { id: string; name: string }[];
    /** How many of those profiles have a stored map. */
    maps: number;
    logSessions: number;
    /** Notes worth showing up front — things that will not come across. */
    warnings: string[];
}

export interface BackupImportResult {
    /** Profiles created, under the names they actually got. */
    imported: { id: string; name: string }[];
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

type Tagged = { $: string; v?: unknown; ctor?: string; kind?: string };

function isTagged(value: unknown): value is Tagged {
    return typeof value === 'object' && value !== null && typeof (value as Tagged).$ === 'string';
}

/**
 * Undo the exporter's tagging. Plain JSON passes through untouched; anything
 * structured clone can hold that JSON cannot arrives as a `$`-tagged object.
 *
 * A value the exporter could not carry at all (`$: 'unsupported'`) decodes to
 * `undefined` rather than throwing: one unreadable field in one log row must
 * not cost the user the profile it belongs to.
 */
export function decodeBackupValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decodeBackupValue);
    if (!isTagged(value)) {
        if (typeof value === 'object' && value !== null) {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) out[k] = decodeBackupValue(v);
            return out;
        }
        return value;
    }
    switch (value.$) {
        case 'ArrayBuffer':
            return base64ToBytes(String(value.v)).buffer;
        case 'View': {
            const bytes = base64ToBytes(String(value.v));
            // Uint8Array covers every view this app stores. Anything else is
            // rebuilt over the same bytes by name, and falls back to the raw
            // bytes if the name is not a view constructor on this platform.
            if (!value.ctor || value.ctor === 'Uint8Array') return bytes;
            const ctor = (globalThis as Record<string, unknown>)[value.ctor] as
                | (new (buffer: ArrayBufferLike) => ArrayBufferView)
                | undefined;
            return typeof ctor === 'function' ? new ctor(bytes.buffer) : bytes;
        }
        case 'Date':
            return new Date(String(value.v));
        case 'Map':
            return new Map((value.v as [unknown, unknown][]).map(([k, v]) => [decodeBackupValue(k), decodeBackupValue(v)]));
        case 'Set':
            return new Set((value.v as unknown[]).map(decodeBackupValue));
        case 'bigint':
            return BigInt(String(value.v));
        case 'number':
            return Number(value.v);
        case 'undefined':
        case 'unsupported':
        default:
            return undefined;
    }
}

/**
 * Read and check a backup file.
 *
 * Deliberately strict about the envelope and forgiving about the contents: a
 * file that is not a backup at all should say so plainly, while a backup with
 * one unreadable section is still worth most of what it holds.
 */
export function parseBackup(text: string): MudletWebBackup {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error('That file is not valid JSON — pick the .json backup downloaded from the old address.');
    }
    if (typeof raw !== 'object' || raw === null) throw new Error('That file does not look like a Mudlet Web backup.');
    const b = raw as Partial<MudletWebBackup>;
    if (b.format !== BACKUP_FORMAT) {
        throw new Error('That file does not look like a Mudlet Web backup (no "' + BACKUP_FORMAT + '" marker).');
    }
    if (typeof b.version !== 'number' || b.version > BACKUP_MAX_VERSION) {
        throw new Error(`This backup is version ${String(b.version)}, which is newer than this client understands.`);
    }
    return {
        format: b.format,
        version: b.version,
        createdAt: typeof b.createdAt === 'string' ? b.createdAt : undefined,
        origin: typeof b.origin === 'string' ? b.origin : undefined,
        localStorage: (b.localStorage && typeof b.localStorage === 'object' ? b.localStorage : {}) as Record<string, string>,
        indexedDB: (b.indexedDB && typeof b.indexedDB === 'object' ? b.indexedDB : {}) as Record<string, BackupDatabase>,
        skipped: Array.isArray(b.skipped) ? b.skipped : [],
    };
}

// ---------------------------------------------------------------------------
// Reading the pieces out
// ---------------------------------------------------------------------------

/** The connection rows the old store blob held. */
function backedUpConnections(backup: MudletWebBackup): MudConnection[] {
    const raw = backup.localStorage[STORE_KEY];
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as { state?: { connections?: MudConnection[] } };
        const list = parsed?.state?.connections;
        return Array.isArray(list) ? list.filter(c => c && typeof c.id === 'string') : [];
    } catch {
        return [];
    }
}

function backedUpClientSettings(backup: MudletWebBackup): Partial<ClientSettings> | null {
    const raw = backup.localStorage[STORE_KEY];
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { state?: { client?: Partial<ClientSettings> } };
        const client = parsed?.state?.client;
        return client && typeof client === 'object' ? client : null;
    } catch {
        return null;
    }
}

/** Profile ids that have a VFS database in the file, whether or not the store
 *  blob still lists them. */
function backedUpVfsIds(backup: MudletWebBackup): string[] {
    return Object.keys(backup.indexedDB)
        .filter(name => name.startsWith(VFS_DB_PREFIX))
        .map(name => name.slice(VFS_DB_PREFIX.length));
}

function mapRecordFor(backup: MudletWebBackup, connectionId: string): ArrayBuffer | null {
    const store = backup.indexedDB[MAPS_DB]?.stores?.['maps'];
    const record = store?.records.find(r => r.key === connectionId);
    if (!record) return null;
    const decoded = decodeBackupValue(record.value);
    if (decoded instanceof ArrayBuffer) return decoded;
    if (ArrayBuffer.isView(decoded)) {
        const view = decoded as ArrayBufferView;
        return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    }
    return null;
}

function logSessionsFor(backup: MudletWebBackup, connectionId: string): LogSession[] {
    const store = backup.indexedDB[LOGS_DB]?.stores?.['sessions'];
    if (!store) return [];
    return store.records
        .map(r => decodeBackupValue(r.value) as LogSession)
        .filter(s => s && s.connectionId === connectionId);
}

function logEntriesFor(backup: MudletWebBackup, sessionIds: Set<string>): LogEntry[] {
    const store = backup.indexedDB[LOGS_DB]?.stores?.['entries'];
    if (!store) return [];
    return store.records
        .map(r => decodeBackupValue(r.value) as LogEntry)
        .filter(e => e && sessionIds.has(e.sessionId));
}

/**
 * What the file holds, without changing anything.
 *
 * Profiles come from the store blob first; a VFS database with no row left in
 * that blob is still offered, under a placeholder name, because the data in it
 * is the part worth rescuing and a truncated store blob should not bury it.
 */
export function summariseBackup(backup: MudletWebBackup): BackupSummary {
    const connections = backedUpConnections(backup);
    const known = new Set(connections.map(c => c.id));
    const profiles = connections.map(c => ({ id: c.id, name: c.name || 'Unnamed profile' }));
    for (const id of backedUpVfsIds(backup)) {
        if (!known.has(id)) profiles.push({ id, name: 'Recovered profile' });
    }

    const warnings: string[] = [];
    if (backup.localStorage[VAULT_STORAGE_KEY]) {
        warnings.push('Saved logins are not imported — passkeys are tied to the address they were created on. Re-enter and save them here.');
    }
    if (!backup.indexedDB[LOGS_DB]) {
        warnings.push('This backup has no session logs in it (they are optional on the export side).');
    }
    for (const note of backup.skipped ?? []) {
        if (note.where === 'mudix_folder_handles') {
            warnings.push('Linked local folders cannot be carried across addresses — re-link the folder after importing.');
        }
    }

    const maps = profiles.filter(p => mapRecordFor(backup, p.id) !== null).length;
    const logSessions = backup.indexedDB[LOGS_DB]?.stores?.['sessions']?.records.length ?? 0;

    return {
        createdAt: backup.createdAt ?? null,
        origin: backup.origin ?? null,
        profiles,
        maps,
        logSessions,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/**
 * Recreate a profile's ZenFS database under a new name.
 *
 * The exported store is keyed by inode number and holds no reference to its own
 * name, so writing the records into a database (and object store) named for the
 * new connection id produces the same filesystem. ZenFS opens its database at
 * the default version with an object store of the same name; this has to match
 * that shape exactly or the mount will find nothing.
 */
async function restoreVfsDatabase(sourceStore: BackupStore, newConnectionId: string): Promise<void> {
    if (typeof indexedDB === 'undefined') throw new Error('This browser has no IndexedDB, so profiles cannot be restored.');
    const name = profileVfsDatabaseName(newConnectionId);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
            const created = req.result;
            if (!created.objectStoreNames.contains(name)) created.createObjectStore(name);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('could not open ' + name));
        req.onblocked = () => reject(new Error('another tab is holding ' + name + ' open'));
    });

    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(name, 'readwrite');
            const store = tx.objectStore(name);
            for (const record of sourceStore.records) {
                const value = decodeBackupValue(record.value);
                if (value === undefined) continue;   // unreadable record; skip rather than abort
                store.put(value, decodeBackupValue(record.key) as IDBValidKey);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
        });
    } finally {
        db.close();
    }
}

/** Carry a per-profile localStorage key across, re-addressed to the new id. */
function restoreLocalKey(backup: MudletWebBackup, from: string, to: string, warnings: string[]): void {
    const value = backup.localStorage[from];
    if (value === undefined) return;
    try {
        localStorage.setItem(to, value);
    } catch {
        warnings.push(`Could not restore ${to} — this browser refused the write.`);
    }
}

/**
 * Import everything in a backup file.
 *
 * Additive by construction: every profile is created fresh through the store,
 * so an import can be run into a browser that is already in use, and can be run
 * twice, without losing anything that was already here.
 */
export async function importBackup(backup: MudletWebBackup): Promise<BackupImportResult> {
    const summary = summariseBackup(backup);
    const warnings = [...summary.warnings];
    const imported: { id: string; name: string }[] = [];

    const store = useAppStore.getState();
    const hadConnections = store.connections.length > 0;

    const rows = new Map(backedUpConnections(backup).map(c => [c.id, c]));

    for (const profile of summary.profiles) {
        const row = rows.get(profile.id);
        // A profile with no surviving row still gets a connection so its data is
        // reachable; the user can point it at a game afterwards.
        const data = row
            ? { ...row }
            : ({ name: profile.name, mode: 'mud', host: '', port: 23 } as unknown as MudConnection);
        delete (data as Partial<MudConnection>).id;

        let newId: string;
        try {
            newId = useAppStore.getState().addConnection(data as Omit<MudConnection, 'id'>);
        } catch (err) {
            warnings.push(`${profile.name}: could not be added — ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        const name = useAppStore.getState().connections.find(c => c.id === newId)?.name ?? profile.name;

        // The VFS carries the profile's scripts, triggers, packages, settings and
        // layout, so a failure here is a failure to import the profile at all —
        // drop the empty connection rather than leave a hollow one behind.
        const vfsStore = backup.indexedDB[VFS_DB_PREFIX + profile.id]?.stores?.[VFS_DB_PREFIX + profile.id];
        if (vfsStore) {
            try {
                await restoreVfsDatabase(vfsStore, newId);
            } catch (err) {
                useAppStore.getState().removeConnection(newId);
                warnings.push(`${profile.name}: its files could not be restored — ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
        } else {
            warnings.push(`${profile.name}: the backup had no file data for it, so it arrives empty.`);
        }

        const map = mapRecordFor(backup, profile.id);
        if (map) {
            try {
                await saveMap(newId, map);
            } catch (err) {
                warnings.push(`${profile.name}: its map could not be restored — ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Sessions keep their own ids (UUIDs, so they cannot clash) and are
        // re-pointed at the new connection. Entry ids are dropped: the store
        // assigns them, and a carried-over id would collide with a row this
        // browser already has.
        const sessions = logSessionsFor(backup, profile.id);
        if (sessions.length) {
            try {
                const ids = new Set(sessions.map(s => s.id));
                for (const session of sessions) {
                    await createSession({ ...session, connectionId: newId, connectionName: name });
                }
                const entries = logEntriesFor(backup, ids).map(e => {
                    const { id: _dropped, ...rest } = e;
                    return rest as LogEntry;
                });
                if (entries.length) await appendEntries(entries);
            } catch (err) {
                warnings.push(`${profile.name}: its logs could not be restored — ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        restoreLocalKey(backup, historyStorageKey(profile.id), historyStorageKey(newId), warnings);
        restoreLocalKey(backup, stopwatchStorageKey(profile.id), stopwatchStorageKey(newId), warnings);

        imported.push({ id: newId, name });
    }

    // Global settings (theme, proxy, editor preferences) are the one thing here
    // that is not per-profile, so they cannot be merged without guessing which
    // side the user meant. Adopted only into a browser that had no profiles of
    // its own — the migration case, where there is nothing of the user's to
    // overwrite; otherwise left alone and said so.
    const client = backedUpClientSettings(backup);
    if (client) {
        if (hadConnections) {
            warnings.push('Client settings (theme, proxy, editor) were left as they are here — this browser already had profiles of its own.');
        } else {
            useAppStore.getState().patchClient(client);
        }
    }

    if (!imported.length && !summary.profiles.length) {
        throw new Error('That backup holds no profiles.');
    }
    return { imported, warnings };
}
