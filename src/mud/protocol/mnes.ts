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
    computeMtts,
} from "./constants";
import { CLIENT_NAME, CLIENT_VERSION, TERMINAL_TYPE } from "../../version";

// NEW-ENVIRON control bytes as numeric codes for the byte-at-a-time parser.
// The command byte (right after the option code) and the structural markers
// share values — see constants.ts — but never collide because they're
// distinguished by position: command first, markers everywhere after.
const SEND = 1;     // command: server requests variables
const VAR = 0;      // marker: standard variable name follows
const VALUE = 1;    // marker: variable value follows
const ESC = 2;      // marker: next byte is literal (unescape it)
const USERVAR = 3;  // marker: user-defined variable name follows

/** A single MNES variable the client reports back, e.g. `{ name: "CHARSET",
 *  value: "UTF-8" }`.
 *
 *  A null `value` means **undefined** rather than empty. RFC 1572 draws the
 *  distinction structurally: a name followed by VALUE is defined (and, with
 *  nothing after the VALUE, defined-but-empty), while a name followed by the
 *  next marker or IAC with no VALUE at all is undefined. That is how a variable
 *  the client deliberately does not supply is answered — see
 *  {@link MNES_UNMAINTAINED}. */
export interface MnesVar {
    name: string;
    value: string | null;
}

/** Result of parsing an `IAC SB NEW-ENVIRON SEND … IAC SE` request body. */
export interface MnesRequest {
    /** True when the body is a well-formed SEND command (the only request kind
     *  a client answers). */
    isSend: boolean;
    /** Variable names the server explicitly asked for, in request order. Empty
     *  means a bare SEND — the server wants every variable we report. */
    requested: string[];
}

/** Escape a name/value per RFC 1572: any control byte that would otherwise be
 *  read as a marker (VAR/VALUE/ESC/USERVAR = 0..3) or as IAC (255) is prefixed
 *  with ESC. MNES values are ASCII in practice, so this rarely fires — but a
 *  charset name or version string is server-influenced enough to be worth
 *  doing correctly. */
function escapeEnv(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c <= 3 || c === 0xff) out += NEW_ENVIRON_ESC;
        out += s[i];
    }
    return out;
}

/**
 * Parse an `IAC SB NEW-ENVIRON SEND …` request. `subneg` is the subnegotiation
 * body with the leading option code (39) still attached (matching how the
 * telnet option parser hands bodies to the other protocol streams). The byte
 * after the option code is the command; for a server→client request it's SEND.
 * After SEND comes an optional list of `VAR <name>` / `USERVAR <name>` entries,
 * each name running until the next marker (ESC-escaped bytes pass through).
 * A bare SEND with no entries — or only empty names — means "send everything".
 */
export function parseMnesRequest(subneg: string): MnesRequest {
    if (subneg.length < 2 || subneg.charCodeAt(0) !== NEW_ENVIRON_COMMAND_CODE) {
        return { isSend: false, requested: [] };
    }
    if (subneg.charCodeAt(1) !== SEND) return { isSend: false, requested: [] };

    const requested: string[] = [];
    const n = subneg.length;
    let i = 2;
    while (i < n) {
        const marker = subneg.charCodeAt(i);
        if (marker !== VAR && marker !== USERVAR) {
            i++; // skip stray bytes between entries
            continue;
        }
        i++; // consume the VAR/USERVAR marker
        let name = "";
        while (i < n) {
            const c = subneg.charCodeAt(i);
            if (c === ESC) {
                i++;
                if (i < n) { name += subneg[i]; i++; }
                continue;
            }
            if (c === VAR || c === USERVAR || c === VALUE) break;
            name += subneg[i];
            i++;
        }
        if (name.length > 0) requested.push(name);
    }
    return { isSend: true, requested };
}

/**
 * Frame an `IAC SB NEW-ENVIRON IS <marker> <name> VALUE <value> … IAC SE` reply
 * for the given variables. The returned string is a Latin-1 byte-string ready
 * for sendBytes (names/values are ASCII; control bytes are escaped per RFC
 * 1572). `marker` selects how each variable name is tagged: `NEW_ENVIRON_VAR`
 * (the default — MNES frames every variable as a standard VAR) or
 * `NEW_ENVIRON_USERVAR` (plain NEW-ENVIRON frames its client-defined variables
 * as USERVAR, matching Mudlet). The two never mix within one reply because the
 * client reports a single coherent set per negotiated mode.
 */
export function encodeMnesIs(
    vars: ReadonlyArray<MnesVar>,
    marker: string = NEW_ENVIRON_VAR,
): string {
    let body = OPT_NEW_ENVIRON + NEW_ENVIRON_IS;
    for (const { name, value } of vars) {
        body += marker + escapeEnv(name);
        // RFC 1572: a name with no VALUE after it is undefined, which is not the
        // same as a VALUE with nothing after it (defined, and empty). Mudlet
        // answers a variable it deliberately does not maintain with the former.
        if (value !== null) body += NEW_ENVIRON_VALUE + escapeEnv(value);
    }
    return GMCP_IAC + GMCP_SB + body + GMCP_IAC + GMCP_SE;
}

/** Live client state the NEW-ENVIRON variable set is derived from. Everything
 *  here is something the server can't know on its own — the negotiated encoding,
 *  the transport's TLS status, the output window's wrap column. */
export interface NewEnvironState {
    /** The active byte→char codec label as reported for the CHARSET variable,
     *  e.g. "UTF-8" or "LATIN-1". */
    charset: string;
    /** Whether the live encoding is UTF-8 (drives the UTF-8 capability flag). */
    utf8: boolean;
    /** Whether the link to the game server is TLS-encrypted. True for a direct
     *  `wss://` connection; false in proxy mode (plaintext upstream telnet). */
    tls: boolean;
    /** Output window wrap column, or 0 when the grid hasn't been measured yet. */
    wrapColumns: number;
    /** Whether the client is advertising screen-reader use (MTTS SCREEN READER
     *  bit, NEW-ENVIRON SCREEN_READER var) — `setConfig("advertiseScreenReader", …)`.
     *  Defaults to false (matching Mudlet's opt-in behaviour). */
    screenReader?: boolean;
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
 * and layout/accessibility hints (WORD_WRAP, SCREEN_READER). Capabilities mudix
 * doesn't implement are reported honestly as "0" rather than omitted, so a
 * server gets a definite answer instead of inferring absence. The caller frames
 * the result with VAR (MNES) or USERVAR (NEW-ENVIRON) via encodeMnesIs.
 */
export function buildNewEnvironVars(
    state: NewEnvironState,
    extended: boolean,
): MnesVar[] {
    const mtts = String(computeMtts({ utf8: state.utf8, tls: state.tls, screenReader: state.screenReader }));
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
        { name: "TLS", value: state.tls ? "1" : "0" },
        { name: "WORD_WRAP", value: String(state.wrapColumns) },
        { name: "SCREEN_READER", value: state.screenReader ? "1" : "0" },
        { name: "OSC_COLOR_PALETTE", value: "1" },
        // OSC 8 hyperlinks. A flag reads "1" only once mudix actually honours
        // that part of Mudlet's OSC 8 extension; the rest stay "0" until the
        // corresponding feature lands (menus, spoilers, presets, …). Mudlet
        // reports the whole set as "1" because it implements all of them.
        ...OSC_HYPERLINK_CAPS.map(([name, value]) => ({ name, value })),
    ];
}

/** OSC 8 hyperlink capability flags and the value mudix currently reports for
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

/** MNES names the standard defines that mudix deliberately does not supply.
 *  They are still *known*, so a server that asks for one is told it is
 *  undefined rather than left with silence — Mudlet's `isMNESVariable` lists
 *  IPADDRESS alongside the five it reports, and answers it with a name and no
 *  VALUE. (A browser tab has no way to learn its own address, and the client is
 *  not the right party to guess: the server already sees the peer address.) */
export const MNES_UNMAINTAINED: ReadonlyArray<string> = ["IPADDRESS"];

/**
 * Pick which of the client's `available` variables to report in response to a
 * parsed request, mirroring Mudlet's `sendIsMNESValues` /
 * `sendIsNewEnvironValues`:
 *
 *   - A bare SEND (no names) asks for everything, and gets it.
 *   - Named variables come back in request order, each either with its value or
 *     — for a name in `undefinedNames` — as undefined (no VALUE).
 *   - A name that is neither is left out entirely.
 *
 * A request naming only names we do not report therefore selects **nothing**.
 * It used to fall back to sending everything on the reasoning that the server
 * still learns who we are, but that answers a question nobody asked: a server
 * probing for one specific variable gets an unsolicited dump of the whole set,
 * which is not what Mudlet does and not what the request meant. The caller
 * decides what an empty selection is framed as.
 */
export function selectMnesVars(
    request: MnesRequest,
    available: ReadonlyArray<MnesVar>,
    undefinedNames: ReadonlyArray<string> = [],
): MnesVar[] {
    if (request.requested.length === 0) return [...available];
    const byName = new Map(available.map((v) => [v.name, v.value] as const));
    const undefinedSet = new Set(undefinedNames);
    const picked: MnesVar[] = [];
    for (const name of request.requested) {
        const value = byName.get(name);
        if (value !== undefined) picked.push({ name, value });
        else if (undefinedSet.has(name)) picked.push({ name, value: null });
    }
    return picked;
}
