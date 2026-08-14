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

    // CSI — ESC [ <params/intermediates> <final 0x40-0x7E>
    if (next === "[") {
        let j = start + 2;
        while (j < n && !isCsiFinal(text[j])) j++;
        if (j >= n) return { kind: "incomplete", end: n };
        return { kind: "csi", end: j + 1, finalByte: text[j], params: text.slice(start + 2, j) };
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

/** URI schemes mudix is willing to make clickable from server output. */
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

// ── OSC 4 / 104 colour palette protocol ───────────────────────────────────
// OSC 4 redefines a palette entry: `ESC ] 4 ; index ; spec ST` (repeatable as
// `4;i1;s1;i2;s2…`). OSC 104 resets entries: `ESC ] 104 ST` clears the whole
// palette, `ESC ] 104 ; i1 ; i2 … ST` resets the listed indices. `spec` is an
// XParseColor string — `rgb:RR/GG/BB` (1–4 hex digits per channel) or
// `#RGB` / `#RRGGBB` / `#RRRRGGGGBBBB`. The query form `4;index;?` (server asks
// us to report a colour) is parsed but produces no op — we don't answer.

export type OscPaletteOp =
    | { kind: "set"; index: number; color: string }  // color is "#rrggbb"
    | { kind: "reset"; index: number }
    | { kind: "reset-all" };

/** Scale a `width`-hex-digit channel value to 8 bits, per XParseColor (each
 *  field is treated as a fraction of its max, e.g. `f` → 255, `ffff` → 255). */
function scaleHexChannel(hex: string): number {
    const max = (1 << (4 * hex.length)) - 1;
    const v = parseInt(hex, 16);
    return Math.round((v / max) * 255);
}

function toHex2(n: number): string {
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}

/**
 * Parse an XParseColor spec into a `#rrggbb` string, or null if unrecognised.
 * Handles the two forms MUDs use in practice — `rgb:r/g/b` and `#`-hex — and
 * rejects named colours and other X forms (`rgbi:`, `cmyk:`, …).
 */
export function parseXColorSpec(spec: string): string | null {
    const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(spec);
    if (rgb) {
        return `#${toHex2(scaleHexChannel(rgb[1]))}${toHex2(scaleHexChannel(rgb[2]))}${toHex2(scaleHexChannel(rgb[3]))}`;
    }
    const hash = /^#([0-9a-f]+)$/i.exec(spec);
    if (hash && hash[1].length % 3 === 0) {
        const w = hash[1].length / 3;
        if (w >= 1 && w <= 4) {
            const r = hash[1].slice(0, w), g = hash[1].slice(w, 2 * w), b = hash[1].slice(2 * w);
            return `#${toHex2(scaleHexChannel(r))}${toHex2(scaleHexChannel(g))}${toHex2(scaleHexChannel(b))}`;
        }
    }
    return null;
}

/**
 * Parse an OSC payload as an OSC 4 (set) or OSC 104 (reset) palette command.
 * Returns the ordered list of operations, or null if the payload is neither.
 * Malformed index/spec pairs are skipped rather than aborting the whole list.
 */
export function parseOscColorPalette(payload: string): OscPaletteOp[] | null {
    if (payload === "104" || payload.startsWith("104;")) {
        const rest = payload.slice(3);
        if (rest === "") return [{ kind: "reset-all" }];
        const ops: OscPaletteOp[] = [];
        for (const part of rest.split(";")) {
            if (part === "") continue;
            const idx = Number(part);
            if (Number.isInteger(idx) && idx >= 0 && idx <= 255) ops.push({ kind: "reset", index: idx });
        }
        return ops;
    }
    if (payload === "4" || payload.startsWith("4;")) {
        const fields = payload.split(";").slice(1); // drop the leading "4"
        const ops: OscPaletteOp[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
            const idx = Number(fields[i]);
            const spec = fields[i + 1];
            if (!Number.isInteger(idx) || idx < 0 || idx > 255) continue;
            if (spec === "?") continue; // query form — we don't report colours back
            const color = parseXColorSpec(spec);
            if (color) ops.push({ kind: "set", index: idx, color });
        }
        return ops;
    }
    return null;
}
