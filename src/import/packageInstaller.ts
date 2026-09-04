import { unzipSync, strFromU8 } from 'fflate';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import type { PackageKind, PackageManifest } from '../storage/schema';
import { parseMudletXml, type MudletImportResult } from './mudletXmlImport';

export interface InstallResult {
    manifest: PackageManifest;
    data: MudletImportResult;
}

/**
 * An install that has been validated and unpacked in memory but has not touched
 * the profile's files yet: `commit()` is the only step that writes. A caller
 * that decides to refuse — the name is already installed, the user cancelled —
 * drops the prepared install and the profile is left exactly as it was.
 *
 * Desktop Mudlet takes the same order (`Host::installPackage` refuses an
 * already-installed name before it unpacks anything). Wiping first meant every
 * later refusal destroyed the files of the very install it declined to replace,
 * leaving a package that was listed, had items in the store, and had nothing
 * behind it on disk.
 */
export interface PreparedInstall extends InstallResult {
    /** Write the package's files into the VFS. Nothing on disk changes before this. */
    commit(): void;
}

export interface InstallOptions {
    /**
     * 'package' (default) — plain XML imports skip VFS storage; only zips are kept on disk.
     * 'module'            — XML on disk is the source of truth: even plain XML is written to the
     *                       VFS so it can be re-parsed on the next profile open and synced to.
     */
    kind?: PackageKind;
    /**
     * Absolute VFS path the bytes were read from, when known. If it lives inside the
     * derived pkgDir, the install skips the pkgDir wipe — otherwise an installer-style
     * "unzip into <pkgDir>/ then installPackage(<pkgDir>/foo.xml)" pattern would delete
     * the resources the script just staged.
     */
    sourcePath?: string;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" — local file header

/** Mudlet accepts both, and treats the name — not the content — as the claim
 *  about what the file is. */
const archiveExtension = /\.(mpackage|zip)$/i;

function looksLikeZip(buf: Uint8Array): boolean {
    if (buf.length < 4) return false;
    return ZIP_MAGIC.every((b, i) => buf[i] === b);
}

/** Replace path separators and other chars unsafe in a VFS directory name. */
function sanitizePackageName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

/** Strip extension, sanitize for use as a directory name. */
function packageNameFromFile(filename: string): string {
    const base = filename.replace(/\.(mpackage|zip|xml)$/i, '');
    return sanitizePackageName(base) || 'package';
}

function isXmlEntry(path: string): boolean {
    return /\.xml$/i.test(path);
}

const TEXT_EXT = /\.(xml|lua|txt|json|md|css|html|htm|js|csv|ini|cfg|conf|yml|yaml)$/i;
function isTextEntry(path: string): boolean {
    return TEXT_EXT.test(path);
}

/**
 * Validate and unpack a Mudlet package from in-memory bytes without writing
 * anything — the returned `commit()` performs every filesystem change.
 * Synchronous: the caller is expected to flush the VFS afterwards (or let the
 * next idle flush handle it).
 *
 * Behaviour by kind:
 * - .mpackage / .zip : always unzipped into <profilePath>/<packageName>/. The full payload
 *                      is preserved so resources (images, sounds, lua modules) remain
 *                      available to scripts via the VFS, regardless of `kind`.
 * - .xml as 'package': parse only — no files written. Nodes live in the app store.
 * - .xml as 'module' : the XML is also written to <profilePath>/<packageName>/<filename>;
 *                      the on-disk file is treated as the source of truth, so it must exist
 *                      to be re-parsed on profile open.
 *
 * The XML is parsed in package-mode, which wraps each category in a top-level
 * group and tags every node with the package name, making uninstall a tag-based cascade.
 */
export function preparePackageInstall(
    filename: string,
    buf: Uint8Array,
    vfs: ProfileVFS,
    opts: InstallOptions = {},
): PreparedInstall {
    const kind: PackageKind = opts.kind ?? 'package';
    // Provisional: an archive's config.lua may rename the package out from under
    // us, exactly as it does in Mudlet — see the rename below.
    let packageName = packageNameFromFile(filename);
    let pkgDir = `${vfs.profilePath}/${packageName}`;
    let sourcePath = opts.sourcePath;

    // Where a staging caller put the package's contents: always the filename's
    // directory, because that is the only name it could know before config.lua
    // is read. A config.lua rename retargets `pkgDir` below, and the commit
    // moves the staged directory to match.
    const stagedDir = pkgDir;
    // Whether the commit may wipe a previous install of the same name. It may
    // not when the source file is staged inside that directory — the caller
    // pre-positioned the package's contents there, and the wipe would destroy
    // what we're about to install.
    const sourceInsidePkgDir = !!sourcePath
        && (sourcePath === stagedDir || sourcePath.startsWith(`${stagedDir}/`));

    let xmlContent: string;
    let xmlRelPath: string | undefined;
    let manifestExtras: Partial<PackageManifest> = {};
    /** The unpacked archive, held in memory until commit. Null for a plain XML. */
    let entries: Record<string, Uint8Array> | null = null;

    // The extension decides, as it does in Mudlet: a .mpackage/.zip is unpacked,
    // and anything else is read as a plain package XML. Sniffing the bytes
    // instead meant a .mpackage that was not a zip quietly fell through to the
    // XML reader and failed with a parse error about markup the caller never
    // wrote — where Mudlet says the one thing that is actually true of it.
    if (archiveExtension.test(filename)) {
        if (!looksLikeZip(buf)) throw new Error('could not unzip package');

        try { entries = unzipSync(buf); }
        catch { throw new Error('could not unzip package'); }
        // Pick the first .xml at any depth — Mudlet places it at the root of the archive.
        const xmlEntry = Object.keys(entries).find(isXmlEntry);
        // Mudlet's wording: an archive that unpacked fine but held nothing it could
        // install is a different complaint from one that would not unpack.
        if (!xmlEntry) throw new Error(`no package found in ${filename}`);
        xmlContent = strFromU8(entries[xmlEntry]);
        xmlRelPath = xmlEntry;

        manifestExtras = readConfigLua(entries);

        // A config.lua may declare a name of its own ("mpackage"), and that name —
        // not the archive's filename — is what the package is installed as. This is
        // how something published as `mypkg-2.1.3.mpackage` presents itself as
        // `mypkg`. Mudlet unpacks under the filename, reads config.lua, then
        // physically renames the folder before importing the XML, so the folder,
        // the node tags and the installed-package list all agree
        // (src/Host.cpp:2130-2150 `Host::installPackage`).
        //
        // We used to only put the declared name in the manifest and leave the
        // directory and every node's packageName tag on the filename. Uninstall
        // looks both of those up by manifest.name, so it stripped nothing at all
        // and the package kept running; a reinstall from a differently named file
        // left the first copy live alongside the second.
        //
        // Nothing is on disk yet at this point, so unlike desktop there is no
        // folder to rename in the ordinary case — the commit simply writes under
        // the declared name. Only a *staged* install has files already sitting
        // under the filename's directory, and the commit moves those.
        const declared = sanitizePackageName(manifestExtras.name ?? '');
        if (declared && declared !== packageName) {
            packageName = declared;
            pkgDir = `${vfs.profilePath}/${declared}`;
            // A staged source file moves with its directory; the manifest must
            // record where it will actually be once the commit has run.
            if (sourceInsidePkgDir && sourcePath) sourcePath = pkgDir + sourcePath.slice(stagedDir.length);
        }
    } else {
        xmlContent = strFromU8(buf);
        // Modules need an on-disk XML to reload from on profile open; plain XML
        // packages keep nothing on disk.
        if (kind === 'module') xmlRelPath = filename;
    }

    // Parsed here, not after the files land: an XML that will not parse is
    // refused with the profile untouched rather than unpacked and then rejected.
    const data = parseMudletXml(xmlContent, { packageName });

    const manifest: PackageManifest = {
        ...manifestExtras,
        // Last word, deliberately: `packageName` already *is* the config.lua name
        // when there was one, sanitized for use as a directory, and it is what the
        // directory and every node tag now carry. Letting the raw declared value
        // through here is what let the manifest disagree with both.
        name: packageName,
        ...(xmlRelPath ? { xmlPath: xmlRelPath } : {}),
        sourceFile: filename,
        ...(sourcePath ? { sourcePath } : {}),
        installedAt: new Date().toISOString(),
        ...(kind === 'module' ? { kind: 'module' as const, sync: false } : {}),
    };

    const commit = (): void => {
        // Wipe any previous install of the same package (re-install is a clean
        // slate). Reached only once the install is certain to go through.
        if (!sourceInsidePkgDir && vfs.exists(pkgDir)) vfs.rmdir(pkgDir);
        else if (sourceInsidePkgDir && pkgDir !== stagedDir) {
            // A staged install that config.lua renamed: the contents are under
            // the filename's directory and belong under the declared one. The
            // destination is cleared first, or the rename would fail (or merge)
            // against a previous install's directory.
            if (vfs.exists(pkgDir)) vfs.rmdir(pkgDir);
            vfs.rename(stagedDir, pkgDir);
        }

        if (!entries) {
            if (kind === 'module') {
                vfs.mkdir(pkgDir);
                vfs.writeFile(`${pkgDir}/${filename}`, xmlContent);
            }
            return;
        }

        vfs.mkdir(pkgDir);
        try {
            // Write every entry to VFS preserving the archive's directory layout.
            for (const [path, bytes] of Object.entries(entries)) {
                // Skip the directory placeholders that some zippers emit.
                if (path.endsWith('/')) {
                    vfs.mkdir(`${pkgDir}/${path}`);
                    continue;
                }
                const dest = `${pkgDir}/${path}`;
                const parent = dest.substring(0, dest.lastIndexOf('/'));
                if (parent && !vfs.exists(parent)) vfs.mkdir(parent);
                if (isTextEntry(path)) vfs.writeFile(dest, strFromU8(bytes));
                else                   vfs.writeBinaryFile(dest, bytes);
            }
        } catch (err) {
            // A write that fails partway — quota, a backend that went away —
            // would otherwise leave a half-unpacked directory standing in for a
            // package that never installed, and `getMudletHomeDir()/<name>`
            // existing is how scripts (and the uninstaller) decide a package
            // has files.
            if (!sourceInsidePkgDir) { try { vfs.rmdir(pkgDir); } catch { /* nothing to undo */ } }
            throw err;
        }
    };

    return { manifest, data, commit };
}

/**
 * Prepare and immediately commit — equivalent to `preparePackageInstall(...)`
 * followed by `commit()`, for callers with nothing to decide in between.
 */
export function installPackageFromBytes(
    filename: string,
    buf: Uint8Array,
    vfs: ProfileVFS,
    opts: InstallOptions = {},
): InstallResult {
    const { manifest, data, commit } = preparePackageInstall(filename, buf, vfs, opts);
    commit();
    return { manifest, data };
}

/** Async wrapper that reads from a File and flushes the VFS to disk on success. */
export async function installPackageFromFile(file: File, vfs: ProfileVFS, opts: InstallOptions = {}): Promise<InstallResult> {
    const buf = new Uint8Array(await file.arrayBuffer());
    const result = installPackageFromBytes(file.name, buf, vfs, opts);
    await vfs.flush();
    return result;
}

/**
 * {@link preparePackageInstall} over a `File`, for a caller that has to decide
 * whether to go through with the install *after* seeing the name it would land
 * under — which `config.lua` can rename to anything, so the file's own name
 * settles nothing. Nothing is written until `commit()`; flushing the VFS
 * afterwards is the caller's, as with every other prepare.
 */
export async function preparePackageInstallFromFile(
    file: File,
    vfs: ProfileVFS,
    opts: InstallOptions = {},
): Promise<PreparedInstall> {
    return preparePackageInstall(file.name, new Uint8Array(await file.arrayBuffer()), vfs, opts);
}

/**
 * Parse a Lua string literal beginning at `start` in `text`. Supports:
 *   - "..." / '...'   with simple backslash escapes
 *   - [[ ... ]] and [=*[ ... ]=*]  long-bracket strings (multi-line)
 *
 * Returns the unquoted value and the index just past the closing delimiter,
 * or null if the position doesn't begin a recognizable string literal.
 */
function parseLuaString(text: string, start: number): { value: string; end: number } | null {
    let i = start;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    if (i >= text.length) return null;

    const ch = text[i];
    if (ch === '"' || ch === "'") {
        let j = i + 1;
        let out = '';
        while (j < text.length && text[j] !== ch) {
            if (text[j] === '\\' && j + 1 < text.length) {
                const esc = text[j + 1];
                out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
                j += 2;
            } else {
                out += text[j];
                j++;
            }
        }
        return { value: out, end: j + 1 };
    }

    if (ch === '[') {
        // [=*[ … ]=*]
        let j = i + 1;
        let level = 0;
        while (text[j] === '=') { level++; j++; }
        if (text[j] !== '[') return null;
        j++;
        // Lua spec: a leading newline immediately after the opener is stripped.
        if (text[j] === '\r' && text[j + 1] === '\n') j += 2;
        else if (text[j] === '\n' || text[j] === '\r') j++;
        const closer = ']' + '='.repeat(level) + ']';
        const end = text.indexOf(closer, j);
        if (end < 0) return null;
        return { value: text.slice(j, end), end: end + closer.length };
    }

    return null;
}

/** Best-effort parse of Mudlet's config.lua for manifest metadata. */
function readConfigLua(entries: Record<string, Uint8Array>): Partial<PackageManifest> {
    const cfgKey = Object.keys(entries).find(k => /(?:^|\/)config\.lua$/i.test(k));
    if (!cfgKey) return {};
    const out: Partial<PackageManifest> = {};
    // Kept verbatim alongside the mapped fields, because getPackageInfo answers
    // with what config.lua declared and nothing else — not the name we derived,
    // not when we installed it. A package without a config.lua therefore has no
    // info at all, which is exactly what Mudlet reports for one.
    const declared: Record<string, string> = {};
    const text = strFromU8(entries[cfgKey]);

    const keyRe = /^[ \t]*(\w+)[ \t]*=[ \t]*/gm;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(text)) !== null) {
        const parsed = parseLuaString(text, keyRe.lastIndex);
        if (!parsed) continue;
        keyRe.lastIndex = parsed.end;

        const key = m[1].toLowerCase();
        const val = parsed.value;
        declared[key] = val;
        if      (key === 'mpackage' || key === 'name' || key === 'package') out.name = val || out.name;
        else if (key === 'version')                                         out.version = val;
        else if (key === 'author')                                          out.author = val;
        else if (key === 'title')                                           out.title = val;
        else if (key === 'description')                                     out.description = val;
        else if (key === 'icon')                                            out.icon = val;
        else if (key === 'created')                                         out.created = val;
    }
    if (Object.keys(declared).length) out.declaredInfo = declared;
    return out;
}

/**
 * Remove a package's on-disk files. The store handles tag-based node removal
 * separately. Modules are exempt: they unlink only — the underlying XML (and any
 * unzipped resources) survive uninstall so the user's source files aren't
 * silently destroyed when they remove the module from the app.
 */
export async function uninstallPackageFiles(manifest: PackageManifest, vfs: ProfileVFS): Promise<void> {
    // A module installed from a file the user chose keeps that file: `xmlVfsPath`
    // means it is referenced where it lies, and deleting it would destroy the
    // user's own source because they removed the module from the app. A module
    // installed from an archive is different — the directory is ours, unpacked
    // by the install, and Mudlet takes it away again. Blanket-exempting every
    // module (as this did) left those directories behind for good: nothing else
    // ever removes them, and a later install of the same name then found a
    // folder for a module that was not installed.
    if (manifest.kind === 'module' && manifest.xmlVfsPath) return;
    const pkgDir = `${vfs.profilePath}/${manifest.name}`;
    if (vfs.exists(pkgDir)) vfs.rmdir(pkgDir);
    await vfs.flush();
}

/**
 * Resolve the absolute VFS path of a module's XML file. Honors `xmlVfsPath` (in-place
 * modules) first, then falls back to the managed `<profilePath>/<name>/<xmlPath>` layout.
 * Returns null if neither is set.
 */
export function moduleXmlAbsolutePath(manifest: PackageManifest, vfs: ProfileVFS): string | null {
    if (manifest.xmlVfsPath) return manifest.xmlVfsPath;
    if (manifest.xmlPath)    return `${vfs.profilePath}/${manifest.name}/${manifest.xmlPath}`;
    return null;
}

/**
 * Re-read a module's XML from the VFS and return the parsed result.
 * Throws if the on-disk file is missing — modules require their XML to be present.
 */
export function reloadModuleFromVfs(manifest: PackageManifest, vfs: ProfileVFS): MudletImportResult {
    const path = moduleXmlAbsolutePath(manifest, vfs);
    if (!path) throw new Error(`Module "${manifest.name}" has no xmlPath; cannot reload from disk`);
    if (!vfs.exists(path)) throw new Error(`Module "${manifest.name}" XML not found at ${path}`);
    const xmlContent = vfs.readFile(path);
    return parseMudletXml(xmlContent, { packageName: manifest.name });
}

/**
 * Prepare a module install from a path that already lives inside the profile's
 * VFS. Nothing is written until the returned `commit()` runs.
 *
 * - Plain XML : referenced in place. The manifest stores `xmlVfsPath` and no pkgDir is
 *               created. Reload and sync read/write the user-chosen path verbatim, so
 *               external tools (a synced folder, an editor) can keep editing it.
 * - .mpackage / .zip : same flow as a normal module install — extracted into a fresh
 *               pkgDir so resources are accessible. The original archive on disk is
 *               left untouched but is no longer referenced by the module.
 *
 * Throws on read/parse failures.
 */
export function prepareModuleInstallFromVfsPath(
    absolutePath: string,
    vfs: ProfileVFS,
    /** Consulted first, so a module under the read-only /lua/ namespace installs
     *  as readily as one in the profile — see LuaRuntime.readBuiltinBytes. */
    readBuiltin: (path: string) => Uint8Array | null = () => null,
): PreparedInstall {
    if (!absolutePath) throw new Error('no package file was actually given');
    const builtin = readBuiltin(absolutePath);
    // Mudlet's wording (Host::installPackage), which verboseModuleInstall prints
    // verbatim — ours said "File not found", which is the same fact in a shape
    // no script matching on Mudlet's text would recognise.
    if (!builtin && !vfs.exists(absolutePath)) throw new Error(`could not open file '${absolutePath}`);
    const filename = absolutePath.substring(absolutePath.lastIndexOf('/') + 1) || 'module';
    const buf = builtin ?? vfs.readBinaryFile(absolutePath);

    if (archiveExtension.test(filename)) {
        if (!looksLikeZip(buf)) throw new Error('could not unzip package');
        // Zips always go through the unzip-into-pkgDir flow; the user's source archive
        // stays where it was but isn't part of the module's reload path.
        return preparePackageInstall(filename, buf, vfs, { kind: 'module', sourcePath: absolutePath });
    }

    // Plain XML: reference in place, no pkgDir.
    const xmlContent = strFromU8(buf);
    const packageName = packageNameFromFile(filename);
    const data = parseMudletXml(xmlContent, { packageName });

    const manifest: PackageManifest = {
        name: packageName,
        xmlVfsPath: absolutePath,
        sourceFile: filename,
        installedAt: new Date().toISOString(),
        kind: 'module',
        sync: false,
    };
    // An in-place module is referenced where it lies, so there is nothing to
    // write and nothing a refusal could have destroyed.
    return { manifest, data, commit: () => {} };
}

/**
 * Prepare and immediately commit — equivalent to
 * `prepareModuleInstallFromVfsPath(...)` followed by `commit()`.
 */
export function installModuleFromVfsPath(
    absolutePath: string,
    vfs: ProfileVFS,
    readBuiltin: (path: string) => Uint8Array | null = () => null,
): InstallResult {
    const { manifest, data, commit } = prepareModuleInstallFromVfsPath(absolutePath, vfs, readBuiltin);
    commit();
    return { manifest, data };
}
