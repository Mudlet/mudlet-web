// Mudlet's Qt resource namespace (`:/…`), as much of it as makes sense here.
//
// Desktop Mudlet compiles ~244 files into the binary via `src/mudlet.qrc` and
// scripts reach them with Qt's resource syntax: `setBackgroundImage(label,
// ":/icons/mudlet.png")`, `getImageSize(":/icons/mudlet.png")`, `url(:/…)` in a
// stylesheet. A browser has no equivalent, so those paths used to resolve to
// nothing at all.
//
// This vendors a deliberate subset rather than the whole bundle. `src/icons/` is
// 9.6 MB and is overwhelmingly game logos for Mudlet's connection dialog — mudix
// has its own — so shipping it would cost every user megabytes for artwork the
// app never draws. What is here is what scripts actually reference.
//
// **Adding one is a size decision.** Entries are inlined as data URIs so the
// bytes are available synchronously (getImageSize has no way to await a fetch),
// which means each file lands in the JS bundle at ~4/3 its on-disk size.
//
// Provenance: copied verbatim from Mudlet `src/icons/`, same GPL-2.0-or-later
// licence as the rest of the project. Re-copy from a Mudlet checkout if upstream
// ever redraws them.
import mudletIcon from './icons/mudlet.png?inline';

/** Qt resource path (without the leading `:/`) → data URI. */
const RESOURCES: Record<string, string> = {
    'icons/mudlet.png': mudletIcon,
};

/** Whether `path` uses Qt's resource syntax. Mudlet also accepts the `qrc:///`
 *  URL form for the same bundle. */
export function isQtResourcePath(path: string): boolean {
    return path.startsWith(':/') || path.startsWith('qrc:/');
}

/** Strip the scheme and any leading slashes, leaving the `.qrc` key. */
function resourceKey(path: string): string {
    return path.replace(/^(:|qrc:)\/+/, '');
}

/**
 * A `:/…` path as a URL usable anywhere a browser wants one — an `<img>` src, a
 * CSS `url(...)`, a background image. Null when the resource isn't vendored.
 */
export function qtResourceUrl(path: string): string | null {
    return RESOURCES[resourceKey(path)] ?? null;
}

/**
 * The bytes behind a `:/…` path, decoded synchronously. Null when the resource
 * isn't vendored, or the entry isn't a base64 data URI (which would mean the
 * bundler emitted it as a file instead of inlining it).
 */
export function qtResourceBytes(path: string): Uint8Array | null {
    const uri = qtResourceUrl(path);
    const comma = uri?.indexOf(',') ?? -1;
    if (!uri || comma === -1 || !uri.slice(0, comma).includes(';base64')) return null;
    const binary = atob(uri.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** Every vendored resource path, in Qt form. For diagnostics and tests. */
export function qtResourcePaths(): string[] {
    return Object.keys(RESOURCES).map(k => `:/${k}`);
}
