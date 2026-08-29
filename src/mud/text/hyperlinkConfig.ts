/**
 * Mudlet OSC 8 hyperlink extension — configuration parsing.
 *
 * Mudlet extends the bare OSC 8 sequence (`ESC ] 8 ; params ; URI ST`) with a
 * rich config carried in the URI's query string:
 *
 *   send:attack?config={"style":{"color":"red","bold":true},"tooltip":"…"}
 *   send:p1?preset=btn&config={"s":{"c":"yellow"}}
 *   preset:btn?config={"s":{"bg":"#07f","c":"white","b":true}}   (definition only)
 *
 * The config is a JSON object whose keys may use a compact shorthand (`s`→`style`,
 * `c`→`color`, …). Presets are named, reusable config templates: a `preset:NAME`
 * link registers one (and renders nothing); later links reference it with
 * `?preset=NAME`, optionally layering an override `config=` on top (deep merge,
 * override wins).
 *
 * This module is the pure, side-effect-free parsing layer (plus a small preset
 * registry). It turns a URI into a normalised {@link HyperlinkConfig}; the
 * render/interaction layers consume that. Mirrors Mudlet's
 * `parseHyperlinkConfig` / `parseJsonHyperlinkConfig` / `expandJsonShorthands`
 * (src/TBuffer.cpp) and the shorthand table registered in src/TConsole.cpp.
 */

import type { FormatColor } from "./FormatState";
import { mxpColor } from "./colorParsers";
import { decodePercent } from "./ansiEscapes";

// ── Normalised config model ───────────────────────────────────────────────

export type UnderlineStyle = "solid" | "wavy" | "dotted" | "dashed";

/** Visual styling for a link in one state. Mirrors the SGR-style attributes a
 *  run can carry, expressed as already-resolved colours. */
export interface LinkStateStyle {
    foreground?: FormatColor;
    background?: FormatColor;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    underlineStyle?: UnderlineStyle;
    overline?: boolean;
    strikethrough?: boolean;
    /** `text-decoration-color` — the colour of the underline/overline/strike. */
    decorationColor?: FormatColor;
}

/** CSS-like pseudo-class states a link style can target. */
export type LinkState =
    | "hover" | "active" | "focus" | "focus-visible"
    | "visited" | "link" | "any-link" | "selected" | "disabled";

export const LINK_STATES: readonly LinkState[] = [
    "hover", "active", "focus", "focus-visible",
    "visited", "link", "any-link", "selected", "disabled",
];

/** The base style plus any per-state overrides. */
export interface HyperlinkStyling extends LinkStateStyle {
    states?: Partial<Record<LinkState, LinkStateStyle>>;
}

/** One entry in a right-click menu: either a separator or a labelled action. */
export interface MenuItem {
    separator?: boolean;
    label?: string;
    /** A command URI like `send:strike` / `prompt:cast` / `https://…`. */
    action?: string;
}

/** A menu's header line (shown above the items). */
export interface LinkTitle {
    text?: string;
    style?: LinkStateStyle;
}

export type VisibilityAction = "conceal" | "reveal" | "reveal-then-conceal";

export interface VisibilitySettings {
    action?: VisibilityAction;
    /** Delay before the action fires, in milliseconds. */
    delayMs?: number;
    deletesEntireLine?: boolean;
    expireOnInput?: boolean;
    expireOnPrompt?: boolean;
    expireOnOutput?: boolean;
    outputDelayMs?: number;
}

export interface SelectionSettings {
    group?: string;
    value?: string;
    /** Clicking toggles the selected state (default true). */
    toggle?: boolean;
    selected?: boolean;
    /** Radio-button behaviour within the group (default true); false = checkbox. */
    exclusive?: boolean;
}

/** The fully-parsed OSC 8 link configuration. Every field is optional — a bare
 *  `send:look` link parses to an empty config. */
export interface HyperlinkConfig {
    style?: HyperlinkStyling;
    tooltip?: string;
    menu?: MenuItem[];
    title?: LinkTitle;
    spoiler?: boolean;
    disabled?: boolean;
    visibility?: VisibilitySettings;
    selection?: SelectionSettings;
}

// ── Compact shorthand expansion ───────────────────────────────────────────

/** Shorthand key → full property name. Mirrors the table registered in
 *  Mudlet's TConsole.cpp. Applied recursively to every key in a config object,
 *  so `{"s":{"c":"red","h":{"u":true}}}` becomes
 *  `{"style":{"color":"red","hover":{"underline":true}}}`. */
export const HYPERLINK_SHORTHANDS: Readonly<Record<string, string>> = {
    s: "style",
    c: "color",
    bg: "bg",
    b: "bold",
    i: "italic",
    u: "underline",
    o: "overline",
    st: "strikethrough",
    tdc: "text-decoration-color",
    h: "hover",
    a: "active",
    f: "focus",
    fv: "focus-visible",
    vi: "visited",
    l: "link",
    al: "any-link",
    sl: "selected",
    m: "menu",
    t: "tooltip",
    v: "visibility",
    sel: "selection",
    sp: "spoiler",
    d: "disabled",
    ti: "title",
};

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursively expand shorthand keys to their full names. When both a shorthand
 * and its full form are present on the same object (e.g. `s` and `style`), their
 * object values are deep-merged with the shorthand taking precedence — matching
 * Mudlet's `expandJsonShorthands`.
 */
export function expandShorthands(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(expandShorthands);
    if (!isPlainObject(value)) return value;

    const result: JsonObject = {};
    // Sort keys so a shorthand (e.g. "s") is always seen before its full form
    // ("style"), making the precedence rule deterministic.
    for (const key of Object.keys(value).sort()) {
        const fullKey = HYPERLINK_SHORTHANDS[key] ?? key;
        const expanded = expandShorthands(value[key]);
        if (key in result === false && fullKey in result === false) {
            result[fullKey] = expanded;
        } else if (isPlainObject(result[fullKey]) && isPlainObject(expanded)) {
            // Collision: keep the earlier (shorthand) value's precedence.
            result[fullKey] = deepMerge(expanded, result[fullKey] as JsonObject);
        }
        // else: a non-object collision keeps the first-seen (shorthand) value.
    }
    return result;
}

/** Deep-merge two raw JSON objects; `override` wins on scalar/array collisions,
 *  objects merge recursively. Mirrors Mudlet's `mergeConfigs`. */
export function deepMerge(base: JsonObject, override: JsonObject): JsonObject {
    const out: JsonObject = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const existing = out[key];
        out[key] = isPlainObject(existing) && isPlainObject(value)
            ? deepMerge(existing, value)
            : value;
    }
    return out;
}

// ── JSON → normalised config ──────────────────────────────────────────────

function jsonBool(v: unknown): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    if (typeof v === "number") return v !== 0;
    return false;
}

function jsonColor(v: unknown): FormatColor | undefined {
    return typeof v === "string" ? (mxpColor(v) ?? undefined) : undefined;
}

const UNDERLINE_STYLES: readonly UnderlineStyle[] = ["solid", "wavy", "dotted", "dashed"];

function parseStateStyle(obj: JsonObject): LinkStateStyle {
    const style: LinkStateStyle = {};
    const fg = jsonColor(obj.color);
    if (fg) style.foreground = fg;
    const bg = jsonColor(obj.bg);
    if (bg) style.background = bg;
    if ("bold" in obj) style.bold = jsonBool(obj.bold);
    if ("italic" in obj) style.italic = jsonBool(obj.italic);
    if ("overline" in obj) style.overline = jsonBool(obj.overline);
    if ("strikethrough" in obj) style.strikethrough = jsonBool(obj.strikethrough);
    const dc = jsonColor(obj["text-decoration-color"]);
    if (dc) style.decorationColor = dc;
    if ("underline" in obj) {
        const u = obj.underline;
        if (typeof u === "string" && (UNDERLINE_STYLES as readonly string[]).includes(u)) {
            style.underline = true;
            style.underlineStyle = u as UnderlineStyle;
        } else {
            style.underline = jsonBool(u);
            if (style.underline) style.underlineStyle = "solid";
        }
    }
    return style;
}

function parseStyling(obj: JsonObject): HyperlinkStyling {
    const styling: HyperlinkStyling = parseStateStyle(obj);
    const states: Partial<Record<LinkState, LinkStateStyle>> = {};
    for (const state of LINK_STATES) {
        const v = obj[state];
        if (isPlainObject(v)) states[state] = parseStateStyle(v);
    }
    if (Object.keys(states).length > 0) styling.states = states;
    return styling;
}

function parseMenu(arr: unknown[]): MenuItem[] {
    const items: MenuItem[] = [];
    for (const entry of arr) {
        if (entry === "-") {
            items.push({ separator: true });
        } else if (isPlainObject(entry)) {
            // A single { label: action } pair.
            const keys = Object.keys(entry);
            if (keys.length >= 1) {
                const label = keys[0];
                const action = entry[label];
                items.push({ label, action: typeof action === "string" ? action : undefined });
            }
        }
    }
    return items;
}

function parseTitle(v: unknown): LinkTitle | undefined {
    if (typeof v === "string") return { text: v };
    if (isPlainObject(v)) {
        const title: LinkTitle = {};
        if (typeof v.text === "string") title.text = v.text;
        if (isPlainObject(v.style)) title.style = parseStateStyle(v.style);
        return title;
    }
    return undefined;
}

function parseVisibility(obj: JsonObject): VisibilitySettings {
    const vis: VisibilitySettings = {};
    const action = obj.action;
    if (action === "conceal" || action === "reveal" || action === "reveal-then-conceal") {
        vis.action = action;
    }
    if (typeof obj.delay === "number") vis.delayMs = obj.delay;
    if ("deleteLine" in obj) vis.deletesEntireLine = jsonBool(obj.deleteLine);
    if (typeof obj.outputDelay === "number") vis.outputDelayMs = obj.outputDelay;
    const expire = obj.expire;
    if (isPlainObject(expire)) {
        if ("input" in expire) vis.expireOnInput = jsonBool(expire.input);
        if ("prompt" in expire) vis.expireOnPrompt = jsonBool(expire.prompt);
        if ("output" in expire) vis.expireOnOutput = jsonBool(expire.output);
    }
    return vis;
}

function parseSelection(obj: JsonObject): SelectionSettings {
    const sel: SelectionSettings = {};
    if (typeof obj.group === "string") sel.group = obj.group;
    if (typeof obj.value === "string") sel.value = obj.value;
    sel.toggle = "toggle" in obj ? jsonBool(obj.toggle) : true;
    sel.exclusive = "exclusive" in obj ? jsonBool(obj.exclusive) : true;
    if ("selected" in obj) sel.selected = jsonBool(obj.selected);
    return sel;
}

/**
 * Normalise an already-shorthand-expanded config object into a
 * {@link HyperlinkConfig}. Unknown keys are ignored; malformed values are
 * skipped rather than throwing (a partially-valid config still applies).
 */
export function normaliseHyperlinkConfig(root: JsonObject): HyperlinkConfig {
    const config: HyperlinkConfig = {};
    if (isPlainObject(root.style)) config.style = parseStyling(root.style);
    if (typeof root.tooltip === "string") config.tooltip = root.tooltip;
    if (Array.isArray(root.menu)) config.menu = parseMenu(root.menu);
    if ("title" in root) {
        const title = parseTitle(root.title);
        if (title) config.title = title;
    }
    if ("spoiler" in root) config.spoiler = jsonBool(root.spoiler);
    if ("disabled" in root) config.disabled = jsonBool(root.disabled);
    if (isPlainObject(root.visibility)) config.visibility = parseVisibility(root.visibility);
    if (isPlainObject(root.selection)) config.selection = parseSelection(root.selection);
    return config;
}

/** Parse a raw config JSON string (shorthand-allowed) into a normalised config,
 *  or null if the JSON is invalid / not an object. */
export function parseConfigJson(json: string): HyperlinkConfig | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    return normaliseHyperlinkConfig(expandShorthands(parsed) as JsonObject);
}

// ── URI query extraction ──────────────────────────────────────────────────

/** The reserved query keys mudix consumes (and strips from outgoing URLs). */
const RESERVED_PARAMS = new Set(["config", "preset"]);

interface ExtractedQuery {
    /** The URI up to (not including) the first `?`. */
    base: string;
    /** The raw `config={…}` JSON body, if present. */
    configJson?: string;
    /** The `preset=NAME` value, if present. */
    presetName?: string;
    /** Non-reserved query pairs, in original order/encoding (for http links). */
    userPairs: string[];
}

/**
 * Split a URI into its base and the reserved/user query parts. `config={…}` is
 * located by brace-matching (its JSON value may contain `&`), mirroring
 * Mudlet's hand-rolled scan; everything else is `&`-delimited `key=value`.
 */
export function extractQuery(uri: string): ExtractedQuery {
    const q = uri.indexOf("?");
    if (q === -1) return { base: uri, userPairs: [] };
    const base = uri.slice(0, q);
    let rest = uri.slice(q + 1);

    let configJson: string | undefined;
    let presetName: string | undefined;
    const userPairs: string[] = [];

    while (rest.length > 0) {
        if (rest.startsWith("config={")) {
            const end = matchBraces(rest, "config=".length);
            if (end === -1) {
                configJson = rest.slice("config=".length); // malformed — take the rest
                rest = "";
            } else {
                configJson = rest.slice("config=".length, end);
                rest = rest[end] === "&" ? rest.slice(end + 1) : rest.slice(end);
            }
            // A server may percent-encode the JSON body only partially (quotes
            // escaped, braces literal). Decode when the literal text isn't valid
            // JSON but its decoded form is.
            configJson = decodeIfEncoded(configJson);
            continue;
        }
        if (rest.startsWith("config=")) {
            // Percent-encoded config (`config=%7B%22style%22…`). An encoded body
            // cannot contain a raw `&`, so the value ends at the next separator
            // and brace-matching isn't needed.
            const value = rest.slice("config=".length);
            const amp = value.indexOf("&");
            const raw = amp === -1 ? value : value.slice(0, amp);
            rest = amp === -1 ? "" : value.slice(amp + 1);
            const decoded = decodePercent(raw);
            if (decoded.startsWith("{")) configJson = decoded;
            continue;
        }
        const amp = rest.indexOf("&");
        const pair = amp === -1 ? rest : rest.slice(0, amp);
        rest = amp === -1 ? "" : rest.slice(amp + 1);
        if (pair === "") continue;
        const eq = pair.indexOf("=");
        const key = eq === -1 ? pair : pair.slice(0, eq);
        if (key === "preset") {
            presetName = eq === -1 ? "" : pair.slice(eq + 1);
        } else if (!RESERVED_PARAMS.has(key)) {
            userPairs.push(pair);
        }
    }
    return { base, configJson, presetName, userPairs };
}

/** Return `json` unchanged when it already parses, otherwise its percent-decoded
 *  form when that parses instead. Handles servers that escape the config body
 *  (fully or in part) to keep the URI well-formed. */
function decodeIfEncoded(json: string): string {
    if (!json.includes("%")) return json;
    try {
        JSON.parse(json);
        return json;
    } catch {
        const decoded = decodePercent(json);
        try {
            JSON.parse(decoded);
            return decoded;
        } catch {
            return json;
        }
    }
}

/** Find the index just past the `}` that closes the brace opened at `from`
 *  (which must point at `{`), respecting JSON string quoting. Returns -1 if
 *  unbalanced. */
function matchBraces(s: string, from: number): number {
    let depth = 0, inString = false, escaped = false;
    for (let i = from; i < s.length; i++) {
        const ch = s[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

// ── Enable/disable gate ───────────────────────────────────────────────────

// Mudlet 5.0's `Host::mEnableOSC8Hyperlinks` (default on). The ANSI parser runs
// with no access to profile settings, so the gate lives here as a single
// module-level flag — the same shape as colors.ts's server-redefine gate, and
// for the same reason. Set from ProfileSession per profile; read by
// parseAnsiSegments when an OSC 8 sequence *opens* a link, and by the
// NEW-ENVIRON capability block.
let osc8HyperlinksEnabled = true;

/** Enable/disable OSC 8 hyperlink parsing (Mudlet `mEnableOSC8Hyperlinks`). */
export function setOsc8HyperlinksEnabled(enabled: boolean): void {
    osc8HyperlinksEnabled = enabled;
}

/** Whether OSC 8 hyperlinks are currently honoured. */
export function isOsc8HyperlinksEnabled(): boolean {
    return osc8HyperlinksEnabled;
}

// ── Preset registry ───────────────────────────────────────────────────────

/** Session-scoped store of `preset:NAME` definitions. Holds raw config objects
 *  (shorthand un-expanded, as Mudlet does) so a later `?preset=NAME` can deep-
 *  merge an override before expansion. */
export class HyperlinkPresetRegistry {
    private presets = new Map<string, JsonObject>();

    register(name: string, rawConfig: JsonObject): void {
        if (name) this.presets.set(name, rawConfig);
    }

    get(name: string): JsonObject | undefined {
        return this.presets.get(name);
    }

    clear(): void {
        this.presets.clear();
    }
}

// ── Top-level URI parsing ─────────────────────────────────────────────────

export type Osc8UriResult =
    /** A `preset:NAME` definition was registered; renders nothing. */
    | { kind: "preset"; name: string }
    /** A normal link. `command` is the cleaned URI (reserved params stripped)
     *  to hand to scheme classification; `config` is the resolved config. */
    | { kind: "link"; command: string; config: HyperlinkConfig };

/**
 * Parse a full OSC 8 URI (the part after the `8;params;` framing) into either a
 * preset definition or a resolved link. `registry` supplies/receives preset
 * definitions. Returns null for an empty/whitespace URI.
 *
 * - `preset:NAME?config={…}` registers NAME (raw) and returns a `preset` result.
 * - Otherwise the base command is cleaned: send:/prompt: drop all query params;
 *   http/https/ftp keep user params but strip `config`/`preset`. The config is
 *   resolved as `deepMerge(preset, override)` → expand shorthands → normalise.
 */
export function parseOsc8Uri(uri: string, registry: HyperlinkPresetRegistry): Osc8UriResult | null {
    if (uri.trim() === "") return null;

    if (uri.startsWith("preset:")) {
        const q = uri.indexOf("?");
        const name = q === -1 ? uri.slice("preset:".length) : uri.slice("preset:".length, q);
        const { configJson } = extractQuery(uri);
        if (name && configJson) {
            try {
                const obj = JSON.parse(configJson);
                if (isPlainObject(obj)) registry.register(name, obj);
            } catch {
                // ignore malformed preset definition
            }
        }
        return { kind: "preset", name };
    }

    const { base, configJson, presetName, userPairs } = extractQuery(uri);

    // Rebuild the command URI handed to scheme classification.
    let command = base;
    const isWeb = /^(https?|ftp):/i.test(base);
    if (isWeb && userPairs.length > 0) command = `${base}?${userPairs.join("&")}`;
    // send:/prompt: already dropped their query by using `base`.

    // Resolve config: preset base (raw) merged with override (raw), then expand.
    let raw: JsonObject = {};
    if (presetName) {
        const preset = registry.get(presetName);
        if (preset) raw = preset;
    }
    if (configJson) {
        try {
            const override = JSON.parse(configJson);
            if (isPlainObject(override)) raw = deepMerge(raw, override);
        } catch {
            // ignore malformed override; keep preset (if any)
        }
    }
    const config = normaliseHyperlinkConfig(expandShorthands(raw) as JsonObject);
    return { kind: "link", command, config };
}
