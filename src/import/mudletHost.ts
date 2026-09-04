import type { ProfileSettings, ProtocolSettings, BooleanProtocolKey } from '../storage/schema';
import { SERVER_WRAP_WIDTH_MIN, SERVER_WRAP_WIDTH_MAX } from '../mud/text/serverWrap';
import { MIN_CONSOLE_BUFFER_SIZE, MAX_CONSOLE_BUFFER_SIZE } from '../mud/text/Console';
import { parseMudletXml, type MudletImportResult } from './mudletXmlImport';
import { parseVariablePackageXml, type MudletVariablePackage } from './mudletVariables';

// Maps the `<HostPackage><Host>` block of a Mudlet profile XML onto mudix's
// ProfileSettings. This is the settings half of a full Mudlet-profile import —
// the automation half is parseMudletXml, the saved-variables half is
// parseVariablePackageXml. Only fields with a mudix home are mapped; the rest of
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

// Mudlet color element name → ansiPalette index. mudix's palette is 0–7 dark
// (black,red,green,yellow,blue,magenta,cyan,white) then 8–15 bright; Mudlet
// names them mBlack/mLightBlack/… so the indices are interleaved relative to
// Mudlet's own document order.
const ANSI_COLOR_INDEX: ReadonlyArray<readonly [string, number]> = [
    ['mBlack', 0], ['mRed', 1], ['mGreen', 2], ['mYellow', 3],
    ['mBlue', 4], ['mMagenta', 5], ['mCyan', 6], ['mWhite', 7],
    ['mLightBlack', 8], ['mLightRed', 9], ['mLightGreen', 10], ['mLightYellow', 11],
    ['mLightBlue', 12], ['mLightMagenta', 13], ['mLightCyan', 14], ['mLightWhite', 15],
];

// Mudlet's `<Host mEnableX>` attribute → mudix ProtocolSettings field.
const PROTOCOL_ATTR: ReadonlyArray<readonly [string, BooleanProtocolKey]> = [
    ['mEnableGMCP', 'gmcp'], ['mEnableMSDP', 'msdp'], ['mEnableMSSP', 'mssp'],
    ['mEnableMSP', 'msp'], ['mEnableMTTS', 'mtts'], ['mEnableMNES', 'mnes'],
    ['mEnableMXP', 'mxp'], ['mEnableNAWS', 'naws'], ['mEnableCHARSET', 'charset'],
    ['mEnableNEWENVIRON', 'newEnviron'],
];

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

    return out;
}

/** The connection identity a Mudlet `<Host>` carries: the profile name and the
 *  MUD address (`<url>` host + `<port>`). Used to seed a new mudix connection. */
export interface MudletProfileIdentity {
    name?: string;
    host?: string;
    port?: number;
}

/** Read `<name>`/`<url>`/`<port>` (direct children of `<Host>`). */
export function parseMudletHostIdentity(host: Element): MudletProfileIdentity {
    const out: MudletProfileIdentity = {};
    const name = childText(host, 'name');
    if (name) out.name = name;
    const url = childText(host, 'url');
    if (url) out.host = url;
    const port = childText(host, 'port');
    if (port !== undefined && Number.isFinite(Number(port))) out.port = Number(port);
    return out;
}

// ── write-back (inverse of parseMudletHost) ──────────────────────────────────

/** What Mudlet's own exporter puts above `<MudletPackage>`, reproduced so a file
 *  written here is byte-shaped like one written there. Nothing reads it —
 *  Mudlet's QXmlStreamReader ignores the doctype — but dropping it would make
 *  mudix's saves gratuitously different. */
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

// Mudlet's mDisplayFont is a serialized QFont: "family,pointSize,<tail>". mudix
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

    let list = host.querySelector(':scope > mInstalledPackages');
    if (!list) {
        list = newHostEl(host, 'mInstalledPackages');
        host.appendChild(list);
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const name of identity.installedPackages) {
        const el = newHostEl(host, 'string');
        el.textContent = name;
        list.appendChild(el);
    }
}

/**
 * Reduce a full Mudlet profile save to a document holding just its
 * `<HostPackage>`.
 *
 * Mudlet's `<Host>` is roughly 120 attributes, 26 child elements and 53 colour
 * elements (`XMLimport.cpp:723-1305`); mudix models about a third of that. The
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
 * - `<mInstalledModules>`, because import folds a resolved module into an
 *   ordinary package. A surviving reference would make Mudlet load it a second
 *   time from the absolute path it had on the original machine.
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
 *  `getPackageInfo`/`getInstalledPackages` work; mudix registers a manifest per
 *  entry on import. */
export function parseInstalledPackages(host: Element): string[] {
    const list = host.querySelector(':scope > mInstalledPackages');
    if (!list) return [];
    return Array.from(list.querySelectorAll(':scope > string'))
        .map(s => s.textContent?.trim() ?? '')
        .filter(Boolean);
}

/** Everything a full Mudlet profile XML carries that mudix can import. */
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
 * Parse a complete Mudlet profile XML (a `current/*.xml`) into the things mudix
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
