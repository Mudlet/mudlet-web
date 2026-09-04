// Registering the fonts a package ships.
//
// A package that ships a font is a common way to distribute a mapper or a UI
// that leans on box-drawing or icon glyphs. The files were unpacked correctly
// and then nothing ever registered them with the browser, so the font was
// unusable from the profile that had just installed it: `getAvailableFonts()`
// did not list it, `document.fonts` never grew, and every element asking for
// the family rendered in a fallback face. No error, no warning (issue #103).
//
// Desktop does this in two halves, and the web port needs both:
//
//   * `Host::installPackageFonts` (Host.cpp:3513) walks the unpacked package
//     directory recursively at install time and loads every font it finds.
//   * `Host::refreshPackageFonts` (:3529) re-runs it for every installed
//     package on profile open — browser font registrations, like Qt's, do not
//     survive a restart.
//
// The one thing desktop gets for free and this does not is the family name: Qt
// reads it out of the file, while `new FontFace(family, bytes)` has to be told.
// See `utils/fontFamilyName`.

import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import type { PackageManifest } from '../storage/schema';
import { fontFamilyName, isFontPath } from '../utils/fontFamilyName';
import { loadFontFromVfs } from '../utils/fontLoader';

export interface PackageFontResult {
    /** Families successfully registered, in the order they were found. */
    registered: string[];
    /** One line per font that could not be registered, for the error log. */
    warnings: string[];
}

/** Every font file under `dir`, recursively — desktop's `QDirIterator` with
 *  `QDirIterator::Subdirectories`. */
function fontPathsUnder(vfs: ProfileVFS, dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
        entries = vfs.readdir(dir);
    } catch {
        return out; // not a directory, or unreadable — nothing to register
    }
    for (const entry of entries) {
        const path = `${dir}/${entry}`;
        if (isFontPath(entry)) out.push(path);
        else fontPathsUnder(vfs, path, out);
    }
    return out;
}

/**
 * Register every font shipped inside one installed package.
 *
 * Best-effort per file: a font that will not parse or will not load must not
 * stop the ones beside it, and must not fail the install that is calling this —
 * desktop's `loadFont` likewise reports and carries on. What it must not do is
 * stay silent, which is the whole of issue #103, so each failure comes back as
 * a warning for the caller to surface.
 *
 * Idempotent, because `refreshPackageFonts` re-runs it over packages whose
 * fonts may already be registered: `loadFontFromVfs` keys what it has loaded by
 * profile + path + family and returns early on a repeat.
 */
export async function installPackageFonts(
    manifest: PackageManifest,
    vfs: ProfileVFS,
): Promise<PackageFontResult> {
    const result: PackageFontResult = { registered: [], warnings: [] };
    // A plain-XML package keeps nothing on disk, so it has no directory to walk
    // and cannot be shipping a font.
    const dir = `${vfs.profilePath}/${manifest.name}`;
    if (!vfs.exists(dir)) return result;

    for (const path of fontPathsUnder(vfs, dir)) {
        const shown = path.slice(vfs.profilePath.length + 1);
        let family: string | null;
        try {
            family = fontFamilyName(vfs.readBinaryFile(path));
        } catch (err) {
            result.warnings.push(`could not read the font "${shown}": ${describe(err)}`);
            continue;
        }
        if (!family) {
            // Not an error in the file's own terms — it may be a format with no
            // sfnt wrapper — but there is no name to register it under, and
            // guessing one from the file name would only produce a family
            // nothing asks for.
            result.warnings.push(
                `the font "${shown}" declares no family name, so it could not be registered`);
            continue;
        }
        try {
            await loadFontFromVfs(family, path, vfs);
            result.registered.push(family);
        } catch (err) {
            result.warnings.push(`the font "${shown}" (${family}) could not be loaded: ${describe(err)}`);
        }
    }
    return result;
}

/**
 * Re-register the fonts of every installed package — desktop's
 * `Host::refreshPackageFonts`, called on profile open.
 *
 * Without it a package's font works until the tab is closed and then silently
 * stops, which is a worse bug than never having worked.
 */
export async function refreshPackageFonts(
    manifests: readonly PackageManifest[],
    vfs: ProfileVFS,
): Promise<PackageFontResult> {
    const all: PackageFontResult = { registered: [], warnings: [] };
    for (const manifest of manifests) {
        const one = await installPackageFonts(manifest, vfs);
        all.registered.push(...one.registered);
        all.warnings.push(...one.warnings);
    }
    return all;
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
