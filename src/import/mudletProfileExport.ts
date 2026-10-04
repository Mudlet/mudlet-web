import { zipSync, strToU8, type Zippable } from 'fflate';
import type { MudConnection, PackageManifest } from '../storage/schema';
import type { PersistedProfileData } from '../storage/profileVfsData';
import { buildLinkedWriteback } from './mudletWriteback';
import { serializeMudletXml } from './mudletXmlExport';
import {
    applyHostIdentity, applyHostTls, applyInstalledModules, extractHostPackageXml, MUDLET_XML_PROLOG,
    type MudletModuleEntry,
} from './mudletHost';

// The inverse of mudletProfileImport: turn a Mudlet Web profile back into a *Mudlet
// profile folder* — `current/<stamp>.xml`, `map/`, and the profile's loose VFS
// files. The output is what `buildMudletProfileBundle` already knows how to
// read, so export/import is one format rather than two, and the same folder can
// be dropped into desktop Mudlet's profile directory.
//
// The XML is produced by feeding a <Host> base through `buildLinkedWriteback` —
// the same path the linked-folder write-back uses — so automation packages, the
// VariablePackage and the ~30 modeled Host settings are serialized by tested
// code instead of a second, parallel emitter. The base is the profile's own
// retained `<Host>` when it has one (see RETAINED_HOST_PATH), so the ~100
// settings Mudlet Web doesn't model survive the trip out; a profile born in Mudlet Web has
// nothing to retain and starts from the empty skeleton.

/** Mudlet names its saves `YYYY-MM-DD#HH-mm-ss.xml`; the importer sorts by that
 *  filename when no mtimes are available, so the stamp has to be sortable. */
export function formatSaveStamp(date: Date): string {
    const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
        `#${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

/** Connection fields Mudlet's `<Host>` can't express (websocket mode, the proxy
 *  override, auto-reconnect). Written beside the XML so a Mudlet Web→Mudlet Web round-trip
 *  keeps them; desktop Mudlet ignores the dot-directory entirely. */
export const CONNECTION_SIDECAR_PATH = '.mudlet/connection.json';

/** Where the sidecar lived in archives exported before the storage rename.
 *  Those zips are out in the wild, so import still has to look here. */
export const LEGACY_CONNECTION_SIDECAR_PATH = '.mudix/connection.json';

/** Where a profile imported from Mudlet keeps its original `<HostPackage>`,
 *  inside its own VFS. `extractHostPackageXml` produces it at import time; the
 *  export and `saveProfile()` base their `<Host>` on it so the settings Mudlet Web
 *  doesn't model don't revert to Mudlet's defaults. Dot-prefixed like the rest
 *  of Mudlet Web's bookkeeping, so desktop Mudlet ignores it.
 *
 *  Absent for a profile created in Mudlet Web (nothing unmodeled to preserve), for a
 *  linked folder (its own `current/*.xml` is the live original), and for
 *  profiles imported before this file existed — their `<Host>` was already
 *  dropped at import and can't be recovered. */
export const RETAINED_HOST_PATH = '.mudlet/host.xml';

/** Pre-rename location of the retained host XML. A profile whose VFS has not
 *  been opened since the rename still keeps it here (see migrateLegacyDotDir),
 *  as does any archive exported before it. */
export const LEGACY_RETAINED_HOST_PATH = '.mudix/host.xml';

export interface ConnectionSidecar {
    mode?: MudConnection['mode'];
    url?: string;
    host?: string;
    port?: number;
    proxyUrl?: string;
    autoReconnect?: boolean;
    reconnectOnDrop?: boolean;
    tls?: boolean;
    sslIgnoreExpired?: boolean;
    sslIgnoreSelfSigned?: boolean;
    sslIgnoreAll?: boolean;
    charLoginAccount?: string;
    description?: string;
}

/** Written whether set or not: a profile imported from desktop keeps that
 *  profile's `<Host>` and its connection files (`ssl_tsl`, `login`,
 *  `description`, `autologin`, `autoreconnect`), so an absent value here would
 *  let those bring back a setting the user has since cleared. */
export const SIDECAR_FLAGS = ['autoReconnect', 'reconnectOnDrop', 'tls', 'sslIgnoreExpired', 'sslIgnoreSelfSigned', 'sslIgnoreAll'] as const;
export const SIDECAR_TEXTS = ['charLoginAccount', 'description'] as const;

export function buildConnectionSidecar(c: MudConnection): ConnectionSidecar {
    const out: ConnectionSidecar = {};
    if (c.mode !== undefined) out.mode = c.mode;
    if (c.url !== undefined) out.url = c.url;
    if (c.host !== undefined) out.host = c.host;
    if (c.port !== undefined) out.port = c.port;
    if (c.proxyUrl !== undefined) out.proxyUrl = c.proxyUrl;
    for (const flag of SIDECAR_FLAGS) out[flag] = !!c[flag];
    for (const text of SIDECAR_TEXTS) out[text] = c[text] ?? '';
    return out;
}

/** Desktop keeps each connection-dialog field in a file of its own beside
 *  `current/`, written by `MudletApp::writeProfileData` as one `QDataStream`
 *  `QString`: a big-endian byte count, then UTF-16BE. */
export function encodeProfileDataItem(text: string): Uint8Array {
    const out = new Uint8Array(4 + text.length * 2);
    const size = text.length * 2;
    out[0] = size >>> 24;
    out[1] = (size >>> 16) & 0xff;
    out[2] = (size >>> 8) & 0xff;
    out[3] = size & 0xff;
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        out[4 + i * 2] = unit >>> 8;
        out[5 + i * 2] = unit & 0xff;
    }
    return out;
}

/** Desktop's checkboxes are stored as `Qt::CheckState` numbers. */
const checkState = (on: boolean | undefined) => (on ? '2' : '0');

/**
 * The connection files desktop's Connect dialog reads, so the profile opens
 * there with its address, character and checkboxes filled in. Every one is
 * written, empty or not: a profile imported from desktop still carries the
 * files it came with, and a stale one would bring back what the user changed.
 * A websocket profile has no address desktop can dial, so its `url` is empty.
 */
export function buildDesktopConnectionFiles(c: MudConnection): Record<string, Uint8Array> {
    const telnet = c.mode === 'mud';
    const items: Record<string, string> = {
        url: telnet ? c.host ?? '' : '',
        port: telnet ? String(c.port ?? 23) : '',
        login: c.charLoginAccount ?? '',
        description: c.description ?? '',
        autologin: checkState(c.autoReconnect),
        autoreconnect: checkState(c.reconnectOnDrop),
        ssl_tsl: checkState(c.tls),
    };
    const out: Record<string, Uint8Array> = {};
    for (const [name, text] of Object.entries(items)) out[name] = encodeProfileDataItem(text);
    return out;
}

/** The `<url>`/`<port>` a Mudlet `<Host>` should carry for this connection.
 *  A websocket profile's ws(s):// URL stays out: desktop fills an empty server
 *  field from `<url>` and would dial it as a hostname. The sidecar carries it. */
function hostAddress(c: MudConnection): { url: string; port: number } {
    if (c.mode === 'mud') return { url: c.host ?? '', port: c.port ?? 23 };
    return { url: '', port: c.port ?? 23 };
}

/**
 * A minimal but valid Mudlet profile save: Mudlet's version stamp and an empty
 * `<Host>` for the identity and the modeled settings to fill in. Unmodeled
 * Mudlet settings are simply absent — the importer merges what's present over
 * defaults, and desktop Mudlet fills its own.
 */
const EMPTY_HOST_XML = MUDLET_XML_PROLOG
    + '<MudletPackage version="1.001"><HostPackage><Host></Host></HostPackage></MudletPackage>';

/**
 * The `<Host>` document an export starts from: the profile's retained original
 * when it has one — carrying the ~100 settings Mudlet Web doesn't model — else the
 * empty skeleton. A retained document that somehow has no `<Host>` falls back
 * too, so a hand-edited or truncated file degrades to today's behaviour instead
 * of failing the export.
 */
function hostBaseDoc(retained: string | undefined): Document {
    const extracted = retained ? extractHostPackageXml(retained) : null;
    if (extracted) {
        const doc = new DOMParser().parseFromString(extracted, 'text/xml');
        if (doc.getElementsByTagName('Host')[0]) return doc;
    }
    return new DOMParser().parseFromString(EMPTY_HOST_XML, 'text/xml');
}

/**
 * The base `buildLinkedWriteback` writes this profile's automation and settings
 * onto. The connection identity and package list are stamped on either way: a
 * retained `<Host>` holds the name, address and packages the profile had when it
 * was imported, and the live connection record is what's authoritative now.
 */
export function buildHostBaseXml(
    connection: MudConnection,
    packageNames: string[],
    retained?: string,
    /** Written as `<mInstalledModules>` when given; a retained `<Host>` never
     *  carries one (see extractHostPackageXml). */
    modules?: MudletModuleEntry[],
): string {
    const doc = hostBaseDoc(retained);
    const host = doc.getElementsByTagName('Host')[0];
    const { url, port } = hostAddress(connection);
    applyHostIdentity(host, {
        name: connection.name,
        url,
        port,
        installedPackages: packageNames,
    });
    applyHostTls(host, {
        tls: !!connection.tls,
        sslIgnoreExpired: !!connection.sslIgnoreExpired,
        sslIgnoreSelfSigned: !!connection.sslIgnoreSelfSigned,
        sslIgnoreAll: !!connection.sslIgnoreAll,
    });
    if (modules) applyInstalledModules(host, modules);
    return new XMLSerializer().serializeToString(doc);
}

const ARCHIVE = /\.(mpackage|zip)$/i;

function moduleManifests(data: PersistedProfileData): PackageManifest[] {
    return (data.packages ?? []).filter(p => p.kind === 'module' && p.name);
}

/** The name desktop gives a module installed from `path`
 *  (`Host::sanitizePackageName`): the file name, less every package extension. */
function desktopModuleName(path: string): string {
    let name = path;
    let before;
    do {
        before = name;
        name = name.slice(name.lastIndexOf('/') + 1).replace(/\.(trigger|xml|zip|mpackage)/gi, '').replace(/\\/g, '');
    } while (name !== before);
    return name;
}

/**
 * Where each module's file sits in the exported folder, as the relative
 * `<filepath>` desktop's `<mInstalledModules>` lists, plus any module XML that
 * has to be written because the module's own file can't be listed as it is.
 *
 * An archive module points at its archive, which is what Mudlet Web reloads it
 * from too - unless it syncs: Mudlet Web syncs to the XML and leaves the
 * archive behind, and desktop would unpack that stale archive over it. Otherwise
 * the module's XML goes as it is on disk: a synced module keeps it current, and
 * one that never finished loading would lose whatever didn't load if it were
 * regenerated from its items. Only a module whose file lies outside the profile,
 * or is gone, is written fresh from its items.
 *
 * Desktop names an XML module after its file, so one whose file is named
 * otherwise would load there under a second name; it gets a copy named for it.
 * Desktop also deletes `<module>/` when the module is removed, so a module file
 * there gets a copy under `modules/`, or removing it would take its only copy.
 */
export function exportModules(src: Pick<ProfileExportSource, 'data' | 'files' | 'profilePath'>): {
    entries: MudletModuleEntry[];
    generated: Record<string, Uint8Array>;
} {
    const root = src.profilePath ? `${src.profilePath}/` : undefined;
    const inProfile = (abs: string | undefined) =>
        abs && root && abs.startsWith(root) ? abs.slice(root.length) : undefined;
    const entries: MudletModuleEntry[] = [];
    const generated: Record<string, Uint8Array> = {};
    // Code-unit order, as desktop's QMap of modules writes them
    const modules = moduleManifests(src.data).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const freePath = (file: string) => {
        let path = `modules/${file}`;
        for (let n = 2; src.files[path] || generated[path]; n++) path = `modules/${n}/${file}`;
        return path;
    };
    for (const m of modules) {
        const entry = { key: m.name, sync: !!m.sync, priority: m.priority ?? 0 };
        const removedWithModule = (path: string) => path.toLowerCase().startsWith(`${m.name.toLowerCase()}/`);
        const archive = inProfile(m.sourcePath);
        if (archive && ARCHIVE.test(archive) && src.files[archive] && !m.sync) {
            let path = archive;
            if (removedWithModule(archive)) {
                path = freePath(archive.slice(archive.lastIndexOf('/') + 1));
                generated[path] = src.files[archive];
            }
            entries.push({ ...entry, filepath: path });
            continue;
        }
        const xml = m.xmlVfsPath ? inProfile(m.xmlVfsPath) : m.xmlPath ? `${m.name}/${m.xmlPath}` : undefined;
        if (xml && src.files[xml] && desktopModuleName(xml) === m.name && !removedWithModule(xml)) {
            entries.push({ ...entry, filepath: xml });
            continue;
        }
        const path = freePath(`${m.name}.xml`);
        const own = <T extends { packageName?: string }>(nodes: T[] | undefined) =>
            (nodes ?? []).filter(n => n.packageName === m.name);
        generated[path] = xml && src.files[xml] ? src.files[xml] : strToU8(serializeMudletXml({
            scripts: own(src.data.scripts),
            aliases: own(src.data.aliases),
            triggers: own(src.data.triggers),
            timers: own(src.data.timers),
            keys: own(src.data.keybindings),
            buttons: own(src.data.buttons),
        }, m.name));
        entries.push({ ...entry, filepath: path });
    }
    return { entries, generated };
}

/** Serialize one profile's automation, variables and settings as Mudlet profile XML. */
export function buildProfileXml(
    connection: MudConnection,
    data: PersistedProfileData,
    /** The profile's retained `<HostPackage>` (or a full save to take it from),
     *  so unmodeled Mudlet settings survive. See {@link RETAINED_HOST_PATH}. */
    hostBaseXml?: string,
    modules: MudletModuleEntry[] = [],
): string {
    // A module's items live in its own file, as on desktop: in the save as
    // well, they would load twice and stop belonging to the module
    const moduleNames = new Set(moduleManifests(data).map(m => m.name));
    const packageNames = (data.packages ?? []).map(p => p.name).filter(n => n && !moduleNames.has(n));
    const notModule = <T extends { packageName?: string }>(nodes: T[] | undefined) =>
        (nodes ?? []).filter(n => !n.packageName || !moduleNames.has(n.packageName));
    return buildLinkedWriteback(
        buildHostBaseXml(connection, packageNames, hostBaseXml, modules),
        {
            scripts: notModule(data.scripts),
            aliases: notModule(data.aliases),
            triggers: notModule(data.triggers),
            timers: notModule(data.timers),
            keys: notModule(data.keybindings),
            buttons: notModule(data.buttons),
        },
        { hidden: data.variables?.hidden ?? [], variables: data.variables?.values ?? [] },
        data.profile,
    );
}

/** One exported session log: `name` becomes the filename under `logs/`. */
export interface ExportLog {
    name: string;
    html: string;
}

export interface ProfileExportSource {
    connection: MudConnection;
    /** Contents of `.mudlet/profile.json`. */
    data: PersistedProfileData;
    /** Loose VFS files (packages, fonts, sounds, …), keyed relative to the
     *  profile root. `.mudlet/` is expected to be filtered out by the collector. */
    files: Record<string, Uint8Array>;
    /** The profile's retained Mudlet `<HostPackage>` — `.mudlet/host.xml`, or a
     *  linked folder's own newest save. Undefined for a profile that was never
     *  imported from Mudlet: it has no unmodeled Host settings to preserve. */
    hostBaseXml?: string;
    /** The profile's VFS root, so a module referenced by absolute path can be
     *  found among `files`. */
    profilePath?: string;
    mapBytes?: Uint8Array;
    logs?: ExportLog[];
}

/** Strip characters that are illegal in zip entry / filesystem names, so a
 *  profile called `Arkadia: main` can't produce an unextractable archive. */
export function sanitizeFolderName(name: string, fallback: string): string {
    const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
    return cleaned || fallback;
}

/**
 * Build one profile's folder as `{path -> bytes}`, keyed *relative to the
 * profile root* (no folder prefix). Pure — the caller supplies everything.
 */
export function buildProfileFolder(src: ProfileExportSource, stamp: string): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const [path, bytes] of Object.entries(src.files)) {
        // The profile.json is re-serialized into the XML; carrying it too would
        // ship the same state twice in two formats. Both locations: a profile
        // that has not been opened since the storage rename still keeps it in
        // `.mudix/` (moved on open — see migrateLegacyDotDir).
        if (path === '.mudlet/profile.json' || path === '.mudix/profile.json') continue;
        out[path] = bytes;
    }
    const modules = exportModules(src);
    Object.assign(out, modules.generated);
    Object.assign(out, buildDesktopConnectionFiles(src.connection));
    out[`current/${stamp}.xml`] = strToU8(buildProfileXml(src.connection, src.data, src.hostBaseXml, modules.entries));
    out[CONNECTION_SIDECAR_PATH] = strToU8(JSON.stringify(buildConnectionSidecar(src.connection), null, 2));
    if (src.mapBytes) out[`map/${stamp}map.dat`] = src.mapBytes;
    for (const log of src.logs ?? []) {
        out[`logs/${sanitizeFolderName(log.name, 'session')}.html`] = strToU8(log.html);
    }
    return out;
}

/**
 * Build the downloadable archive: one folder per profile, so a single zip can
 * carry every profile a user has. Duplicate profile names are suffixed rather
 * than merged — two folders that collide would silently lose one profile.
 */
export function buildProfilesZip(sources: ProfileExportSource[], now: Date): Uint8Array {
    const stamp = formatSaveStamp(now);
    const entries: Zippable = {};
    // Desktop loads the newest save and map by modification time, and an unzip
    // keeps the archive's; every other file is dated a little earlier than them
    const newest = new Set([`current/${stamp}.xml`, `map/${stamp}map.dat`]);
    const earlier = new Date(now.getTime() - 60_000);
    const used = new Set<string>();
    sources.forEach((src, i) => {
        let folder = sanitizeFolderName(src.connection.name, `profile-${i + 1}`);
        if (used.has(folder.toLowerCase())) {
            let n = 2;
            while (used.has(`${folder} (${n})`.toLowerCase())) n++;
            folder = `${folder} (${n})`;
        }
        used.add(folder.toLowerCase());
        for (const [path, bytes] of Object.entries(buildProfileFolder(src, stamp))) {
            entries[`${folder}/${path}`] = [bytes, { mtime: newest.has(path) ? now : earlier }];
        }
    });
    // level 6: map files are the bulk and compress well; higher levels cost
    // seconds of main-thread time on a large map for a few percent.
    return zipSync(entries, { level: 6 });
}
