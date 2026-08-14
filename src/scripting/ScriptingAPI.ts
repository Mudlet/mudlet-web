import type { MudSession, ScriptLogSource, ShowSentTextMode, BlankLinesBehaviour } from '../mud/MudSession';
import type { AliasEngine } from '../mud/aliases/AliasEngine';
import type { TriggerEngine } from '../mud/triggers/TriggerEngine';
import type { TimerEngine } from '../mud/timers/TimerEngine';
import type { KeyEngine } from '../mud/keybindings/KeyEngine';
import { classifyReservedKey, formatKeyCombo, reservedKeyNote } from '../mud/keybindings/browserReservedKeys';
import { CLIENT_VERSION } from '../version';
import { getBrand } from '../branding';
import type { WindowHandle, WindowOpenOptions } from '../ui/windows/types';
import { MAP_WIDGET_ID, MAPPER_WIDGET_ID } from '../ui/windows/types';
import type { LabelManager, LabelCreateOptions, LabelMouseEvent, LabelWheelEvent } from '../ui/labels/LabelManager';
import { classifyLabelLink } from '../ui/labels/labelLinks';
import { decodeGif, decodeAnimatedImage, sniffDecodableImage, supportsImageDecoder, MoviePlayer } from '../ui/labels/gifMovie';
import { resolveSvgIntrinsicSize } from '../ui/labels/backgroundImageSize';
import type { CommandLineManager } from '../ui/cmdline/CommandLineManager';
import type { ScrollBoxManager } from '../ui/scrollbox/ScrollBoxManager';
import { TextEditManager } from '../ui/textedit/TextEditManager';
import { userWindowQssToScopedCss, cssEscape, rewriteQtSelectors } from '../ui/labels/qtCss';
import { AnsiAwareBuffer, type FormatColor, type FormatStateSnapshot, type FormatHyperlink, type RgbColor } from '../mud/text/FormatState';
import { classifyHyperlinkUri } from '../mud/text/ansiEscapes';
import { extractQuery } from '../mud/text/hyperlinkConfig';
import { OscLinkManager } from '../mud/text/oscLinkManager';
import { openOsc8Menu } from '../ui/output/osc8Menu';
import { namedColorToState, dechoToAnsiFast, cechoToAnsiFast, hechoToAnsiFast } from '../mud/text/colorParsers';
import { colorCodes } from '../mud/text/colors';
import { Console } from '../mud/text/Console';
import { flashTitle } from '../utils/documentTitle';
import { MspParser } from '../mud/protocol';
import { StopwatchManager, localStorageStopwatchStore } from './StopwatchManager';
import { MxpFrameManager } from './MxpFrameManager';
import { getHeldModifiers } from './heldModifiers';
import { useAppStore, selectProfileField, connectionUrl, PROTOCOL_DEFAULTS, MAPPER_DEFAULTS, MAP_INFO_BG_DEFAULT, type BooleanProtocolKey, type MapperSettings, type MapInfoBgColor, type MudConnection } from '../storage';
import {
    getUniversalDefaultFonts,
    getRegisteredFontFamilies,
    getCachedLocalFonts,
    primeLocalFontsCache,
    DEFAULT_OUTPUT_FONT_FAMILY,
} from '../utils/fontLoader';
import { isQtResourcePath, qtResourceUrl } from '../assets/qt-resources';
import { ProfilesPresence } from './profilesPresence';
import { MapStore } from '../map/MapStore';
import { type EngineHost, NULL_ENGINE_HOST } from './EngineHost';
import { findBundledGame } from '../mud/games/bundledGames';

// Mudlet's TChar always carries baked-in fg/bg colors (the rendered pair), so
// getFgColor/getBgColor never return "no color" for in-bounds positions. mudix
// buffer segments are sparse — plain text has no explicit color — so we fall
// back to these defaults, matching the dark-theme values SettingsModal uses
// (App.css :root --text / --bg).
const DEFAULT_FG_RGB: [number, number, number] = [0xd4, 0xd4, 0xd4];
const DEFAULT_BG_RGB: [number, number, number] = [0x09, 0x09, 0x09];

/**
 * The ANSI palette index (0-15) a segment colour corresponds to, or -2 when it
 * has none. Colour triggers compare palette indices — Mudlet keeps the ANSI
 * number on every TChar — but mudix stores SGR 30-37/40-47 as the hex value
 * they render as, so those are resolved back through the same palette here.
 * A 256-colour (38;5;N) segment already carries its index.
 */
function ansiPaletteIndex(color: FormatColor | undefined): number {
    if (!color) return -2;
    if (color.space === 'indexed') return color.index;
    if (color.space !== 'hex') return -2;
    const hex = color.color.toLowerCase();
    const dark = colorCodes.ansi.dark.findIndex(c => c.toLowerCase() === hex);
    if (dark >= 0) return dark;
    const bright = colorCodes.ansi.bright.findIndex(c => c.toLowerCase() === hex);
    return bright >= 0 ? bright + 8 : -2;
}

const HEX_RE = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
function parseHexToRgb(hex: string | undefined): [number, number, number] | null {
    if (!hex) return null;
    const m = HEX_RE.exec(hex);
    if (!m) return null;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** Map an ANSI / xterm color index to its palette hex string. 0..7 are the
 *  normal ANSI colors, 8..15 the bright set (both honor a profile palette
 *  override via colorCodes.ansi), and 16..255 the fixed xterm-256 cube. Returns
 *  null for out-of-range indices. Used by isAnsiFgColor / isAnsiBgColor. */
function ansiIndexToHex(idx: number): string | null {
    const n = Math.floor(Number(idx));
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    if (n < 8) return colorCodes.ansi.dark[n];
    if (n < 16) return colorCodes.ansi.bright[n - 8];
    return colorCodes.xterm[n] ?? null;
}

/** Build a CSS color string from Mudlet-style 0..255 channels (alpha included).
 *  Channels are clamped and rounded; alpha (Mudlet's 0..255 "transparency") is
 *  mapped to CSS's 0..1 range. Used by setCommand{Background,Foreground}Color. */
function rgbaCss(r: number, g: number, b: number, a = 255): string {
    const ch = (n: number) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
    const alpha = Math.max(0, Math.min(1, (Number(a) || 0) / 255));
    return `rgba(${ch(r)}, ${ch(g)}, ${ch(b)}, ${alpha})`;
}

/** Clamp a numeric value to [0, 255] and round. Used by the map colour APIs. */
function clamp255(n: number): number {
    return Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
}

/** Parse the "r,g,b,a" string the Bridge hands `setConfig("mapInfoColor", …)`
 *  (it flattens the Lua table before crossing into JS). Each channel must be a
 *  whole number in 0..255, matching Mudlet's per-channel validation; anything
 *  out of range yields null so setConfig reports failure rather than clamping. */
function parseMapInfoColor(value: unknown): MapInfoBgColor | null {
    const m = String(value ?? '').match(/^(\d+),(\d+),(\d+),(\d+)$/);
    if (!m) return null;
    const ch = m.slice(1, 5).map(Number);
    if (ch.some(n => n < 0 || n > 255)) return null;
    return { r: ch[0], g: ch[1], b: ch[2], a: ch[3] };
}

// ── setConfig / getConfig support ───────────────────────────────────────────
// Coerce a Lua-passed value to a boolean the way Mudlet's setConfig does:
// real booleans pass through; the strings "false"/"0"/"no"/"off" (any case)
// read as false; everything else non-nil is truthy.
function configBool(v: unknown): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return !/^(false|0|no|off)$/i.test(v.trim());
    return !!v;
}

/** Coerce a `setConfig("showSentText", …)` value into a {@link ShowSentTextMode}.
 *  Accepts the three mode strings directly; maps booleans / boolean-ish strings
 *  / numbers to `script` (on) or `never` (off) for backward compatibility with
 *  the original boolean key (Mudlet's "show sent text" toggle ≙ `script`).
 *  Returns null for anything else so `setConfig` reports failure. */
function parseShowSentText(value: unknown): ShowSentTextMode | null {
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'never' || s === 'script' || s === 'always') return s;
        if (/^(true|1|yes|on)$/.test(s)) return 'script';
        if (/^(false|0|no|off)$/.test(s)) return 'never';
        return null;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
        return value ? 'script' : 'never';
    }
    return null;
}

/** Coerce a `setConfig("blankLinesBehaviour", …)` value into a
 *  {@link BlankLinesBehaviour}. Accepts the three mode strings (case-insensitive);
 *  returns null for anything else so `setConfig` reports failure. */
function parseBlankLinesBehaviour(value: unknown): BlankLinesBehaviour | null {
    if (typeof value !== 'string') return null;
    const s = value.trim().toLowerCase();
    return s === 'show' || s === 'hide' || s === 'replacewithspace' ? s : null;
}

/** Divisor between the value `setConfig("mapRoomSize", …)` takes (Mudlet's
 *  preferences spin-box scale, 1..20) and the internal `mRoomSize` fraction of
 *  a grid cell it ends up storing: `dlgMapper::slot_roomSize` does
 *  `setRoomSize(size / 10.0)`. Mudlet's default spinner value is 5 → 0.5. */
const MUDLET_ROOM_SIZE_SCALE = 10;

/** Mudlet config keys persisted in the {@link ProfileSettings.config} bag rather
 *  than a dedicated structured field. Each entry gives the value type and the
 *  default `getConfig` returns before the key has been set, so first reads match
 *  Mudlet-ish values. `enum` constrains string writes (an out-of-range value is
 *  rejected). Most are stored only for round-trip fidelity, but a few drive real
 *  behaviour by being read back out of the bag in the React layer (e.g.
 *  `commandLineHistorySaveSize` in CommandBar, `showTabConnectionIndicators` in
 *  the window title). Keys with live, non-bag side-effects (showSentText,
 *  mapperPanelVisible) are handled explicitly in get/setConfig instead. */
const CONFIG_PERSIST_ONLY: Record<string, {
    type: 'bool' | 'num' | 'str';
    default: boolean | number | string;
    enum?: readonly string[];
}> = {
    // Consumed by ProfileSession (fed into MudSession.setProtocolOptions →
    // TelnetNegotiator's MTTS/NEW-ENVIRON SCREEN_READER reporting) on the next
    // connect — see docs/config-api.md group 2a.
    advertiseScreenReader:          { type: 'bool', default: false },
    ambiguousEAsianWidthCharacters: { type: 'str',  default: 'auto', enum: ['auto', 'wide', 'narrow'] },
    // Default true, matching Mudlet's mAnnounceIncomingText: the off-screen
    // ARIA live region (ScreenReaderLog) mirrors incoming output to the user's
    // screen reader. Gating this on a default-false key would silently mute that
    // path, so it stays on unless the user explicitly disables it.
    announceIncomingText:           { type: 'bool', default: true },
    caretShortcut:                  { type: 'str',  default: 'none', enum: ['none', 'tab', 'ctrltab', 'f6'] },
    commandLineHistorySaveSize:     { type: 'num',  default: 500 },
    compactInputLine:               { type: 'bool', default: false },
    controlCharacterHandling:       { type: 'str',  default: 'asis', enum: ['asis', 'oem', 'picture'] },
    editorAutoComplete:             { type: 'bool', default: true },
    enableBlinkText:                { type: 'bool', default: false },
    enableClosedCaption:            { type: 'bool', default: false },
    f3SearchEnabled:                { type: 'bool', default: false },
    fixUnnecessaryLinebreaks:       { type: 'bool', default: false },
    inputLineStrictUnixEndings:     { type: 'bool', default: false },
    logInHTML:                      { type: 'bool', default: false },
    promptForMXPProcessorOn:        { type: 'bool', default: false },
    promptForVersionInTTYPE:        { type: 'bool', default: false },
    show3dMapView:                  { type: 'bool', default: false },
    showRoomIdsOnMap:               { type: 'bool', default: false },
    showTabConnectionIndicators:    { type: 'bool', default: true },
    showUpperLowerLevels:           { type: 'bool', default: true },
    specialForceGAOff:              { type: 'bool', default: false },
    // False, matching Mudlet's `mVersionInTTYPE` (Host.h): a period is not a
    // legal TTYPE character per RFC 1091, so Mudlet stopped sending the version
    // by default in 2024. The KaVir auto-detect turns it on for the servers that
    // actually want it — see ProfileSession's `kavir.detected` handler.
    versionInTTYPE:                 { type: 'bool', default: false },
    // IRC client settings. mudix has no IRC client (that's a separate service a
    // browser tab can't reach), but the *configuration* is ordinary profile
    // data — Mudlet stores it whether or not the client has ever been opened,
    // and get/setIrcNick and friends read and write exactly this. Defaults are
    // Mudlet's own (dlgIRC.h), so a profile that has never touched IRC still
    // answers with something usable.
    ircNick:                        { type: 'str',  default: 'Mudlet' },
    ircHost:                        { type: 'str',  default: 'irc.libera.chat' },
    ircPort:                        { type: 'num',  default: 6667 },
    ircSecure:                      { type: 'bool', default: false },
    ircPassword:                    { type: 'str',  default: '' },
    /** Space-separated, as Mudlet stores it. */
    ircChannels:                    { type: 'str',  default: '#mudlet' },
};

/** Format an epoch-ms timestamp as Mudlet's "hh:mm:ss.zzz" (local time). */
function formatLineTimestamp(ms: number): string {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function formatColorToRgb(color: FormatColor | undefined): [number, number, number] | null {
    if (!color) return null;
    if (color.space === 'rgb') return [color.r, color.g, color.b];
    if (color.space === 'hex') return parseHexToRgb(color.color);
    if (color.space === 'indexed') return parseHexToRgb(colorCodes.xterm[color.index]);
    return null;
}

/**
 * Returns how many monospace characters fit horizontally inside `el`. Used by
 * getColumnCount when the script hasn't pinned a wrap width with setWindowWrap.
 * The probe is hidden and removed before this returns, so it never appears in
 * the output. Returns 0 if the element is missing or has zero width (e.g. not
 * yet mounted, in a hidden tab).
 */
function measureColumnCapacity(el: HTMLElement | null): number {
    if (!el) return 0;
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit;letter-spacing:inherit;';
    el.appendChild(probe);
    const charWidth = probe.getBoundingClientRect().width / 100;
    probe.remove();
    if (charWidth <= 0) return 0;
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const width = Math.max(0, el.clientWidth - pad);
    return Math.floor(width / charWidth);
}

// Default monospace stack used by the output panels — mirrors --font-mono in
// App.css. Used as the fallback family when the profile has no outputFont set.
const DEFAULT_MONO_STACK = `'Bitstream Vera Sans Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace`;

// Mudlet's getMousePosition() returns the cursor position relative to the
// main console widget. There's no equivalent of QCursor::pos() on the web —
// the browser only exposes the cursor through events — so we passively track
// the last-known viewport-relative position and transform it into main-output
// coordinates on read. Initialised to NaN so getMousePosition can return 0,0
// before any pointer activity (matching Mudlet's "you've never moved" feel
// rather than reporting a stale pre-load position).
let lastPointerClientX = Number.NaN;
let lastPointerClientY = Number.NaN;
if (typeof document !== 'undefined') {
    const track = (e: PointerEvent | MouseEvent) => {
        lastPointerClientX = e.clientX;
        lastPointerClientY = e.clientY;
    };
    document.addEventListener('pointermove', track, { passive: true, capture: true });
    document.addEventListener('mousedown',   track, { passive: true, capture: true });
}

/**
 * Measures the pixel size of an average character cell for `family` at `size`
 * points. Backs Mudlet's `calcFontSize(...)` — scripts use the returned (w, h)
 * to pre-size miniconsoles for a column/row count. Font sizes are Qt point
 * sizes everywhere in the Mudlet API, and mudix renders them as CSS `pt`
 * (StickyOutputPanel), so the cell is measured at the CSS-px equivalent
 * (1pt = 4/3 px at 96dpi) to match both Mudlet's QFontMetrics numbers and what
 * the DOM actually paints. The width is measured via a canvas 2D context
 * (monospace fonts have a uniform advance, so any glyph works); height uses
 * the font bounding box ascent+descent when available, falling back to 1.2x
 * size which matches the line-height Qt's QFontMetrics reports for common
 * fonts.
 */
// Geyser calls calcFontSize on the per-constraint path (character-unit
// constraints), so a single re-layout of a large widget tree can reach it
// thousands of times. Allocating a canvas + 2D context per call costs ~41µs;
// the result depends only on (family, size), so measure once and reuse both the
// context and the answer. Measured over 5000 calls: 207ms → 0.1ms.
let measureCtx: CanvasRenderingContext2D | null | undefined;
const measureCache = new Map<string, [number, number]>();

/** Mudlet's scrollback floor and ceiling for setConsoleBufferSize. The floor
 *  keeps a buffer usable; the ceiling is what `useMaximum` asks for — Mudlet
 *  sizes it off the machine, which a browser tab cannot ask about, so this is a
 *  fixed generous cap instead. */
const MIN_CONSOLE_BUFFER_LINES = 100;
const MAX_CONSOLE_BUFFER_LINES = 1_000_000;

/**
 * Window id backing an MXP `<FRAME name>`. Frame names come from the server,
 * while mudix owns window ids of its own — `main`, `map` (the toolbar's
 * mapper), `mapViewN`. eden calls its minimap frame `map`, which unprefixed
 * would have the server's frame and the user's map widget fighting over one
 * window: creating the frame hijacks the mapper's panel (and drops the frame's
 * text, since a map panel takes no buffer writes), `ACTION=close` deletes the
 * mapper, and the toolbar's Map button hides the frame. The separator cannot
 * appear in a frame name (MxpFrameManager's VALID_FRAME_NAME is alphanumerics,
 * `_` and `-`), so the namespace cannot be reached from the wire either.
 *
 * The cost is that a Lua script cannot address a frame by its bare MXP name the
 * way Mudlet's mSubConsoleMap allows; no mudix API exposes frames to scripts
 * yet, so nothing depends on that today.
 */
function mxpWindowId(name: string): string {
    return `mxp:${name}`;
}

function measureMonospaceCell(family: string, size: number): [number, number] {
    const px = size * 4 / 3;
    const fallback: [number, number] = [Math.round(px * 0.6), Math.round(px * 1.2)];
    if (typeof document === 'undefined') return fallback;
    const cacheKey = `${family}|${size}`;
    const hit = measureCache.get(cacheKey);
    if (hit) return hit;
    if (measureCtx === undefined) {
        measureCtx = document.createElement('canvas').getContext('2d');
    }
    const ctx = measureCtx;
    if (!ctx) return fallback;
    const stack = family && family.trim()
        ? `"${family.trim().replace(/"/g, '\\"')}", ${DEFAULT_MONO_STACK}`
        : DEFAULT_MONO_STACK;
    ctx.font = `${px}px ${stack}`;
    const m = ctx.measureText('M');
    const ascent = m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent;
    const height = (typeof ascent === 'number' && typeof descent === 'number')
        ? ascent + descent
        : px * 1.2;
    const cell: [number, number] = [Math.round(m.width), Math.round(height)];
    measureCache.set(cacheKey, cell);
    return cell;
}

// ── Windows ───────────────────────────────────────────────────────────────────

class ScriptingWindowsAPI {
    constructor(private readonly session: MudSession) {}

    open(id: string, options?: WindowOpenOptions): WindowHandle {
        return this.session.windows.open(id, options);
    }

    write(id: string, text: string): void {
        this.session.windows.write(id, text);
    }

    clear(id: string): void {
        this.session.windows.clear(id);
    }

    setTitle(id: string, title?: string): boolean {
        return this.session.windows.setTitle(id, title);
    }

    /** Mudlet getUserWindowTitle / getMapWindowTitle — null when no such window. */
    getTitle(id: string): string | null {
        return this.session.windows.getTitle(id);
    }

    /** Mudlet getScrollBarVisible — the enable/disableScrollBar intent. */
    scrollBarVisible(id: string): boolean {
        return this.session.windows.scrollBarVisible(id);
    }

    /** Mudlet getMapWidgetGeometry / getWindowGeometry — null when no such window. */
    getGeometry(id: string): { x: number; y: number; width: number; height: number } | null {
        return this.session.windows.getGeometry(id);
    }

    focus(id: string): void {
        this.session.windows.focus(id);
    }

    hide(id: string): void {
        this.session.windows.hide(id);
    }

    show(id: string): boolean {
        return this.session.windows.show(id);
    }

    close(id: string): void {
        this.session.windows.close(id);
    }

    has(id: string): boolean {
        return this.session.windows.has(id);
    }

    isVisible(id: string): boolean {
        return this.session.windows.isVisible(id);
    }

    isMiniConsole(id: string): boolean {
        return this.session.windows.isMiniConsole(id);
    }

    move(id: string, x: number, y: number): void {
        this.session.windows.setPosition(id, x, y);
    }

    setParent(id: string, parent?: string): boolean {
        return this.session.windows.setParent(id, parent);
    }

    bringToFront(id: string): void {
        this.session.windows.bringToFront(id);
    }

    sendToBack(id: string): void {
        this.session.windows.sendToBack(id);
    }

    resize(id: string, width: number, height: number): void {
        this.session.windows.setSize(id, width, height);
    }

    setFontSize(id: string, size: number): boolean {
        return this.session.windows.setFontSize(id, size);
    }

    getFontSize(id: string): number | null {
        return this.session.windows.getFontSize(id);
    }

    setFont(id: string, family: string): boolean {
        return this.session.windows.setFont(id, family);
    }

    getFont(id: string): string | null {
        return this.session.windows.getFont(id);
    }

    setBackgroundColor(id: string, r: number, g: number, b: number, a = 255): boolean {
        return this.session.windows.setBackgroundColor(id, r, g, b, a);
    }

    getBackgroundColor(id: string): { r: number; g: number; b: number; a: number } | null {
        return this.session.windows.getBackgroundColor(id);
    }

    element(id: string): HTMLElement | null {
        return this.session.windows.getElement(id);
    }

    // ── Per-window command line ────────────────────────────────
    enableCommandLine(id: string): boolean {
        return this.session.windows.enableCommandLine(id);
    }
    disableCommandLine(id: string): boolean {
        return this.session.windows.disableCommandLine(id);
    }
    setCmdLineStyleSheet(id: string, css: string): boolean {
        return this.session.windows.setCmdLineStyleSheet(id, css);
    }
    setCmdLineAction(id: string, cb: ((text: string) => void) | null): boolean {
        return this.session.windows.setCmdLineAction(id, cb);
    }
    clearCmdLine(id: string): boolean {
        return this.session.windows.clearWindowCmdLine(id);
    }
    printCmdLine(id: string, text: string): boolean {
        return this.session.windows.printWindowCmdLine(id, text);
    }
    appendCmdLine(id: string, text: string): boolean {
        return this.session.windows.appendWindowCmdLine(id, text);
    }
    getCmdLineValue(id: string): string {
        return this.session.windows.getCmdLineValue(id);
    }
}

// ── Labels ────────────────────────────────────────────────────────────────────

class ScriptingLabelsAPI {
    constructor(
        private readonly manager: LabelManager,
        /** Resolves the engine's current VFS-aware CSS rewriter. Read lazily
         *  (rather than captured) because the engine is bound after this API is
         *  constructed; before that it resolves to an identity rewrite. */
        private readonly cssRewriter: () => (css: string) => string,
        /** Same lazy-resolution contract as `cssRewriter`, for the rich-text
         *  HTML labels render (`<img src>` and inline `style` url(...) refs). */
        private readonly htmlRewriter: () => (html: string) => string,
    ) {}

    create(name: string, opts: LabelCreateOptions): boolean {
        return this.manager.create(name, opts);
    }
    has(name: string): boolean { return this.manager.has(name); }
    /** Whether a movie is installed on this label — the movie functions report
     *  "no movie here" separately from "no such label". */
    hasMovie(name: string): boolean { return this.manager.getMovie(name) !== null; }
    /** Read-only state for the geometry/visibility/text getters. */
    get(name: string) { return this.manager.get(name); }
    destroy(name: string): boolean {
        // Drop the authored CSS with the label, so a later label reusing the
        // name doesn't inherit the old one's stylesheet through getStyleSheet.
        this.authoredCss.delete(name);
        return this.manager.destroy(name);
    }
    move(name: string, x: number, y: number): boolean {
        return this.manager.move(name, x, y);
    }
    setParent(name: string, parent: string): boolean {
        return this.manager.setParent(name, parent);
    }
    resize(name: string, width: number, height: number): boolean {
        return this.manager.resize(name, width, height);
    }
    show(name: string): boolean { return this.manager.show(name); }
    hide(name: string): boolean { return this.manager.hide(name); }
    setHtml(name: string, html: string): boolean {
        // Qt resolves <img src="..."> in label rich text against the real
        // filesystem; in the browser the bytes only exist behind the VFS
        // service worker, so rebase the refs before the HTML reaches the DOM.
        const rewrite = this.htmlRewriter();
        return this.manager.setHtml(name, rewrite(html));
    }
    setBackgroundColor(name: string, r: number, g: number, b: number, a = 255): boolean {
        return this.manager.setBackgroundColor(name, r, g, b, a);
    }
    getBackgroundColor(name: string): { r: number; g: number; b: number; a: number } | null {
        return this.manager.getBackgroundColor(name);
    }
    setStyleSheet(name: string, css: string): boolean {
        const rewrite = this.cssRewriter();
        const ok = this.manager.setStyleSheet(name, rewrite(css));
        // Remember what the script actually wrote. The rewritten form is an
        // implementation detail of serving profile files over HTTP — a script
        // that sets `url(/tmp/x.png)` and reads it back must not be handed
        // `url("/__vfs/<id>/tmp/x.png")`, which is neither what it set nor a
        // path it could set. GeyserLabel_spec pins the round trip.
        if (ok) this.authoredCss.set(name, css);
        return ok;
    }
    getStyleSheet(name: string): string | undefined {
        const stored = this.manager.getStyleSheet(name);
        if (stored === undefined) return undefined;
        return this.authoredCss.get(name) ?? stored;
    }
    /** Pre-rewrite CSS per label, keyed by name — see {@link setStyleSheet}. */
    private readonly authoredCss = new Map<string, string>();
    setLinkStyle(name: string, color: string, visitedColor: string, underline: boolean): boolean {
        return this.manager.setLinkStyle(name, color, visitedColor, underline);
    }
    resetLinkStyle(name: string): boolean {
        return this.manager.resetLinkStyle(name);
    }
    getSizeHint(name: string): { width: number; height: number } | null {
        return this.manager.getSizeHint(name);
    }
    setClickCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        return this.manager.setClickCallback(name, fn);
    }
    setMouseUpCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        return this.manager.setMouseUpCallback(name, fn);
    }
    setDoubleClickCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        return this.manager.setDoubleClickCallback(name, fn);
    }
    setMouseMoveCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        return this.manager.setMouseMoveCallback(name, fn);
    }
    setMouseEnterCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        return this.manager.setMouseEnterCallback(name, fn);
    }
    setMouseLeaveCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        return this.manager.setMouseLeaveCallback(name, fn);
    }
    setWheelCallback(name: string, fn: ((e: LabelWheelEvent) => void) | undefined): boolean {
        return this.manager.setWheelCallback(name, fn);
    }
    setTooltip(name: string, text: string | undefined): boolean {
        return this.manager.setTooltip(name, text);
    }
    setClickThrough(name: string, value: boolean): boolean {
        return this.manager.setClickThrough(name, value);
    }
    setCursor(name: string, cursor: string | undefined): boolean {
        return this.manager.setCursor(name, cursor);
    }
    raise(name: string): boolean { return this.manager.raise(name); }
    lower(name: string): boolean { return this.manager.lower(name); }
}

// ── Main API ──────────────────────────────────────────────────────────────────

// Mudlet's installPackage/installModule return (bool ok, string errorMessage).
// wasmoon JS functions can only push a single Lua value, so the installer
// callbacks return this shape and a Bridge.lua wrapper reshapes it into the
// documented multi-return. `error` is null on success.
export interface InstallOutcome {
    ok: boolean;
    error: string | null;
}

/** The MUD's telnet host/port for a connection — stored directly in mud-mode,
 *  parsed from the endpoint URL in websocket-mode (port falls back to the ws/wss
 *  default). Shared by getConnectionInfo() and getProfiles(). */
function connectionHostPort(conn: MudConnection): { host: string; port: number } {
    if (conn.mode === 'mud') {
        return { host: conn.host ?? '', port: conn.port ?? 23 };
    }
    if (conn.url) {
        try {
            const u = new URL(conn.url);
            return { host: u.hostname, port: u.port ? Number(u.port) : (u.protocol === 'wss:' ? 443 : 80) };
        } catch { /* malformed url → defaults below */ }
    }
    return { host: '', port: 0 };
}

export class ScriptingAPI {
    /** The engine backing this API. ScriptingEngine binds itself in its own
     *  constructor, immediately after building this object, so in the real app
     *  a live engine is present for essentially the whole lifetime. The inert
     *  host covers the two cases where one genuinely isn't: after teardown
     *  unbinds (see setHost), and in tests, which construct a ScriptingAPI
     *  without an engine at all.
     *
     *  This is deliberately NOT session-backed. An earlier version gave the
     *  unbound host live fallbacks (dial the session, send, emit flushLines) to
     *  preserve pre-engine behaviour from the old nullable-callback design.
     *  Once the engine started binding in the constructor those became both
     *  unreachable in production and actively wrong: after destroy() calls
     *  setHost(null), a `connect()` from a surviving DOM link handler would
     *  have dialled the session — defeating the teardown refusal three phases
     *  earlier in the same function. Inert is the correct unbound behaviour. */
    private host: EngineHost = NULL_ENGINE_HOST;

    /** OSC 8 selection-group + visited-link state for this connection. */
    private readonly oscLinks = new OscLinkManager();
    readonly windows: ScriptingWindowsAPI;
    readonly labels: ScriptingLabelsAPI;
    readonly cmdLines: CommandLineManager;
    readonly scrollBoxes: ScrollBoxManager;
    // Mudlet createTextEdit widgets (data-model registry; see TextEditManager).
    readonly textEdits = new TextEditManager();
    readonly aliases: AliasEngine;
    readonly triggers: TriggerEngine;
    profileName = '';
    /** When true, errors routed through {@link printError} are also echoed into
     *  the main output window (Mudlet's "Show errors in main console"). Wired
     *  from ProfileSettings.showErrorsInMainWindow in ProfileSession. */
    showErrorsInMainWindow = false;
    readonly timers: TimerEngine;
    readonly keys: KeyEngine;
    /** Mudlet-compatible stopwatch registry (createStopWatch & friends).
     *  Persistent watches survive reloads via localStorage keyed by connection. */
    readonly stopwatches: StopwatchManager;
    /** Cross-tab view of open/connected profiles — backs getProfiles(). */
    private readonly presence: ProfilesPresence;
    /** Teardown for the session subscriptions wired in the constructor. */
    private readonly apiUnsubs: Array<() => void> = [];

    private readonly mainConsole = new Console();

    // True while the trigger pipeline is running for the current line. Drives
    // echo deferral and rerender suppression — Mudlet's TLuaInterpreter has no
    // analogous flag (the renderer reads the buffer at paint time), but mudix
    // renders via 'message' events, so we have to suppress per-mutation
    // rerenders during trigger processing and let the post-trigger render
    // pick up the final state in one shot.
    private inTriggerProcessing = false;

    // While lineBuffer is active, echo/cecho output is held here and flushed
    // to the output *after* the triggering line (or batch) is rendered.
    private echoDeferred: AnsiAwareBuffer[] = [];
    private isDeferringEcho = false;

    // True between beginLine/endLine until the trigger's first echoed `\n`.
    // Mudlet's echo/cecho appends to the matched line at the output cursor (end
    // of line); only a newline advances to a fresh line. While this is set, a
    // main-window echo's pre-newline text is appended to the matched buffer
    // rather than starting a new deferred line.
    private echoOnMatchedLine = false;

    // The engine-backed callbacks that used to live here (link execution,
    // alias expansion, package/module management, the perm* constructors, …)
    // are now methods on the EngineHost bound via setHost. The four below are
    // different: they are supplied by ProfileSession, not the engine, so they
    // stay as individually settable slots.

    /** Mudlet `startLogging(state)`. Forwarded to ProfileSession, which owns
     *  the SessionLogger instance (created/torn-down on this hook). */
    private loggingToggler: ((enabled: boolean) => boolean) | null = null;
    /** Mudlet `appendLog(text)`. Forwarded to the active SessionLogger (wired by
     *  ProfileSession, which owns the logger lifecycle). */
    private logAppender: ((text: string) => void) | null = null;
    /** Mudlet `closeMudlet()`. mudix maps it to "close the active profile":
     *  disconnect, then return to the connection screen. Wired by ProfileSession. */
    private closeProfileCallback: (() => void) | null = null;

    private selection: { windowName: string | undefined; start: number; length: number } | null = null;

    // Session-global rich-text clipboard — mirrors Mudlet's host-wide
    // mClipboard. `copy()` fills it from the current selection (formatting
    // preserved); `paste()`/`appendBuffer()` read from it.
    private clipboard: AnsiAwareBuffer | null = null;

    // Session-local mirror of the OS *text* clipboard for getClipboardText /
    // setClipboardText (distinct from the rich-text `clipboard` above that
    // backs copy/paste). The browser's real clipboard is async and gated on a
    // user gesture, whereas Mudlet's getClipboardText/setClipboardText are
    // synchronous — so we keep an authoritative in-process value and sync it to
    // navigator.clipboard best-effort. getClipboardText returns this mirror
    // (kicking off an async refresh from the OS clipboard when available).
    private clipboardText = '';

    // Names of off-screen text buffers created via `createBuffer`. Their
    // backing Console lives in `session.consoles` like any window console, but
    // has no panel — so output to them is never pushed to the WindowManager
    // (which would force a panel open). See `drainWindowConsole`.
    private buffers = new Set<string>();

    constructor(
        private readonly session: MudSession,
        aliasEngine: AliasEngine,
        triggerEngine: TriggerEngine,
        timerEngine: TimerEngine,
        keyEngine: KeyEngine,
        private readonly connectionId: string,
    ) {
        this.windows = new ScriptingWindowsAPI(session);
        // Hand out a bound *call*, not the method itself. `this.host.rewriteCss`
        // would detach ScriptingEngine.rewriteCss from its instance, and it
        // dereferences this.vfs — so the label stylesheet path died with
        // "Cannot read properties of undefined (reading 'vfs')". The predecessor
        // of this was a closure field, which carried its own binding; a
        // prototype method does not.
        this.labels = new ScriptingLabelsAPI(
            session.labels,
            () => (css: string) => this.host.rewriteCss(css),
            () => (html: string) => this.host.rewriteHtml(html),
        );
        // Clicking an <a href> inside a label's rich text is handled by the
        // overlay, which has no way to send/run anything itself — supply the
        // behaviour here (Mudlet does it in TLabel::slot_linkActivated).
        session.labels.setLinkActivator((href) => { this.activateLabelLink(href); });
        this.cmdLines = session.cmdLines;
        this.scrollBoxes = session.scrollBoxes;
        this.aliases = aliasEngine;
        this.triggers = triggerEngine;
        this.timers = timerEngine;
        this.keys = keyEngine;
        this.stopwatches = new StopwatchManager(localStorageStopwatchStore(connectionId));
        this.presence = new ProfilesPresence(connectionId, () => this.session.status === 'connected');
        // Re-announce this tab's connected state to other tabs on connect/
        // disconnect (for their getProfiles). Deferred to a microtask so the
        // session's own status handler has run before we read session.status.
        const announce = () => { queueMicrotask(() => this.presence.announce()); };
        this.apiUnsubs.push(session.events.on('client.connect', announce));
        this.apiUnsubs.push(session.events.on('client.disconnect', announce));
        session.consoles.set('main', this.mainConsole);
        // Mudlet `sysBufferShrinkEvent("main", linesRemoved)` — named user
        // windows have the same hook wired in WindowManager.registerConsole.
        this.mainConsole.onBufferShrink = (n) => this.host.raiseEvent('sysBufferShrinkEvent', ['main', n]);
        // Re-apply the one persisted config key that drives a live session
        // side-effect (suppressing local command echo) so it survives reloads.
        // Older profiles persisted this as a boolean; parseShowSentText maps that
        // (true→'script', false→'never') as well as the new mode strings.
        const persistedMode = parseShowSentText(this.configBag().showSentText);
        if (persistedMode) session.showSentText = persistedMode;
        // Same for blankLinesBehaviour (how empty server lines render).
        const persistedBlank = parseBlankLinesBehaviour(this.configBag().blankLinesBehaviour);
        if (persistedBlank) session.blankLinesBehaviour = persistedBlank;
        // Same for the per-origin media mute gates (muteMediaAPI / muteMediaGame),
        // which additionally track the persisted bag for as long as the session
        // lives: unlike `setConfig`, the Settings UI writes straight to the store,
        // so without this the toggles wouldn't bite until a reload.
        this.syncMediaMuteFromConfig();
        this.apiUnsubs.push(useAppStore.subscribe((state, prev) => {
            const next = state.connectionProfile[this.connectionId]?.config;
            if (next === prev.connectionProfile[this.connectionId]?.config) return;
            this.syncMediaMuteFromConfig();
        }));
    }

    /** Push the persisted `muteMediaAPI` / `muteMediaGame` gates onto the live
     *  sound and video managers. Both setters no-op when already in the wanted
     *  state, so this is cheap to call on every config-bag change. */
    private syncMediaMuteFromConfig(): void {
        const bag = this.configBag();
        for (const [origin, key] of [['api', 'muteMediaAPI'], ['game', 'muteMediaGame']] as const) {
            const muted = configBool(bag[key] ?? false);
            this.session.sounds.setOriginMuted(origin, muted);
            this.session.videos.setOriginMuted(origin, muted);
        }
    }

    /** Bind the engine backing this API. Called once by ScriptingEngine during
     *  its own construction; pass null on teardown to revert to the inert host,
     *  so anything that outlives the engine (a rendered line's link handler,
     *  say) can't drive a disposed one. */
    setHost(host: EngineHost | null): void {
        this.host = host ?? NULL_ENGINE_HOST;
    }

    /** The currently bound host. Exposed so tests can layer a single override
     *  over it: `api.setHost({ ...api.engineHost, readFileBytes: fn })`. */
    get engineHost(): EngineHost {
        return this.host;
    }

    // ── Connection ────────────────────────────────────────────────────────────

    connect(url: string): void {
        this.dialConnect(url);
    }

    /** Dial through the engine's load gate when wired (deferring a connect made
     *  during initial load); the default host connects the session directly. */
    private dialConnect(url: string): void {
        this.host.requestConnect(url);
    }

    disconnect(): void {
        this.session.disconnect();
    }

    send(text: string, echo = true): void {
        // sysDataSendRequest handlers may deny the send. With no engine wired
        // yet (early init) the no-op host reports "not denied", so this sends
        // straight through.
        if (this.host.dispatchSendRequest(text)) return;
        this.session.send(text, echo);
    }

    sendGmcp(message: string): void {
        this.session.sendGmcpRaw(message);
    }

    /** Mudlet `sendMSDP(variable, ...values)`. Frames an MSDP subnegotiation
     *  (`IAC SB MSDP MSDP_VAR <var> [MSDP_VAL <val>]... IAC SE`) and sends it. */
    sendMSDP(variable: string, values: string[]): boolean {
        return this.session.sendMSDP(variable, values);
    }

    /** Mudlet `sendSocket(data)`. Sends a literal byte-string over the socket
     *  with no telnet/encoding processing (each char is one byte). */
    sendSocket(data: string): boolean {
        return this.session.sendSocket(data);
    }

    /** Mudlet `feedTelnet(data)`. Injects raw server bytes into the inbound
     *  pipeline as if received from the MUD (telnet stripping → ANSI →
     *  triggers → render). */
    /** Mudlet `feedTelnet(data)` — inject imitation server bytes. Refused while
     *  a socket exists in any state but unconnected, so replayed data can never
     *  interleave with a live stream; the message is returned for the binding to
     *  shape into Mudlet's `(nil, errMsg)`, and null means it was fed. */
    feedTelnet(data: string): string | null {
        if (!this.session.isSocketUnconnected()) {
            return 'feedTelnet: refused, telnet connection socket is not in the unconnected state';
        }
        this.session.feedTelnet(data);
        return null;
    }

    /** Mudlet `loadReplay(fileName)` core. Starts playback of a Mudlet binary
     *  replay (.dat). The LuaRuntime binding reads the bytes from the VFS
     *  before calling here. Returns null on success or the failure reason. */
    loadReplay(bytes: Uint8Array): string | null {
        return this.session.loadReplayData(bytes);
    }

    /** Deliver any replay chunk that has come due. Only the busted pump calls
     *  this — see MudSession.pumpReplay. */
    pumpReplay(): number {
        return this.session.pumpReplay();
    }

    /** Mudlet `receiveMSP(text)`. Parses an MSP payload (`!!SOUND(...)` /
     *  `!!MUSIC(...)` tags) as if the server had sent it and dispatches the
     *  resulting sound/music commands through the normal `msp` event path
     *  (SoundManager). Returns true when at least one command was parsed. */
    receiveMSP(payload: string): boolean {
        const text = String(payload ?? '');
        if (!text) return false;
        const { commands } = new MspParser().feed(text);
        for (const cmd of commands) this.session.events.emit('msp', cmd);
        return commands.length > 0;
    }

    /** Whether MSP is live on this connection — negotiated with the server, not
     *  merely permitted by the profile's `enableMSP` config. Mudlet gates
     *  receiveMSP on this (ctelnet::isMSPEnabled). */
    isMspNegotiated(): boolean {
        return this.session.isMspNegotiated();
    }

    /** Mudlet `sendATCP(message)`. Frames + sends an ATCP (telnet 200)
     *  subnegotiation; false when the socket isn't open. */
    sendATCP(message: string): boolean {
        return this.session.sendATCP(message);
    }

    /** Mudlet `sendTelnetChannel102(msg)`. Frames + sends a zMUD channel-102
     *  (telnet 102) subnegotiation; false when the socket isn't open. */
    sendTelnetChannel102(msg: string): boolean {
        return this.session.sendTelnetChannel102(msg);
    }

    /** Mudlet `reconnect()`. Disconnect and redial the last-connected URL;
     *  false when no connection has been made this session. */
    /** Mudlet `reconnect()`. Routed through the host rather than straight to the
     *  session so it observes the same teardown gate as connect() — otherwise a
     *  sysExitEvent handler calling reconnect() opens a socket that the disposal
     *  immediately below it then has to tear down. */
    reconnect(): boolean {
        return this.host.requestReconnect();
    }

    /** Mudlet `getServerEncoding()`. IANA name of the decoder applied to the
     *  inbound stream (default "utf-8"). */
    getServerEncoding(): string {
        return this.session.getServerEncoding();
    }

    /** Mudlet `setServerEncoding(name)`. Switch the server stream decoder to
     *  `name` (one of getServerEncodingsList()); false when unsupported or no
     *  connection is active. */
    setServerEncoding(name: string): boolean {
        return this.session.setServerEncoding(name);
    }

    /** Mudlet `getServerEncodingsList()`. The encodings mudix can decode. */
    getServerEncodingsList(): string[] {
        return this.session.getServerEncodingsList();
    }

    /** Mudlet `getCharacterName()`. mudix uses one character per profile, so
     *  this returns the active profile name (same value as getProfileName());
     *  empty string when unset. */
    getCharacterName(): string {
        return this.profileName;
    }

    /**
     * Mudlet `getProfiles()`. A record keyed by profile name, one entry per
     * configured connection, each `{ host, port, loaded, connected, description }`:
     *  - `host`/`port` — the MUD's address (mud-mode: stored host/port; ws-mode:
     *    parsed from the endpoint URL), available for every profile.
     *  - `loaded` — the profile is open (in some tab) and editable. Cross-tab via
     *    the Web Lock each open profile holds.
     *  - `connected` — the profile is connected to its game. Own tab: live; other
     *    tabs: their last-announced state (BroadcastChannel presence). Always
     *    false for a profile that isn't loaded.
     *  - `description` — the connection record's free-text description.
     * On a duplicate profile name, last-wins (a Lua table can't hold dup keys).
     */
    getProfiles(): Record<string, { host: string; port: string; loaded: boolean; connected?: boolean; description: string }> {
        const loaded = new Set(this.presence.loadedIds());
        const out: Record<string, { host: string; port: string; loaded: boolean; connected?: boolean; description: string }> = {};
        for (const conn of useAppStore.getState().connections) {
            const isLoaded = loaded.has(conn.id);
            const { host, port } = connectionHostPort(conn);
            out[conn.name] = {
                host,
                // Strings, as Mudlet reports them: the port comes out of the
                // profile's own text field, and a caller concatenating it into
                // an address shouldn't have to think about number formatting.
                port: String(port),
                loaded: isLoaded,
                // Only a loaded profile has a connection to report on. Gated on
                // loaded, too, so a crashed tab's stale presence can't outlive
                // its (auto-released) lock.
                ...(isLoaded ? { connected: this.presence.isConnected(conn.id) } : {}),
                description: conn.description ?? '',
            };
        }
        return out;
    }

    /** Mudlet `getMudletInfo()`. Echoes a short diagnostic block to the main
     *  window. This is a browser client with no Qt build, so it reports the
     *  web-client equivalents (profile, server encoding, platform). The client
     *  version is our own release (see src/version.ts), not the Mudlet API
     *  level — that's what `getMudletVersion()` reports. */
    getMudletInfo(): void {
        const platform = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
        const lines = [
            `${getBrand().appName} ${CLIENT_VERSION} — web-based MUD client`,
            `Profile: ${this.profileName || '(none)'}`,
            `Platform: ${platform}`,
            // Mudlet reports both the encoding in use and everything it could be
            // switched to; a script diagnosing mojibake wants the second list as
            // much as the first.
            `Current encoding: "${this.session.getServerEncoding()}"`,
            `Available encodings: ${this.session.getServerEncodingsList().join(', ')}`,
        ];
        for (const line of lines) this.echo(line + '\n');
    }

    /** Mudlet `loadProfile(name) → bool`. Opens the named profile and connects
     *  to it. Each profile lives in its own browser tab (the per-profile lock
     *  keeps it to one tab), so this opens a NEW tab at `?profile=<id>&connect=1`
     *  rather than switching the current one — the calling profile stays open
     *  alongside, mirroring Mudlet's multi-profile model. Returns false for an
     *  unknown name, when targeting the profile already open in this tab, or when
     *  the browser blocks the popup. NOTE: `window.open` needs a user gesture, so
     *  this works from a key/button/alias but a browser may block it from a
     *  trigger (no Mudlet equivalent to that limitation). */
    loadProfile(name: string): boolean {
        const target = (name ?? '').trim();
        if (!target) return false;
        const conn = useAppStore.getState().connections.find(c => c.name === target);
        if (!conn) {
            this.echo(`loadProfile: no profile named "${target}"\n`);
            return false;
        }
        if (conn.id === this.connectionId) {
            this.echo(`loadProfile: "${target}" is already open in this tab\n`);
            return false;
        }
        const url = new URL(window.location.href);
        url.searchParams.set('profile', conn.id);
        url.searchParams.set('connect', '1');
        const w = window.open(url.toString(), '_blank');
        return !!w;
    }

    /** Mudlet `getCommandSeparator()`. Returns the profile's command separator
     *  (the string that splits one Enter into multiple commands). Defaults to
     *  `;;` when the profile hasn't customised it. */
    getCommandSeparator(): string {
        const sep = selectProfileField(useAppStore.getState(), this.connectionId, 'commandSeparator');
        return sep ?? ';;';
    }

    // ── setConfig / getConfig ───────────────────────────────────────────────
    // A flat key→value registry mirroring Mudlet's TLuaInterpreter config bag.
    // Keys fall into three groups:
    //   • structured  — routed to a real ProfileSettings field (protocol
    //     toggles, mapper settings, autoClearInput) so the Settings UI stays in
    //     sync. Protocol changes take effect on the next connect, like Mudlet.
    //   • live        — showSentText, muteMediaAPI, muteMediaGame: applied
    //     immediately to the session and persisted so they survive a reload.
    //   • persist-only (CONFIG_PERSIST_ONLY) — stored for round-trip fidelity
    //     but not yet acted on; getConfig returns the stored value or a default.
    // Read-only keys (logDirectory, specialForceMXPProcessorOn) reject writes.

    /** The persisted catch-all config bag for the active profile (never null). */
    private configBag(): Record<string, unknown> {
        return useAppStore.getState().connectionProfile[this.connectionId]?.config ?? {};
    }

    /** Shallow-merge a single key into the persisted config bag. */
    private patchConfigBag(key: string, value: unknown): void {
        const prev = this.configBag();
        useAppStore.getState().patchConnectionProfile(this.connectionId, { config: { ...prev, [key]: value } });
    }

    private getProtocol(key: BooleanProtocolKey): boolean {
        const p = useAppStore.getState().connectionProfile[this.connectionId]?.protocols;
        return p?.[key] ?? PROTOCOL_DEFAULTS[key];
    }

    private setProtocol(key: BooleanProtocolKey, value: boolean): void {
        const prev = useAppStore.getState().connectionProfile[this.connectionId]?.protocols ?? {};
        useAppStore.getState().patchConnectionProfile(this.connectionId, { protocols: { ...prev, [key]: value } });
    }

    private getMapperField<K extends keyof MapperSettings>(key: K): MapperSettings[K] {
        const m = useAppStore.getState().connectionProfile[this.connectionId]?.mapper;
        return m?.[key] ?? MAPPER_DEFAULTS[key];
    }

    private setMapperField<K extends keyof MapperSettings>(key: K, value: MapperSettings[K]): void {
        const prev = useAppStore.getState().connectionProfile[this.connectionId]?.mapper ?? {};
        useAppStore.getState().patchConnectionProfile(this.connectionId, { mapper: { ...prev, [key]: value } });
    }

    /** Applies a Mudlet-space room size (`mRoomSize` — a fraction of a grid
     *  cell, same unit as `renderer.settings.roomSize`) while holding the
     *  *effective* Mudlet exit size constant.
     *
     *  Mudlet's exit pen is `(1 / mLineSize) * cellPx * mRoomSize`
     *  (`T2DMap::paintEvent`), i.e. exits scale with the room size; the
     *  renderer's `lineWidth` is an independent map-unit width. Rescaling
     *  `lineWidth` by the same factor reproduces that coupling — and makes a
     *  combined `setConfig{mapRoomSize=…, mapExitSize=…}` order-independent,
     *  which matters because `Other.lua` walks the table with `pairs()`. */
    private setMudletRoomSize(roomSize: number): void {
        const store = useAppStore.getState();
        const prev = store.connectionProfile[this.connectionId]?.mapper ?? {};
        const prevRoomSize = prev.roomSize ?? MAPPER_DEFAULTS.roomSize;
        const prevLineWidth = prev.lineWidth ?? MAPPER_DEFAULTS.lineWidth;
        const lineWidth = prevRoomSize > 0 ? prevLineWidth * (roomSize / prevRoomSize) : prevLineWidth;
        store.patchConnectionProfile(this.connectionId, { mapper: { ...prev, roomSize, lineWidth } });
    }

    /** The renderer's `lineWidth` expressed in Mudlet's `mLineSize` space —
     *  the inverse-thickness divisor `getConfig("mapExitSize")` reports. */
    private mudletExitSize(): number {
        const roomSize = this.getMapperField('roomSize') ?? MAPPER_DEFAULTS.roomSize;
        const lineWidth = this.getMapperField('lineWidth') ?? MAPPER_DEFAULTS.lineWidth;
        if (!(lineWidth > 0)) return MAPPER_DEFAULTS.roomSize / MAPPER_DEFAULTS.lineWidth;
        return roomSize / lineWidth;
    }

    /** Mudlet `getConfig(key [, useStringFormat])`. Returns the option's value,
     *  or `undefined` (→ Lua nil, plus a message from the Bridge wrapper) for an
     *  unknown key. `useStringFormat` is Mudlet's opt-in for options that kept a
     *  legacy boolean reading alongside a newer enum — currently `showSentText`.
     *  The no-arg / table forms are handled by the Lua wrapper in Other.lua,
     *  which calls this once per key. */
    getConfig(key: string, useStringFormat = false): unknown {
        switch (key) {
            // structured — protocol toggles
            case 'enableGMCP': return this.getProtocol('gmcp');
            case 'enableMSDP': return this.getProtocol('msdp');
            case 'enableMSP':  return this.getProtocol('msp');
            case 'enableMSSP': return this.getProtocol('mssp');
            case 'enableMTTS': return this.getProtocol('mtts');
            case 'enableMXP':  return this.getProtocol('mxp');
            case 'enableMNES': return this.getProtocol('mnes');
            // Mudlet's canonical key is the all-caps `enableNEWENVIRON`; the
            // mixed-case `enableNewEnviron` is kept as a mudix alias.
            case 'enableNEWENVIRON':
            case 'enableNewEnviron': return this.getProtocol('newEnviron');
            case 'enableCHARSET': return this.getProtocol('charset');
            case 'enableNAWS': return this.getProtocol('naws');
            // structured — inverse "force negotiation off" toggles
            case 'specialForceMxpNegotiationOff':     return !this.getProtocol('mxp');
            case 'specialForceCharsetNegotiationOff': return !this.getProtocol('charset');
            case 'specialForceCompressionOff':        return !this.getProtocol('mccp');
            // MNES and NEW-ENVIRON share telnet option 39; "force off" means
            // neither variant is offered, so it's true only when both are off.
            case 'forceNewEnvironNegotiationOff':     return !this.getProtocol('mnes') && !this.getProtocol('newEnviron');
            // structured — input line
            case 'autoClearInputLine':
                return selectProfileField(useAppStore.getState(), this.connectionId, 'autoClearInput') ?? false;
            // structured — MSSP secure-port offer (Mudlet Host::mAskTlsAvailable).
            // A typed field rather than a config-bag key: the offer logic and the
            // Settings checkbox both read it, and declining the offer clears it.
            case 'askTlsAvailable':
                return selectProfileField(useAppStore.getState(), this.connectionId, 'askTlsAvailable') ?? true;
            // structured — mapper
            // Mudlet's getConfig reports the *internal* doubles (host.mRoomSize /
            // host.mLineSize), not the spin-box scale its setConfig takes — see
            // setConfig below for the (deliberately asymmetric) write side.
            case 'mapRoomSize':        return this.getMapperField('roomSize');
            case 'mapExitSize':        return this.mudletExitSize();
            case 'mapRoundRooms':      return this.getMapperField('roomShape') === 'roundedRectangle';
            case 'mapShowRoomBorders': return this.getMapperField('borders');
            case 'mapShowGrid':        return this.getMapperField('gridEnabled');
            // structured — map-info widget background (Bridge rebuilds the table)
            case 'mapInfoColor': {
                const c = (this.configBag().mapInfoColor as MapInfoBgColor | undefined) ?? MAP_INFO_BG_DEFAULT;
                return `${c.r},${c.g},${c.b},${c.a}`;
            }
            // live
            // Mudlet's legacy key was a plain on/off toggle and still reads back
            // as one; the three-mode string is the opt-in `getConfig(key, true)`
            // form. 'never' is the only mode that reads false.
            case 'showSentText':
                return useStringFormat ? this.session.showSentText : this.session.showSentText !== 'never';
            case 'blankLinesBehaviour': return this.session.blankLinesBehaviour;
            // Mudlet's mShowPanel — the mapper's *control bar*, not the map
            // window (that's openMapWidget/closeMapWidget). Default true.
            case 'mapperPanelVisible':
                return selectProfileField(useAppStore.getState(), this.connectionId, 'mapperPanelVisible') ?? true;
            case 'muteMediaAPI':       return this.session.sounds.isOriginMuted('api');
            case 'muteMediaGame':      return this.session.sounds.isOriginMuted('game');
            // read-only
            case 'logDirectory':       return '/profiles/' + this.connectionId + '/log';
            case 'specialForceMXPProcessorOn':
                return configBool(this.configBag().specialForceMXPProcessorOn ?? false);
        }
        const spec = CONFIG_PERSIST_ONLY[key];
        if (spec) {
            const stored = this.configBag()[key];
            return stored !== undefined ? stored : spec.default;
        }
        return undefined;
    }

    /**
     * What kind of value `setConfig(key, …)` takes, or null when the key names
     * no option at all. Mudlet reads each option with a `getVerified*` helper,
     * so a value of the wrong TYPE raises while a value that is merely out of
     * range is a `(nil, errMsg)` return — the Bridge wrapper needs to know which
     * of the two applies before it calls through, and only the type is knowable
     * ahead of the call.
     *
     * `'readonly'` keys exist for `getConfig` but refuse every write; `'any'`
     * keys take more than one value type and vet the value themselves.
     */
    configKeyKind(key: string): 'bool' | 'num' | 'str' | 'any' | 'readonly' | null {
        switch (key) {
            case 'enableGMCP': case 'enableMSDP': case 'enableMSP': case 'enableMSSP':
            case 'enableMTTS': case 'enableMXP': case 'enableMNES':
            case 'enableNEWENVIRON': case 'enableNewEnviron':
            case 'enableCHARSET': case 'enableNAWS':
            case 'specialForceMxpNegotiationOff': case 'specialForceCharsetNegotiationOff':
            case 'specialForceCompressionOff': case 'forceNewEnvironNegotiationOff':
            case 'autoClearInputLine': case 'askTlsAvailable':
            case 'mapRoundRooms': case 'mapShowRoomBorders':
            case 'mapShowGrid': case 'muteMediaAPI': case 'muteMediaGame':
            case 'mapperPanelVisible':
                return 'bool';
            case 'mapRoomSize': case 'mapExitSize':
                return 'num';
            case 'blankLinesBehaviour':
            // Set-only in Mudlet: they name a map-info overlay to switch on/off
            // and have no getConfig counterpart, so getConfig reports them as
            // invalid while setConfig accepts them.
            case 'showMapInfo': case 'hideMapInfo':
                return 'str';
            // showSentText still accepts its legacy boolean alongside the enum,
            // and mapInfoColor takes a table, so neither can be type-checked up
            // front — they validate their own value and report it as a refusal.
            case 'showSentText': case 'mapInfoColor':
                return 'any';
            case 'logDirectory':
                return 'readonly';
            case 'specialForceMXPProcessorOn':
                return 'bool';
        }
        const spec = CONFIG_PERSIST_ONLY[key];
        return spec ? spec.type : null;
    }

    /** Mudlet `setConfig(key, value)`. Returns true when the key is known and
     *  writable, false for unknown or read-only keys. */
    setConfig(key: string, value: unknown): boolean {
        switch (key) {
            case 'enableGMCP': this.setProtocol('gmcp', configBool(value)); return true;
            case 'enableMSDP': this.setProtocol('msdp', configBool(value)); return true;
            case 'enableMSP':  this.setProtocol('msp',  configBool(value)); return true;
            case 'enableMSSP': this.setProtocol('mssp', configBool(value)); return true;
            case 'enableMTTS': this.setProtocol('mtts', configBool(value)); return true;
            case 'enableMXP':  this.setProtocol('mxp',  configBool(value)); return true;
            case 'enableMNES': this.setProtocol('mnes', configBool(value)); return true;
            // Mudlet's canonical key is `enableNEWENVIRON`; `enableNewEnviron` is
            // a mudix alias. Both route to the same NEW-ENVIRON protocol flag.
            case 'enableNEWENVIRON':
            case 'enableNewEnviron': this.setProtocol('newEnviron', configBool(value)); return true;
            case 'enableCHARSET': this.setProtocol('charset', configBool(value)); return true;
            case 'enableNAWS': this.setProtocol('naws', configBool(value)); return true;
            case 'specialForceMxpNegotiationOff':     this.setProtocol('mxp',     !configBool(value)); return true;
            case 'specialForceCharsetNegotiationOff': this.setProtocol('charset', !configBool(value)); return true;
            case 'specialForceCompressionOff':        this.setProtocol('mccp',    !configBool(value)); return true;
            // Forcing option 39 off disables both variants; un-forcing restores
            // the RFC-1572 default (plain NEW-ENVIRON on, MNES left off — matching
            // Mudlet's defaults) rather than guessing which variant to re-enable.
            case 'forceNewEnvironNegotiationOff':
                this.setProtocol('newEnviron', !configBool(value));
                if (configBool(value)) this.setProtocol('mnes', false);
                return true;
            case 'autoClearInputLine':
                useAppStore.getState().patchConnectionProfile(this.connectionId, { autoClearInput: configBool(value) });
                return true;
            // Whether an MSSP-advertised TLS port still earns a "switch to the
            // secure port?" offer. Declining the offer (or reverting a failed
            // upgrade) clears the same field, so a script can re-arm it.
            case 'askTlsAvailable':
                useAppStore.getState().patchConnectionProfile(this.connectionId, { askTlsAvailable: configBool(value) });
                return true;
            // Mudlet's setConfig for these two routes through the *preferences*
            // slots, so the accepted values are the spin-box scale, not the
            // internal doubles getConfig hands back:
            //   setConfig("mapRoomSize", n) → dlgMapper::slot_roomSize(n)
            //                               → T2DMap::setRoomSize(n / 10)
            //   setConfig("mapExitSize", n) → dlgMapper::slot_exitSize(n)
            //                               → T2DMap::setExitSize(n), i.e. mLineSize = n
            // Mudlet's defaults are mapRoomSize 5 (mRoomSize 0.5) and
            // mapExitSize 10 (mLineSize 10). Both then have to be converted out
            // of Mudlet's draw-time formulas into the renderer's map units.
            case 'mapRoomSize': {
                const n = Number(value);
                // Mudlet's room size is a fraction of a grid cell — the same
                // unit as renderer.settings.roomSize — once the /10 spin-box
                // scaling is undone.
                if (Number.isFinite(n) && n > 0) this.setMudletRoomSize(n / MUDLET_ROOM_SIZE_SCALE);
                return true;
            }
            case 'mapExitSize': {
                const n = Number(value);
                // mLineSize is an inverse divisor: Mudlet's exit pen is
                // (1 / mLineSize) * cellPx * mRoomSize, so in renderer map units
                // lineWidth = roomSize / mLineSize. Bigger mapExitSize → thinner
                // exits, which is why the preferences spinner shows 50/mLineSize.
                if (Number.isFinite(n) && n > 0) {
                    this.setMapperField('lineWidth', (this.getMapperField('roomSize') ?? MAPPER_DEFAULTS.roomSize) / n);
                }
                return true;
            }
            case 'mapRoundRooms':
                this.setMapperField('roomShape', configBool(value) ? 'roundedRectangle' : 'rectangle');
                return true;
            case 'mapShowRoomBorders': this.setMapperField('borders', configBool(value)); return true;
            case 'mapShowGrid':        this.setMapperField('gridEnabled', configBool(value)); return true;
            // Switch a registerMapInfo overlay on/off by label. Mudlet reports
            // success for any label — including one nothing has registered yet —
            // so these never refuse. **Deviation:** Mudlet guards the whole
            // branch on a live mapper widget and treats the key as unknown when
            // there is none; Mudlet Web's MapStore is always present on the
            // WindowManager, so the write lands whether or not a map panel is
            // open (and is visible the moment one is).
            case 'showMapInfo': this.map.showMapInfo(String(value ?? '')); return true;
            case 'hideMapInfo': this.map.hideMapInfo(String(value ?? '')); return true;
            case 'mapInfoColor': {
                const rgba = parseMapInfoColor(value);
                if (!rgba) return false;
                this.patchConfigBag('mapInfoColor', rgba);
                return true;
            }
            case 'showSentText': {
                const mode = parseShowSentText(value);
                if (!mode) return false;
                this.session.showSentText = mode;
                this.patchConfigBag('showSentText', mode);
                return true;
            }
            case 'blankLinesBehaviour': {
                const mode = parseBlankLinesBehaviour(value);
                if (!mode) return false;
                this.session.blankLinesBehaviour = mode;
                this.patchConfigBag('blankLinesBehaviour', mode);
                return true;
            }
            // Live per-origin media mute gates, persisted so they survive a
            // reload (re-applied in the constructor, and re-synced whenever the
            // Settings UI writes the same bag keys). 'api' silences script
            // playback (playSoundFile/playMusicFile/playVideoFile); 'game'
            // silences server media (MSP, MXP <SOUND>/<MUSIC>, and GMCP
            // Client.Media). Muting a live track keeps it playing silently;
            // unmuting restores it mid-track.
            case 'muteMediaAPI': {
                const muted = configBool(value);
                this.session.sounds.setOriginMuted('api', muted);
                this.session.videos.setOriginMuted('api', muted);
                this.patchConfigBag('muteMediaAPI', muted);
                return true;
            }
            case 'muteMediaGame': {
                const muted = configBool(value);
                this.session.sounds.setOriginMuted('game', muted);
                this.session.videos.setOriginMuted('game', muted);
                this.patchConfigBag('muteMediaGame', muted);
                return true;
            }
            // Mudlet dlgMapper::slot_setMapperPanelVisible → Host::mShowPanel:
            // shows/hides the mapper's control bar (area picker, z-level
            // buttons, options menu) on every map panel, leaving the map itself
            // alone. Persisted per profile, like Mudlet's profile XML.
            case 'mapperPanelVisible': {
                useAppStore.getState().patchConnectionProfile(this.connectionId, {
                    mapperPanelVisible: configBool(value),
                });
                return true;
            }
            // Mudlet Host::setForceMXPProcessorOn — run the in-band MXP parser
            // without an option-91 handshake. Writable (dlgProfilePreferences and
            // setConfig both drive it); the handshake replies stay off, since no
            // server confirmed it speaks MXP.
            case 'specialForceMXPProcessorOn': {
                const on = configBool(value);
                this.host.setForceMxpProcessorOn(on);
                this.patchConfigBag('specialForceMXPProcessorOn', on);
                return true;
            }
            // read-only keys — present in the catalogue but not writable
            case 'logDirectory':
                return false;
        }
        const spec = CONFIG_PERSIST_ONLY[key];
        if (spec) {
            let v: unknown;
            if (spec.type === 'bool') v = configBool(value);
            else if (spec.type === 'num') v = Number(value);
            else {
                v = String(value);
                if (spec.enum && !spec.enum.includes(v as string)) return false;
            }
            this.patchConfigBag(key, v);
            return true;
        }
        return false;
    }

    /**
     * The connection a profile-name argument refers to, or null when no profile
     * has that name. Matching ignores case, as Mudlet's does: it looks the name
     * up as a folder, and the platforms it runs on mostly have case-insensitive
     * ones — so `setProfileInformation(name:upper(), …)` has to find the profile
     * it already has rather than start a second one beside it.
     */
    private connectionByName(profileName?: string): MudConnection | null {
        if (profileName === undefined) {
            return useAppStore.getState().connections.find(c => c.id === this.connectionId) ?? null;
        }
        const wanted = profileName.toLowerCase();
        return useAppStore.getState().connections.find(c => c.name.toLowerCase() === wanted) ?? null;
    }

    /** Mudlet `getProfileInformation([profileName])`. The profile's free-text
     *  description ("" when unset), defaulting to this profile. Returns null for
     *  a name no profile has. */
    getProfileInformation(profileName?: string): string | null {
        const conn = this.connectionByName(profileName);
        if (conn) {
            // A profile that simply has no description of its own still answers
            // — with the blurb its game ships with, or the empty string.
            return conn.description ?? findBundledGame(conn.name)?.description ?? '';
        }
        // No profile by that name, but the getter still answers for a game
        // mudix ships in its catalogue: Mudlet reads the description straight
        // out of TGameDetails, so "Achaea" resolves whether or not anyone has
        // ever opened an Achaea profile. Only the *writers* refuse it.
        if (profileName !== undefined) {
            const game = findBundledGame(profileName);
            if (game) return game.description;
        }
        return null;
    }

    /** Mudlet `setProfileInformation([profileName,] text)`. Stores the free-text
     *  description on the connection record (also editable from the connection
     *  screen). False for a name no profile has — deliberately a refusal rather
     *  than a create, since in Mudlet the write goes through a call that makes
     *  whatever folder it is handed, and a folder there is a profile. */
    setProfileInformation(text: string, profileName?: string): boolean {
        const conn = this.connectionByName(profileName);
        if (!conn) return false;
        useAppStore.getState().patchConnection(conn.id, { description: String(text ?? '') });
        return true;
    }

    /** Mudlet `clearProfileInformation([profileName])`. Puts the description
     *  back to what the profile started with: the blurb its game ships with in
     *  the bundled catalogue, or empty for a profile someone made up. */
    clearProfileInformation(profileName?: string): boolean {
        const conn = this.connectionByName(profileName);
        if (!conn) return false;
        const shipped = findBundledGame(conn.name)?.description ?? '';
        useAppStore.getState().patchConnection(conn.id, { description: shipped });
        return true;
    }

    /** Mudlet `getProfileIcon()`. Returns the stored icon as a `data:` URI, or
     *  "" when the profile has no custom icon (the connection screen then shows
     *  the auto-generated name tile). */
    getProfileIcon(): string {
        return useAppStore.getState().connections.find(c => c.id === this.connectionId)?.icon ?? '';
    }

    /** Mudlet `setProfileIcon(path)`. The LuaRuntime binding reads the VFS image
     *  and inlines it as a `data:` URI before calling here, so this method only
     *  stores the already-resolved icon string. Returns false for an empty
     *  value. */
    setProfileIcon(icon: string): boolean {
        const v = String(icon ?? '');
        if (!v) return false;
        useAppStore.getState().patchConnection(this.connectionId, { icon: v });
        return true;
    }

    /** Mudlet `resetProfileIcon()`. Clears the custom icon so the connection
     *  screen falls back to the auto-generated name tile. */
    resetProfileIcon(): boolean {
        useAppStore.getState().patchConnection(this.connectionId, { icon: undefined });
        return true;
    }

    /** Mudlet `holdingModifiers(number)`. True when exactly the given set of
     *  keyboard modifiers (Qt::KeyboardModifier bitmask, as in
     *  `mudlet.keymodifier`) is currently held — exact equality, matching
     *  Mudlet. */
    holdingModifiers(modifiers: number): boolean {
        return getHeldModifiers() === (Number(modifiers) | 0);
    }







    getPackages(): string[] {
        return this.host.getPackageNames();
    }


    installModule(path: string): InstallOutcome { return this.host.installModuleFromPath(path); }
    uninstallModule(name: string): boolean { return this.host.uninstallModuleByName(name); }
    syncModule(name: string): Promise<void> { return this.host.syncModuleToFile(name); }
    /** Write every module flagged to sync back out to its own file. Called by
     *  saveProfile — see the note there. */
    saveSyncedModules(): void { this.host.saveSyncedModules(); }
    reloadModule(name: string): boolean { return this.host.reloadModuleFromFile(name); }
    enableModuleSync(name: string): void { this.host.setModuleSync(name, true); }
    disableModuleSync(name: string): void { this.host.setModuleSync(name, false); }
    getModuleSync(name: string): boolean { return this.host.getModuleSync(name); }
    setModulePriority(name: string, priority: number): boolean {
        return this.host.setModulePriority(name, priority);
    }
    getModulePriority(name: string): number { return this.host.getModulePriority(name); }
    getModules(): string[] { return this.host.getModuleNames(); }
    getModuleInfo(name: string): Record<string, unknown> | null { return this.host.getModuleInfoRecord(name); }
    /** Mudlet `setModuleInfo(name, key, value)`. Stores a custom info field on a
     *  module (visible via getModuleInfo). Always true. */
    setModuleInfo(name: string, key: string, value: string): boolean { return this.host.setModuleInfo(name, key, value); }
    getModulePath(name: string): string | null { return this.host.getModulePath(name); }
    /** Mudlet `getPackageInfo(name)`. Merged info table — the package manifest's
     *  standard fields overlaid with anything set via setPackageInfo. Empty when
     *  the package isn't installed and nothing was set. */
    getPackageInfo(name: string): Record<string, string> { return this.host.getPackageInfo(name); }
    /** Mudlet `setPackageInfo(name, key, value)`. Stores a custom info field on a
     *  package (visible via getPackageInfo). Always true. */
    setPackageInfo(name: string, key: string, value: string): boolean { return this.host.setPackageInfo(name, key, value); }





    /**
     * Mudlet `setTriggerStayOpen(name, lines)`. Keeps the named trigger's chain
     * open for `lines` more lines of input for the current run only — it adjusts
     * transient chain state, not the persisted trigger's fire-length. 0 closes
     * the chain after the current line; positive values extend or shorten an
     * already-running chain.
     */
    setTriggerStayOpen(name: string, lines: number): boolean {
        return this.host.setTriggerStayOpenByName(name, lines);
    }


























    /** Hook for ProfileSession to start/stop the per-connection SessionLogger.
     *  Mudlet `startLogging(true|false)` toggles whether new output lines are
     *  recorded; the on/off transition is synchronous. */
    setLoggingToggler(fn: ((enabled: boolean) => boolean) | null): void {
        this.loggingToggler = fn;
    }

    /** Mudlet `startLogging(state)`. Returns true on success, false when
     *  the toggle isn't wired up yet (e.g. before ProfileSession mounts). */
    /**
     * Mudlet `startLogging(state)` → (ok, message, path, state). The state code
     * distinguishes a change from a no-op: 1 started, 0 stopped, -1 already on,
     * -2 already off; the two "already" cases answer nil rather than true, so a
     * caller can tell "I turned it on" from "it was on".
     */
    startLogging(enabled: boolean): { ok: boolean; message: string; path: string | null; state: number } {
        const wasOn = !!this.loggingPath();
        if (wasOn === enabled) {
            return enabled
                ? { ok: false, state: -1, path: this.loggingPath(), message: `Main console output is already being logged to file: ${this.loggingPath()}` }
                : { ok: false, state: -2, path: null, message: 'Main console output was already not being logged to a file.' };
        }
        // The path has to be read on the way out for a stop (the logger is gone
        // afterwards) and on the way in for a start (it doesn't exist yet).
        const before = this.loggingPath();
        this.loggingToggler?.(enabled);
        const path = enabled ? this.loggingPath() : before;
        return enabled
            ? { ok: true, state: 1, path, message: `Main console output has started to be logged to file: ${path}` }
            : { ok: true, state: 0, path, message: `Main console output has stopped being logged to file: ${path}` };
    }

    /** Where the live logger is writing its text log, or null when logging is
     *  off. Wired by ProfileSession alongside the toggler. */
    private loggingPathProvider: (() => string | null) | null = null;

    setLoggingPathProvider(fn: (() => string | null) | null): void {
        this.loggingPathProvider = fn;
    }

    private loggingPath(): string | null {
        return this.loggingPathProvider?.() ?? null;
    }

    /** Hook for ProfileSession to forward appendLog text to the live logger. */
    setLogAppender(fn: ((text: string) => void) | null): void {
        this.logAppender = fn;
    }

    /** Mudlet `appendLog(text)`. Appends a line to the current session log.
     *  No-op (returns false) when logging isn't active. */
    appendLog(text: string): boolean {
        if (!this.logAppender || !this.loggingPath()) return false;
        this.logAppender(text);
        return true;
    }

    /** Hook for ProfileSession to close the active profile (return to the
     *  connection screen). */
    setCloseProfileCallback(fn: (() => void) | null): void {
        this.closeProfileCallback = fn;
    }

    /** Mudlet `closeMudlet()`. mudix maps it to closing the active profile:
     *  disconnect, then return to the connection screen. */
    closeMudlet(): void {
        this.disconnect();
        this.closeProfileCallback?.();
    }


    /** Mudlet `resetProfile()` — reload the entire profile as if just opened:
     *  clear every UI surface, recreate the Lua runtime, and re-run all scripts.
     *  The actual work is deferred by the engine (it closes the Lua VM that is
     *  currently executing this call), so this returns immediately. */
    resetProfile(): void {
        this.host.resetProfile();
    }


    /** Mudlet `exportAreaImage(areaID, filePath[, zLevel])` — render the area to a
     *  PNG file in the profile VFS. Returns `[true, absolutePath]` on success or
     *  `[false, errorMessage]` (e.g. the mapper isn't open, or the area is
     *  unknown). The 0-indexed array is unpacked into Mudlet's multi-return by
     *  Bridge.lua. */
    exportAreaImage(areaId: number, filePath: string, zLevel?: number): [boolean, string] {
        const r = this.host.exportAreaImageToVfs(areaId, filePath, zLevel);
        return 'path' in r ? [true, r.path] : [false, r.error];
    }


    killByName(kind: 'timer' | 'alias' | 'trigger' | 'key', name: string): boolean {
        return this.host.killByName(kind, name);
    }



    installPackage(path: string): InstallOutcome {
        return this.host.installPackageFromVfsPath(path);
    }

    uninstallPackage(name: string): boolean {
        return this.host.uninstallPackageByName(name);
    }

    enableScript(name: string): boolean {
        return this.host.toggleScriptByName(name, true);
    }

    disableScript(name: string): boolean {
        return this.host.toggleScriptByName(name, false);
    }

    // A numeric argument names a script-created temp item, which lives in the
    // runtime rather than the saved tree; Mudlet toggles either kind.
    enableTrigger(nameOrId: string | number): boolean {
        if (typeof nameOrId === 'number') return this.host.setTempItemEnabled(nameOrId, true);
        return this.host.toggleTriggerByName(nameOrId, true);
    }

    disableTrigger(nameOrId: string | number): boolean {
        if (typeof nameOrId === 'number') return this.host.setTempItemEnabled(nameOrId, false);
        return this.host.toggleTriggerByName(nameOrId, false);
    }

    enableTimer(name: string): boolean {
        return this.host.toggleTimerByName(name, true);
    }

    disableTimer(name: string): boolean {
        return this.host.toggleTimerByName(name, false);
    }

    enableAlias(nameOrId: string | number): boolean {
        if (typeof nameOrId === 'number') return this.host.setTempItemEnabled(nameOrId, true);
        return this.host.toggleAliasByName(nameOrId, true);
    }

    disableAlias(nameOrId: string | number): boolean {
        if (typeof nameOrId === 'number') return this.host.setTempItemEnabled(nameOrId, false);
        return this.host.toggleAliasByName(nameOrId, false);
    }

    /** The saved keybinding carrying this numeric id, or null. Backs
     *  getKeyCode() for a permanent key referenced by the id permKey returned. */
    keyNodeByNumericId(numericId: number): { key: string; modifiers: string[] } | null {
        return this.host.keyNodeByNumericId(numericId);
    }

    // A numeric argument names a script-created temp key, which lives in the key
    // engine rather than the saved tree; Mudlet's enableKey/disableKey toggle
    // either kind.
    enableKey(nameOrId: string | number): boolean {
        if (typeof nameOrId === 'number') return this.keys.setTempEnabled(nameOrId, true);
        return this.host.toggleKeyByName(nameOrId, true);
    }

    disableKey(nameOrId: string | number): boolean {
        if (typeof nameOrId === 'number') return this.keys.setTempEnabled(nameOrId, false);
        return this.host.toggleKeyByName(nameOrId, false);
    }

    /**
     * Mudlet `getOS()` — the platform name scripts branch on. Mudlet returns
     * the native OS ("windows"/"mac"/"linux"/…); in the browser we report the
     * underlying OS sniffed from the user agent so platform-specific scripts
     * (e.g. mac vs. windows keybinding hints, the bundled accessibility
     * stylesheet) behave sensibly. "unknown" when it can't be determined.
     */
    getOS(): string {
        if (typeof navigator === 'undefined') return 'unknown';
        const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
        const raw = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
        if (raw.includes('win')) return 'windows';
        if (raw.includes('mac') || raw.includes('iphone') || raw.includes('ipad') || raw.includes('ios')) return 'mac';
        if (raw.includes('android') || raw.includes('linux') || raw.includes('cros')) return 'linux';
        if (raw.includes('freebsd')) return 'freebsd';
        if (raw.includes('openbsd')) return 'openbsd';
        if (raw.includes('netbsd')) return 'netbsd';
        return 'unknown';
    }

    /**
     * Full Mudlet `getOS()` return tuple, ordered as the C++ pushes it:
     * `osName, osVersion, [osType], processor` — where the Linux branch inserts
     * an extra `osType` (the distribution type) before the processor, so Linux
     * yields 4 values and every other platform 3. The Lua-side `getOS()` wrapper
     * (Bridge.lua) unpacks this 0-indexed array into the multi-return.
     *
     * In the browser none of these come from QSysInfo, so each is sniffed from
     * `navigator` and falls back to a non-empty `"unknown"` (Mudlet's contract,
     * and the busted spec, require non-empty strings).
     */
    getOSInfo(): string[] {
        const name = this.getOS();
        const version = this.getOSVersion();
        const processor = this.getOSProcessor();
        if (name === 'linux') {
            const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '').toLowerCase() : '';
            const osType = ua.includes('android') ? 'android' : ua.includes('cros') ? 'chromeos' : 'linux';
            return [name, version, osType, processor];
        }
        return [name, version, processor];
    }

    /** Best-effort OS version string from the user agent; "unknown" if absent. */
    private getOSVersion(): string {
        if (typeof navigator === 'undefined') return 'unknown';
        const ua = navigator.userAgent || '';
        let m = ua.match(/Windows NT ([\d.]+)/);
        if (m) return m[1];
        m = ua.match(/Mac OS X (10[\d_.]+)/);
        if (m) return m[1].replace(/_/g, '.');
        m = ua.match(/Android ([\d.]+)/);
        if (m) return m[1];
        m = ua.match(/CrOS \S+ ([\d.]+)/);
        if (m) return m[1];
        return 'unknown';
    }

    /** Processor string in Mudlet's format ("x86 (64-bit)", "arm64", …). */
    private getOSProcessor(): string {
        if (typeof navigator === 'undefined') return 'unknown';
        const nav = navigator as Navigator & { userAgentData?: { architecture?: string; bitness?: string } };
        const arch = (nav.userAgentData?.architecture || '').toLowerCase();
        if (arch === 'arm') return nav.userAgentData?.bitness === '64' ? 'arm64' : 'arm';
        if (arch === 'x86') return nav.userAgentData?.bitness === '64' ? 'x86 (64-bit)' : 'x86 (32-bit)';
        const raw = (nav.platform || nav.userAgent || '').toLowerCase();
        if (/x86_64|win64|wow64|amd64|x64/.test(raw)) return 'x86 (64-bit)';
        if (/aarch64|arm64/.test(raw)) return 'arm64';
        if (/armv\d|\barm\b/.test(raw)) return 'arm';
        if (/i686|i386|x86|win32/.test(raw)) return 'x86 (32-bit)';
        return 'unknown';
    }

    /**
     * Mudlet `getWindowsCodepage()` — on native Windows this reads the active
     * ANSI code page (ACP) from the registry as a string; the bundled
     * utf8_filenames.lua consults it (when getOS() == "windows") to decide
     * whether to transcode filenames from UTF-8 to a legacy ANSI page. The
     * browser VFS is always UTF-8, whose code page number is 65001, so we report
     * that on every platform. utf8_filenames keys its mapping table by legacy
     * ANSI page numbers (1250/1252/932/…), none of which is 65001 — so reporting
     * 65001 makes it correctly skip transcoding rather than corrupt UTF-8 paths.
     */
    getWindowsCodepage(): string {
        return '65001';
    }

    exists(nameOrId: string | number, type: string): number {
        return this.host.existsByName(nameOrId, type);
    }

    /**
     * Mudlet `isActive(name|id, type [, checkAncestors])` — count of *active*
     * items matching the name (or 1/0 for an id). An item is active when its own
     * enabled flag is set; with `checkAncestors` (default false) every ancestor
     * group must be enabled too. Type strings mirror `exists`.
     */
    isActive(nameOrId: string | number, type: string, checkAncestors = false): number {
        return this.host.isActiveByName(nameOrId, type, checkAncestors);
    }

    /** Mudlet `ancestors(id, type)`. Ancestor chain (parent→root) of the item,
     *  or null when no item of that type has the id. */
    ancestors(id: number, type: string): Array<{ id: number; name: string; node: string; isActive: boolean }> | null {
        return this.host.ancestorsById(id, type);
    }

    /** Mudlet `findItems(name, type [, exact [, caseSensitive]])`. Numeric ids of
     *  matching items/groups — empty when none match, null when there is no such
     *  item family (which the Lua wrapper reports as a bad item type). */
    findItems(name: string, type: string, exact = true, caseSensitive = true): number[] | null {
        return this.host.findItemsByName(name, type, exact, caseSensitive);
    }

    /** Mudlet `isAncestorsActive(id, type)`. True when every ancestor group is
     *  enabled; null when no item of that type has the id. */
    isAncestorsActive(id: number, type: string): boolean | null {
        return this.host.isAncestorsActiveById(id, type);
    }

    /** Next id from the profile's single item-id sequence — see
     *  ItemIdSequence. Backs the Lua runtime's temporary items. */
    allocateItemId(): number {
        return this.host.allocateItemId();
    }

    /** Whether `type` names an item family at all — the tree-walking APIs
     *  (findItems, ancestors, isAncestorsActive) all refuse an unknown one, and
     *  refuse it differently from "nothing matched". */
    isKnownItemType(type: string): boolean {
        return this.host.isKnownItemType(type);
    }

    /** Mudlet `getProfileStats()`. Per-family total/active counts (+ trigger
     *  patterns). See ScriptingEngine.getProfileStats for mudix's caveats. */
    getProfileStats(): Record<string, unknown> {
        return this.host.getProfileStats();
    }

    permScript(name: string, parent: string, code: string): number {
        return this.host.createPermScript(name, parent, code);
    }

    permRegexTrigger(name: string, parent: string, regexes: string[], code: string): number {
        return this.host.createPermRegexTrigger(name, parent, regexes, code);
    }

    /** Mudlet `permSubstringTrigger(name, parent, patterns, luaCode)`. Same
     *  shape as permRegexTrigger but each pattern uses substring matching
     *  (`String.prototype.includes` semantics, like the temp variant). An
     *  empty patterns array creates a trigger group. Returns the new id, or
     *  -1 if `parent` is given but no trigger group of that name exists. */
    permSubstringTrigger(name: string, parent: string, patterns: string[], code: string): number {
        return this.host.createPermSubstringTrigger(name, parent, patterns, code);
    }

    /** Mudlet `permBeginOfLineStringTrigger(name, parent, patterns, luaCode)`.
     *  Same shape as permSubstringTrigger but each pattern matches only when it
     *  appears at the start of the line (`String.prototype.startsWith`, like the
     *  `tempBeginOfLineTrigger` variant). An empty patterns array creates a
     *  trigger group. Returns the new id, or -1 if `parent` is given but no
     *  trigger group of that name exists. */
    permBeginOfLineStringTrigger(name: string, parent: string, patterns: string[], code: string): number {
        return this.host.createPermBeginOfLineStringTrigger(name, parent, patterns, code);
    }

    /** Mudlet `permExactMatchTrigger(name, parent, patterns, luaCode)`. Same
     *  shape as permSubstringTrigger but each pattern matches only on full-line
     *  equality. An empty patterns array creates a trigger group. Returns the
     *  new id, or -1 if `parent` is given but no trigger group of that name
     *  exists. */
    permExactMatchTrigger(name: string, parent: string, patterns: string[], code: string): number {
        return this.host.createPermExactMatchTrigger(name, parent, patterns, code);
    }

    /** Mudlet `permPromptTrigger(name, parent, luaCode)`. Creates a persistent
     *  trigger that fires on every server prompt line (GA/EOR), with no text
     *  pattern. Returns the new id, or -1 if `parent` is given but no trigger
     *  group of that name exists. */
    permPromptTrigger(name: string, parent: string, code: string): number {
        return this.host.createPermPromptTrigger(name, parent, code);
    }

    /** Mudlet `permAlias(name, parent, regex, luaCode)`. Creates a persistent
     *  alias under the named parent group (empty = root). Returns the new
     *  alias id, or -1 when `parent` is non-empty but no alias group of that
     *  name exists. */
    permAlias(name: string, parent: string, pattern: string, code: string): number {
        return this.host.createPermAlias(name, parent, pattern, code);
    }

    /** Mudlet `permTimer(name, parent, seconds, luaCode)`. Creates a
     *  persistent one-shot timer under the parent group (empty = root).
     *  Returns the new timer id, or -1 when `parent` is non-empty but no
     *  timer group of that name exists. */
    permTimer(name: string, parent: string, delay: number, code: string): number {
        return this.host.createPermTimer(name, parent, delay, code);
    }

    /** Mudlet `permKey(name, parent, modifier, keycode, luaCode)`. Persists a
     *  keybinding under the named parent group (empty = root). Returns the new
     *  id, or -1 when `parent` is non-empty but no key group of that name
     *  exists. `modifier` is the Qt keyboard-modifier int (1=shift, 2=ctrl,
     *  4=alt, 8=meta) — -1 means "no modifier" (Mudlet's convention; used by
     *  `permGroup("name","key")`). */
    permKey(name: string, parent: string, modifier: number, key: string | number, code: string): number {
        return this.host.createPermKey(name, parent, modifier, key, code);
    }

    // Combos already warned about via warnReservedTempKey — a script may re-register
    // the same tempKey on every sysLoadEvent (or in a loop), so we warn once each.
    private readonly warnedReservedTempKeys = new Set<string>();

    /**
     * Warn (once per unique combo + call site, for this runtime) when a script
     * binds a browser-reserved key via `tempKey`. The profile-load scan covers
     * permanent keybindings, but temp keys are created at runtime and never hit
     * the store, so the check has to happen here at registration time. `key` is a
     * DOM `KeyboardEvent.code`; `modifiers` the {ctrl,shift,alt,meta} subset;
     * `source` is the caller's "script:line" captured by the Lua wrapper.
     */
    warnReservedTempKey(key: string, modifiers: string[], source?: string): void {
        const action = classifyReservedKey({ key, modifiers });
        if (!action) return;
        const combo = formatKeyCombo({ key, modifiers });
        // Dedup per combo AND call site: a loop re-binding from one line warns
        // once, but two different scripts binding the same combo each warn.
        const dedupKey = `${combo}\u0000${source ?? ''}`;
        if (this.warnedReservedTempKeys.has(dedupKey)) return;
        this.warnedReservedTempKeys.add(dedupKey);
        const where = source ? ` (from ${source})` : '';
        this.session.events.emit('message',
            `\x1b[33m[ WARN ]  - tempKey ${combo}${where}: ${reservedKeyNote(action)}\x1b[0m`,
            'info', Date.now());
    }

    /** Mudlet `tempButton(toolbarName, name, code [, orientation])`. Appends a
     *  transient button under an existing toolbar group; returns the new id, or
     *  -1 when the toolbar doesn't exist. `orientation` is Mudlet's int form
     *  (0=horizontal/1=vertical) — accepted for compat, applied to the
     *  button row inside the toolbar grid. */
    tempButton(toolbar: string, name: string, code: string, orientation: number): number {
        return this.host.createTempButton(toolbar, name, code, orientation);
    }

    /** Mudlet `tempButtonToolbar(name [, orientation [, location]])`. Creates
     *  a transient toolbar (ButtonNode group). `location` int: 0=top, 1=bottom,
     *  2=left, 3=right, 4=floating. Returns the new id or -1 on duplicate
     *  name. */
    tempButtonToolbar(name: string, orientation: number, location: number): number {
        return this.host.createTempButtonToolbar(name, orientation, location);
    }

    /** Mudlet `setButtonState(name, state)`. Sets the pressed state of a
     *  two-state (push-down) button by name. Returns false when not found. */
    setButtonState(name: string, state: boolean): boolean {
        return this.host.setButtonStateByName(name, state);
    }

    /** Mudlet `getButtonState(name)`. Reads the pressed state of a two-state
     *  button. Returns nil when not found. */
    getButtonState(name: string): boolean | null {
        return this.host.getButtonStateByName(name);
    }

    /** Which of Mudlet's button refusals applies to `name` — see
     *  ScriptingEngine.buttonKindByName. */
    buttonKind(name: string): 'missing' | 'plain' | 'pushdown' {
        return this.host.buttonKindByName(name);
    }

    /** Mudlet `setButtonStyleSheet(name, css)`. Stores a CSS string on the
     *  ButtonNode; the renderer applies it inline. Returns false when not
     *  found. */
    setButtonStyleSheet(name: string, css: string): boolean {
        return this.host.setButtonStyleSheetByName(name, css);
    }

    /** Mudlet `showToolBar(name)` / `hideToolBar(name)`. Toggles the toolbar's
     *  effective enabled flag — the existing button bar already gates render
     *  on `isEffectivelyEnabled`, so flipping the group's `enabled` field is
     *  the show/hide hook. Returns true on success, false when not found. */
    setToolBarVisibility(name: string, show: boolean): boolean {
        return this.host.toggleToolBarByName(name, show);
    }

    setScript(name: string, code: string, pos: number): number {
        return this.host.setScriptByName(name, code, pos);
    }

    /** Removes the script with this numeric id. Backs permScript's rollback
     *  when the new body raises as it is run. True when one was removed. */
    removeScriptById(id: number): boolean {
        return this.host.removeScriptById(id);
    }

    /** Mudlet `getScript(name [, pos]) → code, id`. Returns the source of the
     *  pos-th (1-indexed) script named `name` together with that script's own
     *  numeric id. Null when no script sits at that position, which Bridge.lua
     *  surfaces as Mudlet's `(-1, "script ... at position ... not found")`. */
    getScript(name: string, pos: number): { code: string; id: number } | null {
        return this.host.getScriptByName(name, pos);
    }

    // ── Echo / output ─────────────────────────────────────────────────────────

    echo(text: string): void {
        // During trigger processing Mudlet's echo/cecho appends to the matched
        // line at the output cursor (the line's end); only a `\n` advances to a
        // fresh line. mudix seeds the matched line into mainConsole.history
        // (beginLine) and defers script echoes, so without this every trigger
        // echo opened a new line — breaking Arkadia's grade/value triggers,
        // which `replace()`/`prefix()` then append text to the same line.
        if (this.echoOnMatchedLine) {
            const buf = this.mainConsole.getBuffer();
            if (buf) {
                const nl = text.indexOf('\n');
                const head = nl < 0 ? text : text.slice(0, nl);
                if (head) buf.insert(buf.text.length, head, this.mainConsole.format.toSnapshot());
                if (nl < 0) return;          // stayed on the matched line
                this.echoOnMatchedLine = false;
                text = text.slice(nl);        // remainder leads with the advancing \n
            } else {
                this.echoOnMatchedLine = false;
            }
        }
        this.mainConsole.echo(text);
        this.drainMain();
    }

    echoToWindow(win: string, text: string): void {
        const con = this.outputConsole(win);
        con.echo(text);
        this.drainWindowConsole(win, con);
    }

    /**
     * Native fast path for the color-echo family (`decho`/`cecho`/`hecho`).
     * Mudlet's Lua `xEcho` splits the string into color segments and crosses the Lua↔JS
     * boundary twice per segment (`setFgColor` + `echo`); a per-character
     * rainbow line is ~180 crossings. This converts the whole string to ANSI in
     * one pass and appends it as a single buffer — the same path network output
     * uses — so a `decho`-heavy loop pays ~1 crossing per line instead.
     *
     * Returns `false` when the fast path can't preserve exact `xEcho` semantics;
     * the Lua wrapper then falls back to the original `decho`. It bails on:
     *  - label targets (xEcho replaces their HTML wholesale),
     *  - main-window echo during trigger processing (echo appends to the matched
     *    line via a raw, non-ANSI insert the ANSI path can't reproduce),
     *  - any input the per-kind guard declines ({@link dechoToAnsiFast} /
     *    {@link cechoToAnsiFast} / {@link hechoToAnsiFast}) — style tags,
     *    combined fg/bg, backgrounds, unknown color names, unmodeled tokens.
     */
    fastColorEcho(kind: string, win: string, str: string): boolean {
        if (win !== 'main' && this.labels.has(win)) return false;
        if (win === 'main' && this.echoOnMatchedLine) return false;

        let ansi: string | null = null;
        if (kind === 'decho') ansi = dechoToAnsiFast(str);
        else if (kind === 'cecho') ansi = cechoToAnsiFast(str);
        else if (kind === 'hecho') ansi = hechoToAnsiFast(str);
        if (ansi === null) return false;

        // parseDecho unconditionally appends a trailing reset; we reset the pen
        // before every echo below, so drop it to avoid leaving a stray empty
        // partial (xEcho leaves none). Any internal `<r>` resets are preserved.
        if (ansi.endsWith('\x1b[0m')) ansi = ansi.slice(0, -4);

        const con = this.outputConsole(win);
        // Mirror xEcho's pre-echo `deselect(win)` + `resetFormat(win)`: leading
        // text renders in the default pen and the pen returns to default after.
        // Pass the concrete `win` (never undefined) exactly as xEcho does, so a
        // main-window echo only clears a selection owned by main — clearing
        // unconditionally would clobber a selection held in another window.
        this.deselect(win);
        con.resetFormat();
        con.echo(ansi);
        if (win === 'main') this.drainMain();
        else this.drainWindowConsole(win, con);
        return true;
    }

    /**
     * Mudlet `echoLink([win,] text, cmd, hint, [useCurrentFormat])`. With
     * `useCurrentFormat=false` (the default), the link is rendered with
     * Mudlet's built-in style: blue foreground + underline. With
     * `useCurrentFormat=true`, the current pen state on the resolved console
     * is preserved.
     */
    echoLink(text: string, cmd: string, tooltip: string, win?: string, useCurrentFormat = false): void {
        if (!text) return;  // xEcho emits empty-text calls for colour-only segments
        const hyperlink: FormatHyperlink = {
            onClick: () => { this.host.runLinkCode(cmd); },
            title: tooltip || undefined,
        };
        const con = this.outputConsole(win);
        con.format.hyperlink = hyperlink;
        if (!useCurrentFormat) {
            // Mudlet's TConsole::echoLink default: blue + underline.
            const prevFg = con.format.foreground;
            const prevUnderline = con.format.underline;
            con.format.foreground = { space: 'rgb', r: 0, g: 0, b: 255 };
            con.format.underline = true;
            con.echo(text);
            con.format.foreground = prevFg;
            con.format.underline = prevUnderline;
        } else {
            con.echo(text);
        }
        con.format.hyperlink = undefined;
        if (!win || win === 'main') {
            this.drainMain();
        } else {
            this.drainWindowConsole(win, con);
        }
    }

    /**
     * Build a {@link FormatHyperlink} whose right-click handler opens a context
     * menu listing `cmds` (labelled by `hints`, falling back to the command
     * text). Shared by `echoPopup`/`insertPopup`/`setPopup` — those three differ
     * only in whether the styled span is appended, inserted at the cursor, or
     * applied to the current selection.
     */
    private buildPopupHyperlink(
        cmds: string[],
        hints: string[],
        action: (cmd: string) => void = (cmd) => { this.host.runLinkCode(cmd); },
    ): FormatHyperlink {
        const onContextMenu = (ev: MouseEvent) => {
            ev.preventDefault();
            document.getElementById('mudix-popup-menu')?.remove();

            const menu = document.createElement('div');
            menu.id = 'mudix-popup-menu';
            menu.style.cssText = 'position:fixed;z-index:9999;background:#1e1e1e;border:1px solid #444;border-radius:4px;padding:2px 0;box-shadow:0 2px 10px rgba(0,0,0,0.7);min-width:120px;font-family:monospace;font-size:13px';
            menu.style.left = `${ev.clientX}px`;
            menu.style.top = `${ev.clientY}px`;

            cmds.forEach((cmd, i) => {
                const item = document.createElement('div');
                item.textContent = hints[i] ?? cmd;
                item.style.cssText = 'padding:5px 14px;cursor:pointer;color:#ddd;white-space:nowrap';
                item.addEventListener('mouseenter', () => { item.style.background = '#2a4a6e'; });
                item.addEventListener('mouseleave', () => { item.style.background = ''; });
                item.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    menu.remove();
                    action(cmd);
                });
                menu.appendChild(item);
            });

            document.body.appendChild(menu);

            const dismiss = (e: MouseEvent) => {
                if (!menu.contains(e.target as Node)) {
                    menu.remove();
                    document.removeEventListener('mousedown', dismiss);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
        };

        return { onContextMenu, title: hints[0] ?? '' };
    }

    /**
     * Build a {@link FormatHyperlink} for an MXP `<SEND>`/`<A>` link. Unlike the
     * popup/link APIs above (whose actions run Lua via `host.runLinkCode`), MXP link
     * targets are MUD commands or URLs:
     *  - `kind === 'url'` → left-click opens the URL in a new browser tab.
     *  - `kind === 'command'` → left-click sends the command to the MUD (echoed
     *    like a typed command).
     *  - `promptCmds` (a `cmd1|cmd2|…` list) → right-click shows a popup menu of
     *    the commands, each sending to the MUD.
     * Used by ScriptingEngine when rendering MXP-parsed lines.
     */
    createMxpHyperlink(
        kind: 'command' | 'url',
        payload: string,
        hint?: string,
        promptCmds?: string[],
        promptHints?: string[],
    ): FormatHyperlink {
        if (kind === 'url') {
            return {
                onClick: () => { window.open(payload, '_blank', 'noopener'); },
                title: hint || undefined,
                autoUnderline: true,
            };
        }
        const sendCmd = (cmd: string) => { this.send(cmd); };
        if (promptCmds && promptCmds.length > 1) {
            const hl = this.buildPopupHyperlink(promptCmds, promptHints ?? [], sendCmd);
            hl.onClick = () => sendCmd(payload);
            hl.title = hint || hl.title;
            hl.autoUnderline = true;
            return hl;
        }
        return {
            onClick: () => sendCmd(payload),
            title: hint || undefined,
            autoUnderline: true,
        };
    }

    /** Execute an OSC 8 link URI — a primary action or a menu item. The scheme
     *  decides the behaviour (send / prompt / open URL); anything else is a
     *  no-op (it was already rejected at parse time). */
    private runHyperlinkUri(uri: string): void {
        const action = classifyHyperlinkUri(uri);
        if (!action) return;
        if (action.kind === 'send') this.send(action.command);
        else if (action.kind === 'prompt') this.printCmdLine(action.command);
        else this.openUrl(action.url);
    }

    /**
     * Activate an `<a href>` clicked inside a label's rich text — Mudlet's
     * `TLabel::slot_linkActivated`. Wired onto the LabelManager in the
     * constructor; see labelLinks.ts for how the schemes differ from the OSC 8
     * ones {@link runHyperlinkUri} handles (chiefly: a scheme-less href is a Lua
     * chunk, which is how Geyser packages hang code off a label link).
     */
    activateLabelLink(href: string): void {
        const action = classifyLabelLink(href);
        if (!action) return;
        if (action.kind === 'send') this.send(action.command);
        else if (action.kind === 'prompt') this.printCmdLine(action.command);
        else if (action.kind === 'url') this.openUrl(action.url);
        else this.host.runLinkCode(action.code);
    }

    /**
     * Build a {@link FormatHyperlink} for an OSC 8 link URI. The scheme decides
     * the behaviour, mirroring Mudlet: `send:` fires the command immediately,
     * `prompt:` drops it into the command bar for editing, and the web schemes
     * open externally. Returns `undefined` for a disallowed scheme so the link
     * is dropped (the text renders without a click handler).
     */
    createOsc8Hyperlink(uri: string, link?: FormatHyperlink): FormatHyperlink | undefined {
        // Strip the OSC 8 extension query (config=/preset=) before deriving the
        // command, so a `send:cmd?config={…}` link never leaks JSON into the MUD
        // command. send:/prompt: drop their whole query; web links keep their
        // user params. (Links resolved at parse time arrive already-clean; this
        // also defends against any raw URI reaching here.)
        const { base, userPairs } = extractQuery(uri);
        const isWeb = /^(https?|ftp):/i.test(base);
        const command = isWeb && userPairs.length > 0 ? `${base}?${userPairs.join('&')}` : base;
        const action = classifyHyperlinkUri(command);
        if (!action) return undefined;

        const config = link?.config;
        const disabled = config?.disabled === true;
        const tooltip = config?.tooltip;
        // A non-empty menu opens on right-click; a disabled link still shows it.
        const menu = config?.menu;
        const menuHandler = menu && menu.length > 0
            ? (ev: MouseEvent) => openOsc8Menu(ev, menu, config?.title, (uri) => this.runHyperlinkUri(uri))
            : undefined;
        // Carry the parsed config + id onto the produced link so the renderer can
        // apply styling/states/tooltip; a disabled link has no click handler
        // (its activation is blocked) but still shows its tooltip and styling.
        const withConfig = (hl: FormatHyperlink): FormatHyperlink => {
            if (config) hl.config = config;
            if (link?.linkId) hl.linkId = link.linkId;
            if (menuHandler) hl.onContextMenu = menuHandler;
            return hl;
        };

        const sel = config?.selection;
        const defaultTitle = action.kind === 'url' ? action.url : action.command;
        // The primary activation: toggle selection (radio/checkbox), record the
        // visit, run the scheme action (a selection send carries &selected=<bool>
        // so the server learns the new state), then restyle the live links so
        // every run of the group reflects the change.
        const activate = (ev?: MouseEvent): void => {
            let selectedSuffix = '';
            if (sel?.group !== undefined && sel.value !== undefined) {
                const now = this.oscLinks.toggleSelection(sel.group, sel.value, sel.exclusive ?? true);
                if (action.kind === 'send') selectedSuffix = `&selected=${now}`;
            }
            this.oscLinks.markVisited(command);
            if (action.kind === 'send') this.send(action.command + selectedSuffix);
            else if (action.kind === 'prompt') this.printCmdLine(action.command);
            else this.openUrl(action.url);
            const doc = (ev?.currentTarget as HTMLElement | undefined)?.ownerDocument
                ?? (typeof document !== 'undefined' ? document : null);
            this.oscLinks.restyle(doc);
        };
        // No autoUnderline — an OSC 8 link is underlined only when its config
        // says so (see FormatHyperlink.autoUnderline).
        return withConfig({
            onClick: disabled ? undefined : activate,
            title: tooltip ?? defaultTitle,
            url: command,
        });
    }

    echoPopup(text: string, cmds: string[], hints: string[], win?: string, useCurrentFormat = false): void {
        const con = this.outputConsole(win);
        con.format.hyperlink = this.buildPopupHyperlink(cmds, hints);
        if (!useCurrentFormat) {
            // Same default as echoLink: Mudlet renders popup links blue + underline.
            const prevFg = con.format.foreground;
            const prevUnderline = con.format.underline;
            con.format.foreground = { space: 'rgb', r: 0, g: 0, b: 255 };
            con.format.underline = true;
            con.echo(text);
            con.format.foreground = prevFg;
            con.format.underline = prevUnderline;
        } else {
            con.echo(text);
        }
        con.format.hyperlink = undefined;
        if (!win || win === 'main') {
            this.drainMain();
        } else {
            this.drainWindowConsole(win, con);
        }
    }

    /**
     * Mudlet `insertPopup([window,] text, {commands}, {hints})`. Like
     * `insertText`/`insertLink`, but the inserted span carries a right-click
     * popup menu of `cmds`. Inserts at the cursor on the current line and
     * preserves the surrounding pen state; degrades to `echoPopup` when no
     * backing buffer is available (empty console / sub-window without a buffer).
     */
    insertPopup(text: string, cmds: string[], hints: string[], win?: string, useCurrentFormat = false): void {
        if (!text) return;
        const con = this.getConsole(win);
        const buf = con?.getBuffer();
        if (con && buf) {
            const state: FormatStateSnapshot = con.format.toSnapshot();
            state.hyperlink = this.buildPopupHyperlink(cmds, hints);
            if (!useCurrentFormat) {
                // Same default as insertLink: blue foreground + underline.
                state.foreground = { space: 'rgb', r: 0, g: 0, b: 255 };
                state.underline = true;
            }
            const at = Math.max(0, Math.min(con.getCursorColumn(), buf.text.length));
            buf.insert(at, text, state);
            if (!this.inTriggerProcessing) buf.rerender();
            return;
        }
        this.echoPopup(text, cmds, hints, win, useCurrentFormat);
    }

    /**
     * Mudlet `setPopup([window,] {commands}, {hints})`. Attaches a right-click
     * popup menu to the current selection — preserves the selection's existing
     * colors/attributes (like `setLink`, unlike the homogenizing color setters).
     * `commands` are Lua code strings run when the matching menu entry is
     * chosen. Returns false when there is no selection (or it belongs to a
     * different window).
     */
    setPopup(cmds: string[], hints: string[], win?: string): boolean {
        if (!this.selection) return false;
        if (win !== undefined && !this.selectionMatches(win)) return false;
        const sel = this.selection;
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return false;
        buf.setHyperlink([sel.start, sel.start + sel.length], this.buildPopupHyperlink(cmds, hints));
        if (!this.inTriggerProcessing) buf.rerender();
        return true;
    }



    expandAlias(text: string, echo: boolean): void {
        // The default host falls back to a plain send when no engine is bound.
        this.host.expandAlias(text, echo);
    }

    // ── Format state ──────────────────────────────────────────────────────────
    // Mirrors Mudlet's TConsole::setFgColor/setBgColor/setDisplayAttributes:
    // every call applies the format to the active selection (if any) AND sets
    // the current pen on the resolved console for subsequent echo.

    setFgColor(r: number, g: number, b: number, win?: string): void {
        if (this.selectionMatches(win)) {
            this.applyStateToSelection({ foreground: { space: 'rgb', r, g, b } });
        }
        this.outputConsole(win).setFgColor(r, g, b);
    }

    setBgColor(r: number, g: number, b: number, a?: number, win?: string): void {
        const color: RgbColor = a !== undefined && a < 255
            ? { space: 'rgb', r, g, b, a }
            : { space: 'rgb', r, g, b };
        if (this.selectionMatches(win)) {
            this.applyStateToSelection({ background: color });
        }
        this.outputConsole(win).setBgColor(r, g, b, a);
    }

    setBold(v: boolean, win?: string): void {
        if (this.selectionMatches(win)) this.applyStateToSelection({ bold: v });
        this.outputConsole(win).setBold(v);
    }
    setItalic(v: boolean, win?: string): void {
        if (this.selectionMatches(win)) this.applyStateToSelection({ italic: v });
        this.outputConsole(win).setItalic(v);
    }
    setUnderline(v: boolean, win?: string): void {
        if (this.selectionMatches(win)) this.applyStateToSelection({ underline: v });
        this.outputConsole(win).setUnderline(v);
    }
    setStrikethrough(v: boolean, win?: string): void {
        if (this.selectionMatches(win)) this.applyStateToSelection({ strikethrough: v });
        this.outputConsole(win).setStrikethrough(v);
    }
    /** Mudlet `setOverline([window,] bool)`. Renders a line above the text
     *  (CSS `text-decoration: overline`, ANSI SGR 53). Mirrors the other style
     *  setters: applies to the active selection when one matches, and updates
     *  the resolved console's pen for subsequent echo. */
    setOverline(v: boolean, win?: string): void {
        if (this.selectionMatches(win)) this.applyStateToSelection({ overline: v });
        this.outputConsole(win).setOverline(v);
    }
    /**
     * Mudlet `setReverse([window,] bool)`. Toggles reverse-video — the renderer
     * swaps the fg/bg pair when `inverse` is set (see Console rendering). Mirrors
     * the other style setters: applies to the active selection when one matches,
     * and updates the resolved console's pen for subsequent echo.
     */
    setReverse(v: boolean, win?: string): void {
        if (this.selectionMatches(win)) this.applyStateToSelection({ inverse: v });
        this.outputConsole(win).setReverse(v);
    }

    /**
     * Mudlet `setTextFormat(windowName, r1, g1, b1, r2, g2, b2, bold, underline,
     * italics, [strikeout], [overline], [reverse], [blinkMode]) → bool`. Sets
     * the full pen state in one call. r1/g1/b1 is BACKGROUND, r2/g2/b2 is
     * FOREGROUND (a Mudlet quirk — preserved here for parity). `blinkMode` is
     * "none" / "slow" / "fast". Returns false when the named window doesn't
     * resolve. Mirrors setFgColor & friends: the pen is updated on the resolved
     * console AND applied to the current selection when one is active on it.
     */
    setTextFormat(
        windowName: string | undefined,
        bg: { r: number; g: number; b: number },
        fg: { r: number; g: number; b: number },
        bold: boolean,
        underline: boolean,
        italics: boolean,
        strikeout: boolean,
        overline: boolean,
        reverse: boolean,
        blinkMode: 'none' | 'slow' | 'fast',
    ): boolean {
        if (!this.consoleExists(windowName)) return false;

        const snapshot: FormatStateSnapshot = {
            foreground: { space: 'rgb', r: fg.r, g: fg.g, b: fg.b },
            background: { space: 'rgb', r: bg.r, g: bg.g, b: bg.b },
            bold: bold || undefined,
            italic: italics || undefined,
            underline: underline || undefined,
            strikethrough: strikeout || undefined,
            overline: overline || undefined,
            inverse: reverse || undefined,
            slowBlink: blinkMode === 'slow' || undefined,
            rapidBlink: blinkMode === 'fast' || undefined,
        };

        if (this.selectionMatches(windowName)) {
            this.applyStateToSelection(snapshot);
        }
        const con = this.outputConsole(windowName);
        con.format.foreground = snapshot.foreground;
        con.format.background = snapshot.background;
        con.format.bold = snapshot.bold;
        con.format.italic = snapshot.italic;
        con.format.underline = snapshot.underline;
        con.format.strikethrough = snapshot.strikethrough;
        con.format.overline = snapshot.overline;
        con.format.inverse = snapshot.inverse;
        con.format.slowBlink = snapshot.slowBlink;
        con.format.rapidBlink = snapshot.rapidBlink;
        return true;
    }

    // ── Formatting (selection-aware) ──────────────────────────────────────────

    fg(name: string, win?: string): void {
        const state = namedColorToState(name, false);
        if (!state || state.foreground?.space !== 'rgb') return;
        const c = state.foreground;
        this.setFgColor(c.r, c.g, c.b, win);
    }

    bg(name: string, win?: string): void {
        const state = namedColorToState(name, true);
        if (!state || state.background?.space !== 'rgb') return;
        const c = state.background;
        this.setBgColor(c.r, c.g, c.b, undefined, win);
    }

    resetFormat(windowName?: string): boolean {
        // Mudlet TConsole::reset(): deselect + reset pen state to defaults.
        // It does NOT touch the buffer — selections lose their pointer here,
        // but characters keep whatever format was applied to them. Selection is
        // per-console in Mudlet, so only drop it when it belongs to this window
        // (mirrors `deselect`): echoing to one window — e.g. cecho/decho/hecho,
        // which call resetFormat internally — must not clear a selection made
        // in another, which would break selectCurrentLine(buf) → copy(buf) when
        // unrelated output goes to main in between.
        if (this.selectionMatches(windowName)) this.selection = null;
        this.outputConsole(windowName).resetFormat();
        return true;
    }

    // ── Selection ─────────────────────────────────────────────────────────────

    selectString(str: string, occurrence: number, windowName?: string): number {
        // Mudlet searches the cursor's current line. With Console as the
        // canonical buffer that is just `Console.getLine()` — including the
        // matching line during trigger processing (just appended) and any
        // history line the cursor was moved to.
        const line = this.getConsole(windowName)?.getLine() ?? '';

        let count = 0;
        let searchFrom = 0;
        while (searchFrom <= line.length - str.length) {
            const idx = line.indexOf(str, searchFrom);
            if (idx === -1) break;
            count++;
            if (count === occurrence) {
                this.selection = { windowName, start: idx, length: str.length };
                return idx;
            }
            searchFrom = idx + str.length;
        }
        return -1;
    }

    /**
     * Mudlet `selectSection([window,] from, length) → bool`. `from` is 0-indexed.
     * Negative `from` is rejected (Mudlet behavior); zero/negative lengths
     * register a no-op selection but still report success in Mudlet — we match
     * that, but reject when the resolved buffer doesn't exist.
     */
    selectSection(from: number, length: number, windowName?: string): boolean {
        if (!Number.isFinite(from) || from < 0) return false;
        if (!Number.isFinite(length) || length < 0) return false;
        const buf = this.resolveBuffer(windowName);
        if (!buf) return false;
        // Mudlet clamps a selection to the buffer: a `from` at/past the end of a
        // non-empty line refers to the last character (so e.g. selectSection at
        // column == line length still selects one char) rather than an empty,
        // format-less selection.
        const bufLen = buf.length;
        const start = bufLen > 0 && from >= bufLen ? bufLen - 1 : from;
        this.selection = { windowName, start, length };
        return true;
    }

    /**
     * Mudlet `selectCurrentLine([window])`. Selects the entire cursor line —
     * equivalent to `selectSection(0, #getCurrentLine())`. Returns false when
     * the named window doesn't exist; true otherwise (the main window always
     * exists, even with no history yet).
     */
    selectCurrentLine(windowName?: string): boolean {
        if (!this.consoleExists(windowName)) return false;
        const line = this.getConsole(windowName)?.getLine() ?? '';
        this.selection = { windowName, start: 0, length: line.length };
        return true;
    }

    /**
     * Mudlet `deselect([windowName])`. With a window name, only clears the
     * selection if it belongs to that window — selections in other consoles
     * remain intact. Without an arg, clears unconditionally.
     */
    deselect(windowName?: string): void {
        if (windowName !== undefined && !this.selectionMatches(windowName)) return;
        this.selection = null;
    }

    /**
     * Mudlet `getSelection([windowName])`. Returns the currently selected text
     * along with its 0-based start column and length on the active line. Returns
     * null when no selection is set, or when `windowName` is given and doesn't
     * match the selection's window — the Lua wrapper translates null into
     * Mudlet's `false, "no selection"` 2-tuple.
     */
    getSelection(windowName?: string): { text: string; start: number; length: number } | null {
        if (!this.selection) return null;
        if (windowName !== undefined && !this.selectionMatches(windowName)) return null;
        const buf = this.resolveBuffer(this.selection.windowName);
        if (!buf) return null;
        const { start, length } = this.selection;
        return { text: buf.text.slice(start, start + length), start, length };
    }

    /**
     * Mudlet `getFgColor([window])` / `getBgColor([window])`. Reads the fg/bg
     * color at the current selection's start position (Mudlet's P_begin). Each
     * console tracks its own selection in Mudlet; mudix has a single global
     * selection, so when `window` is given it must match the selection's
     * owning window — otherwise we treat it as "no selection in that window"
     * and return null (Mudlet's "no values" shape, surfaced as nil/nil/nil in
     * Lua via the Bridge wrapper).
     *
     * Mudlet returns 0 values when the cursor sits past the end of the line;
     * we mirror that for an empty buffer or a selection whose start is at/
     * past the buffer length. For valid positions where the segment carries
     * no explicit color, we resolve to the profile's default text/background
     * (matching Mudlet's behavior that every TChar carries baked-in colors).
     */
    getFgColor(windowName?: string): [number, number, number] | null {
        return this.readSelectionColor('foreground', windowName);
    }

    getBgColor(windowName?: string): [number, number, number] | null {
        return this.readSelectionColor('background', windowName);
    }

    /**
     * Mudlet `isAnsiFgColor(ansiColor)` / `isAnsiBgColor(ansiColor)`. True when
     * the foreground/background color at the current selection's start equals
     * ANSI/xterm color index `ansiColor` (0..7 normal, 8..15 bright, 16..255 the
     * xterm-256 palette). mudix stores rendered RGB rather than the original
     * ANSI index, so the comparison is against the palette entry's RGB — exact
     * for the 256 standard slots. Returns false when there's no selection (or it
     * belongs to another window) or `ansiColor` is out of range.
     */
    isAnsiFgColor(ansiColor: number): boolean {
        return this.matchesAnsiColor('foreground', ansiColor);
    }

    isAnsiBgColor(ansiColor: number): boolean {
        return this.matchesAnsiColor('background', ansiColor);
    }

    private matchesAnsiColor(channel: 'foreground' | 'background', ansiColor: number): boolean {
        const rgb = this.readSelectionColor(channel, undefined);
        if (!rgb) return false;
        const target = parseHexToRgb(ansiIndexToHex(ansiColor) ?? undefined);
        if (!target) return false;
        return rgb[0] === target[0] && rgb[1] === target[1] && rgb[2] === target[2];
    }

    private readSelectionColor(
        channel: 'foreground' | 'background',
        windowName: string | undefined,
    ): [number, number, number] | null {
        if (!this.selection) return null;
        if (!this.selectionMatches(windowName)) return null;
        const sel = this.selection;
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return null;
        if (sel.start < 0 || sel.start >= buf.length) return null;
        return this.readColorAt(buf, sel.start, channel);
    }

    /**
     * Resolve the rgb of `channel` for the character at `pos` in `buf`, falling
     * back to the profile's configured default when the run carries no explicit
     * colour. Shared by getFgColor/getBgColor (selection) and getTextFormat
     * (selection or cursor).
     */
    private readColorAt(
        buf: AnsiAwareBuffer,
        pos: number,
        channel: 'foreground' | 'background',
    ): [number, number, number] {
        const state = buf.getStateAt(pos);
        const color = channel === 'foreground' ? state?.foreground : state?.background;
        const rgb = formatColorToRgb(color);
        if (rgb) return rgb;
        if (channel === 'background') {
            const override = selectProfileField(useAppStore.getState(), this.connectionId, 'outputBackgroundColor');
            if (override) return [override.r, override.g, override.b];
            const themed = parseHexToRgb(selectProfileField(useAppStore.getState(), this.connectionId, 'outputBackground'));
            return themed ?? DEFAULT_BG_RGB;
        }
        const themed = parseHexToRgb(selectProfileField(useAppStore.getState(), this.connectionId, 'outputForeground'));
        return themed ?? DEFAULT_FG_RGB;
    }

    /**
     * Mudlet `getTextFormat([windowName]) → table | nil, errMsg`. Reads the full
     * set of display attributes of the character at the current selection's start
     * position (Mudlet's "char under cursor or selection"). Mirrors getFgColor /
     * getBgColor: requires an active selection that, when `windowName` is given,
     * belongs to that window, and whose start is within the buffer — otherwise
     * returns null (surfaced as nil + reason by the Bridge wrapper).
     *
     * `foreground`/`background` resolve through the same logic as getFgColor /
     * getBgColor (falling back to the profile defaults for unstyled segments).
     * `overline`, `concealed`, and `alternateFont` have no equivalent in mudix's
     * FormatState, so they report Mudlet's "off" values (false / 0) for parity.
     */
    getTextFormat(windowName?: string): {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        strikeout: boolean;
        reverse: boolean;
        overline: boolean;
        concealed: boolean;
        alternateFont: number;
        blinking: 'none' | 'slow' | 'fast';
        foreground: [number, number, number];
        background: [number, number, number];
    } | null {
        // Mudlet reads the char "under the cursor or selection": prefer an active
        // selection, otherwise fall back to the cursor position on the current
        // line (so getTextFormat works after a bare moveCursor, no selectSection).
        let buf: AnsiAwareBuffer | null;
        let pos: number;
        if (this.selection && this.selectionMatches(windowName)) {
            buf = this.resolveBuffer(this.selection.windowName);
            pos = this.selection.start;
        } else {
            const con = this.getConsole(windowName);
            buf = con?.getBuffer() ?? null;
            pos = con?.getCursorColumn() ?? 0;
        }
        if (!buf || buf.length === 0 || pos < 0) return null;
        if (pos >= buf.length) pos = buf.length - 1; // clamp to the last char
        const foreground = this.readColorAt(buf, pos, 'foreground');
        const background = this.readColorAt(buf, pos, 'background');
        const state = buf.getStateAt(pos);
        return {
            bold: !!state?.bold,
            italic: !!state?.italic,
            underline: !!state?.underline,
            strikeout: !!state?.strikethrough,
            reverse: !!state?.inverse,
            overline: !!state?.overline,
            concealed: false,
            alternateFont: 0,
            blinking: state?.rapidBlink ? 'fast' : state?.slowBlink ? 'slow' : 'none',
            foreground,
            background,
        };
    }

    applyFormatToSelection(state: FormatStateSnapshot): void {
        this.applyStateToSelection(state);
    }

    /**
     * Mudlet `setLink([windowName], command, hint)`. Applies a clickable
     * hyperlink to the current selection — preserves existing colors/attributes
     * on each segment (unlike setFgColor & friends which homogenize). `command`
     * is the Lua code run on click; the Bridge.lua wrapper converts function
     * arguments into a `__mudix_call_link(id)` string before reaching here.
     * Returns false if there is no selection (or it doesn't belong to `win`).
     */
    setLink(cmd: string, tooltip: string, win?: string): boolean {
        if (!this.selection) return false;
        if (win !== undefined && !this.selectionMatches(win)) return false;
        const sel = this.selection;
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return false;
        const hyperlink: FormatHyperlink = {
            onClick: () => { this.host.runLinkCode(cmd); },
            title: tooltip || undefined,
        };
        buf.setHyperlink([sel.start, sel.start + sel.length], hyperlink);
        if (!this.inTriggerProcessing) buf.rerender();
        return true;
    }

    // ── Trigger pipeline hooks (called by ScriptingEngine) ────────────────────

    /**
     * Called before trigger processing for each incoming line. Pushes the
     * matching line into mainConsole.history so cursor-driven APIs see it as
     * a regular addressable line (Mudlet's TBuffer holds the matching line
     * during trigger processing — the cursor is just an (x,y) into that
     * single buffer). The cursor is automatically positioned on the new line
     * at column 0 by Console.appendLine. Also enables echo deferral so
     * trigger-emitted echoes appear after the rendered line.
     */
    beginLine(buffer: AnsiAwareBuffer, isPrompt = false): void {
        buffer.isPrompt = isPrompt;
        // Snapshot the colours the SERVER sent, before any trigger runs. Mudlet
        // matches colour triggers against the line as it arrived, so a trigger
        // that recolours the line cannot change what a later (or nested) colour
        // trigger sees — while the display still shows the recoloured version.
        // Pushed, not assigned: a trigger may call feedTriggers itself, and the
        // outer line's snapshot has to survive the nested pass.
        this.lineColorSnapshots.push(buffer.getSegments().map(seg => ({
            fg: ansiPaletteIndex(seg.state?.foreground),
            bg: ansiPaletteIndex(seg.state?.background),
            text: seg.text ?? '',
        })));
        this.mainConsole.appendLine(buffer);
        this.inTriggerProcessing = true;
        this.selection = null;
        this.isDeferringEcho = true;
        this.echoOnMatchedLine = true;
        // The trigger cursor sits at the end of the matched line (Mudlet fires
        // before the line's terminator), so a trigger's `cecho("\n text")`
        // should advance to a fresh line rather than emit a leading blank row.
        this.mainConsole.markCursorAtEnd();
    }

    /**
     * Called after all triggers for a line have run (but before render).
     * Drops the trigger-active flag; echo deferral stays on until
     * flushDeferredEcho() is called.
     */
    endLine(): void {
        this.lineColorSnapshots.pop();
        // A line a trigger gagged leaves the buffer as well as the screen.
        // deleteLine() during trigger processing only marks the line (the
        // render pass reads the flag), so the buffer kept a line the player
        // could not see — getLines/getLineCount/the cursor all still counted it,
        // and `deleteFull()` looked like it had done nothing.
        if (this.mainConsole.getBuffer()?.deleted) this.mainConsole.deleteLine();
        this.inTriggerProcessing = false;
        this.echoOnMatchedLine = false;
        // NB: the trigger selection is intentionally NOT cleared here. Mudlet
        // leaves a selection made inside a trigger in place, so a script can read
        // it back via getSelection() after the line is processed (e.g. UI_spec's
        // nested-trigger test inspects the selection after feedTriggers). beginLine
        // resets it at the start of the next line, so it never leaks across lines.
        // Clear the leading-newline latch so it can't leak onto a later echo
        // (timer/alias output) if this line's triggers never echoed.
        this.mainConsole.markCursorAtEnd(false);
    }

    /**
     * Mudlet `tempColorTrigger(fg, bg)` colour-scan helper. Walks the
     * just-appended line buffer (the one beginLine() seeded mainConsole with)
     * and returns true if any segment carries the requested ANSI palette
     * indices. `wantFg`/`wantBg` accept -1 as "any colour"; non-indexed
     * (RGB) segments never match a positive index, matching Mudlet's
     * palette-only semantics.
     */
    currentLineMatchesColor(wantFg: number, wantBg: number): boolean {
        return this.currentLineColorMatch(wantFg, wantBg) !== null;
    }

    /**
     * The text of the first run on the current line carrying the wanted ANSI
     * colours, or null when none does. A colour trigger reports that run as
     * `matches[1]` — Mudlet matches a contiguous same-coloured run, not the
     * whole line — so adjacent segments sharing the colours are joined.
     *
     * Reads the snapshot beginLine took, not the live buffer: an earlier trigger
     * may already have recoloured the line, and Mudlet still matches against the
     * colours the server sent.
     */
    currentLineColorMatch(wantFg: number, wantBg: number): string | null {
        const snapshot = this.lineColorSnapshots[this.lineColorSnapshots.length - 1];
        if (!snapshot) return null;
        let run: string | null = null;
        for (const seg of snapshot) {
            const hit = (wantFg === -1 || seg.fg === wantFg)
                && (wantBg === -1 || seg.bg === wantBg);
            if (hit && seg.text) run = (run ?? '') + seg.text;
            else if (run !== null) return run;
        }
        return run;
    }

    /** Per-segment ANSI palette indices (and text) of each line currently being
     *  processed, as it arrived — see {@link beginLine}. -2 marks a segment with
     *  no palette colour (RGB or default), which never matches a requested
     *  index. A stack, because a trigger can feedTriggers another line. */
    private lineColorSnapshots: { fg: number; bg: number; text: string }[][] = [];

    /**
     * Flush echo output collected during the just-processed line's trigger run.
     * Called once per line (right after that line is rendered) so a trigger's
     * `echo`/`cecho` lands immediately after the line it fired on — matching
     * Mudlet, where the trigger cursor sits on the matching line and echoed text
     * is inserted there, not piled at the end of the whole flush batch.
     *
     * Emits the completed echo lines, then promotes any trailing partial (an
     * echo without a closing newline, e.g. `cecho("\n text")`) into its own
     * line via `completePartialLine` — which preserves history so later lines in
     * the batch keep correct line numbers, unlike the old wholesale `clear()`.
     */
    flushDeferredEcho(): void {
        this.isDeferringEcho = false;
        for (const line of this.echoDeferred) {
            this.session.events.emit('message', line, 'trigger-echo');
        }
        this.echoDeferred = [];
        const partial = this.mainConsole.completePartialLine();
        if (partial) {
            this.session.events.emit('message', partial, 'trigger-echo');
        }
        this.session.windows.flushAllLines();
    }

    // ── Triggers ──────────────────────────────────────────────────────────────

    /** Raw tail of the last {@link feedTriggers} call that had no trailing
     *  newline, carried into the next one — see there. */
    private feedTriggersRemainder = '';

    /**
     * Feed `text` through the trigger pipeline as if it arrived from the MUD.
     * Routes complete lines through ScriptingEngine.processFlushBatch (same
     * code path as network-driven flushLines) so trigger ordering, ANSI carry,
     * and deferred-echo placement match exactly.
     */
    feedTriggers(text: string): boolean {
        // Trigger reloads are coalesced onto a microtask, which cannot run while
        // the calling Lua chunk is still on the stack. Mudlet applies perm* and
        // enable/disableTrigger immediately, so a script that creates or toggles
        // a trigger and feeds a line in the same chunk must see the new state.
        this.host.flushPendingApplies();
        // A line the caller left unterminated is carried, as RAW text, into the
        // next call: Mudlet feeds every call into the same TBuffer, so an escape
        // sequence split across two feedTriggers is still parsed as one. Only
        // re-joining the raw bytes reproduces that — the rendered partial has
        // already lost the half-consumed sequence. It stays on screen meanwhile
        // (echoed below) and is re-emitted from the batch once completed, which
        // is why the display copy is cleared before the batch runs.
        const lines = (this.feedTriggersRemainder + text).split('\n');
        const remainder = lines[lines.length - 1];
        const completeLines = lines.slice(0, -1);
        this.feedTriggersRemainder = remainder;

        if (completeLines.length === 0) {
            // Only the new bytes: whatever was carried in is already displayed.
            this.mainConsole.echo(text);
            this.drainMain();
            const partial = this.mainConsole.currentPartial;
            if (partial.length > 0) this.session.events.emit('message', partial, 'script-partial');
            return true;
        }

        // Drop any stray partial left by direct echo() calls (and the displayed
        // copy of the carried-over remainder, which the batch below re-emits) so
        // trigger echo accumulates fresh during batch processing — but keep
        // history, so successive feedTriggers calls accumulate lines the way
        // Mudlet appends fed text to the buffer (a full clear() would strand
        // earlier lines).
        this.mainConsole.clearPartial();

        // With no engine bound yet (early init) the default host falls back to
        // emitting a raw flushLines event.
        this.host.processFlushBatch([{ text: completeLines.join('\n'), type: 'mud' }]);

        if (remainder) {
            this.mainConsole.echo(remainder);
            this.drainMain();
        }
        const partial = this.mainConsole.currentPartial;
        if (partial.length > 0) this.session.events.emit('message', partial, 'script-partial');
        // Mudlet answers true once the text has been handed to the display.
        return true;
    }

    // ── Cursor / line access ──────────────────────────────────────────────────

    /**
     * Mudlet `getCurrentLine([window])`. Returns the text on the cursor's
     * current line, or `null` when the named window doesn't exist — the Lua
     * binding turns that into Mudlet's `(nil, errMsg)` 2-tuple. Falls back to
     * an empty string for the main window (always present, may have no line yet).
     */
    getCurrentLine(windowName?: string): string | null {
        if (!this.consoleExists(windowName)) return null;
        return this.getConsole(windowName)?.getLine() ?? '';
    }

    // Mudlet line-index APIs are 0-indexed: getLineNumber() == cursor.y() and
    // getLastLineNumber() == size - 1, where `size` counts the always-open line
    // Mudlet's buffer keeps past the last complete one. getLineCount() is the
    // count of *complete* lines, so it comes out one lower — which is why the
    // two are equal rather than off by one, and why a buffer-scan loop
    // `for i = getLineCount() - 1, 0, -1` starts on the last complete line.
    //
    // mudix's history holds only complete lines, so Console.getLineCount()
    // (history.length - 1) is the last complete index and both Lua-facing
    // numbers add one to reach Mudlet's convention. Missing windows report -1
    // (Mudlet's "no such window" sentinel).
    getLineNumber(windowName?: string): number {
        return this.getConsole(windowName)?.getLineNumber() ?? -1;
    }

    getLineCount(windowName?: string): number {
        const con = this.getConsole(windowName);
        return con ? con.getLineCount() + 1 : -1;
    }

    getLastLineNumber(windowName?: string): number {
        const con = this.getConsole(windowName);
        return con ? con.getLineCount() + 1 : -1;
    }

    // ── Scrolling / scrollbars ────────────────────────────────────────────────
    // Mudlet hides/shows the gutter for the named console (or "main") and
    // independently toggles whether the user can scroll back at all. The
    // [Horizontal]ScrollBar pair only affects the gutter; the Scrolling pair
    // also blocks wheel/key scrolling. Mudlet forbids disable/enableScrolling
    // on the main window — we keep that policy (the binding hands Lua `false`).

    disableScrollBar(windowName?: string): void {
        this.session.windows.setScrollBarVisible(windowName ?? 'main', false);
    }
    enableScrollBar(windowName?: string): void {
        this.session.windows.setScrollBarVisible(windowName ?? 'main', true);
    }
    disableHorizontalScrollBar(windowName?: string): void {
        this.session.windows.setHorizontalScrollBarVisible(windowName ?? 'main', false);
    }
    enableHorizontalScrollBar(windowName?: string): void {
        this.session.windows.setHorizontalScrollBarVisible(windowName ?? 'main', true);
    }
    disableScrolling(windowName?: string): boolean {
        return this.session.windows.setScrollingEnabled(windowName ?? 'main', false);
    }
    enableScrolling(windowName?: string): boolean {
        return this.session.windows.setScrollingEnabled(windowName ?? 'main', true);
    }

    /** Mudlet `timeStampsEnabled(window)` — whether the console shows its
     *  timestamp column. Null when no such window exists. */
    timeStampsEnabled(windowName: string): boolean | null {
        return this.session.windows.timeStampsEnabled(windowName);
    }

    /** Mudlet `enableTimeStamps(window)` / `disableTimeStamps(window)`. False
     *  when no such window exists. */
    setTimeStamps(windowName: string, visible: boolean): boolean {
        return this.session.windows.setTimeStamps(windowName, visible);
    }

    /** Mudlet `scrollingActive([window])` — whether the user can scroll back in
     *  this console. True unless disableScrolling was called on it; the main
     *  window is always scrollable. */
    scrollingActive(windowName?: string): boolean {
        return this.session.windows.isScrollingEnabled(windowName ?? 'main');
    }

    /** Mudlet getScroll — 0-indexed buffer line at the top of the viewport. In
     *  tail mode reports the last line (Mudlet's mCursorY behaviour at end). */
    getScroll(windowName?: string): number {
        const name = windowName ?? 'main';
        // getScrollLine measures the DOM, and a console whose panel hasn't been
        // laid out measures as 0 — which would claim a 30-line buffer is
        // scrolled to the very top. Nothing has scrolled it, so it is at the
        // tail: report the last line, the same answer tail mode gives.
        if (!this.session.windows.canMeasureScroll(name)) {
            return Math.max(0, this.getLastLineNumber(name));
        }
        return this.session.windows.getScrollLine(name);
    }

    /** Mudlet scrollTo. With no line (or a line past end), resume tail mode.
     *  Negative line counts back from the buffer end. */
    scrollTo(windowName: string | undefined, lineNumber: number | undefined): boolean {
        return this.session.windows.scrollToLine(windowName ?? 'main', lineNumber);
    }

    getLines(from: number, to: number, windowName?: string): string[] {
        return this.getConsole(windowName)?.getLines(from, to) ?? [];
    }

    /**
     * Mudlet `getTimestamp([window,] lineNumber)` — the wall-clock time the line
     * entered the buffer, formatted "HH:MM:SS.mmm" (Mudlet's "hh:mm:ss.zzz").
     * `lineNumber` is 1-based to match `getLines`; omit it for the current
     * cursor line. Returns null when the window or line doesn't exist — the Lua
     * binding maps that to Mudlet's `(nil, errMsg)` shape.
     */
    getTimestamp(lineNumber?: number, windowName?: string): string | null {
        if (!this.consoleExists(windowName)) return null;
        const ms = this.getConsole(windowName)?.getLineTimestamp(lineNumber) ?? null;
        return ms == null ? null : formatLineTimestamp(ms);
    }

    /**
     * Mudlet `wrapLine([window,] lineNumber)`. Re-displays the line at
     * `lineNumber` (0-indexed, like getLineNumber/getLineCount), re-interpreting
     * its embedded `\n` and re-wrapping to the current width. Returns false when
     * the window or line doesn't exist.
     */
    wrapLine(lineNumber: number, windowName?: string): boolean {
        const con = this.getConsole(windowName);
        if (!con) return false;
        const isMain = !windowName || windowName === 'main';
        const state = useAppStore.getState();
        const wrapAt = isMain
            ? (selectProfileField(state, this.connectionId, 'outputWrapAt') ?? 0)
            : (this.session.windows.getWrap(windowName!) ?? 0);
        const indent = isMain
            ? (selectProfileField(state, this.connectionId, 'outputWrapIndent') ?? 0)
            : this.session.windows.getWrapIndent(windowName!);
        const hanging = isMain
            ? (selectProfileField(state, this.connectionId, 'outputWrapHangingIndent') ?? 0)
            : this.session.windows.getWrapHangingIndent(windowName!);
        if (!con.wrapLine(lineNumber, wrapAt, indent, hanging)) return false;
        if (isMain) this.drainMain();
        else this.drainWindowConsole(windowName!, con);
        return true;
    }

    /**
     * Mudlet `getConsoleBufferSize([consoleName])` → (linesLimit, batchSize).
     * Returns `null` when the named console doesn't exist so the Lua binding can
     * hand back nil.
     */
    getConsoleBufferSize(windowName?: string): [number, number] | null {
        const con = this.getConsole(windowName);
        if (!con) return null;
        return [con.maxLines, con.batchDeleteSize];
    }

    /**
     * Mudlet `setConsoleBufferSize([consoleName], linesLimit, sizeOfBatchDeletion)`.
     * Sets the scrollback cap (and the round-tripped batch-deletion size).
     * Returns false when the named console doesn't exist.
     */
    setConsoleBufferSize(
        windowName: string | undefined,
        linesLimit: number,
        batchSize?: number,
        useMaximum = false,
    ): boolean {
        const con = this.getConsole(windowName);
        if (!con) return false;
        // Mudlet clamps rather than refuses: a limit under the floor would make
        // the buffer useless, and a batch that isn't smaller than the limit
        // would empty it on the first trim.
        const limit = useMaximum
            ? MAX_CONSOLE_BUFFER_LINES
            : Math.max(MIN_CONSOLE_BUFFER_LINES, Math.floor(linesLimit));
        if (Number.isFinite(limit) && limit > 0) con.setMaxLines(limit);
        if (batchSize !== undefined && Number.isFinite(batchSize) && batchSize > 0) {
            const batch = batchSize >= limit ? Math.floor(limit / 10) : Math.floor(batchSize);
            con.setBatchDeleteSize(Math.max(1, batch));
        }
        return true;
    }

    getColumnNumber(windowName?: string): number {
        // Mudlet's mUserCursor.x() — just the cursor's column on the cursor's
        // current line. Console owns the persistent column cursor for both
        // history and the in-flight matching line.
        return this.getConsole(windowName)?.getCursorColumn() ?? 0;
    }

    /** Mudlet `isPrompt()` — reports the per-line prompt flag at the current
     *  cursor position. Lines pushed via beginLine carry the flag, so
     *  moveCursor + isPrompt can inspect historical lines, not just the most
     *  recent one. Defaults to false for the main window when no history exists. */
    isPrompt(windowName?: string): boolean {
        return this.getConsole(windowName)?.cursorOnPrompt() ?? false;
    }

    /**
     * Mudlet getColumnCount. Reports the displayable column capacity of the
     * rendered output area — how many monospace characters fit horizontally.
     * Unaffected by setWindowWrap; that controls where lines wrap when text is
     * appended to the buffer, not the screen width. Returning the wrap value
     * would break the canonical Mudlet idiom
     *   setWindowWrap(name, getColumnCount(name) - 1)
     * called from a sysUserWindowResizeEvent handler, where each resize would
     * otherwise feed the stored wrap back in and decrement it by one.
     *
     * Fallback path: scripts that just called openUserWindow + resizeWindow
     * commonly busy-loop on getColumnCount in the same JS turn — React can't
     * render the new panel until the loop yields, so a pure DOM measurement
     * stays at 0 forever and the loop hangs. When the window exists but the
     * element hasn't mounted (or measures zero), derive an estimate from the
     * window's logical pixel width and the active font's cell width, so the
     * reported column count tracks resizeWindow even before layout commits.
     */
    getColumnCount(windowName?: string): number {
        const isMain = !windowName || windowName === 'main';
        const el = isMain
            ? this.session.windows.getElement('main')
            : this.session.windows.getElement(windowName!);
        const measured = measureColumnCapacity(el);
        if (measured > 0) return measured;
        if (isMain) return 0;

        const size = this.session.windows.getSize(windowName!);
        if (!size || size.width <= 0) return 0;
        const profileFamily = selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont')?.family ?? '';
        const profileSize   = selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize') ?? 12;
        const family = this.session.windows.getFont(windowName!) ?? profileFamily;
        const fontSize = this.session.windows.getFontSize(windowName!) ?? profileSize;
        const [cellW] = measureMonospaceCell(family, fontSize);
        if (cellW <= 0) return 0;
        // Match the gutter/padding measureColumnCapacity would subtract once
        // the element mounts (~8px per side on text panels).
        const usable = Math.max(0, size.width - 16);
        return Math.floor(usable / cellW);
    }

    /**
     * Mudlet getRowCount(name). Reports the displayable row capacity of the
     * named window (or "main") — how many text lines fit vertically in the
     * rendered area. Mirrors getColumnCount: measures the live element, and
     * falls back to a font-derived estimate from the stored window height when
     * the panel hasn't mounted yet (so resize+busy-loop scripts don't hang).
     */
    getRowCount(windowName?: string): number {
        const isMain = !windowName || windowName === 'main';
        const el = isMain
            ? this.session.windows.getElement('main')
            : this.session.windows.getElement(windowName!);

        const profileFamily = selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont')?.family ?? '';
        const profileSize   = selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize') ?? 12;
        const family = (isMain ? null : this.session.windows.getFont(windowName!)) ?? profileFamily;
        const fontSize = (isMain ? null : this.session.windows.getFontSize(windowName!)) ?? profileSize;
        const [, cellH] = measureMonospaceCell(family, fontSize);
        if (cellH <= 0) return 0;

        if (el) {
            const cs = getComputedStyle(el);
            const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
            const height = Math.max(0, el.clientHeight - pad);
            if (height > 0) return Math.floor(height / cellH);
        }
        if (isMain) return 0;

        const size = this.session.windows.getSize(windowName!);
        if (!size || size.height <= 0) return 0;
        return Math.floor(size.height / cellH);
    }

    /**
     * Mudlet setWindowWrap(name, charsPerLine). Sets the visual wrap width
     * (in monospace columns) for the named window or "main". 0 clears the
     * setting. Returns false when the named window does not exist; main always
     * succeeds (persisted on the active profile).
     */
    setWindowWrap(name: string, wrapAt: number): boolean {
        if (!Number.isFinite(wrapAt)) return false;
        const v = Math.max(0, Math.round(wrapAt));
        if (!name || name === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputWrapAt: v > 0 ? v : undefined });
            return true;
        }
        return this.session.windows.setWrap(name, v);
    }

    /**
     * Mudlet `getWindowWrap(name) → cols`. Reports the visual wrap width set by
     * setWindowWrap (0 when unset). For "main" reads the profile's stored
     * override; for a named window reads the WindowManager hint. Returns -1 when
     * the named window does not exist (Mudlet's invalid-window sentinel).
     */
    getWindowWrap(name: string): number {
        if (!name || name === 'main') {
            return selectProfileField(useAppStore.getState(), this.connectionId, 'outputWrapAt') ?? 0;
        }
        if (!this.session.windows.has(name)) return -1;
        return this.session.windows.getWrap(name) ?? 0;
    }

    /**
     * Mudlet `setWindowWrapIndent(name, indent)`. Sets the indent (in
     * characters) applied to newline-started lines in the named window or
     * "main". Returns false when the named window does not exist.
     */
    setWindowWrapIndent(name: string, indent: number): boolean {
        if (!Number.isFinite(indent)) return false;
        const v = Math.max(0, Math.round(indent));
        if (!name || name === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputWrapIndent: v > 0 ? v : undefined });
            return true;
        }
        return this.session.windows.setWrapIndent(name, v);
    }

    /**
     * Mudlet `setWindowWrapHangingIndent(name, indent)`. Sets the indent (in
     * characters) applied to wrapped continuation lines in the named window or
     * "main". Returns false when the named window does not exist.
     */
    setWindowWrapHangingIndent(name: string, indent: number): boolean {
        if (!Number.isFinite(indent)) return false;
        const v = Math.max(0, Math.round(indent));
        if (!name || name === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputWrapHangingIndent: v > 0 ? v : undefined });
            return true;
        }
        return this.session.windows.setWrapHangingIndent(name, v);
    }

    /**
     * Mudlet `setMapWindowTitle(title)`. Sets the dockable map panel's tab
     * title; an empty string resets it to the default ("Map"). Returns false
     * when the map widget isn't open.
     */
    setMapWindowTitle(title: string): boolean {
        const t = title && title.length ? title : undefined;
        return this.session.windows.setTitle(MAP_WIDGET_ID, t);
    }

    /**
     * Mudlet `insertText([window,] text)`. Inserts `text` at the cursor on
     * the cursor's current line — works the same way during trigger processing
     * (cursor is on the just-appended matching line) and outside (cursor is
     * wherever moveCursor put it). Falls back to an end-of-buffer echo only
     * when the cursor isn't on a valid line yet (empty buffer / sub-window
     * without a backing buffer).
     */
    insertText(text: string, windowName?: string): void {
        const isMain = !windowName || windowName === 'main';
        const con = this.getConsole(windowName);
        const buf = con?.getBuffer();
        if (con && buf) {
            const state = con.format.toSnapshot();
            // Console.insertText splits on embedded '\n' into new history lines
            // (Mudlet #8945); for the single-line case it inserts in place.
            con.insertText(text, state);
            if (!this.inTriggerProcessing) con.getBuffer()?.rerender();
            return;
        }
        // No current line: degrade to an echo so the text isn't lost.
        if (isMain) {
            this.mainConsole.echo(text);
            this.drainMain();
        } else {
            this.echoToWindow(windowName!, text);
        }
    }

    /**
     * Mudlet `insertLink([window,] text, cmd, hint, [useCurrentFormat])`.
     * Like `insertText` but the inserted span is a clickable link bound to
     * `cmd`. With `useCurrentFormat=false` (the default) the link inherits
     * Mudlet's built-in style — blue foreground + underline — layered on top
     * of the current pen state. If no buffer is available (empty console,
     * sub-window without backing buffer) the call degrades to `echoLink` so
     * the text isn't lost.
     */
    insertLink(text: string, cmd: string, tooltip: string, windowName?: string, useCurrentFormat = false): void {
        if (!text) return;
        const con = this.getConsole(windowName);
        const buf = con?.getBuffer();
        if (con && buf) {
            const state: FormatStateSnapshot = con.format.toSnapshot();
            state.hyperlink = {
                onClick: () => { this.host.runLinkCode(cmd); },
                title: tooltip || undefined,
            };
            if (!useCurrentFormat) {
                state.foreground = { space: 'rgb', r: 0, g: 0, b: 255 };
                state.underline = true;
            }
            const at = Math.max(0, Math.min(con.getCursorColumn(), buf.text.length));
            buf.insert(at, text, state);
            if (!this.inTriggerProcessing) buf.rerender();
            return;
        }
        this.echoLink(text, cmd, tooltip, windowName, useCurrentFormat);
    }

    /**
     * Mudlet `moveCursorUp([window,] [lines=1,] [keepHorizontal=false]) → bool`.
     * `keepHorizontal=true` preserves the column across the vertical move; the
     * default (false) resets the column to 0.
     */
    moveCursorUp(windowName?: string, lines: number = 1, keepHorizontal: boolean = false): boolean {
        return this.getConsole(windowName)?.moveUp(lines, keepHorizontal) ?? false;
    }

    moveCursorDown(windowName?: string, lines: number = 1, keepHorizontal: boolean = false): boolean {
        return this.getConsole(windowName)?.moveDown(lines, keepHorizontal) ?? false;
    }

    /**
     * Mudlet `moveCursor([window,] x, y) → bool`. The cursor is just an (x,y)
     * into the central buffer — works the same way during trigger processing
     * and outside, because the matching line is pushed into Console.history
     * before triggers fire (Mudlet has the same model: matching line is the
     * last line in TBuffer; cursor.y is its index). Returns true on a
     * successful move.
     */
    moveCursor(windowName: string | undefined, x: number, y: number): boolean {
        if (!Number.isFinite(x) || x < 0) return false;
        if (!Number.isFinite(y) || y < 0) return false;
        return this.getConsole(windowName)?.moveTo(y, x) ?? false;
    }

    moveCursorEnd(windowName?: string): void {
        const con = this.getConsole(windowName);
        if (!con) return;
        con.moveToEnd();
        con.setCursorColumn(con.getLine().length);
        con.markCursorAtEnd();
    }

    // ── Window / line management ──────────────────────────────────────────────

    clearWindow(name?: string): void {
        if (!name || name === 'main') {
            // Both halves: the renderer wipes what is on screen, and the buffer
            // behind it is emptied too. Clearing only the view left getLines /
            // getLineCount / the cursor reporting lines the player could no
            // longer see — Mudlet's clearWindow empties the buffer itself.
            this.mainConsole.clear();
            this.session.events.emit('script.clearwindow');
        } else if (this.buffers.has(name)) {
            // Off-screen buffer: WindowManager.clear no-ops (no panel), so clear
            // the backing console directly.
            this.getConsole(name)?.clear();
        } else {
            this.session.windows.clear(name);
        }
    }

    /**
     * Mudlet `createMiniConsole([parent,] name, x, y, width, height)`. Creates
     * a positioned text panel inside the given parent (defaults to `main`), or
     * repositions it if it already exists (Mudlet 3.0+ semantics). When parent
     * is a userwindow, the miniconsole renders inside that parent's viewport
     * at parent-relative coordinates and follows parent moves/resizes.
     * Returns true on success.
     */
    createMiniConsole(name: string, x: number, y: number, width: number, height: number, parent?: string): boolean {
        if (!name) return false;
        const wm = this.session.windows;
        if (!wm.has(name)) {
            wm.open(name, {
                kind: 'text',
                title: name,
                autoDock: false,
                ignoreHint: true,
                parent: parent && parent !== 'main' ? parent : undefined,
            });
        } else {
            wm.show(name);
        }
        wm.markAsMiniConsole(name);
        wm.setPosition(name, Math.round(x), Math.round(y));
        wm.setSize(name, Math.round(width), Math.round(height));
        return true;
    }

    /**
     * Mudlet `deleteMiniConsole(name)`. Destroys a mini-console created by
     * createMiniConsole, freeing its registry/buffer/console state. Restricted
     * to mini-consoles (mirrors Mudlet's CONSOLE-only check) — returns false
     * for the main window, dockable panels, or an unknown name.
     */
    deleteMiniConsole(name: string): boolean {
        if (!name || name === 'main') return false;
        // A user window counts: Geyser's UserWindow:delete goes through
        // MiniConsole.type_delete, which calls this — a user window is a
        // miniconsole with a dock around it, and refusing here left the window
        // on screen and still answering windowType() after it was deleted.
        if (!this.session.windows.isMiniConsole(name) && !this.session.windows.has(name)) return false;
        this.session.windows.close(name);
        this.host.raiseEvent('sysMiniConsoleDeleted', [name]);
        return true;
    }

    /**
     * MXP `<FRAME>` (Mudlet 4.21). All the layout thinking lives in
     * {@link MxpFrameManager}, a port of Mudlet's TMxpFrameManager — edge tiling
     * with accumulating borders, `<DEST>`-nested sub-frames, `TITLE` tab headers
     * and `DOCK` tab groups. This just owns the manager and satisfies its host
     * interface below. `dest` is the `<DEST>` frame open when the tag was parsed.
     */
    mxpFrame(name: string, attrs: Record<string, string>, dest?: string): void {
        if (!name) return;
        this.mxpFrames.createFrame(name, attrs, dest);
    }

    /** Tear every MXP frame down. MXP frames are per-connection state in Mudlet
     *  (TMxpFrameManager::resetAllFrames), so a reconnect starts from a clean
     *  main window rather than inheriting the last session's layout. */
    mxpResetFrames(): void {
        this.mxpFrames.resetAllFrames();
        this.mxpReplacedFrames.clear();
    }

    /**
     * Write an MXP `<DEST>` redirected line into a frame's console. Returns
     * false when no such frame exists (the caller then renders the text inline
     * in the main window, matching Mudlet). `eof` clears the frame first — the
     * status-frame "replace contents" idiom.
     */
    mxpWriteToFrame(name: string, buffer: AnsiAwareBuffer, eof: boolean): boolean {
        if (!this.mxpFrames.has(name)) return false;
        const id = mxpWindowId(name);
        if (eof) {
            this.clearWindow(id);
            if (!this.mxpReplacedFrames.has(name)) {
                this.mxpReplacedFrames.add(name);
                this.session.windows.setTopAnchored(id, true);
            }
        }
        this.session.windows.pushBuffer(id, buffer);
        // A frame the server rewrites wholesale is a pane, not a scrollback, so
        // hold it at the first row. Such a redraw arrives over several network
        // flushes (eden sends ~12 map rows across two), and a console that
        // follows the tail slides as the rows land and snaps back on the next
        // clear — the "jumping" a fixed pane must not do.
        if (this.mxpReplacedFrames.has(name)) this.session.windows.scrollToTop(id);
        return true;
    }

    /** Frames that have been written with `<DEST … EOF>` at least once, i.e. the
     *  server treats them as replace-contents panes. Learned rather than
     *  declared: MXP has no attribute for it. */
    private readonly mxpReplacedFrames = new Set<string>();

    private readonly mxpFrames = new MxpFrameManager({
        // Frames tile in the main window minus the Lua borders. A GUI package
        // that docks a panel to an edge reserves its strip through those —
        // Geyser's `Adjustable.Container{attached=…}` calls setBorderRight and
        // friends — so laying frames out against the raw viewport would put a
        // server's right-hand frame straight on top of the package's panel.
        // The MXP borders themselves are excluded: MxpFrameManager tracks those.
        consoleArea: () => {
            const [w, h] = this.getMainWindowSize();
            const b = this.getBorderSizes();
            return {
                x: b.left,
                y: b.top,
                width: Math.max(0, w - b.left - b.right),
                height: Math.max(0, h - b.top - b.bottom),
            };
        },
        // Matches the row height placeFrameConsole pins the frame's console to,
        // so `Nc` really is N visible rows.
        charCellSize: () => {
            const family = selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont')?.family ?? '';
            const size = selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize') ?? 12;
            const [cellW, cellH] = measureMonospaceCell(family, size);
            return [cellW || 8, cellH || 16];
        },
        placeFrameConsole: (name, x, y, width, height, parent) => {
            const id = mxpWindowId(name);
            if (this.session.windows.isMiniConsole(id)) {
                this.windows.move(id, x, y);
                this.windows.resize(id, width, height);
            } else {
                this.createMiniConsole(id, x, y, width, height, parent && mxpWindowId(parent));
            }
            this.session.windows.markAsMxpFrame(id);
            // Mudlet pins each frame console to the main display's font
            // (TMxpFrameManager: `console->setFontSize(...)`). Without it a frame
            // asked for `20c` of rows is measured with the main font but rendered
            // with the panel default, so the rows overflow the box it was given —
            // which is what puts a scrollbar in a status frame and makes a
            // redrawn map jump as the console scrolls to the bottom.
            const font = selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont');
            const size = selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize') ?? 12;
            if (font?.family) this.session.windows.setFont(id, font.family);
            this.session.windows.setFontSize(id, size);
            // …and to Mudlet's row metric. Consoles normally lay rows out at the
            // stylesheet's roomier line-height; a frame is a fixed box that has
            // to hold the rows the server sized it for, so it uses ascent+descent
            // like TTextEdit::mFontHeight. ~10% tighter, which is the difference
            // between a map fitting and overflowing by a row.
            this.session.windows.setLineHeight(id, measureMonospaceCell(font?.family ?? '', size)[1]);
        },
        openExternalFrame: (name, title, width, height) => {
            this.session.windows.open(mxpWindowId(name), {
                kind: 'text', title, autoDock: false, lockFloating: true, ignoreHint: true, width, height,
            });
        },
        destroyFrameConsole: (name) => this.session.windows.close(mxpWindowId(name)),
        showFrameConsole: (name) => { this.session.windows.show(mxpWindowId(name)); },
        raiseFrameConsole: (name) => this.session.windows.bringToFront(mxpWindowId(name)),
        setFrameScrolling: (name, enabled) => { this.session.windows.setScrollingEnabled(mxpWindowId(name), enabled); },
        setFrameTabs: (name, pages, active) => this.session.windows.setFrameTabs(
            mxpWindowId(name),
            pages.map(p => ({ id: mxpWindowId(p.id), title: p.title })),
            mxpWindowId(active),
        ),
        setMxpBorders: (borders) => this.session.windows.setMxpBorders(borders),
    });

    /**
     * Mudlet `createBuffer(name)`. Registers a named off-screen console for
     * formatting and storing rich text — like a miniconsole, but never shown
     * on screen (no dock panel). echo/cecho/format/selection target it by name;
     * `copy` + `appendBuffer` move formatted text in and out. Idempotent and a
     * no-op when the name is taken by `main` or an existing on-screen window.
     */
    createBuffer(name: string): void {
        if (!name || name === 'main') return;
        if (this.session.windows.has(name)) return;
        this.buffers.add(name);
        // Register the backing console so echo/selection resolve it by name.
        this.outputConsole(name);
    }

    /** True when `name` is an off-screen buffer created via createBuffer. */
    isBuffer(name: string): boolean {
        return this.buffers.has(name);
    }

    /**
     * Mudlet `copy([window])`. Copies the current selection of the resolved
     * console — including all formatting — into the session clipboard, a single
     * rich-text buffer shared with `paste`/`appendBuffer` (Mudlet's host-global
     * mClipboard). No-op when there's no selection, or when `window` is given
     * but doesn't own the active selection.
     */
    copy(windowName?: string): void {
        if (!this.selection) return;
        if (windowName !== undefined && !this.selectionMatches(windowName)) return;
        const buf = this.resolveBuffer(this.selection.windowName);
        if (!buf) return;
        const start = Math.max(0, Math.min(this.selection.start, buf.length));
        const end = Math.max(start, Math.min(this.selection.start + this.selection.length, buf.length));
        const slice = buf.clone();
        slice.remove([end, slice.length]);
        slice.remove([0, start]);
        this.clipboard = slice;
    }

    /**
     * Mudlet `appendBuffer([window])`. Appends the clipboard's rich text (from
     * the last `copy()`) as a new line at the end of the named console's buffer.
     * No-op until something has been copied. Mirrors TConsole::appendBuffer.
     */
    appendBuffer(windowName?: string): void {
        if (!this.clipboard) return;
        const isMain = !windowName || windowName === 'main';
        const con = this.outputConsole(windowName);
        con.appendBuffer(this.clipboard.clone());
        if (isMain) this.drainMain();
        else this.drainWindowConsole(windowName!, con);
    }

    /**
     * Mudlet `paste([window])`. Inserts the clipboard at the cursor's current
     * column when the cursor sits above the last line; otherwise appends it as
     * a new line at the end (TConsole::paste semantics). No-op without a prior
     * copy().
     */
    paste(windowName?: string): void {
        if (!this.clipboard) return;
        const con = this.outputConsole(windowName);
        const buf = con.getBuffer();
        if (buf && con.getLineNumber() < con.getLineCount()) {
            const at = Math.max(0, Math.min(con.getCursorColumn(), buf.text.length));
            buf.insertBuffer(at, this.clipboard.clone());
            if (!this.inTriggerProcessing) buf.rerender();
            return;
        }
        const isMain = !windowName || windowName === 'main';
        con.appendBuffer(this.clipboard.clone());
        if (isMain) this.drainMain();
        else this.drainWindowConsole(windowName!, con);
    }

    /**
     * Mudlet `createMapper([parent,] x, y, width, height)`. Creates a positioned
     * mapper widget inside the given parent (defaults to `main`), or repositions
     * it if it already exists. Singleton: Mudlet allows only one in-console
     * mapper at a time, so we reuse a fixed id — distinct from the dockable map
     * widget opened by `openMapWidget`. Both are client-owned ids (see
     * MAPPER_WIDGET_ID) so a script or a MUD cannot name a window over them.
     * Both render the same MapStore and stay in sync. Returns true on success.
     */
    createMapper(x: number, y: number, width: number, height: number, parent?: string): boolean {
        const wm = this.session.windows;
        const id = MAPPER_WIDGET_ID;
        if (!wm.has(id)) {
            wm.open(id, {
                kind: 'map',
                title: 'Mapper',
                autoDock: false,
                ignoreHint: true,
                parent: parent && parent !== 'main' ? parent : undefined,
            });
        } else {
            wm.show(id);
        }
        wm.markAsMiniConsole(id);
        wm.setPosition(id, Math.round(x), Math.round(y));
        wm.setSize(id, Math.round(width), Math.round(height));
        return true;
    }

    /**
     * Mudlet `setWindow(windowName, name[, x, y, show])` — move an element
     * (label, overlay command line, text edit, scroll box, or a miniconsole /
     * mapper panel) into another parent window: `main`, a userwindow /
     * miniconsole, or a scroll box. Mirrors Qt's reparenting semantics: the
     * element lands at (x, y) in the new parent and is only visible when
     * `show` is true. Userwindow bases themselves can't be moved (as in
     * Mudlet, where they anchor a dock widget).
     */
    /**
     * Mudlet `getWindowGeometry(name)` → x, y, width, height. Reads back the
     * stored geometry the move/resizeWindow setters write, following the same
     * routing precedence they use (labels → command lines → text edits →
     * scroll boxes → user windows/miniconsoles). Null when no widget of any
     * kind owns the name; `"main"` is deliberately excluded because
     * moveWindow/resizeWindow don't act on it either.
     */
    getWindowGeometry(name: string): { x: number; y: number; width: number; height: number } | null {
        if (name === 'main') return null;
        const overlay = this.labels.get(name) ?? this.cmdLines.get(name)
            ?? this.textEdits.get(name) ?? this.scrollBoxes.get(name);
        if (overlay) {
            const { x, y, width, height } = overlay;
            return { x, y, width, height };
        }
        return this.session.windows.getGeometry(name);
    }

    /**
     * Mudlet `windowVisible(name)` — *effective* visibility: a widget whose
     * own flag is set still reports false when any ancestor is hidden. Walks
     * the parent chain (overlay widgets carry a `parent` name, user windows
     * resolve theirs through WindowManager) up to `"main"`, which is always
     * visible. Null when the name belongs to no widget, or is `"main"`.
     */
    windowVisible(name: string): boolean | null {
        if (name === 'main') return null;
        // Own flag first — a name owned by nothing has no visibility to report.
        const own = this.ownVisibility(name);
        if (own === null) return null;
        if (!own) return false;
        // Then every ancestor, bounded by the widget count so a corrupt parent
        // cycle can't spin here.
        const seen = new Set<string>([name]);
        let parent = this.parentOf(name);
        while (parent && parent !== 'main' && !seen.has(parent)) {
            seen.add(parent);
            if (this.ownVisibility(parent) === false) return false;
            parent = this.parentOf(parent);
        }
        return true;
    }

    /** A widget's own visible flag, ignoring ancestors. Null when unknown. */
    private ownVisibility(name: string): boolean | null {
        const overlay = this.labels.get(name) ?? this.cmdLines.get(name)
            ?? this.textEdits.get(name) ?? this.scrollBoxes.get(name);
        if (overlay) return overlay.visible;
        if (this.session.windows.has(name)) return this.session.windows.isVisible(name);
        return null;
    }

    /** The name a widget is nested under, or null once the chain reaches a root. */
    private parentOf(name: string): string | null {
        const overlay = this.labels.get(name) ?? this.cmdLines.get(name)
            ?? this.textEdits.get(name) ?? this.scrollBoxes.get(name);
        if (overlay) return overlay.parent || null;
        return this.session.windows.parentOf(name);
    }

    /**
     * Mudlet `getLabelText(name)` — the HTML/text last written to a label via
     * echo()/setLabelText. Null when the name is unknown *or* names a non-label
     * widget, which Mudlet reports as an error rather than an empty string.
     */
    getLabelText(name: string): string | null {
        return this.labels.get(name)?.html ?? null;
    }

    setWindow(windowName: string, name: string, x = 0, y = 0, show = true): boolean {
        const wm = this.session.windows;
        if (windowName !== 'main' && !wm.has(windowName) && !this.scrollBoxes.has(windowName)) {
            return false;
        }
        // Same routing precedence as the hide/show/move/resizeWindow bindings.
        if (this.labels.has(name)) {
            this.labels.setParent(name, windowName);
            this.labels.move(name, x, y);
            return show ? this.labels.show(name) : this.labels.hide(name);
        }
        if (this.cmdLines.has(name)) {
            this.cmdLines.setParent(name, windowName);
            this.cmdLines.move(name, x, y);
            return show ? this.cmdLines.show(name) : this.cmdLines.hide(name);
        }
        if (this.textEdits.has(name)) {
            this.textEdits.setParent(name, windowName);
            this.textEdits.move(name, x, y);
            return show ? this.textEdits.show(name) : this.textEdits.hide(name);
        }
        if (this.scrollBoxes.has(name)) {
            // Refuse cycles — parenting a scroll box into itself or one of its
            // descendants would recurse forever in ScrollBoxOverlay.
            for (let p: string | undefined = windowName; p && p !== 'main';
                 p = this.scrollBoxes.get(p)?.parent) {
                if (p === name) return false;
            }
            this.scrollBoxes.setParent(name, windowName);
            this.scrollBoxes.move(name, x, y);
            return show ? this.scrollBoxes.show(name) : this.scrollBoxes.hide(name);
        }
        if (wm.has(name)) {
            if (!wm.isMiniConsole(name)) return false;
            wm.setParent(name, windowName === 'main' ? undefined : windowName);
            wm.setPosition(name, Math.round(x), Math.round(y));
            if (show) wm.show(name); else wm.hide(name);
            return true;
        }
        return false;
    }

    /**
     * Mudlet `replace([win,] with, [keepcolor])`. Default (`keepcolor=false`)
     * applies the resolved console's current pen state (set via
     * setFgColor/setBgColor/etc.) to the replacement text. With
     * `keepcolor=true`, the replacement inherits the selection's existing
     * format — same as our previous behavior.
     */
    replace(newText: string, windowName?: string, keepColor = false): void {
        if (!this.selection) return;
        const sel = this.selection;
        const targetWin = windowName ?? sel.windowName;
        const buf = this.resolveBuffer(targetWin);
        if (!buf) return;
        const state = keepColor ? undefined : this.outputConsole(targetWin).format.toSnapshot();
        buf.replace([sel.start, sel.start + sel.length], newText, state);
        this.selection = null;
        if (!this.inTriggerProcessing) {
            buf.rerender();
        } else if (this.getConsole(targetWin) === this.mainConsole) {
            // Mudlet #8824: after a replace/creplaceLine during trigger
            // processing the output cursor stays on the replaced line, so a
            // following echo/cecho appends to it instead of opening a new line.
            // (A trigger's first echo may have advanced past the matched line
            // and cleared this flag; the replace re-establishes the line.)
            this.echoOnMatchedLine = true;
        }
    }

    /**
     * Mudlet `deleteLine([window])`. Marks the cursor's current buffer as
     * deleted. When that buffer is the matching line of an in-flight trigger,
     * the renderer skips emitting it; when it's a rendered history line,
     * Console.deleteLine removes it from the DOM.
     */
    deleteLine(windowName?: string): void {
        const con = this.getConsole(windowName);
        if (!con) return;
        const buf = con.getBuffer();
        if (this.inTriggerProcessing && buf) {
            buf.markAsDeleted();
            return;
        }
        con.deleteLine();
    }

    // The three staging calls below reach the command bar through an event, so
    // the new text only lands in React state on the next render. A script that
    // stages text and reads it straight back (`sendCmdLine("look")` then
    // `getCmdLine()`) would see the pre-staging value, so each one also updates
    // the script-side mirror getCmdLine reads — see {@link setCmdLineValue}.

    appendCmdLine(text: string): void {
        this.cmdLineValue = this.getCmdLine() + text;
        this.session.events.emit('script.appendcmd', text);
    }

    printCmdLine(text: string): void {
        this.cmdLineValue = text;
        this.session.events.emit('script.setcmd', text);
    }

    clearCmdLine(): void {
        this.cmdLineValue = '';
        this.session.events.emit('script.clearcmd');
    }

    /**
     * Mudlet selectCmdLineText([commandLine]). Selects (highlights) all text in
     * the command bar so the next keystroke overtypes it. mudix has a single
     * main command bar; a named overlay command-line arg is accepted for
     * compatibility but only "main"/omitted is acted upon. The actual DOM
     * selection happens in ProfileSession, which owns the input ref.
     */
    selectCmdLineText(name?: string): void {
        if (name && name !== 'main') return;
        this.session.events.emit('script.selectcmd');
    }

    /**
     * Mudlet setCommandBackgroundColor([windowName], r, g, b, [transparency]).
     * Recolors the command bar's background. mudix only has the main command
     * bar, so a non-"main" windowName is ignored. `a` is Mudlet's 0..255 alpha;
     * the CommandBar reads the `inputBackground` profile field as a CSS color.
     */
    setCommandBackgroundColor(r: number, g: number, b: number, a = 255, name?: string): boolean {
        if (name && name !== 'main') {
            return this.session.windows.setCmdLineColor(name, 'background-color', r, g, b, a);
        }
        useAppStore.getState().patchConnectionProfile(this.connectionId, {
            inputBackground: rgbaCss(r, g, b, a),
        });
        return true;
    }

    /** Mudlet setCommandForegroundColor — recolors the command bar text. */
    setCommandForegroundColor(r: number, g: number, b: number, a = 255, name?: string): boolean {
        if (name && name !== 'main') {
            return this.session.windows.setCmdLineColor(name, 'color', r, g, b, a);
        }
        useAppStore.getState().patchConnectionProfile(this.connectionId, {
            inputForeground: rgbaCss(r, g, b, a),
        });
        return true;
    }

    // ── Command-line value (Mudlet getCmdLine) ────────────────────────────────
    // The input string lives in React state inside ProfileSession, which mirrors
    // every change into `cmdLineValue` so the script API can read it
    // synchronously. The mirror — not the React state — is what getCmdLine
    // answers with, because a script that stages text through printCmdLine and
    // reads it back in the same chunk cannot wait for a re-render. Both writers
    // are last-write-wins, which is the right order in both directions: the user
    // typing after a script staged text overwrites it, and vice versa.
    private cmdLineValue: string | null = null;
    private cmdLineProvider: (() => string) | null = null;

    /** Registered by ProfileSession while a command bar is mounted; read only
     *  before the first {@link setCmdLineValue} has mirrored anything. */
    setCmdLineProvider(fn: (() => string) | null): void {
        this.cmdLineProvider = fn;
        if (fn === null) this.cmdLineValue = null;
    }

    /** Mirror a command-bar edit (user typing, history recall, submit-clear). */
    setCmdLineValue(text: string): void {
        this.cmdLineValue = text;
    }

    getCmdLine(): string {
        return this.cmdLineValue ?? this.cmdLineProvider?.() ?? '';
    }

    // ── Command-line tab-completion suggestions ───────────────────────────────
    // Mudlet's addCmdLineSuggestion family. Stored as an insertion-ordered Set
    // so addCmdLineSuggestion("a"); add("b") feeds tab completion as ["a","b"].
    // CommandBar merges these with command history when computing matches.
    // Mutations emit `script.cmdlinesuggestions` with the current snapshot so
    // React can re-render without polling.
    private cmdLineSuggestions = new Set<string>();

    addCmdLineSuggestion(suggestion: string): void {
        const s = suggestion ?? '';
        if (!s) return;
        if (this.cmdLineSuggestions.has(s)) return;
        this.cmdLineSuggestions.add(s);
        this.emitCmdLineSuggestions();
    }

    removeCmdLineSuggestion(suggestion: string): void {
        if (this.cmdLineSuggestions.delete(suggestion ?? '')) {
            this.emitCmdLineSuggestions();
        }
    }

    clearCmdLineSuggestions(): void {
        if (this.cmdLineSuggestions.size === 0) return;
        this.cmdLineSuggestions.clear();
        this.emitCmdLineSuggestions();
    }

    getCmdLineSuggestions(): string[] {
        return [...this.cmdLineSuggestions];
    }

    private emitCmdLineSuggestions(): void {
        this.session.events.emit('script.cmdlinesuggestions', [...this.cmdLineSuggestions]);
    }

    // ── Command-line tab-completion blacklist ────────────────────────────────
    // Mudlet's addCmdLineBlacklist family. The blacklist is subtractive, and it
    // applies to every source Tab draws from — buffer words, history and the
    // suggestions above — not just the ones a script added, which is the point
    // of it: it's how you stop Tab offering a word the game keeps saying.
    // Matched case-insensitively, as TCommandLine does.
    private cmdLineBlacklist = new Set<string>();

    addCmdLineBlacklist(word: string): void {
        const w = word ?? '';
        if (!w || this.cmdLineBlacklist.has(w)) return;
        this.cmdLineBlacklist.add(w);
        this.emitCmdLineBlacklist();
    }

    removeCmdLineBlacklist(word: string): void {
        if (this.cmdLineBlacklist.delete(word ?? '')) this.emitCmdLineBlacklist();
    }

    clearCmdLineBlacklist(): void {
        if (this.cmdLineBlacklist.size === 0) return;
        this.cmdLineBlacklist.clear();
        this.emitCmdLineBlacklist();
    }

    getCmdLineBlacklist(): string[] {
        return [...this.cmdLineBlacklist];
    }

    private emitCmdLineBlacklist(): void {
        this.session.events.emit('script.cmdlineblacklist', [...this.cmdLineBlacklist]);
    }

    // ── Per-command-line history saving ─────────────────────────────────────
    // Mudlet's TCommandLine::mSaveCommands, reached from Lua as
    // get/setSaveCommandHistory. It is a second switch *under* the profile-wide
    // `commandLineHistorySaveSize`: with that at zero nothing is saved at all
    // and this one is not even consulted. Defaults to on, as Mudlet's does.
    private saveCommandHistoryFlags = new Map<string, boolean>();

    saveCommandHistoryFor(cmdLineName: string): boolean {
        return this.saveCommandHistoryFlags.get(cmdLineName) ?? true;
    }

    setSaveCommandHistoryFor(cmdLineName: string, save: boolean): void {
        if (this.saveCommandHistoryFor(cmdLineName) === save) return;
        this.saveCommandHistoryFlags.set(cmdLineName, save);
        // Only the main bar has a persisted history for the flag to govern; the
        // rest round-trip the setting and will follow if they ever gain one.
        if (cmdLineName === 'main') this.session.events.emit('script.savecommandhistory', save);
    }

    /**
     * Mudlet `openUrl(url) → bool`. Opens a URL in a new browser tab. Special
     * case: a `file:` prefix (as in `openUrl("file:" .. getMudletHomeDir())`)
     * routes to the in-app VFS file browser at the given path, since web pages
     * can't navigate to `file:` URLs.
     */
    openUrl(url: string): boolean {
        const u = (url ?? '').trim();
        if (!u) return false;
        if (u.startsWith('file:')) {
            // Accept file:, file://, and file:/// prefixes — keep the path's
            // leading slash so VFS paths like /profiles/<id>/... resolve.
            const path = u.replace(/^file:(\/\/)?/, '');
            this.session.events.emit('script.openvfs', path);
            return true;
        }
        const w = window.open(u, '_blank', 'noopener,noreferrer');
        return !!w;
    }

    /**
     * Mudlet `invokeFileDialog(fileOrFolder, title[, location])` — UI side.
     * Emits a `script.filedialog` request; ProfileSession shows the in-app VFS
     * picker and resolves it. The calling Lua handler is parked on its
     * coroutine until `onPick` runs (see LuaRuntime.parkDialogThread), so if
     * nothing is listening (headless runtime, tests) the request is cancelled
     * immediately — a handler must never stay suspended forever.
     */
    invokeFileDialog(request: { mode: 'file' | 'folder'; title: string; location: string }, onPick: (path: string) => void): void {
        let resolved = false;
        const once = (path: string) => {
            if (resolved) return;
            resolved = true;
            onPick(typeof path === 'string' ? path : '');
        };
        const listeners = this.session.events.emit('script.filedialog', { ...request, onPick: once });
        if (listeners === 0) once('');
    }

    // ── Command-line action (Mudlet setCmdLineAction) ─────────────────────────
    // When set, the action receives every Enter-submitted line *before* alias
    // matching and the MUD send. The script fully owns the command bar — it
    // may parse, store, route, or re-emit the text via send()/expandAlias().
    private cmdLineAction: ((text: string) => void) | null = null;

    setCmdLineAction(fn: ((text: string) => void) | null): void {
        this.cmdLineAction = fn;
    }

    /** Engine-side accessor: returns the currently registered action, or null. */
    getCmdLineAction(): ((text: string) => void) | null {
        return this.cmdLineAction;
    }

    // ── Stylesheets (Mudlet setAppStyleSheet / setUserWindowStyleSheet) ───────
    // Real Mudlet APIs that scripts (theme switchers, package CSS) depend on.
    // Browser equivalent: install or replace a `<style>` tag in document.head
    // keyed by `tag` (app-wide) or window name (per-window). App/profile-level
    // CSS goes in verbatim apart from `rewriteQtSelectors`, which
    // redirects Qt objectName selectors (`QWidget#widget_panel { … }`) onto the
    // `data-qt-object` hooks mudix's DOM carries — see qtCss.ts. Per-window CSS is
    // translated through `userWindowQssToScopedCss`: `QWidget { … }` (the
    // canonical Mudlet selector) auto-scopes to `[data-mudix-window="name"]`,
    // so a stylesheet like `QWidget { padding: 15 20; }` actually pads the
    // window viewport. Scripts can still write the attribute selector
    // explicitly for non-`QWidget` rules. After a successful app-level install
    // we raise sysAppStyleSheetChange via `host.raiseEvent` so themes can hook
    // re-applies.



    /**
     * Get (or create) a `<style>` tag in `document.head` owned by this profile.
     *
     * Every tag mudix installs on a script's behalf is stamped with the owning
     * connection id, both in its element id and in `data-mudix-style-owner`, so
     * {@link destroy} can take them all down again. Mudlet's `setAppStyleSheet`
     * is genuinely application-wide (a QApplication stylesheet shared by every
     * open profile), but a mudix tab hosts one profile at a time: leaving a
     * closed profile's CSS installed silently restyled the *next* profile opened
     * in that tab. So all three setters — app, profile and per-window — are
     * profile-local here, and torn down with the profile.
     */
    private styleTag(kind: string, key: string, dataKey: string, dataValue: string): HTMLStyleElement {
        const id = `mudix-${kind}-stylesheet--${this.connectionId}--${key}`;
        let el = document.getElementById(id) as HTMLStyleElement | null;
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            el.dataset[dataKey] = dataValue;
            el.dataset.mudixStyleOwner = this.connectionId;
            document.head.appendChild(el);
        }
        return el;
    }

    /** Remove every `<style>` tag this profile's scripts installed. */
    private removeOwnedStyleTags(): void {
        const owned = document.querySelectorAll(`style[data-mudix-style-owner="${cssEscape(this.connectionId)}"]`);
        for (const el of owned) el.remove();
    }

    setAppStyleSheet(css: string, tag?: string): boolean {
        const key = tag && tag.length > 0 ? tag : 'default';
        const el = this.styleTag('app', key, 'mudixAppStylesheet', key);
        el.textContent = rewriteQtSelectors(css ?? '');
        // Mudlet's event carries (tag, profileName) — which sheet changed and
        // whose — not the CSS itself. A handler that wants the text has it
        // already; what it cannot otherwise know is which of several tagged
        // sheets moved.
        this.host.raiseEvent('sysAppStyleSheetChange', [tag ?? '', this.profileName]);
        return true;
    }

    setUserWindowStyleSheet(name: string, css: string): boolean {
        if (!name) return false;
        const el = this.styleTag('userwindow', name, 'mudixUserwindowStylesheet', name);
        const scope = `[data-mudix-window="${cssEscape(name)}"]`;
        el.textContent = userWindowQssToScopedCss(css ?? '', scope);
        // Remembered verbatim: the tag holds the *scoped* translation, and a
        // getter has to answer what the script wrote, not what mudix made of it.
        this.userWindowCss.set(name, css ?? '');
        return true;
    }

    /** Mudlet `getUserWindowStyleSheet(name)` — the QSS as it was set. */
    getUserWindowStyleSheet(name: string): string {
        return this.userWindowCss.get(name) ?? '';
    }

    private readonly userWindowCss = new Map<string, string>();

    /** Mudlet `getCmdLineStyleSheet([name])`. Same story as above: the command
     *  line's authored QSS, not the CSS the overlay ends up with. "main" is the
     *  default and has no widget of its own to read back from. */
    getCmdLineStyleSheet(name: string): string {
        return this.cmdLineCss.get(name || 'main') ?? '';
    }

    noteCmdLineStyleSheet(name: string, css: string): void {
        this.cmdLineCss.set(name || 'main', css ?? '');
    }

    private readonly cmdLineCss = new Map<string, string>();

    /**
     * Mudlet `setProfileStyleSheet(stylesheet)`. Installs (or replaces) a
     * profile-wide CSS block. In Mudlet this themes the whole profile's
     * widgets; the browser analogue is a single `<style>` tag in document.head,
     * keyed separately from setAppStyleSheet's blocks so the two don't clobber
     * each other. Always returns true.
     *
     * Deliberately raises NO sysAppStyleSheetChange: that event announces an
     * *application*-level change, and a profile sheet is not one. Raising it
     * here (as mudix used to) told every profile-agnostic theme handler to
     * re-apply itself over a change that was never theirs.
     */
    setProfileStyleSheet(css: string): boolean {
        const el = this.styleTag('profile', 'default', 'mudixProfileStylesheet', 'true');
        el.textContent = rewriteQtSelectors(css ?? '');
        return true;
    }

    /**
     * Mudlet `setClipboardText(textContent)`. Updates the session text
     * clipboard and best-effort writes it to the OS clipboard via
     * navigator.clipboard (which may reject without a user gesture or in an
     * insecure context — the in-process mirror is authoritative regardless).
     * Always returns true.
     */
    setClipboardText(text: string): boolean {
        this.clipboardText = String(text ?? '');
        try {
            const nav = (globalThis as { navigator?: Navigator }).navigator;
            nav?.clipboard?.writeText?.(this.clipboardText)?.catch(() => { /* gesture/permission gated */ });
        } catch { /* no clipboard API */ }
        return true;
    }

    /**
     * Mudlet `getClipboardText()`. Returns the session text clipboard. Because
     * the OS clipboard can only be read asynchronously in the browser, we kick
     * off a best-effort refresh (so a subsequent call reflects an external copy)
     * and return the current mirror synchronously, matching Mudlet's signature.
     */
    getClipboardText(): string {
        try {
            const nav = (globalThis as { navigator?: Navigator }).navigator;
            nav?.clipboard?.readText?.()
                ?.then((t) => { if (typeof t === 'string') this.clipboardText = t; })
                ?.catch(() => { /* gesture/permission gated */ });
        } catch { /* no clipboard API */ }
        return this.clipboardText;
    }

    centerView(roomId: number): boolean {
        return this.session.windows.centerView(roomId);
    }

    // ── Secondary map views ───────────────────────────────────────────────────
    // Mudlet's createMapView family opens extra map windows so several areas can
    // be watched while the primary mapper follows the player. The registry lives
    // in WindowManager (it owns the windows); these are the Lua-facing shapes.

    /** Mudlet `createMapView([areaID])` → the new view id, or the refusal
     *  message when the areaID names no area. */
    createMapView(areaId: number): number | string {
        return this.session.windows.createMapView(areaId);
    }

    /** Mudlet `closeMapView(viewID)`. False when no view has that id. */
    closeMapView(viewId: number): boolean {
        return this.session.windows.closeMapView(viewId);
    }

    /** Mudlet `closeAllMapViews()` → how many were closed. */
    closeAllMapViews(): number {
        return this.session.windows.closeAllMapViews();
    }

    /** Mudlet `getMapViewIds()` — every open view, in creation order. */
    getMapViewIds(): number[] {
        return this.session.windows.getMapViewIds();
    }

    /** Mudlet `getMapViewInfo(viewID)` → `{areaId, centeredRoomId, zoom, zLevel}`,
     *  or undefined when no view has that id. */
    getMapViewInfo(viewId: number): { areaId: number; zoom: number; zLevel: number; centeredRoomId: number } | undefined {
        return this.session.windows.getMapViewInfo(viewId);
    }

    /**
     * Mudlet `getMapZoom([areaID])` — the number of map units visible across the
     * viewport's shorter edge. Mudlet keeps this on the area (TArea's
     * `mLast2DMapZoom`, reached via TRoomDB::get2DMapZoom), so it answers with
     * no mapper mounted and each area remembers its own; mudix stores it the
     * same way. Without an areaID the live renderer's current zoom wins when one
     * is mounted. Undefined for an areaID that doesn't exist — the binding
     * reports that as `(nil, errMsg)`.
     */
    getMapZoom(areaID?: number): number | undefined {
        if (areaID !== undefined) {
            if (!this.map.hasArea(areaID)) return undefined;
            return this.map.getAreaZoom(areaID) ?? MapStore.DEFAULT_MAP_ZOOM;
        }
        return this.session.windows.getMapZoom()
            ?? this.map.getAreaZoom(this.currentMapArea())
            ?? MapStore.DEFAULT_MAP_ZOOM;
    }

    /**
     * Mudlet `setMapZoom(zoom [, areaID])`. Like Mudlet the zoom must be at
     * least 3.0, and an areaID that doesn't exist is refused. Stored on the area
     * and pushed to the live renderer when one is mounted. Returns the refusal
     * message, or null on success, for the binding to shape.
     */
    setMapZoom(zoom: number, areaID?: number): string | null {
        if (!Number.isFinite(zoom) || zoom < MapStore.MIN_MAP_ZOOM) {
            return `setMapZoom: zoom ${zoom} is too small, it must be at least ${MapStore.MIN_MAP_ZOOM}`;
        }
        if (areaID !== undefined && !this.map.hasArea(areaID)) {
            return `setMapZoom: number ${areaID} is not a valid areaID`;
        }
        this.map.setAreaZoom(areaID ?? this.currentMapArea(), zoom);
        // Only the currently displayed area's zoom is visible right now.
        if (areaID === undefined || areaID === this.currentMapArea()) {
            this.session.windows.setMapZoom(zoom);
        }
        return null;
    }

    /** The area the 2D view is showing — the player's room's area, falling back
     *  to the default area when there is no player room yet. */
    private currentMapArea(): number {
        const player = this.map.getPlayerRoom();
        return player != null ? (this.map.getRoomArea(player) ?? -1) : -1;
    }

    /** Mudlet `updateMap()` — force the map to re-read MapStore and redraw. */
    updateMap(): void {
        this.session.windows.updateMap();
    }

    getRoomIDbyHash(hash: string): number | undefined {
        return this.session.windows.getRoomIDbyHash(hash);
    }

    // ── Map scripting API ─────────────────────────────────────────────────────

    get map() { return this.session.windows.mapStore; }

    get cmdLineMenu() { return this.session.cmdLineMenu; }

    get mouseEvents() { return this.session.mouseEvents; }

    get sounds() { return this.session.sounds; }

    get videos() { return this.session.videos; }

    /** Mudlet `setMapBackgroundColor(r, g, b)`. Persists into the profile
     *  mapper settings so MapPanel picks it up on its next render pass. */
    setMapBackgroundColor(r: number, g: number, b: number): boolean {
        const rr = clamp255(r);
        const gg = clamp255(g);
        const bb = clamp255(b);
        const hex = '#' + [rr, gg, bb].map(c => c.toString(16).padStart(2, '0')).join('');
        const store = useAppStore.getState();
        const prev = store.connectionProfile[this.connectionId]?.mapper ?? {};
        store.patchConnectionProfile(this.connectionId, { mapper: { ...prev, backgroundColor: hex } });
        return true;
    }

    /** Mudlet `setMapRoomSize(size)`. Maps to renderer.settings.roomSize via
     *  the profile mapper field. Returns false for non-positive values. */
    setMapRoomSize(size: number): boolean {
        if (!Number.isFinite(size) || size <= 0) return false;
        const store = useAppStore.getState();
        const prev = store.connectionProfile[this.connectionId]?.mapper ?? {};
        store.patchConnectionProfile(this.connectionId, { mapper: { ...prev, roomSize: size } });
        return true;
    }

    /** Mudlet `getMapRoomSize()`. Reads the active room-size value. Falls back
     *  to the MAPPER_DEFAULTS.roomSize when unset. */
    getMapRoomSize(): number {
        const store = useAppStore.getState();
        const mapper = store.connectionProfile[this.connectionId]?.mapper;
        return mapper?.roomSize ?? 0.6;
    }

    /**
     * Mudlet `loadMap([location])`. Persists the bytes (when given) to the
     * connection's binary-map IndexedDB slot and re-renders any open MapPanel.
     * The Lua binding in LuaRuntime reads the VFS path before calling here so
     * this method only deals in already-decoded bytes. Returns true unless the
     * panel reported a parse failure for the given buffer.
     */
    loadMap(buf?: Uint8Array): boolean {
        if (!buf) return this.session.windows.loadMap();
        // Copy into a fresh standalone ArrayBuffer — the source may be a slice
        // of a larger buffer (e.g. a Node Buffer view onto a pool) or a
        // SharedArrayBuffer-backed view, both of which the binary reader chokes on.
        const out = new ArrayBuffer(buf.byteLength);
        new Uint8Array(out).set(buf);
        return this.session.windows.loadMap(out);
    }

    /**
     * Mudlet `saveMap([location])`. Serialises the current MapStore to the
     * Mudlet binary `.dat` format and persists it to the connection's default
     * IndexedDB slot (so it survives reload). Returns the bytes so the Lua
     * binding can also write them to a VFS path when one is supplied. Returns
     * null when serialisation fails.
     */
    saveMap(): Uint8Array | null {
        const buf = this.session.windows.saveMap();
        return buf ? new Uint8Array(buf) : null;
    }

    /** Mudlet `loadMap("...xml")` backbone — import an IRE-style XML map
     *  (XMLimport::readMap) and replace the current map. The Lua binding
     *  reads the VFS file before calling here. Returns false when the text
     *  is not a well-formed XML map. */
    loadMapXml(xmlText: string): boolean { return this.session.windows.loadMapXml(xmlText); }

    /** Mudlet `saveJsonMap(path)` backbone — serialises the current MapStore
     *  as JSON. The Lua binding writes the result to the supplied VFS path. */
    saveJsonMap(): string { return this.session.windows.saveJsonMap(); }

    /** Mudlet `loadJsonMap(path)` backbone — parse a JSON payload previously
     *  produced by saveJsonMap and reload the map. Returns false when the
     *  JSON is malformed or doesn't match the MudletMap shape. */
    loadJsonMap(json: string): boolean { return this.session.windows.loadJsonMap(json); }

    /** Mudlet `addSupportedTelnetOption(option)`. Forwarded to the session
     *  client so the next IAC WILL/DO from the server can be auto-accepted. */
    addSupportedTelnetOption(option: number): boolean {
        return this.session.addSupportedTelnetOption(option);
    }

    /**
     * Mudlet `saveWindowLayout()` — capture the current layout (window hints
     * + dock area extents) into a per-connection snapshot in the persisted
     * app store. A later `loadWindowLayout()` re-applies the captured state.
     * Returns true on success, false when no connectionId is bound.
     */
    saveWindowLayout(): boolean {
        if (!this.connectionId) return false;
        const snapshot = this.session.windows.captureLayoutSnapshot();
        useAppStore.getState().saveLayoutSnapshot(this.connectionId, snapshot);
        this.writeWindowLayoutFile(snapshot);
        return true;
    }

    /** Where Mudlet keeps the window layout: beside the profiles folder, not
     *  inside one, because the layout is the application's rather than any one
     *  profile's. Null when there is no VFS to write into. */
    private windowLayoutPath(): string | null {
        const dir = this.host.configDirectory();
        return dir === null ? null : `${dir}/windowLayout.dat`;
    }

    /**
     * Mirror the snapshot to `windowLayout.dat`.
     *
     * The store is still where a layout survives a reload — this file is the
     * Mudlet-shaped copy, so a script (or a person poking at the profile
     * filesystem) finds the layout where Mudlet puts it and can read it. It is
     * JSON rather than Mudlet's `QMainWindow::saveState` blob: nothing outside
     * mudix reads it, and those bytes describe Qt dock widgets that have no
     * counterpart here.
     */
    private writeWindowLayoutFile(snapshot: unknown): void {
        const path = this.windowLayoutPath();
        if (!path) return;
        const json = JSON.stringify({ version: 1, snapshot }, null, 0);
        this.host.writeFileBytes(path, new TextEncoder().encode(json));
    }

    /** The snapshot in `windowLayout.dat`, or null when there is no readable,
     *  parsable file — in which case the caller falls back to the store. */
    private readWindowLayoutFile(): { hints: Record<string, unknown>; dockExtents: Record<string, number> } | null {
        const path = this.windowLayoutPath();
        if (!path) return null;
        const bytes = this.host.readFileBytes(path);
        if (!bytes) return null;
        try {
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            const snapshot = parsed?.snapshot;
            if (!snapshot || typeof snapshot !== 'object' || !snapshot.hints) return null;
            return snapshot;
        } catch {
            // A file some other tool wrote, or a half-written one. The store
            // still has a layout, and losing it to a bad file would be worse
            // than ignoring the file.
            return null;
        }
    }

    /**
     * Mudlet `loadWindowLayout()` — restore the most recently saved snapshot
     * for this connection. Re-applies geometry, dock state, font/colour, and
     * visibility to live windows; opens windows that the snapshot had visible
     * but are not currently mounted. Returns false when no snapshot exists.
     */
    loadWindowLayout(): boolean {
        if (!this.connectionId) return false;
        // The file wins when there is one: it is what a save just wrote, and it
        // is the copy someone editing the profile filesystem can change. The
        // store is the fallback — and after a reload, when the layout came back
        // from localStorage rather than from a save this session, the only copy.
        const snapshot = this.readWindowLayoutFile()
            ?? useAppStore.getState().connectionLayoutSnapshots[this.connectionId];
        if (!snapshot) return false;
        this.session.windows.applyLayoutSnapshot(snapshot as Parameters<typeof this.session.windows.applyLayoutSnapshot>[0]);
        return true;
    }

    // ── Misc ──────────────────────────────────────────────────────────────────

    /**
     * Mudlet `getTime()` — current local time as a record. The Bridge.lua wrapper
     * picks fields off this object for the `{year, month, day, hour, min, sec,
     * msec}` table form, and uses `wday` (0=Sun..6=Sat) to format `ddd`/`dddd`
     * tokens when the script asks for a formatted string.
     */
    getTime(): { year: number; month: number; day: number; hour: number; min: number; sec: number; msec: number; wday: number } {
        const d = new Date();
        return {
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            day: d.getDate(),
            hour: d.getHours(),
            min: d.getMinutes(),
            sec: d.getSeconds(),
            msec: d.getMilliseconds(),
            wday: d.getDay(),
        };
    }

    /**
     * Mudlet `getNetworkLatency()` — round-trip time of the most recent
     * keep-alive ping. Returns the last measured value (in ms) for as long as
     * the connection is up; -1 when no measurement has been made yet (mirrors
     * Mudlet's "not yet measured" sentinel — better than a fake 0 which would
     * read as "instant" in scripts charting latency).
     */
    getNetworkLatency(): number {
        const fresh = this.session.ping;
        if (fresh != null) {
            this.lastPingMs = fresh;
            return fresh;
        }
        return this.lastPingMs ?? -1;
    }

    private lastPingMs: number | null = null;

    getMainWindowSize(): [number, number] {
        // Reports the full viewport (the coordinate space labels live in), not
        // the console area. Borders carve insets out of this rectangle without
        // shrinking it — matches Mudlet so scripts that place labels with
        // `y = h - labelHeight` after setBorderBottom land in the carved zone.
        const el = this.session.windows.getMainViewportElement()
                ?? this.session.windows.getElement('main');
        if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) return [rect.width, rect.height];
        }
        return [window.innerWidth, window.innerHeight];
    }

    /**
     * Mudlet `hasFocus([window])` → bool. Reports whether the named console (or
     * the main command bar / output area when omitted) currently holds keyboard
     * focus. mudix maps "main"/omitted to the command input, and a named window
     * to its registered overlay element. Returns false when nothing matches.
     */
    hasFocus(windowName?: string): boolean {
        if (typeof document === 'undefined') return false;
        const activeEl = document.activeElement;
        if (!activeEl) return false;
        if (!windowName || windowName === 'main') {
            const input = document.querySelector('.command-input');
            return !!input && (activeEl === input || (!!input && input.contains(activeEl)));
        }
        const el = this.session.windows.getElement(windowName);
        return !!el && (activeEl === el || el.contains(activeEl));
    }

    /**
     * Mudlet `alert([seconds])`. Mudlet flashes the taskbar entry to grab the
     * user's attention; browsers have no taskbar-flash API, so we flash the
     * document title (alternating with a "● " bell prefix) for `seconds`
     * (default 10, Mudlet's default), and skip the flash entirely while the tab
     * is already focused — matching Mudlet, which no-ops when the window is
     * active.
     */
    alert(seconds?: number): void {
        const dur = Number.isFinite(seconds) && (seconds as number) > 0 ? (seconds as number) : 10;
        flashTitle(dur);
    }

    /**
     * Mudlet `getMainConsoleWidth()` — pixel width of the main console's text
     * area. Mudlet computes `averageCharWidth * (wrapAt + 1)`; we mirror that
     * with a canvas-measured monospace cell for the profile's output font, and
     * resolve the wrap column from the profile's `outputWrapAt` override (the
     * value `setWindowWrap("main", n)` writes), falling back to the live
     * measured column count when no explicit wrap is set.
     */
    getMainConsoleWidth(): number {
        const state = useAppStore.getState();
        const family = selectProfileField(state, this.connectionId, 'outputFont')?.family ?? '';
        const size = selectProfileField(state, this.connectionId, 'fontSize') ?? 12;
        const [cellW] = measureMonospaceCell(family, size);
        const wrapAt = selectProfileField(state, this.connectionId, 'outputWrapAt')
            ?? this.getColumnCount('main');
        return Math.round(cellW * (wrapAt + 1));
    }

    /**
     * Mudlet `getConnectionInfo()` → `host, port, connected`. Mudlet reports the
     * MUD's telnet host/port; mudix reads them off the active connection config.
     * For a `mud`-mode connection those are the stored host/port; for a raw
     * `websocket` connection we parse them out of the endpoint URL (port falls
     * back to the ws/wss default). `connected` reflects the live session status.
     */
    getConnectionInfo(): { host: string; port: number; connected: boolean } {
        const conn = useAppStore.getState().connections.find(c => c.id === this.connectionId);
        const { host, port } = conn ? connectionHostPort(conn) : { host: '', port: 0 };
        return { host, port, connected: this.session.status === 'connected' };
    }

    /**
     * Mudlet `connectToServer(host, port [, save])`. mudix tunnels MUD traffic
     * through a WebSocket proxy, so this builds the same `proxy?host=&port=` URL
     * the connection screen uses and (re)connects the live session. With `save`,
     * the host/port are persisted onto the active connection (switching it to
     * mud-mode) so they survive a reload — the analogue of Mudlet's profile
     * write. Returns false for an out-of-range port.
     */
    connectToServer(host: string, port = 23, save = false): boolean {
        if (!Number.isFinite(port) || port < 1 || port > 65535) return false;
        const state = useAppStore.getState();
        const conn = state.connections.find(c => c.id === this.connectionId);
        const url = connectionUrl(
            conn
                ? { ...conn, mode: 'mud', host, port }
                : { id: this.connectionId, name: '', mode: 'mud', host, port },
            state.client.userProxyUrl,
        );
        if (!url) return false;
        if (save && conn) {
            state.updateConnection(this.connectionId, { ...conn, mode: 'mud', host, port });
        }
        this.dialConnect(url);
        return true;
    }

    /**
     * Mudlet `getLabelSizeHint(name)` → `width, height` (the label's preferred
     * content size). Returns null when no such label — the Lua binding maps that
     * to Mudlet's `(nil, errMsg)` shape.
     */
    getLabelSizeHint(name: string): { width: number; height: number } | null {
        return this.labels.getSizeHint(name);
    }

    /**
     * Mudlet `announce(text [, processing])` — push `text` to assistive tech.
     * Mudlet raises a Qt accessibility announcement; the browser equivalent is
     * an ARIA live region. `processing` maps to live-region politeness exactly
     * as Mudlet does: `importantall`/`importantmostrecent` → `assertive`, every
     * other value → `polite`. Two persistent off-screen regions are reused so
     * repeated calls don't pile up DOM nodes. The text is cleared then re-set on
     * a microtask so screen readers re-announce even identical consecutive
     * messages (a live region that doesn't change is not spoken again).
     */
    announce(text: string, processing?: string): void {
        if (typeof document === 'undefined' || !text) return;
        const assertive = processing === 'importantall' || processing === 'importantmostrecent';
        const id = assertive ? 'mudix-aria-live-assertive' : 'mudix-aria-live-polite';
        let region = document.getElementById(id);
        if (!region) {
            region = document.createElement('div');
            region.id = id;
            region.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
            region.setAttribute('aria-atomic', 'true');
            region.setAttribute('role', 'status');
            // Visually-hidden but still read by screen readers.
            region.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);border:0;white-space:nowrap';
            document.body.appendChild(region);
        }
        const el = region;
        el.textContent = '';
        setTimeout(() => { el.textContent = text; }, 50);
    }

    /**
     * Mudlet `showNotification(title [, content [, expiryInSeconds]])` → true.
     * Mudlet pops a system tray notification; the browser equivalent is the Web
     * Notifications API. `content` defaults to `title` (matching Mudlet). `expiry`
     * (when given, ≥1s) auto-closes the notification.
     *
     * Gated on the user having opted in via Settings (`client.notificationsEnabled`),
     * which is also where the browser permission prompt is raised — so we never
     * trigger a permission pop-up from a script call here, and silently no-op
     * unless the user enabled notifications AND the browser granted permission.
     * Mudlet always returns true regardless of whether anything is shown, so we
     * match that — the return value reflects "the call was accepted", not "a
     * notification appeared".
     */
    showNotification(title: string, content?: string, expirySeconds?: number): boolean {
        const enabled = useAppStore.getState().client.notificationsEnabled === true;
        if (enabled
            && typeof window !== 'undefined'
            && 'Notification' in window
            && Notification.permission === 'granted') {
            try {
                const n = new Notification(title, { body: content ?? title });
                if (expirySeconds && expirySeconds > 0) {
                    setTimeout(() => n.close(), Math.max(1000, Math.round(expirySeconds * 1000)));
                }
            } catch { /* construction can throw where the API needs a SW (e.g. mobile) */ }
        }
        return true;
    }

    /**
     * Mudlet getMousePosition() → x, y in main-console-local pixels. Tracked
     * passively via document-level pointermove/mousedown — before any input
     * has been seen returns 0,0. When the cursor is outside the main viewport
     * the result is negative or past the viewport bounds (same as Qt's
     * mapFromGlobal). Falls back to viewport coords if the main element
     * isn't mounted.
     */
    getMousePosition(): [number, number] {
        if (Number.isNaN(lastPointerClientX) || Number.isNaN(lastPointerClientY)) {
            return [0, 0];
        }
        const el = this.session.windows.getMainViewportElement()
                ?? this.session.windows.getElement('main');
        if (el) {
            const rect = el.getBoundingClientRect();
            return [Math.round(lastPointerClientX - rect.left),
                    Math.round(lastPointerClientY - rect.top)];
        }
        return [Math.round(lastPointerClientX), Math.round(lastPointerClientY)];
    }

    /**
     * Mudlet getUserWindowSize(name). Returns the rendered [width, height] of a
     * userwindow / miniconsole in pixels. Reports the live element box when the
     * panel is mounted (so docked panels reflect their actual on-screen size),
     * otherwise falls back to the stored window hint. Returns [0, 0] when the
     * window doesn't exist.
     */
    getUserWindowSize(name: string): [number, number] {
        // Mudlet resolves the default/"main" name to the main window. The Lua
        // binding already intercepts that case, but guard here too so any future
        // internal caller can't reintroduce the nil-size crash (see Geyser
        // Label:onRightClick).
        if (!name || name === 'main') return this.getMainWindowSize();
        const size = this.session.windows.getSize(name);
        if (!size) return [0, 0];
        return [size.width, size.height];
    }

    /**
     * Mudlet setFontSize. Without `win` (or "main"), persists the size on the
     * active profile so the main output picks it up. With a window name, sets
     * the per-window output font size on WindowManager (saved into the hint).
     */
    setFontSize(size: number, win?: string): boolean {
        if (!Number.isFinite(size) || size < 1 || size > 99) return false;
        const rounded = Math.round(size);
        if (!win || win === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { fontSize: rounded });
            return true;
        }
        return this.session.windows.setFontSize(win, rounded);
    }

    /**
     * Mudlet setMiniConsoleFontSize. Strictly targets miniconsoles (created via
     * createMiniConsole / createConsole) — userwindows and labels are rejected
     * the same way Mudlet's CONSOLE-only lookup rejects them.
     */
    setMiniConsoleFontSize(name: string, size: number): boolean {
        // A user window carries a console of its own, so it takes this too —
        // Geyser.UserWindow:setFontSize goes through here, and refusing left a
        // window created with `fontSize = 12` showing the profile default.
        if (!name || !this.session.windows.has(name)) return false;
        if (!Number.isFinite(size) || size < 1 || size > 99) return false;
        return this.session.windows.setFontSize(name, Math.round(size));
    }

    /**
     * Mudlet getFontSize. Returns the configured font size in pixels for the
     * main window (when no name passed) or for a specific window. Returns null
     * if a named window doesn't exist or has no override.
     */
    getFontSize(win?: string): number | null {
        if (!win || win === 'main') return selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize');
        if (!this.session.windows.has(win)) return null;
        return this.session.windows.getFontSize(win) ?? selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize');
    }

    /**
     * Mudlet setBackgroundColor. With no name (or "main") sets the main window
     * background; otherwise dispatches to the matching label or userwindow/
     * miniconsole. Channels are 0..255; alpha defaults to 255.
     */
    setBackgroundColor(name: string | undefined, r: number, g: number, b: number, a = 255): boolean {
        if (!name || name === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputBackgroundColor: { r, g, b, a } });
            return true;
        }
        if (this.session.labels.has(name)) {
            return this.session.labels.setBackgroundColor(name, r, g, b, a);
        }
        return this.session.windows.setBackgroundColor(name, r, g, b, a);
    }

    /**
     * Mudlet getBackgroundColor. Without a name (or "main") returns the main
     * window background; otherwise looks up the named window/miniconsole. Labels
     * fall through here too — their fill color is reported. Returns null when
     * the name doesn't resolve to anything; callers (Lua wrapper) translate that
     * to a 4-tuple of zeros.
     */
    getBackgroundColor(name?: string): { r: number; g: number; b: number; a: number } | null {
        if (!name || name === 'main') {
            return selectProfileField(useAppStore.getState(), this.connectionId, 'outputBackgroundColor') ?? null;
        }
        if (this.session.labels.has(name)) {
            return this.session.labels.getBackgroundColor(name);
        }
        return this.session.windows.getBackgroundColor(name);
    }

    /**
     * Mudlet `setBackgroundImage`. Dispatcher across labels, miniconsoles /
     * userwindows, and the main window — matches Mudlet's overload set:
     *
     *   setBackgroundImage(labelName, imageLocation)           → label
     *   setBackgroundImage(imageLocation, [mode])              → main console
     *   setBackgroundImage(windowName, imageLocation, [mode])  → miniconsole / userwindow
     *
     * Disambiguation matches Mudlet's C++ semantics — label lookup wins when
     * the named widget is a label; otherwise the call is treated as a console
     * form. `mode` arrives already coerced to a number by the GUIUtils.lua
     * wrapper (string mode like "center" → 2 via `mudlet.BgImageMode`). For
     * label form `imageLocation` is a VFS path, resolved through the same
     * rewriter that powers setLabelStyleSheet so package-bundled images work
     * without scripts knowing about the vfs:// scheme.
     */
    setBackgroundImage(a: string, b?: string | number, c?: number): boolean {
        // 1 arg: setBackgroundImage(path) → main, default to border (mode 1).
        if (b === undefined) {
            return this.applyBackgroundImage(undefined, a, 1);
        }
        // 2 args.
        if (c === undefined) {
            // (path, mode) → main window with explicit mode.
            if (typeof b === 'number') {
                return this.applyBackgroundImage(undefined, a, b);
            }
            // (name, path). Mudlet checks label first; only then the console
            // path. Fall through to main when the name is literally "main"
            // (matches setBackgroundColor's special case), default mode 1.
            if (this.session.labels.has(a)) {
                return this.applyLabelBackgroundImage(a, b);
            }
            if (a === 'main') {
                return this.applyBackgroundImage(undefined, b, 1);
            }
            if (this.session.windows.has(a)) {
                return this.session.windows.setBackgroundImage(a, this.resolveImageUrl(b), 1);
            }
            return false;
        }
        // 3 args: (windowName, path, mode).
        if (typeof b !== 'string') return false;
        const mode = Number(c) || 1;
        if (a === 'main') {
            return this.applyBackgroundImage(undefined, b, mode);
        }
        return this.session.windows.setBackgroundImage(a, this.resolveImageUrl(b), mode);
    }

    /**
     * Mudlet `resetBackgroundImage([windowName])`. Without a name (or "main")
     * clears the main window background image; otherwise looks up the named
     * label or window and clears its image. Returns true on success.
     */
    resetBackgroundImage(name?: string): boolean {
        if (!name || name === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputBackgroundImage: undefined });
            return true;
        }
        if (this.session.labels.has(name)) {
            return this.session.labels.resetBackgroundImage(name);
        }
        return this.session.windows.resetBackgroundImage(name);
    }

    /**
     * Mudlet `setLabelCustomCursor(labelName, cursorPath, [hotX, hotY])`. Points
     * the label's mouse cursor at a custom image. The path is run through the
     * VFS-aware URL resolver (same as setBackgroundImage) so package-relative
     * paths resolve, then composed into a CSS `cursor: url(...) hotX hotY, auto`
     * value. hotX/hotY are the cursor hotspot in pixels (default 0,0). Returns
     * false when the label doesn't exist.
     */
    setLabelCustomCursor(name: string, path: string, hotX?: number, hotY?: number): boolean {
        if (!name || !this.session.labels.has(name)) return false;
        const url = this.resolveImageUrl(path ?? '');
        if (!url) return this.session.labels.setCursor(name, undefined);
        const x = Number.isFinite(hotX) ? Math.max(0, Math.round(hotX as number)) : 0;
        const y = Number.isFinite(hotY) ? Math.max(0, Math.round(hotY as number)) : 0;
        const escaped = url.replace(/"/g, '\\"');
        return this.session.labels.setCursor(name, `url("${escaped}") ${x} ${y}, auto`);
    }

    // ── Label movies ──────────────────────────────────────────────────────────
    // Mudlet's QMovie family, backed by an in-browser GIF decoder + canvas
    // player (src/ui/labels/gifMovie.ts). Paths resolve through the profile
    // VFS like Mudlet's local files (`getMudletHomeDir().."/movie.gif"`).

    /**
     * Mudlet `setMovie(labelName, path)` — decode the animation at `path`,
     * install it on the label, and start playing (Mudlet starts immediately
     * too). GIFs decode synchronously via the bundled decoder (every
     * browser); WebP/APNG go through the WebCodecs ImageDecoder where
     * available (Chromium/Safari) — for those a pending player is installed
     * immediately (so follow-up scaleMovie/startMovie calls work, matching
     * the Mudlet idiom) and frames land when the async decode completes.
     * False when the label doesn't exist or the file isn't decodable.
     */
    setMovie(name: string, path: string): boolean {
        if (!name || !path || !this.session.labels.has(name)) return false;
        const bytes = this.host.readFileBytes(path);
        if (!bytes) return false;

        if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) { // "GIF"
            let player: MoviePlayer;
            try {
                player = new MoviePlayer(decodeGif(bytes));
            } catch {
                return false;
            }
            this.session.labels.setMovie(name, player);
            player.start();
            return true;
        }

        const sniffed = sniffDecodableImage(bytes);
        if (!sniffed || !supportsImageDecoder()) return false;
        const player = MoviePlayer.pending(sniffed.width, sniffed.height);
        this.session.labels.setMovie(name, player);
        player.start();
        decodeAnimatedImage(bytes, sniffed.mime)
            .then(gif => player.resolveFrames(gif))
            .catch((err: unknown) => {
                player.stop();
                const msg = err instanceof Error ? err.message : String(err);
                this.printError(`setMovie: failed to decode "${path}": ${msg}`);
            });
        return true;
    }

    /** Mudlet `startMovie(labelName)` — resume a paused/finished animation. */
    startMovie(name: string): boolean {
        const movie = this.session.labels.getMovie(name);
        if (!movie) return false;
        movie.start();
        return true;
    }

    /** Mudlet `pauseMovie(labelName)` — freeze on the current frame. */
    pauseMovie(name: string): boolean {
        const movie = this.session.labels.getMovie(name);
        if (!movie) return false;
        movie.pause();
        return true;
    }

    /** Mudlet `setMovieFrame(labelName, n)` — jump to frame n (0-based, like
     *  QMovie::jumpToFrame). False when the frame doesn't exist. */
    setMovieFrame(name: string, frame: number): boolean {
        return this.session.labels.getMovie(name)?.jumpToFrame(frame) ?? false;
    }

    /** Mudlet `setMovieSpeed(labelName, percent)` — 100 = recorded speed. */
    setMovieSpeed(name: string, percent: number): boolean {
        return this.session.labels.getMovie(name)?.setSpeed(percent) ?? false;
    }

    /** Mudlet `scaleMovie(labelName, [autoscale=true])` — size the GIF to the
     *  label; with autoscale it keeps tracking label resizes. */
    scaleMovie(name: string, autoscale: boolean): boolean {
        return this.session.labels.setMovieScale(name, autoscale);
    }

    /** Label form of setBackgroundImage — mirrors Mudlet's `pL->setPixmap()`,
     *  which shows the image at its native pixel size rather than scaling it
     *  to the label. CSS already does that for raster formats; SVGs without a
     *  `width`/`height` have no CSS intrinsic size and get stretched, so once
     *  the image loads we resolve its real size (viewBox fallback, matching
     *  Qt's QSvgRenderer::defaultSize()) and patch it in. */
    private applyLabelBackgroundImage(name: string, path: string): boolean {
        const url = this.resolveImageUrl(path);
        const ok = this.session.labels.setBackgroundImage(name, url);
        if (ok) {
            resolveSvgIntrinsicSize(url).then(size => {
                if (size) this.session.labels.setBackgroundImageSize(name, url, size.width, size.height);
            });
        }
        return ok;
    }

    private applyBackgroundImage(_target: undefined, path: string, mode: number): boolean {
        // Mode 4 is a raw stylesheet body, not an image path — skip the URL
        // resolver so multi-property strings (with their own url(...) refs)
        // are handed to the renderer verbatim, where backgroundImageStyle
        // parses them through the same Qt CSS pipeline as setLabelStyleSheet.
        const url = mode === 4 ? path : this.resolveImageUrl(path);
        useAppStore.getState().patchConnectionProfile(this.connectionId, { outputBackgroundImage: { url, mode } });
        return true;
    }

    /** Runs `path` through the active VFS-aware CSS rewriter so package paths
     *  (e.g. `MyPackage/bg.png`) resolve to vfs:// URLs the renderer can load.
     *  Absolute http(s):/data:/blob: URIs pass through untouched. */
    private resolveImageUrl(path: string): string {
        if (!path) return path;
        // Qt resource, not a VFS path — resolved directly so this works even
        // where no CSS rewriter is bound.
        if (isQtResourcePath(path)) return qtResourceUrl(path) ?? path;
        const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const wrapped = `url("${escaped}")`;
        const rewritten = this.host.rewriteCss(wrapped);
        // No rewriter bound (or nothing to rewrite): return the original path
        // rather than unwrapping, which would hand back the *escaped* form.
        if (rewritten === wrapped) return path;
        const m = /url\(\s*"([^"]*)"\s*\)/.exec(rewritten);
        return m ? m[1] : path;
    }

    // ── Borders ───────────────────────────────────────────────────────────────
    // Mudlet setBorderTop/Bottom/Left/Right carve pixel insets out of the main
    // window so labels can sit in the freed space. Sizes are clamped to >= 0
    // and rounded; non-finite input is rejected. Reads/writes the active
    // profile's outputBorders override.

    setBorderTop(size: number): void { this.patchBorders('top', size); }
    setBorderBottom(size: number): void { this.patchBorders('bottom', size); }
    setBorderLeft(size: number): void { this.patchBorders('left', size); }
    setBorderRight(size: number): void { this.patchBorders('right', size); }

    /**
     * Mudlet setBorderSizes — CSS-shorthand-style overloads:
     *   1 arg  → uniform                 (all = a)
     *   2 args → (vertical, horizontal)  (top=bottom=a, left=right=b)
     *   3 args → (top, horizontal, bot)  (left=right=b)
     *   4 args → CSS top/right/bottom/left
     * Other arities no-op (matches Mudlet's silent reject).
     */
    setBorderSizes(a?: number, b?: number, c?: number, d?: number): void {
        const A = this.normalizeBorder(a);
        const B = this.normalizeBorder(b);
        const C = this.normalizeBorder(c);
        const D = this.normalizeBorder(d);
        let t: number | null | undefined, r: number | null | undefined,
            bo: number | null | undefined, l: number | null | undefined;
        if (b === undefined && c === undefined && d === undefined) {
            t = r = bo = l = A;
        } else if (c === undefined && d === undefined) {
            t = bo = A; r = l = B;
        } else if (d === undefined) {
            t = A; r = l = B; bo = C;
        } else {
            t = A; r = B; bo = C; l = D;
        }
        if (t == null || r == null || bo == null || l == null) return;
        this.applyBorders({ top: t, right: r, bottom: bo, left: l });
    }

    getBorderTop(): number { return selectProfileField(useAppStore.getState(), this.connectionId, 'outputBorders')?.top ?? 0; }
    getBorderBottom(): number { return selectProfileField(useAppStore.getState(), this.connectionId, 'outputBorders')?.bottom ?? 0; }
    getBorderLeft(): number { return selectProfileField(useAppStore.getState(), this.connectionId, 'outputBorders')?.left ?? 0; }
    getBorderRight(): number { return selectProfileField(useAppStore.getState(), this.connectionId, 'outputBorders')?.right ?? 0; }

    getBorderSizes(): { top: number; right: number; bottom: number; left: number } {
        return selectProfileField(useAppStore.getState(), this.connectionId, 'outputBorders') ?? { top: 0, right: 0, bottom: 0, left: 0 };
    }

    /** Mudlet setBorderColor. Channels are 0..255; alpha defaults to 255. */
    setBorderColor(r: number, g: number, b: number, a = 255): void {
        useAppStore.getState().patchConnectionProfile(this.connectionId, { outputBorderColor: { r, g, b, a } });
    }

    /** Mudlet resetBorderColor — clears the override so the border tracks the page background again. */
    resetBorderColor(): void {
        useAppStore.getState().patchConnectionProfile(this.connectionId, { outputBorderColor: undefined });
    }

    /** Mudlet getBorderColor — RGB of the main console frame border. Returns the
     *  explicit setBorderColor override when set; otherwise the main window
     *  background (which the border visually inherits), falling back to black. */
    getBorderColor(): [number, number, number] {
        const state = useAppStore.getState();
        const border = selectProfileField(state, this.connectionId, 'outputBorderColor');
        if (border) return [border.r, border.g, border.b];
        const bg = selectProfileField(state, this.connectionId, 'outputBackgroundColor');
        if (bg) return [bg.r, bg.g, bg.b];
        return [0, 0, 0];
    }

    /** Mudlet `getProcessMemoryUsage()` → process RSS in Kb. The browser sandbox
     *  exposes no whole-process RSS, so this returns the JS heap currently in use
     *  (`performance.memory`, Chromium only) as the closest analogue, or 0 when
     *  the API is unavailable (Firefox/Safari). */
    getProcessMemoryUsage(): number {
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return mem ? Math.round(mem.usedJSHeapSize / 1024) : 0;
    }

    /** Mudlet `getSubsystemMemoryStats()` → a diagnostic table of heap metrics
     *  plus per-subsystem counts. Browser-adapted: heap figures come from
     *  `performance.memory` (Chromium; 0 elsewhere); the Lua GC figure
     *  (`luaMemoryKb`) is added by the Bridge.lua wrapper via
     *  `collectgarbage("count")`. Counts are best-effort snapshots. */
    getSubsystemMemoryStats(): Record<string, number> {
        const mem = (performance as unknown as {
            memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
        }).memory;
        const map = this.map;
        const state = useAppStore.getState();
        const triggers = state.connectionTriggers[this.connectionId] ?? [];
        let triggerPatterns = 0;
        for (const t of triggers) if (!t.isGroup) triggerPatterns += t.patterns?.length ?? 0;
        const aliasPatterns = (state.connectionAliases[this.connectionId] ?? []).filter(a => !a.isGroup).length;
        const activeMediaPlayers =
            this.session.sounds.getPlaying().length +
            this.session.sounds.getPlaying({}, 'music').length +
            this.session.videos.getByState(false).length;
        const loadedFonts = (typeof document !== 'undefined' && document.fonts) ? document.fonts.size : 0;
        return {
            heapUsedKb: mem ? Math.round(mem.usedJSHeapSize / 1024) : 0,
            heapTotalKb: mem ? Math.round(mem.totalJSHeapSize / 1024) : 0,
            heapLimitKb: mem ? Math.round(mem.jsHeapSizeLimit / 1024) : 0,
            mapRooms: Object.keys(map.getRooms()).length,
            mapAreas: Object.keys(map.getAreaTable()).length,
            activeMediaPlayers,
            loadedFonts,
            triggerPatterns,
            aliasPatterns,
        };
    }

    private patchBorders(side: 'top' | 'right' | 'bottom' | 'left', size: number): void {
        const v = this.normalizeBorder(size);
        if (v == null) return;
        const cur = selectProfileField(useAppStore.getState(), this.connectionId, 'outputBorders') ?? { top: 0, right: 0, bottom: 0, left: 0 };
        this.applyBorders({ ...cur, [side]: v });
    }

    // Write outputBorders only when a value actually changed. Geyser "console
    // host" panes (e.g. Muxlet's main pane) call setBorderSizes from their
    // onReposition handler, so a single layout reflow — closing or drag-dropping
    // a pane — recomputes the same border geometry many times. Each store write
    // would otherwise run the persist middleware (localStorage serialize) and
    // re-render the main OutputArea, turning one reflow into dozens of redundant
    // output renders. The equality guard collapses those no-op writes.
    private applyBorders(next: { top: number; right: number; bottom: number; left: number }): void {
        const cur = selectProfileField(useAppStore.getState(), this.connectionId, 'outputBorders');
        if (cur && cur.top === next.top && cur.right === next.right
            && cur.bottom === next.bottom && cur.left === next.left) return;
        useAppStore.getState().patchConnectionProfile(this.connectionId, { outputBorders: next });
    }

    private normalizeBorder(n: unknown): number | null {
        const num = Number(n);
        if (!Number.isFinite(num)) return null;
        return Math.max(0, Math.round(num));
    }

    /**
     * Mudlet setFont. Without `win` (or "main"), updates the active profile's
     * outputFont so the App-level applyOutputFont effect re-applies the
     * --font-output CSS variable.
     * With a window name, sets the per-window override on WindowManager.
     * Empty `family` clears the override (main → unset, window → inherit).
     */
    setFont(family: string, win?: string): boolean {
        const fam = (family ?? '').trim();
        if (!win || win === 'main') {
            const next = fam ? { kind: 'system' as const, family: fam } : undefined;
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputFont: next });
            return true;
        }
        return this.session.windows.setFont(win, fam);
    }

    /**
     * Mudlet getFont. Returns the configured font family for the main window
     * (or empty string if none set) or for a specific window. Returns null if
     * the named window doesn't exist.
     */
    getFont(win?: string): string | null {
        // Falls back to the family the console is really drawn in rather than
        // "": Mudlet's Qt font always has a concrete name, and a script that
        // reads the font to restore it later needs something it can pass back
        // to setFont.
        const configured = (): string =>
            selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont')?.family
            || DEFAULT_OUTPUT_FONT_FAMILY;
        if (!win || win === 'main') return configured();
        if (!this.session.windows.has(win)) return null;
        return this.session.windows.getFont(win) ?? configured();
    }

    /**
     * Mudlet `calcFontSize(window_or_fontsize [, fontname])` — returns the
     * `[width, height]` of an average character cell in pixels. Two overloads:
     *
     *   • `calcFontSize(size [, family])` — measure `family` (or the main
     *     output font when omitted) at `size` points (Qt point sizes, like
     *     every font size in the Mudlet API).
     *   • `calcFontSize("WindowName")` — measure the named window/miniconsole
     *     using its configured font+size. Use `"main"` for the main output.
     *
     * Returns `null` when the size is invalid or the named window doesn't
     * exist; the Lua wrapper turns that into Mudlet's `(nil, errMsg)` shape.
     */
    calcFontSize(arg: number | string, fontName?: string): [number, number] | null {
        const mainFamily = (): string =>
            selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont')?.family ?? '';
        const mainSize = (): number =>
            selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize') ?? 12;

        let size: number;
        let family: string;
        if (typeof arg === 'string') {
            if (arg === '') return null;
            if (arg === 'main') {
                size = mainSize();
                family = mainFamily();
            } else {
                if (!this.session.windows.has(arg)) return null;
                size = this.session.windows.getFontSize(arg) ?? mainSize();
                family = this.session.windows.getFont(arg) ?? mainFamily();
            }
        } else {
            size = Number(arg);
            if (!Number.isFinite(size) || size < 1) return null;
            family = fontName && String(fontName).trim() ? String(fontName) : mainFamily();
        }
        return measureMonospaceCell(family, size);
    }

    /**
     * Mudlet `getAvailableFonts()` — set-style table whose keys are font
     * family names usable from scripts. The browser cannot enumerate the
     * system font list without an explicit Local Font Access permission, so
     * this is a best-effort union of what we *do* know:
     *   - Universal web-safe families that work everywhere.
     *   - Every family the FontFaceSet has materialized (URL- or VFS-loaded
     *     fonts go in here once the browser has registered the @font-face).
     *   - The profile's currently configured output font, if any.
     *   - Locally installed system fonts, but only when the user has already
     *     granted Local Font Access in this browser profile — we never prompt
     *     from inside this getter. A silent prime kicks off here so the next
     *     call sees the result.
     */
    getAvailableFonts(): Record<string, boolean> {
        const set: Record<string, boolean> = {};
        for (const f of getUniversalDefaultFonts()) set[f] = true;
        for (const f of getRegisteredFontFamilies()) set[f] = true;
        const current = selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont');
        if (current?.family) set[current.family] = true;
        for (const f of getCachedLocalFonts()) set[f] = true;
        void primeLocalFontsCache();
        return set;
    }

    /** Flush any buffered partial lines to the main output and all open windows. Called after each event dispatch. */
    flushOutput(): void {
        if (!this.isDeferringEcho) {
            const partial = this.mainConsole.currentPartial;
            if (partial.length > 0) this.session.events.emit('message', partial, 'script-partial');
        }
        this.session.windows.flushAllLines();
    }

    /** @deprecated use echo() */
    print(text: string): void {
        this.echo(text);
    }

    printError(text: string, source?: ScriptLogSource): void {
        this.session.events.emit('script.log', text, 'error', source);
        if (this.showErrorsInMainWindow) {
            this.session.events.emit('message', text, 'error', Date.now());
        }
    }

    destroy(): void {
        for (const unsub of this.apiUnsubs) unsub();
        this.apiUnsubs.length = 0;
        // Script-installed CSS is profile-local (see styleTag): a closed
        // profile's app/profile/window stylesheets must not follow the tab into
        // the next profile opened in it.
        this.removeOwnedStyleTags();
        this.presence.destroy();
        this.flushOutput();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private getConsole(name?: string): Console | null {
        // Mudlet treats the default/empty/"main" name as the main console. The
        // `?? 'main'` only catches null/undefined, so map the empty string too —
        // otherwise getLineNumber(""), getColumnNumber(""), etc. miss the main
        // buffer and return their not-found sentinels.
        const key = name ? name : 'main';
        const con = this.session.consoles.get(key);
        if (con) return con;
        // A window's Console is created lazily by the first write, so a
        // just-created miniconsole had none — and every reader (getLineCount,
        // getLines, moveCursor, …) reported "no such window" for a window that
        // plainly exists. Materialise the empty one instead.
        return this.consoleExists(name) ? this.outputConsole(name) : null;
    }

    /**
     * Whether `windowName` is addressable for text/selection ops. True for the
     * main window, any on-screen window, and off-screen buffers (createBuffer) —
     * all of which back a Console. Used by the read/select methods instead of a
     * bare `windows.has`, which is false for buffers (they have no panel).
     */
    private consoleExists(windowName: string | undefined): boolean {
        if (!windowName || windowName === 'main') return true;
        return this.session.windows.has(windowName) || this.buffers.has(windowName);
    }

    /** Returns the Console for a window, creating and registering one on demand. */
    private outputConsole(win?: string): Console {
        if (!win || win === 'main') return this.mainConsole;
        let con = this.session.consoles.get(win);
        if (!con) {
            con = new Console();
            this.session.consoles.set(win, con);
        }
        return con;
    }

    private drainWindowConsole(win: string, con: Console): void {
        // Off-screen buffers (createBuffer) keep their content in the Console's
        // history only — never push to the WindowManager, which would force a
        // panel open. Drain pending into the void so it can't grow unbounded.
        if (this.buffers.has(win)) {
            con.takeLines();
            return;
        }
        for (const line of con.takeLines()) {
            this.session.windows.pushBuffer(win, line);
        }
        // Also surface the in-flight partial (echo without a trailing \n) so
        // prompts like `echo(win, "Do: ")` actually appear — matches the
        // main-output `script-partial` path. The renderer updates the same
        // DOM element on subsequent partial pushes and finalizes it once a
        // completed line arrives via pushBuffer.
        const partial = con.currentPartial;
        if (partial.length > 0) this.session.windows.pushPartialBuffer(win, partial);
    }

    private resolveBuffer(windowName: string | undefined): AnsiAwareBuffer | null {
        return this.getConsole(windowName)?.getBuffer() ?? null;
    }

    private selectionMatches(win: string | undefined): boolean {
        if (!this.selection) return false;
        const selMain = !this.selection.windowName || this.selection.windowName === 'main';
        const argMain = !win || win === 'main';
        if (selMain && argMain) return true;
        return this.selection.windowName === win;
    }

    private applyStateToSelection(state: FormatStateSnapshot | null): void {
        if (!this.selection || !state) return;
        const sel = this.selection;
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return;
        buf.applyFormat([sel.start, sel.start + sel.length], state);
        // Only rerender if already in the DOM (post-trigger path).
        if (!this.inTriggerProcessing) buf.rerender();
    }

    private drainMain(): void {
        for (const line of this.mainConsole.takeLines()) {
            if (this.isDeferringEcho) {
                this.echoDeferred.push(line);
            } else {
                this.session.events.emit('message', line, 'script');
            }
        }
    }
}
