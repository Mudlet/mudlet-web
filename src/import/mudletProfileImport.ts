import { unzipSync, strFromU8 } from 'fflate';
import type { PackageManifest } from '../storage/schema';
import { extractHostPackageXml, parseMudletProfile, type MudletProfileImport, type MudletModuleRef } from './mudletHost';
import { parseMudletXml } from './mudletXmlImport';
import { parseConfigLuaText } from './packageInstaller';
import { canonicalServerEncoding } from '../mud/protocol/charset';
import { MAX_HISTORY } from '../ui/commandHistory';
import { decodeProfileData } from './qtProfileData';

// Turn the raw files of a Mudlet profile — a directory the user picked, or a
// .zip of one — into a structured bundle ready to provision a new Mudlet Web profile.
// Source-agnostic: callers hand in a {path -> bytes} map (from a File System
// Access directory walk or an unzip), and this locates the newest saved profile
// XML, the newest binary map, the remaining profile-root files, and the package
// manifests to register.

export interface MudletProfileBundle {
    /** Profile name — `<Host><name>`, else the profile folder name, else fallback. */
    name: string;
    /** MUD address from `<Host>` (`<url>`/`<port>`), if present. */
    host?: string;
    port?: number;
    /** Parsed settings + automation + variables from the newest current/*.xml. */
    profile: MudletProfileImport;
    /** That save's `<HostPackage>`, verbatim. `profile.settings` covers only the
     *  Host fields Mudlet Web models; the other ~100 live here and nowhere else, so
     *  this is retained in the new profile's VFS for an export to base on.
     *  Undefined if the save carries no `<HostPackage>`. */
    hostPackageXml?: string;
    /** Manifests for the profile's installed packages (from <mInstalledPackages>,
     *  metadata from each package's config.lua). Registered on import so
     *  getPackageInfo / package managers see them as installed. Folded-in
     *  modules join them as `kind: 'module'` manifests (addModuleToBundle). */
    packages: PackageManifest[];
    /** Modules the profile loads from external local XML files — unresolvable in a
     *  browser; the import UI asks the user to upload or drop each. */
    modules: MudletModuleRef[];
    /** Newest map/* binary, ready for mapStorage. Undefined if the profile has no map. */
    mapBytes?: Uint8Array;
    /** Remaining profile-root files to copy into the new VFS (packages, fonts,
     *  sounds, …), keyed relative to the profile root. Excludes current/ and map/,
     *  and the {@link CONSUMED_PROFILE_FILES} read into the fields below. */
    files: Record<string, Uint8Array>;
    /** Connect over TLS: the profile's `ssl_tsl` file, else `<Host mSslTsl>`.
     *  Undefined when neither says. */
    tls?: boolean;
    /** Desktop's saved character name — the profile's `login` file, which it
     *  sends on its own two seconds after connecting. */
    login?: string;
    /** The saved password, from the profile's `password` file. Only there when
     *  desktop was not keeping passwords in the system keychain. Never written
     *  into the new profile's files: the caller hands it to the credential vault. */
    password?: string;
    /** The main command line's history (`command_history_main`), newest first,
     *  de-duplicated the way Mudlet Web's own history is. */
    commandHistory?: string[];
    /**
     * Everything about this profile that could not be carried over faithfully,
     * in the order it was noticed. Seeded from the XML parse
     * (`profile.automation.warnings`) and appended to as the import proceeds —
     * by `addModuleToBundle` for each folded-in module, and by
     * `importMudletProfile` for files that would not write and a map that would
     * not save.
     *
     * The single place the import UI reads: a profile import used to succeed in
     * silence even when it dropped things, which made every fidelity gap a
     * surprise discovered weeks later (issue #45).
     */
    warnings: string[];
}

/**
 * Profile-root files desktop keeps a connection detail in, one value per file
 * (`MudletApp::readProfileData`). Each is read into the bundle — the connection
 * record or the settings — rather than copied as a file: once imported, those
 * are what's live, and a copy left in the profile would be stale the moment the
 * setting changed (an export writes fresh ones, see buildProfileFolder). The
 * password is kept out of the profile's files above all.
 */
export const CONSUMED_PROFILE_FILES = ['encoding', 'ssl_tsl', 'login', 'password'] as const;

/** Qt::Checked, which is what desktop's `ssl_tsl` file holds for "on". */
const QT_CHECKED = 2;

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** The profile-root prefix (with trailing slash, or '') for a path that sits at
 *  or under a `current/` directory — i.e. everything before `current/`. */
function rootOfCurrent(lowerPath: string): string | null {
    if (lowerPath.startsWith('current/')) return '';
    const i = lowerPath.indexOf('/current/');
    return i >= 0 ? lowerPath.slice(0, i + 1) : null;
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The newest of `paths`: by mtime when there are mtimes (what desktop goes by),
 * with `byName` choosing among any that tie — a zip stamps every entry it
 * writes at once with the same time, and its times are only good to two
 * seconds. Without mtimes, `byName` alone decides. Null for no paths.
 */
function pickNewest(
    paths: string[],
    mtimes: Record<string, number> | undefined,
    byName: (candidates: string[]) => string,
): string | null {
    if (!paths.length) return null;
    if (!mtimes) return byName(paths);
    const newest = Math.max(...paths.map(p => mtimes[p] ?? 0));
    return byName(paths.filter(p => (mtimes[p] ?? 0) === newest));
}

/** Without times to go by, prefer autosave.xml, else the latest timestamp
 *  filename (Mudlet names saves YYYY-MM-DD#HH-mm-ss.xml). */
function newestXmlByName(paths: string[]): string {
    return paths.find(p => basename(p).toLowerCase() === 'autosave.xml')
        ?? paths.reduce((a, b) => (basename(b) > basename(a) ? b : a));
}

function latestByName(paths: string[]): string {
    return paths.reduce((a, b) => (basename(b) > basename(a) ? b : a));
}

/**
 * Desktop's `command_history_main`: one command per line, newest first, often
 * led by an empty line (TCommandLine::slot_saveHistory saves the line being
 * typed too). Read into the shape Mudlet Web's history keeps — no blanks, one
 * entry per command ignoring case, at most {@link MAX_HISTORY}.
 */
export function parseCommandHistory(text: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
        if (out.length >= MAX_HISTORY) break;
    }
    return out;
}

/**
 * Build a manifest per installed package, reading metadata from each package's
 * config.lua via `readConfig(name)` (returns the file text or undefined).
 * `installedAt` is left empty for the caller to stamp (keeps this deterministic).
 * Reusable across the file-map import path and the linked-folder (VFS) path.
 */
export function buildPackageManifests(
    names: string[],
    readConfig: (name: string) => string | undefined,
): PackageManifest[] {
    return names.map(name => {
        let info: Partial<PackageManifest> = {};
        const src = readConfig(name);
        if (src) {
            try { info = parseConfigLuaText(src); } catch { /* leave bare */ }
        }
        // The name stays the one <mInstalledPackages> knows it by, whatever
        // config.lua's `mpackage` says: that is the name desktop installed it
        // under, and the one its folder and tagged nodes carry.
        return { ...info, name, installedAt: '', kind: 'package' as const };
    });
}

/** Desktop's main command-line history file, beside the profile-data files. */
export const DESKTOP_HISTORY_FILE = 'command_history_main';

/** What a desktop profile's own files say about its connection — see
 *  {@link readDesktopProfileFiles}. */
export interface DesktopProfileFiles {
    /** The `encoding` file, in the listed spelling. Undefined when there is no
     *  file, or it names an encoding Mudlet Web cannot decode (then warned). */
    serverEncoding?: string;
    /** `ssl_tsl`, else the save's `mSslTsl` passed in. */
    tls?: boolean;
    login?: string;
    password?: string;
    /** `command_history_main`, newest first (see {@link parseCommandHistory}). */
    commandHistory?: string[];
    warnings: string[];
}

/**
 * Read the files desktop keeps a profile's connection details in — the
 * {@link CONSUMED_PROFILE_FILES}, serialised QStrings (see qtProfileData.ts),
 * and the plain-text {@link DESKTOP_HISTORY_FILE}. `read` returns a file's
 * bytes by its name at the profile root, or undefined when it is absent.
 * Shared by the import and by a linked folder, which reads the same files in
 * place. `saveTls` is the save's `<Host mSslTsl>`, the fallback for TLS.
 */
export function readDesktopProfileFiles(
    read: (name: string) => Uint8Array | undefined,
    saveTls?: boolean,
): DesktopProfileFiles {
    const text = (name: string) => {
        const bytes = read(name);
        return bytes === undefined ? undefined : decodeProfileData(bytes);
    };
    const warnings: string[] = [];
    // Host's constructor reads `encoding` and hands it to cTelnet::setEncoding;
    // the saves themselves don't carry it.
    let serverEncoding: string | undefined;
    const encodingName = text('encoding')?.trim();
    if (encodingName) {
        serverEncoding = canonicalServerEncoding(encodingName) ?? undefined;
        if (!serverEncoding) warnings.push(`The server encoding "${encodingName}" is not one Mudlet Web can decode; the profile uses UTF-8.`);
    }
    // The connection dialog writes `ssl_tsl` the moment its checkbox changes and
    // sets mSslTsl from it on connect, so it is newer than the save's attribute
    // — when it holds a check state at all; anything else falls back to the save.
    const tls = parseSslTsl(text('ssl_tsl')) ?? saveTls;
    const login = text('login')?.trim() || undefined;
    // Not trimmed: desktop sends the password exactly as the file holds it.
    const password = text('password')?.replace(/\r?\n$/, '') || undefined;
    const history = read(DESKTOP_HISTORY_FILE);
    const commandHistory = history ? parseCommandHistory(strFromU8(history)) : undefined;
    return {
        ...(serverEncoding ? { serverEncoding } : {}),
        ...(tls !== undefined ? { tls } : {}),
        ...(login ? { login } : {}),
        ...(password ? { password } : {}),
        ...(commandHistory?.length ? { commandHistory } : {}),
        warnings,
    };
}

/** An `ssl_tsl` file's decoded text as on/off, or undefined when it holds no
 *  check state (missing, empty, or not a number). */
export function parseSslTsl(text: string | undefined): boolean | undefined {
    const t = text?.trim();
    return t && /^\d+$/.test(t) ? Number(t) === QT_CHECKED : undefined;
}

/** Build manifests from a profile-root files map (the import path). */
function buildManifests(names: string[], files: Record<string, Uint8Array>): PackageManifest[] {
    const byLower = new Map(Object.keys(files).map(k => [k.toLowerCase(), k]));
    return buildPackageManifests(names, name => {
        const k = byLower.get(`${name.toLowerCase()}/config.lua`);
        return k ? strFromU8(files[k]) : undefined;
    });
}

/**
 * Build a profile bundle from a Mudlet profile's files. `fallbackName` is used
 * when neither the Host `<name>` nor a wrapping folder name is available.
 * `mtimes` (keyed the same as `files`) makes the newest-save selection match
 * Mudlet's (most-recently-modified wins); without it, a deterministic fallback
 * prefers `current/autosave.xml` then the latest timestamp filename.
 * Throws if no `current/*.xml` is present (not a Mudlet profile).
 */
/** Normalize separators and drop directory entries, keeping mtimes aligned. */
function normalizeTree(
    files: Record<string, Uint8Array>,
    mtimes?: Record<string, number>,
): { norm: Map<string, Uint8Array>; normMtime: Record<string, number> } {
    const norm = new Map<string, Uint8Array>();
    const normMtime: Record<string, number> = {};
    for (const [k, v] of Object.entries(files)) {
        const p = normalizePath(k);
        if (!p || p.endsWith('/')) continue;
        norm.set(p, v);
        if (mtimes && mtimes[k] !== undefined) normMtime[p] = mtimes[k];
    }
    return { norm, normMtime };
}

/**
 * Every profile root in the tree — the prefix before each `current/` directory.
 *
 * A tree with profiles side by side (Mudlet Web's multi-profile export) yields one
 * root each. Nesting is resolved by depth: a root at the top wins over anything
 * inside it, so a single profile that happens to contain another `current/*.xml`
 * deeper down still imports as one profile, matching the old shallowest-wins
 * behavior. Returned sorted, so import order is deterministic.
 */
export function findProfileRoots(files: Record<string, Uint8Array>): string[] {
    const { norm } = normalizeTree(files);
    const roots = new Set<string>();
    for (const p of norm.keys()) {
        const lower = p.toLowerCase();
        if (!/(^|\/)current\/[^/]+\.xml$/.test(lower)) continue;
        const r = rootOfCurrent(lower);
        // `current/` is matched case-insensitively, but the root is returned in
        // its original case — it's a real path prefix callers hand back to
        // buildMudletProfileBundle (and show to users), not a match key.
        if (r !== null) roots.add(p.slice(0, r.length));
    }
    if (!roots.size) return [];
    // The bare root swallows everything else — a profile zipped without its
    // folder can't also contain sibling profiles.
    if (roots.has('')) return [''];
    const depth = (r: string) => r.split('/').filter(Boolean).length;
    const shallowest = Math.min(...Array.from(roots, depth));
    return Array.from(roots).filter(r => depth(r) === shallowest).sort();
}

export function buildMudletProfileBundle(
    files: Record<string, Uint8Array>,
    fallbackName = 'Imported profile',
    mtimes?: Record<string, number>,
    /** Import this specific root (from {@link findProfileRoots}) instead of the
     *  shallowest one — used when one tree holds several profiles. */
    rootOverride?: string,
): MudletProfileBundle {
    const { norm, normMtime } = normalizeTree(files, mtimes);

    const root = rootOverride ?? findProfileRoots(files)[0] ?? null;
    if (root === null) throw new Error('Not a Mudlet profile: no current/*.xml found');
    const rootPrefix = root;

    // Re-key everything relative to the profile root, carrying mtimes along.
    // Matching stays case-insensitive (zips from case-insensitive filesystems
    // vary), while the prefix itself keeps its original case.
    const rootLower = rootPrefix.toLowerCase();
    const rel = new Map<string, Uint8Array>();
    const relMtime: Record<string, number> = {};
    for (const [p, v] of norm) {
        if (rootPrefix && !p.toLowerCase().startsWith(rootLower)) continue;
        const r = p.slice(rootPrefix.length);
        rel.set(r, v);
        if (normMtime[p] !== undefined) relMtime[r] = normMtime[p];
    }
    const haveMtimes = mtimes && Object.keys(relMtime).length > 0 ? relMtime : undefined;

    const currentXmls: string[] = [];
    const maps: string[] = [];
    const others: Record<string, Uint8Array> = {};
    for (const relPath of rel.keys()) {
        const lower = relPath.toLowerCase();
        if (/^current\/[^/]+\.xml$/.test(lower)) currentXmls.push(relPath);
        else if (lower.startsWith('current/')) { /* non-xml current files: ignore */ }
        else if (lower.startsWith('map/')) maps.push(relPath);
        else others[relPath] = rel.get(relPath)!;
    }
    if (!currentXmls.length) throw new Error('Not a Mudlet profile: no current/*.xml found');

    // Newest save and newest map, the way desktop picks them: by modification
    // time. A map's name is no guide — `autosave.dat` sorts after every dated
    // `YYYY-MM-DD#HH-mm-ssmap.dat` whichever is newer.
    const newestXml = pickNewest(currentXmls, haveMtimes, newestXmlByName)!;
    const newestMap = pickNewest(maps, haveMtimes, latestByName);

    const newestXmlText = strFromU8(rel.get(newestXml)!);
    const profile = parseMudletProfile(newestXmlText);
    const folderName = rootPrefix ? basename(rootPrefix.replace(/\/$/, '')) : '';
    // Copied, not aliased: later stages push onto this list, and the parse
    // result is also handed to the store as the profile's own automation.
    const warnings = [...profile.automation.warnings];

    // The connection details desktop keeps in files of their own beside the save.
    const historyFile = Object.keys(others).find(k => k.toLowerCase() === DESKTOP_HISTORY_FILE);
    const desktop = readDesktopProfileFiles(
        name => (name === DESKTOP_HISTORY_FILE ? (historyFile ? others[historyFile] : undefined) : others[name]),
        profile.connection.tls,
    );
    for (const file of CONSUMED_PROFILE_FILES) delete others[file];
    if (desktop.serverEncoding) profile.settings.serverEncoding = desktop.serverEncoding;
    warnings.push(...desktop.warnings);
    const { tls, login, password, commandHistory } = desktop;

    return {
        name: profile.connection.name || folderName || fallbackName,
        host: profile.connection.host,
        port: profile.connection.port,
        profile,
        hostPackageXml: extractHostPackageXml(newestXmlText) ?? undefined,
        packages: buildManifests(profile.installedPackages, others),
        modules: profile.modules,
        mapBytes: newestMap ? rel.get(newestMap) : undefined,
        files: others,
        ...(tls !== undefined ? { tls } : {}),
        ...(login ? { login } : {}),
        ...(password ? { password } : {}),
        ...(commandHistory?.length ? { commandHistory } : {}),
        warnings,
    };
}

/**
 * Each entry's modification time (ms), keyed by name exactly as `unzipSync`
 * keys it, read from the archive's central directory — fflate doesn't surface
 * them. Uses the Info-ZIP extended-timestamp field (0x5455, true UTC to the
 * second) when every entry has one, else the DOS date/time all entries carry
 * (local time, two-second resolution). Either way the values only have to
 * order entries of the same archive, so a DOS time is read as if it were UTC.
 * Entries with no usable time are left out. Never throws: an archive this
 * can't read just yields no times, and the import falls back to names.
 */
export function zipEntryMtimes(bytes: Uint8Array): Record<string, number> {
    const u16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
    const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
    try {
        let e = bytes.length - 22;
        while (e >= 0 && u32(e) !== 0x06054b50) {
            if (bytes.length - e > 65557) return {};
            e--;
        }
        if (e < 0) return {};
        let count = u16(e + 10);
        let offset = u32(e + 16);
        // Zip64: the real count and offset live in the zip64 end record.
        if (e >= 20 && u32(e - 20) === 0x07064b50) {
            const z = u32(e - 12);
            if (u32(z) === 0x06064b50) {
                count = u32(z + 32);
                offset = u32(z + 48);
            }
        }
        const dos: Record<string, number> = {};
        const unix: Record<string, number> = {};
        let allUnix = count > 0;
        for (let i = 0; i < count; i++) {
            if (u32(offset) !== 0x02014b50) return {};
            const flags = u16(offset + 8);
            const time = u16(offset + 12);
            const date = u16(offset + 14);
            const nameLen = u16(offset + 28);
            const extraLen = u16(offset + 30);
            const commentLen = u16(offset + 32);
            // Bit 11 marks a UTF-8 name; fflate reads any other as Latin-1.
            const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLen), !(flags & 0x800));
            if (date) {
                dos[name] = Date.UTC(
                    (date >> 9) + 1980, ((date >> 5) & 15) - 1, date & 31,
                    time >> 11, (time >> 5) & 63, (time & 31) * 2,
                );
            }
            let found = false;
            const extraEnd = offset + 46 + nameLen + extraLen;
            for (let x = offset + 46 + nameLen; x + 4 <= extraEnd; x += 4 + u16(x + 2)) {
                // UT: a flags byte, then the mtime when its bit 0 is set.
                if (u16(x) === 0x5455 && u16(x + 2) >= 5 && (bytes[x + 4] & 1)) {
                    unix[name] = u32(x + 5) * 1000;
                    found = true;
                    break;
                }
            }
            if (!found) allUnix = false;
            offset = extraEnd + commentLen;
        }
        return allUnix ? unix : dos;
    } catch {
        return {};
    }
}

/** Build a profile bundle from a `.zip` of a Mudlet profile directory, picking
 *  the newest save and map by the entries' modification times. */
export function extractMudletProfileZip(
    bytes: Uint8Array,
    fallbackName = 'Imported profile',
): MudletProfileBundle {
    return buildMudletProfileBundle(unzipSync(bytes), fallbackName, zipEntryMtimes(bytes));
}

/** One bundle per profile in the tree — a Mudlet Web multi-profile export, or a
 *  single Mudlet profile (in which case this is a one-element list). */
export function buildAllMudletProfileBundles(
    files: Record<string, Uint8Array>,
    fallbackName = 'Imported profile',
    mtimes?: Record<string, number>,
): MudletProfileBundle[] {
    const roots = findProfileRoots(files);
    if (!roots.length) throw new Error('Not a Mudlet profile: no current/*.xml found');
    return roots.map(root => buildMudletProfileBundle(files, fallbackName, mtimes, root));
}

/** Every profile in a `.zip`, in folder order. */
export function extractMudletProfileZipAll(
    bytes: Uint8Array,
    fallbackName = 'Imported profile',
): MudletProfileBundle[] {
    return buildAllMudletProfileBundles(unzipSync(bytes), fallbackName, zipEntryMtimes(bytes));
}

// ── modules ──────────────────────────────────────────────────────────────────
// A Mudlet module loads its content from an external XML file on the user's disk
// (e.g. C:/Users/.../buttons.xml). A browser can't read that path, but the file
// is sometimes present inside the imported profile tree — so we match by
// basename. Whatever's resolved stays a MODULE, as it is on desktop: its XML is
// kept as a file in the new profile's VFS, which the module reloads from on
// every open and (with its globalSave flag) syncs back to, and its priority is
// carried over. Anything not found is surfaced for the user to upload or drop.

export interface ResolvedModule {
    ref: MudletModuleRef;
    xmlBytes: Uint8Array;
    /** Where the file was found, as a `bundle.files` key. */
    path: string;
}

function fileBasename(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
}

/** Split a bundle's modules into those whose XML was found in the imported tree
 *  (by filename) and those still missing. */
export function resolveModulesFromTree(bundle: MudletProfileBundle): {
    resolved: ResolvedModule[];
    unresolved: MudletModuleRef[];
} {
    const byBase = new Map<string, string>();
    for (const p of Object.keys(bundle.files)) byBase.set(fileBasename(p), p);
    const resolved: ResolvedModule[] = [];
    const unresolved: MudletModuleRef[] = [];
    for (const ref of bundle.modules) {
        const path = byBase.get(fileBasename(ref.filepath));
        if (path) resolved.push({ ref, xmlBytes: bundle.files[path], path });
        else unresolved.push(ref);
    }
    return { resolved, unresolved };
}

/**
 * Fold a resolved/uploaded module's XML into the bundle: its triggers/aliases/…
 * are parsed (tagged under the module key) and appended to the automation, and
 * a MODULE manifest is registered — `kind: 'module'`, the `<globalSave>` flag
 * as `sync`, its `<priority>` — so getModules/getModulePriority/getModulePath
 * see it the way desktop does, and getPackages does not (issue #279).
 *
 * The XML has to exist as a file for the module to reload from: `treePath` is
 * where the import tree already holds it (see resolveModulesFromTree); an
 * uploaded file is added to `bundle.files` under `<key>/<its filename>`. The
 * manifest's `xmlVfsPath` is that path relative to the profile root until
 * bundleToConnectionData anchors it in the new profile's VFS.
 *
 * `module` may be the bare key, in which case the rest of its entry is looked
 * up in `bundle.modules`. Mutates and returns the bundle.
 */
export function addModuleToBundle(
    bundle: MudletProfileBundle,
    module: MudletModuleRef | string,
    xmlBytes: Uint8Array,
    treePath?: string,
): MudletProfileBundle {
    const ref: MudletModuleRef = typeof module === 'string'
        ? bundle.modules.find(m => m.key === module) ?? { key: module, filepath: '', globalSave: false, priority: 0 }
        : module;
    const key = ref.key;
    const parsed = parseMudletXml(strFromU8(xmlBytes), { packageName: key });
    const a = bundle.profile.automation;
    a.scripts.push(...parsed.scripts);
    a.aliases.push(...parsed.aliases);
    a.triggers.push(...parsed.triggers);
    a.timers.push(...parsed.timers);
    a.keys.push(...parsed.keys);
    a.buttons.push(...parsed.buttons);
    a.warnings.push(...parsed.warnings);
    // Named, because by this point the user has hand-picked the file this came
    // from and needs to know which one the complaint is about.
    for (const w of parsed.warnings) bundle.warnings.push(`Module "${key}": ${w}`);
    let relPath = treePath && bundle.files[treePath] ? treePath : undefined;
    if (!relPath) {
        const filename = ref.filepath.replace(/\\/g, '/').split('/').pop() || `${key}.xml`;
        relPath = `${key}/${filename}`;
        bundle.files[relPath] = xmlBytes;
    }
    const manifest: PackageManifest = {
        name: key,
        installedAt: '',
        kind: 'module',
        sync: ref.globalSave,
        priority: ref.priority,
        xmlVfsPath: relPath,
        sourceFile: relPath.split('/').pop(),
    };
    // A module named in <mInstalledPackages> too is a module: desktop's
    // getPackages lists only what mInstalledPackages holds, but our store keeps
    // one manifest per name, and the module's is the one that loads it.
    const at = bundle.packages.findIndex(p => p.name === key);
    if (at === -1) bundle.packages.push(manifest);
    else bundle.packages[at] = manifest;
    return bundle;
}
