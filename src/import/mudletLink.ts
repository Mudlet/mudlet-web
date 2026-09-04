import { useAppStore } from '../storage/appStore';
import { PROFILE_DATA_PATH, type PersistedProfileData } from '../storage/profileVfsData';
import { parseMudletProfile } from './mudletHost';
import { buildPackageManifests } from './mudletProfileImport';

// Link mode (read-only, phase 1): a profile whose VFS is a *linked Mudlet folder*
// loads its settings/automation/variables/packages from the newest current/*.xml
// on every open — so edits made in Mudlet show up in mudix. The .mudix/profile.json
// sidecar holds only mudix-only state (layout/dock/mapper/…), applied over the
// XML. Automation write-back to current/*.xml is phase 2; until then mudix's own
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
 * layering the .mudix sidecar's mudix-only slices on top. Returns false if the
 * VFS isn't a Mudlet profile (caller falls back to the normal profile.json load).
 * `installedAt` stamps the package manifests (pass an ISO timestamp).
 */
export function loadMudletLinkedProfile(vfs: VfsReader, connectionId: string, installedAt: string): boolean {
    const found = readNewestParseableXml(vfs);
    if (!found) return false;

    const data = parseMudletProfile(found.xml);
    const packages = buildPackageManifests(data.installedPackages, name => {
        const p = `${name}/config.lua`;
        try { return vfs.exists(p) ? vfs.readFile(p) : undefined; } catch { return undefined; }
    }).map(m => ({ ...m, installedAt }));

    const sidecar = readSidecar(vfs);
    const vars = data.variables.variables;

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
        // XML settings as the base; mudix-only profile fields (mapper, font source,
        // mapViewStates, …) from the sidecar win where set.
        profile: { ...data.settings, ...(sidecar.profile ?? {}) },
        // Pure mudix-only UI/layout slices come entirely from the sidecar.
        windowHints: sidecar.windowHints,
        dockExtents: sidecar.dockExtents,
        scriptEditorBounds: sidecar.scriptEditorBounds,
        modalBounds: sidecar.modalBounds,
        layoutSnapshot: sidecar.layoutSnapshot,
    });
    return true;
}
