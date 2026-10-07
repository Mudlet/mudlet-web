import type { ProfileSettings, ProtocolSettings, BooleanProtocolKey } from '../storage/schema';
import { SERVER_WRAP_WIDTH_MIN, SERVER_WRAP_WIDTH_MAX } from '../mud/text/serverWrap';
import { MIN_CONSOLE_BUFFER_SIZE, MAX_CONSOLE_BUFFER_SIZE } from '../mud/text/Console';
import { parseMudletXml, type MudletImportResult } from './mudletXmlImport';
import { parseVariablePackageXml, type MudletVariablePackage } from './mudletVariables';
import type { SavedStopwatch } from '../scripting/StopwatchManager';

// Maps the `<HostPackage><Host>` block of a Mudlet profile XML onto Mudlet Web's
// ProfileSettings. This is the settings half of a full Mudlet-profile import —
// the automation half is parseMudletXml, the saved-variables half is
// parseVariablePackageXml. Only fields with a Mudlet Web home are mapped; the rest of
// Host (spell dictionary, profile shortcuts, Discord, MMCP, …) is ignored.

function childText(host: Element, tag: string): string | undefined {
    const el = host.querySelector(`:scope > ${tag}`);
    const t = el?.textContent?.trim();
    return t ? t : undefined;
}

/** Telnet protocol toggles live as `yes`/`no` attributes on the <Host> element. */
function attrBool(host: Element, attr: string): boolean | undefined {
    const v = host.getAttribute(attr);
    return v == null ? undefined : v === 'yes';
}

function attrNum(host: Element, attr: string): number | undefined {
    const v = host.getAttribute(attr);
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

// Mudlet color element name → ansiPalette index. Mudlet Web's palette is 0–7 dark
// (black,red,green,yellow,blue,magenta,cyan,white) then 8–15 bright; Mudlet
// names them mBlack/mLightBlack/… so the indices are interleaved relative to
// Mudlet's own document order.
const ANSI_COLOR_INDEX: ReadonlyArray<readonly [string, number]> = [
    ['mBlack', 0], ['mRed', 1], ['mGreen', 2], ['mYellow', 3],
    ['mBlue', 4], ['mMagenta', 5], ['mCyan', 6], ['mWhite', 7],
    ['mLightBlack', 8], ['mLightRed', 9], ['mLightGreen', 10], ['mLightYellow', 11],
    ['mLightBlue', 12], ['mLightMagenta', 13], ['mLightCyan', 14], ['mLightWhite', 15],
];

// Mudlet's `<Host mEnableX>` attribute → Mudlet Web ProtocolSettings field.
const PROTOCOL_ATTR: ReadonlyArray<readonly [string, BooleanProtocolKey]> = [
    ['mEnableGMCP', 'gmcp'], ['mEnableMSDP', 'msdp'], ['mEnableMSSP', 'mssp'],
    ['mEnableMSP', 'msp'], ['mEnableMTTS', 'mtts'], ['mEnableMNES', 'mnes'],
    ['mEnableMXP', 'mxp'], ['mEnableNAWS', 'naws'], ['mEnableCHARSET', 'charset'],
    ['mEnableNEWENVIRON', 'newEnviron'],
];

// Mudlet's `<Host>` yes/no attribute → key in ProfileSettings.config (the
// getConfig/setConfig bag), for the preferences that live there rather than in
// a field of their own. Attribute names from XMLexport.cpp's writeHost.
const CONFIG_BOOL_ATTR: ReadonlyArray<readonly [string, string]> = [
    ['USE_IRE_DRIVER_BUGFIX', 'fixUnnecessaryLinebreaks'],
    ['mUSE_FORCE_LF_AFTER_PROMPT', 'forceLfAfterPrompt'],
    ['mUSE_UNIX_EOL', 'inputLineStrictUnixEndings'],
    ['mFORCE_GA_OFF', 'specialForceGAOff'],
    ['CompactInputLine', 'compactInputLine'],
    ['f3SearchEnabled', 'f3SearchEnabled'],
];

// Host::CommandEchoMode, by its integer value (Never = 0, ScriptControl = 1,
// Always = 2) → the showSentText mode string.
const ECHO_MODES = ['never', 'script', 'always'] as const;

// The Q_ENUM key spellings XMLexport writes (valueToKey) ↔ Mudlet Web's mode strings.
const CARET_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
    ['None', 'none'], ['Tab', 'tab'], ['CtrlTab', 'ctrltab'], ['F6', 'f6'],
];
const BLANK_LINE_BEHAVIOURS: ReadonlyArray<readonly [string, string]> = [
    ['Show', 'show'], ['Hide', 'hide'], ['ReplaceWithSpace', 'replacewithspace'],
];

// `ControlCharacterHandling` is ControlCharacterMode's integer: AsIs = 0,
// Picture = 1, OEM = 2. Anything else reads as AsIs (XMLimport's default case).
const CONTROL_CHARACTER_MODES = ['asis', 'picture', 'oem'] as const;

/** The getConfig-bag preferences a `<Host>` carries. Empty when it has none. */
function parseHostConfig(host: Element): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const [attr, key] of CONFIG_BOOL_ATTR) {
        const v = attrBool(host, attr);
        if (v !== undefined) config[key] = v;
    }
    // Mudlet 4.19 made the echo a tri-state `commandEchoMode`; older saves only
    // have the boolean `printCommand`, which XMLimport reads as script control
    // (yes) or never (no). Out-of-range integers are clamped, as there.
    const echoMode = attrNum(host, 'commandEchoMode');
    if (echoMode !== undefined) {
        config.showSentText = ECHO_MODES[Math.min(2, Math.max(0, Math.trunc(echoMode)))];
    } else {
        const printCommand = attrBool(host, 'printCommand');
        if (printCommand !== undefined) config.showSentText = printCommand ? 'script' : 'never';
    }
    const historySize = attrNum(host, 'CommandLineHistorySaveSize');
    if (historySize !== undefined) config.commandLineHistorySaveSize = Math.trunc(historySize);
    const caret = host.getAttribute('caretShortcut');
    const caretMode = CARET_SHORTCUTS.find(([xml]) => xml === caret)?.[1];
    if (caretMode) config.caretShortcut = caretMode;
    const blank = host.getAttribute('blankLineBehaviour');
    const blankMode = BLANK_LINE_BEHAVIOURS.find(([xml]) => xml === blank)?.[1];
    if (blankMode) config.blankLinesBehaviour = blankMode;
    // Absent means AsIs too (the default up to Mudlet 4.14.1, when it arrived),
    // but only a present attribute is recorded, so a merge keeps what was there.
    const control = attrNum(host, 'ControlCharacterHandling');
    if (control !== undefined) config.controlCharacterHandling = CONTROL_CHARACTER_MODES[control] ?? 'asis';
    return config;
}

/** The inverse of {@link parseHostConfig}: write whichever of those
 *  preferences `config` holds back onto the `<Host>`. */
function applyHostConfig(host: Element, config: Record<string, unknown>): void {
    for (const [attr, key] of CONFIG_BOOL_ATTR) {
        const v = config[key];
        if (typeof v === 'boolean') host.setAttribute(attr, v ? 'yes' : 'no');
    }
    // A legacy boolean in the bag (false ≙ never, true ≙ script), as SettingsModal reads it.
    const echo = config.showSentText;
    const mode = echo === false ? 'never' : echo === true ? 'script' : echo;
    const echoIndex = ECHO_MODES.indexOf(mode as typeof ECHO_MODES[number]);
    if (echoIndex >= 0) {
        // Both, as XMLexport writes them: the tri-state for Mudlet 4.19 and up,
        // the boolean for anything older.
        host.setAttribute('commandEchoMode', String(echoIndex));
        host.setAttribute('printCommand', echoIndex === 0 ? 'no' : 'yes');
    }
    const size = config.commandLineHistorySaveSize;
    if (typeof size === 'number' && Number.isFinite(size)) host.setAttribute('CommandLineHistorySaveSize', String(Math.trunc(size)));
    const caret = CARET_SHORTCUTS.find(([, web]) => web === config.caretShortcut)?.[0];
    if (caret) host.setAttribute('caretShortcut', caret);
    const blank = BLANK_LINE_BEHAVIOURS.find(([, web]) => web === config.blankLinesBehaviour)?.[0];
    if (blank) host.setAttribute('blankLineBehaviour', blank);
    const control = CONTROL_CHARACTER_MODES.indexOf(config.controlCharacterHandling as typeof CONTROL_CHARACTER_MODES[number]);
    // XMLexport leaves the attribute out for AsIs, the default.
    if (control > 0) host.setAttribute('ControlCharacterHandling', String(control));
    else if (control === 0) host.removeAttribute('ControlCharacterHandling');
}

// Mudlet's mDisplayFont is "Family,pointSize,…" (a serialized QFont). We only
// want the family and size.
function parseFontSpec(spec: string): { family?: string; size?: number } {
    const parts = spec.split(',');
    const family = parts[0]?.trim() || undefined;
    const size = parts[1] !== undefined ? Number(parts[1]) : undefined;
    return { family, size: Number.isFinite(size as number) ? size : undefined };
}

/**
 * Map a `<Host>` element to a partial ProfileSettings. Only keys actually
 * present in the XML are set, so the result can be merged over existing/default
 * settings without clobbering anything Mudlet didn't specify.
 */
export function parseMudletHost(host: Element): Partial<ProfileSettings> {
    const out: Partial<ProfileSettings> = {};

    // ── command line / wrap ──────────────────────────────────────────────
    const sep = childText(host, 'mCommandSeparator');
    if (sep !== undefined) out.commandSeparator = sep;
    const autoClear = attrBool(host, 'autoClearCommandLineAfterSend');
    if (autoClear !== undefined) out.autoClearInput = autoClear;
    const wrapAt = childText(host, 'wrapAt');
    if (wrapAt !== undefined && Number.isFinite(Number(wrapAt))) out.outputWrapAt = Number(wrapAt);
    const wrapIndent = childText(host, 'wrapIndentCount');
    if (wrapIndent !== undefined && Number.isFinite(Number(wrapIndent))) out.outputWrapIndent = Number(wrapIndent);
    const wrapHanging = childText(host, 'wrapHangingIndentCount');
    if (wrapHanging !== undefined && Number.isFinite(Number(wrapHanging))) out.outputWrapHangingIndent = Number(wrapHanging);

    // ── colors ───────────────────────────────────────────────────────────
    const fg = childText(host, 'mFgColor');
    if (fg) out.outputForeground = fg;
    const bg = childText(host, 'mBgColor');
    if (bg) out.outputBackground = bg;
    const cmdFg = childText(host, 'mCommandFgColor');
    if (cmdFg) out.commandEchoForeground = cmdFg;
    const cmdBg = childText(host, 'mCommandBgColor');
    if (cmdBg) out.commandEchoBackground = cmdBg;
    const inputFg = childText(host, 'mCommandLineFgColor');
    if (inputFg) out.inputForeground = inputFg;
    const inputBg = childText(host, 'mCommandLineBgColor');
    if (inputBg) out.inputBackground = inputBg;

    const palette: (string | undefined)[] = new Array(16);
    let anyColor = false;
    for (const [name, idx] of ANSI_COLOR_INDEX) {
        const c = childText(host, name);
        if (c) { palette[idx] = c; anyColor = true; }
    }
    if (anyColor) out.ansiPalette = palette;

    const redefine = attrBool(host, 'mServerMayRedefineColors');
    if (redefine !== undefined) out.serverRedefineColors = redefine;
    const osc8 = attrBool(host, 'enableOSC8Hyperlinks');
    if (osc8 !== undefined) out.osc8Hyperlinks = osc8;

    // ── undo the game's own wrapping (Mudlet 5.0) ────────────────────────
    const undoWrap = attrBool(host, 'mUndoServerWrap');
    if (undoWrap !== undefined) out.undoServerWrap = undoWrap;
    // Mudlet clamps rather than rejects on read (XMLimport: qBound(20, …, 500)),
    // so a profile hand-edited out of range still loads — matched here so the
    // same file produces the same setting in both clients.
    const undoWrapWidthText = childText(host, 'undoServerWrapWidth');
    const undoWrapWidth = undoWrapWidthText !== undefined ? Number(undoWrapWidthText) : NaN;
    if (Number.isFinite(undoWrapWidth)) {
        out.undoServerWrapWidth = Math.min(
            SERVER_WRAP_WIDTH_MAX,
            Math.max(SERVER_WRAP_WIDTH_MIN, Math.trunc(undoWrapWidth)),
        );
    }

    // ── main display size (Mudlet 5.0) ───────────────────────────────────
    // XMLimport.cpp:1148-1150. Clamped to the bounds TBuffer::setBufferSize
    // would apply anyway, so a hand-edited profile loads the same in both.
    const bufferSizeText = childText(host, 'consoleBufferSize');
    const bufferSize = bufferSizeText !== undefined ? Number(bufferSizeText) : NaN;
    if (Number.isFinite(bufferSize)) {
        out.consoleBufferSize = Math.min(
            MAX_CONSOLE_BUFFER_SIZE,
            Math.max(MIN_CONSOLE_BUFFER_SIZE, Math.trunc(bufferSize)),
        );
    }
    const useMaxBuffer = childText(host, 'useMaxConsoleBufferSize');
    if (useMaxBuffer !== undefined) out.useMaxConsoleBufferSize = useMaxBuffer.trim() === 'yes';

    // ── borders ──────────────────────────────────────────────────────────
    const top = Number(childText(host, 'borderTopHeight') ?? '');
    const bottom = Number(childText(host, 'borderBottomHeight') ?? '');
    const left = Number(childText(host, 'borderLeftWidth') ?? '');
    const right = Number(childText(host, 'borderRightWidth') ?? '');
    if ([top, bottom, left, right].some(n => Number.isFinite(n) && n > 0)) {
        out.outputBorders = {
            top: Number.isFinite(top) ? top : 0,
            bottom: Number.isFinite(bottom) ? bottom : 0,
            left: Number.isFinite(left) ? left : 0,
            right: Number.isFinite(right) ? right : 0,
        };
    }

    // ── font ─────────────────────────────────────────────────────────────
    const fontSpec = childText(host, 'mDisplayFont');
    if (fontSpec) {
        const { family, size } = parseFontSpec(fontSpec);
        if (family) out.outputFont = { kind: 'system', family };
        if (size !== undefined) out.fontSize = size;
    }

    // ── network / prompt ─────────────────────────────────────────────────
    const timeout = attrNum(host, 'NetworkPacketTimeout');
    if (timeout !== undefined) out.promptTimeoutMs = timeout;

    // ── protocols ────────────────────────────────────────────────────────
    const protocols: ProtocolSettings = {};
    let anyProtocol = false;
    for (const [attr, key] of PROTOCOL_ATTR) {
        const v = attrBool(host, attr);
        if (v !== undefined) { protocols[key] = v; anyProtocol = true; }
    }
    if (anyProtocol) out.protocols = protocols;

    // ── preferences kept in the getConfig bag ────────────────────────────
    const config = parseHostConfig(host);
    if (Object.keys(config).length) out.config = config;

    return out;
}

/** The connection identity a Mudlet `<Host>` carries: the profile name and the
 *  MUD address (`<url>` host + `<port>`). Used to seed a new Mudlet Web connection. */
export interface MudletProfileIdentity {
    name?: string;
    host?: string;
    port?: number;
    /** `mSslTsl` — connect over TLS. The profile's `ssl_tsl` file, when it has
     *  one, is fresher (see buildMudletProfileBundle). */
    tls?: boolean;
    sslIgnoreExpired?: boolean;
    sslIgnoreSelfSigned?: boolean;
    sslIgnoreAll?: boolean;
}

/** Read `<name>`/`<url>`/`<port>` (direct children of `<Host>`) and the TLS
 *  attributes. */
export function parseMudletHostIdentity(host: Element): MudletProfileIdentity {
    const out: MudletProfileIdentity = {};
    const name = childText(host, 'name');
    if (name) out.name = name;
    const url = childText(host, 'url');
    if (url) out.host = url;
    const port = childText(host, 'port');
    if (port !== undefined && Number.isFinite(Number(port))) out.port = Number(port);
    const tls = attrBool(host, 'mSslTsl');
    if (tls !== undefined) out.tls = tls;
    const ignoreExpired = attrBool(host, 'mSslIgnoreExpired');
    if (ignoreExpired !== undefined) out.sslIgnoreExpired = ignoreExpired;
    const ignoreSelfSigned = attrBool(host, 'mSslIgnoreSelfSigned');
    if (ignoreSelfSigned !== undefined) out.sslIgnoreSelfSigned = ignoreSelfSigned;
    const ignoreAll = attrBool(host, 'mSslIgnoreAll');
    if (ignoreAll !== undefined) out.sslIgnoreAll = ignoreAll;
    return out;
}

// ── write-back (inverse of parseMudletHost) ──────────────────────────────────

/** What Mudlet's own exporter puts above `<MudletPackage>`, reproduced so a file
 *  written here is byte-shaped like one written there. Nothing reads it —
 *  Mudlet's QXmlStreamReader ignores the doctype — but dropping it would make
 *  Mudlet Web's saves gratuitously different. */
export const MUDLET_XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE MudletPackage>';

/** A Mudlet profile save has no namespace. `createElement` on a document some
 *  DOM implementations still consider HTML stamps `xmlns="…/xhtml"` onto every
 *  element we add, so create them namespace-less explicitly. */
function newHostEl(host: Element, tag: string): Element {
    return host.ownerDocument.createElementNS(null, tag);
}

function setHostEl(host: Element, tag: string, value: string): void {
    let el = host.querySelector(`:scope > ${tag}`);
    if (!el) {
        el = newHostEl(host, tag);
        host.appendChild(el);
    }
    el.textContent = value;
}

// Mudlet's mDisplayFont is a serialized QFont: "family,pointSize,<tail>". Mudlet Web
// only models the family + size, so on write-back we replace those two fields and
// keep the rest of the spec from the existing value (Mudlet's defaults when the
// Host has none) rather than guessing the ~17 QFont params.
const DEFAULT_QFONT_TAIL = ['-1', '5', '400', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1', '', '0', '0'];

/**
 * Write the modeled ProfileSettings back onto an existing `<Host>` element,
 * in place — only the fields present in `s` are touched, so unmodeled Host
 * fields (and the whole rest of the profile) are preserved. The inverse of
 * {@link parseMudletHost}. The display-font family is only written for a *system*
 * font (Mudlet can't resolve a url/vfs font name); the size is always synced, and
 * the rest of the QFont spec is preserved.
 */
export function applyProfileSettingsToHost(host: Element, s: Partial<ProfileSettings>): void {
    if (s.commandSeparator !== undefined) setHostEl(host, 'mCommandSeparator', s.commandSeparator);
    if (s.autoClearInput !== undefined) host.setAttribute('autoClearCommandLineAfterSend', s.autoClearInput ? 'yes' : 'no');
    if (s.outputWrapAt !== undefined) setHostEl(host, 'wrapAt', String(s.outputWrapAt));
    if (s.outputWrapIndent !== undefined) setHostEl(host, 'wrapIndentCount', String(s.outputWrapIndent));
    if (s.outputWrapHangingIndent !== undefined) setHostEl(host, 'wrapHangingIndentCount', String(s.outputWrapHangingIndent));
    if (s.outputForeground) setHostEl(host, 'mFgColor', s.outputForeground);
    if (s.outputBackground) setHostEl(host, 'mBgColor', s.outputBackground);
    if (s.commandEchoForeground) setHostEl(host, 'mCommandFgColor', s.commandEchoForeground);
    if (s.commandEchoBackground) setHostEl(host, 'mCommandBgColor', s.commandEchoBackground);
    if (s.inputForeground) setHostEl(host, 'mCommandLineFgColor', s.inputForeground);
    if (s.inputBackground) setHostEl(host, 'mCommandLineBgColor', s.inputBackground);
    if (s.serverRedefineColors !== undefined) host.setAttribute('mServerMayRedefineColors', s.serverRedefineColors ? 'yes' : 'no');
    if (s.osc8Hyperlinks !== undefined) host.setAttribute('enableOSC8Hyperlinks', s.osc8Hyperlinks ? 'yes' : 'no');
    if (s.undoServerWrap !== undefined) host.setAttribute('mUndoServerWrap', s.undoServerWrap ? 'yes' : 'no');
    if (s.undoServerWrapWidth !== undefined) setHostEl(host, 'undoServerWrapWidth', String(s.undoServerWrapWidth));
    if (s.promptTimeoutMs !== undefined) host.setAttribute('NetworkPacketTimeout', String(s.promptTimeoutMs));
    // XMLexport.cpp:617-618.
    if (s.consoleBufferSize !== undefined) setHostEl(host, 'consoleBufferSize', String(s.consoleBufferSize));
    if (s.useMaxConsoleBufferSize !== undefined) setHostEl(host, 'useMaxConsoleBufferSize', s.useMaxConsoleBufferSize ? 'yes' : 'no');
    if (s.config) applyHostConfig(host, s.config);

    if (s.ansiPalette) {
        for (const [name, idx] of ANSI_COLOR_INDEX) {
            const c = s.ansiPalette[idx];
            if (c) setHostEl(host, name, c);
        }
    }
    if (s.outputBorders) {
        setHostEl(host, 'borderTopHeight', String(s.outputBorders.top));
        setHostEl(host, 'borderBottomHeight', String(s.outputBorders.bottom));
        setHostEl(host, 'borderLeftWidth', String(s.outputBorders.left));
        setHostEl(host, 'borderRightWidth', String(s.outputBorders.right));
    }
    if (s.protocols) {
        for (const [attr, key] of PROTOCOL_ATTR) {
            const v = s.protocols[key];
            if (v !== undefined) host.setAttribute(attr, v ? 'yes' : 'no');
        }
    }

    // Font: write the family only for a system font (a url/vfs font name is
    // meaningless to Mudlet); sync the size regardless; preserve the QFont tail.
    const systemFamily = s.outputFont?.kind === 'system' ? s.outputFont.family : undefined;
    if (systemFamily !== undefined || s.fontSize !== undefined) {
        const existing = host.querySelector(':scope > mDisplayFont')?.textContent ?? '';
        const parts = existing ? existing.split(',') : [];
        const family = systemFamily ?? parts[0] ?? '';
        const size = s.fontSize !== undefined ? String(s.fontSize) : (parts[1] ?? '');
        const tail = parts.length > 2 ? parts.slice(2) : DEFAULT_QFONT_TAIL;
        setHostEl(host, 'mDisplayFont', [family, size, ...tail].join(','));
    }
}

/** The identity a Mudlet `<Host>` carries for one profile: its name, the MUD
 *  address, and the packages Mudlet should consider installed. */
export interface MudletHostIdentity {
    name: string;
    url: string;
    port: number;
    installedPackages: string[];
}

/**
 * Write the connection identity onto a `<Host>` in place. Unlike
 * {@link applyProfileSettingsToHost} this always overwrites rather than only
 * touching what's set: the live connection record and package set are
 * authoritative, so a `<Host>` retained from an earlier import can't export the
 * name, address or package list it had back then.
 */
export function applyHostIdentity(host: Element, identity: MudletHostIdentity): void {
    setHostEl(host, 'name', identity.name);
    setHostEl(host, 'url', identity.url);
    setHostEl(host, 'port', String(identity.port));
    applyInstalledPackages(host, identity.installedPackages);
}

/**
 * Replace `<Host><mInstalledPackages>` with `names`, creating it when absent.
 * Desktop's `Host::saveProfile` always writes the live list, and a load takes
 * the profile's package set from it — so a save that left it out (or kept a
 * stale copy from the document it was based on) forgets every package on the
 * next open.
 */
export function applyInstalledPackages(host: Element, names: string[]): void {
    let list = host.querySelector(':scope > mInstalledPackages');
    if (!list) {
        list = newHostEl(host, 'mInstalledPackages');
        host.appendChild(list);
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const name of names) {
        const el = newHostEl(host, 'string');
        el.textContent = name;
        list.appendChild(el);
    }
}

/**
 * Replace `<Host><stopwatches>` with the profile's persistent stopwatches,
 * written as desktop's `XMLexport` writes them, so a save carries them as
 * desktop's does rather than the copy the document was based on.
 */
export function applyStopwatches(host: Element, watches: SavedStopwatch[]): void {
    let list = host.querySelector(':scope > stopwatches');
    if (!list) {
        list = newHostEl(host, 'stopwatches');
        host.appendChild(list);
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const watch of watches) {
        const el = newHostEl(host, 'stopwatch');
        el.setAttribute('id', String(watch.id));
        if (watch.running) {
            el.setAttribute('running', 'yes');
            el.setAttribute('effectiveStartDateTimeEpochMSecs', String(Math.trunc(watch.effectiveStartEpochMs)));
        } else {
            el.setAttribute('running', 'no');
            el.setAttribute('elapsedDateTimeMSecs', String(Math.trunc(watch.elapsedMs)));
        }
        el.setAttribute('name', watch.name);
        list.appendChild(el);
    }
}

/**
 * Reduce a full Mudlet profile save to a document holding just its
 * `<HostPackage>`.
 *
 * Mudlet's `<Host>` is roughly 120 attributes, 26 child elements and 53 colour
 * elements (`XMLimport.cpp:723-1305`); Mudlet Web models about a third of that. The
 * rest — proxy and TLS configuration, logging setup, the spell dictionary,
 * console buffer sizing, the map colours and sizes, `<stopwatches>`, `<MMCP>`,
 * the `<experiment>` flags, the second-console palette — has no home in
 * ProfileSettings, so it survives a round-trip only by being carried verbatim.
 * Retaining this on import is what lets an export base its `<Host>` on the real
 * one instead of a skeleton.
 *
 * Dropped on the way through:
 * - the automation and variable packages, which are regenerated from live state
 *   on every write; keeping a copy here would ship the same data twice, in two
 *   formats, and let a stale one resurface.
 * - `<mInstalledModules>`, because import re-registers each resolved module
 *   against a copy of its XML inside the new profile. A surviving reference
 *   would make Mudlet load it a second time from the absolute path it had on
 *   the original machine.
 *
 * Returns null if `profileXml` doesn't parse or carries no `<HostPackage>`.
 */
export function extractHostPackageXml(profileXml: string): string | null {
    const doc = new DOMParser().parseFromString(profileXml, 'text/xml');
    if (doc.getElementsByTagName('parsererror')[0]) return null;
    const hostPackage = doc.getElementsByTagName('HostPackage')[0];
    if (!hostPackage) return null;
    const version = doc.getElementsByTagName('MudletPackage')[0]?.getAttribute('version') ?? '1.001';

    const out = new DOMParser().parseFromString('<MudletPackage/>', 'text/xml');
    out.documentElement.setAttribute('version', version);
    const copy = out.importNode(hostPackage, true) as Element;
    for (const el of Array.from(copy.getElementsByTagName('mInstalledModules'))) el.remove();
    out.documentElement.appendChild(copy);
    return MUDLET_XML_PROLOG + new XMLSerializer().serializeToString(out);
}

/** Names from `<Host><mInstalledPackages>` — the packages Mudlet considers
 *  installed for this profile. Mudlet tracks these so package managers (mpkg) and
 *  `getPackageInfo`/`getInstalledPackages` work; Mudlet Web registers a manifest per
 *  entry on import. */
export function parseInstalledPackages(host: Element): string[] {
    const list = host.querySelector(':scope > mInstalledPackages');
    if (!list) return [];
    return Array.from(list.querySelectorAll(':scope > string'))
        .map(s => s.textContent?.trim() ?? '')
        .filter(Boolean);
}

/** Everything a full Mudlet profile XML carries that Mudlet Web can import. */
export interface MudletProfileImport {
    /** From `<Host>` — the profile name + MUD address for the connection record. */
    connection: MudletProfileIdentity;
    /** From `<HostPackage><Host>` — partial so it merges over defaults. */
    settings: Partial<ProfileSettings>;
    /** From the Trigger/Alias/Script/Timer/Key/Action packages. */
    automation: MudletImportResult;
    /** From `<VariablePackage>` — the saved-variables tree + hidden list. */
    variables: MudletVariablePackage;
    /** Names from `<mInstalledPackages>` — registered as package manifests on import. */
    installedPackages: string[];
    /** From `<mInstalledModules>` — modules reference an XML file at an absolute
     *  local path *outside* the profile, which a browser can't read. The import
     *  flow surfaces these for the user to upload or drop. */
    modules: MudletModuleRef[];
}

/** One `<mInstalledModules>` entry: a module the profile loads from an external
 *  XML file on the user's disk. */
export interface MudletModuleRef {
    key: string;
    filepath: string;
    /** Mudlet `globalSave` flag — sync the module back on save. */
    globalSave: boolean;
    priority: number;
}

/** Parse the repeated `<mInstalledModules>` blocks under `<Host>`. */
export function parseInstalledModules(host: Element): MudletModuleRef[] {
    return Array.from(host.children)
        .filter(c => c.tagName === 'mInstalledModules')
        .map(el => ({
            key: childText(el, 'key') ?? '',
            filepath: childText(el, 'filepath') ?? '',
            globalSave: (childText(el, 'globalSave') ?? '0') !== '0',
            priority: Number(childText(el, 'priority') ?? '0') || 0,
        }))
        .filter(m => m.key);
}

/**
 * Parse a complete Mudlet profile XML (a `current/*.xml`) into the things Mudlet Web
 * can apply: the connection identity, profile settings, automation trees, and
 * saved variables. `<VariablePackage>` variable names become the seed of the
 * profile's save-list when applied. Throws on malformed XML.
 */
export function parseMudletProfile(xml: string): MudletProfileImport {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error(`XML parse error: ${err.textContent?.split('\n')[0]}`);
    const host = doc.getElementsByTagName('Host')[0];
    return {
        connection: host ? parseMudletHostIdentity(host) : {},
        settings: host ? parseMudletHost(host) : {},
        automation: parseMudletXml(xml),
        variables: parseVariablePackageXml(xml),
        installedPackages: host ? parseInstalledPackages(host) : [],
        modules: host ? parseInstalledModules(host) : [],
    };
}
