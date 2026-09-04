import { zipSync, strToU8 } from 'fflate';
import type { MudConnection } from '../storage/schema';
import type { PersistedProfileData } from '../storage/profileVfsData';
import { buildLinkedWriteback } from './mudletWriteback';
import { applyHostIdentity, extractHostPackageXml, MUDLET_XML_PROLOG } from './mudletHost';

// The inverse of mudletProfileImport: turn a mudix profile back into a *Mudlet
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
// settings mudix doesn't model survive the trip out; a profile born in mudix has
// nothing to retain and starts from the empty skeleton.

/** Mudlet names its saves `YYYY-MM-DD#HH-mm-ss.xml`; the importer sorts by that
 *  filename when no mtimes are available, so the stamp has to be sortable. */
export function formatSaveStamp(date: Date): string {
    const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
        `#${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

/** Connection fields Mudlet's `<Host>` can't express (websocket mode, the proxy
 *  override, auto-reconnect). Written beside the XML so a mudix→mudix round-trip
 *  keeps them; desktop Mudlet ignores the dot-directory entirely. */
export const CONNECTION_SIDECAR_PATH = '.mudix/connection.json';

/** Where a profile imported from Mudlet keeps its original `<HostPackage>`,
 *  inside its own VFS. `extractHostPackageXml` produces it at import time; the
 *  export and `saveProfile()` base their `<Host>` on it so the settings mudix
 *  doesn't model don't revert to Mudlet's defaults. Dot-prefixed like the rest
 *  of mudix's bookkeeping, so desktop Mudlet ignores it.
 *
 *  Absent for a profile created in mudix (nothing unmodeled to preserve), for a
 *  linked folder (its own `current/*.xml` is the live original), and for
 *  profiles imported before this file existed — their `<Host>` was already
 *  dropped at import and can't be recovered. */
export const RETAINED_HOST_PATH = '.mudix/host.xml';

export interface ConnectionSidecar {
    mode?: MudConnection['mode'];
    url?: string;
    host?: string;
    port?: number;
    proxyUrl?: string;
    autoReconnect?: boolean;
}

export function buildConnectionSidecar(c: MudConnection): ConnectionSidecar {
    const out: ConnectionSidecar = {};
    if (c.mode !== undefined) out.mode = c.mode;
    if (c.url !== undefined) out.url = c.url;
    if (c.host !== undefined) out.host = c.host;
    if (c.port !== undefined) out.port = c.port;
    if (c.proxyUrl !== undefined) out.proxyUrl = c.proxyUrl;
    if (c.autoReconnect !== undefined) out.autoReconnect = c.autoReconnect;
    return out;
}

/** The `<url>`/`<port>` a Mudlet `<Host>` should carry for this connection.
 *  A websocket profile has no host/port pair, so its ws(s):// URL goes in
 *  `<url>` — the sidecar carries the mode, and the ws scheme is a second signal
 *  the importer can fall back on. */
function hostAddress(c: MudConnection): { url: string; port: number } {
    if (c.mode === 'mud') return { url: c.host ?? '', port: c.port ?? 23 };
    return { url: c.url ?? c.host ?? '', port: c.port ?? 23 };
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
 * when it has one — carrying the ~100 settings mudix doesn't model — else the
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
): string {
    const doc = hostBaseDoc(retained);
    const { url, port } = hostAddress(connection);
    applyHostIdentity(doc.getElementsByTagName('Host')[0], {
        name: connection.name,
        url,
        port,
        installedPackages: packageNames,
    });
    return new XMLSerializer().serializeToString(doc);
}

/** Serialize one profile's automation, variables and settings as Mudlet profile XML. */
export function buildProfileXml(
    connection: MudConnection,
    data: PersistedProfileData,
    /** The profile's retained `<HostPackage>` (or a full save to take it from),
     *  so unmodeled Mudlet settings survive. See {@link RETAINED_HOST_PATH}. */
    hostBaseXml?: string,
): string {
    const packageNames = (data.packages ?? []).map(p => p.name).filter(Boolean);
    return buildLinkedWriteback(
        buildHostBaseXml(connection, packageNames, hostBaseXml),
        {
            scripts: data.scripts ?? [],
            aliases: data.aliases ?? [],
            triggers: data.triggers ?? [],
            timers: data.timers ?? [],
            keys: data.keybindings ?? [],
            buttons: data.buttons ?? [],
        },
        { hidden: [], variables: data.variables?.values ?? [] },
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
    /** Contents of `.mudix/profile.json`. */
    data: PersistedProfileData;
    /** Loose VFS files (packages, fonts, sounds, …), keyed relative to the
     *  profile root. `.mudix/` is expected to be filtered out by the collector. */
    files: Record<string, Uint8Array>;
    /** The profile's retained Mudlet `<HostPackage>` — `.mudix/host.xml`, or a
     *  linked folder's own newest save. Undefined for a profile that was never
     *  imported from Mudlet: it has no unmodeled Host settings to preserve. */
    hostBaseXml?: string;
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
        // ship the same state twice in two formats.
        if (path === '.mudix/profile.json') continue;
        out[path] = bytes;
    }
    out[`current/${stamp}.xml`] = strToU8(buildProfileXml(src.connection, src.data, src.hostBaseXml));
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
    const entries: Record<string, Uint8Array> = {};
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
            entries[`${folder}/${path}`] = bytes;
        }
    });
    // level 6: map files are the bulk and compress well; higher levels cost
    // seconds of main-thread time on a large map for a few percent.
    return zipSync(entries, { level: 6 });
}
