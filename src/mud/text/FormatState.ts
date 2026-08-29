import { colorCodes, setPaletteColor, resetPaletteColor, resetAllPaletteColors, isServerRedefineColorsAllowed } from "./colors";
import mudletColorsJson from "./mudletColors.json";
import {
    scanEscape,
    parseOsc8Payload,
    classifyHyperlinkUri,
    parseOscColorPalette,
    type OscPaletteOp,
} from "./ansiEscapes";
import {
    parseOsc8Uri,
    isOsc8HyperlinksEnabled,
    HyperlinkPresetRegistry,
    type HyperlinkConfig,
    type LinkStateStyle,
    type UnderlineStyle,
} from "./hyperlinkConfig";
import { applyVisibility } from "./hyperlinkVisibility";
import { appendCells, cellsToHtml, columnAfter } from "./cellRender";
import { getControlCharacterMode } from "./controlCharacterMode";

/** Apply OSC 4/104 palette operations to the global colour tables. Palette
 *  changes affect text parsed *after* this point — which is exactly document
 *  order, since lines are fed to the parser in the order the server sent them. */
export function applyOscPaletteOps(ops: ReadonlyArray<OscPaletteOp>): void {
    // Mudlet's "Allow server to redefine your colors": when off, OSC 4/104 from
    // the server is ignored and the user's palette stands.
    if (!isServerRedefineColorsAllowed()) return;
    for (const op of ops) {
        if (op.kind === "set") setPaletteColor(op.index, op.color);
        else if (op.kind === "reset") resetPaletteColor(op.index);
        else resetAllPaletteColors();
    }
}

const ESC = "";

export interface FormatHyperlink {
    onClick?: (ev: MouseEvent) => void;
    onContextMenu?: (ev: MouseEvent) => void;
    onMouseEnter?: (ev: MouseEvent) => void;
    onMouseLeave?: (ev: MouseEvent) => void;
    title?: string;
    /**
     * Raw link target recorded by the low-level ANSI parser for OSC 8 links.
     * The parser has no access to the scripting API, so it stores the URI here
     * and the engine later wires the click behaviour via `bindUrlHyperlinks`.
     * For OSC 8 links this is the *cleaned* command (extension query stripped).
     */
    url?: string;
    /** Parsed Mudlet OSC 8 extension config (styling, states, tooltip, menu,
     *  spoiler, disabled, visibility, selection), resolved at parse time. */
    config?: HyperlinkConfig;
    /** OSC 8 `id=` parameter — groups split runs of one logical link so hover
     *  can highlight them together. */
    linkId?: string;
    /**
     * Document-style link that should render with an underline cue by default,
     * the way a web browser underlines anchors. Set on MXP `<send>`/`<a>` links
     * only. Scripted Mudlet-API links (`echoLink`, `echoPopup`, `setLink`) leave
     * this unset — they underline only when the script sets the real `underline`
     * attribute (Mudlet's `useCurrentFormat=false` default), so a
     * `useCurrentFormat=true` link keeps the current pen with no underline.
     *
     * OSC 8 links also leave it unset: Mudlet's `HyperlinkStyling::isUnderlined`
     * defaults to false, so they underline only when their `config` style asks
     * for it (`{"style":{"underline":true}}` / a matching pseudo-class state).
     */
    autoUnderline?: boolean;
}

export interface IndexedColor {
    space: "indexed";
    index: number;
}

export interface RgbColor {
    space: "rgb";
    r: number;
    g: number;
    b: number;
    a?: number;
}

export interface HexColor {
    space: "hex";
    color: string;
}

export type FormatColor = IndexedColor | RgbColor | HexColor

/** One SGR parameter: a number, or its sub-parameters when it carried any
 *  (`4:3` → `[4, 3]`). See {@link parseSgrCodes}. */
export type SgrParam = number | number[];

export type DimEasing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out';

export interface DimEffect {
    startOpacity: number;
    endOpacity: number;
    duration: number;
    easing?: DimEasing;
}

export interface FormatStateSnapshot {
    foreground?: FormatColor;
    background?: FormatColor;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    /** Which underline SGR asked for (`4:1`..`4:5`). Only meaningful while
     *  `underline` is set; absent means the plain solid one. */
    underlineStyle?: UnderlineStyle;
    inverse?: boolean;
    strikethrough?: boolean;
    overline?: boolean;
    slowBlink?: boolean;
    rapidBlink?: boolean;
    dim?: DimEffect;
    hyperlink?: FormatHyperlink;
    cssClass?: string;
}

export type TextRange = [start: number, end: number];

export interface BufferSegment {
    text: string;
    state?: FormatStateSnapshot;
}

function cloneColor(color?: FormatColor): FormatColor | undefined {
    if (!color) return undefined;
    if (color.space === "indexed") {
        return {space: "indexed", index: color.index};
    }
    if (color.space === "hex") {
        return {space: "hex", color: color.color};
    }
    return color.a !== undefined
        ? {space: "rgb", r: color.r, g: color.g, b: color.b, a: color.a}
        : {space: "rgb", r: color.r, g: color.g, b: color.b};
}

function hyperlinksEqual(a?: FormatHyperlink, b?: FormatHyperlink): boolean {
    return !a && !b;
}

function colorsEqual(a?: FormatColor, b?: FormatColor): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.space !== b.space) return false;
    if (a.space === "indexed" && b.space === "indexed") {
        return a.index === b.index;
    }
    if (a.space === "rgb" && b.space === "rgb") {
        return a.r === b.r && a.g === b.g && a.b === b.b && (a.a ?? 255) === (b.a ?? 255);
    }
    if (a.space === "hex" && b.space === "hex") {
        return a.color === b.color;
    }
    return false;
}

function hasVisualFormatting(state?: FormatStateSnapshot): boolean {
    if (!state) return false;
    return !!(
        state.foreground ||
        state.background ||
        state.bold ||
        state.italic ||
        state.underline ||
        state.inverse ||
        state.strikethrough ||
        state.overline ||
        state.slowBlink ||
        state.rapidBlink ||
        state.dim ||
        state.cssClass
    );
}

function dimEffectsEqual(a?: DimEffect, b?: DimEffect): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
        a.startOpacity === b.startOpacity &&
        a.endOpacity === b.endOpacity &&
        a.duration === b.duration &&
        (a.easing || 'ease-in-out') === (b.easing || 'ease-in-out')
    );
}

function isDefaultState(state?: FormatStateSnapshot): boolean {
    return !hasVisualFormatting(state) && (!state || !state.hyperlink);
}

function cloneState(state?: FormatStateSnapshot): FormatStateSnapshot | undefined {
    if (!state) return undefined;
    return {
        foreground: cloneColor(state.foreground),
        background: cloneColor(state.background),
        bold: state.bold,
        italic: state.italic,
        underline: state.underline,
        underlineStyle: state.underlineStyle,
        inverse: state.inverse,
        strikethrough: state.strikethrough,
        overline: state.overline,
        slowBlink: state.slowBlink,
        rapidBlink: state.rapidBlink,
        dim: state.dim ? {...state.dim} : undefined,
        hyperlink: state.hyperlink ? {...state.hyperlink} : undefined,
        cssClass: state.cssClass,
    };
}

function statesEqual(a?: FormatStateSnapshot, b?: FormatStateSnapshot): boolean {
    if (isDefaultState(a) && isDefaultState(b)) return true;
    if (!a || !b) return false;
    return (
        colorsEqual(a.foreground, b.foreground) &&
        colorsEqual(a.background, b.background) &&
        !!a.bold === !!b.bold &&
        !!a.italic === !!b.italic &&
        !!a.underline === !!b.underline &&
        a.underlineStyle === b.underlineStyle &&
        !!a.inverse === !!b.inverse &&
        !!a.strikethrough === !!b.strikethrough &&
        !!a.overline === !!b.overline &&
        !!a.slowBlink === !!b.slowBlink &&
        !!a.rapidBlink === !!b.rapidBlink &&
        dimEffectsEqual(a.dim, b.dim) &&
        hyperlinksEqual(a.hyperlink, b.hyperlink) &&
        a.cssClass === b.cssClass
    );
}

export class FormatState {

    static DEFAULT = {}

    background?: FormatColor;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    underlineStyle?: UnderlineStyle;
    inverse?: boolean;
    strikethrough?: boolean;
    overline?: boolean;
    slowBlink?: boolean;
    rapidBlink?: boolean;
    dim?: DimEffect;
    hyperlink?: FormatHyperlink;

    // ── the foreground's dark/light pair (Mudlet mForeGroundColor /
    // mForeGroundColorLight / mIsDefaultColor) ──────────────────────────────
    //
    // Bold does not only embolden: on a colour from the 30–37 range it selects
    // that colour's bright twin, and it does so whichever order the two arrive
    // in. Resolving the colour the moment its SGR lands cannot express that — a
    // `\e[31m…\e[1m` would stay dark, and worse, a `\e[39m` (default foreground)
    // followed by a bold would resurrect the red the reset was meant to end,
    // which is the bug Mudlet/Mudlet#9466 reported.
    //
    // So both variants are kept, plus whether the foreground is currently the
    // profile default, and `foreground` is recomputed from the three whenever
    // any of them moves. Consumers keep reading `foreground` and see the colour
    // already resolved.
    private fgNormal?: FormatColor;
    private fgLight?: FormatColor;
    /** True while the foreground is the profile's own — as it starts, and as
     *  SGR 0 and SGR 39 leave it. Bold never brightens a default foreground. */
    private fgIsDefault = true;
    private _foreground?: FormatColor;

    /** The foreground in force, both variants already resolved. */
    get foreground(): FormatColor | undefined {
        return this._foreground;
    }

    /** Writing the foreground from outside the SGR decoder — `setFgColor`, MXP
     *  colour attributes, link styling — names one colour and knows nothing of
     *  the bold pair, so it becomes both variants. Without that a later bold
     *  would re-resolve to whatever the escape stream had left behind and undo
     *  the write. */
    set foreground(color: FormatColor | undefined) {
        this._foreground = cloneColor(color);
        this.fgNormal = cloneColor(color);
        this.fgLight = cloneColor(color);
        this.fgIsDefault = color === undefined;
    }

    constructor(initial?: FormatStateSnapshot) {
        if (initial) {
            this.applySnapshot(initial);
        }
    }

    private applySnapshot(snapshot: FormatStateSnapshot): void {
        // A snapshot carries only the colour that was in force, so the setter's
        // rule is the right one: it becomes both variants. Nothing is lost —
        // whatever bold was doing at the carry point had already chosen it.
        this.foreground = snapshot.foreground;
        this.background = cloneColor(snapshot.background);
        this.bold = snapshot.bold ? true : undefined;
        this.italic = snapshot.italic ? true : undefined;
        this.underline = snapshot.underline ? true : undefined;
        this.underlineStyle = snapshot.underline ? snapshot.underlineStyle : undefined;
        this.inverse = snapshot.inverse ? true : undefined;
        this.strikethrough = snapshot.strikethrough ? true : undefined;
        this.overline = snapshot.overline ? true : undefined;
        this.slowBlink = snapshot.slowBlink ? true : undefined;
        this.rapidBlink = snapshot.rapidBlink ? true : undefined;
        this.dim = snapshot.dim ? {...snapshot.dim} : undefined;
        this.hyperlink = snapshot.hyperlink ? {...snapshot.hyperlink} : undefined;
    }

    reset(): void {
        this.foreground = undefined;
        this.background = undefined;
        this.bold = undefined;
        this.italic = undefined;
        this.underline = undefined;
        this.underlineStyle = undefined;
        this.inverse = undefined;
        this.strikethrough = undefined;
        this.overline = undefined;
        this.slowBlink = undefined;
        this.rapidBlink = undefined;
        this.dim = undefined;
    }

    toSnapshot(): FormatStateSnapshot {
        return {
            foreground: cloneColor(this.foreground),
            background: cloneColor(this.background),
            bold: this.bold ? true : undefined,
            italic: this.italic ? true : undefined,
            underline: this.underline ? true : undefined,
            underlineStyle: this.underline ? this.underlineStyle : undefined,
            inverse: this.inverse ? true : undefined,
            strikethrough: this.strikethrough ? true : undefined,
            overline: this.overline ? true : undefined,
            slowBlink: this.slowBlink ? true : undefined,
            rapidBlink: this.rapidBlink ? true : undefined,
            dim: this.dim ? {...this.dim} : undefined,
            hyperlink: this.hyperlink ? {...this.hyperlink} : undefined,
        };
    }

    applySgr(params: SgrParam[]): void {
        if (params.length === 0) {
            this.reset();
            return;
        }
        for (let i = 0; i < params.length; i += 1) {
            const param = params[i];
            // A parameter with sub-parameters is self-contained — everything it
            // needs came colon-joined with it, so it never looks ahead.
            if (Array.isArray(param)) {
                this.applySgrGroup(param);
                continue;
            }
            const code = param;
            switch (code) {
                case 0:
                    this.reset();
                    break;
                case 1:
                    this.bold = true;
                    this.resolveForeground();
                    break;
                case 3:
                    this.italic = true;
                    break;
                case 4:
                    // The bare SGR 4 is the solid underline, so it replaces any
                    // style a previous 4:n left rather than keeping it.
                    this.underline = true;
                    this.underlineStyle = "solid";
                    break;
                case 5:
                    this.slowBlink = true;
                    break;
                case 6:
                    this.rapidBlink = true;
                    break;
                case 7:
                    this.inverse = true;
                    break;
                case 9:
                    this.strikethrough = true;
                    break;
                case 53:
                    this.overline = true;
                    break;
                case 22:
                    this.bold = undefined;
                    this.resolveForeground();
                    break;
                case 23:
                    this.italic = undefined;
                    break;
                case 24:
                    this.underline = undefined;
                    this.underlineStyle = undefined;
                    break;
                case 25:
                    this.slowBlink = undefined;
                    this.rapidBlink = undefined;
                    break;
                case 27:
                    this.inverse = undefined;
                    break;
                case 29:
                    this.strikethrough = undefined;
                    break;
                case 55:
                    this.overline = undefined;
                    break;
                case 39:
                    // The foreground goes back to the profile default, and both variants
                    // with it: the colour bold would otherwise brighten is gone, not
                    // merely covered over.
                    this.fgNormal = undefined;
                    this.fgLight = undefined;
                    this.fgIsDefault = true;
                    this.resolveForeground();
                    break;
                case 49:
                    this.background = undefined;
                    break;
                case 38:
                case 48: {
                    const isForeground = code === 38;
                    // The `38;5;n` spelling puts each piece in its own
                    // parameter, so this reads the ones that follow — and only
                    // plain numbers count, since a sub-parameter group belongs
                    // to a parameter of its own.
                    const at = (n: number): number | undefined => {
                        const p = params[i + n];
                        return typeof p === "number" ? p : undefined;
                    };
                    const mode = at(1);
                    const arg1 = at(2);
                    if (mode === 5 && arg1 !== undefined) {
                        const color: HexColor = {space: "hex", color: colorCodes.xterm[arg1]};
                        if (isForeground) {
                            // A colour chosen out of the 256-colour cube names
                            // itself exactly; there is no brighter twin to pick,
                            // so bold leaves it alone. Same for 24-bit below.
                            this.setForeground(color, color);
                        } else {
                            this.background = color;
                        }
                        i += 2;
                    } else if (
                        mode === 2 && arg1 !== undefined
                        && at(3) !== undefined && at(4) !== undefined
                    ) {
                        const color: RgbColor = {
                            space: "rgb",
                            r: arg1,
                            g: at(3)!,
                            b: at(4)!,
                        };
                        if (isForeground) {
                            this.setForeground(color, color);
                        } else {
                            this.background = color;
                        }
                        i += 4;
                    }
                    break;
                }
                default:
                    if (code >= 30 && code <= 37) {
                        // Both variants are recorded, so a bold in this same
                        // sequence or any later one picks the bright twin.
                        // Polish MUDs (Arkadia, Avalon) draw map glyphs as
                        // `\e[1;30m+` and as `\e[1m...\e[30m+`, and both have to
                        // come out bright black rather than invisible #000000 on
                        // a black background.
                        this.setForeground(
                            {space: "hex", color: colorCodes.ansi.dark[code - 30]},
                            {space: "hex", color: colorCodes.ansi.bright[code - 30]},
                        );
                    } else if (code >= 90 && code <= 97) {
                        // Already bright — bold has nothing brighter to reach for.
                        const bright: HexColor = {space: "hex", color: colorCodes.ansi.bright[code - 90]};
                        this.setForeground(bright, bright);
                    } else if (code >= 40 && code <= 47) {
                        this.background = {space: "hex", color: colorCodes.ansi.dark[code - 40]};
                    } else if (code >= 100 && code <= 107) {
                        this.background = {space: "hex", color: colorCodes.ansi.bright[code - 100]};
                    }
                    break;
            }
        }
    }

    /**
     * Apply one SGR parameter that carried sub-parameters (`4:3`, `38:5:196`).
     *
     * Only the underline styles need reading apart from the flat form: an
     * extended colour means the same written either way, so it is handed back to
     * the ordinary path with its sub-parameters flattened.
     */
    private applySgrGroup(group: number[]): void {
        if (group[0] === 38 || group[0] === 48) {
            this.applyExtendedColorGroup(group);
            return;
        }
        if (group[0] !== 4) {
            this.applySgr(group);
            return;
        }
        // `4:n` picks the underline's style; every style is exclusive, so each
        // replaces the last rather than adding to it (Mudlet's decodeSGR clears
        // the three sibling flags on every branch). Anything outside 0..5 is a
        // style this build does not know, and an unknown decoration is treated
        // as none rather than drawn as some other one.
        switch (group[1] ?? 0) {
            case 1: // single
            case 2: // double — no such underline here, so it shows as single
                this.underline = true;
                this.underlineStyle = "solid";
                break;
            case 3:
                this.underline = true;
                this.underlineStyle = "wavy";
                break;
            case 4:
                this.underline = true;
                this.underlineStyle = "dotted";
                break;
            case 5:
                this.underline = true;
                this.underlineStyle = "dashed";
                break;
            default: // 0, and anything unrecognised
                this.underline = undefined;
                this.underlineStyle = undefined;
                break;
        }
    }

    /**
     * `38:…` / `48:…` — an extended colour written with sub-parameters.
     *
     * The colon form carries one element the semicolon form does not: a colour
     * space identifier sits between the `2` and the red component, almost always
     * empty (`38:2::255:0:0`). So the components are the 4th, 5th and 6th
     * sub-parameters here where they are the 3rd, 4th and 5th parameters there.
     * Missing components are zero, as in Mudlet's decodeSGR38.
     */
    private applyExtendedColorGroup(group: number[]): void {
        const isForeground = group[0] === 38;
        const put = (color: FormatColor) => {
            if (isForeground) this.setForeground(color, color);
            else this.background = color;
        };
        if (group[1] === 5 && group[2] !== undefined) {
            put({space: "hex", color: colorCodes.xterm[group[2]]});
        } else if (group[1] === 2) {
            put({space: "rgb", r: group[3] ?? 0, g: group[4] ?? 0, b: group[5] ?? 0});
        }
    }

    /** Record a foreground and the colour bold should show instead of it, then
     *  resolve which of the two is in force. Pass the same colour twice when it
     *  has no brighter twin. */
    private setForeground(normal: FormatColor, light: FormatColor): void {
        this.fgNormal = cloneColor(normal);
        this.fgLight = cloneColor(light);
        this.fgIsDefault = false;
        this.resolveForeground();
    }

    /** Pick the variant the current bold state calls for. Mudlet writes each
     *  cell as `(!mIsDefaultColor && mBold) ? light : normal` — a default
     *  foreground stays default however bold the text is. */
    private resolveForeground(): void {
        // Straight to the backing field: going through the setter would flatten
        // the pair this is choosing between.
        this._foreground = cloneColor(
            !this.fgIsDefault && this.bold ? this.fgLight : this.fgNormal);
    }

    setHyperlink(link?: FormatHyperlink): void {
        this.hyperlink = link ? {...link} : undefined;
    }
}

/**
 * Split an SGR sequence into its parameters. `;` separates parameters and `:`
 * their sub-parameters (ECMA-48 / ITU T.416), so a parameter that carries
 * sub-parameters comes back as an array and a plain one as a number.
 *
 * The distinction matters for exactly one reason, but it matters a lot: `4:3` is
 * a *curly underline*, one parameter with a sub-parameter, while `4;3` is an
 * underline followed by italics. Flattening both — which mudix did, to make
 * `38:5:1` work alongside `38;5;1` — turned every styled underline into an
 * accidental italic. Extended colours still read either form, since applySgr
 * looks ahead across parameters for the `38;5;n` spelling.
 */
export function parseSgrCodes(sequence: string): SgrParam[] {
    if (!sequence) return [0];
    const params: SgrParam[] = [];
    for (const part of sequence.split(';')) {
        const nums = part
            .split(':')
            .map(sub => sub.trim())
            .map(sub => (sub.length === 0 ? 0 : Number.parseInt(sub, 10)))
            .map(num => (Number.isNaN(num) ? 0 : num));
        // A bare `;` (an empty parameter) means 0, the same as writing it out.
        if (nums.length === 1) params.push(nums[0]);
        else params.push(nums);
    }
    return params;
}

/** True when a parsed OSC 8 config carries any field worth keeping (so a bare
 *  `send:look` link doesn't lug an empty object around). */
function hasConfig(config: HyperlinkConfig): boolean {
    return Object.keys(config).length > 0;
}

/** Monotonic source of `data-link-group` keys. Module-global (not per toDom
 *  call) so keys are unique across every rendered line — navigation scans the
 *  whole output and dedupes by this key, so per-line numbering would collide
 *  (every line's first link would be `inst:1`). */
let navLinkSeq = 0;

/** Merge a per-state link style over the link's base style (state fields win).
 *  Returns undefined when neither is present so callers fall back to plain SGR. */
function mergeLinkStyle(base?: LinkStateStyle, overlay?: LinkStateStyle): LinkStateStyle | undefined {
    if (!overlay) return base;
    if (!base) return overlay;
    return { ...base, ...overlay };
}

function parseAnsiSegments(
    text: string,
    baseState?: FormatStateSnapshot,
    presets?: HyperlinkPresetRegistry,
): BufferSegment[] {
    const segments: BufferSegment[] = [];
    const state = new FormatState(baseState);
    // A bare parse (e.g. script-echoed text) still resolves config and presets
    // within this one string via an ephemeral registry; cross-line presets need
    // the session registry passed in.
    const registry = presets ?? new HyperlinkPresetRegistry();
    let buffer = "";
    const flush = (): void => {
        if (!buffer) return;
        const snapshot = state.toSnapshot();
        const storedState = isDefaultState(snapshot) ? undefined : snapshot;
        segments.push({text: buffer, state: storedState});
        buffer = "";
    };
    for (let i = 0; i < text.length;) {
        const char = text[i];
        if (char === ESC) {
            const esc = scanEscape(text, i);
            // An escape cut off by end-of-line is dropped (the line is already
            // fully assembled by the time we parse it; a truncated tail is junk).
            if (esc.kind === "incomplete") break;
            if (esc.kind === "csi" && esc.finalByte === "m") {
                flush();
                state.applySgr(parseSgrCodes(esc.params ?? ""));
            } else if (esc.kind === "osc" && esc.oscPayload !== undefined) {
                const link = parseOsc8Payload(esc.oscPayload);
                if (link) {
                    // OSC 8: a non-empty URI opens a hyperlink over the text
                    // that follows; an empty URI closes it. The URI is resolved
                    // through the Mudlet extension parser — preset definitions
                    // register (and render nothing), normal links keep their
                    // cleaned command + parsed config on the snapshot (the engine
                    // wires click behaviour later via bindUrlHyperlinks).
                    flush();
                    if (link.uri === "") {
                        state.hyperlink = undefined;
                    } else if (!isOsc8HyperlinksEnabled()) {
                        // Mudlet 5.0's mEnableOSC8Hyperlinks gate
                        // (TBuffer::decodeOSC). Deliberately *below* the close
                        // branch: closing is the only thing that clears the
                        // open link, so refusing it would leave a link the
                        // toggle caught mid-flight open for the rest of the
                        // session. The sequence is still consumed, never
                        // rendered as literal text.
                    } else {
                        const result = parseOsc8Uri(link.uri, registry);
                        if (result?.kind === "link" && classifyHyperlinkUri(result.command)) {
                            // No autoUnderline: OSC 8 links carry no underline
                            // unless their config asks for one (Mudlet's
                            // HyperlinkStyling::isUnderlined defaults to false —
                            // deliberately unlike MXP/scripted links).
                            const hl: FormatHyperlink = { url: result.command };
                            if (hasConfig(result.config)) hl.config = result.config;
                            if (link.id) hl.linkId = link.id;
                            state.hyperlink = hl;
                        }
                        // preset definition / disallowed scheme: leave the
                        // current hyperlink state untouched (text stays plain).
                    }
                } else {
                    // OSC 4/104: server-driven colour palette redefinition. No
                    // text or state change — it retargets the colour tables for
                    // the SGR runs that follow.
                    const palette = parseOscColorPalette(esc.oscPayload);
                    if (palette) applyOscPaletteOps(palette);
                }
            }
            // Every other recognized sequence (non-OSC-8 OSC commands, cursor
            // moves, charset designation, DCS strings, …) is consumed and
            // ignored — never rendered as literal text.
            i = esc.end;
            continue;
        }
        buffer += char;
        i += 1;
    }
    flush();
    return segments;
}

/**
 * A run of text with its visual attributes resolved to concrete CSS colour
 * strings — the shape a canvas/image renderer wants. `color`/`background` are
 * undefined when the run uses the console default (the renderer fills in its
 * own default for those).
 */
export interface OutputStyledRun {
    text: string;
    color?: string;
    background?: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
}

/**
 * Buffer of text aware of ANSI formatting codes and hyperlink metadata.
 */
export class AnsiAwareBuffer {
    private segments: BufferSegment[] = [];
    private _deleted = false;
    private _onRender?: (container: HTMLElement) => void;
    private _textCache: string | null = null;
    private _renderContainer: HTMLElement | null = null;

    constructor(
        initial?: string | BufferSegment[],
        state?: FormatStateSnapshot,
        presets?: HyperlinkPresetRegistry,
    ) {
        if (typeof initial === "string") {
            this.segments = parseAnsiSegments(initial, state, presets);
            this.normalizeSegments();
        } else if (Array.isArray(initial)) {
            this.segments = initial.map(segment => ({
                text: segment.text,
                state: cloneState(segment.state),
            }));
            this.normalizeSegments();
        } else if (initial === undefined && state) {
            this.segments = [];
        }
    }

    get deleted(): boolean {
        return this._deleted;
    }

    markAsDeleted(): this {
        this._deleted = true;
        return this;
    }

    /** Per-line prompt flag. Mudlet's TBuffer tracks isPrompt on each line so
     *  the matching `isPrompt()` script primitive reflects the prompt status of
     *  whatever line the cursor is currently on (not just the last). Set by the
     *  trigger pipeline before triggers run; defaults to false. */
    isPrompt = false;

    /** Wall-clock time (epoch ms) the line was created. Mudlet stamps every
     *  buffer line with a QTime; `getTimestamp(lineNumber)` reads it back. A
     *  buffer is built right as its line is echoed/received, so construction
     *  time is the line's timestamp. */
    timestamp = Date.now();

    removeFromDom(): void {
        const container = this._renderContainer;
        if (!container) return;
        container.parentElement?.removeChild(container);
        this._renderContainer = null;
    }

    onRender(callback: (container: HTMLElement) => void): this {
        this._onRender = callback;
        return this;
    }

    /** @internal */
    notifyRender(container: HTMLElement): void {
        this._renderContainer = container;
        if (this._onRender) {
            this._onRender(container);
            this._onRender = undefined;
        }
    }

    /** Re-renders the buffer into its previously notified container. No-op if not yet rendered. */
    rerender(): void {
        const container = this._renderContainer;
        if (!container) return;
        while (container.firstChild) container.removeChild(container.firstChild);
        if (this.length === 0) {
            container.innerHTML = '&nbsp;';
        } else {
            container.appendChild(this.toDom());
        }
    }

    /** Removes all formatting from a range (clears colors, bold, etc.). */
    clearFormat(range: TextRange): this {
        const [start, end] = range;
        if (start >= end) return this;
        const text = this.text.slice(start, end);
        this.replace([start, end], text, {});
        return this;
    }

    clone(): AnsiAwareBuffer {
        return new AnsiAwareBuffer(this.getSegments());
    }

    get text(): string {
        if (this._textCache === null) {
            this._textCache = this.segments.map(segment => segment.text).join("");
        }
        return this._textCache;
    }

    get length(): number {
        return this.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    }

    clear(): this {
        this.segments = [];
        this._textCache = null;
        return this;
    }

    replace(range: [number, number], text: string, state?: FormatStateSnapshot): this {
        const [start, end] = range;
        this.assertRange(start, end);
        const fallback = state ? undefined : this.inferState(start);
        this.remove(range);
        if (text.length === 0) return this;
        this.insertInternal(start, text, state, fallback);
        return this;
    }

    replaceBuffer(range: [number, number], buffer: AnsiAwareBuffer): this {
        const [start, end] = range;
        this.assertRange(start, end);
        this.remove(range);
        if (buffer.length === 0) return this;
        this.insertBuffer(start, buffer);
        return this;
    }

    insert(index: number, text: string, state?: FormatStateSnapshot): this {
        if (text.length === 0) return this;
        this.assertIndex(index, true);
        const inferredState = state ? undefined : this.inferState(index);
        this.insertInternal(index, text, state, inferredState);
        return this;
    }

    insertBuffer(index: number, buffer: AnsiAwareBuffer): this {
        if (buffer.length === 0) return this;
        this.assertIndex(index, true);

        const sourceSegments = buffer.getSegments();
        if (sourceSegments.length === 0) return this;

        if (this.segments.length === 0) {
            this.segments = sourceSegments;
            this._textCache = null;
            return this;
        }

        if (index === this.length) {
            for (const segment of sourceSegments) {
                this.appendSegmentAtEnd(segment);
            }
            this.normalizeSegments();
            return this;
        }

        const position = this.resolveIndex(index, true);
        if (position.segmentIndex < this.segments.length) {
            this.splitSegment(position.segmentIndex, position.offset);
        }

        const insertionPoint = this.resolveBoundaryIndex(index);
        this.segments.splice(insertionPoint, 0, ...sourceSegments);
        this.normalizeSegments();
        return this;
    }

    prefix(text: string, state?: FormatStateSnapshot): this {
        this.insert(0, text, state ?? {});
        return this;
    }

    suffix(text: string, state?: FormatStateSnapshot): this {
        this.insert(this.length, text, state ?? {});
        return this;
    }

    private insertInternal(
        index: number,
        text: string,
        explicitState?: FormatStateSnapshot,
        baseState?: FormatStateSnapshot,
    ): void {
        if (text.length === 0) return;
        const insertionSegments = this.createSegmentsFromText(text, explicitState, baseState);
        if (insertionSegments.length === 0) return;
        if (this.segments.length === 0) {
            this.segments = insertionSegments.map(segment => ({
                text: segment.text,
                state: cloneState(segment.state),
            }));
            this._textCache = null;
            return;
        }
        if (index === this.length) {
            for (const segment of insertionSegments) {
                this.appendSegmentAtEnd(segment);
            }
            this.normalizeSegments();
            return;
        }
        const position = this.resolveIndex(index, true);
        if (position.segmentIndex < this.segments.length) {
            this.splitSegment(position.segmentIndex, position.offset);
        }
        const insertionPoint = this.resolveBoundaryIndex(index);
        this.segments.splice(insertionPoint, 0, ...insertionSegments.map(segment => ({
            text: segment.text,
            state: cloneState(segment.state),
        })));
        this.normalizeSegments();
    }

    append(text: string, state?: FormatStateSnapshot): this {
        this.insert(this.length, text, state);
        return this;
    }

    appendBuffer(buffer: AnsiAwareBuffer): this {
        this.insertBuffer(this.length, buffer);
        return this;
    }

    prepend(text: string, state?: FormatStateSnapshot): this {
        this.insert(0, text, state);
        return this;
    }

    prependBuffer(buffer: AnsiAwareBuffer): this {
        this.insertBuffer(0, buffer);
        return this;
    }

    remove(range: [number, number]): this {
        const [start, end] = range;
        this.assertRange(start, end);
        if (start === end) return this;
        const startPos = this.resolveIndex(start, true);
        if (startPos.segmentIndex < this.segments.length) {
            this.splitSegment(startPos.segmentIndex, startPos.offset);
        }
        const endPos = this.resolveIndex(end, true);
        if (endPos.segmentIndex < this.segments.length) {
            this.splitSegment(endPos.segmentIndex, endPos.offset);
        }
        const startIndex = this.resolveBoundaryIndex(start);
        const endIndex = this.resolveBoundaryIndex(end);
        this.segments.splice(startIndex, endIndex - startIndex);
        this.normalizeSegments();
        return this;
    }

    /** @internal */
    getSegments(): BufferSegment[] {
        return this.segments.map(segment => ({
            text: segment.text,
            state: cloneState(segment.state),
        }));
    }

    /** Whether any segment carries an OSC 8 link with `visibility` settings.
     *  A cheap pre-check (no cloning, no grouping) for the concealment pass,
     *  which every stored line goes through. */
    hasVisibilityLink(): boolean {
        return this.segments.some(s => s.state?.hyperlink?.config?.visibility !== undefined);
    }

    toHyperlinkSegments(): { text: string; hyperlink?: FormatHyperlink }[] {
        const segments: { text: string; hyperlink?: FormatHyperlink }[] = [];
        for (const segment of this.segments) {
            const link = segment.state?.hyperlink ? {...segment.state.hyperlink} : undefined;
            const last = segments[segments.length - 1];
            if (last && hyperlinksEqual(last.hyperlink, link)) {
                last.text += segment.text;
            } else {
                segments.push({text: segment.text, hyperlink: link});
            }
        }
        return segments;
    }

    color(range: TextRange, color: number | FormatStateSnapshot): this {
        const style = this.prepareStyle(color);
        const [start, end] = range;
        if (start >= end) return this;
        const text = this.text.slice(start, end);
        this.replace([start, end], text, style);
        return this;
    }

    applyFormat(range: TextRange, format: FormatStateSnapshot): this {
        const [start, end] = range;
        if (start >= end) return this;

        const text = this.text.slice(start, end);
        const currentState = this.getStateAt(start);

        const mergedState: FormatStateSnapshot = {
            ...currentState,
            ...format,
            foreground: format.foreground !== undefined ? format.foreground : currentState?.foreground,
            background: format.background !== undefined ? format.background : currentState?.background,
        };

        this.replace([start, end], text, mergedState);
        return this;
    }

    /**
     * Overlays a hyperlink on every segment in `range`, preserving each
     * segment's existing colors/attributes. Pass `undefined` to clear any
     * hyperlinks in the range. Unlike `applyFormat` (which homogenizes
     * formatting across the range), this is segment-wise — used by Mudlet
     * `setLink` so coloured selections remain coloured after becoming clickable.
     */
    setHyperlink(range: TextRange, hyperlink?: FormatHyperlink): this {
        const [start, end] = range;
        if (start >= end) return this;
        this.assertRange(start, end);

        const startPos = this.resolveIndex(start, true);
        if (startPos.segmentIndex < this.segments.length) {
            this.splitSegment(startPos.segmentIndex, startPos.offset);
        }
        const endPos = this.resolveIndex(end, true);
        if (endPos.segmentIndex < this.segments.length) {
            this.splitSegment(endPos.segmentIndex, endPos.offset);
        }
        const startIndex = this.resolveBoundaryIndex(start);
        const endIndex = this.resolveBoundaryIndex(end);
        for (let i = startIndex; i < endIndex; i++) {
            const seg = this.segments[i];
            const base = cloneState(seg.state) ?? {};
            base.hyperlink = hyperlink ? {...hyperlink} : undefined;
            seg.state = base;
        }
        this.normalizeSegments();
        return this;
    }

    /**
     * Wire deferred URL hyperlinks (recorded by the ANSI parser for OSC 8 links
     * as a bare `url` with no handlers) into live, clickable links. `factory`
     * turns a URI into a {@link FormatHyperlink} with the right click behaviour
     * (or `undefined` to drop the link). Segments that already have a handler —
     * e.g. an MXP `<SEND>` link overlaid on the same range — are left alone.
     */
    bindUrlHyperlinks(factory: (url: string, link: FormatHyperlink) => FormatHyperlink | undefined): this {
        for (const seg of this.segments) {
            const link = seg.state?.hyperlink;
            if (!link?.url || link.onClick) continue;
            const hl = factory(link.url, link);
            const base = cloneState(seg.state) ?? {};
            base.hyperlink = hl ? { ...hl } : undefined;
            seg.state = base;
        }
        return this;
    }

    colorWords(
        words: string | string[],
        color: number | FormatStateSnapshot,
        options: { caseInsensitive?: boolean } = {},
    ): this {
        const list = Array.isArray(words) ? words : [words];
        if (list.length === 0) return this;
        const caseInsensitive = options.caseInsensitive ?? false;
        const ranges: TextRange[] = [];
        const text = this.text;
        const haystack = caseInsensitive ? text.toLowerCase() : text;
        for (const word of list) {
            if (!word) continue;
            const needle = caseInsensitive ? word.toLowerCase() : word;
            let searchStart = 0;
            while (searchStart <= text.length - word.length) {
                const index = haystack.indexOf(needle, searchStart);
                if (index === -1) break;
                ranges.push([index, index + word.length]);
                searchStart = index + word.length;
            }
        }
        if (ranges.length === 0) return this;
        ranges.forEach(range => this.color(range, color));
        return this
    }

    splitLines(): AnsiAwareBuffer[] {
        const lines: AnsiAwareBuffer[] = [];
        let currentLineSegments: BufferSegment[] = [];

        for (const segment of this.segments) {
            const text = segment.text;
            let lastIndex = 0;

            for (let i = 0; i < text.length; i++) {
                if (text[i] === "\n") {
                    if (i > lastIndex) {
                        currentLineSegments.push({
                            text: text.slice(lastIndex, i),
                            state: cloneState(segment.state),
                        });
                    }

                    lines.push(new AnsiAwareBuffer(currentLineSegments));
                    currentLineSegments = [];
                    lastIndex = i + 1;
                }
            }

            if (lastIndex < text.length) {
                currentLineSegments.push({
                    text: text.slice(lastIndex),
                    state: cloneState(segment.state),
                });
            }
        }

        if (currentLineSegments.length > 0) {
            lines.push(new AnsiAwareBuffer(currentLineSegments));
        }

        if (lines.length === 0) {
            lines.push(new AnsiAwareBuffer());
        }

        return lines;
    }

    /** Returns the format state at the end of this buffer, for carrying into the next line. */
    trailingState(): FormatStateSnapshot | undefined {
        if (this.segments.length === 0) return undefined;
        return cloneState(this.segments[this.segments.length - 1].state);
    }

    /**
     * Build the CSS visual declarations (colour, weight, decorations) for a
     * segment. When `overlay` is given (an OSC 8 link style for a state), its set
     * fields win over the segment's own SGR attributes — that's how a link's
     * configured colour/decoration paints over the underlying run. With no
     * overlay this reproduces the plain SGR rendering exactly.
     */
    private visualDecls(state: FormatStateSnapshot, overlay?: LinkStateStyle): string[] {
        const styles: string[] = [];
        const fgSrc = state.inverse ? state.background : state.foreground;
        const bgSrc = state.inverse ? state.foreground : state.background;
        const fg = overlay?.foreground ?? fgSrc;
        const bg = overlay?.background ?? bgSrc;
        if (fg) styles.push(`color: ${this.colorToHex(fg)}`);
        // Reverse video with a default-coloured source: the swap yields no
        // explicit colour, so paint the console default of the opposite role
        // (text→bg, bg→text) — otherwise \e[7m on default colours is invisible.
        else if (state.inverse && overlay?.foreground === undefined) styles.push("color: var(--console-bg)");
        if (bg) styles.push(`background-color: ${this.colorToHex(bg)}`);
        else if (state.inverse && overlay?.background === undefined) styles.push("background-color: var(--console-text)");
        if (overlay?.bold ?? state.bold) styles.push("font-weight: bold");
        if (overlay?.italic ?? state.italic) styles.push("font-style: italic");

        const decorations: string[] = [];
        const underline = overlay?.underline ?? state.underline;
        if (underline) decorations.push("underline");
        if (overlay?.strikethrough ?? state.strikethrough) decorations.push("line-through");
        if (overlay?.overline ?? state.overline) decorations.push("overline");
        // MXP links get an underline cue unless the run is already underlined.
        // Scripted links (echoLink/echoPopup/setLink) and OSC 8 links do not —
        // they carry a real `underline` attribute when Mudlet would underline them.
        if (state.hyperlink?.autoUnderline && !underline) decorations.push("underline");
        if (decorations.length > 0) {
            styles.push(`text-decoration: ${decorations.join(" ")}`);
            // A link's own style wins over the run's, as every other overlay
            // field does; with no link it is the SGR `4:n` style that draws.
            const underlineStyle = overlay?.underlineStyle ?? state.underlineStyle;
            if (underlineStyle && underlineStyle !== "solid") {
                styles.push(`text-decoration-style: ${underlineStyle}`);
            }
            if (overlay?.decorationColor) {
                styles.push(`text-decoration-color: ${this.colorToHex(overlay.decorationColor)}`);
            }
        }
        return styles;
    }

    toHtml(): string {
        let html = "";

        const escape = (s: string) => this.escapeHtml(s);
        const mode = getControlCharacterMode();
        let column = 0;

        for (const segment of this.segments) {
            const escapedText = cellsToHtml(segment.text, escape, column, mode);
            column = columnAfter(segment.text, column, mode);

            if (!segment.state || isDefaultState(segment.state)) {
                html += escapedText;
                continue;
            }

            const state = segment.state;
            const link = state.hyperlink;
            const styles = this.visualDecls(state, link?.config?.style);

            if (link) {
                const disabled = link.config?.disabled === true;
                styles.push(`cursor: ${disabled ? "default" : "pointer"}`);
                let attrs = ' data-output-clickable="true"';
                if (link.linkId) attrs += ` data-link-id="${this.escapeHtml(link.linkId)}"`;
                if (link.title) attrs += ` title="${this.escapeHtml(link.title)}"`;
                const styleAttr = styles.length > 0 ? ` style="${styles.join("; ")}"` : "";
                html += `<span${styleAttr}${attrs}>${escapedText}</span>`;
                continue;
            }

            const styleAttr = styles.length > 0 ? ` style="${styles.join("; ")}"` : "";
            html += `<span${styleAttr}>${escapedText}</span>`;
        }

        return html;
    }

    /**
     * Resolve the buffer's segments to styled runs with concrete CSS colours,
     * for rendering to a canvas (copy-as-image). Mirrors {@link toHtml}'s colour
     * handling, including reverse-video on default colours — there the swap
     * yields no explicit colour, so we hand back the console default of the
     * opposite role for the renderer to paint.
     */
    toStyledRuns(): OutputStyledRun[] {
        const runs: OutputStyledRun[] = [];
        for (const segment of this.segments) {
            const state = segment.state;
            if (!state || isDefaultState(state)) {
                runs.push({ text: segment.text, bold: false, italic: false, underline: false });
                continue;
            }
            const overlay = state.hyperlink?.config?.style;
            const fgSrc = state.inverse ? state.background : state.foreground;
            const bgSrc = state.inverse ? state.foreground : state.background;
            const fg = overlay?.foreground ?? fgSrc;
            const bg = overlay?.background ?? bgSrc;
            let color: string | undefined;
            let background: string | undefined;
            if (fg) color = this.colorToHex(fg);
            else if (state.inverse && overlay?.foreground === undefined) color = "var(--console-bg)";
            if (bg) background = this.colorToHex(bg);
            else if (state.inverse && overlay?.background === undefined) background = "var(--console-text)";
            const underline = (overlay?.underline ?? state.underline)
                || (state.hyperlink?.autoUnderline ?? false);
            runs.push({
                text: segment.text,
                color,
                background,
                bold: overlay?.bold ?? state.bold ?? false,
                italic: overlay?.italic ?? state.italic ?? false,
                underline,
            });
        }
        return runs;
    }

    toDom(): DocumentFragment {
        const fragment = document.createDocumentFragment();
        // OSC 8 links sharing an `id=` highlight together on hover. Scoped to one
        // rendered buffer (one logical line) — the common case for split links.
        const linkGroups = new Map<string, HTMLElement[]>();
        const baseCssByEl = new WeakMap<HTMLElement, string>();
        const hoverCssByEl = new WeakMap<HTMLElement, string>();
        // A multicolour link is split into one span per colour run; these group
        // those runs into one logical link so keyboard nav steps link-by-link
        // and focus highlights the whole link, not a single run. Keyed by `id=`
        // when present, else by a per-occurrence instance (adjacent same-command
        // runs). `navGroups` collects each link's runs for the focus highlight.
        const navGroups = new Map<string, HTMLElement[]>();
        // MXP/scripted links carry no url but share one onClick reference across
        // their colour runs (setHyperlink spreads the same handler), so that ref
        // identifies the logical link.
        const onClickKeys = new Map<(ev: MouseEvent) => void, string>();
        let prevLinkKey: string | null = null;
        let currentInst = ''; // nav key of the in-progress adjacency run
        const controlCharacterMode = getControlCharacterMode();
        let column = 0;

        for (const segment of this.segments) {
            const state = segment.state;

            if (!state || isDefaultState(state)) {
                prevLinkKey = null; // plain text breaks link-run adjacency
                column = appendCells(fragment, segment.text, column, controlCharacterMode);
                continue;
            }

            const element = document.createElement('span');
            column = appendCells(element, segment.text, column, controlCharacterMode);

            const link = state.hyperlink;
            const linkStyle = link?.config?.style;
            const states = linkStyle?.states;
            const disabled = link?.config?.disabled === true;

            // Trailing decls common to every state (cursor for links, dim vars),
            // appended after the visual decls so a cssText swap preserves them.
            const trailing: string[] = [];
            if (link) trailing.push(`cursor: ${disabled ? 'default' : 'pointer'}`);
            if (state.dim) {
                trailing.push(`--dim-start: ${state.dim.startOpacity}`);
                trailing.push(`--dim-end: ${state.dim.endOpacity}`);
                trailing.push(`--dim-duration: ${state.dim.duration}ms`);
                trailing.push(`--dim-easing: ${state.dim.easing || 'ease-in-out'}`);
            }
            const cssFor = (overlay?: LinkStateStyle): string =>
                [...this.visualDecls(state, mergeLinkStyle(linkStyle, overlay)), ...trailing].join('; ');

            // A disabled link renders with its :disabled style applied up front.
            const baseCss = cssFor(disabled ? states?.disabled : undefined);
            // What actually gets applied — a spoiler starts concealed.
            let initialCss = baseCss;

            if (link) {
                element.dataset.outputClickable = 'true';
                // Focusable for Ctrl+]/Ctrl+[ link navigation, but out of the Tab
                // order (-1); the focus/spoiler paths below may promote it to 0.
                element.tabIndex = -1;
                if (link.title) element.title = link.title;
                if (link.linkId) {
                    element.dataset.linkId = link.linkId;
                    const group = linkGroups.get(link.linkId) ?? [];
                    group.push(element);
                    linkGroups.set(link.linkId, group);
                }

                // Group this run with the rest of its logical link so keyboard
                // nav and the focus highlight treat a colour-split link as one
                // unit: id= links group across the line; OSC 8 links (have a url)
                // group adjacent same-command runs; MXP/scripted links group by
                // their shared onClick; anything else is its own stop.
                let navKey: string;
                if (link.linkId) {
                    navKey = `id:${link.linkId}`;
                    prevLinkKey = null;
                } else if (link.url) {
                    const k = `u:${link.url}`;
                    if (prevLinkKey !== k) currentInst = `inst:${++navLinkSeq}`;
                    navKey = currentInst;
                    prevLinkKey = k;
                } else if (link.onClick) {
                    let k = onClickKeys.get(link.onClick);
                    if (k === undefined) { k = `cb:${++navLinkSeq}`; onClickKeys.set(link.onClick, k); }
                    navKey = k;
                    prevLinkKey = null;
                } else {
                    navKey = `inst:${++navLinkSeq}`;
                    prevLinkKey = null;
                }
                element.dataset.linkGroup = navKey;
                const navGroup = navGroups.get(navKey) ?? [];
                navGroup.push(element);
                navGroups.set(navKey, navGroup);
                // Focusing any run highlights the whole link (spans every run).
                element.addEventListener('focus', () => {
                    for (const el of navGroups.get(navKey) ?? [element]) el.classList.add('osc8-link-focused');
                });
                element.addEventListener('blur', () => {
                    for (const el of navGroups.get(navKey) ?? [element]) el.classList.remove('osc8-link-focused');
                });

                if (link.onClick) {
                    element.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        link.onClick!(e);
                    });
                }
                if (link.onContextMenu) {
                    element.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        link.onContextMenu!(e);
                    });
                }
                if (link.onMouseEnter) {
                    element.addEventListener('mouseenter', (e) => { link.onMouseEnter!(e); });
                }
                if (link.onMouseLeave) {
                    element.addEventListener('mouseleave', (e) => { link.onMouseLeave!(e); });
                }

                // Pseudo-class state styling (hover/active/focus). A disabled link
                // is inert; a spoiler owns the interaction (state swaps would
                // reveal its text early). Hover propagates across same-id runs.
                if (!disabled && states && !link.config?.spoiler) {
                    baseCssByEl.set(element, baseCss);
                    if (states.hover) hoverCssByEl.set(element, cssFor(states.hover));
                    if (states.hover || link.linkId) {
                        const peers = (): HTMLElement[] =>
                            link.linkId ? (linkGroups.get(link.linkId) ?? [element]) : [element];
                        element.addEventListener('mouseenter', () => {
                            for (const el of peers()) {
                                const h = hoverCssByEl.get(el);
                                if (h) el.style.cssText = h;
                            }
                        });
                        element.addEventListener('mouseleave', () => {
                            for (const el of peers()) {
                                const b = baseCssByEl.get(el);
                                if (b !== undefined) el.style.cssText = b;
                            }
                        });
                    }
                    if (states.active) {
                        const activeCss = cssFor(states.active);
                        element.addEventListener('mousedown', () => { element.style.cssText = activeCss; });
                        element.addEventListener('mouseup', () => { element.style.cssText = baseCss; });
                    }
                    if (states.focus) {
                        const focusCss = cssFor(states.focus);
                        element.tabIndex = 0;
                        element.addEventListener('focus', () => { element.style.cssText = focusCss; });
                        element.addEventListener('blur', () => { element.style.cssText = baseCss; });
                    }
                }

                // Selection / visited: stash the current style + its state
                // variants on the element so the link manager can restyle every
                // run of a group across the buffer when state changes (it reads
                // these data-* attributes; it doesn't recompute styling).
                const visitKey = link.url;
                if (visitKey && states?.visited) {
                    element.dataset.oscVisit = visitKey;
                    element.dataset.cssVisited = cssFor(states.visited);
                    element.dataset.cssBase = baseCss;
                }
                const sel = link.config?.selection;
                if (sel?.group !== undefined && sel.value !== undefined) {
                    element.dataset.oscGroup = sel.group;
                    element.dataset.oscValue = sel.value;
                    if (sel.exclusive) element.dataset.oscExclusive = 'true';
                    element.dataset.cssSelected = cssFor(states?.selected);
                    element.dataset.cssBase = baseCss;
                    if (sel.selected) initialCss = cssFor(states?.selected);
                }

                // Spoiler: conceal the text behind a block until the first
                // interaction reveals it. The reveal click is swallowed (capture
                // phase, before the activate handler); once revealed, clicks fall
                // through to the link's primary action. Keyboard-safe via Enter/Space.
                if (link.config?.spoiler) {
                    const fgSrc = linkStyle?.foreground ?? (state.inverse ? state.background : state.foreground);
                    const block = fgSrc ? this.colorToHex(fgSrc) : "#888888";
                    initialCss = `${baseCss}; color: transparent; background-color: ${block}`;
                    element.dataset.spoiler = "hidden";
                    let revealed = false;
                    const reveal = (): void => {
                        revealed = true;
                        element.style.cssText = baseCss;
                        element.dataset.spoiler = "shown";
                    };
                    element.addEventListener("click", (e) => {
                        if (!revealed) { e.preventDefault(); e.stopImmediatePropagation(); reveal(); }
                    }, true);
                    // Keyboard activation (Enter/Space) is routed through
                    // link.click() by the nav handler, so this click-capture
                    // reveal covers the keyboard path too — no keydown needed.
                }
            } else {
                prevLinkKey = null; // a formatted non-link run breaks adjacency
            }

            if (initialCss) element.style.cssText = initialCss;

            // Visibility wiring runs *after* cssText is set — a reveal action
            // sets `visibility: hidden`, which a later cssText assignment wipes.
            if (link?.config?.visibility) applyVisibility(element, link.config.visibility);

            const classes: string[] = [];
            if (state.cssClass) classes.push(state.cssClass);
            if (state.slowBlink) classes.push('ansi-slow-blink');
            if (state.rapidBlink) classes.push('ansi-rapid-blink');
            if (state.dim) classes.push('ansi-dim');
            if (classes.length > 0) {
                element.className = classes.join(' ');
            }

            fragment.appendChild(element);
        }

        return fragment;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    private colorToHex(color: FormatColor): string {
        if (color.space === "hex") {
            return color.color;
        }
        if (color.space === "rgb") {
            if (color.a !== undefined && color.a < 255) {
                return `rgba(${color.r}, ${color.g}, ${color.b}, ${(color.a / 255).toFixed(3)})`;
            }
            const r = color.r.toString(16).padStart(2, "0");
            const g = color.g.toString(16).padStart(2, "0");
            const b = color.b.toString(16).padStart(2, "0");
            return `#${r}${g}${b}`;
        }
        if (color.space === "indexed") {
            return colorCodes.xterm[color.index] || "#000000";
        }
        return "#000000";
    }

    private prepareStyle(styleOrIndex: number | FormatStateSnapshot): FormatStateSnapshot {
        if (typeof styleOrIndex === "number") {
            return {
                foreground: {
                    space: "indexed",
                    index: styleOrIndex,
                },
            };
        }
        return {...styleOrIndex};
    }

    private appendSegmentAtEnd(segment: BufferSegment): void {
        const last = this.segments[this.segments.length - 1];
        if (last && statesEqual(last.state, segment.state)) {
            last.text += segment.text;
        } else {
            this.segments.push({text: segment.text, state: cloneState(segment.state)});
        }
    }

    private createSegmentsFromText(
        text: string,
        explicitState?: FormatStateSnapshot,
        baseState?: FormatStateSnapshot,
    ): BufferSegment[] {
        if (!text) return [];
        if (explicitState) {
            if (text.length === 0) return [];
            return [{text, state: isDefaultState(explicitState) ? undefined : cloneState(explicitState)}];
        }
        if (!text.includes(ESC)) {
            const state = baseState && !isDefaultState(baseState) ? cloneState(baseState) : undefined;
            return [{text, state}];
        }
        return parseAnsiSegments(text, baseState);
    }

    private resolveIndex(index: number, allowEnd = false): { segmentIndex: number; offset: number } {
        this.assertIndex(index, allowEnd);
        let remaining = index;
        for (let i = 0; i < this.segments.length; i += 1) {
            const length = this.segments[i].text.length;
            if (remaining < length || (allowEnd && remaining === length)) {
                return {segmentIndex: i, offset: remaining};
            }
            remaining -= length;
        }
        return {segmentIndex: this.segments.length, offset: 0};
    }

    private resolveBoundaryIndex(index: number): number {
        const position = this.resolveIndex(index, true);
        const {segmentIndex, offset} = position;
        if (segmentIndex >= this.segments.length) {
            return this.segments.length;
        }
        if (offset <= 0) {
            return segmentIndex;
        }
        if (offset >= this.segments[segmentIndex].text.length) {
            return segmentIndex + 1;
        }
        return segmentIndex;
    }

    private inferState(index: number): FormatStateSnapshot | undefined {
        if (this.segments.length === 0) return undefined;
        if (index <= 0) return cloneState(this.segments[0].state);
        if (index >= this.length) return cloneState(this.segments[this.segments.length - 1].state);
        const before = this.resolveIndex(index - 1, true);
        const segment = this.segments[before.segmentIndex];
        if (before.offset + 1 === segment.text.length) {
            const nextSegment = this.segments[before.segmentIndex + 1];
            if (nextSegment && nextSegment.state && !segment.state) {
                return cloneState(nextSegment.state);
            }
        }
        return cloneState(segment.state);
    }

    private splitSegment(index: number, offset: number): void {
        const segment = this.segments[index];
        if (!segment) return;
        if (offset <= 0 || offset >= segment.text.length) return;
        const before: BufferSegment = {text: segment.text.slice(0, offset), state: cloneState(segment.state)};
        const after: BufferSegment = {text: segment.text.slice(offset), state: cloneState(segment.state)};
        this.segments.splice(index, 1, before, after);
    }

    private normalizeSegments(): void {
        const normalized: BufferSegment[] = [];
        for (const segment of this.segments) {
            if (!segment.text) continue;
            const state = isDefaultState(segment.state) ? undefined : cloneState(segment.state);
            const last = normalized[normalized.length - 1];
            if (last && statesEqual(last.state, state)) {
                last.text += segment.text;
            } else {
                normalized.push({text: segment.text, state});
            }
        }
        this.segments = normalized;
        this._textCache = null;
    }

    private assertRange(start: number, end: number): void {
        if (start < 0 || end < start || end > this.length) {
            throw new RangeError(`Invalid range [${start}, ${end}) for buffer of length ${this.length}`);
        }
    }

    getStateAt(index: number): FormatStateSnapshot | undefined {
        this.assertIndex(index, false);

        if (this.segments.length === 0) return undefined;

        let currentPos = 0;
        for (const segment of this.segments) {
            const segmentEnd = currentPos + segment.text.length;
            if (index >= currentPos && index < segmentEnd) {
                return cloneState(segment.state);
            }
            currentPos = segmentEnd;
        }

        return undefined;
    }

    applyMudletColors(): this {
        const originalText = this.text;
        const tagPattern = /<([a-z_:]+)>/gi;

        const MUDLET_COLORS: Record<string, FormatColor> = {};
        for (const [name, rgb] of Object.entries(mudletColorsJson)) {
            if (Array.isArray(rgb) && rgb.length >= 3) {
                MUDLET_COLORS[name.toLowerCase()] = {
                    space: 'rgb',
                    r: rgb[0],
                    g: rgb[1],
                    b: rgb[2],
                } as RgbColor;
            }
        }

        interface TagInfo {
            index: number;
            tagLength: number;
            tagName: string;
        }

        interface ParsedTag {
            type: 'fg' | 'bg' | 'reset';
            color?: FormatColor;
        }

        const parseMudletTag = (tagName: string): ParsedTag | null => {
            if (tagName === 'reset') {
                return { type: 'reset' };
            }
            if (tagName.startsWith('bg:')) {
                const colorName = tagName.substring(3);
                const color = MUDLET_COLORS[colorName.toLowerCase()];
                return color ? { type: 'bg', color } : null;
            }
            const color = MUDLET_COLORS[tagName.toLowerCase()];
            return color ? { type: 'fg', color } : null;
        };

        const tags: TagInfo[] = [];
        let match: RegExpExecArray | null;

        tagPattern.lastIndex = 0;
        while ((match = tagPattern.exec(originalText)) !== null) {
            tags.push({
                index: match.index,
                tagLength: match[0].length,
                tagName: match[1].toLowerCase()
            });
        }

        if (tags.length === 0) return this;

        for (let i = tags.length - 1; i >= 0; i--) {
            const tag = tags[i];
            this.remove([tag.index, tag.index + tag.tagLength]);
        }

        let offset = 0;
        for (let i = 0; i < tags.length; i++) {
            const tag = tags[i];
            const adjustedIndex = tag.index - offset;
            offset += tag.tagLength;

            const stateAtPosition = adjustedIndex < this.length
                ? this.getStateAt(adjustedIndex)
                : undefined;

            if (tag.tagName === 'reset') {
                const nextIndex = i < tags.length - 1 ? tags[i + 1].index - offset : this.length;
                if (nextIndex > adjustedIndex && adjustedIndex < this.length) {
                    this.color([adjustedIndex, nextIndex], stateAtPosition || {});
                }
            } else {
                const parsed = parseMudletTag(tag.tagName);
                if (parsed && parsed.type !== 'reset' && adjustedIndex < this.length) {
                    const nextIndex = i < tags.length - 1 ? tags[i + 1].index - offset : this.length;
                    if (nextIndex > adjustedIndex) {
                        const newState: FormatStateSnapshot = {
                            ...(stateAtPosition || {}),
                            ...(parsed.type === 'fg' ? { foreground: parsed.color } : {}),
                            ...(parsed.type === 'bg' ? { background: parsed.color } : {})
                        };
                        this.color([adjustedIndex, nextIndex], newState);
                    }
                }
            }
        }

        return this;
    }

    createLink(
        range: TextRange,
        options: {
            onClick?: (ev: MouseEvent) => void;
            onContextMenu?: (ev: MouseEvent) => void;
            onMouseEnter?: (ev: MouseEvent) => void;
            onMouseLeave?: (ev: MouseEvent) => void;
            title?: string;
        }
    ): this {
        const [start, end] = range;
        if (start >= end) return this;

        const text = this.text.slice(start, end);

        const hyperlink: FormatHyperlink = {
            onClick: options.onClick,
            onContextMenu: options.onContextMenu,
            onMouseEnter: options.onMouseEnter,
            onMouseLeave: options.onMouseLeave,
            title: options.title,
        };

        const currentState = this.getStateAt(start) || {};
        const newState: FormatStateSnapshot = {
            ...currentState,
            hyperlink,
        };

        this.replace([start, end], text, newState);
        return this;
    }

    createLinksForText(
        text: string,
        options: {
            onClick?: (ev: MouseEvent) => void;
            onContextMenu?: (ev: MouseEvent) => void;
            onMouseEnter?: (ev: MouseEvent) => void;
            onMouseLeave?: (ev: MouseEvent) => void;
            title?: string;
        },
        searchOptions: { caseInsensitive?: boolean } = {}
    ): this {
        if (!text) return this;

        const caseInsensitive = searchOptions.caseInsensitive ?? false;
        const ranges: TextRange[] = [];
        const bufferText = this.text;
        const haystack = caseInsensitive ? bufferText.toLowerCase() : bufferText;
        const needle = caseInsensitive ? text.toLowerCase() : text;

        let searchStart = 0;
        while (searchStart <= bufferText.length - text.length) {
            const index = haystack.indexOf(needle, searchStart);
            if (index === -1) break;
            ranges.push([index, index + text.length]);
            searchStart = index + text.length;
        }

        if (ranges.length === 0) return this;

        for (let i = ranges.length - 1; i >= 0; i--) {
            this.createLink(ranges[i], options);
        }

        return this;
    }

    private assertIndex(index: number, allowEnd: boolean): void {
        if (index < 0 || index > this.length || (!allowEnd && index >= this.length)) {
            throw new RangeError(`Index ${index} is out of bounds for buffer of length ${this.length}`);
        }
    }
}

export {cloneState as cloneFormatState, statesEqual as formatStatesEqual};

/**
 * Walks ANSI SGR escapes in `text` starting from `baseState` and returns the
 * SGR state that would apply *after* the last byte of `text`. Unlike
 * `AnsiAwareBuffer.trailingState()` (which returns the state of the last
 * non-empty text segment), this reflects the actual end-of-stream state:
 *   - empty `text` → returns `baseState`, so blank lines preserve carry
 *   - text ending in `\e[0m` → returns default (undefined), not the pre-reset color
 *   - text with no ANSI codes → returns `baseState` unchanged
 * Used to carry SGR state across line breaks the way Mudlet's TBuffer does.
 */
export function computeTrailingState(
    text: string,
    baseState?: FormatStateSnapshot,
): FormatStateSnapshot | undefined {
    const state = new FormatState(baseState);
    let i = 0;
    while (i < text.length) {
        if (text[i] === ESC) {
            const esc = scanEscape(text, i);
            if (esc.kind === "incomplete") break;
            if (esc.kind === "csi" && esc.finalByte === "m") {
                state.applySgr(parseSgrCodes(esc.params ?? ""));
            }
            // All other sequences are consumed without affecting carry state.
            i = esc.end;
            continue;
        }
        i += 1;
    }
    const snapshot = state.toSnapshot();
    return isDefaultState(snapshot) ? undefined : snapshot;
}
