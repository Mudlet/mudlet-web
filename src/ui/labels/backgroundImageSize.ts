// Resolves the "native" pixel size Qt would use for a label's background
// image, so LabelOverlay can render it unscaled like Mudlet's
// `QLabel::setPixmap()` (see setBackgroundImage in ScriptingAPI) instead of
// letting the browser stretch it to fill the label.
//
// Raster formats (PNG/JPEG/GIF/...) already have real intrinsic dimensions
// that CSS `background-size: auto` renders natively — no fix needed there.
// SVGs without a `width`/`height` attribute have *no* CSS intrinsic size, so
// a bare `background-image` gets scaled to cover the label, which Qt never
// does: `QSvgRenderer::defaultSize()` falls back to the `viewBox` extent and
// `QPixmap` loads at exactly that pixel size, clipped by the label like any
// oversized pixmap. This only resolves that SVG case; other formats resolve
// to null and the caller leaves `background-size` alone.
export async function resolveSvgIntrinsicSize(url: string): Promise<{ width: number; height: number } | null> {
    if (!isSvgUrl(url)) return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return parseSvgIntrinsicSize(await res.text());
    } catch {
        return null;
    }
}

export function isSvgUrl(url: string): boolean {
    if (url.startsWith('data:')) return /^data:image\/svg\+xml/i.test(url);
    // Strip query/hash before checking the extension (e.g. `?v=2`).
    return /\.svg(?:[?#]|$)/i.test(url);
}

/** Exported for tests. Mirrors Qt's defaultSize(): explicit width+height
 *  wins, else the viewBox extent, else no intrinsic size (null). */
export function parseSvgIntrinsicSize(svgText: string): { width: number; height: number } | null {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null;

    const w = parseSvgLength(svg.getAttribute('width'));
    const h = parseSvgLength(svg.getAttribute('height'));
    if (w !== null && h !== null) return { width: w, height: h };

    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
            return { width: parts[2], height: parts[3] };
        }
    }
    return null;
}

function parseSvgLength(v: string | null): number | null {
    if (!v || v.endsWith('%')) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether `bytes` are worth handing to an SVG parser, the way TLabel::svgCandidate
 * decides it: gzip magic, or the first character past any byte order mark and
 * whitespace being `<`. Mudlet reads a file by its content rather than its
 * name, so a raster saved as `.svg` is still a raster, and an SVG under any
 * name is still an SVG. The parser is the authority on what really is one.
 */
export function isSvgCandidate(bytes: Uint8Array): boolean {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
    let at = 0;
    let utf16 = false;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;
    else if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
        at = 2;
        utf16 = true;
    }
    for (const end = Math.min(bytes.length, 64); at < end; at++) {
        const byte = bytes[at];
        // In UTF-16 every ASCII character is half of a code unit whose other
        // half is a NUL, whichever way round the byte order mark put them.
        if (utf16 && byte === 0) continue;
        if (byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)) continue;
        return byte === 0x3c; // '<'
    }
    return false;
}

/**
 * The document size of an SVG held in `bytes`, synchronously — or null when it
 * is not an SVG the browser can parse, or has no size to offer (no width,
 * height or viewBox). Gzipped documents are not inflated here; they resolve
 * through {@link resolveSvgIntrinsicSize} like a remote URL does.
 */
export function svgIntrinsicSizeFromBytes(bytes: Uint8Array): { width: number; height: number } | null {
    if (!isSvgCandidate(bytes) || bytes[0] === 0x1f) return null;
    try {
        const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
        const text = new TextDecoder(utf16 ? (bytes[0] === 0xff ? 'utf-16le' : 'utf-16be') : 'utf-8').decode(bytes);
        return parseSvgIntrinsicSize(text);
    } catch {
        return null;
    }
}
