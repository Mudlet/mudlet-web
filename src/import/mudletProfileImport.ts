import { unzipSync, strFromU8 } from 'fflate';
import type { PackageManifest } from '../storage/schema';
import { extractHostPackageXml, parseMudletProfile, type MudletProfileImport, type MudletModuleRef } from './mudletHost';
import { parseMudletXml } from './mudletXmlImport';

// Turn the raw files of a Mudlet profile — a directory the user picked, or a
// .zip of one — into a structured bundle ready to provision a new mudix profile.
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
     *  Host fields mudix models; the other ~100 live here and nowhere else, so
     *  this is retained in the new profile's VFS for an export to base on.
     *  Undefined if the save carries no `<HostPackage>`. */
    hostPackageXml?: string;
    /** Manifests for the profile's installed packages (from <mInstalledPackages>,
     *  metadata from each package's config.lua). Registered on import so
     *  getPackageInfo / package managers see them as installed. */
    packages: PackageManifest[];
    /** Modules the profile loads from external local XML files — unresolvable in a
     *  browser; the import UI asks the user to upload or drop each. */
    modules: MudletModuleRef[];
    /** Newest map/* binary, ready for mapStorage. Undefined if the profile has no map. */
    mapBytes?: Uint8Array;
    /** Remaining profile-root files to copy into the new VFS (packages, fonts,
     *  sounds, …), keyed relative to the profile root. Excludes current/ and map/. */
    files: Record<string, Uint8Array>;
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

/** Pick the newest of `paths` by mtime when available; else null (caller decides
 *  a deterministic fallback). */
function newestByMtime(paths: string[], mtimes: Record<string, number> | undefined): string | null {
    if (!paths.length || !mtimes) return null;
    return paths.reduce((a, b) => ((mtimes[b] ?? 0) > (mtimes[a] ?? 0) ? b : a));
}

// Pull a few standard fields out of a package's config.lua. Not a Lua eval —
// just matches `key = "..."` / `key = [[...]]` / `key = '...'` assignments, which
// is how Mudlet/muddler config.lua files declare their metadata.
function parseConfigLua(src: string): Partial<PackageManifest> {
    const field = (key: string): string | undefined => {
        const m = src.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(?:\\[\\[([\\s\\S]*?)\\]\\]|"([^"]*)"|'([^']*)')`));
        const v = (m?.[1] ?? m?.[2] ?? m?.[3])?.trim();
        return v ? v : undefined;
    };
    const out: Partial<PackageManifest> = {};
    const version = field('version'); if (version) out.version = version;
    const author = field('author'); if (author) out.author = author;
    const title = field('title'); if (title) out.title = title;
    const description = field('description'); if (description) out.description = description;
    const icon = field('icon'); if (icon) out.icon = icon;
    const created = field('created'); if (created) out.created = created;
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
            try { info = parseConfigLua(src); } catch { /* leave bare */ }
        }
        return { name, installedAt: '', kind: 'package' as const, ...info };
    });
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
 * A tree with profiles side by side (mudix's multi-profile export) yields one
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

    // Newest save: mtime when we have it, else prefer autosave.xml, else the
    // latest timestamp filename (Mudlet names saves YYYY-MM-DD#HH-mm-ss.xml).
    let newestXml = newestByMtime(currentXmls, haveMtimes);
    if (!newestXml) {
        newestXml = currentXmls.find(p => basename(p).toLowerCase() === 'autosave.xml')
            ?? currentXmls.reduce((a, b) => (basename(b) > basename(a) ? b : a));
    }
    let newestMap = newestByMtime(maps, haveMtimes);
    if (!newestMap && maps.length) {
        newestMap = maps.reduce((a, b) => (basename(b) > basename(a) ? b : a));
    }

    const newestXmlText = strFromU8(rel.get(newestXml)!);
    const profile = parseMudletProfile(newestXmlText);
    const folderName = rootPrefix ? basename(rootPrefix.replace(/\/$/, '')) : '';
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
        // Copied, not aliased: later stages push onto this list, and the parse
        // result is also handed to the store as the profile's own automation.
        warnings: [...profile.automation.warnings],
    };
}

/** Build a profile bundle from a `.zip` of a Mudlet profile directory. (Zip
 *  entry mtimes aren't surfaced, so newest-save uses the autosave/timestamp
 *  fallback.) */
export function extractMudletProfileZip(
    bytes: Uint8Array,
    fallbackName = 'Imported profile',
): MudletProfileBundle {
    return buildMudletProfileBundle(unzipSync(bytes), fallbackName);
}

/** One bundle per profile in the tree — a mudix multi-profile export, or a
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
    return buildAllMudletProfileBundles(unzipSync(bytes), fallbackName);
}

// ── modules ──────────────────────────────────────────────────────────────────
// A Mudlet module loads its content from an external XML file on the user's disk
// (e.g. C:/Users/.../buttons.xml). A browser can't read that path, but the file
// is sometimes present inside the imported profile tree — so we match by
// basename. Whatever's resolved is baked into the profile as a normal (removable)
// package; a browser can't live-sync to an external file anyway. Anything not
// found is surfaced for the user to upload or drop.

export interface ResolvedModule {
    ref: MudletModuleRef;
    xmlBytes: Uint8Array;
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
    const byBase = new Map<string, Uint8Array>();
    for (const [p, b] of Object.entries(bundle.files)) byBase.set(fileBasename(p), b);
    const resolved: ResolvedModule[] = [];
    const unresolved: MudletModuleRef[] = [];
    for (const ref of bundle.modules) {
        const bytes = byBase.get(fileBasename(ref.filepath));
        if (bytes) resolved.push({ ref, xmlBytes: bytes });
        else unresolved.push(ref);
    }
    return { resolved, unresolved };
}

/**
 * Fold a resolved/uploaded module's XML into the bundle: its triggers/aliases/…
 * are parsed (grouped + tagged under the module key, so it's a removable unit)
 * and appended to the automation, and a manifest is registered. Mutates and
 * returns the bundle. Treated as a package — the live-sync-to-disk behaviour
 * doesn't apply in a browser.
 */
export function addModuleToBundle(bundle: MudletProfileBundle, key: string, xmlBytes: Uint8Array): MudletProfileBundle {
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
    if (!bundle.packages.some(p => p.name === key)) {
        bundle.packages.push({ name: key, installedAt: '', kind: 'package' });
    }
    return bundle;
}
