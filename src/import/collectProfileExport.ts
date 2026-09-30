import { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { PROFILE_DATA_PATH, type PersistedProfileData } from '../storage/profileVfsData';
import { loadMap } from '../storage/mapStorage';
import { listSessions, getSessionEntries } from '../storage/logStorage';
import { buildSessionHtml, formatSessionFileStamp } from '../storage/logExport';
import type { MudConnection } from '../storage/schema';
import { RETAINED_HOST_PATH, LEGACY_RETAINED_HOST_PATH, type ExportLog, type ProfileExportSource } from './mudletProfileExport';
import { readNewestParseableXml, type VfsReader } from './mudletLink';

// Gathers everything one profile owns across the three stores it's spread over
// (its VFS, the map IndexedDB, the log IndexedDB) into the plain data that
// mudletProfileExport turns into a Mudlet profile folder. Split from the pure
// builders so those stay testable without ZenFS/IndexedDB.

/** Files under this directory are Mudlet Web bookkeeping, not user content: the
 *  profile JSON is re-serialized into the profile XML, and the connection
 *  sidecar is written fresh on export. Both names: a profile not opened since
 *  the storage rename still keeps them in `.mudix/` (moved on open, see
 *  migrateLegacyDotDir), and that is bookkeeping too. */
const VFS_INTERNAL_DIRS = ['.mudlet', '.mudix'];

/** Depth cap for the VFS walk. Profile trees are shallow (packages/<pkg>/…);
 *  the cap is a cheap guard against a pathological or cyclic tree hanging the
 *  export rather than a real structural limit. */
const MAX_WALK_DEPTH = 12;

/** The part of ProfileVFS the walk needs, so it's testable over any ZenFS. */
export type WalkableVfs = Pick<ProfileVFS, 'profilePath' | 'readdir' | 'stat' | 'readBinaryFile'>;

/**
 * Every user file in the profile folder, keyed by its path relative to the
 * profile root — packages, modules, and whatever scripts wrote with `io.*` /
 * `table.save`, i.e. what desktop Mudlet's profile folder holds.
 *
 * Paths are resolved against `profilePath`, never passed bare: ProfileVFS reads
 * a leading `/` as the ZenFS root, and a relative path resolves against the Lua
 * working directory, which `lfs.chdir` can move (issue #261).
 */
export function collectVfsFiles(vfs: WalkableVfs): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    walk(vfs, '', 0, out);
    return out;
}

function walk(vfs: WalkableVfs, dir: string, depth: number, out: Record<string, Uint8Array>): void {
    if (depth > MAX_WALK_DEPTH) return;
    const abs = (rel: string) => (rel ? `${vfs.profilePath}/${rel}` : vfs.profilePath);
    let names: string[];
    try {
        names = vfs.readdir(abs(dir));
    } catch {
        return; // unreadable directory: skip rather than fail the whole export
    }
    for (const name of names) {
        if (name === '.' || name === '..') continue;
        const rel = dir ? `${dir}/${name}` : name;
        if (VFS_INTERNAL_DIRS.some(d => rel === d || rel.startsWith(`${d}/`))) continue;
        const st = vfs.stat(abs(rel));
        if (!st) continue;
        if (st.type === 'dir') {
            walk(vfs, rel, depth + 1, out);
        } else {
            try {
                out[rel] = vfs.readBinaryFile(abs(rel));
            } catch (err) {
                console.warn('[collectProfileExport] unreadable file skipped:', rel, err);
            }
        }
    }
}

function readProfileData(vfs: ProfileVFS): PersistedProfileData {
    const empty: PersistedProfileData = {
        version: 0, scripts: [], aliases: [], triggers: [], timers: [],
        keybindings: [], buttons: [], packages: [],
    };
    if (!vfs.exists(PROFILE_DATA_PATH)) return empty;
    try {
        return { ...empty, ...(JSON.parse(vfs.readFile(PROFILE_DATA_PATH)) as PersistedProfileData) };
    } catch (err) {
        console.warn('[collectProfileExport] profile.json unparseable, exporting files only', err);
        return empty;
    }
}

/**
 * The `<Host>` this profile's export should base on, so the ~100 Mudlet settings
 * Mudlet Web doesn't model don't revert to Mudlet's defaults on the way out.
 *
 * The retained copy comes first. A profile that has one was imported from
 * Mudlet, and any `current/*.xml` in its VFS is a save Mudlet Web itself wrote via
 * `saveProfile()` — basing on that would just re-read our own output. A linked
 * folder has no retained copy and its `current/*.xml` *is* the live original,
 * kept current by write-back, so it's the right base there.
 *
 * Undefined for a profile born in Mudlet Web: nothing beyond the modeled settings to
 * preserve, and the export falls back to the empty skeleton as before.
 *
 * Takes the same minimal reader surface as the link-mode loader, so it's
 * testable without a mounted ZenFS.
 */
export function readHostBase(vfs: VfsReader): string | undefined {
    try {
        if (vfs.exists(RETAINED_HOST_PATH)) return vfs.readFile(RETAINED_HOST_PATH);
        // A profile not opened since the storage rename still has it here.
        if (vfs.exists(LEGACY_RETAINED_HOST_PATH)) return vfs.readFile(LEGACY_RETAINED_HOST_PATH);
    } catch (err) {
        console.warn('[collectProfileExport] retained <Host> unreadable', err);
    }
    try {
        return readNewestParseableXml(vfs)?.xml;
    } catch (err) {
        console.warn('[collectProfileExport] current/ unreadable', err);
        return undefined;
    }
}

async function collectLogs(connectionId: string): Promise<ExportLog[]> {
    const sessions = await listSessions(connectionId);
    const logs: ExportLog[] = [];
    for (const session of sessions) {
        const entries = await getSessionEntries(session.id);
        if (!entries.length) continue;
        logs.push({
            name: `${session.connectionName} ${formatSessionFileStamp(session.startedAt)}`,
            html: buildSessionHtml(session, entries),
        });
    }
    return logs;
}

export interface CollectOptions {
    /** Session logs aren't part of the Mudlet format; they ride along under
     *  `logs/` so a migrating user doesn't leave history behind. */
    includeLogs?: boolean;
}

/**
 * Read one profile out of storage, ready for export.
 *
 * The profile's `.mudlet/profile.json` is the source of truth — not the Zustand
 * store, which only holds slices for the *open* profile. A profile open in
 * another tab may therefore be up to one save-debounce stale; exporting from the
 * connection screen (where nothing is open) always sees the committed state.
 */
export async function collectProfileExport(
    connection: MudConnection,
    opts: CollectOptions = {},
): Promise<ProfileExportSource> {
    const vfs = await ProfileVFS.mount(connection.id);
    let data: PersistedProfileData;
    let hostBaseXml: string | undefined;
    let files: Record<string, Uint8Array>;
    try {
        data = readProfileData(vfs);
        hostBaseXml = readHostBase(vfs);
        files = collectVfsFiles(vfs);
    } finally {
        vfs.unmount();
    }

    let mapBytes: Uint8Array | undefined;
    try {
        const buf = await loadMap(connection.id);
        if (buf) mapBytes = new Uint8Array(buf);
    } catch (err) {
        console.warn('[collectProfileExport] map read failed', err);
    }

    let logs: ExportLog[] | undefined;
    if (opts.includeLogs) {
        try {
            logs = await collectLogs(connection.id);
        } catch (err) {
            console.warn('[collectProfileExport] log read failed', err);
        }
    }

    return { connection, data, files, hostBaseXml, mapBytes, logs };
}
