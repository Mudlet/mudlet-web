import { useAppStore } from '../storage/appStore';
import { PROFILE_DATA_PATH, type PersistedProfileData } from '../storage/profileVfsData';
import type { MudConnection, PackageManifest, ProfileSettings } from '../storage/schema';
import { parseMudletProfile } from './mudletHost';
import {
    buildPackageManifests,
    DESKTOP_HISTORY_FILE,
    parseSslTsl,
    readDesktopProfileFiles,
    type DesktopProfileFiles,
} from './mudletProfileImport';
import { decodeProfileData, encodeProfileData } from './qtProfileData';
import { canonicalServerEncoding, savedServerEncoding } from '../mud/protocol/charset';
import { DEFAULT_HISTORY_SAVE_SIZE, historyStorageKey, loadHistory, MAX_HISTORY, saveHistory } from '../ui/commandHistory';

// Link mode (read-only, phase 1): a profile whose VFS is a *linked Mudlet folder*
// loads its settings/automation/variables/packages from the newest current/*.xml
// on every open — so edits made in Mudlet show up in mudlet. The .mudlet/profile.json
// sidecar holds only Mudlet Web-only state (layout/dock/mapper/…), applied over the
// XML. Automation write-back to current/*.xml is phase 2; until then Mudlet Web's own
// automation edits aren't persisted to a linked profile.
//
// We read through the already-mounted ProfileVFS, so only this minimal surface
// is needed (and it keeps the loader unit-testable without a real VFS).
export interface VfsReader {
    exists(path: string): boolean;
    readdir(path: string): string[];
    stat(path: string): { mtime: Date } | null;
    readFile(path: string): string;
}

/** A {@link VfsReader} that also reads bytes — what a linked folder's
 *  desktop profile-data files need (they are not text; see qtProfileData.ts). */
export interface LinkedVfsReader extends VfsReader {
    readBinaryFile(path: string): Uint8Array;
}

/** current/*.xml paths (relative to the profile root) ordered newest-first.
 *  Order is by mtime; when mtimes are unavailable (all zero) autosave.xml comes
 *  first, then the latest timestamp filename. Empty when not a Mudlet profile. */
export function listCurrentXmlsByRecency(vfs: VfsReader): string[] {
    if (!vfs.exists('current')) return [];
    let names: string[];
    try {
        names = vfs.readdir('current').filter(n => n.toLowerCase().endsWith('.xml'));
    } catch {
        return [];
    }
    return names
        .map(n => ({ n, m: vfs.stat(`current/${n}`)?.mtime?.getTime() ?? 0 }))
        .sort((a, b) => {
            // Mudlet's real saves are the timestamped files; autosave.xml is not
            // what it loads, so always rank it last (and it's where our earlier
            // write bug left a corrupt file). Among the timestamped saves, newest
            // mtime wins, then the latest filename.
            const aAuto = a.n.toLowerCase() === 'autosave.xml';
            const bAuto = b.n.toLowerCase() === 'autosave.xml';
            if (aAuto !== bAuto) return aAuto ? 1 : -1;
            if (a.m !== b.m) return b.m - a.m;
            return a.n < b.n ? 1 : -1;
        })
        .map(({ n }) => `current/${n}`);
}

/** Path of the newest profile save in current/, or null if not a Mudlet profile. */
export function findNewestCurrentXml(vfs: VfsReader): string | null {
    return listCurrentXmlsByRecency(vfs)[0] ?? null;
}

/** Whether a mounted VFS looks like a linked Mudlet profile (has current/*.xml). */
export function isMudletProfileVfs(vfs: VfsReader): boolean {
    return findNewestCurrentXml(vfs) !== null;
}

/**
 * Whether opening this profile loads it from its newest current/*.xml rather
 * than `.mudlet/profile.json`: only a linked Mudlet folder, where desktop may
 * have edited the save since. A Mudlet Web profile that called saveProfile()
 * has a current/*.xml too, but nothing outside this app writes it and
 * profile.json — flushed alongside it — is the fuller record (module
 * manifests, install paths, …). Loading that one as a linked folder lost its
 * installed packages and re-ran the default-package install (#259).
 */
export function opensAsLinkedProfile(connection: { mudletLinked?: boolean }, vfs: VfsReader): boolean {
    return connection.mudletLinked === true && isMudletProfileVfs(vfs);
}

/**
 * The newest current/*.xml whose content actually parses as a Mudlet profile,
 * with its text. Skips a corrupt newest save (e.g. a truncated/garbage autosave
 * from the write bug) and falls back to older saves — so a linked profile still
 * opens, and write-back can re-heal the bad file from a good base. Null if none
 * parse.
 */
export function readNewestParseableXml(vfs: VfsReader): { path: string; xml: string } | null {
    for (const path of listCurrentXmlsByRecency(vfs)) {
        let xml: string;
        try {
            xml = vfs.readFile(path);
        } catch {
            continue;
        }
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        if (!doc.getElementsByTagName('parsererror')[0] && doc.getElementsByTagName('MudletPackage')[0]) {
            return { path, xml };
        }
    }
    return null;
}

/**
 * The linked profile's package set. The XML's `<mInstalledPackages>` decides
 * which packages are installed — that's what desktop edits — but a package this
 * app already knew keeps the manifest it recorded in the sidecar (install
 * paths, source, declared info), which the XML has no room for; only one the
 * sidecar hasn't seen is rebuilt from its `config.lua`. Modules aren't in
 * `<mInstalledPackages>` at all (desktop keeps them in `<mInstalledModules>`),
 * so the sidecar's are carried over as they are.
 */
function linkedPackageManifests(
    vfs: VfsReader,
    names: string[],
    known: PackageManifest[],
    installedAt: string,
): PackageManifest[] {
    const knownPackages = new Map(known.filter(m => m.kind !== 'module').map(m => [m.name, m]));
    const fresh = buildPackageManifests(names.filter(n => !knownPackages.has(n)), name => {
        const p = `${name}/config.lua`;
        try { return vfs.exists(p) ? vfs.readFile(p) : undefined; } catch { return undefined; }
    }).map(m => ({ ...m, installedAt }));
    const freshByName = new Map(fresh.map(m => [m.name, m]));
    const packages = names.map(n => knownPackages.get(n) ?? freshByName.get(n)!);
    const modules = known.filter(m => m.kind === 'module' && !names.includes(m.name));
    return [...packages, ...modules];
}

function readSidecar(vfs: VfsReader): Partial<PersistedProfileData> {
    if (!vfs.exists(PROFILE_DATA_PATH)) return {};
    try {
        return JSON.parse(vfs.readFile(PROFILE_DATA_PATH)) as Partial<PersistedProfileData>;
    } catch {
        return {};
    }
}

/**
 * Hydrate the store for a Mudlet-linked profile from the newest current/*.xml,
 * layering the .mudlet sidecar's Mudlet Web-only slices on top. Returns false if the
 * VFS isn't a Mudlet profile (caller falls back to the normal profile.json load).
 * `installedAt` stamps the package manifests (pass an ISO timestamp).
 */
export function loadMudletLinkedProfile(vfs: LinkedVfsReader, connectionId: string, installedAt: string): boolean {
    const found = readNewestParseableXml(vfs);
    if (!found) return false;

    const data = parseMudletProfile(found.xml);
    const sidecar = readSidecar(vfs);
    const desktop = readLinkedDesktopFiles(vfs, data.connection.tls);
    const packages = linkedPackageManifests(vfs, data.installedPackages, sidecar.packages ?? [], installedAt);
    const vars = data.variables.variables;
    // The desktop `encoding` file over both the XML settings and the sidecar:
    // desktop's Host reads it on every load, and this client writes its own
    // change back to it (see desktopProfileFileUpdates), so the file is the
    // current value. A file naming an encoding Mudlet Web cannot decode (or
    // none) still wins — the profile reads as UTF-8 — rather than letting the
    // sidecar's older choice stand and be written back over desktop's.
    const profile: Partial<ProfileSettings> = { ...data.settings, ...(sidecar.profile ?? {}) };
    if (desktop.serverEncoding) profile.serverEncoding = desktop.serverEncoding;
    else if (readRootFile(vfs, 'encoding') !== undefined) delete profile.serverEncoding;

    useAppStore.getState().hydrateConnectionData(connectionId, {
        // Automation + settings + variables are authoritative from the XML.
        scripts: data.automation.scripts,
        aliases: data.automation.aliases,
        triggers: data.automation.triggers,
        timers: data.automation.timers,
        keybindings: data.automation.keys,
        buttons: data.automation.buttons,
        packages,
        variables: { saveList: vars.map(v => v.name), values: vars, hidden: data.variables.hidden },
        // XML settings as the base; Mudlet Web-only profile fields (mapper, font source,
        // mapViewStates, …) from the sidecar win where set; the encoding file over both.
        profile,
        // Pure Mudlet Web-only UI/layout slices come entirely from the sidecar.
        windowHints: sidecar.windowHints,
        dockExtents: sidecar.dockExtents,
        scriptEditorBounds: sidecar.scriptEditorBounds,
        modalBounds: sidecar.modalBounds,
        layoutSnapshot: sidecar.layoutSnapshot,
    });
    applyLinkedConnectionFiles(vfs, connectionId, desktop);
    const size = useAppStore.getState().connectionProfile[connectionId]?.config?.commandLineHistorySaveSize;
    mergeLinkedCommandHistory(vfs, connectionId, typeof size === 'number' && Number.isFinite(size) ? size : DEFAULT_HISTORY_SAVE_SIZE);
    return true;
}

// ── desktop profile-data files (issue #450) ──────────────────────────────────
//
// Desktop keeps `encoding`, `ssl_tsl`, `login` and `password` in files of their
// own at the profile root, and the main command line's history in
// `command_history_main`. A linked folder reads them in place, with the same
// reader the import uses, every time the profile opens — so a change made on
// desktop shows up here. Changes made here to the encoding, TLS and character
// name are written back in desktop's format, as the save itself is (see
// ScriptingEngine.writeBackLinkedProfile). The password and the history are
// read only: the password goes to the encrypted vault once, at link time, and
// the folder's copy is left alone; the history would race a desktop Mudlet
// running on the same folder, which rewrites it on exit.

/** A root file's bytes from a linked VFS, or undefined when it is absent or
 *  unreadable. */
function readRootFile(vfs: LinkedVfsReader, name: string): Uint8Array | undefined {
    try {
        return vfs.exists(name) ? vfs.readBinaryFile(name) : undefined;
    } catch {
        return undefined;
    }
}

/** {@link readDesktopProfileFiles} over a linked folder's root. */
export function readLinkedDesktopFiles(vfs: LinkedVfsReader, saveTls?: boolean): DesktopProfileFiles {
    return readDesktopProfileFiles(name => readRootFile(vfs, name), saveTls);
}

/**
 * Bring the connection record in line with the folder's `ssl_tsl` and `login`
 * files. Only what the folder says: a missing `login` file leaves a character
 * name set here alone, while an emptied one clears it, as on desktop.
 */
function applyLinkedConnectionFiles(vfs: LinkedVfsReader, connectionId: string, desktop: DesktopProfileFiles): void {
    const state = useAppStore.getState();
    const conn = state.connections.find(c => c.id === connectionId);
    if (!conn) return;
    const patch: { tls?: boolean; charLoginAccount?: string } = {};
    // The ws(s):// scheme decides TLS for a websocket connection.
    if (conn.mode === 'mud' && desktop.tls !== undefined && desktop.tls !== (conn.tls ?? false)) patch.tls = desktop.tls;
    if (readRootFile(vfs, 'login') !== undefined && (desktop.login ?? '') !== (conn.charLoginAccount ?? '')) {
        patch.charLoginAccount = desktop.login;
    }
    if (Object.keys(patch).length) state.patchConnection(connectionId, patch);
}

/** Where the last-merged `command_history_main` modification time is kept. */
export function linkedHistoryMarkerKey(connectionId: string): string {
    return `${historyStorageKey(connectionId)}_desktop_mtime`;
}

/**
 * Fold the folder's `command_history_main` into the command bar's history
 * when the file has changed since it was last read: desktop's commands first
 * (it was used since), then this client's own, one entry per command ignoring
 * case. An unchanged file is skipped, so this client's history isn't
 * reshuffled on every open.
 */
export function mergeLinkedCommandHistory(vfs: LinkedVfsReader, connectionId: string, saveSize: number = DEFAULT_HISTORY_SAVE_SIZE): void {
    const bytes = readRootFile(vfs, DESKTOP_HISTORY_FILE);
    if (!bytes) return;
    const stamp = String(vfs.stat(DESKTOP_HISTORY_FILE)?.mtime?.getTime() ?? 0);
    const markerKey = linkedHistoryMarkerKey(connectionId);
    try {
        if (localStorage.getItem(markerKey) === stamp) return;
    } catch {
        return;
    }
    const desktopHistory = readDesktopProfileFiles(n => (n === DESKTOP_HISTORY_FILE ? bytes : undefined)).commandHistory ?? [];
    const key = historyStorageKey(connectionId);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const cmd of [...desktopHistory, ...loadHistory(key)]) {
        const lower = cmd.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        merged.push(cmd);
        if (merged.length >= MAX_HISTORY) break;
    }
    saveHistory(merged, key, saveSize);
    try {
        localStorage.setItem(markerKey, stamp);
    } catch {
        // Storage full or disabled: the merge simply runs again next open.
    }
}

/** Whether a connection-record change touches what a linked folder's
 *  profile-data files mirror (TLS, the character name), so a save must write
 *  them back. Nothing for a profile that is not a linked folder. */
export function linkedConnectionFilesChanged(
    conn: Pick<MudConnection, 'mudletLinked' | 'mode' | 'tls' | 'charLoginAccount'> | undefined,
    prev: Pick<MudConnection, 'mudletLinked' | 'mode' | 'tls' | 'charLoginAccount'> | undefined,
): boolean {
    if (!conn?.mudletLinked || !prev || conn === prev) return false;
    return conn.tls !== prev.tls || conn.charLoginAccount !== prev.charLoginAccount || conn.mode !== prev.mode;
}

/** The settings a linked folder's profile-data files mirror. */
export interface DesktopProfileFileValues {
    serverEncoding?: string;
    /** Undefined for a connection where TLS isn't the profile's to say (websocket). */
    tls?: boolean;
    login?: string;
}

/**
 * The profile-data files to write so a linked folder says what `want` does, in
 * desktop's format, keyed by name. Only files whose value differs are listed —
 * an unchanged file is not rewritten under a desktop Mudlet that may be
 * running on the same folder — and none is created to say what its absence
 * already means (no encoding chosen, TLS off, no character name). Never the
 * password.
 */
export function desktopProfileFileUpdates(vfs: LinkedVfsReader, want: DesktopProfileFileValues): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    const current = (name: string) => {
        const bytes = readRootFile(vfs, name);
        return bytes === undefined ? undefined : decodeProfileData(bytes).trim();
    };
    if (want.serverEncoding) {
        const name = savedServerEncoding(want.serverEncoding);
        const have = current('encoding');
        const same = have !== undefined
            && (canonicalServerEncoding(have) ?? have) === (canonicalServerEncoding(name) ?? name);
        if (!same) out.encoding = encodeProfileData(name);
    }
    if (want.tls !== undefined) {
        const have = parseSslTsl(current('ssl_tsl'));
        if ((have ?? false) !== want.tls) out.ssl_tsl = encodeProfileData(want.tls ? '2' : '0');
    }
    if ((current('login') ?? '') !== (want.login ?? '')) out.login = encodeProfileData(want.login ?? '');
    return out;
}
