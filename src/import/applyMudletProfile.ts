import { strFromU8 } from 'fflate';
import { useAppStore } from '../storage/appStore';
import { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { saveProfileData } from '../storage/profileVfsData';
import { saveMap } from '../storage/mapStorage';
import { saveFolderHandle } from '../scripting/vfs/folderHandleStore';
import { parseMudletProfile } from './mudletHost';
import { buildMudletProfileBundle, type MudletProfileBundle } from './mudletProfileImport';
import { CONNECTION_SIDECAR_PATH, RETAINED_HOST_PATH, type ConnectionSidecar } from './mudletProfileExport';
import type { MudConnection } from '../storage/schema';

// Apply a parsed Mudlet profile bundle (see mudletProfileImport.ts) as a NEW
// native mudix profile: create the connection, provision its VFS (copy map +
// loose files), and seed its store slices (settings, automation, variables).
// This is a one-time copy — mudix owns the result; the original Mudlet folder is
// never touched and there is no write-back. (Live "link" mode, where the Mudlet
// XML stays the source of truth, is a separate feature.)

/** The per-connection store slices a bundle maps to. Pure — no side effects, so
 *  it's unit-testable; `importMudletProfile` applies it. Automation is imported
 *  profile-owned (as authored in Mudlet), not package-tagged. */
export function bundleToConnectionData(bundle: MudletProfileBundle, installedAt: string) {
    const a = bundle.profile.automation;
    const vars = bundle.profile.variables.variables;
    return {
        scripts: a.scripts,
        aliases: a.aliases,
        triggers: a.triggers,
        timers: a.timers,
        keybindings: a.keys,
        buttons: a.buttons,
        // Register the profile's installed packages so package managers (mpkg)
        // and getPackageInfo see them as installed. Stamp the install time here
        // (the bundle leaves it empty to stay pure/deterministic).
        packages: bundle.packages.map(p => (p.installedAt ? p : { ...p, installedAt })),
        profile: bundle.profile.settings,
        // Every saved variable in the imported <VariablePackage> seeds the
        // save-list; its current value is restored into _G on first open.
        variables: { saveList: vars.map(v => v.name), values: vars },
    };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The connection record for an imported bundle.
 *
 * A Mudlet `<Host>` only models a telnet host/port, so that's the default. A
 * profile exported *from mudix* also carries `.mudix/connection.json`, which
 * restores what Mudlet can't express — websocket mode and its ws(s):// URL, the
 * per-profile proxy override, auto-reconnect. Unknown/aliased sidecar values are
 * ignored field by field, so a hand-edited file can't produce a broken profile.
 */
export function bundleToConnectionRecord(bundle: MudletProfileBundle): Omit<MudConnection, 'id'> {
    const base: Omit<MudConnection, 'id'> = {
        name: bundle.name,
        mode: 'mud',
        host: bundle.host ?? '',
        port: bundle.port ?? 23,
        // The imported profile's package set is authoritative — see
        // ensureDefaultPackages: no stock defaults are added to a Mudlet-imported
        // profile that doesn't already carry them.
        mudletImported: true,
    };
    const raw = bundle.files[CONNECTION_SIDECAR_PATH];
    if (!raw) return base;
    let side: ConnectionSidecar;
    try {
        side = JSON.parse(strFromU8(raw)) as ConnectionSidecar;
    } catch {
        return base;
    }
    const out = { ...base };
    if (side.mode === 'mud' || side.mode === 'websocket') out.mode = side.mode;
    if (typeof side.url === 'string') out.url = side.url;
    if (typeof side.host === 'string') out.host = side.host;
    if (typeof side.port === 'number' && Number.isFinite(side.port)) out.port = side.port;
    if (typeof side.proxyUrl === 'string') out.proxyUrl = side.proxyUrl;
    if (typeof side.autoReconnect === 'boolean') out.autoReconnect = side.autoReconnect;
    // A websocket profile's address lives in `url`; <Host><url> held it only so
    // the XML stayed valid, and as `host` it would read as a telnet hostname.
    if (out.mode === 'websocket') {
        if (!out.url && base.host) out.url = base.host;
        delete out.host;
    }
    return out;
}

/**
 * Create a new mudix profile from a Mudlet profile bundle. Returns the new
 * connection id. The profile opens offline like any other; its data is durable
 * in the new VFS (`.mudix/profile.json`) and map store before this resolves.
 */
export async function importMudletProfile(bundle: MudletProfileBundle): Promise<string> {
    const connectionId = useAppStore.getState().addConnection(bundleToConnectionRecord(bundle));

    const vfs = await ProfileVFS.mount(connectionId);
    try {
        // Copy the profile-root files (packages, fonts, sounds, …) verbatim.
        for (const [rel, bytes] of Object.entries(bundle.files)) {
            try {
                vfs.writeBinaryFile(rel, bytes);
            } catch (err) {
                console.warn('[importMudletProfile] failed to write', rel, err);
            }
        }
        // Retain the original <Host>. ProfileSettings models about a third of
        // it; without this the rest is gone the moment the import finishes, and
        // an export would rebuild the profile's <Host> from a bare skeleton.
        // Written after the loose files so a stale copy inside an imported tree
        // can't win over the save we actually parsed.
        if (bundle.hostPackageXml) {
            try {
                vfs.writeFile(RETAINED_HOST_PATH, bundle.hostPackageXml);
            } catch (err) {
                console.warn('[importMudletProfile] failed to retain <Host>', err);
            }
        }
        // Seed the store, then flush it to the profile's .mudix/profile.json so
        // it's durable for when the user opens the profile (which re-hydrates
        // from that file). Hydrating a non-active connection doesn't disturb any
        // open session — its subscription keys on its own connection id.
        useAppStore.getState().hydrateConnectionData(connectionId, bundleToConnectionData(bundle, new Date().toISOString()));
        saveProfileData(vfs, connectionId);
        await vfs.flush();
    } finally {
        vfs.unmount();
    }

    if (bundle.mapBytes) {
        try {
            await saveMap(connectionId, toArrayBuffer(bundle.mapBytes));
        } catch (err) {
            console.warn('[importMudletProfile] map save failed', err);
        }
    }

    return connectionId;
}

/** Recursively read a picked directory into {path -> bytes} + {path -> mtime}
 *  maps for buildMudletProfileBundle. The directory's own name isn't included in
 *  the keys, so a picked profile folder yields `current/…`, `map/…` at the root.
 *  The mtimes let the bundle pick the most-recently-saved XML the way Mudlet does. */
export async function readDirectoryHandle(
    root: FileSystemDirectoryHandle,
): Promise<{ files: Record<string, Uint8Array>; mtimes: Record<string, number> }> {
    const files: Record<string, Uint8Array> = {};
    const mtimes: Record<string, number> = {};
    interface DirEntries { entries(): AsyncIterable<[string, FileSystemHandle]>; }
    async function recurse(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
        for await (const [name, handle] of (dir as unknown as DirEntries).entries()) {
            const rel = prefix ? `${prefix}/${name}` : name;
            if (handle.kind === 'directory') {
                await recurse(handle as FileSystemDirectoryHandle, rel);
            } else {
                const file = await (handle as FileSystemFileHandle).getFile();
                files[rel] = new Uint8Array(await file.arrayBuffer());
                mtimes[rel] = file.lastModified;
            }
        }
    }
    await recurse(root, '');
    return { files, mtimes };
}

/** Build a bundle from a picked directory handle (mtime-aware newest-save pick). */
export async function bundleFromDirectory(dir: FileSystemDirectoryHandle): Promise<MudletProfileBundle> {
    const { files, mtimes } = await readDirectoryHandle(dir);
    return buildMudletProfileBundle(files, dir.name || 'Imported profile', mtimes);
}

/** Import a Mudlet profile from a picked directory handle (no unresolved-module
 *  handling — callers that need the upload/remove flow should use bundleFromDirectory
 *  + resolveModulesFromTree first). */
export async function importMudletProfileFromDirectory(dir: FileSystemDirectoryHandle): Promise<string> {
    return importMudletProfile(await bundleFromDirectory(dir));
}

// ── link mode ────────────────────────────────────────────────────────────────

/** The newest file (by lastModified) in a subdirectory of `dir` matching `pred`. */
async function newestFileIn(
    dir: FileSystemDirectoryHandle,
    sub: string,
    pred: (name: string) => boolean,
): Promise<File | null> {
    let handle: FileSystemDirectoryHandle;
    try {
        handle = await dir.getDirectoryHandle(sub);
    } catch {
        return null;
    }
    interface DirEntries { entries(): AsyncIterable<[string, FileSystemHandle]>; }
    let newest: File | null = null;
    for await (const [name, h] of (handle as unknown as DirEntries).entries()) {
        if (h.kind !== 'file' || !pred(name)) continue;
        const file = await (h as FileSystemFileHandle).getFile();
        if (!newest || file.lastModified > newest.lastModified) newest = file;
    }
    return newest;
}

/**
 * Link a Mudlet profile *directory* as a new mudix profile (Link mode): the
 * folder stays the source of truth — its `current/*.xml` is re-read on every
 * open — rather than being copied in. Reads the connection identity from the
 * newest save, registers the connection, persists the folder handle so the VFS
 * mounts it, and copies the current map. Returns the new connection id.
 */
export async function linkMudletFolder(dir: FileSystemDirectoryHandle): Promise<string> {
    const xmlFile = await newestFileIn(dir, 'current', n => n.toLowerCase().endsWith('.xml'));
    if (!xmlFile) throw new Error('Not a Mudlet profile: no current/*.xml found in the selected folder');
    const profile = parseMudletProfile(await xmlFile.text());

    const connectionId = useAppStore.getState().addConnection({
        name: profile.connection.name || dir.name || 'Linked profile',
        mode: 'mud',
        host: profile.connection.host ?? '',
        port: profile.connection.port ?? 23,
        mudletLinked: true,
    });

    // Persist the handle so ProfileVFS mounts the folder on open (the page already
    // holds readwrite permission from the picker gesture).
    await saveFolderHandle(connectionId, dir);

    const mapFile = await newestFileIn(dir, 'map', () => true);
    if (mapFile) {
        try {
            await saveMap(connectionId, await mapFile.arrayBuffer());
        } catch (err) {
            console.warn('[linkMudletFolder] map copy failed', err);
        }
    }

    return connectionId;
}
