// Low-level scanner for ANSI / ECMA-48 escape sequences shared by the ANSI
// buffer parser (FormatState) and the MXP parser. A terminal must *consume*
// every control sequence it recognizes — even the ones it doesn't act on —
// rather than printing the raw bytes. Before this existed, both parsers only
// understood `ESC [ … m` (SGR) and leaked everything else (OSC hyperlinks,
// cursor moves, charset designations) onto the screen as literal text.

const ESC = "\x1b";
const BEL = "\x07";

/** CSI final bytes are 0x40–0x7E (`@`…`~`). */
export function isCsiFinal(c: string): boolean {
    const code = c.charCodeAt(0);
    return code >= 0x40 && code <= 0x7e;
}

/** CSI parameter bytes are 0x30–0x3F: the digits and separators, plus the four
 *  reserved bytes `<=>?` that are only legal as the FIRST one. */
function isCsiParameter(c: string): boolean {
    const code = c.charCodeAt(0);
    return code >= 0x30 && code <= 0x3f;
}

/** CSI intermediate bytes are 0x20–0x2F. They come after the parameters and
 *  before the final byte, and end the parameter string. */
function isCsiIntermediate(c: string): boolean {
    const code = c.charCodeAt(0);
    return code >= 0x20 && code <= 0x2f;
}

/** TBuffer's MAX_CSI_SEQUENCE_LENGTH: how long a parameter string may get
 *  before the sequence is discarded instead of acted on. Counts the parameters
 *  only — not the `ESC [` in front or the final byte behind. */
const MAX_CSI_SEQUENCE_LENGTH = 4096;

export interface EscapeScan {
    /**
     * - `csi`    — `ESC [ <params> <final>` (SGR, cursor moves, erase, …)
     * - `osc`    — `ESC ] <payload> ST` (OSC 8 hyperlinks, window title, …)
     * - `string` — DCS/SOS/PM/APC (`ESC P/X/^/_ … ST`); opaque, always ignored
     * - `esc`    — a short `ESC <intermediates> <final>` escape (charset, RIS, …)
     * - `incomplete` — the sequence runs off the end of `text`
     */
    kind: "csi" | "osc" | "string" | "esc" | "incomplete";
    /** Index one past the end of the sequence (exclusive). For `incomplete`,
     *  equals `text.length`. */
    end: number;
    /** CSI only: the final byte. */
    finalByte?: string;
    /** CSI only: the parameter + intermediate bytes between `ESC [` and the final. */
    params?: string;
    /** OSC only: the payload between `ESC ]` and the ST terminator. */
    oscPayload?: string;
}

/**
 * Scan a single escape sequence beginning at `text[start]` (which must be ESC).
 * Classifies the sequence and reports where it ends so callers can act on the
 * ones they understand and skip the rest. When the sequence is cut off by the
 * end of input the result is `incomplete` — callers either drop it or hold it
 * for the next line.
 */
export function scanEscape(text: string, start: number): EscapeScan {
    const n = text.length;
    const next = text[start + 1];
    if (next === undefined) return { kind: "incomplete", end: n };

    // CSI — ESC [ <params 0x30-0x3F> <intermediates 0x20-0x2F> <final 0x40-0x7E>
    if (next === "[") {
        let j = start + 2;
        while (j < n && isCsiParameter(text[j])) j++;
        const parametersEnd = j;
        // Then over any intermediate bytes, and the parameter bytes a malformed
        // sequence has after them ("ESC[1 m", "ESC[38;5;-1m"), or that tail would
        // reach the screen as text.
        while (j < n && (isCsiIntermediate(text[j]) || isCsiParameter(text[j]))) j++;
        const hasIntermediates = j !== parametersEnd;
        // A sequence past the cap is thrown away rather than buffered without
        // bound — a server that never sends a final byte would otherwise grow it
        // for as long as it kept typing. It counts everything ahead of the final
        // byte, intermediates included, and takes the final byte only when that
        // is what stopped the scan (TBuffer's MAX_CSI_SEQUENCE_LENGTH). Checked
        // before running off the end, so an over-long tail is never held.
        if (j - (start + 2) >= MAX_CSI_SEQUENCE_LENGTH) {
            return { kind: "csi", end: j < n && isCsiFinal(text[j]) ? j + 1 : j, params: "" };
        }
        if (j >= n) return { kind: "incomplete", end: n };
        const params = text.slice(start + 2, j);
        // Only a final byte belongs to the sequence. Whatever else cut it short —
        // an ESC, a newline, a character's lead byte — belongs to what comes
        // next: reading through it swallowed the following sequence whole, so
        // "ESC[0;4> ESC[0m text" lost its reset and printed "0m".
        if (!isCsiFinal(text[j])) return { kind: "csi", end: j, params };
        // Mudlet acts on no sequence with an intermediate byte, so one is
        // consumed with its final byte but reported without it.
        if (hasIntermediates) return { kind: "csi", end: j + 1, params };
        return { kind: "csi", end: j + 1, finalByte: text[j], params };
    }

    // OSC — ESC ] <payload> (BEL | ST). ST is the two-byte `ESC \`.
    if (next === "]") {
        let j = start + 2;
        while (j < n) {
            const c = text[j];
            if (c === BEL) return { kind: "osc", end: j + 1, oscPayload: text.slice(start + 2, j) };
            if (c === ESC && text[j + 1] === "\\") {
                return { kind: "osc", end: j + 2, oscPayload: text.slice(start + 2, j) };
            }
            j++;
        }
        return { kind: "incomplete", end: n };
    }

    // DCS / SOS / PM / APC — opaque strings terminated by BEL or ST.
    if (next === "P" || next === "X" || next === "^" || next === "_") {
        let j = start + 2;
        while (j < n) {
            const c = text[j];
            if (c === BEL) return { kind: "string", end: j + 1 };
            if (c === ESC && text[j + 1] === "\\") return { kind: "string", end: j + 2 };
            j++;
        }
        return { kind: "incomplete", end: n };
    }

    // ISO 2022 character set designation — ESC ( ) * + <designator 0x30-0x7E>.
    // The byte after the introducer names the set and is consumed with it; but
    // ONLY a byte in that range can name one, so anything else (an ESC starting
    // a fresh sequence, a multibyte lead byte, a newline) leaves the escape
    // behind as a stray and stands as text in its own right.
    if (next === "(" || next === ")" || next === "*" || next === "+") {
        const designator = text.charCodeAt(start + 2);
        if (Number.isNaN(designator)) return { kind: "incomplete", end: n };
        if (designator >= 0x30 && designator <= 0x7e) return { kind: "esc", end: start + 3 };
        return { kind: "esc", end: start + 2 };
    }

    // The complete two-byte escapes games actually send: DECSC, DECRC, RIS and
    // a stray ST. Only these — any other byte after an ESC is text, and
    // printing it is no worse than dropping the ESC alone, whereas eating it
    // loses real output (and would orphan the continuation bytes of a multibyte
    // character whose lead byte followed the escape).
    if (next === "7" || next === "8" || next === "c" || next === "\\") {
        return { kind: "esc", end: start + 2 };
    }

    // A stray ESC: consumed on its own, leaving whatever followed as text.
    return { kind: "esc", end: start + 1 };
}

/**
 * Where the escape sequence `text` leaves unfinished begins, scanning from
 * `from`, or -1 when every sequence in it is complete. Sequences are walked
 * from the start rather than from the last ESC, as an ESC inside an OSC or
 * string payload belongs to that sequence.
 */
export function unfinishedEscapeStart(text: string, from = 0): number {
    let i = text.indexOf(ESC, from);
    while (i !== -1) {
        const scan = scanEscape(text, i);
        if (scan.kind === "incomplete") return i;
        i = text.indexOf(ESC, Math.max(scan.end, i + 1));
    }
    return -1;
}

/**
 * How many spaces a `CSI n C` (CUF, cursor forward) stands for — the one cursor
 * movement Mudlet emulates (TBuffer::translateToPlainText's 'C' case, added for
 * games that column-align with it). The parameter has to read whole as a
 * positive integer (`QByteArray::toInt`): `ESC[C`, `ESC[0C` and anything like
 * `ESC[1;2C` stand for nothing and return 0.
 */
export function cursorForwardCount(params: string | undefined): number {
    if (!params) return 0;
    let n = 0;
    for (let i = 0; i < params.length; i++) {
        const d = params.charCodeAt(i) - 0x30;
        if (d < 0 || d > 9) return 0;
        n = n * 10 + d;
    }
    // Past INT_MAX toInt fails, and Mudlet ignores the sequence.
    if (n > 0x7fffffff) return 0;
    // Clamped here too, ahead of the margin {@link cursorForwardSpaces} puts
    // on it, so a caller measuring a line (visibleText) never builds a string
    // a billion spaces long either.
    return Math.min(n, MAX_CURSOR_FORWARD);
}

/** TBuffer::translateToPlainText's `rightMargin`: the column a cursor-forward
 *  stops at. See {@link cursorForwardSpaces}. */
export const MAX_CURSOR_FORWARD = 1000;

/**
 * How many spaces a cursor-forward of `count` (from {@link cursorForwardCount})
 * actually writes at `column` (the line's length so far) —
 * TBuffer::translateToPlainText's 'C' case. Like a terminal's, the cursor stops
 * at the right margin: the count comes from the game, and unbounded, one
 * sequence (or a run of them) could ask for gigabytes of spaces. The margin is
 * {@link MAX_CURSOR_FORWARD}, not the window's wrap: games send lines longer
 * than that, and the spaces have to survive the wrap that splits them.
 */
export function cursorForwardSpaces(count: number, column: number): number {
    if (count <= 0) return 0;
    return Math.max(0, Math.min(count, MAX_CURSOR_FORWARD - 1 - column));
}

// ── OSC 8 hyperlink protocol ──────────────────────────────────────────────
// https://wiki.mudlet.org/w/Manual:Supported_Protocols#OSC_8:_Hyperlink_Protocol
// and https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
//
// An OSC 8 sequence is `ESC ] 8 ; params ; URI ST` — its payload (the part
// scanEscape hands back as `oscPayload`) is therefore `8;params;URI`. A
// non-empty URI *opens* a hyperlink that applies to the text up to the closing
// `ESC ] 8 ; ; ST` (empty URI). `params` is a colon-separated list of
// `key=value` pairs; only `id` is standardised (it groups split links so a
// terminal can highlight them together on hover).

export interface Osc8Link {
    /** The link target. An empty string means "close the current hyperlink". */
    uri: string;
    /** The optional `id=` parameter, used to group multi-run links. */
    id?: string;
}

/**
 * Parse an OSC payload (the bytes between `ESC ]` and the terminator) as an
 * OSC 8 hyperlink. Returns `null` when the payload is some other OSC command
 * (window title `0;…`, clipboard `52;…`, …) or is malformed — callers then
 * treat it the same as any other ignored escape.
 */
export function parseOsc8Payload(payload: string): Osc8Link | null {
    if (!payload.startsWith("8;")) return null;
    const rest = payload.slice(2);
    const sep = rest.indexOf(";");
    if (sep === -1) return null; // need both the params and URI fields
    const params = rest.slice(0, sep);
    const uri = rest.slice(sep + 1);
    let id: string | undefined;
    if (params) {
        for (const kv of params.split(":")) {
            const eq = kv.indexOf("=");
            if (eq !== -1 && kv.slice(0, eq) === "id") id = kv.slice(eq + 1);
        }
    }
    return { uri, id };
}

/**
 * The action a clickable hyperlink performs, derived from its URI scheme. This
 * mirrors Mudlet's OSC 8 schemes — `send:`/`prompt:` drive the game, while the
 * web schemes open externally. The URI comes from an untrusted MUD server, so
 * any other scheme (`javascript:`, `data:`, `file:`, …) is rejected and the
 * link is dropped rather than made clickable.
 */
export type HyperlinkAction =
    | { kind: "send"; command: string }
    | { kind: "prompt"; command: string }
    | { kind: "url"; url: string };

/** URI schemes Mudlet Web is willing to make clickable from server output. */
export const ALLOWED_HYPERLINK_SCHEMES = ["send", "prompt", "http", "https", "ftp"] as const;

/** Percent-decode a send/prompt command, like Mudlet's `QUrl::fromPercentEncoding`,
 *  so `cast%20fireball` reaches the MUD as `cast fireball`. Malformed escapes are
 *  left as-is rather than throwing. */
export function decodePercent(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

export function classifyHyperlinkUri(uri: string): HyperlinkAction | null {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(uri);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    switch (scheme) {
        // send/prompt carry MUD commands — percent-decoded so a `%20` (or other
        // escaped byte) the server used to keep the URI well-formed becomes the
        // literal command text. Web URLs stay encoded (the browser wants them so).
        case "send": return { kind: "send", command: decodePercent(m[2]) };
        case "prompt": return { kind: "prompt", command: decodePercent(m[2]) };
        case "http":
        case "https":
        case "ftp": return { kind: "url", url: uri };
        default: return null;
    }
}

// ── Linux-console palette OSC ────────────────────────────────────────────
// The two palette commands Mudlet's TBuffer::decodeOSC obeys, both only while
// "Allow server to redefine your colors" is on:
//   `ESC ] P <i> <rr> <gg> <bb> ST` — set ANSI colour i (one hex digit, 0–f)
//   `ESC ] R ST`                    — reset the sixteen colours
// The payload is exactly the 8 characters `Pirrggbb`; any other length is
// dropped. xterm's OSC 4 / OSC 104 are NOT among them — desktop ignores those,
// so they are consumed here like any other unrecognised OSC.

export type OscPaletteOp =
    | { kind: "set"; index: number; color: string }  // color is "#rrggbb"
    | { kind: "reset" };

/** Parse an OSC payload as a Linux-console palette command, or null if it is
 *  not one (or is a malformed one). */
export function parseOscPalette(payload: string): OscPaletteOp | null {
    if (payload.startsWith("R")) return { kind: "reset" };
    if (payload.startsWith("P")) {
        const m = /^P([0-9a-f])([0-9a-f]{6})$/i.exec(payload);
        if (!m) return null;
        return { kind: "set", index: parseInt(m[1], 16), color: `#${m[2].toLowerCase()}` };
    }
    return null;
}
