import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import type { OutputFontSource } from '../storage';

const PROBE_TEXT = 'mwijMWIJ0123!@#';
const PROBE_FALLBACKS = ['monospace', 'serif', 'sans-serif'] as const;
const PROBE_FONT_SIZE_PX = 72;

function quoteFamily(family: string): string {
    return `"${family.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * Bumped every time a family becomes usable that wasn't before — a profile
 * font materialised out of the VFS, a `@font-face` stylesheet finishing, a
 * package installing its own font.
 *
 * Anything that *measures* a font has to cache (canvas metrics are hot enough
 * that Geyser's per-constraint layout would otherwise dominate a reflow), and a
 * measurement taken before the family exists silently answers for a fallback:
 * "Fira Code Willowdale" at 11pt measured 8.83px against Bitstream Vera Sans
 * Mono, then 9.02px once the real face arrived. Cached under a plain
 * family+size key that first answer never expires, and every script that turns
 * a cell width into a column count (`math.floor(width / cellW)`) is wrong for
 * the life of the page. Cache under this generation instead and a stale
 * measurement can only survive until the font that invalidates it loads.
 */
let fontGeneration = 0;

/** Cache-key component for anything that memoises a font measurement. */
export function getFontGeneration(): number {
    return fontGeneration;
}

/** Note that a family became usable — see `getFontGeneration`. */
export function bumpFontGeneration(): void {
    fontGeneration++;
}

// `loadingdone` covers the faces we never register by hand: `@font-face` rules
// in a profile stylesheet, and anything a package's CSS pulls in.
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
    document.fonts.addEventListener('loadingdone', bumpFontGeneration);
}

/**
 * DOM offsetWidth probe: render the same text once with each of three generic
 * fallbacks and once with the candidate family prepended; if any pair diverges,
 * the candidate is being applied. We probe all three generics because a
 * monospace target often coincides with the monospace fallback width while
 * still differing from serif/sans-serif. Note: document.fonts.check() is NOT
 * usable here — Chrome returns true for any well-formed family because a
 * fallback always completes rendering, so it can't distinguish installed
 * from missing.
 */
function checkViaDomMeasurement(family: string): boolean {
    if (typeof document === 'undefined' || !document.body) return false;
    const probe = document.createElement('span');
    probe.textContent = PROBE_TEXT;
    probe.style.cssText =
        `position:absolute;left:-9999px;top:-9999px;visibility:hidden;` +
        `white-space:nowrap;font-size:${PROBE_FONT_SIZE_PX}px;line-height:1;`;
    document.body.appendChild(probe);
    try {
        return PROBE_FALLBACKS.some(fb => {
            probe.style.fontFamily = fb;
            const baseline = probe.offsetWidth;
            probe.style.fontFamily = `${quoteFamily(family)}, ${fb}`;
            return probe.offsetWidth !== baseline;
        });
    } finally {
        probe.remove();
    }
}

/** Synchronous detection. May false-negative on a system font whose face the
 *  browser hasn't materialized yet — use {@link ensureFontAvailable} when an
 *  await is acceptable. */
export function isFontAvailable(family: string): boolean {
    const trimmed = family.trim();
    if (!trimmed) return false;
    return checkViaDomMeasurement(trimmed);
}

/** Async variant: nudges the browser via document.fonts.load() first (this
 *  causes Chrome to materialize an installed system face into the FontFaceSet
 *  so subsequent measurements can see it), then measures via the DOM probe. */
export async function ensureFontAvailable(family: string): Promise<boolean> {
    const trimmed = family.trim();
    if (!trimmed) return false;
    try {
        await document.fonts?.load?.(`${PROBE_FONT_SIZE_PX}px ${quoteFamily(trimmed)}`);
    } catch {
        // ignore — DOM measurement may still succeed for installed fonts
    }
    return checkViaDomMeasurement(trimmed);
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

export interface FontProbeRow {
    fallback: string;
    baselineWidth: number;
    candidateWidth: number;
    diverges: boolean;
}

export interface FontProbeReport {
    family: string;
    text: string;
    fontSizePx: number;
    rows: FontProbeRow[];
    available: boolean;
    fontsCheckSays: boolean;
    fontsLoadFaces: number;
    fontFamiliesInSet: number;
}

/** Run the probe and return raw measurements for debugging the detector. */
export async function diagnoseFontProbe(family: string): Promise<FontProbeReport> {
    const trimmed = family.trim();
    const report: FontProbeReport = {
        family: trimmed,
        text: PROBE_TEXT,
        fontSizePx: PROBE_FONT_SIZE_PX,
        rows: [],
        available: false,
        fontsCheckSays: false,
        fontsLoadFaces: 0,
        fontFamiliesInSet: 0,
    };
    if (!trimmed || typeof document === 'undefined' || !document.body) return report;

    const specifier = `${PROBE_FONT_SIZE_PX}px ${quoteFamily(trimmed)}`;
    try {
        const faces = await document.fonts?.load?.(specifier);
        report.fontsLoadFaces = faces?.length ?? 0;
    } catch {
        // ignore
    }
    try {
        report.fontsCheckSays = document.fonts?.check?.(specifier);
    } catch {
        // ignore
    }
    try {
        report.fontFamiliesInSet = document.fonts ? Array.from(document.fonts).length : 0;
    } catch {
        // ignore
    }

    const probe = document.createElement('span');
    probe.textContent = PROBE_TEXT;
    probe.style.cssText =
        `position:absolute;left:-9999px;top:-9999px;visibility:hidden;` +
        `white-space:nowrap;font-size:${PROBE_FONT_SIZE_PX}px;line-height:1;`;
    document.body.appendChild(probe);
    try {
        for (const fb of PROBE_FALLBACKS) {
            probe.style.fontFamily = fb;
            const baseline = probe.offsetWidth;
            probe.style.fontFamily = `${quoteFamily(trimmed)}, ${fb}`;
            const candidate = probe.offsetWidth;
            report.rows.push({
                fallback: fb,
                baselineWidth: baseline,
                candidateWidth: candidate,
                diverges: candidate !== baseline,
            });
        }
    } finally {
        probe.remove();
    }
    report.available = report.rows.some(r => r.diverges);
    return report;
}

export interface LocalFontEntry {
    family: string;
    fullName: string;
    postscriptName: string;
    style?: string;
}

type QueryLocalFontsFn = () => Promise<LocalFontEntry[]>;

function getQueryLocalFonts(): QueryLocalFontsFn | null {
    const fn = (window as unknown as { queryLocalFonts?: QueryLocalFontsFn }).queryLocalFonts;
    return typeof fn === 'function' ? fn.bind(window) : null;
}

export function isLocalFontApiSupported(): boolean {
    return getQueryLocalFonts() !== null;
}

export async function queryLocalFonts(): Promise<LocalFontEntry[]> {
    const fn = getQueryLocalFonts();
    if (!fn) throw new Error('Local Font Access API not available in this browser.');
    return fn();
}

// ── System-font cache (for sync APIs like Mudlet getAvailableFonts) ─────────
// queryLocalFonts() is async and the first call requires a user gesture, so
// scripting APIs that need the list synchronously read this cache. It's
// populated lazily — primeLocalFontsCache() runs the silent permission check
// and only queries when permission is already granted (never prompts). The
// FontPicker also writes through here when the user lists fonts explicitly.

const UNIVERSAL_FONT_DEFAULTS: readonly string[] = [
    'monospace', 'serif', 'sans-serif',
    // Bundled with the app (App.css @font-face) — always available, unlike the
    // rest of this list which just guesses at what the host OS ships.
    'Bitstream Vera Sans Mono', 'Ubuntu', 'Ubuntu Mono',
    'Consolas', 'Courier New', 'Menlo', 'Monaco', 'DejaVu Sans Mono', 'Cascadia Code',
    'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma',
];

let localFontsCache: string[] | null = null;
let localFontsPrimePromise: Promise<void> | null = null;

/** The family consoles actually render in when the profile sets none — the
 *  bundled face App.css applies (picked to match Mudlet's default look). Mudlet
 *  always reports a concrete family from getFont, never an empty string, and
 *  UI_spec checks that what comes back is a real name. */
export const DEFAULT_OUTPUT_FONT_FAMILY = 'Bitstream Vera Sans Mono';

export function getUniversalDefaultFonts(): readonly string[] {
    return UNIVERSAL_FONT_DEFAULTS;
}

export function getCachedLocalFonts(): string[] {
    return localFontsCache ?? [];
}

export function setLocalFontsCache(families: Iterable<string>): void {
    localFontsCache = [...new Set(families)];
}

/** Fire-and-forget. If Local Font Access is supported AND permission was
 *  previously granted, query installed fonts and cache the family list.
 *  Never prompts the user. Idempotent: subsequent calls before the first
 *  resolves piggy-back on the in-flight promise. */
export function primeLocalFontsCache(): Promise<void> {
    if (localFontsCache !== null) return Promise.resolve();
    if (localFontsPrimePromise) return localFontsPrimePromise;
    if (!isLocalFontApiSupported()) return Promise.resolve();
    const perms = (navigator as Navigator & {
        permissions?: { query: (d: { name: string }) => Promise<PermissionStatus> };
    }).permissions;
    if (!perms?.query) return Promise.resolve();
    localFontsPrimePromise = perms.query({ name: 'local-fonts' as PermissionName })
        .then(async status => {
            if (status.state !== 'granted') return;
            try {
                const fonts = await queryLocalFonts();
                const set = new Set<string>();
                for (const f of fonts) set.add(f.family);
                localFontsCache = [...set];
            } catch {
                // ignore — silent failure is fine for a cache prime
            }
        })
        .catch(() => undefined)
        .finally(() => { localFontsPrimePromise = null; });
    return localFontsPrimePromise;
}

/** Families currently registered in document.fonts — URL stylesheets and
 *  FontFace-API uploads (the kind loaded by loadFontFromUrl / loadFontFromVfs)
 *  show up here once the browser has materialized the face. Quoted-string
 *  forms ("Family Name") are unwrapped to plain names. */
export function getRegisteredFontFamilies(): string[] {
    if (typeof document === 'undefined' || !document.fonts) return [];
    const out = new Set<string>();
    try {
        for (const face of document.fonts) {
            const fam = face.family?.replace(/^['"]|['"]$/g, '');
            if (fam) out.add(fam);
        }
    } catch {
        // FontFaceSet iteration unsupported — return whatever we have.
    }
    return [...out];
}

const LINK_DATA_ATTR = 'mudixFontUrl';

function ensureStylesheet(url: string): HTMLLinkElement {
    const existing = document.querySelector<HTMLLinkElement>(
        `link[data-${LINK_DATA_ATTR.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}="${url}"]`,
    );
    if (existing) return existing;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset[LINK_DATA_ATTR] = url;
    document.head.appendChild(link);
    return link;
}

export async function loadFontFromUrl(family: string, url: string): Promise<void> {
    ensureStylesheet(url);
    try {
        await document.fonts.load(`16px ${quoteFamily(family)}`);
    } catch {
        // Stylesheet may still be loading; the canvas check will surface failures.
    }
    bumpFontGeneration();
}

const loadedVfsKeys = new Set<string>();

function vfsKey(family: string, vfs: ProfileVFS, path: string): string {
    return `${vfs.profilePath}::${path}::${family}`;
}

export async function loadFontFromVfs(family: string, path: string, vfs: ProfileVFS): Promise<void> {
    const key = vfsKey(family, vfs, path);
    if (loadedVfsKeys.has(key)) return;
    const raw = vfs.readBinaryFile(path);
    // Defensive copy: ZenFS may return a Buffer view with non-zero byteOffset.
    const bytes = new Uint8Array(raw.byteLength);
    bytes.set(raw);
    const face = new FontFace(family, bytes);
    await face.load();
    document.fonts.add(face);
    loadedVfsKeys.add(key);
    bumpFontGeneration();
}

const OUTPUT_FONT_VAR = '--font-output';

export async function applyOutputFont(
    font: OutputFontSource | undefined,
    vfs: ProfileVFS | null,
): Promise<void> {
    if (!font || !font.family.trim()) {
        document.documentElement.style.removeProperty(OUTPUT_FONT_VAR);
        return;
    }
    try {
        if (font.kind === 'url') {
            await loadFontFromUrl(font.family, font.url);
        } else if (font.kind === 'vfs' && vfs) {
            await loadFontFromVfs(font.family, font.path, vfs);
        }
    } catch (e) {
        console.error('[fontLoader] failed to register font', font, e);
    }
    document.documentElement.style.setProperty(OUTPUT_FONT_VAR, quoteFamily(font.family));
}
