import type { MudSession, ScriptLogSource, ShowSentTextMode, BlankLinesBehaviour } from '../mud/MudSession';
import type { TelnetNegotiatorFlags } from '../mud/connection/TelnetNegotiator';
import { splitSentCommands } from '../mud/commandSplit';
import type { AliasEngine } from '../mud/aliases/AliasEngine';
import type { TriggerEngine } from '../mud/triggers/TriggerEngine';
import type { TimerEngine } from '../mud/timers/TimerEngine';
import type { KeyEngine } from '../mud/keybindings/KeyEngine';
import { classifyReservedKey, formatKeyCombo, reservedKeyNote } from '../mud/keybindings/browserReservedKeys';
import { CLIENT_VERSION } from '../version';
import { timeZoneAbbreviation, timeZoneLongName, timeZoneOffset } from '../utils/timeZone';
import { getBrand } from '../branding';
import type { WindowHandle, WindowOpenOptions } from '../ui/windows/types';
import { MAP_WIDGET_ID, MAPPER_WIDGET_ID, mapViewWindowId } from '../ui/windows/types';
import type { LabelManager, LabelCreateOptions, LabelMouseEvent, LabelWheelEvent } from '../ui/labels/LabelManager';
import { classifyLabelLink } from '../ui/labels/labelLinks';
import { AddonCommandRegistry } from '../ui/commands/addonCommands';
import { decodeGif, decodeAnimatedImage, sniffDecodableImage, supportsImageDecoder, MoviePlayer } from '../ui/labels/gifMovie';
import { isSvgCandidate, isSvgUrl, resolveSvgIntrinsicSize, svgIntrinsicSizeFromBytes } from '../ui/labels/backgroundImageSize';
import { looksLikeImage } from './lua/imageSize';
import type { CommandLineManager } from '../ui/cmdline/CommandLineManager';
import type { ScrollBoxManager } from '../ui/scrollbox/ScrollBoxManager';
import { TextEditManager } from '../ui/textedit/TextEditManager';
import { userWindowQssToScopedCss, cssEscape, rewriteQtSelectors, patchStyleSheetBackgroundColor } from '../ui/labels/qtCss';
import type { LogFormat } from '../logging/SessionLogger';
import { AnsiAwareBuffer, type FormatColor, type FormatStateSnapshot, type FormatHyperlink, type RgbColor } from '../mud/text/FormatState';
import { classifyHyperlinkUri } from '../mud/text/ansiEscapes';
import { extractQuery, type UnderlineStyle } from '../mud/text/hyperlinkConfig';
import { OscLinkManager } from '../mud/text/oscLinkManager';
import { pumpDelayedReveals } from '../mud/text/hyperlinkVisibility';
import { historyStorageKey, loadHistory } from '../ui/commandHistory';
import { OSC8_DOCS_DEBOUNCE_MS, OSC8_DOCS_PHRASE, osc8DocumentationExamples } from '../mud/text/osc8Docs';
import { SERVER_WRAP_WIDTH_MAX, SERVER_WRAP_WIDTH_MIN } from '../mud/text/serverWrap';
import { decodeTelnetByteTags } from '../mud/connection/telnetByteTags';
import { openOsc8Menu } from '../ui/output/osc8Menu';
import { namedColorToState, dechoToAnsiFast, cechoToAnsiFast, hechoToAnsiFast } from '../mud/text/colorParsers';
import { colorCodes } from '../mud/text/colors';
import { effectiveAmbiguousWidthWide, setAmbiguousWidthWide } from '../mud/text/wcwidth';
import { BAD_LINE_ERROR, Console, MIN_CONSOLE_BUFFER_SIZE, MAX_CONSOLE_BUFFER_SIZE, WINDOW_WRAP_DEFAULT } from '../mud/text/Console';
import { flashTitle } from '../utils/documentTitle';
import { readStoredLogin } from '../utils/storedCredentials';
import { MspParser } from '../mud/protocol';
import { decodeUtf8AsTBuffer, fromByteString } from '../mud/protocol/byteString';
import { canEncodeForServer, decodeForServer } from '../mud/protocol/charset';
import { StopwatchManager, localStorageStopwatchStore } from './StopwatchManager';
import { MxpFrameManager } from './MxpFrameManager';
import { getHeldModifiers } from './heldModifiers';
import { useAppStore, selectProfileField, connectionUrl, PROTOCOL_DEFAULTS, MAPPER_DEFAULTS, MAP_INFO_BG_DEFAULT, type BooleanProtocolKey, type MapperSettings, type MapInfoBgColor, type MudConnection } from '../storage';
import {
    getUniversalDefaultFonts,
    getRegisteredFontFamilies,
    getCachedLocalFonts,
    primeLocalFontsCache,
    getFontGeneration,
    DEFAULT_OUTPUT_FONT_FAMILY,
} from '../utils/fontLoader';
import { isQtResourcePath, qtResourceUrl } from '../assets/qt-resources';
import { ProfilesPresence } from './profilesPresence';
import { MapStore } from '../map/MapStore';
import { type EngineHost, type TempComplexTriggerSpec, NULL_ENGINE_HOST } from './EngineHost';
import { BUNDLED_GAMES, findBundledGame } from '../mud/games/bundledGames';
import { TAB_COMPLETION_LINES, tabCompletionPool } from '../ui/tabCompletion';

// Mudlet's TChar always carries baked-in fg/bg colors (the rendered pair), so
// getFgColor/getBgColor never return "no color" for in-bounds positions. Mudlet Web
// buffer segments are sparse — plain text has no explicit color — so we fall
// back to these defaults.
//
// The foreground is Qt::lightGray, which is what Host::mFgColor starts as and
// what App.css already paints uncoloured console text (`--console-text`). It
// used to be #d4d4d4 here, so Mudlet Web RENDERED plain text at #c0c0c0 and REPORTED
// it as #d4d4d4 — a script comparing getFgColor() against what it could see was
// told they differed.
//
// The background is Qt::black, Host::mBgColor's default, and App.css paints
// every stock theme's console (`--console-bg`) the same. It used to be #090909,
// the app chrome's colour, so a colour trigger for background 0 never matched
// uncoloured text until the profile set its background to black by hand.
const DEFAULT_FG_RGB: [number, number, number] = [0xc0, 0xc0, 0xc0];
/** Mudlet's error for a feedTriggers() chain that hit the nesting cap. Raised,
 *  not returned, by the Lua wrapper in Bridge.lua, which matches on its start. */
const FEED_RUNAWAY_ERROR = 'feedTriggers stopped to prevent a crash: a trigger (or another trigger it feeds) is stuck '
    + 'in an endless loop - the text being fed keeps re-matching a trigger and firing it again and again. '
    + "Change the trigger's pattern or the fed text so they don't match each other.";
const DEFAULT_BG_RGB: [number, number, number] = [0x00, 0x00, 0x00];

/**
 * A colour as colour triggers compare it: packed `0xRRGGBB`. Desktop Mudlet
 * matches a colour trigger by RGB, not by ANSI number (TTrigger's `colorsMatch`
 * compares each TChar's rgba against the pattern's QColor, which
 * `Host::getAnsiColor` resolves from the ANSI code). So a trigger for 196 fires
 * on `38;5;196` text and on truecolor text of the same RGB, and one for 7 fires
 * on uncoloured text, which is drawn in the same light grey.
 */
type RgbKey = number;
/** Pattern codes with a meaning of their own: Mudlet's `TTrigger::scmIgnored`
 *  ("any colour") and `TTrigger::scmDefault` (the console's default). */
/** The font size Mudlet gives a new miniconsole (TMainConsole::createMiniConsole). */
const MINICONSOLE_DEFAULT_FONT_SIZE = 12;

/** What a createBuffer buffer remembers of the window calls made on it. */
interface BufferWidget {
    visible: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    background: { r: number; g: number; b: number; a: number };
    /** Null until setFontSize — the profile's size reads back until then. */
    fontSize: number | null;
    /** Null until setFont — the profile's family reads back until then. */
    fontFamily: string | null;
    /** enable/disableTimeStamps. A buffer is never drawn, but it keeps the
     *  setting as any console does, so a script reads back what it set. */
    timestamps: boolean;
}

const COLOR_IGNORED = -1;
const COLOR_DEFAULT = -2;
/** No colour at all: an ANSI code outside 0-255, or a colour that does not
 *  parse. NaN, so it equals nothing — itself included — and a pattern holding
 *  it matches nothing, as desktop's invalid QColor does. */
const RGB_KEY_NONE: RgbKey = NaN;

function packRgb(r: number, g: number, b: number): RgbKey {
    return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function hexKey(hex: string | undefined): RgbKey {
    const rgb = parseHexToRgb(hex);
    return rgb ? packRgb(rgb[0], rgb[1], rgb[2]) : RGB_KEY_NONE;
}

/** The RGB key of a segment colour, or null when it carries none (the
 *  console's default, which the caller resolves). */
function segmentColorKey(color: FormatColor | undefined): RgbKey | null {
    if (!color) return null;
    if (color.space === 'indexed') return hexKey(colorCodes.xterm[color.index]);
    if (color.space === 'rgb') return packRgb(color.r, color.g, color.b);
    return typeof color.color === 'string' ? hexKey(color.color) : RGB_KEY_NONE;
}

/** The RGB an ANSI code (0-255) names, from the palette the renderer paints
 *  it with — `Host::getAnsiColor`. Codes 0-15 are the profile's own sixteen,
 *  which `colorCodes.xterm` mirrors. */
function ansiCodeKey(code: number): RgbKey {
    if (!Number.isInteger(code) || code < 0 || code > 255) return RGB_KEY_NONE;
    return hexKey(colorCodes.xterm[code]);
}

const HEX_RE = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
function parseHexToRgb(hex: string | undefined): [number, number, number] | null {
    if (!hex) return null;
    const m = HEX_RE.exec(hex);
    if (!m) return null;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** Build a CSS color string from Mudlet-style 0..255 channels (alpha included).
 *  Channels are clamped and rounded; alpha (Mudlet's 0..255 "transparency") is
 *  mapped to CSS's 0..1 range. Used by setCommand{Background,Foreground}Color. */
function rgbaCss(r: number, g: number, b: number, a = 255): string {
    const ch = (n: number) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
    const alpha = Math.max(0, Math.min(1, (Number(a) || 0) / 255));
    return `rgba(${ch(r)}, ${ch(g)}, ${ch(b)}, ${alpha})`;
}

/** `#rrggbb` for an rgb triple, clamped — the form the profile's colour
 *  settings are stored in. */
function hexCss(r: number, g: number, b: number): string {
    const ch = (n: number) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, '0');
    return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/** WCAG relative luminance of an rgb triple, as Mudlet computes it. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
    const channel = (v: number) => {
        const f = v / 255;
        return f <= 0.03928 ? f / 12.92 : Math.pow((f + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two rgb triples (1 = identical, 21 = black on white). */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
    const one = relativeLuminance(a);
    const other = relativeLuminance(b);
    return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

/** The lighter of the two link blues, for consoles too dark for plain blue. */
const LINK_BLUE_LIGHT: [number, number, number] = [80, 160, 255];
const LINK_BLUE: [number, number, number] = [0, 0, 255];

/**
 * Mudlet `readableLinkColor`. Plain blue is barely legible against the dark
 * background most profiles use, so whichever of the two link blues stands out
 * more against this console's background wins. Ties go to plain blue, which is
 * what a light console keeps.
 */
function readableLinkColor(background: [number, number, number]): RgbColor {
    const [r, g, b] = contrastRatio(LINK_BLUE, background) >= contrastRatio(LINK_BLUE_LIGHT, background)
        ? LINK_BLUE
        : LINK_BLUE_LIGHT;
    return { space: 'rgb', r, g, b };
}

/** Clamp a numeric value to [0, 255] and round. Used by the map colour APIs. */
/** Mudlet validates each colour component in 0..255 and names the one that
 *  failed. Returns that message, or null when every component is in range. */
function badColorComponent(components: Record<string, number>): string | null {
    for (const [channel, value] of Object.entries(components)) {
        if (!Number.isFinite(value) || value < 0 || value > 255) {
            return `${channel} value ${value} needs to be between 0-255`;
        }
    }
    return null;
}

/** Split a `#rrggbb` or `#rrggbbaa` string into components. An absent alpha
 *  reads as opaque, which is what Mudlet reports for a colour set without one. */
function parseRgba(hex: string): [number, number, number, number] {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex.trim());
    if (!m) return [0, 0, 0, 255];
    return [
        parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16),
        m[4] === undefined ? 255 : parseInt(m[4], 16),
    ];
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
 *  Accepts the three mode strings; a real boolean is the legacy form of the key
 *  and maps to `script` (on) or `never` (off).
 *
 *  A NUMBER is not a mode. Mudlet reads the value with `lua_isboolean` first and
 *  `lua_isstring` second, and in Lua 5.1 a number is string-convertible — so 42
 *  becomes "42", fails the three-way match and is refused. Treating it as the
 *  boolean toggle instead (which is what Mudlet Web did) meant any number at all
 *  silently turned command echo on. */
function parseShowSentText(value: unknown): ShowSentTextMode | null {
    if (typeof value === 'boolean') return value ? 'script' : 'never';
    if (typeof value === 'string' || typeof value === 'number') {
        const s = String(value).trim().toLowerCase();
        if (s === 'never' || s === 'script' || s === 'always') return s;
        return null;
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
/** The point size saveJsonMap writes for the map symbol font: desktop's
 *  default, since Mudlet Web's setting is a family only. */
const MAP_SYMBOL_FONT_POINT_SIZE = 12;

type Rgba = [number, number, number, number];

/** Desktop's player-room marker settings (Host::mPlayerRoomStyle and friends),
 *  which saveJsonMap writes and loadJsonMap reads. */
interface JsonPlayerRoomSettings {
    style: number;
    outerDiameter: number;
    innerDiameter: number;
    outerColor: Rgba;
    innerColor: Rgba;
}

/** Host's defaults: the plain marker, 120% / 70%, red outside, white inside. */
const DESKTOP_PLAYER_ROOM: Readonly<JsonPlayerRoomSettings> = {
    style: 0,
    outerDiameter: 120,
    innerDiameter: 70,
    outerColor: [255, 0, 0, 255],
    innerColor: [255, 255, 255, 255],
};

/** A colour as Mudlet's JSON map writes one (TMap::writeJsonColor). */
function jsonColor([r, g, b, a]: Rgba): Record<string, number[]> {
    return a < 255 ? { color32RGBA: [r, g, b, a] } : { color24RGB: [r, g, b] };
}

/** The inverse of {@link jsonColor}; undefined for anything else. */
function readJsonRgba(raw: unknown): Rgba | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    const t = Array.isArray(o.color32RGBA) ? o.color32RGBA : Array.isArray(o.color24RGB) ? o.color24RGB : null;
    if (!t) return undefined;
    const c = (i: number, d: number) => (Number.isFinite(Number(t[i])) ? Number(t[i]) : d);
    return [c(0, 0), c(1, 0), c(2, 0), t.length > 3 ? c(3, 255) : 255];
}

const MUDLET_ROOM_SIZE_SCALE = 10;

/** The values `setConfig("ambiguousEAsianWidthCharacters", …)` takes, in the
 *  order Mudlet's refusal lists them. */
const AMBIGUOUS_WIDTH_MODES: readonly string[] = ['narrow', 'wide', 'auto'];

/** The keys Mudlet's setConfig only handles inside its
 *  `if (host.mpMap && host.mpMap->mpMapper)` block — the 2D mapper widget's
 *  own settings. Until a mapper exists they are refused as unknown options. */
const MAPPER_ONLY_CONFIG_KEYS: ReadonlySet<string> = new Set([
    'mapRoomSize', 'mapExitSize', 'mapRoundRooms', 'showRoomIdsOnMap',
    'showMapInfo', 'hideMapInfo', 'show3dMapView', 'mapShowRoomBorders',
    'mapShowGrid', 'showUpperLowerLevels', 'mapInfoColor',
]);

/** Mudlet config keys persisted in the {@link ProfileSettings.config} bag rather
 *  than a dedicated structured field. Each entry gives the value type and the
 *  default `getConfig` returns before the key has been set, so first reads match
 *  Mudlet-ish values. `enum` constrains string writes (an out-of-range value is
 *  rejected). Most are stored only for round-trip fidelity, but a few drive real
 *  behaviour by being read back out of the bag in the React layer (e.g.
 *  `commandLineHistorySaveSize` in CommandBar, `showTabConnectionIndicators` in
 *  the window title). Keys with live, non-bag side-effects (showSentText,
 *  mapperPanelVisible) are handled explicitly in get/setConfig instead. */
/** Words Qt's font database reads as a STYLE on the end of a family name rather
 *  than as part of it — the set QFontDatabase::styleString can produce, which is
 *  weight and slant only. Width words (Condensed, Narrow, Expanded) are
 *  deliberately absent: Qt keeps those in the family name, so "Arial Narrow" is
 *  a family and trimming it would silently substitute Arial. See
 *  {@link ScriptingAPI.resolveFontFamily}. */
const FONT_STYLE_WORDS = new Set([
    'thin', 'extralight', 'ultralight', 'light', 'regular', 'normal', 'book', 'roman',
    'medium', 'demibold', 'semibold', 'bold', 'extrabold', 'ultrabold', 'black', 'heavy',
    'italic', 'oblique',
]);

const CONFIG_PERSIST_ONLY: Record<string, {
    type: 'bool' | 'num' | 'str';
    default: boolean | number | string;
    enum?: readonly string[];
    /** Inclusive bounds for a `num` option. Written as a range rather than
     *  checked at the call site because the refusal has to name the bounds, and
     *  Bridge.lua builds that message — see {@link ScriptingAPI.configKeyRange}. */
    range?: readonly [number, number];
    /** Options that must NOT outlive the session, however ordinary they look.
     *  Kept in memory instead of the profile's config bag. */
    sessionOnly?: true;
}> = {
    // Consumed by ProfileSession (fed into MudSession.setProtocolOptions →
    // TelnetNegotiator's MTTS/NEW-ENVIRON SCREEN_READER reporting) on the next
    // connect — see docs/config-api.md group 2a.
    advertiseScreenReader:          { type: 'bool', default: false },
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
    forceLfAfterPrompt:             { type: 'bool', default: false },
    inputLineStrictUnixEndings:     { type: 'bool', default: false },
    logInHTML:                      { type: 'bool', default: false },
    // The 2D map's room-symbol settings. They live on the map rather than on the
    // mapper widget, which is why the specs for them need no open mapper.
    // Mudlet's own defaults (Host::mMapSymbolFont is the application font at
    // 1.0 scaling, merging enabled); the family is whatever the profile draws
    // output in, since the browser has no application font to inherit.
    mapSymbolFont:                  { type: 'str',  default: DEFAULT_OUTPUT_FONT_FAMILY },
    // The ends of the range Mudlet's preferences spin box offers. NaN is the
    // value a range check has to be written carefully to stop, since it compares
    // false against both bounds — see setConfig.
    mapSymbolFontScaling:           { type: 'num',  default: 1.0, range: [0.5, 2.0] },
    // Qt's NoFontMerging strategy bit: draw symbols only with the chosen family
    // instead of falling back to another font for glyphs it lacks.
    mapSymbolFontOnlyUseSelected:   { type: 'bool', default: false },
    // Session-only on purpose, and Mudlet is the same: a UI package that sets
    // this and is then uninstalled must not leave the map button dead for good,
    // so every session starts back on "default".
    mapperButton:                   {
        type: 'str', default: 'default', enum: ['default', 'scripted', 'disabled'], sessionOnly: true,
    },
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
    // IRC client settings. Mudlet Web has no IRC client (that's a separate service a
    // browser tab can't reach), but the *configuration* is ordinary profile
    // data — Mudlet stores it whether or not the client has ever been opened,
    // and get/setIrcNick and friends read and write exactly this. Defaults are
    // Mudlet's own (dlgIRC.h), so a profile that has never touched IRC still
    // answers with something usable.
    //
    // Named as Mudlet names them (TLuaInterpreter's getConfig map, defaults from
    // dlgIRC.h). The shorter ircNick/ircHost/ircPort/ircSecure spellings Mudlet Web
    // used first are kept as aliases below — get/setIrcNick and the settings UI
    // were written against them, and a script that found them working has no
    // reason to be broken for the sake of the rename.
    ircHostName:                    { type: 'str',  default: 'irc.libera.chat' },
    ircHostPort:                    { type: 'num',  default: 6667, range: [1, 65535] },
    ircHostSecure:                  { type: 'bool', default: false },
    ircNickName:                    { type: 'str',  default: 'Mudlet' },
    ircPassword:                    { type: 'str',  default: '' },
    /** Space-separated, as Mudlet stores it. */
    ircChannels:                    { type: 'str',  default: '#mudlet' },
};

/** The Mudlet Web spellings of the IRC keys, and the Mudlet ones they now mean.
 *  Resolved before every get and set, so both names read and write one value. */
/** Distinguishes "this key is not an experiment" from an experiment that reads
 *  as nil — `<group>.active` answers nil when nothing in the group is on. */
const NOT_AN_EXPERIMENT = Symbol('not-an-experiment');

/** Where the enabled experiment names live in the profile's config bag. */
const EXPERIMENTS_KEY = 'enabledExperiments';

const CONFIG_KEY_ALIASES: Record<string, string> = {
    ircHost:   'ircHostName',
    ircPort:   'ircHostPort',
    ircSecure: 'ircHostSecure',
    ircNick:   'ircNickName',
};

/** Mudlet's valid experiments (Host::mValidExperiments). An experiment is a
 *  rendering or mapper behaviour a build can be asked to try; Mudlet Web implements
 *  none of them, but the switches are ordinary profile state and scripts feature-
 *  test through them, so they are answered rather than refused. Grouped by the
 *  first two dot-segments, and at most one per group may be on. */
const VALID_EXPERIMENTS: readonly string[] = [
    'experiment.rendering.originalish',
    'experiment.rendering.more-transparent',
    'experiment.3dmap.modernmapper',
    'experiment.render-in-out-exits',
    'experiment.3d-player-icon',
];

/** Format an epoch-ms timestamp as Mudlet's `TBuffer::smTimeStampFormat`,
 *  "hh:mm:ss.zzz " (local time) — the trailing space is part of it. */
function formatLineTimestamp(ms: number): string {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} `;
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
 * sizes everywhere in the Mudlet API, and Mudlet Web renders them as CSS `pt`
 * (StickyOutputPanel), so the cell is measured at the CSS-px equivalent
 * (1pt = 4/3 px at 96dpi) to match both Mudlet's QFontMetrics numbers and what
 * the DOM actually paints. The width is measured via a canvas 2D context
 * (monospace fonts have a uniform advance, so any glyph works); height uses
 * the font bounding box ascent+descent when available, falling back to 1.2x
 * size which matches the line-height Qt's QFontMetrics reports for common
 * fonts.
 *
 * The numbers here are NOT rounded, even though Mudlet's are (QFontMetrics
 * answers in whole pixels). Qt can round because TTextEdit then *lays the text
 * out* on that same integer grid; the DOM lays it out on the font's real
 * fractional advance, so a rounded-down cell would hand this client's own
 * column arithmetic a column that does not exist. The classic case is
 * `getColumnCount`, which is `floor(usableWidth / cellW)`: at 11pt Fira Code
 * the true advance is 9.02px, and rounding it to 9 reports 26 columns for a
 * 234px console when only 25 fit — every padded row then folds its right-hand
 * value onto the next line.
 *
 * `calcFontSize` is the one caller that DOES round, because a Lua script
 * multiplies what it returns back up into a widget size — see the note there.
 */
// Geyser calls calcFontSize on the per-constraint path (character-unit
// constraints), so a single re-layout of a large widget tree can reach it
// thousands of times. Allocating a canvas + 2D context per call costs ~41µs;
// the result depends only on (family, size), so measure once and reuse both the
// context and the answer. Measured over 5000 calls: 207ms → 0.1ms.
//
// …but only until a font loads: canvas resolves the family against the faces
// the document has *right now*, so a cell measured before the profile's own
// font arrives is a fallback's cell. The whole cache is dropped when the font
// generation moves (see fontLoader.getFontGeneration) rather than keyed by it,
// so the entries measured against the fallback don't linger.
let measureCtx: CanvasRenderingContext2D | null | undefined;
/** The addresses an MXP `<A>` click opens in a browser tab — see
 *  {@link ScriptingAPI.createMxpHyperlink}. */
const MXP_OPENABLE_URL = /^(https?|ftp|mailto):/i;

const measureCache = new Map<string, [number, number]>();
let measureCacheGeneration = -1;

/** Mudlet's scrollback floor and ceiling for setConsoleBufferSize — shared with
 *  the profile setting so the Lua API and the Settings control agree on both
 *  bounds and on what `useMaximum` means. */
const MIN_CONSOLE_BUFFER_LINES = MIN_CONSOLE_BUFFER_SIZE;
const MAX_CONSOLE_BUFFER_LINES = MAX_CONSOLE_BUFFER_SIZE;

/**
 * Window id backing an MXP `<FRAME name>` — the frame's own name, as in Mudlet,
 * where a frame console goes into the same `mSubConsoleMap` a script's
 * miniconsoles live in. That is what lets Lua read a frame back like any other
 * window (`getLines(frameName, …)`, `windowType(frameName)`), which MXP_spec
 * asserts.
 *
 * The names come from the server, so they used to be prefixed to keep a MUD
 * from seizing a window the client owns — eden calls its minimap frame `map`,
 * which is also what the toolbar's mapper was once called. That job now belongs
 * to the `sys:` prefix every client-owned window id carries (see
 * ui/windows/types.ts), and a frame name cannot contain a `:` in the first
 * place (MxpFrameManager's VALID_FRAME_NAME is alphanumerics, `_` and `-`), so
 * the two id spaces still cannot meet. What is left is the collision Mudlet has
 * too: a server frame and a script miniconsole of the same name are one window.
 */
function mxpWindowId(name: string): string {
    return name;
}

function measureMonospaceCell(family: string, size: number): [number, number] {
    const px = size * 4 / 3;
    const fallback: [number, number] = [px * 0.6, px * 1.2];
    if (typeof document === 'undefined') return fallback;
    const generation = getFontGeneration();
    if (generation !== measureCacheGeneration) {
        measureCache.clear();
        measureCacheGeneration = generation;
    }
    const cacheKey = `${family}|${size}`;
    const hit = measureCache.get(cacheKey);
    if (hit) return hit;
    if (measureCtx === undefined) {
        measureCtx = document.createElement('canvas').getContext('2d');
    }
    const ctx = measureCtx;
    if (!ctx) return fallback;
    const stack = family && family.trim()
        ? `"${family.trim().replace(/[\\"]/g, '\\$&')}", ${DEFAULT_MONO_STACK}`
        : DEFAULT_MONO_STACK;
    ctx.font = `${px}px ${stack}`;
    const m = ctx.measureText('M');
    const ascent = m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent;
    const height = (typeof ascent === 'number' && typeof descent === 'number')
        ? ascent + descent
        : px * 1.2;
    const cell: [number, number] = [m.width, height];
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

    /** Whether a mapper has been created this session (see WindowManager.hasMapper). */
    hasMapper(): boolean {
        return this.session.windows.hasMapper();
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

    /** Re-applies a docking area to a window that is already open — Mudlet's
     *  Host::openWindow honours the `area` argument on every call, not just
     *  the one that creates the dock widget. 'main' means floating. */
    setDockArea(id: string, area: string): void {
        if (!this.session.windows.has(id)) return;
        if (area === 'main') this.session.windows.undock(id);
        else if (area === 'left' || area === 'right' || area === 'top' || area === 'bottom') {
            this.session.windows.dock(id, area);
        }
    }

    /** Whether the window is shown in a dock rather than floating. */
    isDocked(id: string): boolean {
        return this.session.windows.isDocked(id);
    }

    /**
     * Float a docked user window ahead of a move or resize, as Host::moveWindow
     * and Host::resizeWindow do (`if (!pD->isFloating()) pD->setFloating(true)`)
     * before they move or resize the dock widget — which is also why a docked
     * window's getWindowGeometry reads back what resizeWindow set. Geyser's
     * UserWindow:move documents the same ("is set to floating state if this
     * function is used"). setFloating leaves a hidden dock hidden, so this does
     * too. Miniconsoles have no dock and are left alone.
     */
    floatForGeometryChange(id: string): void {
        const wm = this.session.windows;
        if (wm.isMiniConsole(id) || !wm.isDocked(id)) return;
        const wasVisible = wm.isVisible(id);
        wm.undock(id);
        if (!wasVisible) wm.hide(id);
        wm.settleLayout();
    }

    /** Commit the window layout synchronously, so the next script line sees the
     *  sizes a dock change produced (see WindowManager.settleLayout). */
    settleLayout(): void {
        this.session.windows.settleLayout();
    }

    /** Queue the sysUserWindowResizeEvent a freshly opened user window is owed. */
    announceCreatedSize(id: string): void {
        this.session.windows.announceCreatedSize(id);
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
    hasCommandLine(id: string): boolean {
        return this.session.windows.hasCommandLine(id);
    }
    deleteCommandLine(id: string): boolean {
        return this.session.windows.deleteCommandLine(id);
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
    // Mudlet's SVG tint/transform family. Argument and colour checks live in
    // the Lua binding; these only answer whether the label exists.
    setSvgTint(name: string, color: string): boolean { return this.manager.setSvgTint(name, color); }
    resetSvgTint(name: string): boolean { return this.manager.resetSvgTint(name); }
    setSvgRotation(name: string, degrees: number): boolean { return this.manager.setSvgRotation(name, degrees); }
    setSvgShear(name: string, shearX: number, shearY: number): boolean {
        return this.manager.setSvgShear(name, shearX, shearY);
    }
    resetSvgTransform(name: string): boolean { return this.manager.resetSvgTransform(name); }
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
        const ok = this.manager.setBackgroundColor(name, r, g, b, a);
        // The manager patched the background-color declaration inside the
        // label's live stylesheet; the authored copy {@link getStyleSheet}
        // answers with has to move with it, or a script that sets a colour and
        // reads the sheet back is handed the colour it just replaced.
        const authored = ok ? this.authoredCss.get(name) : undefined;
        if (authored !== undefined) {
            this.authoredCss.set(name, patchStyleSheetBackgroundColor(authored, r, g, b, a));
        }
        return ok;
    }
    getBackgroundColor(name: string): { r: number; g: number; b: number; a: number } | null {
        return this.manager.getBackgroundColor(name);
    }
    /** Backs the label branch of the global setFont/getFont — see
     *  {@link ScriptingAPI.setFont}. */
    setFont(name: string, family: string): boolean {
        return this.manager.setFont(name, family);
    }
    getFont(name: string): string | null {
        return this.manager.getFont(name);
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
    /** Mudlet's addon commands (addCommand and friends). Per profile, like
     *  every other placement a package makes. */
    readonly addonCommands = new AddonCommandRegistry();

    /** A player clicked a command's button. Mudlet raises `sysCommandClicked`
     *  with the id as a NUMBER (mudlet.cpp:694-699), which is the id addCommand
     *  handed the package — that is what makes the id worth returning. */
    addonCommandClicked(id: number): void {
        if (!this.addonCommands.get(id)?.enabled) return;
        this.host.raiseEvent('sysCommandClicked', [id]);
    }
    /** Values for the `sessionOnly` options in {@link CONFIG_PERSIST_ONLY} —
     *  held here rather than in the profile's config bag precisely so they are
     *  gone next session. */
    private readonly sessionConfig = new Map<string, unknown>();
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
    // analogous flag (the renderer reads the buffer at paint time), but Mudlet Web
    // renders via 'message' events, so we have to suppress per-mutation
    // rerenders during trigger processing and let the post-trigger render
    // pick up the final state in one shot.
    private inTriggerProcessing = false;

    // While lineBuffer is active, echo/cecho output is held here and flushed
    // to the output *after* the triggering line (or batch) is rendered.
    // A command echoed by a trigger (send()) is queued here too, as its styled
    // text, so it keeps its place among the trigger's echoes.
    private echoDeferred: (AnsiAwareBuffer | { command: string })[] = [];
    private isDeferringEcho = false;

    /** Flip echo deferral, mirroring it onto the session so echoCommand knows
     *  the in-flight console partial belongs to flushDeferredEcho and must not
     *  be closed out from under it. */
    private setDeferringEcho(on: boolean): void {
        this.isDeferringEcho = on;
        this.session.scriptEchoDeferred = on;
        this.session.deferCommandEcho = on ? this.queueCommandEcho : null;
    }

    private readonly queueCommandEcho = (styled: string): void => {
        this.echoDeferred.push({ command: styled });
    };

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
    private loggingToggler: ((enabled: boolean, format: LogFormat) => boolean) | null = null;
    /** Mudlet `appendLog(text)`. Forwarded to the active SessionLogger (wired by
     *  ProfileSession, which owns the logger lifecycle). */
    private logAppender: ((text: string) => void) | null = null;
    /** Mudlet `closeMudlet()`. Mudlet Web maps it to "close the active profile":
     *  disconnect, then return to the connection screen. Wired by ProfileSession. */
    private closeProfileCallback: (() => void) | null = null;
    /** A closeMudlet() is armed and has not run yet (see closeMudlet). */
    private closeMudletArmed = false;
    /** Set by destroy(): an armed closeMudlet() that outlives the profile
     *  has nothing left to close. */
    private destroyed = false;

    /** One selection per console, keyed by window name ('main' for the main
     *  console), the way each desktop TConsole keeps its own P_begin/P_end:
     *  selecting or deselecting in one window leaves every other window's
     *  selection standing. */
    private readonly selections = new Map<string, { windowName: string | undefined; start: number; length: number }>();

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
    //
    // Desktop's buffer is a full TConsole that is simply never shown, so the
    // window functions accept it like any console: it keeps a background
    // colour, a font size, a geometry and a visible flag of its own, all of
    // which read back exactly as they were set (mudlet-web#380).
    private buffers = new Map<string, BufferWidget>();

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
        // Another tab's closeProfile(<this profile>).
        this.presence.onCloseRequested = () => { this.closeMudlet(); };
        // Re-announce this tab's connected state to other tabs on connect/
        // disconnect (for their getProfiles). Deferred to a microtask so the
        // session's own status handler has run before we read session.status.
        const announce = () => { queueMicrotask(() => this.presence.announce()); };
        this.apiUnsubs.push(session.events.on('client.connect', announce));
        this.apiUnsubs.push(session.events.on('client.disconnect', announce));
        // An encoding agreed by accepting a server's CHARSET REQUEST is saved to
        // the profile, as cTelnet's `setEncoding(acceptedEncoding, true)` saves
        // it — the next session opens on it, and the Settings dropdown shows it.
        this.apiUnsubs.push(session.events.on('charset.accepted', (encoding) => {
            useAppStore.getState().patchConnectionProfile(connectionId, { serverEncoding: encoding });
        }));
        session.consoles.set('main', this.mainConsole);
        // Mudlet applies the profile's `consoleBufferSize` to the main console
        // as soon as it exists (mudlet.cpp:2264-2271). The session holds the
        // resolved value because the setting can be read before this console is
        // constructed; later changes come back through setConsoleBufferSize.
        session.applyConsoleBufferSize(this.mainConsole);
        // Mudlet `sysBufferShrinkEvent("main", linesRemoved)` — named user
        // windows have the same hook wired in WindowManager.registerConsole.
        this.mainConsole.onBufferShrink = (n) => this.host.raiseEvent('sysBufferShrinkEvent', ['main', n]);
        // Mudlet gives the main console the profile's wrap (Host::mWrapAt, 100
        // by default) when it is created, and again whenever the preferences
        // change it (TConsole::changeColors). The Settings UI writes the store
        // directly, so follow the store rather than only setWindowWrap.
        this.applyStoredWrap(undefined);
        this.apiUnsubs.push(useAppStore.subscribe((state, prev) => {
            if (state.connectionProfile === prev.connectionProfile) return;
            const next = state.connectionProfile[this.connectionId];
            const old = prev.connectionProfile[this.connectionId];
            if (next?.outputWrapAt === old?.outputWrapAt
                && next?.outputWrapIndent === old?.outputWrapIndent
                && next?.outputWrapHangingIndent === old?.outputWrapHangingIndent) return;
            this.applyStoredWrap(undefined);
        }));
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

    /**
     * Mudlet's Lua `send()`, which is C++ `sendRaw` → `Host::send(text,
     * wantPrint, dontExpandAliases = true)`: the whole text is echoed once under
     * the showSentText mode, then split on the profile's command separator, and
     * each part goes to the game **without** passing through the aliases. Item
     * `command` fields take the alias-expanding path instead —
     * {@link ScriptingEngine.hostSend}.
     */
    send(text: string, echo = true): void {
        // Split what the echo hands back, as Host::send does — an echoed
        // `send("x;;")` sends `x` and then a bare line feed on desktop.
        const asSent = this.session.echoSentCommand(text, echo);
        const parts = splitSentCommands(asSent, this.getCommandSeparator());
        // Nothing but separators (or nothing at all) still reaches the game as a
        // bare line feed — Mudlet's "allow sending blank commands" branch.
        if (parts.length === 0) { this.sendData(''); return; }
        for (const part of parts) this.sendData(part);
    }

    /** The tail of `Host::send`: one already-echoed, already-split command onto
     *  the wire. Same `sysDataSendRequest` veto as {@link send}, no echo. With
     *  no engine wired yet (early init) the no-op host reports "not denied", so
     *  this sends straight through. */
    sendData(text: string): void {
        if (this.host.dispatchSendRequest(text)) return;
        this.session.sendData(text);
    }

    sendGmcp(message: string): void {
        this.session.sendGmcpRaw(message);
    }

    /** Mudlet `sendMSDP(variable, ...values)`. Frames an MSDP subnegotiation
     *  (`IAC SB MSDP MSDP_VAR <var> [MSDP_VAL <val>]... IAC SE`) and sends it. */
    sendMSDP(variable: string, values: string[]): boolean {
        return this.session.sendMSDP(variable, values);
    }

    /** Mudlet `sendSocket(data [, parseTelnetCodes])`. Sends a literal
     *  byte-string over the socket with no telnet/encoding processing (each
     *  char is one byte). With `parseTelnetCodes` the `<T_IAC>`-style tags are
     *  decoded first, as feedTelnet's are (TLuaInterpreter::parseTelnetCodes). */
    sendSocket(data: string, parseTelnetCodes = false): boolean {
        return this.session.sendSocket(parseTelnetCodes ? decodeTelnetByteTags(data) : data);
    }

    /** Mudlet `feedTelnet(data)`. Injects raw server bytes into the inbound
     *  pipeline as if received from the MUD (telnet stripping → ANSI →
     *  triggers → render). */
    /** Mudlet `feedTelnet(data)` — inject imitation server bytes. Refused while
     *  a socket exists in any state but unconnected, so replayed data can never
     *  interleave with a live stream; the message is returned for the binding to
     *  shape into Mudlet's `(nil, errMsg)`, and null means it was fed.
     *
     *  The empty string is not data: it asks which version of the byte-tag
     *  table this client decodes, and feeds nothing (TLuaInterpreter::feedTelnet
     *  answers `true, "feedTelnet: using table version N"` for it). */
    feedTelnet(data: string): string | { version: string } | null {
        if (!this.session.isSocketUnconnected()) {
            return 'feedTelnet: refused, telnet connection socket is not in the unconnected state';
        }
        if (data.length === 0) return { version: decodeTelnetByteTags('') };
        // Same as feedTriggers: a trigger the calling chunk just created or
        // switched on has to be in the engine before the bytes reach it, and
        // the coalesced reload cannot run while that chunk is on the stack.
        this.host.flushPendingApplies();
        // `data` is a BYTE-STRING: one char per byte, as a socket produces and
        // as everything downstream reads it (MSDP decodes its values from the
        // game's bytes, for one). The Lua binding unarmors it into that shape — see
        // byteArmor.ts for why the crossing cannot be made in plain text.
        //
        // The `<T_IAC><T_GA>`-style placeholders are decoded after: a telnet
        // stream is made of bytes a Lua string cannot carry comfortably, so
        // Mudlet lets the data name them instead. See telnetByteTags.ts.
        this.session.feedTelnet(decodeTelnetByteTags(data));
        return null;
    }

    /** Mudlet `loadReplay(fileName)` core. Starts playback of a Mudlet binary
     *  replay (.dat). The LuaRuntime binding reads the bytes from the VFS
     *  before calling here, and hands over `readAt` so playback reads each
     *  chunk again from the file as it comes up (see MudSession.loadReplayData).
     *  Returns null on success or the failure reason. */
    loadReplay(bytes: Uint8Array, readAt?: (position: number, length: number) => Uint8Array): string | null {
        return this.session.loadReplayData(bytes, readAt);
    }

    /** Deliver any replay chunk that has come due. Only the busted pump calls
     *  this — see MudSession.pumpReplay. */
    pumpReplay(): number {
        return this.session.pumpReplay();
    }

    /** Commit a line held for a server-wrap continuation whose flush delay has
     *  elapsed. Same reason as {@link pumpReplay}: the busted runner blocks the
     *  event loop the timer would have fired on. */
    pumpServerWrap(): boolean {
        return this.session.pumpServerWrap();
    }

    /** Put back the text of an OSC 8 link written concealed whose reveal delay
     *  has elapsed. Same reason again: the runner blocks the event loop the
     *  reveal timer would have fired on. */
    pumpHyperlinkReveals(): boolean {
        return pumpDelayedReveals();
    }

    /** Report the size of a user window just opened. Same reason again: the
     *  runner blocks the turn that report was queued for. */
    pumpCreatedWindowSizes(): boolean {
        return this.session.windows.pumpCreatedSizes();
    }

    /** Run the map info contributors for a repaint of the map widget that
     *  updateMap() or centerview() asked for. Same reason again: the runner
     *  blocks the render that paint would have come with. */
    pumpMapPaint(): boolean {
        return this.session.windows.pumpMapPaint();
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

    /** Whether the server has taken GMCP up on this connection — Mudlet's
     *  `cTelnet::isGMCPEnabled`, which `sendGMCP` is refused without. */
    isGmcpEnabled(): boolean {
        return this.session.isGmcpEnabled();
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
     *  `name` (one of getServerEncodingsList()). Returns true, or the refusal
     *  cTelnet::setEncoding gives — the only place a script author is shown
     *  every name they could have asked for, so it lists them all, ASCII first
     *  as Mudlet does. */
    setServerEncoding(name: string): true | string {
        if (this.session.setServerEncoding(name)) {
            // Saved to the profile, as cTelnet::setEncoding(…, saveValue = true)
            // writes it for a script — the next session opens on it, and the
            // Settings dropdown shows it.
            useAppStore.getState().patchConnectionProfile(this.connectionId, {
                serverEncoding: this.session.getServerEncoding(),
            });
            return true;
        }
        const names = ['ASCII', ...this.session.getServerEncodingsList().filter(e => e !== 'ASCII')];
        return `Encoding "${name}" does not exist;\nuse one of the following:\n"${names.join('", "')}".`;
    }

    /** Mudlet `getServerEncodingsList()`. The encodings Mudlet Web can decode. */
    getServerEncodingsList(): string[] {
        return this.session.getServerEncodingsList();
    }

    /** Mudlet `getCharacterName()` — `Host::getLogin()`, the character name the
     *  profile logs in with, *not* the profile name. '' when none is saved; the
     *  Lua wrapper reports that as Mudlet's `nil, "no character name set"`.
     *  Read through {@link readStoredLogin}, the same source auto-login and the
     *  GMCP `Char.Login` reply use, so a branded build's in-memory login counts. */
    getCharacterName(): string {
        return readStoredLogin(this.connectionId).account;
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

    /** Mudlet `loadProfile(name)`. Opens the named profile and connects
     *  to it. Each profile lives in its own browser tab (the per-profile lock
     *  keeps it to one tab), so this opens a NEW tab at `?profile=<id>&connect=1`
     *  rather than switching the current one — the calling profile stays open
     *  alongside, mirroring Mudlet's multi-profile model.
     *
     *  Returns null on success, or the message for Mudlet's `nil, message`
     *  refusal: an unknown name, a profile already open (in this tab or any
     *  other — the loaded set is the same one getProfiles() reports), or a popup
     *  the browser blocked. NOTE: `window.open` needs a user gesture, so this
     *  works from a key/button/alias but a browser may block it from a trigger
     *  (no Mudlet equivalent to that limitation). */
    loadProfile(name: string): string | null {
        const target = name ?? '';
        const conn = useAppStore.getState().connections.find(c => c.name === target);
        if (!conn) return `loadProfile: profile '${target}' does not exist`;
        if (conn.id === this.connectionId || this.presence.loadedIds().includes(conn.id)) {
            return `loadProfile: profile '${target}' is already loaded`;
        }
        const url = new URL(window.location.href);
        url.searchParams.set('profile', conn.id);
        url.searchParams.set('connect', '1');
        const w = window.open(url.toString(), '_blank');
        return w ? null : `loadProfile: could not open profile '${target}', the browser blocked the new tab`;
    }

    /** Mudlet `closeProfile(name)`. Closes the named open profile — this one,
     *  or one open in another tab, which is asked to close itself over the
     *  profiles-presence channel. Closing is what `closeMudlet()` does here:
     *  disconnect, then return that tab to the connection screen.
     *
     *  Returns null on success, or the message for Mudlet's `nil, message`
     *  refusal when no open profile has that name. Like Mudlet, which closes the
     *  tab on the next event-loop turn, the close happens after the calling
     *  script has returned — so a script closing its own profile still finishes
     *  (closeMudlet defers itself). */
    closeProfile(name: string): string | null {
        const target = name ?? '';
        const conn = useAppStore.getState().connections.find(c => c.name === target);
        const notLoaded = `closeProfile: profile '${target}' does not exist`;
        if (!conn) return notLoaded;
        if (conn.id === this.connectionId) {
            this.closeMudlet();
            return null;
        }
        if (!this.presence.loadedIds().includes(conn.id)) return notLoaded;
        return this.presence.requestClose(conn.id) ? null : notLoaded;
    }

    /** Mudlet `setActiveProfile(name)`: make an open profile the one in front.
     *  The name is matched as MudletApp::getCanonicalProfileName matches it —
     *  case-insensitively against the profiles, then against the bundled games
     *  (a game with no profile is "not loaded").
     *
     *  Returns null on success or the refusal message. Each profile has a tab
     *  of its own here, and a page can't bring another tab forward — browsers
     *  only let the user switch tabs — so for a profile open elsewhere this
     *  answers true, as desktop does, without the switch; for this tab's own
     *  profile it asks for the window's focus. */
    setActiveProfile(name: string): string | null {
        const requested = name ?? '';
        if (requested === '') return 'setActiveProfile: profile name cannot be empty';
        const lower = requested.toLowerCase();
        const conn = [...useAppStore.getState().connections]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .find(c => c.name.toLowerCase() === lower);
        const canonical = conn?.name ?? BUNDLED_GAMES.find(g => g.name.toLowerCase() === lower)?.name;
        if (canonical === undefined) return `setActiveProfile: profile '${requested}' does not exist`;
        const loaded = conn !== undefined
            && (conn.id === this.connectionId || this.presence.loadedIds().includes(conn.id));
        if (!loaded) return `setActiveProfile: profile '${canonical}' is not loaded`;
        if (conn.id === this.connectionId) {
            try { window.focus(); } catch { /* not focusable here */ }
        }
        return null;
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

    /** The negotiator flag each profile protocol toggle drives. MCCP is
     *  absent on purpose: its handler owns its own switch and isn't part of
     *  the negotiator flag set. */
    private static readonly LIVE_PROTOCOL_FLAG: Partial<Record<BooleanProtocolKey, keyof TelnetNegotiatorFlags>> = {
        gmcp: 'gmcpEnabled',
        mtts: 'mttsEnabled',
        msdp: 'msdpEnabled',
        mssp: 'msspEnabled',
        charset: 'charsetEnabled',
        msp: 'mspEnabled',
        mxp: 'mxpEnabled',
        mnes: 'mnesEnabled',
        newEnviron: 'newEnvironEnabled',
        naws: 'nawsEnabled',
    };

    private getProtocol(key: BooleanProtocolKey): boolean {
        const p = useAppStore.getState().connectionProfile[this.connectionId]?.protocols;
        return p?.[key] ?? PROTOCOL_DEFAULTS[key];
    }

    private setProtocol(key: BooleanProtocolKey, value: boolean): void {
        const prev = useAppStore.getState().connectionProfile[this.connectionId]?.protocols ?? {};
        useAppStore.getState().patchConnectionProfile(this.connectionId, { protocols: { ...prev, [key]: value } });
        // The store change reaches the session through ProfileSession, but not
        // until the next render — and a script that turns a protocol off and
        // then reads the wire is still inside this call. Mudlet has no such
        // gap (setConfig writes the very flag cTelnet reads), so the session
        // is told directly as well; the effect's later re-apply is a no-op.
        const flag = ScriptingAPI.LIVE_PROTOCOL_FLAG[key];
        if (flag) this.session.setProtocolOptions({ [flag]: value });
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
    getConfig(rawKey: string, useStringFormat = false): unknown {
        const key = CONFIG_KEY_ALIASES[rawKey] ?? rawKey;
        const experiment = this.readExperimentConfig(key);
        if (experiment !== NOT_AN_EXPERIMENT) return experiment;
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
            // mixed-case `enableNewEnviron` is kept as a Mudlet Web alias.
            case 'enableNEWENVIRON':
            case 'enableNewEnviron': return this.getProtocol('newEnviron');
            case 'enableCHARSET': return this.getProtocol('charset');
            case 'enableNAWS': return this.getProtocol('naws');
            // structured — inverse "force negotiation off" toggles
            case 'specialForceMxpNegotiationOff':     return !this.getProtocol('mxp');
            case 'specialForceCharsetNegotiationOff': return !this.getProtocol('charset');
            case 'specialForceCompressionOff':        return !this.getProtocol('mccp');
            // Desktop keeps this the plain inverse of enableNEWENVIRON
            // (Host::mEnableNEWENVIRON) in both directions; MNES is a separate
            // preference it never reads or writes.
            case 'forceNewEnvironNegotiationOff':     return !this.getProtocol('newEnviron');
            // structured — input line
            case 'autoClearInputLine':
                return selectProfileField(useAppStore.getState(), this.connectionId, 'autoClearInput') ?? false;
            // structured — MSSP secure-port offer (Mudlet Host::mAskTlsAvailable).
            // A typed field rather than a config-bag key: the offer logic and the
            // Settings checkbox both read it, and declining the offer clears it.
            case 'askTlsAvailable':
                return selectProfileField(useAppStore.getState(), this.connectionId, 'askTlsAvailable') ?? true;
            // structured — mapper
            // Mudlet's getConfig reports mapRoomSize in the tenths-of-a-cell
            // unit its setConfig takes (qRound(mRoomSize * 10)), so a script can
            // hand the answer straight back; mapExitSize is the internal
            // mLineSize, which is the unit its setter takes already.
            case 'mapRoomSize':
                return Math.round((this.getMapperField('roomSize') ?? MAPPER_DEFAULTS.roomSize) * MUDLET_ROOM_SIZE_SCALE);
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
            // Mudlet Host::getWideAmbiguousEAsianGlyphsControlState: the
            // profile's tri-state, held in the boolean the Settings toggle
            // writes, with "never chosen" meaning auto.
            case 'ambiguousEAsianWidthCharacters': {
                const wide = selectProfileField(useAppStore.getState(), this.connectionId, 'ambiguousWidthWide');
                return wide === undefined ? 'auto' : wide ? 'wide' : 'narrow';
            }
            // Mudlet's mShowPanel — the mapper's *control bar*, not the map
            // window (that's openMapWidget/closeMapWidget). Default true.
            case 'mapperPanelVisible':
                return selectProfileField(useAppStore.getState(), this.connectionId, 'mapperPanelVisible') ?? true;
            // live — the join runs in the line assembler, so these read back off
            // the session rather than the bag
            case 'undoServerWrap':      return this.session.undoServerWrap;
            case 'undoServerWrapWidth': return this.session.undoServerWrapWidth;
            // Mudlet leaves "matches", "multimatches" and "line" out of the
            // globals table until a script reads them; Mudlet Web sets them up
            // front on every dispatch, which is Mudlet with this switched off
            // (see e2e/knownDivergences.ts).
            case 'lazyCaptureGlobals':  return false;
            case 'muteMediaAPI':       return this.session.sounds.isOriginMuted('api');
            case 'muteMediaGame':      return this.session.sounds.isOriginMuted('game');
            // read-only
            case 'logDirectory':       return '/profiles/' + this.connectionId + '/log';
            case 'specialForceMXPProcessorOn':
                return configBool(this.configBag().specialForceMXPProcessorOn ?? false);
        }
        const spec = CONFIG_PERSIST_ONLY[key];
        if (spec) {
            const stored = spec.sessionOnly ? this.sessionConfig.get(key) : this.configBag()[key];
            if (stored === undefined) return spec.default;
            // A stored number outside the option's own bounds is answered with
            // the default rather than handed back. Mudlet's readers do this
            // (dlgIRC::readIrcHostPort falls back to 6667 for anything outside
            // 1..65535) because the writers do not all validate, so a profile
            // can carry a value the rest of the client would choke on.
            if (spec.type === 'num' && spec.range && typeof stored === 'number'
                && (stored < spec.range[0] || stored > spec.range[1])) {
                return spec.default;
            }
            return stored;
        }
        return undefined;
    }

    /**
     * `getConfig` for the `experiment.*` namespace, or {@link NOT_AN_EXPERIMENT}
     * when the key is not one. Three shapes: `experiment.list` is the names this
     * build knows, `<group>.active` is the suffix of whichever experiment in
     * that group is on (nil when none is), and any other key reads as the
     * on/off flag — FALSE for a name this build has never heard of, rather than
     * a refusal, so a script can feature-test one that does not exist here.
     */
    private readExperimentConfig(key: string): unknown {
        if (!key.startsWith('experiment.')) return NOT_AN_EXPERIMENT;
        if (key === 'experiment.list') return [...VALID_EXPERIMENTS];
        if (key.endsWith('.active')) {
            const group = key.slice(0, -'.active'.length) + '.';
            for (const name of this.enabledExperiments()) {
                if (name.startsWith(group)) return name.slice(group.length);
            }
            return null;
        }
        return VALID_EXPERIMENTS.includes(key) && this.enabledExperiments().includes(key);
    }

    /** The experiments currently switched on, as stored in the profile bag. */
    private enabledExperiments(): string[] {
        const stored = this.configBag()[EXPERIMENTS_KEY];
        return Array.isArray(stored) ? stored.filter((n): n is string => typeof n === 'string') : [];
    }

    /**
     * `setConfig` for the `experiment.*` namespace: true on success, or the
     * refusal message. At most one experiment in a group may be on at a time —
     * a group being the first two dot-segments — so enabling one turns off
     * whichever of its siblings was on (Host::setExperimentEnabled).
     */
    private writeExperimentConfig(key: string, value: unknown): true | string {
        if (!VALID_EXPERIMENTS.includes(key)) return `Invalid experiment name: ${key}`;
        if (typeof value !== 'boolean') {
            return `setConfig: bad argument #2 type (experiment state as boolean expected, got ${typeof value})`;
        }
        const group = key.split('.').slice(0, 2).join('.') + '.';
        const kept = this.enabledExperiments().filter(name =>
            name !== key && !(key.split('.').length > 2 && name.startsWith(group)));
        this.patchConfigBag(EXPERIMENTS_KEY, value ? [...kept, key] : kept);
        return true;
    }

    /** The bounds a `num` option accepts, for the refusal Bridge.lua writes.
     *  Null when the key is unbounded or names no option. */
    configKeyRange(key: string): readonly [number, number] | null {
        return CONFIG_PERSIST_ONLY[CONFIG_KEY_ALIASES[key] ?? key]?.range ?? null;
    }

    /** The values a string option accepts, for the refusal Bridge.lua writes —
     *  the list is the only place a script author is told what the option takes,
     *  so it has to reach the message. Null when the key takes no fixed set. */
    configKeyValues(key: string): readonly string[] | null {
        const resolved = CONFIG_KEY_ALIASES[key] ?? key;
        if (resolved === 'blankLinesBehaviour') return ['show', 'hide', 'replacewithspace'];
        if (resolved === 'ambiguousEAsianWidthCharacters') return AMBIGUOUS_WIDTH_MODES;
        if (resolved === 'showSentText') return ['never', 'always', 'script'];
        return CONFIG_PERSIST_ONLY[resolved]?.enum ?? null;
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
    configKeyKind(rawKey: string): 'bool' | 'num' | 'str' | 'any' | 'readonly' | null {
        const key = CONFIG_KEY_ALIASES[rawKey] ?? rawKey;
        // Mudlet only knows these while the 2D mapper exists
        // (`host.mpMap->mpMapper`): before the map has been shown, setConfig
        // refuses them as unknown keys whatever the value, so this is decided
        // ahead of the type check.
        if (MAPPER_ONLY_CONFIG_KEYS.has(key) && !this.session.windows.hasMapper()) return null;
        // An experiment takes a boolean, and one this build has never heard of
        // is still a KEY — its refusal has to name it, which it cannot do from
        // the generic "no such option" path. The two pseudo-keys are reads.
        if (key.startsWith('experiment.')) {
            return key === 'experiment.list' || key.endsWith('.active') ? 'readonly' : 'bool';
        }
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
            case 'mapperPanelVisible': case 'undoServerWrap':
            case 'lazyCaptureGlobals':
                return 'bool';
            case 'mapRoomSize': case 'mapExitSize': case 'undoServerWrapWidth':
                return 'num';
            case 'blankLinesBehaviour':
            case 'ambiguousEAsianWidthCharacters':
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
    /**
     * The room symbols the named font has no glyph for, quoted, or null when it
     * can draw every one the map uses.
     *
     * Measured rather than looked up, because a browser will not say what a
     * font contains: a character with no glyph is drawn as the font's notdef
     * box, and every such character therefore measures the SAME width. So each
     * symbol is compared against a codepoint nothing has a glyph for — the last
     * of Private Use Plane 16 — in the same font at the same size. Equal widths
     * mean both came out as the box.
     */
    private symbolsThisFontCannotDraw(family: string): string | null {
        const symbols = this.session.windows.mapRoomSymbols?.() ?? [];
        if (symbols.length === 0) return null;
        const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
        const ctx = canvas?.getContext('2d');
        if (!ctx) return null;
        ctx.font = `32px "${family}"`;
        // U+10FFFD: unassigned, and unassignable — nothing can have a glyph for
        // it, so its width IS the notdef width for this font.
        const notdef = ctx.measureText('\u{10FFFD}').width;
        const missing = symbols.filter(s => s && ctx.measureText(s).width === notdef);
        if (missing.length === 0) return null;
        return [...new Set(missing)].map(s => `"${s}"`).join(', ');
    }

    /** Returns true, or a string when the option was taken and the caller
     *  should be told something about it — see the mapSymbolFont case. */
    setConfig(rawKey: string, value: unknown): boolean | string {
        const key = CONFIG_KEY_ALIASES[rawKey] ?? rawKey;
        if (key.startsWith('experiment.')) {
            const written = this.writeExperimentConfig(key, value);
            return written === true ? true : written;
        }
        switch (key) {
            case 'enableGMCP': this.setProtocol('gmcp', configBool(value)); return true;
            case 'enableMSDP': this.setProtocol('msdp', configBool(value)); return true;
            case 'enableMSP':  this.setProtocol('msp',  configBool(value)); return true;
            case 'enableMSSP': this.setProtocol('mssp', configBool(value)); return true;
            case 'enableMTTS': this.setProtocol('mtts', configBool(value)); return true;
            case 'enableMXP':  this.setProtocol('mxp',  configBool(value)); return true;
            case 'enableMNES': this.setProtocol('mnes', configBool(value)); return true;
            // Mudlet's canonical key is `enableNEWENVIRON`; `enableNewEnviron` is
            // a Mudlet Web alias. Both route to the same NEW-ENVIRON protocol flag.
            case 'enableNEWENVIRON':
            case 'enableNewEnviron': this.setProtocol('newEnviron', configBool(value)); return true;
            case 'enableCHARSET': this.setProtocol('charset', configBool(value)); return true;
            case 'enableNAWS': this.setProtocol('naws', configBool(value)); return true;
            case 'specialForceMxpNegotiationOff':     this.setProtocol('mxp',     !configBool(value)); return true;
            case 'specialForceCharsetNegotiationOff': this.setProtocol('charset', !configBool(value)); return true;
            case 'specialForceCompressionOff':        this.setProtocol('mccp',    !configBool(value)); return true;
            // The inverse of enableNEWENVIRON and nothing more: desktop leaves
            // enableMNES as it was, so un-forcing brings back whichever variant
            // the profile had chosen.
            case 'forceNewEnvironNegotiationOff':
                this.setProtocol('newEnviron', !configBool(value));
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
                if (Number.isFinite(n) && n >= 1) {
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
            // Mudlet Host::setWideAmbiguousEAsianGlyphs. "auto" is decided from
            // the server encoding there and then (wide for the CJK ones), as
            // desktop decides it; lines wrapped from now on use the new width.
            // Stored in the Settings toggle's field so the two cannot disagree:
            // true/false for a chosen width, unset for auto.
            case 'ambiguousEAsianWidthCharacters': {
                const mode = String(value);
                if (!AMBIGUOUS_WIDTH_MODES.includes(mode)) return false;
                const wide = mode === 'auto' ? undefined : mode === 'wide';
                setAmbiguousWidthWide(effectiveAmbiguousWidthWide(wide, this.session.getServerEncoding()));
                useAppStore.getState().patchConnectionProfile(this.connectionId, { ambiguousWidthWide: wide });
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
            // Mudlet Host::mFORCE_GA_OFF. Persisted like the rest of its group,
            // but also pushed at the live client, which takes it only while
            // unconnected — the state a profile injecting with feedTelnet is in.
            case 'specialForceGAOff': {
                const on = configBool(value);
                this.session.setSpecialForceGAOff(on);
                this.patchConfigBag('specialForceGAOff', on);
                return true;
            }
            // Host::mUSE_UNIX_EOL, which cTelnet::sendData reads on every send.
            // Pushed at the session here as well as persisted: left to
            // ProfileSession's next render, a send() in the same chunk as the
            // setConfig still went out with the old line ending (#336).
            case 'inputLineStrictUnixEndings': {
                const on = configBool(value);
                this.session.setInputLineStrictUnixEndings(on);
                this.patchConfigBag('inputLineStrictUnixEndings', on);
                return true;
            }
            // Only the value it already has: see getConfig
            case 'lazyCaptureGlobals': return !configBool(value);
            // Mudlet Host::mUndoServerWrap — rejoin the lines the game wrapped
            // itself. Live: the line assembler judges the next server line under
            // the new setting, and turning it off commits anything held.
            case 'undoServerWrap': {
                const on = configBool(value);
                this.session.setUndoServerWrap(on);
                // Persist as well as apply. Structured rather than a config-bag
                // key because the Settings checkbox and the Mudlet profile XML
                // both read it, and because ProfileSession re-pushes the stored
                // value onto the session on every render — a value that lived
                // only on the session would be reverted by the next store update
                // and lost on reload.
                useAppStore.getState().patchConnectionProfile(this.connectionId, { undoServerWrap: on });
                return true;
            }
            // Out of range is a refusal rather than a clamp, matching Mudlet's
            // getVerifiedInt bounds check — a width the caller never chose would
            // leave the join running at a column nothing asked for.
            case 'undoServerWrapWidth': {
                const width = Math.trunc(Number(value));
                if (!Number.isFinite(width)
                    || width < SERVER_WRAP_WIDTH_MIN || width > SERVER_WRAP_WIDTH_MAX) return false;
                this.session.setUndoServerWrapWidth(width);
                useAppStore.getState().patchConnectionProfile(this.connectionId, { undoServerWrapWidth: width });
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
            else if (spec.type === 'num') {
                const n = Number(value);
                // Inverted deliberately: `n < min || n > max` lets NaN through,
                // since it compares false against both bounds — and a scaling of
                // NaN would blank every room symbol on the map. Written this way
                // the infinities are refused by the same expression.
                if (spec.range && !(n >= spec.range[0] && n <= spec.range[1])) return false;
                v = n;
            } else {
                v = String(value);
                if (spec.enum && !spec.enum.includes(v as string)) return false;
                // A font option stores the family the font database names, not
                // the string the caller typed, so reading it back gives
                // something that can be passed to setFont — and an unknown
                // family is refused rather than silently drawn as a fallback.
                if (key === 'mapSymbolFont') {
                    const family = this.resolveFontFamily(v as string);
                    if (!family) return false;
                    v = family;
                }
            }
            if (spec.sessionOnly) this.sessionConfig.set(key, v);
            else this.patchConfigBag(key, v);
            // The buffer search's key is held only while the search is on, and
            // a package may already be sitting on it. Qt answers two things on
            // one key by disabling BOTH, so switching the search on over a
            // command would cost the player the search they just asked for as
            // well as the command, with nothing on screen to say why.
            if (key === 'f3SearchEnabled') {
                const on = v === true;
                if (on) {
                    for (const command of this.addonCommands.commandsOn(this.addonCommands.searchShortcut)) {
                        // Said in the main window rather than through
                        // printError: it is a notice, not a script fault, and
                        // an error only reaches main when the profile asked for
                        // errors there — which is exactly when it would be
                        // missed by the player who needs it.
                        //
                        // Written to the buffer as well as emitted, for the
                        // reason warnIfUnencodable gives: a line the player can
                        // read has to be a line getLines() and the cursor APIs
                        // can see, and the emit alone only reaches the renderer.
                        const notice = `\x1b[36m[ INFO ]\x1b[0m  - the buffer search has taken `
                            + `${this.addonCommands.searchShortcut.toUpperCase()} from the command `
                            + `"${command.name}", which no longer has a shortcut`;
                        this.mainConsole.appendLine(new AnsiAwareBuffer(notice));
                        this.session.events.emit('message', notice, 'script', Date.now());
                    }
                }
                this.addonCommands.setSearchActive(on);
            }
            // The font is TAKEN either way — a symbol it cannot draw is the
            // map's problem to look at, not a reason to refuse the choice — so
            // the complaint rides along beside the true rather than replacing
            // it. A script has nowhere else to hear it: the symbols are drawn
            // by the renderer, which answers no one.
            if (key === 'mapSymbolFont') {
                const undrawable = this.symbolsThisFontCannotDraw(String(v));
                if (undrawable) {
                    return `the font "${v}" has no glyph for ${undrawable}, which the map uses —`
                        + ' those rooms will show the replacement character';
                }
            }
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
        // Mudlet Web ships in its catalogue: Mudlet reads the description straight
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
    /** Write the profile out as a Mudlet-format XML save. The XML half of
     *  `saveProfile([location [, saveName]])` — see ScriptingEngine. */
    saveProfileXml(location?: string, saveName?: string) {
        return this.host.saveProfileXml(location, saveName);
    }
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
    setLoggingToggler(fn: ((enabled: boolean, format: LogFormat) => boolean) | null): void {
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
        // `logInHTML` decides which of the two documents a start writes, and
        // the header needs the console font and background it is told to name —
        // neither of which the logger can see for itself.
        const [fr, fg, fb] = this.defaultColorRgb('foreground');
        const [br, bgG, bb] = this.defaultColorRgb('background');
        this.loggingToggler?.(enabled, {
            html: this.getConfig('logInHTML') === true,
            font: this.getFont() ?? undefined,
            // Host::mFgColor / mBgColor: the body's colours, and what a log
            // line names for text that has none of its own.
            foreground: { r: fr, g: fg, b: fb },
            background: { r: br, g: bgG, b: bb },
        });
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

    /** Mudlet `closeMudlet()`. Mudlet Web maps it to closing the active profile:
     *  raise sysExitEvent, disconnect, then return to the connection screen.
     *  The event comes first because on desktop (TMainConsole::closeEvent) the
     *  exit handlers run while the profile is still connected, so a goodbye or
     *  save command they send reaches the game. The engine's teardown does not
     *  raise it a second time.
     *
     *  None of that happens inside the call. Desktop's closeMudlet only arms the
     *  close (mudlet::armForceClose, a zero-delay single shot), so it returns
     *  and the rest of the calling script runs — and its sends go out — before
     *  the exit handlers do. A plain timeout rather than the timer queue, so a
     *  script pumping events in waitForEvent does not close underneath itself,
     *  which desktop's armForceClose also waits out. Calls made while a close
     *  is already armed fold into it. */
    closeMudlet(): void {
        if (this.closeMudletArmed) return;
        this.closeMudletArmed = true;
        setTimeout(() => {
            this.closeMudletArmed = false;
            if (this.destroyed) return;
            this.host.raiseExitEvent();
            this.disconnect();
            this.closeProfileCallback?.();
        }, 0);
    }


    /** Mudlet `resetProfile()` — reload the entire profile as if just opened:
     *  clear every UI surface, recreate the Lua runtime, and re-run all scripts.
     *  The actual work is deferred by the engine (it closes the Lua VM that is
     *  currently executing this call), so this returns immediately — true once
     *  the reset is armed, false when it was refused (Host::resetProfile_phase1). */
    resetProfile(): boolean {
        return this.host.resetProfile();
    }


    /** Mudlet `exportAreaImage(areaID, filePath[, zLevel])` — render the area to a
     *  PNG file in the profile VFS. Returns `[true, absolutePath]` on success or
     *  `[false, errorMessage]` (e.g. the mapper isn't open, or the area is
     *  unknown). The 0-indexed array is unpacked into Mudlet's multi-return by
     *  Bridge.lua. */
    exportAreaImage(areaId: number, filePath: string, zLevel?: number | true): [boolean, string] {
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

    // A temp timer's name is the id tempTimer returned (Mudlet names it so), so
    // `disableTimer(id)` reaches it — whether the id arrives as a number or as
    // its string form. Every timer sharing the name is toggled, as in Mudlet.
    enableTimer(name: string): boolean {
        return this.toggleTimer(name, true);
    }

    disableTimer(name: string): boolean {
        return this.toggleTimer(name, false);
    }

    private toggleTimer(name: string, enabled: boolean): boolean {
        const perm = this.host.toggleTimerByName(name, enabled);
        const temp = /^\d+$/.test(name) && this.timers.setTempEnabled(Number(name), enabled);
        return perm || temp;
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
     *  patterns). See ScriptingEngine.getProfileStats for Mudlet Web's caveats. */
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

    /** Mudlet `tempComplexRegexTrigger(...)`. See
     *  ScriptingEngine.createTempComplexTrigger. */
    tempComplexTrigger(spec: TempComplexTriggerSpec): number {
        return this.host.createTempComplexTrigger(spec);
    }

    /** Remove a temporary trigger by the id its creator returned. */
    removeTemporaryTrigger(id: number): boolean {
        return this.host.removeTemporaryTriggerById(id);
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
     *  persistent repeating timer under the parent group (empty = root).
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

    /** Mudlet `tempButton(toolbarName, name, orientation)`. Appends a
     *  transient button, with no command or script, under an existing toolbar
     *  group; returns the new id, or -1 when the toolbar doesn't exist or
     *  the name is already taken (the Lua wrapper returns nothing then).
     *  `orientation` is Mudlet's int form (0=horizontal/1=vertical). */
    tempButton(toolbar: string, name: string, orientation: number): number {
        return this.host.createTempButton(toolbar, name, orientation);
    }

    /** Mudlet `tempButtonToolbar(name, location, orientation)` core. Creates
     *  a transient toolbar (ButtonNode group). `location` is TAction's stored
     *  int — 0=top, 1=bottom, 2=left, 3=right, 4=floating — which Bridge.lua
     *  derives from the Lua argument. Returns the new id or -1 on duplicate
     *  name (the Lua wrapper returns nothing then). */
    tempButtonToolbar(name: string, orientation: number, location: number): number {
        return this.host.createTempButtonToolbar(name, orientation, location);
    }

    /** Mudlet `setButtonState(name, state)`. Sets the pressed state of a
     *  two-state (push-down) button by name. Returns false when not found. */
    setButtonState(name: string | number, state: boolean): boolean {
        return this.host.setButtonStateByName(name, state);
    }

    /** Mudlet `getButtonState(name)`. Reads the pressed state of a two-state
     *  button. Returns nil when not found. */
    getButtonState(name: string | number): boolean | null {
        return this.host.getButtonStateByName(name);
    }

    /**
     * The console's own button state, which no-argument `getButtonState()`
     * reads: 2 when the last clicked button went down, 1 when it came up or
     * was a plain button. Mudlet's TToolBar/TEasyButtonBar write
     * `mpConsole->mButtonState` just before running the button, so it holds
     * the click being handled — ScriptingEngine.executeButton does the same.
     */
    clickedButtonState: 1 | 2 = 1;

    /** Which of Mudlet's button refusals applies to `name` — see
     *  ScriptingEngine.buttonKindByName. */
    buttonKind(name: string | number): 'missing' | 'plain' | 'pushdown' {
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
     *  on its toolbars being switched on, so flipping the group's `enabled` field is
     *  the show/hide hook. Returns null on success, or why nothing moved. */
    setToolBarVisibility(name: string, show: boolean): string | null {
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

    /** Why the body of the script with this numeric id failed when permScript
     *  or setScript just ran it, or null when it ran cleanly. */
    scriptLoadError(id: number): string | null {
        return this.host.scriptLoadErrorById(id);
    }

    /** Mudlet `getScript(name [, pos]) → code, id`. Returns the source of the
     *  pos-th (1-indexed) script named `name` together with that script's own
     *  numeric id. Null when no script sits at that position, which Bridge.lua
     *  surfaces as Mudlet's `(-1, "script ... at position ... not found")`. */
    getScript(name: string, pos: number): { code: string; id: number } | null {
        return this.host.getScriptByName(name, pos);
    }

    // ── Echo / output ─────────────────────────────────────────────────────────

    /** When the `!osc8-docs` banner last went out — see {@link injectOsc8Docs}. */
    private osc8DocsInjectedAt = 0;

    /**
     * Mudlet's `!osc8-docs` easter egg (`TBuffer::appendLine`): text printed
     * through the echo family that carries the phrase is swallowed whole — not
     * just the phrase, the whole call — and a banner of worked OSC 8 examples
     * goes into the MAIN console instead, whichever window the echo named.
     *
     * Returns true when the caller must print nothing. That happens even while
     * the once-a-second debounce is suppressing the banner itself: an echo and
     * the server response repeating it are two sightings of one phrase, and the
     * phrase never belongs on screen either way.
     */
    private injectOsc8Docs(text: string): boolean {
        if (!text.includes(OSC8_DOCS_PHRASE)) return false;
        const now = Date.now();
        if (now - this.osc8DocsInjectedAt > OSC8_DOCS_DEBOUNCE_MS) {
            this.osc8DocsInjectedAt = now;
            // Deliberately the main console's own format state, reset first: the
            // banner colours itself and must not inherit a pen left set by
            // whatever was echoing when the phrase turned up.
            this.mainConsole.resetFormat();
            this.mainConsole.echo(osc8DocumentationExamples());
            this.mainConsole.resetFormat();
            this.drainMain();
        }
        return true;
    }

    echo(text: string): void {
        // An echo from inside a trigger goes onto the matched line rather than
        // through the append path, so it prints the phrase as ordinary text —
        // Mudlet draws the same line, and UI_spec asserts it.
        if (!this.echoOnMatchedLine && this.injectOsc8Docs(text)) return;
        // TConsole::echo drops every \r before writing to the main console
        // (\r\n becomes \n, a lone \r vanishes). Only main: a miniconsole or
        // user window is printed through TConsole::print, which keeps it.
        if (text.includes('\r')) text = text.replace(/\r/g, '');
        this.echoMain(text);
        this.drainMain();
    }

    /**
     * Write `text` to the main console in the current pen, honouring the
     * matched line. During trigger processing Mudlet's echo/cecho appends to
     * the matched line at the output cursor (the line's end); only a `\n`
     * advances to a fresh line. Mudlet Web seeds the matched line into
     * mainConsole.history (beginLine) and defers script echoes, so without this
     * every trigger echo opened a new line — breaking Arkadia's grade/value
     * triggers, which `replace()`/`prefix()` then append text to the same line,
     * and the "add a clickable link after the line" pattern `echoLink` and
     * `echoPopup` are used for. The caller drains.
     */
    private echoMain(text: string, state?: FormatStateSnapshot): void {
        if (this.echoOnMatchedLine) {
            // The last line, not strictly the cursor's: TConsoleModel::echo
            // writes onto line size() - 1, which is the line above once a
            // trigger has deleted the one it matched.
            const matched = this.mainConsole.getBuffer();
            const buf = matched ?? this.mainConsole.lastLine();
            if (buf) {
                const nl = text.indexOf('\n');
                const head = nl < 0 ? text : text.slice(0, nl);
                if (head) {
                    buf.insert(buf.text.length, head, state ?? this.mainConsole.format.toSnapshot());
                    // The line above a gagged one has already been drawn, and
                    // nothing renders it again after this pass the way the
                    // matched line is — so the text was in the buffer but never
                    // on screen (mudlet-web#383). Redraw it now; a line not yet
                    // drawn makes this a no-op and renders with the text anyway.
                    if (!matched) buf.rerender();
                }
                if (nl < 0) return;          // stayed on the matched line
                this.echoOnMatchedLine = false;
                text = text.slice(nl);        // remainder leads with the advancing \n
            } else {
                this.echoOnMatchedLine = false;
            }
        }
        const before = this.mainConsole.getLineCount();
        this.mainConsole.echoText(text, state);
        if (this.triggerLineDepth > 0) this.triggerEchoLines += this.mainConsole.getLineCount() - before;
    }

    /** Echo into `con` — through {@link echoMain} when it is the main console,
     *  so a link or popup echoed from a trigger lands on the matched line.
     *  `state`, when given, is written instead of the console's pen. */
    private echoTo(con: Console, text: string, state?: FormatStateSnapshot): void {
        if (con === this.mainConsole) this.echoMain(text, state);
        else con.echoText(text, state);
    }

    /**
     * The format a link or popup gets when the caller did not ask for the
     * current one — Mudlet's `standardLinkFormat`: the link blue, the console's
     * own background and underline, and nothing else. It replaces the pen
     * outright rather than layering onto it, so bold, italics, a background,
     * strikeout or reverse set beforehand do not carry into the link (and a
     * `cechoLink` with `<b>` inside stays one plain link run, since xEcho
     * passes no format flag to the echoLink calls it makes).
     */
    private standardLinkState(win: string | undefined, hyperlink: FormatHyperlink): FormatStateSnapshot {
        return { foreground: this.linkColor(win), underline: true, hyperlink };
    }

    /**
     * `TConsole::printCommand` on a miniconsole or user window: what Enter on
     * its own command line (no action bound) prints into it after sending.
     * Gated as desktop's enterCommand/printCommand gate it — never under
     * `showSentText` "never", nor while the server echoes (password entry) —
     * and drawn in that console's command colours, which start as
     * TConsoleModel's (213,195,0) on black and setCommandForegroundColor /
     * setCommandBackgroundColor with its name change.
     */
    printCommandToWindow(win: string, text: string): void {
        if (!win || win === 'main' || !this.session.windows.has(win)) return;
        if (this.session.showSentText === 'never' || this.session.isRemoteEchoingActive()) return;
        const { fg, bg } = this.windowCommandColors.get(win) ?? {};
        const [fr, fg2, fb] = fg ?? [213, 195, 0];
        const [br, bg2, bb] = bg ?? [0, 0, 0];
        const con = this.outputConsole(win);
        // Console.echo starts parsing from the pen without changing it, so the
        // escapes colour this line alone, as TConsoleModel::print(msg, fg, bg).
        con.echo(`\x1b[38;2;${fr};${fg2};${fb}m\x1b[48;2;${br};${bg2};${bb}m${text}\x1b[0m\n`);
        this.drainWindowConsole(win, con);
    }

    /** Per-console command echo colours (TConsole::mCommandFgColor/BgColor),
     *  set by setCommandForegroundColor/BackgroundColor with a window name. */
    private readonly windowCommandColors = new Map<string, { fg?: [number, number, number]; bg?: [number, number, number] }>();

    echoToWindow(win: string, text: string): void {
        if (this.injectOsc8Docs(text)) return;
        const con = this.penConsole(win);
        if (!con) return;
        con.echoText(text);
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
     *    combined fg/bg, backgrounds, unknown color names, unmodeled tokens,
     *  - an ESC anywhere in the text (Mudlet stores it as text; the ANSI this
     *    builds would decode it).
     * The Lua wrapper also keeps a cecho off this path while any of its tags
     * names a `color_table` entry a script has changed (see LuaRuntime's
     * installFastColorEcho).
     */
    fastColorEcho(kind: string, win: string, str: string): boolean {
        if (win !== 'main' && this.labels.has(win)) return false;
        if (win === 'main' && this.echoOnMatchedLine) return false;
        // A window that does not exist takes nothing: xEcho's every call on it
        // — deselect, resetFormat, the pens, echo — misses in Mudlet, so the
        // whole colour echo is a no-op rather than the birth of a window.
        if (!this.consoleExists(win)) return true;
        // The string is turned into ANSI below, so an ESC already in it would be
        // decoded as a sequence of its own. Mudlet keeps it as text (xEcho's
        // echo() never decodes escapes), which the per-segment Lua path does too.
        if (str.includes('\x1b')) return false;
        // xEcho echoes each segment through echo("main", …), and TConsole::echo
        // drops every \r on the way into the main console.
        if (win === 'main' && str.includes('\r')) str = str.replace(/\r/g, '');

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
            luaCommands: [cmd],
        };
        const con = this.penConsole(win);
        if (!con) return;
        if (!useCurrentFormat) {
            this.echoTo(con, text, this.standardLinkState(win, hyperlink));
        } else {
            con.format.hyperlink = hyperlink;
            this.echoTo(con, text);
            con.format.hyperlink = undefined;
        }
        if (!win || win === 'main') {
            this.drainMain();
        } else {
            this.drainWindowConsole(win, con);
        }
    }

    /**
     * Build a {@link FormatHyperlink} for the popup family — shared by
     * `echoPopup`/`insertPopup`/`setPopup`, which differ only in whether the
     * styled span is appended, inserted at the cursor, or applied to the
     * current selection.
     *
     * Mudlet keeps links and popups in one link store and decides per click, so
     * a popup is a link that *also* carries a menu:
     *  - Left-click runs `cmds[0]`, whatever the entry count. `TTextEdit::
     *    mousePressEvent` has no popup branch at all — it executes the first
     *    command of whichever link was hit.
     *  - Right-click opens the menu only when there is more than one command,
     *    or the hints list is longer than the commands list (a leading tooltip
     *    hint marking the rest as menu items). A one-entry popup is therefore
     *    indistinguishable from `echoLink`, which is what scripts calling
     *    `cechoPopup(win, text, {code}, {label}, true)` rely on.
     *  - Right-clicking a link never falls through to the console's own copy
     *    menu (Mudlet sets `mIsCommandPopup` and returns), but that holds for
     *    every link, so the renderer swallows it — see FormatBuffer.toDom.
     */
    private buildPopupHyperlink(
        cmds: string[],
        hints: string[],
        customAction?: (cmd: string) => void,
    ): FormatHyperlink {
        const action = customAction ?? ((cmd: string) => { this.host.runLinkCode(cmd); });
        // More hints than commands means hints[0] is a tooltip and the menu
        // labels start one later; otherwise every hint labels its command and
        // the tooltip is all of them, one per line.
        const hintOffset = hints.length > cmds.length ? 1 : 0;
        const hasMenu = cmds.length > 1 || hintOffset === 1;

        const openMenu = (ev: MouseEvent) => {
            document.getElementById('mudlet-popup-menu')?.remove();

            const menu = document.createElement('div');
            menu.id = 'mudlet-popup-menu';
            menu.style.cssText = 'position:fixed;z-index:9999;background:#1e1e1e;border:1px solid #444;border-radius:4px;padding:2px 0;box-shadow:0 2px 10px rgba(0,0,0,0.7);min-width:120px;font-family:monospace;font-size:13px';
            menu.style.left = `${ev.clientX}px`;
            menu.style.top = `${ev.clientY}px`;

            cmds.forEach((cmd, i) => {
                const label = hints[i + hintOffset] ?? cmd;
                // Mudlet's rules for an entry that runs nothing: a bare command
                // with no label at all becomes a separator, one with a label
                // becomes a disabled item.
                if (!cmd && !label) {
                    const sep = document.createElement('div');
                    sep.style.cssText = 'height:1px;margin:3px 0;background:#444';
                    menu.appendChild(sep);
                    return;
                }
                const item = document.createElement('div');
                item.textContent = label;
                if (!cmd) {
                    item.style.cssText = 'padding:5px 14px;color:#777;white-space:nowrap';
                    menu.appendChild(item);
                    return;
                }
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

        const first = cmds[0];
        return {
            onClick: first ? () => { action(first); } : undefined,
            onContextMenu: hasMenu ? openMenu : undefined,
            title: hintOffset ? hints[0] : hints.join('\n'),
            luaCommands: customAction ? undefined : [...cmds],
        };
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
        kind: 'command' | 'url' | 'prompt',
        payload: string,
        hint?: string,
        promptCmds?: string[],
        promptHints?: string[],
        isLive: () => boolean = () => true,
    ): FormatHyperlink {
        // A link an <EXPIRE> has since retired keeps its look but runs
        // nothing, from a click or from its menu (TLinkStore::expireLinks
        // leaves the text and drops what it ran).
        if (kind === 'url') {
            // An <A> is only ever opened, as Mudlet's openUrl(…) action is,
            // never sent to the game, whatever its address. A browser can only
            // safely open a web address, though: a scheme-less one would load
            // a page of this app, and `javascript:` would run in it — those do
            // nothing, as an address the desktop cannot open does nothing.
            return {
                onClick: () => { if (isLive() && MXP_OPENABLE_URL.test(payload)) this.openUrl(payload); },
                title: hint || undefined,
                autoUnderline: true,
            };
        }
        // A SEND carrying PROMPT is asking for the command to be put in front
        // of the player rather than run — the game means it to be edited (the
        // canonical example is `<SEND "tell Zugg " PROMPT>`, which wants a
        // message typed after it). Same as the OSC 8 `prompt:` scheme.
        const sendCmd = kind === 'prompt'
            ? (cmd: string) => { if (isLive()) this.printCmdLine(cmd, true); }
            : (cmd: string) => { if (isLive()) this.send(cmd); };
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
        else if (action.kind === 'prompt') this.printCmdLine(action.command, true);
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
        else if (action.kind === 'prompt') this.printCmdLine(action.command, true);
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
            else if (action.kind === 'prompt') this.printCmdLine(action.command, true);
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
        const con = this.penConsole(win);
        if (!con) return;
        const hyperlink = this.buildPopupHyperlink(cmds, hints);
        if (!useCurrentFormat) {
            // Same default as echoLink: Mudlet's standard link format.
            this.echoTo(con, text, this.standardLinkState(win, hyperlink));
        } else {
            con.format.hyperlink = hyperlink;
            this.echoTo(con, text);
            con.format.hyperlink = undefined;
        }
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
            const hyperlink = this.buildPopupHyperlink(cmds, hints);
            // Same default as insertLink: Mudlet's standard link format.
            const state: FormatStateSnapshot = useCurrentFormat
                ? { ...con.format.toSnapshot(), hyperlink }
                : this.standardLinkState(win, hyperlink);
            this.insertLinkSpan(con, buf, text, state, win,
                () => this.echoPopup(text, cmds, hints, win, useCurrentFormat));
            return;
        }
        this.echoPopup(text, cmds, hints, win, useCurrentFormat);
    }

    /**
     * The shared tail of insertLink/insertPopup — Mudlet routes both through
     * TConsoleModel::insertLink. When the cursor sits on TBuffer::getEndPos()
     * (the last character of the last line, or column 0 of an empty one) the
     * span is appended there instead, which is `appendAtEnd`, and the cursor
     * stays put. Otherwise it goes in at the cursor — padded out to it when the
     * cursor is past the end of the line — and, outside the trigger engine,
     * the cursor moves past it so a following insert lands after the link
     * rather than in front of it.
     */
    private insertLinkSpan(
        con: Console, buf: AnsiAwareBuffer, text: string, state: FormatStateSnapshot,
        windowName: string | undefined, appendAtEnd: () => void,
    ): void {
        const onTriggerLine = this.inTriggerProcessing && con === this.mainConsole;
        const col = con.getCursorColumn();
        if (!onTriggerLine
            && con.getLineNumber() === this.getLastLineNumber(windowName)
            && col === Math.max(0, con.currentPartial.length - 1)) {
            appendAtEnd();
            return;
        }
        const at = Math.min(col, buf.text.length);
        // The padding is not part of the link: applyLink covers the inserted
        // text only, and the gap takes the console's current format, as
        // TBuffer::expandLine fills it — not the link's, nor its neighbour's.
        const padding = ' '.repeat(col - at);
        if (padding) buf.insert(at, padding, con.format.toSnapshot());
        buf.insert(col, text, state);
        if (onTriggerLine) {
            // As for insertText: TConsole::insertLink moves the capture
            // positions past the link, and the colours go with the text.
            this.captureShiftHook?.(at, padding.length + text.length);
            this.spliceLineColorSnapshot(at, 0, { ...this.stateColorKeys(state), text: padding + text });
        } else {
            con.setCursorColumn(col + text.length);
        }
        if (!this.inTriggerProcessing) buf.rerender();
    }

    /**
     * Mudlet `setPopup([window,] {commands}, {hints})`. Attaches a right-click
     * popup menu to the current selection — preserves the selection's existing
     * colors/attributes (like `setLink` and the colour setters).
     * `commands` are Lua code strings run when the matching menu entry is
     * chosen. Returns false when there is no selection (or it belongs to a
     * different window).
     */
    setPopup(cmds: string[], hints: string[], win?: string): boolean {
        const sel = this.selectionOf(win);
        if (!sel) return false;
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return false;
        const span = this.selectionSpan(sel, buf);
        if (span) buf.setHyperlink(span, this.buildPopupHyperlink(cmds, hints));
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
        this.applyStateToSelection({ foreground: { space: 'rgb', r, g, b } }, win);
        this.penConsole(win)?.setFgColor(r, g, b);
    }

    setBgColor(r: number, g: number, b: number, a?: number, win?: string): void {
        const color: RgbColor = a !== undefined && a < 255
            ? { space: 'rgb', r, g, b, a }
            : { space: 'rgb', r, g, b };
        this.applyStateToSelection({ background: color }, win);
        this.penConsole(win)?.setBgColor(r, g, b, a);
    }

    setBold(v: boolean, win?: string): void {
        this.applyStateToSelection({ bold: v }, win);
        this.penConsole(win)?.setBold(v);
    }
    setItalic(v: boolean, win?: string): void {
        this.applyStateToSelection({ italic: v }, win);
        this.penConsole(win)?.setItalic(v);
    }
    setUnderline(v: boolean, win?: string): void {
        this.applyStateToSelection({ underline: v }, win);
        this.penConsole(win)?.setUnderline(v);
    }
    setStrikethrough(v: boolean, win?: string): void {
        this.applyStateToSelection({ strikethrough: v }, win);
        this.penConsole(win)?.setStrikethrough(v);
    }
    /** Mudlet `setOverline([window,] bool)`. Renders a line above the text
     *  (CSS `text-decoration: overline`, ANSI SGR 53). Mirrors the other style
     *  setters: applies to the active selection when one matches, and updates
     *  the resolved console's pen for subsequent echo. */
    setOverline(v: boolean, win?: string): void {
        this.applyStateToSelection({ overline: v }, win);
        this.penConsole(win)?.setOverline(v);
    }
    /**
     * Mudlet `setReverse([window,] bool)`. Toggles reverse-video — the renderer
     * swaps the fg/bg pair when `inverse` is set (see Console rendering). Mirrors
     * the other style setters: applies to the active selection when one matches,
     * and updates the resolved console's pen for subsequent echo.
     */
    setReverse(v: boolean, win?: string): void {
        this.applyStateToSelection({ inverse: v }, win);
        this.penConsole(win)?.setReverse(v);
    }

    /**
     * Mudlet `setTextFormat(windowName, r1, g1, b1, r2, g2, b2, bold, underline,
     * italics, [strikeout], [overline], [reverse], [blinkMode]) → bool`. Sets
     * the full pen state in one call. r1/g1/b1 is BACKGROUND, r2/g2/b2 is
     * FOREGROUND (a Mudlet quirk — preserved here for parity). `blinkMode` is
     * "none" / "slow" / "fast". Returns false when the named window doesn't
     * resolve. Unlike setFgColor & friends it touches the pen only — a
     * selection active on the console keeps its formatting, as in Mudlet.
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

        // Only the pen: TConsole::setTextFormat sets the format later writes
        // use and leaves the selection alone, unlike setFgColor & friends.
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
        this.clearSelection(windowName);
        this.penConsole(windowName)?.resetFormat();
        return true;
    }

    // ── Selection ─────────────────────────────────────────────────────────────

    selectString(str: string, occurrence: number, windowName?: string): number {
        // Mudlet searches the cursor's current line. With Console as the
        // canonical buffer that is just `Console.getLine()` — including the
        // matching line during trigger processing (just appended) and any
        // history line the cursor was moved to.
        const line = this.getConsole(windowName)?.getLine() ?? '';

        // TConsoleModel::selectString resumes each search at `begin + 1`, not
        // after the whole match, so overlapping occurrences count separately:
        // "aa" in "aaaa" is found at 0, 1 and 2. An empty line never matches,
        // and QString::indexOf from past the end is -1 (JS clamps it instead).
        if (line.length > 0 && occurrence >= 1) {
            let begin = -1;
            for (let i = 0; i < occurrence; i++) {
                const from = begin + 1;
                begin = from > line.length ? -1 : line.indexOf(str, from);
                if (begin === -1) break;
            }
            if (begin >= 0) {
                this.setSelection(windowName, begin, str.length);
                return begin;
            }
        }
        // A failed search CLEARS the selection (TConsole::select deselects on
        // every one of its -1 paths). Leaving the old one standing meant the -1
        // was followed by a getSelection reporting a start on a line the cursor
        // had since left — a stale answer that reads exactly like a live one.
        this.deselect(windowName);
        return -1;
    }

    /**
     * Mudlet `selectSection([window,] from, length) → bool`. `from` is 0-indexed.
     *
     * A selection that does not fit the line is REFUSED, not trimmed to fit:
     * TConsole::selectSection rejects a negative start, a start past the end of
     * the line, and a length that runs off it, and leaves the previous selection
     * standing in each case. Clamping instead — which Mudlet Web did — turned
     * "selectSection(5, 1)" on a four-character line into a silent selection of
     * its last character, so a script checking the return value was told its
     * out-of-range request had succeeded and then styled the wrong text.
     *
     * `from == line length` is allowed: that is an empty selection at the end of
     * the line, not a start past it.
     */
    selectSection(from: number, length: number, windowName?: string): boolean {
        if (!Number.isFinite(from) || from < 0) return false;
        if (!Number.isFinite(length) || length < 0) return false;
        const buf = this.resolveBuffer(windowName);
        if (!buf) return false;
        const lineLength = buf.length;
        if (from > lineLength || from + length > lineLength) return false;
        this.setSelection(windowName, from, length);
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
        this.setSelection(windowName, 0, line.length);
        return true;
    }

    /**
     * Mudlet `deselect([windowName])`. Clears the named console's selection
     * (main when omitted); selections in other consoles remain intact.
     */
    deselect(windowName?: string): void {
        this.clearSelection(windowName);
    }

    /**
     * Mudlet `getSelection([windowName])`. Returns the currently selected text
     * along with its 0-based start column and length on the active line. Returns
     * null when no selection is set, or when `windowName` is given and doesn't
     * match the selection's window — the Lua wrapper translates null into
     * Mudlet's `false, "no selection"` 2-tuple.
     */
    getSelection(windowName?: string): { text: string; start: number; length: number } | string | null {
        // A name that is no console refuses, rather than reading as "nothing
        // selected": GUIUtils' replace() goes on to the C replace() after any
        // answer but the empty one, which answers nothing for such a window.
        if (!this.consoleExists(windowName)) return `window "${windowName}" not found`;
        const sel = this.selectionOf(windowName);
        if (!sel) return null;
        // A console whose cursor is on no stored line — just cleared down to
        // its one empty line — still has a line for the selection to be read
        // from: an empty one.
        const text = this.resolveBuffer(sel.windowName)?.text ?? '';
        const { start, length } = sel;
        // The selection is columns on whatever line the cursor is on NOW, not on
        // the line it was made on — so moving the cursor to a shorter line (or
        // clearing the window) can strand it past the end. Mudlet reports that
        // as a refusal rather than silently answering with the empty string the
        // slice would give, which a script cannot tell from a line that really
        // is blank there. A selection that starts AT the end is still valid,
        // and reads as "".
        if (text.length < start) return 'the selection is no longer valid';
        return { text: text.slice(start, start + length), start, length };
    }

    /**
     * Mudlet `getFgColor([window])` / `getBgColor([window])`. Reads the fg/bg
     * color at the current selection's start position (Mudlet's P_begin). Each
     * console tracks its own selection in Mudlet; Mudlet Web has a single global
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
     * xterm-256 palette). Mudlet Web stores rendered RGB rather than the original
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

    /**
     * Whether the main console's selection (or, with none, the cursor line's
     * first column) is on a character — what isAnsiFgColor/isAnsiBgColor read.
     * Desktop answers "current selection invalid in window 'main'" when it is
     * not, ahead of checking the colour number.
     */
    hasReadableSelection(): boolean {
        return this.readSelectionColor('foreground', undefined) !== null;
    }

    private matchesAnsiColor(channel: 'foreground' | 'background', ansiColor: number): boolean {
        const rgb = this.readSelectionColor(channel, undefined);
        if (!rgb) return false;
        const target = this.ansiColorCodeToRgb(channel, ansiColor);
        if (!target) return false;
        return rgb[0] === target[0] && rgb[1] === target[1] && rgb[2] === target[2];
    }

    /**
     * The colour one of `isAnsiFgColor`/`isAnsiBgColor`'s 0..16 codes names.
     *
     * This is Mudlet's own numbering (`TLuaInterpreterUI.cpp`), and it is not
     * the ANSI one: 0 is the profile's default, then the eight colours follow in
     * *light-first* pairs — 1 light black, 2 black, 3 light red, 4 red, and so
     * on to 15 light white, 16 white. Anything outside 0..16 names no colour;
     * the Bridge wrapper already refuses those with Mudlet's message, so this
     * only has to decline to answer.
     */
    private ansiColorCodeToRgb(
        channel: 'foreground' | 'background', code: number,
    ): [number, number, number] | null {
        const n = Math.floor(Number(code));
        if (!Number.isFinite(n) || n < 0 || n > 16) return null;
        if (n === 0) return this.defaultColorRgb(channel);
        // 1,3,5… are the light half and 2,4,6… the dark one, both walking the
        // palette in ANSI order.
        const palette = n % 2 === 1 ? colorCodes.ansi.bright : colorCodes.ansi.dark;
        return parseHexToRgb(palette[Math.floor((n - 1) / 2)]);
    }

    /**
     * The colour Mudlet's getFgColor/getBgColor read: the one at P_begin, the
     * start of the selection.
     *
     * Mudlet has no "no selection" state — deselect() collapses P_begin and
     * P_end to (0, 0) rather than unsetting them, so the getters go on reading
     * the first column of the cursor's line. Mudlet Web models the selection as
     * absent instead, so that case is spelled out here: with nothing selected
     * the column is zero, and the answer is "nothing at all" only when there is
     * no character there to read — an empty console, or a line the selection
     * outlived.
     */
    private readSelectionColor(
        channel: 'foreground' | 'background',
        windowName: string | undefined,
    ): [number, number, number] | null {
        const selected = this.selectionOf(windowName);
        const buf = this.resolveBuffer(windowName);
        if (!buf) return null;
        const start = selected ? selected.start : 0;
        if (start < 0 || start >= buf.length) return null;
        return this.readColorAt(buf, start, channel);
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
        return formatColorToRgb(color) ?? this.defaultColorRgb(channel);
    }

    /** The blue a link gets in `windowName` when the caller did not pass a
     *  format of its own — whichever of Mudlet's two link blues reads better
     *  against that console's background. */
    private linkColor(windowName?: string): RgbColor {
        // A window that has been given a background of its own is judged
        // against that; everything else against the profile's.
        const own = windowName !== undefined && windowName !== 'main'
            ? this.getBackgroundColor(windowName)
            : null;
        return readableLinkColor(own
            ? [own.r, own.g, own.b]
            : this.defaultColorRgb('background'));
    }

    /** The profile's own foreground/background — what a cell carrying no colour
     *  of its own is drawn in, and what `isAnsi*Color(0)` asks about. */
    private defaultColorRgb(channel: 'foreground' | 'background'): [number, number, number] {
        const state = useAppStore.getState();
        if (channel === 'background') {
            const override = selectProfileField(state, this.connectionId, 'outputBackgroundColor');
            if (override) return [override.r, override.g, override.b];
            return parseHexToRgb(selectProfileField(state, this.connectionId, 'outputBackground')) ?? DEFAULT_BG_RGB;
        }
        return parseHexToRgb(selectProfileField(state, this.connectionId, 'outputForeground')) ?? DEFAULT_FG_RGB;
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
     * `alternateFont` is recorded but never rendered — Mudlet Web has no alternate
     * font to switch to — so a script reads back the number the game asked for
     * and sees no difference on screen.
     */
    getTextFormat(windowName?: string): {
        bold: boolean;
        italic: boolean;
        underline: boolean;
        underlineStyle: UnderlineStyle | 'none';
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
        const sel = this.selectionOf(windowName);
        if (sel) {
            buf = this.resolveBuffer(sel.windowName);
            pos = sel.start;
        } else {
            const con = this.getConsole(windowName);
            buf = con?.getBuffer() ?? null;
            pos = con?.getCursorColumn() ?? 0;
        }
        // Past the end of the line is "no character there", not the last one:
        // Mudlet's getTextAttributes reports `x >= lineSize` as an invalid
        // selection, and a spec reads exactly that back to check the styling
        // container is no longer than the text it styles. Clamping made a column
        // one past the end answer for the one before it, which looks the same as
        // a container running one entry long.
        if (!buf || buf.length === 0 || pos < 0 || pos >= buf.length) return null;
        const foreground = this.readColorAt(buf, pos, 'foreground');
        const background = this.readColorAt(buf, pos, 'background');
        const state = buf.getStateAt(pos);
        // A link's own styling adds an underline to the cell without clearing
        // the one SGR put there, so the cell can carry two at once and only what
        // the painter draws is the honest answer. Mudlet resolves it in
        // drawCustomDecorations' order — wavy, then dotted, then dashed, with
        // the plain underline drawn when none of the three is set.
        const linkStyle = state?.hyperlink?.config?.style;
        const underline = !!state?.underline || !!linkStyle?.underline;
        const styles = [state?.underlineStyle, linkStyle?.underlineStyle];
        const underlineStyle = !underline ? 'none'
            : styles.includes('wavy') ? 'wavy'
            : styles.includes('dotted') ? 'dotted'
            : styles.includes('dashed') ? 'dashed'
            : 'solid';
        return {
            bold: !!state?.bold,
            italic: !!state?.italic,
            underline,
            underlineStyle,
            strikeout: !!state?.strikethrough,
            reverse: !!state?.inverse,
            overline: !!state?.overline,
            concealed: !!state?.concealed,
            alternateFont: state?.alternateFont ?? 0,
            blinking: state?.rapidBlink ? 'fast' : state?.slowBlink ? 'slow' : 'none',
            foreground,
            background,
        };
    }

    applyFormatToSelection(state: FormatStateSnapshot): void {
        this.applyStateToSelection(state, 'main');
    }

    /**
     * Mudlet `setLink([windowName], command, hint)`. Applies a clickable
     * hyperlink to the current selection — preserves existing colors/attributes
     * on each segment (as setFgColor & friends do). `command`
     * is the Lua code run on click; the Bridge.lua wrapper converts function
     * arguments into a `__mudlet_call_link(id)` string before reaching here.
     * Returns false if there is no selection (or it doesn't belong to `win`).
     */
    setLink(cmd: string, tooltip: string, win?: string): boolean {
        const sel = this.selectionOf(win);
        if (!sel) return false;
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return false;
        const hyperlink: FormatHyperlink = {
            onClick: () => { this.host.runLinkCode(cmd); },
            title: tooltip || undefined,
            luaCommands: [cmd],
        };
        const span = this.selectionSpan(sel, buf);
        if (span) buf.setHyperlink(span, hyperlink);
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
        // An echo without a newline from outside the trigger engine — an event
        // handler, a timer — is still the open line when the next server line
        // arrives. Desktop ends that line before the server's is added, so the
        // echo comes first in the buffer and on screen. Left open here, the
        // server line went into history above it, and flushDeferredEcho then
        // emitted it after the line as a second copy of what the screen was
        // already showing (mudlet-web#384). Emitted as 'script' so the renderer
        // finalizes the element it is drawn in rather than adding one.
        if (this.triggerLineDepth === 0 && !this.isDeferringEcho) {
            const open = this.mainConsole.completePartialLine();
            if (open) this.session.events.emit('message', open, 'script');
        }
        // Snapshot the colours the SERVER sent, before any trigger runs. Mudlet
        // matches colour triggers against the line as it arrived, so a trigger
        // that recolours the line cannot change what a later (or nested) colour
        // trigger sees — while the display still shows the recoloured version.
        // Pushed, not assigned: a trigger may call feedTriggers itself, and the
        // outer line's snapshot has to survive the nested pass.
        this.triggerLinePrompts.push(isPrompt);
        this.lineColorSnapshots.push(this.colorKeySegments(buffer, 0));
        this.lineColorLive.push(buffer);
        // Which line the cursor was on before this one was appended, so a line
        // fed from inside a trigger can hand the outer pass its own line back.
        this.outerTriggerLines.push(this.triggerLineDepth > 0 ? this.mainConsole.getLineNumber() : -1);
        this.mainConsole.appendLine(buffer);
        this.mainConsole.suspendOpenLine(true);
        this.inTriggerProcessing = true;
        if (this.triggerLineDepth === 0) this.triggerEchoLines = 0;
        this.triggerLineDepth++;
        this.clearSelection('main');
        this.setDeferringEcho(true);
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
        this.lineColorLive.pop();
        this.triggerLinePrompts.pop();
        // A trigger can call feedTriggers, which processes a line of its own
        // inside this one. Only the OUTERMOST line leaves trigger context —
        // clearing the flag when a nested line finishes left the rest of the
        // outer pass running as if no trigger were firing, so every capture
        // position it went on to select was left unshifted by the text the
        // nested pass had inserted.
        this.triggerLineDepth = Math.max(0, this.triggerLineDepth - 1);
        if (this.triggerLineDepth <= 1) this.runawayFeedStopped = false;
        const outerLine = this.outerTriggerLines.pop() ?? -1;
        if (this.triggerLineDepth > 0) {
            // Back to the line the outer pass is still working on. Without this
            // the cursor is left on the line the nested feed appended, and
            // everything the outer pass does afterwards — selectString, the
            // colour calls that follow it — lands on that line instead.
            if (outerLine >= 0) this.mainConsole.moveTo(outerLine);
            // But echoes no longer land on it: TConsole::echo writes onto the
            // buffer's last line, which is now the open one after the fed
            // lines, so what the outer trigger echoes next follows them.
            this.echoOnMatchedLine = false;
            return;
        }
        this.inTriggerProcessing = false;
        this.mainConsole.suspendOpenLine(false);
        this.echoOnMatchedLine = false;
        this.triggerEchoLines = 0;
        // NB: the trigger selection is intentionally NOT cleared here. Mudlet
        // leaves a selection made inside a trigger in place, so a script can read
        // it back via getSelection() after the line is processed (e.g. UI_spec's
        // nested-trigger test inspects the selection after feedTriggers). beginLine
        // resets it at the start of the next line, so it never leaks across lines.
        // Clear the leading-newline latch so it can't leak onto a later echo
        // (timer/alias output) if this line's triggers never echoed.
        this.mainConsole.markCursorAtEnd(false);
    }

    /** The lines a network line is stored as once its triggers are done — see
     *  Console.wrapAppendedLine. */
    wrapNetworkLine(buffer: AnsiAwareBuffer): AnsiAwareBuffer[] {
        return this.mainConsole.wrapAppendedLine(buffer, true);
    }

    /**
     * Mudlet `tempColorTrigger(fg, bg)` colour-scan helper. Walks the
     * just-appended line buffer (the one beginLine() seeded mainConsole with)
     * and returns true if any segment carries the requested ANSI colours.
     * `wantFg`/`wantBg` accept -1 as "any colour" and -2 as the console's
     * default; anything else is compared by the RGB it names, as desktop does.
     */
    currentLineMatchesColor(
        wantFg: number, wantBg: number, window: { start: number; length: number } | null = null,
    ): boolean {
        return this.currentLineColorMatch(wantFg, wantBg, window) !== null;
    }

    /**
     * The text of the first run on the current line carrying the wanted ANSI
     * colours, or null when none does. A colour trigger reports that run as
     * `matches[1]` — Mudlet matches a contiguous same-coloured run, not the
     * whole line — so adjacent segments sharing the colours are joined.
     */
    currentLineColorMatch(
        wantFg: number, wantBg: number, window: { start: number; length: number } | null = null,
    ): string | null {
        return this.currentLineColorRuns(wantFg, wantBg, window, 1)[0]?.text ?? null;
    }

    /**
     * Every run on the current line carrying the wanted ANSI colours, in order,
     * with its offset in the line — at most `limit` of them. A filter parent
     * matching a colour hands each run to its children separately, as
     * TTrigger::match_color_pattern collects them all.
     *
     * Reads the snapshot beginLine took, not the live buffer: an earlier trigger
     * may already have recoloured the line, and Mudlet still matches against the
     * colours the server sent.
     */
    currentLineColorRuns(
        wantFg: number, wantBg: number, window: { start: number; length: number } | null = null,
        limit = Infinity,
    ): { text: string; start: number }[] {
        const runs: { text: string; start: number }[] = [];
        const retained = this.lineColorSnapshots[this.lineColorSnapshots.length - 1];
        if (!retained) return runs;
        // Past the end of the snapshot the colours are the line's own: text a
        // trigger appended there (appendBuffer pastes onto the end of the line
        // without refreshing the snapshot, unlike echo()) came from nowhere
        // the server coloured, and is matched as it now stands.
        const live = this.lineColorLive[this.lineColorLive.length - 1];
        const retainedLength = retained.reduce((n, seg) => n + seg.text.length, 0);
        const snapshot = live && live.length > retainedLength
            ? [...retained, ...this.colorKeySegments(live, retainedLength)]
            : retained;
        // `window` narrows the scan to one stretch of the line — a colour
        // trigger inside a filter chain is only shown what its parent captured,
        // so a colour elsewhere on the line is not a match for it.
        const from = window ? window.start : 0;
        const to = window ? window.start + window.length : Infinity;
        // Compared by RGB, as TTrigger::match_color_pattern does: the codes
        // resolve to the colour they paint, and the default (-2) to the
        // console's own — which is also why plain text answers a trigger for 7.
        const defaults = this.triggerDefaultColorKeys();
        const fgKey = wantFg === COLOR_DEFAULT ? defaults.fg : ansiCodeKey(wantFg);
        const bgKey = wantBg === COLOR_DEFAULT ? defaults.bg : ansiCodeKey(wantBg);
        let run: { text: string; start: number } | null = null;
        const close = (): boolean => {
            if (run !== null) runs.push(run);
            run = null;
            return runs.length >= limit;
        };
        let at = 0;
        for (const seg of snapshot) {
            const text = seg.text ?? '';
            const start = Math.max(at, from);
            const end = Math.min(at + text.length, to);
            at += text.length;
            if (end <= start) {
                // Wholly outside the window: it can neither match nor continue a
                // run, so a run in progress ends here.
                if (close()) return runs;
                continue;
            }
            const visible = text.slice(start - (at - text.length), end - (at - text.length));
            const hit = (wantFg === COLOR_IGNORED || seg.fg === fgKey)
                && (wantBg === COLOR_IGNORED || seg.bg === bgKey);
            if (hit && visible) {
                if (run === null) run = { text: visible, start };
                else run.text += visible;
            } else if (close()) {
                return runs;
            }
        }
        close();
        return runs;
    }

    /** Per-segment colours (as {@link RgbKey}s) and text of each line currently
     *  being processed, as it arrived — see {@link beginLine}. A segment left
     *  on the console's default colour holds the default's RGB, as a desktop
     *  TChar does. A stack, because a trigger can feedTriggers another line. */
    private lineColorSnapshots: { fg: RgbKey; bg: RgbKey; text: string }[][] = [];
    /** The live buffer of each line in {@link lineColorSnapshots}, read for
     *  whatever has been written past the snapshot's end. */
    private lineColorLive: AnsiAwareBuffer[] = [];

    /** `buffer`'s segments from character `from` on, as colour keys. */
    private colorKeySegments(buffer: AnsiAwareBuffer, from: number): { fg: RgbKey; bg: RgbKey; text: string }[] {
        const defaults = this.triggerDefaultColorKeys();
        const out: { fg: RgbKey; bg: RgbKey; text: string }[] = [];
        let at = 0;
        for (const seg of buffer.getSegments()) {
            const text = seg.text ?? '';
            const segStart = at;
            at += text.length;
            if (at <= from) continue;
            out.push({
                fg: segmentColorKey(seg.state?.foreground) ?? defaults.fg,
                bg: segmentColorKey(seg.state?.background) ?? defaults.bg,
                text: text.slice(Math.max(0, from - segStart)),
            });
        }
        return out;
    }

    /** The console's default foreground/background as {@link RgbKey}s — what
     *  uncoloured text is drawn in, and what a `-2` pattern asks for. */
    private triggerDefaultColorKeys(): { fg: RgbKey; bg: RgbKey } {
        const [fr, fg, fb] = this.defaultColorRgb('foreground');
        const [br, bg, bb] = this.defaultColorRgb('background');
        return { fg: packRgb(fr, fg, fb), bg: packRgb(br, bg, bb) };
    }

    /**
     * Keep the colour snapshot aligned with a line a trigger has just edited.
     *
     * The snapshot is of the colours the SERVER sent, and a trigger that
     * merely RECOLOURS the line must not disturb it — that is the whole point
     * of taking one. But inserting or deleting characters moves the runs: the
     * text after an insert is at a different offset than it was, and a colour
     * trigger reading stale offsets matches across the seam. In the spec's
     * words, red "CCCC" with its first two characters deleted has to match as
     * "CC" and not as "CCDD", which is what taking four red characters from the
     * shifted line gives.
     *
     * Done per character and re-joined rather than by walking segment
     * boundaries, because an edit lands wherever it lands — mid-run as often as
     * not — and a line is short enough that the simple version is the one worth
     * having.
     */
    /** The snapshot's colours at a character offset — what a `keepColor`
     *  replacement inherits. Defaults to the reset pair when the line is
     *  shorter than the offset. */
    private snapshotColorAt(at: number): { fg: RgbKey; bg: RgbKey } {
        const snapshot = this.lineColorSnapshots[this.lineColorSnapshots.length - 1] ?? [];
        let seen = 0;
        for (const seg of snapshot) {
            seen += seg.text.length;
            if (at < seen) return { fg: seg.fg, bg: seg.bg };
        }
        return this.triggerDefaultColorKeys();
    }

    /** A pen state's colours as {@link RgbKey}s, unset channels resolved to
     *  the console's defaults. */
    private stateColorKeys(state: { foreground?: FormatColor; background?: FormatColor }): { fg: RgbKey; bg: RgbKey } {
        const defaults = this.triggerDefaultColorKeys();
        return {
            fg: segmentColorKey(state.foreground) ?? defaults.fg,
            bg: segmentColorKey(state.background) ?? defaults.bg,
        };
    }

    private spliceLineColorSnapshot(
        at: number, removeCount: number, insert?: { fg: number; bg: number; text: string },
    ): void {
        const snapshot = this.lineColorSnapshots[this.lineColorSnapshots.length - 1];
        if (!snapshot) return;
        const chars: { fg: number; bg: number; ch: string }[] = [];
        for (const seg of snapshot) {
            for (const ch of seg.text) chars.push({ fg: seg.fg, bg: seg.bg, ch });
        }
        const added = insert
            ? [...insert.text].map(ch => ({ fg: insert.fg, bg: insert.bg, ch }))
            : [];
        chars.splice(Math.max(0, at), Math.max(0, removeCount), ...added);

        const joined: { fg: number; bg: number; text: string }[] = [];
        for (const c of chars) {
            const last = joined[joined.length - 1];
            if (last && last.fg === c.fg && last.bg === c.bg) last.text += c.ch;
            else joined.push({ fg: c.fg, bg: c.bg, text: c.ch });
        }
        this.lineColorSnapshots[this.lineColorSnapshots.length - 1] = joined;
    }
    /** Whether each line currently being processed arrived as a prompt — the
     *  fallback isPrompt() reads once a trigger has gagged the line itself. A
     *  stack for the same reason {@link lineColorSnapshots} is one. */
    private triggerLinePrompts: boolean[] = [];
    /** How many lines are being processed at once — more than one whenever a
     *  trigger calls feedTriggers. See beginLine/endLine. */
    private triggerLineDepth = 0;
    /** TriggerUnit::scmMaxProcessingDepth — see {@link feedTriggers}. */
    private static readonly MAX_TRIGGER_DEPTH = 50;
    /** Set when a feed chain hits {@link MAX_TRIGGER_DEPTH}, until it unwinds to the outermost pass. */
    private runawayFeedStopped = false;
    /** Main-console lines the trigger pass's own echoes have completed. Mudlet's
     *  TConsole::echo embeds a trigger echo's newlines in the line being
     *  processed rather than opening lines, so the line count leaves them out
     *  until the pass is over. See {@link getLineCount}. */
    private triggerEchoLines = 0;
    /** Per nested line, the line the outer pass was on. See beginLine. */
    private outerTriggerLines: number[] = [];

    /** Told when text is inserted into the line a trigger is matching, so the
     *  runtime can move the capture positions it recorded at match time —
     *  otherwise `selectCaptureGroup` after an `insertText` selects the text
     *  that has since slid to where the capture used to be. */
    private captureShiftHook: ((at: number, delta: number) => void) | null = null;

    setCaptureShiftHook(fn: ((at: number, delta: number) => void) | null): void {
        this.captureShiftHook = fn;
    }

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
        this.setDeferringEcho(false);
        for (const line of this.echoDeferred) {
            if (line instanceof AnsiAwareBuffer) {
                this.session.events.emit('message', line, 'trigger-echo');
            } else {
                // Still an 'echo' — the log and OSC 8 expiry treat it as the
                // command it is. It was stored on a line of its own (never
                // onto a prompt), and the renderer reads that off the prompt's
                // buffer, so it draws it on a row of its own too.
                this.session.events.emit('message', line.command, 'echo', Date.now());
            }
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
     *  newline, held until later data completes it — see feedTriggersText. */
    private heldFeedText = '';

    /** Hand over the held unterminated fed text, for the next batch to lead
     *  with. The server's next lines complete it as well as a later feed does:
     *  Mudlet runs both through the one TBuffer. */
    takeHeldFeedText(): string {
        const held = this.heldFeedText;
        this.heldFeedText = '';
        return held;
    }

    /**
     * Feed bytes through the trigger pipeline as if they arrived from the MUD.
     * Routes complete lines through ScriptingEngine.processFlushBatch (same
     * code path as network-driven flushLines) so trigger ordering, ANSI carry,
     * and deferred-echo placement match exactly.
     *
     * `data` is a byte-string (the Lua binding unarmors it — see byteArmor.ts).
     * `utf8Encoded` says how to read it, and it is the caller's promise rather
     * than a guess:
     *
     *  - true (the default) — the bytes are UTF-8. Mudlet transcodes them into
     *    the game's encoding before display, so text the encoding cannot carry
     *    is REFUSED rather than mangled: a script feeding an accented character
     *    to an ASCII game has made a mistake it needs to hear about, and the
     *    transcode is lossless otherwise, so refusing costs nothing real.
     *  - false — the older form, where the caller has already encoded the bytes
     *    themselves. They pass through untouched, decoded with the game's own
     *    encoding rather than read as UTF-8 and double-encoded.
     *
     * Returns null when the text was fed, or the refusal message; the binding
     * shapes that into Mudlet's `true` / `(nil, errMsg)`.
     */
    feedTriggers(data: string, utf8Encoded = true): string | null {
        // A self-feeding trigger nests one line pass per re-match, and the
        // wasm stack is what runs out. Mudlet stops at TriggerUnit's
        // scmMaxProcessingDepth with a raised error, then refuses every feed
        // still nested under that chain until it unwinds to the outermost
        // pass — a trigger feeding two matching lines would otherwise re-run a
        // whole chain from every level on the way back up (2^50 passes).
        if (this.runawayFeedStopped) {
            return 'feedTriggers: refused, an endless loop further along this chain of fed text was already stopped';
        }
        if (this.triggerLineDepth >= ScriptingAPI.MAX_TRIGGER_DEPTH) {
            this.runawayFeedStopped = true;
            return FEED_RUNAWAY_ERROR;
        }
        const encoding = this.session.getServerEncoding();
        let text: string;
        if (utf8Encoded && encoding === 'UTF-8') {
            // Mudlet's simple case: the bytes go to the buffer as they are and
            // its own UTF-8 decoder reads them, a carriage return included.
            text = decodeUtf8AsTBuffer(data);
        } else if (utf8Encoded) {
            text = fromByteString(data).text;
            // ASCII is the strictest case and the one Mudlet checks by hand:
            // it has no encoder to ask, so the test is simply that nothing has
            // its top bit set.
            const carried = /^(us-)?ascii$/i.test(encoding.trim())
                ? ![...text].some(c => (c.codePointAt(0) ?? 0) > 0x7f)
                : canEncodeForServer(text, encoding);
            if (!carried) {
                return `feedTriggers: cannot send '${text}' as it contains one or more characters`
                    + ` that cannot be conveyed in the current game server encoding of '${encoding}'`;
            }
        } else {
            text = decodeForServer(data, encoding);
        }
        this.feedTriggersText(text);
        return null;
    }

    /** The feed itself, once {@link feedTriggers} has settled what the bytes say. */
    private feedTriggersText(text: string): boolean {
        // Carriage returns never reach a line, as with text from the server
        // (MudClient drops every '\r' before parsing): a package fed
        // "line\r\n" must match `^line$` exactly as the game's own copy does.
        text = text.replace(/\r/g, '');
        // An EOT (0x04) ends a line as '\n' does, in fed text as in the game's:
        // TBuffer::translateToPlainText commits on it whatever the source.
        text = text.replace(/\x04/g, '\n');
        // Trigger reloads are coalesced onto a microtask, which cannot run while
        // the calling Lua chunk is still on the stack. Mudlet applies perm* and
        // enable/disableTrigger immediately, so a script that creates or toggles
        // a trigger and feeds a line in the same chunk must see the new state.
        this.host.flushPendingApplies();
        // A line the caller left unterminated is held, as RAW text, until the
        // next data completes it — Mudlet's TBuffer keeps it in mMudLine, which
        // every later feed and every server packet appends to, and draws it only
        // once a '\n' commits it. So it is not shown in the meantime (an echo
        // made before then lands above it), and its triggers see it whole, once.
        // Re-joining the raw bytes also keeps an escape sequence split across two
        // feedTriggers parsed as one — the rendered text would have lost it.
        const joined = this.takeHeldFeedText() + text;
        const cut = joined.lastIndexOf('\n');
        if (cut < 0) {
            this.heldFeedText = joined;
            return true;
        }
        const remainder = joined.slice(cut + 1);

        // Drop any stray partial left by direct echo() calls so trigger echo
        // accumulates fresh during batch processing — but keep history, so
        // successive feedTriggers calls accumulate lines the way Mudlet appends
        // fed text to the buffer (a full clear() would strand earlier lines).
        this.mainConsole.clearPartial();

        // With no engine bound yet (early init) the default host falls back to
        // emitting a raw flushLines event.
        // fromServer: false — an MXP `ESC[#z` in fed text is consumed but does
        // not switch the parser's mode, as in Mudlet.
        // The batch keeps its last '\n': processFlushBatch drops one empty piece
        // after a trailing terminator, so cutting it off here lost the last line
        // whenever it was empty — "F1\n\n" committed only F1, and "\n" nothing,
        // where Mudlet commits an empty line for each '\n' (mudlet-web#385).
        this.host.processFlushBatch([{ text: joined.slice(0, cut + 1), type: 'mud', fromServer: false }]);

        // Appended rather than assigned: a trigger in the batch may have fed an
        // unterminated line of its own, which this one's tail follows in mMudLine.
        this.heldFeedText += remainder;
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
        const con = this.getConsole(windowName);
        // A cursor left on no line — a trigger that deleted the line it matched
        // — reads as TBuffer::line() answers any index past the end.
        if (con && this.inTriggerPass(con) && !con.getBuffer()) return BAD_LINE_ERROR;
        return con?.getLine() ?? '';
    }

    // Mudlet line-index APIs are 0-indexed: getLineNumber() == cursor.y() and
    // getLastLineNumber() == size - 1, where `size` counts the always-open line
    // Mudlet's buffer keeps past the last complete one. getLineCount() is the
    // count of *complete* lines, so it comes out one lower — which is why the
    // two are equal rather than off by one, and why a buffer-scan loop
    // `for i = getLineCount() - 1, 0, -1` starts on the last complete line.
    //
    // Mudlet Web's history holds only complete lines, so Console.getLineCount()
    // (history.length - 1) is the last complete index and both Lua-facing
    // numbers add one to reach Mudlet's convention. Missing windows report -1
    // (Mudlet's "no such window" sentinel).
    //
    // The exception is the main window during a trigger pass: Mudlet runs
    // triggers before that line's terminator opens the next one, so the
    // matched line IS the last line and the count equals getLineNumber().
    // Adding one there made `getLines("main", getLineCount() - 1,
    // getLineCount())` miss the matched line. A trigger's echo does not change
    // that, newlines and all — TConsole::echo embeds them in the line being
    // processed — so the lines those echoes completed here are left out too.
    getLineNumber(windowName?: string): number {
        return this.getConsole(windowName)?.getLineNumber() ?? -1;
    }

    getLineCount(windowName?: string): number {
        const con = this.getConsole(windowName);
        if (!con) return -1;
        if (this.inTriggerPass(con)) return con.getLineCount() - this.triggerEchoLines;
        return con.lastLineNumber();
    }

    getLastLineNumber(windowName?: string): number {
        return this.getLineCount(windowName);
    }

    /** Whether `con` is the main console mid trigger pass — the one time it has
     *  no open line past the last complete one. */
    private inTriggerPass(con: Console): boolean {
        return this.triggerLineDepth > 0 && con === this.mainConsole;
    }

    // ── Scrolling / scrollbars ────────────────────────────────────────────────
    // Mudlet hides/shows the gutter for the named console (or "main") and
    // independently toggles whether the user can scroll back at all. The
    // [Horizontal]ScrollBar pair only affects the gutter; the Scrolling pair
    // also blocks wheel/key scrolling. Mudlet forbids disable/enableScrolling
    // on the main window — we keep that policy (the binding hands Lua `false`).

    disableScrollBar(windowName?: string): void {
        this.session.windows.setScrollBarVisible(windowName || 'main', false);
    }
    enableScrollBar(windowName?: string): void {
        this.session.windows.setScrollBarVisible(windowName || 'main', true);
    }
    disableHorizontalScrollBar(windowName?: string): void {
        this.session.windows.setHorizontalScrollBarVisible(windowName || 'main', false);
    }
    enableHorizontalScrollBar(windowName?: string): void {
        this.session.windows.setHorizontalScrollBarVisible(windowName || 'main', true);
    }
    // A buffer has no pane to scroll, so turning its scrolling off is accepted
    // and changes nothing: it always reports itself scrolling.
    disableScrolling(windowName?: string): boolean {
        if (windowName && this.buffers.has(windowName)) return true;
        return this.session.windows.setScrollingEnabled(windowName || 'main', false);
    }
    enableScrolling(windowName?: string): boolean {
        if (windowName && this.buffers.has(windowName)) return true;
        return this.session.windows.setScrollingEnabled(windowName || 'main', true);
    }

    /** Mudlet `timeStampsEnabled(window)` — whether the console shows its
     *  timestamp column. Null when no such window exists. */
    timeStampsEnabled(windowName: string): boolean | null {
        const buf = this.buffers.get(windowName);
        if (buf) return buf.timestamps;
        // The main console's column is the profile's own setting — the one the
        // output's context menu toggles.
        if (!windowName || windowName === 'main') {
            return selectProfileField(useAppStore.getState(), this.connectionId, 'showTimestamps') === true;
        }
        return this.session.windows.timeStampsEnabled(windowName);
    }

    /** Mudlet `enableTimeStamps(window)` / `disableTimeStamps(window)`. False
     *  when no such window exists. */
    setTimeStamps(windowName: string, visible: boolean): boolean {
        const buf = this.buffers.get(windowName);
        if (buf) {
            buf.timestamps = visible;
            return true;
        }
        if (!windowName || windowName === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { showTimestamps: visible });
            return true;
        }
        if (!this.session.windows.setTimeStamps(windowName, visible)) return false;
        // The column moves the text over, so the console reports its grid
        // (with the gutter) — and with it any size a font change left
        // unreported. A buffer is never shown, so it has none to report.
        this.session.windows.reportConsoleGrid(windowName, this.getColumnCount(windowName), this.getRowCount(windowName));
        return true;
    }

    /** Mudlet `scrollingActive([window])` — whether the user can scroll back in
     *  this console. True unless disableScrolling was called on it; the main
     *  window is always scrollable. */
    scrollingActive(windowName?: string): boolean {
        if (windowName && this.buffers.has(windowName)) return true;
        return this.session.windows.isScrollingEnabled(windowName || 'main');
    }

    /** Mudlet getScroll — the buffer line the console is scrolled to, which
     *  desktop counts as the first line below the scrolled view (its bottom row
     *  plus one), the same edge scrollTo(window, line) puts a line on.
     *  Desktop answers `max(min(mCursorY, getLastLineNumber()), 0)`
     *  (TMainConsole::getWindowScroll), so a console following its output
     *  reports exactly getLastLineNumber() — the comparison scripts use to ask
     *  "am I at the bottom?" — and never a line past it. */
    getScroll(windowName?: string): number {
        const name = windowName || 'main';
        const last = Math.max(0, this.getLastLineNumber(name));
        // getScrollLine measures the DOM, and a console whose panel hasn't been
        // laid out measures as 0 — which would claim a 30-line buffer is
        // scrolled to the very top. Nothing has scrolled it, so it is at the
        // tail: report the last line, the same answer tail mode gives.
        if (!this.session.windows.canMeasureScroll(name)) return last;
        const line = this.session.windows.getScrollLine(name);
        return line === null ? last : Math.max(0, Math.min(line, last));
    }

    /** Mudlet scrollTo. With no line (or a line at or past the last one),
     *  resume tail mode. Negative line counts back from the buffer end. False
     *  only where desktop does nothing (scrolling disabled); Bridge.lua drops
     *  the result either way, as desktop's scrollTo returns nothing. */
    scrollTo(windowName: string | undefined, lineNumber: number | undefined): boolean {
        return this.session.windows.scrollToLine(windowName || 'main', lineNumber);
    }

    /** Null when the window doesn't exist — the binding answers Mudlet's
     *  `(nil, errMsg)` then, not an empty table a `if not t` check can't see. */
    getLines(from: number, to: number, windowName?: string): string[] | null {
        return this.getConsole(windowName)?.getLines(from, to) ?? null;
    }

    /**
     * Mudlet `getTimestamp([window,] lineNumber)` — the wall-clock time the line
     * entered the buffer, formatted as Mudlet's "hh:mm:ss.zzz " (13 characters,
     * trailing space included), or "------------ " for a line wrapping continued. `lineNumber` counts
     * from 0 as getLineNumber() does, 0 itself refused (see
     * Console.getLineTimestamp); omit it for the current cursor line. Returns null when the window or line doesn't exist — the Lua
     * binding maps that to Mudlet's `(nil, errMsg)` shape.
     */
    getTimestamp(lineNumber?: number, windowName?: string): string | null {
        if (!this.consoleExists(windowName)) return null;
        const ms = this.getConsole(windowName)?.getLineTimestamp(lineNumber) ?? null;
        return ms == null || typeof ms === 'string' ? ms : formatLineTimestamp(ms);
    }

    /**
     * Mudlet `wrapLine([window,] lineNumber)`. Re-wraps the buffer from the line
     * at `lineNumber` (0-indexed, like getLineNumber/getLineCount) to its end,
     * re-interpreting embedded `\n` and splitting to the current width, as
     * TBuffer::wrapLine does. Returns false when the window or line doesn't
     * exist; the Lua binding returns nothing either way, as desktop does.
     */
    wrapLine(lineNumber: number, windowName?: string): boolean {
        const con = this.getConsole(windowName);
        if (!con) return false;
        const isMain = !windowName || windowName === 'main';
        const [wrapAt, indent, hanging] = this.wrapSettings(windowName, con);
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
        if (batchSize !== undefined && Number.isFinite(batchSize)) {
            // A batch of none at all is raised to one line rather than left
            // alone: trimming pops one line per batch step, so a batch of zero
            // switches trimming off entirely and lets the buffer grow past the
            // limit that was just set (Mudlet's TBuffer::setBufferSize).
            const batch = batchSize >= limit ? Math.floor(limit / 10) : Math.floor(batchSize);
            con.setBatchDeleteSize(Math.max(1, batch));
        }
        if (con === this.mainConsole && Number.isFinite(limit)) {
            // Desktop's Host::setMainConsoleBufferSize stores the size and the
            // use-maximum flag in the profile's preferences as well, so they are
            // saved with it and the next session opens on them (its batch then
            // the preference's 20%, as for any saved size).
            const lines = Math.min(MAX_CONSOLE_BUFFER_LINES, limit);
            this.session.noteScriptedConsoleBufferSize(lines, useMaximum);
            useAppStore.getState().patchConnectionProfile(this.connectionId, {
                consoleBufferSize: lines,
                useMaxConsoleBufferSize: useMaximum,
            });
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
        const con = this.getConsole(windowName);
        if (!con) return false;
        if (!con.cursorPastEnd()) return con.cursorOnPrompt();
        // A trigger that gagged the line it matched left the cursor past the end
        // of the buffer, so there is no line left to carry the flag — and a
        // prompt is always the last line while its triggers run, so this is the
        // ordinary case rather than an edge one. Mudlet keeps the answer in the
        // trigger pass's own state (TConsoleModel::mIsPromptLine); the stack
        // mirrors it, one entry per line being processed.
        if (con === this.mainConsole && this.triggerLineDepth > 0) {
            return this.triggerLinePrompts[this.triggerLinePrompts.length - 1] ?? false;
        }
        return false;
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
        if (isMain) return measureColumnCapacity(el);

        // A sub-console is measured in the font it has been given rather than
        // the one its panel has painted yet: setFont/setFontSize take effect on
        // the next render, and a script that changes the font and then counts
        // the columns — or a timestamp change reporting them — has to see the
        // new count, as getRowCount already does.
        const profileFamily = selectProfileField(useAppStore.getState(), this.connectionId, 'outputFont')?.family ?? '';
        const profileSize   = selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize') ?? 12;
        const family = this.session.windows.getFont(windowName!) ?? profileFamily;
        const fontSize = this.session.windows.getFontSize(windowName!) ?? profileSize;
        const [cellW] = measureMonospaceCell(family, fontSize);
        if (cellW <= 0) return 0;
        if (el) {
            const cs = getComputedStyle(el);
            const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
            const width = Math.max(0, el.clientWidth - pad);
            if (width > 0) return Math.floor(width / cellW);
        }

        const size = this.session.windows.getSize(windowName!);
        if (!size || size.width <= 0) return 0;
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
            const pending = isMain ? 0 : this.session.windows.pendingCmdLineHeightDelta(windowName!);
            const height = Math.max(0, el.clientHeight - pad + pending);
            if (height > 0) return Math.floor(height / cellH);
        }
        if (isMain) return 0;

        const size = this.session.windows.getSize(windowName!);
        if (!size || size.height <= 0) return 0;
        const height = Math.max(0, size.height + this.session.windows.pendingCmdLineHeightDelta(windowName!));
        return Math.floor(height / cellH);
    }

    /**
     * Mudlet setWindowWrap(name, charsPerLine). Sets the wrap width (in
     * monospace columns) for the named window, buffer or "main", and re-applies
     * it to the lines the console stores from then on. 0 clears the setting,
     * back to the default (100 for main, no wrap for a window); the Lua binding
     * refuses it as Mudlet does. Returns false when the named window does not
     * exist; main always succeeds (persisted on the active profile, as Mudlet
     * keeps it in Host::mWrapAt).
     */
    setWindowWrap(name: string, wrapAt: number): boolean {
        if (!Number.isFinite(wrapAt)) return false;
        const v = Math.max(0, Math.round(wrapAt));
        if (!name || name === 'main') {
            // The store subscription in the constructor re-applies it, but not
            // when the value is unchanged, so apply it here too.
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputWrapAt: v > 0 ? v : undefined });
            this.applyStoredWrap(undefined);
            return true;
        }
        if (this.buffers.has(name)) {
            // An off-screen buffer has no WindowManager entry: its Console holds
            // the width. Clearing it goes back to the width it was created with.
            const con = this.outputConsole(name);
            const [, indent, hanging] = this.wrapSettings(name, con);
            con.setWrapWidth(v > 0 ? v : this.mainWrapAt(), indent, hanging);
            return true;
        }
        if (!this.session.windows.setWrap(name, v)) return false;
        this.applyStoredWrap(name);
        return true;
    }

    /** The main console's wrap width: the profile's `outputWrapAt`, which is
     *  Mudlet's Host::mWrapAt (100 unless changed). 0 means the Settings UI
     *  turned character wrapping off. */
    private mainWrapAt(): number {
        return selectProfileField(useAppStore.getState(), this.connectionId, 'outputWrapAt') ?? 0;
    }

    /** `[wrapAt, indent, hangingIndent]` for a console, 0 meaning off. Main
     *  reads the profile, an on-screen window its WindowManager entry, and a
     *  createBuffer buffer the Console it lives in. */
    private wrapSettings(windowName: string | undefined, con: Console): [number, number, number] {
        if (!windowName || windowName === 'main') {
            const state = useAppStore.getState();
            return [
                this.mainWrapAt(),
                selectProfileField(state, this.connectionId, 'outputWrapIndent') ?? 0,
                selectProfileField(state, this.connectionId, 'outputWrapHangingIndent') ?? 0,
            ];
        }
        if (this.buffers.has(windowName)) {
            return [con.getWrapWidth(), con.getWrapIndent(), con.getWrapHangingIndent()];
        }
        return [
            this.session.windows.getWrap(windowName) ?? 0,
            this.session.windows.getWrapIndent(windowName),
            this.session.windows.getWrapHangingIndent(windowName),
        ];
    }

    /** Tell the console the width to break stored lines at, so what `getLines`
     *  reports matches what the window shows. Called whenever the wrap width or
     *  either indent moves, and for main when the API is created. */
    private applyStoredWrap(windowName?: string): void {
        // Main's wrap also caps what NAWS reports and is the NEW-ENVIRON
        // WORD_WRAP — desktop reads Host::mWrapAt for both, and re-sends NAWS
        // when setWindowWrap("main", n) changes it.
        if (!windowName || windowName === 'main') this.session.setWrapAt(this.mainWrapAt());
        const con = this.getConsole(windowName);
        if (!con) return;
        con.setWrapWidth(...this.wrapSettings(windowName, con));
    }

    /**
     * Mudlet `getWindowWrap(name) → cols` — TConsole::getWrapAt, the width the
     * console's buffer wraps at. Main defaults to 100 (Host::mWrapAt) and a
     * createBuffer buffer to main's width when it was made; a miniconsole or
     * user window no script has set reports TBuffer's own 99999999. Returns -1
     * when the named window does not exist (Mudlet's invalid-window sentinel).
     */
    getWindowWrap(name: string): number {
        if (!name || name === 'main') return this.mainWrapAt();
        if (this.buffers.has(name)) return this.outputConsole(name).getWrapWidth();
        if (!this.session.windows.has(name)) return -1;
        return this.session.windows.getWrap(name) ?? WINDOW_WRAP_DEFAULT;
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
            this.applyStoredWrap(undefined);
            return true;
        }
        if (this.buffers.has(name)) {
            const con = this.outputConsole(name);
            const [width, , hanging] = this.wrapSettings(name, con);
            con.setWrapWidth(width, v, hanging);
            return true;
        }
        if (!this.session.windows.setWrapIndent(name, v)) return false;
        this.applyStoredWrap(name);
        return true;
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
            this.applyStoredWrap(undefined);
            return true;
        }
        if (this.buffers.has(name)) {
            const con = this.outputConsole(name);
            const [width, firstIndent] = this.wrapSettings(name, con);
            con.setWrapWidth(width, firstIndent, v);
            return true;
        }
        if (!this.session.windows.setWrapHangingIndent(name, v)) return false;
        this.applyStoredWrap(name);
        return true;
    }

    /**
     * Mudlet `setMapWindowTitle(title)`. Sets the dockable map panel's tab
     * title; an empty string resets it to the default ("Map - <profile>"). Returns false
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
    insertText(text: string, windowName?: string): boolean {
        const isMain = !windowName || windowName === 'main';
        const con = this.getConsole(windowName);
        const buf = con?.getBuffer();
        if (con && buf) {
            const state = con.format.toSnapshot();
            // Where the insert lands, read before it happens: the capture
            // positions this line's trigger recorded have to move with it.
            // A column past the end is padded with spaces by Console.insertText,
            // and the padding is inserted text as far as captures and colours go.
            const col = con.getCursorColumn();
            const at = Math.min(col, buf.text.length);
            const inserted = ' '.repeat(col - at) + text;
            // Console.insertText splits on embedded '\n' into new history lines
            // (Mudlet #8945); for the single-line case it inserts in place.
            con.insertText(text, state);
            if (this.inTriggerProcessing && con === this.mainConsole && !text.includes('\n')) {
                this.captureShiftHook?.(at, inserted.length);
                // The colours have to move with the text for the same reason
                // the captures do — the inserted characters are not the ones
                // the server coloured, and a later colour trigger must not
                // sweep them into its run.
                this.spliceLineColorSnapshot(at, 0, { ...this.stateColorKeys(state), text: inserted });
            }
            if (!this.inTriggerProcessing) con.getBuffer()?.rerender();
            return true;
        }
        // No current line: degrade to an echo so the text isn't lost.
        if (isMain) {
            // Mid trigger pass that means deleteLine() removed the matched
            // line. TConsole::insertText then hands TBuffer::insertInLine a y
            // past the end, which appends the text to the buffer's last line —
            // the trigger-mode echo — so it joins the line above rather than
            // starting one of its own (mudlet-web#383).
            if (this.inTriggerPass(this.mainConsole)) {
                this.echoMain(text, this.mainConsole.format.toSnapshot());
                this.drainMain();
                return true;
            }
            this.mainConsole.echoText(text);
            this.drainMain();
            return true;
        }
        if (!this.consoleExists(windowName)) return false;
        this.echoToWindow(windowName!, text);
        return true;
    }

    /**
     * Mudlet `insertLink([window,] text, cmd, hint, [useCurrentFormat])`.
     * Like `insertText` but the inserted span is a clickable link bound to
     * `cmd`. With `useCurrentFormat=false` (the default) the link gets
     * Mudlet's standard link format — link blue + underline, nothing of the
     * current pen ({@link standardLinkState}). If no buffer is available (empty console,
     * sub-window without backing buffer) the call degrades to `echoLink` so
     * the text isn't lost.
     */
    insertLink(text: string, cmd: string, tooltip: string, windowName?: string, useCurrentFormat = false): void {
        if (!text) return;
        const con = this.getConsole(windowName);
        const buf = con?.getBuffer();
        if (con && buf) {
            const hyperlink: FormatHyperlink = {
                onClick: () => { this.host.runLinkCode(cmd); },
                title: tooltip || undefined,
                luaCommands: [cmd],
            };
            const state: FormatStateSnapshot = useCurrentFormat
                ? { ...con.format.toSnapshot(), hyperlink }
                : this.standardLinkState(windowName, hyperlink);
            // A newline in the inserted text BREAKS the line, as it does for
            // insertText — TConsole::insertLink runs the same wrapLine() over
            // the result. Writing straight into the buffer skipped that, so the
            // text arrived carrying a literal newline inside one line and
            // getLineCount never moved.
            if (text.includes('\n')) {
                con.insertText(text, state);
                if (!this.inTriggerProcessing) con.getBuffer()?.rerender();
                return;
            }
            this.insertLinkSpan(con, buf, text, state, windowName,
                () => this.echoLink(text, cmd, tooltip, windowName, useCurrentFormat));
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
        // Only the line is range-checked, as in TBuffer::moveCursor; a negative
        // column is kept (see Console.moveTo).
        if (!Number.isFinite(x)) return false;
        if (!Number.isFinite(y) || y < 0) return false;
        return this.getConsole(windowName)?.moveTo(y, x) ?? false;
    }

    moveCursorEnd(windowName?: string): void {
        const con = this.getConsole(windowName);
        if (!con) return;
        if (this.inTriggerPass(con)) {
            // TConsoleModel::moveCursorEnd: the last line, on its last
            // character (column 0 for an empty one). Mid trigger pass the last
            // line is the one being matched — there is no open line after it —
            // so this is that line at length - 1, and getLineNumber() equals
            // getLineCount() afterwards. Parking one line further and one
            // column past the end put a following insertText after the whole
            // line and a getCurrentLine on no line at all (mudlet-web#273).
            const y = this.getLineCount(windowName);
            con.moveTo(y, Math.max(0, (con.lineText(y)?.length ?? 0) - 1));
            // The leading-newline latch is left as it is. beginLine set it for
            // the matched line's missing terminator; once an echo has ended
            // that line, a following "\n" ends the empty line after it — a
            // blank line on desktop, whose echo always appends whatever the
            // cursor does. Re-arming it here swallowed that blank line
            // (generic_mapper's print_echoes, mudlet-web#343).
            return;
        }
        // Outside one, the last line is the open line, and the cursor goes onto
        // its last character all the same (column 0 while it is empty).
        con.moveToEnd();
        con.setCursorColumn(Math.max(0, con.getLine().length - 1));
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
            this.session.windows.clearSplit('main');
        } else if (this.buffers.has(name)) {
            // Off-screen buffer: WindowManager.clear no-ops (no panel), so clear
            // the backing console directly.
            this.getConsole(name)?.clear();
            this.session.windows.clearSplit(name);
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
        // A name already taken by a buffer or a user window is not handed to a
        // new miniconsole (TMainConsole::createMiniConsole): the buffer is moved
        // and resized as a miniconsole of that name would be, and stays a
        // buffer; a user window is left alone. Either way the call reports
        // false, and Bridge.lua words the reason.
        if (this.buffers.has(name)) {
            this.moveBuffer(name, Math.round(x), Math.round(y));
            this.resizeBuffer(name, Math.round(width), Math.round(height));
            return false;
        }
        if (wm.has(name) && !wm.isMiniConsole(name)) return false;
        const created = !wm.has(name);
        if (created) {
            wm.open(name, {
                kind: 'text',
                title: name,
                autoDock: false,
                ignoreHint: true,
                parent: parent && parent !== 'main' ? parent : undefined,
            });
            // TMainConsole::createMiniConsole gives a new miniconsole a 12pt
            // font of its own rather than the profile's; getFontSize() reads
            // that back, and a re-create (a reposition) leaves it alone.
            wm.setFontSize(name, MINICONSOLE_DEFAULT_FONT_SIZE);
        } else {
            wm.show(name);
        }
        wm.markAsMiniConsole(name);
        wm.setPosition(name, Math.round(x), Math.round(y));
        wm.setSize(name, Math.round(width), Math.round(height));
        // That setFontSize(12) is a font change like any other, so desktop's
        // new miniconsole announces itself with sysFontChangeEvent — raised
        // once it is in place, for a handler that measures it.
        if (created) this.raiseFontChangeEvent(name);
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
        // A buffer is a console too, and desktop's deleteMiniConsole finds it
        // in the same map a miniconsole lives in: it goes, with its lines.
        if (this.buffers.has(name)) {
            this.buffers.delete(name);
            this.session.consoles.delete(name);
            this.windowCommandColors.delete(name);
            this.host.raiseEvent('sysMiniConsoleDeleted', [name]);
            return true;
        }
        // A user window counts: Geyser's UserWindow:delete goes through
        // MiniConsole.type_delete, which calls this — a user window is a
        // miniconsole with a dock around it, and refusing here left the window
        // on screen and still answering windowType() after it was deleted.
        if (!this.session.windows.isMiniConsole(name) && !this.session.windows.has(name)) return false;
        this.session.windows.close(name);
        this.windowCommandColors.delete(name);
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
    /** Whether an MXP frame of this name is open for a `<DEST>` to write to. */
    mxpHasFrame(name: string): boolean {
        return this.mxpFrames.has(name);
    }

    mxpFrame(name: string, attrs: Record<string, string>, dest?: string): boolean {
        if (!name) return false;
        return this.mxpFrames.createFrame(name, attrs, dest);
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
    mxpWriteToFrame(name: string, buffer: AnsiAwareBuffer, eof: boolean, eol = false): boolean {
        if (!this.mxpFrames.has(name)) return false;
        const id = mxpWindowId(name);
        // EOL is the narrower of the two clears: the write is a complete line,
        // so the part-written one the frame was left sitting on is discarded
        // rather than continued — but the finished lines above it stay, which is
        // what tells EOL from EOF. Without this the redirect joins onto whatever
        // was half-written and the two lines come out as one.
        if (eol && !eof) this.outputConsole(id).clearPartial();
        if (eof) {
            this.clearWindow(id);
            if (!this.mxpReplacedFrames.has(name)) {
                this.mxpReplacedFrames.add(name);
                this.session.windows.setTopAnchored(id, true);
            }
        }
        // Through the frame's own Console, not straight at the panel: that is
        // where getLines/getLineCount and the selection APIs read a window
        // from, so a redirect that bypassed it would be visible on screen and
        // invisible to every script — which is the opposite of the point of a
        // frame being "a miniconsole registered under the frame's name".
        const con = this.outputConsole(id);
        con.appendBuffer(buffer);
        this.drainWindowConsole(id, con);
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
            const id = mxpWindowId(name);
            this.session.windows.open(id, {
                kind: 'text', title, autoDock: false, lockFloating: true, ignoreHint: true, width, height,
            });
            // A frame is a frame whichever side of the main window it is on:
            // EXTERNAL only decides that it floats rather than taking space out
            // of the console, so it answers windowType() as the mini-console it
            // is — the same as an internal one, and the same as in Mudlet, where
            // both are a TConsole the frame manager owns. A script asking what a
            // frame is should not have to know how the game placed it.
            this.session.windows.markAsMiniConsole(id);
            this.session.windows.markAsMxpFrame(id);
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
        const fresh = !this.buffers.has(name);
        if (fresh) {
            this.buffers.set(name, {
                visible: false, x: 0, y: 0, width: 0, height: 0,
                background: { r: 0, g: 0, b: 0, a: 255 }, fontSize: null, fontFamily: null, timestamps: false,
            });
        }
        // Register the backing console so echo/selection resolve it by name.
        const con = this.outputConsole(name);
        // A buffer wraps like the main console (TConsole::changeColors gives
        // MainConsole and Buffer types the profile's Host::mWrapAt).
        if (fresh) {
            const state = useAppStore.getState();
            con.setWrapWidth(
                this.mainWrapAt(),
                selectProfileField(state, this.connectionId, 'outputWrapIndent') ?? 0,
                selectProfileField(state, this.connectionId, 'outputWrapHangingIndent') ?? 0,
            );
        }
    }

    /** True when `name` is an off-screen buffer created via createBuffer. */
    isBuffer(name: string): boolean {
        return this.buffers.has(name);
    }

    /** showWindow / hideWindow on a buffer: desktop finds it and flips the
     *  flag windowVisible reads back. False when `name` is no buffer. */
    setBufferVisible(name: string, visible: boolean): boolean {
        const buf = this.buffers.get(name);
        if (!buf) return false;
        buf.visible = visible;
        return true;
    }

    /** moveWindow on a buffer — kept for getWindowGeometry to report. */
    moveBuffer(name: string, x: number, y: number): boolean {
        const buf = this.buffers.get(name);
        if (!buf) return false;
        buf.x = x;
        buf.y = y;
        return true;
    }

    /** resizeWindow on a buffer — kept for getWindowGeometry to report. */
    resizeBuffer(name: string, width: number, height: number): boolean {
        const buf = this.buffers.get(name);
        if (!buf) return false;
        buf.width = width;
        buf.height = height;
        return true;
    }

    /**
     * Mudlet `copy([window])`. Copies the current selection of the resolved
     * console — including all formatting — into the session clipboard, a single
     * rich-text buffer shared with `paste`/`appendBuffer` (Mudlet's host-global
     * mClipboard).
     *
     * Like Host::copyToClipboard it ALWAYS replaces the clipboard with the named
     * console's selection (main when omitted) — when that console has none
     * (after a failed selectString, a deselect(), or a selection that belongs to
     * another window) the clipboard becomes empty, and a following appendBuffer
     * appends an empty line. Keeping the previous clipboard instead re-appended
     * stale text. Only an unknown window leaves the clipboard alone (desktop
     * raises "window not found" there). TBuffer::copy resets a start outside
     * the line to column 0, which is reproduced too.
     */
    copy(windowName?: string): boolean {
        if (windowName !== undefined && !this.consoleExists(windowName)) return false;
        const target = windowName ?? 'main';
        const sel = this.selectionOf(target);
        const buf = sel ? this.resolveBuffer(sel.windowName) : null;
        if (!sel || !buf) {
            this.clipboard = new AnsiAwareBuffer('');
            return true;
        }
        const start = sel.start < 0 || sel.start >= buf.length ? 0 : sel.start;
        const end = Math.max(start, Math.min(sel.start + sel.length, buf.length));
        const slice = buf.clone();
        slice.remove([end, slice.length]);
        slice.remove([0, start]);
        this.clipboard = slice;
        return true;
    }

    /** The Lua code of every scripted link in the clipboard, for Bridge.lua to
     *  hold a reference of the clipboard's own to each function a link calls,
     *  as TBuffer's copied TLinkStore does in desktop. */
    clipboardLinkCommands(): string[] {
        const commands: string[] = [];
        for (const segment of this.clipboard?.getSegments() ?? []) {
            commands.push(...(segment.state?.hyperlink?.luaCommands ?? []));
        }
        return commands;
    }

    /**
     * Mudlet `cut()`. `copy()` and then delete what was copied, so the clipboard
     * holds exactly the text the line lost (TConsole::cut → TBuffer::cut). Takes
     * no window argument in Mudlet — it always acts on the main console — and is
     * a no-op without a selection there.
     */
    cut(): void {
        const sel = this.selectionOf('main');
        if (!sel) return;
        this.copy('main');
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return;
        const start = Math.max(0, Math.min(sel.start, buf.length));
        const end = Math.max(start, Math.min(sel.start + sel.length, buf.length));
        buf.remove([start, end]);
        this.clearSelection('main');
        if (!this.inTriggerProcessing) buf.rerender();
    }

    /**
     * Mudlet `appendBuffer([window])`. Appends the clipboard's rich text (from
     * the last `copy()`) onto the end of the named console's last line, then
     * ends that line. No-op until something has been copied. Mirrors
     * TConsole::appendBuffer.
     */
    appendBuffer(windowName?: string): void {
        if (!this.clipboard) return;
        const isMain = !windowName || windowName === 'main';
        const con = this.penConsole(windowName);
        if (!con) return;
        if (isMain && this.echoOnMatchedLine) {
            // Mid trigger pass the matched line is the buffer's last line —
            // desktop fires before its terminator opens the next one — so
            // TBuffer::appendBuffer writes the chunk onto the END of the matched
            // line and only then ends it, exactly as echo(text .. "\n") from a
            // trigger does. Appending to the open line below put the pasted
            // text on a line of its own, out of reach of the triggers still to
            // run on this one.
            const matched = this.mainConsole.getBuffer();
            const buf = matched ?? this.mainConsole.lastLine();
            if (buf) {
                buf.insertBuffer(buf.length, this.clipboard.clone());
                if (!matched) buf.rerender();
                this.echoMain('\n');
                this.drainMain();
                return;
            }
        }
        con.appendBuffer(this.clipboard.clone());
        if (isMain) this.drainMain();
        else this.drainWindowConsole(windowName!, con);
    }

    /**
     * Mudlet `paste([window])`. Inserts the clipboard at the cursor's current
     * column when the cursor sits above the last line; otherwise writes it onto
     * the end of the last line and ends that line (Host::pasteClipboardInto).
     * No-op without a prior copy().
     */
    paste(windowName?: string): void {
        if (!this.clipboard) return;
        const con = this.penConsole(windowName);
        if (!con) return;
        const buf = con.getBuffer();
        const isMain = !windowName || windowName === 'main';
        // TConsole::paste inserts at the cursor unless it is on the buffer's
        // last line — the open one — and appends there. Every console but main
        // keeps its cursor where a script put it (see Console.followsOutput), so
        // that line is counted the way getLastLineNumber() counts it: a window
        // cursor never moved off line 0 pastes into line 0, as it does in
        // Mudlet. Main's cursor follows its output onto the last complete line,
        // which keeps appending as it always has.
        const lastLine = isMain ? con.getLineCount() : this.getLineCount(windowName);
        if (buf && con.getLineNumber() < lastLine) {
            const at = con.getCursorColumnRaw();
            // TBuffer::paste refuses a negative column outright.
            if (at < 0) return;
            // Past the end of the line, Mudlet's insertInLine pads out to the
            // cursor (expandLine) rather than clamping back to it, so the pasted
            // text lands at the column that was asked for.
            // The padding takes the console's current format, as expandLine
            // fills with the console's own pen, not the pasted text's.
            if (at > buf.length) buf.insert(buf.length, ' '.repeat(at - buf.length), con.format.toSnapshot());
            buf.insertBuffer(at, this.clipboard.clone());
            if (!this.inTriggerProcessing) buf.rerender();
            return;
        }
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
     * routing precedence they use (labels → scroll boxes → command lines →
     * text edits → user windows/miniconsoles). Null when no widget of any
     * kind owns the name; `"main"` is deliberately excluded because
     * moveWindow/resizeWindow don't act on it either.
     *
     * The scroll box comes before the other overlays for the reason windowType
     * puts it there: one name can be a scroll box AND a text edit at once, and
     * every by-name lookup has to give the same answer as the last one until
     * the scroll box is deleted.
     */
    getWindowGeometry(name: string): { x: number; y: number; width: number; height: number } | null {
        if (name === 'main') return null;
        const overlay = this.labels.get(name) ?? this.scrollBoxes.get(name)
            ?? this.cmdLines.get(name) ?? this.textEdits.get(name);
        if (overlay) {
            const { x, y, width, height } = overlay;
            return { x, y, width, height };
        }
        const buf = this.buffers.get(name);
        if (buf) return { x: buf.x, y: buf.y, width: buf.width, height: buf.height };
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
        const buf = this.buffers.get(name);
        if (buf) return buf.visible;
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

    /** A move that would make a parent cycle answers desktop's refusal message
     *  (TMainConsole::reparentWindow) rather than false, for Bridge.lua to
     *  return as (nil, message). */
    setWindow(windowName: string, name: string, x = 0, y = 0, show = true): boolean | string {
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
                if (p === name) return `element '${name}' cannot be moved into itself or into one of its own children`;
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
        const sel = this.selectionOf(windowName);
        if (!sel) return;
        const targetWin = sel.windowName;
        const buf = this.resolveBuffer(targetWin);
        if (!buf) return;
        // TBuffer::replaceInLine refuses a selection that no longer fits the
        // line rather than trimming it.
        if (sel.start < 0 || sel.start + sel.length > buf.length) return;
        const state = keepColor ? undefined : this.outputConsole(targetWin).format.toSnapshot();
        buf.replace([sel.start, sel.start + sel.length], newText, state);
        if (this.inTriggerProcessing && this.getConsole(targetWin) === this.mainConsole) {
            // TConsole::replace moves every capture from the start of the
            // selection on by the change in length, so a later group is still
            // found where its text now is
            this.captureShiftHook?.(sel.start, newText.length - sel.length);
            // Same alignment the insert path needs: a replace that changes the
            // line's LENGTH moves every colour run after it. With keepColor the
            // replacement wears whatever the snapshot already had at that
            // offset, which is what "keep" means here.
            this.spliceLineColorSnapshot(sel.start, sel.length, newText ? {
                ...(state ? this.stateColorKeys(state) : this.snapshotColorAt(sel.start)),
                text: newText,
            } : undefined);
        }
        // The selection is left where it was — same start, same length — as
        // TConsoleModel::replace leaves P_begin/P_end: replaceInLine only reads
        // them. So the common selectString → replace → setFgColor idiom colours
        // the replacement; clearing it here made that last call a no-op.
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
        // A trigger gagging its own matched line is the common case, and that
        // line is still on its way to the renderer — which reads the flag to
        // know not to emit it. The buffer drops it either way and drops it now:
        // Mudlet deletes it from TBuffer inside deleteLine(), so getLineCount()
        // and the cursor have to see it gone before the trigger script has run
        // its next statement.
        if (this.inTriggerProcessing && buf) buf.markAsDeleted();
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

    /** Mudlet printCmdLine, which leaves the caret at the end with nothing
     *  selected (TMainConsole's putTextOnCommandLine); `selectAll` is
     *  sendCmdLine's setCommandLineText, which selects what it put there — the
     *  form a link PROMPT takes on desktop too. */
    printCmdLine(text: string, selectAll = false): void {
        this.cmdLineValue = text;
        this.session.events.emit('script.setcmd', text, selectAll);
    }

    clearCmdLine(): void {
        this.cmdLineValue = '';
        this.session.events.emit('script.clearcmd');
    }

    /**
     * Mudlet selectCmdLineText([commandLine]). Selects (highlights) all text in
     * the command bar so the next keystroke overtypes it. Mudlet Web has a single
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
     * Recolors the command bar's background and the echoed commands
     * (Host::mCommandBgColor). Mudlet Web only has the main command
     * bar, so a non-"main" windowName is ignored. `a` is Mudlet's 0..255 alpha;
     * the CommandBar reads the `inputBackground` profile field as a CSS color.
     */
    setCommandBackgroundColor(r: number, g: number, b: number, a = 255, name?: string): boolean {
        if (name && name !== 'main') {
            const ok = this.session.windows.setCmdLineColor(name, 'background-color', r, g, b, a);
            if (ok) this.windowCommandColors.set(name, { ...this.windowCommandColors.get(name), bg: [r, g, b] });
            return ok;
        }
        const commandEchoBackground = hexCss(r, g, b);
        useAppStore.getState().patchConnectionProfile(this.connectionId, {
            inputBackground: rgbaCss(r, g, b, a),
            commandEchoBackground,
        });
        // The next echoed command is drawn in it at once — Host::mCommandBgColor
        // is read as the command is printed — not once the store change has
        // made its way back through a render.
        this.session.commandEchoColor = { ...this.session.commandEchoColor, bg: commandEchoBackground };
        return true;
    }

    /** Mudlet setCommandForegroundColor — recolors the command bar text and
     *  the echoed commands (Host::mCommandFgColor). */
    setCommandForegroundColor(r: number, g: number, b: number, a = 255, name?: string): boolean {
        if (name && name !== 'main') {
            const ok = this.session.windows.setCmdLineColor(name, 'color', r, g, b, a);
            if (ok) this.windowCommandColors.set(name, { ...this.windowCommandColors.get(name), fg: [r, g, b] });
            return ok;
        }
        const commandEchoForeground = hexCss(r, g, b);
        useAppStore.getState().patchConnectionProfile(this.connectionId, {
            inputForeground: rgbaCss(r, g, b, a),
            commandEchoForeground,
        });
        // Host::mCommandFgColor, which the next echoed command is drawn in —
        // applied now for the same reason as setCommandBackgroundColor.
        this.session.commandEchoColor = { ...this.session.commandEchoColor, fg: commandEchoForeground };
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

    // ── Command-line tab-completion suggestions and blacklist ─────────────────
    // Mudlet's addCmdLineSuggestion / addCmdLineBlacklist families. Each
    // TCommandLine keeps its own two lists, so they are held per command-line
    // name here: "main" for the command bar, else a createCommandLine line or a
    // miniconsole's / user window's own one. Words added for a named line used
    // to land on the main bar (#342). The suggestions are insertion-ordered
    // Sets; the blacklist is subtractive across everything Tab draws from (the
    // buffer and the suggestions alike) and matched case-insensitively, as
    // TCommandLine does — it is how you stop Tab offering a word the game keeps
    // saying. The main bar's lists also go out as `script.cmdlinesuggestions` /
    // `script.cmdlineblacklist` snapshots, so React re-renders without polling;
    // a named line reads its own at Tab time through cmdLineCompletionWords.
    private cmdLineSuggestions = new Map<string, Set<string>>();
    private cmdLineBlacklist = new Map<string, Set<string>>();

    private completionList(lists: Map<string, Set<string>>, cmdLine: string): Set<string> {
        let set = lists.get(cmdLine);
        if (!set) { set = new Set(); lists.set(cmdLine, set); }
        return set;
    }

    addCmdLineSuggestion(suggestion: string, cmdLine = 'main'): void {
        const s = suggestion ?? '';
        const set = this.completionList(this.cmdLineSuggestions, cmdLine);
        if (!s || set.has(s)) return;
        set.add(s);
        this.emitCmdLineSuggestions(cmdLine);
    }

    removeCmdLineSuggestion(suggestion: string, cmdLine = 'main'): void {
        if (this.cmdLineSuggestions.get(cmdLine)?.delete(suggestion ?? '')) {
            this.emitCmdLineSuggestions(cmdLine);
        }
    }

    clearCmdLineSuggestions(cmdLine = 'main'): void {
        const set = this.cmdLineSuggestions.get(cmdLine);
        if (!set || set.size === 0) return;
        set.clear();
        this.emitCmdLineSuggestions(cmdLine);
    }

    getCmdLineSuggestions(cmdLine = 'main'): string[] {
        return [...(this.cmdLineSuggestions.get(cmdLine) ?? [])];
    }

    private emitCmdLineSuggestions(cmdLine: string): void {
        if (cmdLine !== 'main') return;
        this.session.events.emit('script.cmdlinesuggestions', this.getCmdLineSuggestions());
    }

    addCmdLineBlacklist(word: string, cmdLine = 'main'): void {
        const w = word ?? '';
        const set = this.completionList(this.cmdLineBlacklist, cmdLine);
        if (!w || set.has(w)) return;
        set.add(w);
        this.emitCmdLineBlacklist(cmdLine);
    }

    removeCmdLineBlacklist(word: string, cmdLine = 'main'): void {
        if (this.cmdLineBlacklist.get(cmdLine)?.delete(word ?? '')) this.emitCmdLineBlacklist(cmdLine);
    }

    clearCmdLineBlacklist(cmdLine = 'main'): void {
        const set = this.cmdLineBlacklist.get(cmdLine);
        if (!set || set.size === 0) return;
        set.clear();
        this.emitCmdLineBlacklist(cmdLine);
    }

    getCmdLineBlacklist(cmdLine = 'main'): string[] {
        return [...(this.cmdLineBlacklist.get(cmdLine) ?? [])];
    }

    private emitCmdLineBlacklist(cmdLine: string): void {
        if (cmdLine !== 'main') return;
        this.session.events.emit('script.cmdlineblacklist', this.getCmdLineBlacklist());
    }

    /** A deleted command line takes its lists with it; one made later under
     *  the same name starts empty, as a new TCommandLine does. */
    forgetCmdLineCompletion(cmdLine: string): void {
        if (cmdLine === 'main') return;
        this.cmdLineSuggestions.delete(cmdLine);
        this.cmdLineBlacklist.delete(cmdLine);
    }

    /** The Tab-completion pool for command line `cmdLine` as it stands now:
     *  the main console's last 500 lines, then the line's suggestions, less
     *  its blacklist — what TCommandLine::handleTabCompletion assembles on
     *  every press. Every command line reads the MAIN console's buffer. */
    cmdLineCompletionWords(cmdLine = 'main'): string[] {
        const lines = this.session.consoles.get('main')?.getEndLines(TAB_COMPLETION_LINES) ?? [];
        return tabCompletionPool(lines, this.getCmdLineSuggestions(cmdLine), this.getCmdLineBlacklist(cmdLine));
    }

    // ── Per-command-line history saving ─────────────────────────────────────
    // Mudlet's TCommandLine::mSaveCommands, reached from Lua as
    // get/setSaveCommandHistory. It is a second switch *under* the profile-wide
    // `commandLineHistorySaveSize`: with that at zero nothing is saved at all
    // and this one is not even consulted. Defaults to on, as Mudlet's does.
    private saveCommandHistoryFlags = new Map<string, boolean>();

    /** Which file each command line's history is kept in. Assigned on creation
     *  and never reused, because two command lines sharing one file would
     *  overwrite each other's history on the next save. */
    private readonly cmdLineHistoryFiles = new Map<string, string>();
    private nextHistoryFile = 1;

    /** Register a command line's history file, returning its name. */
    noteCommandLineForIni(cmdLineName: string): string {
        const existing = this.cmdLineHistoryFiles.get(cmdLineName);
        if (existing) return existing;
        const file = `command_history_${this.nextHistoryFile++}`;
        this.cmdLineHistoryFiles.set(cmdLineName, file);
        return file;
    }

    forgetCommandLineForIni(cmdLineName: string): void {
        this.cmdLineHistoryFiles.delete(cmdLineName);
    }

    /**
     * The profile's `profile.ini`, in the shape QSettings writes it.
     *
     * Mudlet keeps this file open and lets QSettings flush it on the next pass
     * through the event loop, so what a command line records reaches the disk
     * without anyone asking for a save. Two things live under [CommandLines]:
     * which file each one's history goes in, written when it is created, and
     * whether it saves history at all, written with the end-of-session save.
     */
    profileIniContent(): string {
        const lines = ['[CommandLines]'];
        for (const [name, file] of this.cmdLineHistoryFiles) {
            lines.push(`NameMapping\\${name}=${file}`);
        }
        for (const [name, save] of this.saveCommandHistoryFlags) {
            lines.push(`SaveHistory\\${name}=${save}`);
        }
        return `${lines.join('\n')}\n`;
    }

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
     * The command-line history files an end-of-session save should write, as
     * `{ name, content }` pairs relative to the profile directory. Empty when
     * nothing is to be written.
     *
     * Mudlet does this from `Host::saveProfile()`, which emits
     * `signal_saveCommandLinesHistory` and lets every TCommandLine write its own
     * `command_history_<name>` — newest command first, one per line, capped at
     * the profile-wide save size. Both switches have to be on: the size, and the
     * command line's own flag.
     *
     * Only the main bar has a history to write. Mudlet Web's Geyser command lines
     * keep none, so unlike Mudlet there are no numbered files beside it — the
     * shape is here rather than a bare `saveMainHistory()` so that one gaining a
     * history is a change in this function alone.
     */
    commandLineHistoryFiles(): { name: string; content: string }[] {
        const size = Number(this.getConfig('commandLineHistorySaveSize') ?? 0);
        if (!(size > 0) || !this.saveCommandHistoryFor('main')) return [];
        const history = loadHistory(historyStorageKey(this.connectionId));
        return [{ name: 'command_history_main', content: history.slice(0, size).join('\n') }];
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
    // `data-qt-object` hooks Mudlet Web's DOM carries — see qtCss.ts. Per-window CSS is
    // translated through `userWindowQssToScopedCss`: `QWidget { … }` (the
    // canonical Mudlet selector) auto-scopes to `[data-mudlet-window="name"]`,
    // so a stylesheet like `QWidget { padding: 15 20; }` actually pads the
    // window viewport. Scripts can still write the attribute selector
    // explicitly for non-`QWidget` rules. After a successful app-level install
    // we raise sysAppStyleSheetChange via `host.raiseEvent` so themes can hook
    // re-applies.



    /**
     * Get (or create) a `<style>` tag in `document.head` owned by this profile.
     *
     * Every tag Mudlet Web installs on a script's behalf is stamped with the owning
     * connection id, both in its element id and in `data-mudlet-style-owner`, so
     * {@link destroy} can take them all down again. Mudlet's `setAppStyleSheet`
     * is genuinely application-wide (a QApplication stylesheet shared by every
     * open profile), but a Mudlet Web tab hosts one profile at a time: leaving a
     * closed profile's CSS installed silently restyled the *next* profile opened
     * in that tab. So all three setters — app, profile and per-window — are
     * profile-local here, and torn down with the profile.
     */
    private styleTag(kind: string, key: string, dataKey: string, dataValue: string): HTMLStyleElement {
        const id = `mudlet-${kind}-stylesheet--${this.connectionId}--${key}`;
        let el = document.getElementById(id) as HTMLStyleElement | null;
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            el.dataset[dataKey] = dataValue;
            el.dataset.mudletStyleOwner = this.connectionId;
            document.head.appendChild(el);
        }
        return el;
    }

    /** Remove every `<style>` tag this profile's scripts installed. */
    private removeOwnedStyleTags(): void {
        const owned = document.querySelectorAll(`style[data-mudlet-style-owner="${cssEscape(this.connectionId)}"]`);
        for (const el of owned) el.remove();
    }

    setAppStyleSheet(css: string, tag?: string): boolean {
        const key = tag && tag.length > 0 ? tag : 'default';
        const el = this.styleTag('app', key, 'mudletAppStylesheet', key);
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
        const el = this.styleTag('userwindow', name, 'mudletUserwindowStylesheet', name);
        const scope = `[data-mudlet-window="${cssEscape(name)}"]`;
        el.textContent = userWindowQssToScopedCss(css ?? '', scope);
        // Remembered verbatim: the tag holds the *scoped* translation, and a
        // getter has to answer what the script wrote, not what Mudlet Web made of it.
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

    /** The stylesheet a sub command line is created with — the profile's command
     *  line background, in the shape Mudlet's TCommandLine builds. */
    bornCmdLineStyleSheet(): string {
        const profile = useAppStore.getState().connectionProfile[this.connectionId];
        const background = profile?.inputBackground || 'rgb(0,0,0)';
        return `QPlainTextEdit{background-color: ${background};}`;
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
     * here (as Mudlet Web used to) told every profile-agnostic theme handler to
     * re-apply itself over a change that was never theirs.
     */
    setProfileStyleSheet(css: string): boolean {
        const el = this.styleTag('profile', 'default', 'mudletProfileStylesheet', 'true');
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

    centerView(roomId: number, viewId?: number): boolean | string {
        return this.session.windows.centerView(roomId, viewId);
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
     * `mLast2DMapZoom`, reached via TRoomDB::get2DMapZoom), so each area
     * remembers its own; Mudlet Web stores it the same way. Desktop still refuses
     * the call until a mapper exists ("no active mapper"), whichever area is asked. Without an areaID the live renderer's current zoom wins when one
     * is mounted. Undefined for an areaID that doesn't exist — the binding
     * reports that as `(nil, errMsg)`.
     */
    getMapZoom(areaID?: number, viewId?: number): number | undefined | string {
        // A view answers for the area IT is showing, whatever areaID was passed.
        if (viewId !== undefined && viewId > 0) {
            const area = this.session.windows.mapViewArea(viewId);
            if (typeof area === 'string') return `getMapZoom: ${area}`;
            return this.map.getAreaZoom(area) ?? MapStore.DEFAULT_MAP_ZOOM;
        }
        // Desktop asks for the mapper before it looks at the area at all
        // (TLuaInterpreterMapper.cpp), so without one even a valid areaID is
        // refused — the zoom it would read lives on the TArea, but the call is
        // still a mapper call.
        if (!this.session.windows.hasMapper()) return 'no active mapper';
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
    setMapZoom(zoom: number, areaID?: number, viewId?: number): string | null {
        // T2DMap::setMapZoom: NaN would pass the minimum check (every
        // comparison with it is false) and an infinite zoom shows nothing, so
        // both are refused first — named as QString::number writes them.
        if (!Number.isFinite(zoom)) {
            const named = Number.isNaN(zoom) ? 'nan' : zoom > 0 ? 'inf' : '-inf';
            return `setMapZoom: zoom ${named} is invalid, it must be a finite number`;
        }
        if (zoom < MapStore.MIN_MAP_ZOOM) {
            return `setMapZoom: zoom ${zoom} is too small, it must be at least ${MapStore.MIN_MAP_ZOOM}`;
        }
        // Through a view the areaID is ignored and the zoom lands on the area
        // the view is showing, which is what makes the primary mapper read it
        // back — the zoom lives on the TArea, not on the window.
        if (viewId !== undefined && viewId > 0) {
            const area = this.session.windows.mapViewArea(viewId);
            if (typeof area === 'string') return `setMapZoom: ${area}`;
            this.map.setAreaZoom(area, zoom);
            // The view itself now shows that zoom, so getMapViewInfo says so.
            this.session.windows.noteMapViewState(mapViewWindowId(viewId), { zoom });
            return null;
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

    /**
     * Mudlet `setMapBackgroundColor(r, g, b [, a])`. Persists into the profile
     * mapper settings so MapPanel picks it up on its next render pass.
     *
     * Returns the refusal message for a component outside 0-255 and `null` on
     * success — Bridge.lua turns the former into Mudlet's `(nil, errMsg)` pair.
     * The alpha is optional and defaults to opaque; it is stored only when it is
     * not, so an ordinary colour stays the plain `#rrggbb` the renderer and the
     * Mapper tab have always written.
     */
    setMapBackgroundColor(r: number, g: number, b: number, a = 255): string | null {
        const bad = badColorComponent({ red: r, green: g, blue: b, alpha: a });
        if (bad) return bad;
        const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
            + (a === 255 ? '' : a.toString(16).padStart(2, '0'));
        this.setMapperField('backgroundColor', hex);
        return null;
    }

    /** Mudlet `getMapBackgroundColor()` — the four components of the colour
     *  {@link setMapBackgroundColor} stored, alpha included. */
    getMapBackgroundColor(): [number, number, number, number] {
        return parseRgba(this.getMapperField('backgroundColor') ?? MAPPER_DEFAULTS.backgroundColor);
    }

    /** Mudlet `setMapRoomExitsColor(r, g, b)`. The exit pen carries no alpha
     *  either way, so this is the renderer's `lineColor` and nothing else. */
    setMapRoomExitsColor(r: number, g: number, b: number): string | null {
        const bad = badColorComponent({ red: r, green: g, blue: b });
        if (bad) return bad;
        this.setMapperField('lineColor',
            '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join(''));
        return null;
    }

    /** Mudlet `getMapRoomExitsColor()` — three components, no alpha. */
    getMapRoomExitsColor(): [number, number, number] {
        const [r, g, b] = parseRgba(this.getMapperField('lineColor') ?? MAPPER_DEFAULTS.lineColor);
        return [r, g, b];
    }

    /** Mudlet `setDefaultAreaVisible(visible)`. Mudlet's `TMap::mShowDefaultArea`
     *  decides whether the unnamed catch-all area rooms land in before they are
     *  filed anywhere shows up in the area list; here that list is MapPanel's
     *  area dropdown, which reads the same flag. */
    setDefaultAreaVisible(visible: boolean): boolean {
        this.setMapperField('showDefaultArea', visible);
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
    loadMap(buf?: Uint8Array, source?: string): boolean {
        if (!buf) return this.session.windows.loadMap();
        // Copy into a fresh standalone ArrayBuffer — the source may be a slice
        // of a larger buffer (e.g. a Node Buffer view onto a pool) or a
        // SharedArrayBuffer-backed view, both of which the binary reader chokes on.
        const out = new ArrayBuffer(buf.byteLength);
        new Uint8Array(out).set(buf);
        // `source` names the file in any message the load has to put in front of
        // the player (e.g. an unreadable format version — Mudlet quotes the file
        // name in every one of those, TMap::readMap src/TMap.cpp:1531-1573).
        return this.session.windows.loadMap(out, source);
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
    /** The map as Mudlet's JSON, carrying the map-level settings that live in
     *  the profile rather than in the map store — Mudlet writes them into the
     *  same file, so a map moved between clients keeps the way it looks. */
    saveJsonMap(): string {
        const marker = this.jsonPlayerRoom;
        return this.session.windows.saveJsonMap({
            mapSymbolFontFudgeFactor: this.getConfig('mapSymbolFontScaling'),
            // QFont::toString(), which is what desktop writes and reads back
            // with QFont::fromString: a bare family name parses as a font with
            // no size, and desktop falls back to its smaller default for it.
            mapSymbolFontDetails: `${String(this.getConfig('mapSymbolFont'))},${MAP_SYMBOL_FONT_POINT_SIZE},-1,5,50,0,0,0,0,0`,
            onlyMapSymbolFontToBeUsed: this.getConfig('mapSymbolFontOnlyUseSelected'),
            // Desktop's player-room marker settings. Mudlet Web draws its own
            // marker (Settings → Mapper), so these are desktop's values carried
            // through: its defaults, or what the last imported file said. Left
            // out, a desktop that imports the file zeroes them — a marker with
            // no diameter and black colours.
            playerRoomStyle: marker.style,
            playerRoomOuterDiameterPercentage: marker.outerDiameter,
            playerRoomInnerDiameterPercentage: marker.innerDiameter,
            playerRoomColors: [jsonColor(marker.outerColor), jsonColor(marker.innerColor)],
        });
    }

    /** Desktop's player-room marker settings as saveJsonMap writes them — see
     *  there. Desktop's Host defaults until a file brings its own. */
    private jsonPlayerRoom: JsonPlayerRoomSettings = { ...DESKTOP_PLAYER_ROOM };

    /** The counterpart of the extras {@link saveJsonMap} writes: an imported
     *  file's map-level settings, applied after the rooms have loaded. */
    applyJsonMapSettings(doc: Record<string, unknown>): void {
        const scaling = Number(doc.mapSymbolFontFudgeFactor);
        if (Number.isFinite(scaling)) this.setConfig('mapSymbolFontScaling', scaling);
        if (typeof doc.mapSymbolFontDetails === 'string' && doc.mapSymbolFontDetails) {
            // QFont::toString's first field is the family; the rest (size,
            // weight, style…) has nowhere to go in a family-only setting.
            const family = doc.mapSymbolFontDetails.split(',')[0].trim();
            if (family) this.setConfig('mapSymbolFont', family);
        }
        if (typeof doc.onlyMapSymbolFontToBeUsed === 'boolean') {
            this.setConfig('mapSymbolFontOnlyUseSelected', doc.onlyMapSymbolFontToBeUsed);
        }
        const marker = { ...this.jsonPlayerRoom };
        const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
        marker.style = int(doc.playerRoomStyle) ?? marker.style;
        marker.outerDiameter = int(doc.playerRoomOuterDiameterPercentage) ?? marker.outerDiameter;
        marker.innerDiameter = int(doc.playerRoomInnerDiameterPercentage) ?? marker.innerDiameter;
        if (Array.isArray(doc.playerRoomColors)) {
            marker.outerColor = readJsonRgba(doc.playerRoomColors[0]) ?? marker.outerColor;
            marker.innerColor = readJsonRgba(doc.playerRoomColors[1]) ?? marker.innerColor;
        }
        this.jsonPlayerRoom = marker;
    }

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
     * Mudlet Web reads it, and those bytes describe Qt dock widgets that have no
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
    getTime(): {
        year: number; month: number; day: number; hour: number; min: number; sec: number; msec: number; wday: number;
        tzAbbr: string; tzOffset: string; tzOffsetColon: string; tzLong: string;
    } {
        const d = new Date();
        return {
            // The zone, for the `t`…`tttt` format tokens.
            tzAbbr: timeZoneAbbreviation(d),
            tzOffset: timeZoneOffset(d),
            tzOffsetColon: timeZoneOffset(d, true),
            tzLong: timeZoneLongName(d),
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
     * Mudlet `getNetworkLatency()` — the most recent round trip measured,
     * from a command to the game's next GA/EOR prompt marker (as Mudlet
     * times it). Returns the last measured value (in ms) for as long as
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

    /** Mudlet `setMainWindowSize(width, height)`. Sizes the main viewport —
     *  the rectangle {@link getMainWindowSize} reports — since a browser tab
     *  cannot resize itself. See WindowManager.setMainWindowSize. */
    setMainWindowSize(width: number, height: number): boolean {
        return this.session.windows.setMainWindowSize(width, height);
    }

    /**
     * Mudlet `hasFocus([window])` → bool. Reports whether the named console (or
     * the main command bar / output area when omitted) currently holds keyboard
     * focus. Mudlet Web maps "main"/omitted to the command input, and a named window
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
     * the main wrap column (`outputWrapAt`, 100 by default), falling back to
     * the live measured column count when the Settings turned wrapping off.
     */
    getMainConsoleWidth(): number {
        const state = useAppStore.getState();
        const family = selectProfileField(state, this.connectionId, 'outputFont')?.family ?? '';
        const size = selectProfileField(state, this.connectionId, 'fontSize') ?? 12;
        const [cellW] = measureMonospaceCell(family, size);
        const wrapAt = this.mainWrapAt() || this.getColumnCount('main');
        // Not rounded: desktop's width is a qreal, and the column width a script
        // works out of it (width / (wrapAt + 1)) has to multiply back exactly.
        // The cell is held to Qt's 1/64 px font-metric grid (QFixed), so that
        // division and multiplication are exact in floating point.
        return (Math.round(cellW * 64) / 64) * (wrapAt + 1);
    }

    /** The server the last connectToServer() pointed the profile at, with the
     *  dial it asked for — see {@link getConnectionInfo}. */
    private connectTarget: { host: string; port: number; url: string; dials: number } | null = null;

    /**
     * Mudlet `getConnectionInfo()` → `host, port, connected`. Mudlet reports the
     * MUD's telnet host/port — cTelnet's own, which `connectToServer` replaces
     * whether or not it saves them, so a script that moved the profile to
     * another server is told that server from the call on, through a failed
     * dial and a `reconnect()` (mudlet-web#339). That target holds until a dial
     * to somewhere else (the Connect button redialling the profile) overtakes
     * it. Otherwise Mudlet Web reads the active connection config: for a
     * `mud`-mode connection the stored host/port, for a raw `websocket` one the
     * endpoint URL's (port falls back to the ws/wss default). `connected`
     * reflects the live session status.
     */
    getConnectionInfo(): { host: string; port: number; connected: boolean } {
        const connected = this.session.status === 'connected';
        const target = this.connectTarget;
        if (target && (this.session.dialCount === target.dials || this.session.dialedUrl === target.url)) {
            return { host: target.host, port: target.port, connected };
        }
        const conn = useAppStore.getState().connections.find(c => c.id === this.connectionId);
        const { host, port } = conn ? connectionHostPort(conn) : { host: '', port: 0 };
        return { host, port, connected };
    }

    /**
     * Mudlet `connectToServer(host, port [, save])`. Mudlet Web tunnels MUD traffic
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
        this.connectTarget = { host, port, url, dials: this.session.dialCount };
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
        const id = assertive ? 'mudlet-aria-live-assertive' : 'mudlet-aria-live-polite';
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
        // TMainConsole::getUserWindowSize only looks in the dock registry, which
        // holds user windows alone — a miniconsole (or embedded mapper) is not
        // there, so it gets the main window's size like any unknown name.
        if (this.session.windows.isMiniConsole(name)) return this.getMainWindowSize();
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
        const whole = fontSizePoints(size);
        if (whole === null) return false;
        if (!win || win === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { fontSize: whole });
            return true;
        }
        // A buffer keeps the size for getFontSize; it draws nothing, and
        // desktop raises no sysFontChangeEvent for one.
        const buf = this.buffers.get(win);
        if (buf) {
            buf.fontSize = whole;
            return true;
        }
        return this.withFontChangeEvent(win, () => this.session.windows.setFontSize(win, whole));
    }

    /**
     * Desktop's `TConsole::raiseFontChangeEvent`: `sysFontChangeEvent(console,
     * family, size)`, raised whenever a console's font really changes — a new
     * miniconsole or user window taking its first font, and every setFont /
     * setFontSize that lands on something different. Layout code listens for
     * it to reflow. Main's is raised by the engine, which watches the profile
     * font whatever changed it.
     */
    raiseFontChangeEvent(name: string): void {
        this.host.raiseEvent('sysFontChangeEvent', [name, this.getFont(name) ?? '', this.getFontSize(name) ?? 0]);
    }

    /** Run a font write against a console and raise sysFontChangeEvent if it
     *  changed what the console is drawn in. Only consoles raise it on desktop
     *  (not labels, maps or buffers), and a write that lands on the font already
     *  in use raises nothing — TConsole::setFont compares before it applies. */
    private withFontChangeEvent(win: string, apply: () => boolean): boolean {
        if (!this.session.windows.isTextWindow(win)) return apply();
        const fontOf = () => `${this.getFont(win)}\u0000${this.getFontSize(win)}`;
        const before = fontOf();
        const ok = apply();
        if (ok && fontOf() !== before) this.raiseFontChangeEvent(win);
        return ok;
    }

    /**
     * Mudlet setMiniConsoleFontSize. Desktop registers it as another name for
     * setFontSize, so it reaches every console setFontSize does — main
     * included, and main when no name is given (mudlet-web#380).
     */
    setMiniConsoleFontSize(name: string | undefined, size: number): boolean {
        return this.setFontSize(size, name);
    }

    /**
     * Mudlet getFontSize. Returns the configured font size in pixels for the
     * main window (when no name passed) or for a specific window. Returns null
     * if a named window doesn't exist or has no override.
     */
    getFontSize(win?: string): number | null {
        if (!win || win === 'main') return selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize');
        const buf = this.buffers.get(win);
        if (buf) return buf.fontSize ?? selectProfileField(useAppStore.getState(), this.connectionId, 'fontSize');
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
            // Through the labels API, not the manager directly: it keeps the
            // authored copy of the label's stylesheet in step with the
            // background-color declaration the manager patches.
            return this.labels.setBackgroundColor(name, r, g, b, a);
        }
        const buf = this.buffers.get(name);
        if (buf) {
            buf.background = { r, g, b, a };
            return true;
        }
        return this.session.windows.setBackgroundColor(name, r, g, b, a);
    }

    /**
     * Mudlet getBackgroundColor. Without a name (or "main") returns the main
     * window background; otherwise looks up the named window/miniconsole. Labels
     * fall through here too — their fill color is reported. Returns null when
     * the name doesn't resolve to anything; callers (Lua wrapper) translate that
     * to a 4-tuple of zeros.
     *
     * The main window answers from the *preference* when no script has set a
     * colour, not from nothing. `outputBackgroundColor` is only the override
     * `setBackgroundColor()` writes; returning null without it meant the Lua
     * wrapper substituted black, so a package colouring its Geyser UI to match
     * the user's background — a very common pattern — rendered against black
     * whatever the user had chosen (issue #71). Desktop reads the
     * preference-backed model colour for the main window and says why:
     * "the view's colour is a reference to this one, so read it straight from
     * the model" (TLuaInterpreterUI.cpp:1217-1243).
     */
    getBackgroundColor(name?: string): { r: number; g: number; b: number; a: number } | null {
        if (!name || name === 'main') {
            const override = selectProfileField(useAppStore.getState(), this.connectionId, 'outputBackgroundColor');
            if (override) return override;
            // Same precedence the renderer itself draws with, so the answer
            // matches what is on screen rather than a second opinion about it.
            const [r, g, b] = this.defaultColorRgb('background');
            // The preference is a hex colour and carries no alpha; the main
            // console is opaque, which is the alpha setBackgroundColor defaults to.
            return { r, g, b, a: 255 };
        }
        if (this.session.labels.has(name)) {
            return this.session.labels.getBackgroundColor(name);
        }
        const buf = this.buffers.get(name);
        if (buf) return { ...buf.background };
        return this.session.windows.getBackgroundColor(name);
    }

    /**
     * Mudlet `setBackgroundImage`. Dispatcher across labels, miniconsoles /
     * userwindows, and the main window — matches Mudlet's overload set:
     *
     *   setBackgroundImage(imageLocation, [mode])              → main console
     *   setBackgroundImage(name, imageLocation, [mode])        → label, or
     *                                                            miniconsole / userwindow
     *
     * Routing follows Host::setBackgroundImage: "main" is the main console, a
     * label name wins next whatever the argument count (a label takes no mode
     * and ignores the one it is given), and anything else is a sub-console.
     * `mode` arrives already coerced to a number by the GUIUtils.lua wrapper
     * (string mode like "center" → 2 via `mudlet.BgImageMode`). For the label
     * form `imageLocation` is a VFS path, resolved through the same rewriter
     * that powers setLabelStyleSheet so package-bundled images work without
     * scripts knowing about the vfs:// scheme.
     *
     * Returns true, or desktop's refusal message — one wording for a name
     * nothing answers to and for a label image that cannot be loaded, since
     * TLuaInterpreter::setBackgroundImage only learns that one of them failed.
     */
    setBackgroundImage(a: string, b?: string | number, c?: number): true | string {
        // 1 arg, or (path, mode): the main window, default border (mode 1).
        if (b === undefined) return this.applyBackgroundImage(undefined, a, 1);
        if (typeof b === 'number') return this.applyBackgroundImage(undefined, a, b);
        // (name, path[, mode]).
        const mode = c === undefined ? 1 : Number(c) || 1;
        if (a === 'main') return this.applyBackgroundImage(undefined, b, mode);
        const refused = `console or label '${a}' not found, or '${b}' could not be loaded as an image`;
        if (this.session.labels.has(a)) {
            // TLabel::setBackgroundImage keeps what the label shows when the
            // file is not an image at all, and the caller is told.
            if (!this.labelImageLoads(b)) return refused;
            return this.applyLabelBackgroundImage(a, b) ? true : refused;
        }
        if (this.session.windows.has(a)) {
            return this.session.windows.setBackgroundImage(a, this.resolveImageUrl(b), mode) ? true : refused;
        }
        return refused;
    }

    /** Whether a label could load `path` as an image, as far as can be told
     *  now: a vendored Qt resource, a profile file whose content is an SVG or a
     *  raster format Qt reads (QPixmap judges by content, not by name), or a
     *  remote / inline URL — which cannot be judged synchronously and is taken
     *  on trust. */
    private labelImageLoads(path: string): boolean {
        if (isQtResourcePath(path)) return qtResourceUrl(path) !== null;
        if (/^(?:https?|data|blob):/i.test(path)) return true;
        let bytes: Uint8Array | null;
        try { bytes = this.host.readFileBytes(path); } catch { bytes = null; }
        return !!bytes && looksLikeImage(bytes);
    }

    /**
     * Mudlet `resetBackgroundImage([windowName])`. Without a name (or "main")
     * clears the main window background image; otherwise looks up the named
     * label or window and clears its image. Returns true on success.
     */
    resetBackgroundImage(name?: string, fullWindow = false): true | string {
        // The FULL WINDOW background belongs to the profile, so only the main
        // console has one to reset. Asking a miniconsole for it is a mistake
        // rather than a no-op, and saying so is the only way a caller learns
        // that the console they named has just its own background.
        if (fullWindow && name && name !== 'main') {
            return 'the full window background can only be reset on the main console';
        }
        if (!name || name === 'main') {
            useAppStore.getState().patchConnectionProfile(this.connectionId, { outputBackgroundImage: undefined });
            return true;
        }
        if (this.session.labels.has(name)) {
            return this.session.labels.resetBackgroundImage(name) ? true : `console '${name}' not found`;
        }
        return this.session.windows.resetBackgroundImage(name) ? true : `console '${name}' not found`;
    }

    /**
     * Mudlet `setLabelCustomCursor(labelName, cursorPath, [hotX, hotY])`. Points
     * the label's mouse cursor at a custom image. The path is run through the
     * VFS-aware URL resolver (same as setBackgroundImage) so package-relative
     * paths resolve, then composed into a CSS `cursor: url(...) hotX hotY, auto`
     * value. hotX/hotY are the cursor hotspot in pixels (default 0,0). Returns
     * false when the label doesn't exist.
     */
    /** Mudlet `setLabelCustomCursor(name, path [, hotX, hotY])`. True when the
     *  cursor is set, else the refusal in TMainConsole::setLabelCustomCursor's
     *  words and order: the empty name, the empty location, then — for a label
     *  that exists — an image it cannot load; a missing label last. */
    setLabelCustomCursor(name: string, path: string, hotX?: number, hotY?: number): true | string {
        if (!name) return 'a label cannot have an empty string as its name';
        if (!path) return 'custom cursor location cannot be an empty string';
        if (!this.session.labels.has(name)) return `label name '${name}' not found`;
        if (!this.canLoadImage(path)) return `couldn't find custom cursor, is the location "${path}" correct?`;
        const url = this.resolveImageUrl(path);
        const x = Number.isFinite(hotX) ? Math.max(0, Math.round(hotX as number)) : 0;
        const y = Number.isFinite(hotY) ? Math.max(0, Math.round(hotY as number)) : 0;
        const escaped = url.replace(/[\\"]/g, '\\$&');
        this.session.labels.setCursor(name, `url("${escaped}") ${x} ${y}, auto`);
        return true;
    }

    /** Whether an image path names something there to load, as far as can be
     *  told now: a vendored Qt resource, or a profile file that exists. A
     *  remote or inline URL cannot be judged synchronously and is taken on
     *  trust. */
    private canLoadImage(path: string): boolean {
        if (isQtResourcePath(path)) return qtResourceUrl(path) !== null;
        if (/^(?:https?|data|blob):/i.test(path)) return true;
        try { return this.host.readFileBytes(path) !== null; } catch { return false; }
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
        // A profile file is read here and now, the way TLabel sniffs it: by its
        // content, not its name. That both decides whether it is drawn as an
        // SVG layer and hands getLabelSizeHint() the document's size in the same
        // chunk — a script sizing a label to its SVG asks straight after
        // setting it. A remote URL can only be judged by its name, and sized
        // once it has been fetched.
        let bytes: Uint8Array | null = null;
        if (!isQtResourcePath(path)) {
            try { bytes = this.host.readFileBytes(path); } catch { bytes = null; }
        }
        const svg = bytes ? isSvgCandidate(bytes) : isSvgUrl(url);
        const size = bytes && svg ? svgIntrinsicSizeFromBytes(bytes) ?? undefined : undefined;
        const ok = this.session.labels.setBackgroundImage(name, url, svg, size);
        if (ok && svg && !size) {
            resolveSvgIntrinsicSize(url).then(size => {
                if (size) this.session.labels.setBackgroundImageSize(name, url, size.width, size.height);
            });
        }
        return ok;
    }

    private applyBackgroundImage(_target: undefined, path: string, mode: number): true {
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
    // and truncated to whole pixels; non-finite input is rejected. Reads/writes the active
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
     *  plus per-subsystem counts, under Mudlet's own snake_case key names — the
     *  table is read by key, so a browser-flavoured spelling would just make
     *  every existing diagnostic script read nil.
     *
     *  Browser-adapted where the C++ figure has no equivalent: the heap sizes
     *  come from `performance.memory` (Chromium only, and left out entirely
     *  elsewhere, as Mudlet leaves them out on a platform whose allocator it
     *  cannot ask); `heap_limit_mb` and `loaded_fonts` are browser-only extras.
     *  `event_handlers` is absent: Other.lua keeps its handler registry in a
     *  local upvalue, with no reachable count. The Lua GC figures
     *  (`lua_heap_kb`/`lua_heap_mb`) are added by the Bridge.lua wrapper.
     *  Counts are best-effort snapshots. */
    getSubsystemMemoryStats(): Record<string, number> {
        const mem = (performance as unknown as {
            memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
        }).memory;
        const map = this.map;
        const stats = this.host.getProfileStats() as Record<string, { total?: number; temp?: number } | undefined>;
        const family = (name: string, field: 'total' | 'temp') => stats[name]?.[field] ?? 0;
        // Mudlet's buffer keeps an always-open line past the last line feed;
        // getLineCount() leaves that one out, and this count takes it in. A
        // missing console reports -1, which must not become 0 lines.
        const lines = this.getLineCount();
        const kBytesPerMb = 1024 * 1024;
        return {
            triggers_total: family('triggers', 'total'),
            triggers_temp: family('triggers', 'temp'),
            timers_total: family('timers', 'total'),
            timers_temp: family('timers', 'temp'),
            aliases_total: family('aliases', 'total'),
            aliases_temp: family('aliases', 'temp'),
            map_rooms: Object.keys(map.getRooms()).length,
            map_areas: Object.keys(map.getAreaTable()).length,
            console_buffer_lines: lines < 0 ? 0 : lines + 1,
            media_sound_players: this.session.sounds.getPlaying().length,
            media_music_players: this.session.sounds.getPlaying({}, 'music').length,
            // Mudlet counts the players it keeps pooled but idle. Nothing is
            // pooled here, so the nearest live thing is media that exists and
            // is not playing: a paused video element.
            media_stopped_players: this.session.videos.getByState(true).length,
            ...(mem ? {
                heap_in_use_mb: mem.usedJSHeapSize / kBytesPerMb,
                heap_allocated_mb: mem.totalJSHeapSize / kBytesPerMb,
                heap_limit_mb: mem.jsHeapSizeLimit / kBytesPerMb,
            } : {}),
            loaded_fonts: (typeof document !== 'undefined' && document.fonts) ? document.fonts.size : 0,
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
        // The console inside the new borders reports its grid first.
        this.session.windows.applyMainBorders();
        // Host::setBorders raises sysWindowResizeEvent at the unchanged window
        // size whenever a border moves: the console inside it did resize, and
        // Adjustable.Container's resize handler is how a container attached to
        // the facing border re-measures (or detaches) before that border is
        // written. Borders carve insets out of the viewport without resizing it,
        // so the viewport's ResizeObserver never reports this one.
        // Its width/height are what is left inside the new borders, as Mudlet's
        // are (see WindowManager.mainResizeEventArgs).
        const [w, h] = this.getMainWindowSize();
        this.host.raiseEvent('sysWindowResizeEvent', this.session.windows.mainResizeEventArgs(w, h));
    }

    private normalizeBorder(n: unknown): number | null {
        const num = Number(n);
        if (!Number.isFinite(num)) return null;
        // getVerifiedInt drops the fraction rather than rounding: 194.8 is 194.
        return Math.max(0, Math.trunc(num));
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
        // A buffer keeps the family for getFont; it draws nothing, and desktop
        // raises no sysFontChangeEvent for one.
        const buf = this.buffers.get(win);
        if (buf) {
            buf.fontFamily = fam || null;
            return true;
        }
        // Labels are not in the window registry — they are overlay widgets with
        // their own manager — so a label was the one window kind setFont could
        // not reach at all, and Geyser.Label:setFont took its "Qt will pick
        // something close" branch on every call. Fall through to them rather
        // than reporting the name as unknown.
        return this.withFontChangeEvent(win, () => this.session.windows.setFont(win, fam))
            || this.labels.setFont(win, fam);
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
        const buf = this.buffers.get(win);
        if (buf) return buf.fontFamily ?? configured();
        if (!this.session.windows.has(win)) {
            // A label, or nothing at all. Its own font when it has one; the
            // profile font when it does not, matching what a window with no
            // override answers rather than handing back "".
            const label = this.labels.getFont(win);
            if (label === null) return null;
            return label || configured();
        }
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
     *
     * Whole pixels, like the `QSize` Mudlet builds out of
     * `QFontMetrics::averageCharWidth()` and `::height()` — and unlike the
     * fractional cell {@link measureMonospaceCell} hands this client's own
     * column arithmetic. The rounding is what makes the number multipliable:
     * every caller of this one is a script scaling it back up into a widget
     * size (Geyser resolves a `"20c"` constraint as `20 * calcFontSize(...)`,
     * GUIUtils sizes a `createConsole` the same way), and widget geometry is
     * whole pixels in Mudlet and here alike. A fractional cell makes that
     * product land between pixels, where it is truncated — so the size a script
     * computed and the size `getWindowGeometry` reports back silently disagree,
     * by an amount that depends on which fonts the machine happens to have.
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
        const [width, height] = measureMonospaceCell(family, size);
        // qRound, which is what QFontMetrics::averageCharWidth() applies to the
        // fractional advance — so the answer matches Mudlet's for a given font.
        return [Math.round(width), Math.round(height)];
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

    /**
     * The installed family a requested font name means, or null if none does.
     *
     * Mudlet hands the name to QFont, which resolves it three ways before
     * giving up, and scripts depend on all three: the exact family, the same
     * family in any casing, and a "Family Style" name whose trailing style word
     * is a weight/slant request rather than part of the family — "Ubuntu Mono
     * Bold" is Ubuntu Mono asked for in bold, not a family of that name. The
     * answer is always spelled the way the font database spells it, because
     * callers read it straight back (Geyser.Label:setFont stores getFont()'s
     * reply so what it remembers and what the widget got cannot drift).
     *
     * Only weight and slant words are trimmed, never width ones: Qt keeps width
     * in the family name ("Arial Narrow" is its own family), so trimming those
     * would resolve a name to a font the caller did not ask for. A trailing word
     * that is not a style word stops the trim outright, so "Arial Nonsense"
     * fails rather than quietly becoming Arial.
     */
    resolveFontFamily(name: string): string | null {
        const wanted = (name ?? '').trim();
        if (!wanted) return null;
        const installed = this.getAvailableFonts();
        if (installed[wanted]) return wanted;

        const byLowerName = new Map<string, string>();
        for (const family of Object.keys(installed)) byLowerName.set(family.toLowerCase(), family);
        const insensitive = byLowerName.get(wanted.toLowerCase());
        if (insensitive) return insensitive;

        // Right to left, because a style can be several words ("Bold Italic").
        const words = wanted.split(/\s+/);
        for (let end = words.length - 1; end > 0; end--) {
            if (!FONT_STYLE_WORDS.has(words[end].toLowerCase())) break;
            const base = byLowerName.get(words.slice(0, end).join(' ').toLowerCase());
            if (base) return base;
        }
        return null;
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

    /** Mudlet `Host::postMessage`. Writes a client message onto the main
     *  console whatever the profile's error-echo preference — this is the
     *  client telling the player something about the line in front of them,
     *  not a script's error. */
    postSystemMessage(text: string): void {
        // Through the echo path rather than a bare `message` event: nothing
        // appends those to the console's own buffer, so getLines and every
        // other buffer reader would never see a message posted that way. Inside
        // trigger processing this lands on the line being processed, which is
        // the line the message is about.
        this.echo(`${text}\n`);
    }

    /**
     * A notice for the player in the main window — not a script fault, so not
     * printError, which only reaches main when the profile asked for errors
     * there and would be missed by exactly the person who needs it.
     *
     * Written to the buffer as well as emitted, for the reason
     * warnIfUnencodable gives: a line the player can read has to be a line
     * getLines() and the cursor APIs can see.
     */
    /** Held installs wait on the save's flush; see ScriptingEngine. */
    markProfileSaveInFlight(): void {
        this.host.markProfileSaveInFlight();
    }

    postInfo(text: string): void {
        const notice = `\x1b[36m[ INFO ]\x1b[0m  - ${text}`;
        this.mainConsole.appendLine(new AnsiAwareBuffer(notice));
        this.session.events.emit('message', notice, 'script', Date.now());
    }

    /** Mudlet's `Host::postMessage` for the `[ ERROR ]` kind: unlike printError
     *  this is client news rather than a script's own fault, so it goes on the
     *  main console whether or not the profile shows script errors there. */
    postError(text: string): void {
        const notice = `\x1b[31m[ ERROR ]\x1b[0m - ${text}`;
        this.mainConsole.appendLine(new AnsiAwareBuffer(notice));
        this.session.events.emit('message', notice, 'error', Date.now());
    }

    printError(text: string, source?: ScriptLogSource): void {
        this.session.events.emit('script.log', text, 'error', source);
        if (this.showErrorsInMainWindow) {
            this.session.events.emit('message', text, 'error', Date.now());
        }
    }

    destroy(): void {
        this.destroyed = true;
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
    /** Whether `name` is a console a script can write to (see {@link consoleExists}). */
    hasConsole(name: string): boolean {
        return this.consoleExists(name);
    }

    private consoleExists(windowName: string | undefined): boolean {
        if (!windowName || windowName === 'main') return true;
        return this.session.windows.has(windowName) || this.buffers.has(windowName);
    }

    /**
     * The Console a write to `win` goes to, or null when `win` names no console
     * at all. Mudlet resolves the name and answers a miss with "window not
     * found" (or, for echo, "console/label does not exist") without creating
     * anything; going through {@link outputConsole} instead conjured a hidden
     * console out of the typo, which then showed up as a "userwindow" and
     * handed its stray text to whatever window was later created under that
     * name (mudlet-web#280).
     */
    private penConsole(win?: string): Console | null {
        return this.consoleExists(win) ? this.outputConsole(win) : null;
    }

    /** Returns the Console for a window, creating and registering one on demand. */
    private outputConsole(win?: string): Console {
        if (!win || win === 'main') return this.mainConsole;
        let con = this.session.consoles.get(win);
        if (!con) {
            // Only the main console's cursor follows what is written to it; a
            // miniconsole's, user window's or buffer's stays where a script put
            // it — line 0 until then — as Mudlet's does.
            con = new Console({ followsOutput: false });
            // A console other than main starts with TChar's own default pen —
            // white on the default background (`TChar::TChar(nullptr)`) — not
            // the profile's colours, which only a resetFormat() puts in it.
            con.format.foreground = { space: 'rgb', r: 255, g: 255, b: 255 };
            // Mudlet raises sysBufferShrinkEvent for every console that trims,
            // not only the main one, and it names the window the lines went
            // from — a script mirroring a miniconsole's buffer has no other way
            // to hear that its saved indexes moved.
            const name = win;
            con.onBufferShrink = (n) => this.host.raiseEvent('sysBufferShrinkEvent', [name, n]);
            this.session.consoles.set(win, con);
            // The Console is made on first use, but a window can already carry
            // a width (setWindowWrap before any echo, or one restored with the
            // layout) that its stored lines have to follow from the first line.
            if (!this.buffers.has(win)) con.setWrapWidth(...this.wrapSettings(win, con));
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
        const committed = con.takeLines();
        for (const line of committed) {
            this.session.windows.pushBuffer(win, line);
        }
        // Mudlet raises sysWindowOverflowEvent from the same place: once per
        // append that added text, not once per line and not on a resize tick.
        // What it counts is `lineBuffer.size()`, which includes the line the
        // cursor sits on — one more than Lua's getLineCount(), and the reason
        // the console is full (rather than overflowing by nothing) at the
        // moment getLineCount() + 1 reaches the row count.
        if (committed.length > 0) {
            this.session.windows.noteLineOverflow(win, () => ({
                lineCount: this.getLineCount(win) + 1,
                rows: this.getRowCount(win),
            }));
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

    private selectionKey(win: string | undefined): string {
        return !win || win === 'main' ? 'main' : win;
    }

    /** The named console's own selection (main when omitted), or null. */
    private selectionOf(win: string | undefined): { windowName: string | undefined; start: number; length: number } | null {
        return this.selections.get(this.selectionKey(win)) ?? null;
    }

    private setSelection(win: string | undefined, start: number, length: number): void {
        this.selections.set(this.selectionKey(win), { windowName: win, start, length });
    }

    private clearSelection(win: string | undefined): void {
        this.selections.delete(this.selectionKey(win));
    }

    /**
     * The columns a selection covers on `buf`, read as TBuffer::applyFgColor
     * and the other apply* calls read P_begin/P_end: the end is cut at the end
     * of the line, and a selection starting at or past it covers nothing. A
     * selection outlives the text it was made on — replace() keeps it, and the
     * cursor can move to a shorter line — so it can run off the end.
     */
    private selectionSpan(sel: { start: number; length: number }, buf: AnsiAwareBuffer): [number, number] | null {
        if (sel.start < 0 || sel.start >= buf.length || sel.length <= 0) return null;
        return [sel.start, Math.min(sel.start + sel.length, buf.length)];
    }

    private applyStateToSelection(state: FormatStateSnapshot | null, win: string | undefined): void {
        const sel = this.selectionOf(win);
        if (!sel || !state) return;
        const buf = this.resolveBuffer(sel.windowName);
        if (!buf) return;
        const span = this.selectionSpan(sel, buf);
        if (span) buf.applyFormat(span, state);
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

/**
 * The whole point size a font-size argument names, or null when it names none.
 * Mudlet reads the argument with getVerifiedInt, which drops the fraction rather
 * than rounding — 11.5 and 11.9 are both 11 — and sets no ceiling on it.
 */
function fontSizePoints(size: number): number | null {
    if (!Number.isFinite(size)) return null;
    const whole = Math.trunc(size);
    return whole >= 1 ? whole : null;
}
