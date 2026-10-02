import {
    GMCP_IAC,
    GMCP_SB,
    GMCP_SE,
    NEW_ENVIRON_COMMAND_CODE,
    OPT_NEW_ENVIRON,
    NEW_ENVIRON_IS,
    NEW_ENVIRON_VAR,
    NEW_ENVIRON_VALUE,
    NEW_ENVIRON_ESC,
    NEW_ENVIRON_USERVAR,
    computeMtts,
} from "./constants";
import { CLIENT_NAME, CLIENT_VERSION, TERMINAL_TYPE } from "../../version";

// NEW-ENVIRON control bytes as numeric codes for the byte-at-a-time parser.
// The command byte (right after the option code) and the structural markers
// share values — see constants.ts — but never collide because they're
// distinguished by position: command first, markers everywhere after.
const SEND = 1;     // command: server requests variables
const VAR = 0;      // marker: standard variable name follows
const ESC = 2;      // marker: next byte is literal (unescape it)
const USERVAR = 3;  // marker: user-defined variable name follows

/** A single MNES variable the client reports back, e.g. `{ name: "CHARSET",
 *  value: "UTF-8" }`.
 *
 *  A null `value` means **undefined** rather than empty. RFC 1572 draws the
 *  distinction structurally: a name followed by VALUE is defined (and, with
 *  nothing after the VALUE, defined-but-empty), while a name followed by the
 *  next marker or IAC with no VALUE at all is undefined. That is how a variable
 *  the client does not supply is answered. */
export interface MnesVar {
    name: string;
    value: string | null;
}

/** Escape a name/value the way Mudlet's `cTelnet::prepareNewEnvironData` does:
 *  each byte that would otherwise read as a marker (VAR/VALUE/ESC/USERVAR =
 *  0..3) is prefixed with ESC (RFC 1572), and IAC (255) is doubled, as telnet
 *  requires inside any subnegotiation. Values are ASCII in practice, so this
 *  rarely fires — but a charset name or version string is server-influenced
 *  enough to be worth doing correctly. */
function escapeEnv(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0xff) out += GMCP_IAC;
        else if (c <= 3) out += NEW_ENVIRON_ESC;
        out += s[i];
    }
    return out;
}

/**
 * Frame an `IAC SB NEW-ENVIRON IS <marker> <name> VALUE <value> … IAC SE` reply
 * for the given variables. The returned string is a Latin-1 byte-string ready
 * for sendRaw. `marker` selects how each variable name is tagged:
 * `NEW_ENVIRON_VAR` (the default — MNES frames every variable as a standard
 * VAR) or `NEW_ENVIRON_USERVAR`. An empty list frames an empty IS.
 */
export function encodeMnesIs(
    vars: ReadonlyArray<MnesVar>,
    marker: string = NEW_ENVIRON_VAR,
): string {
    return frameIs(vars.map((v) => ({ ...v, marker })));
}

interface MarkedVar extends MnesVar {
    marker: string;
}

function frameIs(vars: ReadonlyArray<MarkedVar>): string {
    let body = OPT_NEW_ENVIRON + NEW_ENVIRON_IS;
    for (const { name, value, marker } of vars) {
        body += marker + escapeEnv(name);
        // RFC 1572: a name with no VALUE after it is undefined, which is not the
        // same as a VALUE with nothing after it (defined, and empty).
        if (value !== null) body += NEW_ENVIRON_VALUE + escapeEnv(value);
    }
    return GMCP_IAC + GMCP_SB + body + GMCP_IAC + GMCP_SE;
}

/** Live client state the NEW-ENVIRON variable set is derived from. Everything
 *  here is something the server can't know on its own — the negotiated encoding,
 *  the profile's wrap column, the advertising preferences. */
export interface NewEnvironState {
    /** The active byte→char codec label as reported for the CHARSET variable,
     *  e.g. "UTF-8" or "LATIN-1". */
    charset: string;
    /** Whether the live encoding is UTF-8 (drives the UTF-8 capability flag). */
    utf8: boolean;
    /** Whether the MTTS bitvector carries the MNES bit — Mudlet sets it when the
     *  profile has both MNES and NEW-ENVIRON enabled. Defaults to false. */
    mnes?: boolean;
    /** The main console's wrap column — Mudlet's `Host::mWrapAt`, reported as
     *  WORD_WRAP. Not the window's column count: a server wrapping to this
     *  value produces lines the client then shows unbroken. */
    wordWrap: number;
    /** Whether the client is advertising screen-reader use (MTTS SCREEN READER
     *  bit, NEW-ENVIRON SCREEN_READER var) — `setConfig("advertiseScreenReader", …)`.
     *  Defaults to false (matching Mudlet's opt-in behaviour). */
    screenReader?: boolean;
    /** Whether OSC 8 hyperlinks are enabled for this profile (Mudlet 5.0's
     *  `Host::mEnableOSC8Hyperlinks`). Every `OSC_HYPERLINKS_*` capability
     *  reports "0" while it is off, exactly as Mudlet's
     *  `cTelnet::getNewEnvironOSCHyperlinks*` do — a server that would light up
     *  its links for us must be told we won't render them. Defaults to true. */
    osc8Hyperlinks?: boolean;
}

/** The five core variables MNES standardises (https://tintin.mudhalla.net/protocols/mnes/).
 *  Plain NEW-ENVIRON reports these too, plus the extended capability set below.
 *  Client name/version/terminal type come from the shared identity module so
 *  MNES, TTYPE, GMCP `Core.Hello` and MXP can't drift apart; re-exported here
 *  because the protocol barrel and `MudClient` already source them from MNES. */
export { CLIENT_NAME, CLIENT_VERSION, TERMINAL_TYPE };

/**
 * Build the variable set the client reports for option 39. The five MNES core
 * variables (CHARSET, CLIENT_NAME, CLIENT_VERSION, MTTS, TERMINAL_TYPE) are
 * always present; when `extended` is true the broader NEW-ENVIRON capability
 * set is appended (mirroring Mudlet's `getNewEnvironDataMap`): terminal
 * capabilities (ANSI, 256_COLORS, TRUECOLOR, UTF-8), transport/security (TLS),
 * and layout/accessibility hints (WORD_WRAP, SCREEN_READER). Capabilities Mudlet Web
 * doesn't implement are reported honestly as "0" rather than omitted, so a
 * server gets a definite answer instead of inferring absence.
 *
 * TLS is "1" always: like the MTTS SSL bit (see computeMtts) it is Mudlet's
 * compiled-in capability, not the state of this link.
 */
export function buildNewEnvironVars(
    state: NewEnvironState,
    extended: boolean,
): MnesVar[] {
    const mtts = String(computeMtts({ utf8: state.utf8, mnes: state.mnes, screenReader: state.screenReader }));
    const core: MnesVar[] = [
        { name: "CHARSET", value: state.charset },
        { name: "CLIENT_NAME", value: CLIENT_NAME },
        { name: "CLIENT_VERSION", value: CLIENT_VERSION },
        { name: "MTTS", value: mtts },
        { name: "TERMINAL_TYPE", value: TERMINAL_TYPE },
    ];
    if (!extended) return core;
    return [
        ...core,
        { name: "ANSI", value: "1" },
        { name: "VT100", value: "0" },
        { name: "256_COLORS", value: "1" },
        { name: "UTF-8", value: state.utf8 ? "1" : "0" },
        { name: "TRUECOLOR", value: "1" },
        { name: "TLS", value: "1" },
        { name: "WORD_WRAP", value: String(state.wordWrap) },
        { name: "SCREEN_READER", value: state.screenReader ? "1" : "0" },
        { name: "OSC_COLOR_PALETTE", value: "1" },
        // OSC 8 hyperlinks. A flag reads "1" only once Mudlet Web actually honours
        // that part of Mudlet's OSC 8 extension; the rest stay "0" until the
        // corresponding feature lands (menus, spoilers, presets, …). Mudlet
        // reports the whole set as "1" because it implements all of them — and,
        // like Mudlet, the whole block collapses to "0" when the profile has
        // OSC 8 hyperlinks turned off.
        ...OSC_HYPERLINK_CAPS.map(([name, value]) => ({
            name,
            value: state.osc8Hyperlinks === false ? "0" : value,
        })),
    ];
}

/** OSC 8 hyperlink capability flags and the value Mudlet Web currently reports for
 *  each. Kept as one table so each phase flips its flags in a single place as
 *  the matching feature is implemented. */
const OSC_HYPERLINK_CAPS: ReadonlyArray<readonly [string, string]> = [
    ["OSC_HYPERLINKS", "1"],            // base parsing + clickable links
    ["OSC_HYPERLINKS_SEND", "1"],       // send: scheme
    ["OSC_HYPERLINKS_PROMPT", "1"],     // prompt: scheme
    ["OSC_HYPERLINKS_STYLE_BASIC", "1"],// config.style base attributes
    ["OSC_HYPERLINKS_STYLE_STATES", "1"],// :hover/:active/:focus state styling
    ["OSC_HYPERLINKS_TOOLTIP", "1"],    // config.tooltip
    ["OSC_HYPERLINKS_COMPACT", "1"],    // compact shorthand keys
    ["OSC_HYPERLINKS_PRESETS", "1"],    // preset:NAME definitions + ?preset=
    ["OSC_HYPERLINKS_DISABLED", "1"],   // config.disabled (non-clickable)
    ["OSC_HYPERLINKS_MENU", "1"],       // right-click menu
    ["OSC_HYPERLINKS_SPOILER", "1"],    // click-to-reveal
    ["OSC_HYPERLINKS_SELECTION", "1"],  // selection groups (radio/checkbox) + visited
    ["OSC_HYPERLINKS_VISIBILITY", "1"], // timed conceal/reveal + expire on input/prompt/output
];

/** The names MNES defines — Mudlet's `isMNESVariable`. IPADDRESS is among
 *  them though no client supplies it (a browser tab cannot learn its own
 *  address, and the server already sees the peer), so a request for it is
 *  answered "undefined" rather than ignored. */
export const MNES_VARIABLES: ReadonlyArray<string> = [
    "CHARSET", "CLIENT_NAME", "CLIENT_VERSION", "MTTS", "TERMINAL_TYPE", "IPADDRESS",
];

/** Mudlet holds its variables in a `QMap`, so every "send them all" reply lists
 *  them in key order. Code-unit order, as `QString::operator<` compares. */
function inKeyOrder(vars: ReadonlyArray<MnesVar>): MnesVar[] {
    return [...vars].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The request list of an `IAC SB NEW-ENVIRON SEND …` body — everything after
 *  the SEND byte — or null when the body is not a SEND (Mudlet answers nothing
 *  else). `subneg` carries the option code (39) at [0]. */
function sendList(subneg: string): string | null {
    if (subneg.length < 2 || subneg.charCodeAt(0) !== NEW_ENVIRON_COMMAND_CODE) return null;
    if (subneg.charCodeAt(1) !== SEND) return null;
    return subneg.slice(2);
}

/** Split a request list into `[marker, name]` entries, a marker being one of
 *  `delimiters`. A name before the first marker gets marker null. Every byte
 *  that is not a delimiter belongs to the current name, as in Mudlet's request
 *  loops — except that an ESC-escaped byte is taken literally (RFC 1572), which
 *  Mudlet does not do but which changes nothing for any name it knows. */
function splitRequest(list: string, delimiters: ReadonlySet<number>): Array<[number | null, string]> {
    const entries: Array<[number | null, string]> = [];
    let marker: number | null = null;
    let name = "";
    let started = false;
    for (let i = 0; i < list.length; i++) {
        const c = list.charCodeAt(i);
        if (c === ESC && i + 1 < list.length) {
            name += list[++i];
            continue;
        }
        if (delimiters.has(c)) {
            if (started || name) entries.push([marker, name]);
            marker = c;
            name = "";
            started = true;
            continue;
        }
        name += list[i];
    }
    if (started || name) entries.push([marker, name]);
    return entries;
}

const NEW_ENVIRON_DELIMITERS: ReadonlySet<number> = new Set([VAR, USERVAR]);
const MNES_DELIMITERS: ReadonlySet<number> = new Set([VAR]);

/**
 * Answer a plain NEW-ENVIRON `SEND` the way Mudlet's
 * `cTelnet::sendIsNewEnvironValues` does — one IS reply, possibly empty, or
 * null when the body is not a SEND. Every variable in `available` is a USERVAR
 * (Mudlet defines no VAR of its own while SYSTEMTYPE and USER are opt-in), so:
 *
 *  - a bare SEND lists them all, in key order;
 *  - `USERVAR` with no name lists them all, `VAR` with no name lists none;
 *  - `USERVAR <name>` gets its value; `VAR <name>` for one of ours, or either
 *    marker with a name we do not define, is echoed back with no VALUE —
 *    RFC 1572's "undefined" — rather than dropped.
 */
export function newEnvironIsReply(subneg: string, available: ReadonlyArray<MnesVar>): string | null {
    const list = sendList(subneg);
    if (list === null) return null;
    const entries = splitRequest(list, NEW_ENVIRON_DELIMITERS);
    const all = inKeyOrder(available);
    const byName = new Map(available.map((v) => [v.name, v.value] as const));
    const out: MarkedVar[] = [];
    if (entries.length === 0) {
        out.push(...all.map((v) => ({ ...v, marker: NEW_ENVIRON_USERVAR })));
        return frameIs(out);
    }
    for (const [marker, name] of entries) {
        const isUserVar = marker === USERVAR;
        const tag = isUserVar ? NEW_ENVIRON_USERVAR : NEW_ENVIRON_VAR;
        if (!name) {
            if (isUserVar) out.push(...all.map((v) => ({ ...v, marker: tag })));
            continue;
        }
        const value = byName.get(name);
        out.push({ name, value: isUserVar && value !== undefined ? value : null, marker: tag });
    }
    return frameIs(out);
}

/**
 * Answer an MNES `SEND` the way Mudlet's `cTelnet::sendIsMNESValues` does, or
 * null when the body is not a SEND. Only VAR separates names here. Each named
 * MNES variable gets an IS reply of its own (IPADDRESS as undefined), a name
 * MNES does not define gets nothing, and a request that ends without a name — a
 * bare SEND, or a trailing empty VAR — is answered with every variable in one
 * reply, after any per-name replies.
 */
export function mnesIsReplies(subneg: string, available: ReadonlyArray<MnesVar>): string[] | null {
    const list = sendList(subneg);
    if (list === null) return null;
    const entries = splitRequest(list, MNES_DELIMITERS);
    const byName = new Map(available.map((v) => [v.name, v.value] as const));
    const replies: string[] = [];
    for (const [, name] of entries) {
        if (!name || !MNES_VARIABLES.includes(name)) continue;
        replies.push(encodeMnesIs([{ name, value: byName.get(name) ?? null }]));
    }
    const last = entries[entries.length - 1];
    if (!last || !last[1]) replies.push(encodeMnesIs(inKeyOrder(available)));
    return replies;
}
