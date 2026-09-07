import {
    CHARSET_ACCEPTED,
    CHARSET_REJECTED,
    CHARSET_REQUEST,
    GMCP_IAC,
    GMCP_SB,
    GMCP_SE,
    OPT_CHARSET,
} from "./constants";
import { codePageUpperHalf, VENDORED_CODE_PAGES } from "./codePages";
import { decodeMultiByte, isMultiByteFramed, type MultiByteLabel } from "./multiByte";

/**
 * CHARSET (RFC 2066, telnet option 42) negotiation and the session's byte→char
 * codec. The `SessionCodec` owns the streaming inbound decoder and the outgoing
 * encoding; the `CharsetHandler` drives the REQUEST/ACCEPTED/REJECTED exchange
 * against it. Extracted from MudClient so the wire protocol lives alongside the
 * other per-option modules in `src/mud/protocol/`.
 */

/**
 * Map a wire-format charset name (case-insensitive, with various dash/underscore
 * spellings) onto the label Mudlet Web decodes it with, or null when it is not an
 * encoding this client speaks.
 *
 * The label is not always an IANA one, because not every encoding here is the
 * browser's to decode. Three kinds come out:
 *
 *  - a lowercase TextDecoder label (`utf-8`, `iso-8859-2`, `windows-1250`,
 *    `gbk`) for the encodings the browser knows;
 *  - an uppercase code-page name (`CP437`, `MEDIEVIA`) for the ones it does not,
 *    which are decoded from the tables in codePages.ts;
 *  - `ascii`, which is neither — it is a decoder of its own, since the browser
 *    reads that label as windows-1252.
 *
 * Downstream tells them apart by the label, so the casing carries meaning.
 */
export function normalizeCharsetName(raw: string): string | null {
    const n = raw.trim().toLowerCase().replace(/_/g, '-');
    if (n === 'utf-8' || n === 'utf8') return 'utf-8';
    // ASCII is its own decoder rather than UTF-8's. It is a strict subset, so
    // UTF-8 reads plain ASCII identically — but it also reads a well-formed
    // multi-byte sequence, and a game declared ASCII has said it will not send
    // one. Mudlet substitutes for every byte with its top bit set; borrowing the
    // UTF-8 decoder would decode some of them instead.
    if (n === 'us-ascii' || n === 'ascii') return 'ascii';
    // The DOS code pages the browser has no decoder for, carried as tables. The
    // label IS the name here (upper case), which is what tells the two kinds
    // apart downstream — see SessionCodec.trySetEncoding.
    const vendored = VENDORED_CODE_PAGES.find(page => page.toLowerCase() === n);
    if (vendored) return vendored;
    // The CJK multi-byte encodings. The browser maps their characters, but the
    // sequences are framed in multiByte.ts — its header says why. BIG5-HKSCS
    // rides Big5's decoder (the browser's big5 already covers the HKSCS
    // extensions) but keeps its own name, because getServerEncoding() has to
    // answer with the name it was given.
    if (n === 'gbk') return 'gbk';
    if (n === 'gb18030') return 'gb18030';
    if (n === 'big5' || n === 'big5-hkscs') return 'big5';
    if (n === 'euc-kr' || n === 'euckr') return 'euc-kr';
    // Mudlet spells these with a space ("ISO 8859-2" — see TEncodingTable.cpp),
    // the wire and IANA with a dash, and both reach here.
    const iso = /^iso[- ]?8859-?(\d{1,2})$/.exec(n);
    if (iso) {
        // TextDecoder knows iso-8859-{2..16} (and iso-8859-1 via 'latin1').
        const part = parseInt(iso[1], 10);
        if (part >= 1 && part <= 16 && part !== 12 /* iso-8859-12 doesn't exist */) {
            return `iso-8859-${part}`;
        }
        return null;
    }
    const latin = /^latin-?(\d+)$/.exec(n);
    if (latin) {
        // "Latin-N" aliases: Latin-1 = ISO-8859-1, Latin-2 = ISO-8859-2, Latin-9 = ISO-8859-15.
        const map: Record<string, string> = { '1': 'iso-8859-1', '2': 'iso-8859-2', '9': 'iso-8859-15' };
        return map[latin[1]] ?? null;
    }
    if (/^windows-125\d$/.test(n)) return n;        // 1250..1258 all valid TextDecoder labels
    if (n === 'koi8-r' || n === 'koi8-u') return n;
    return null;
}

/** Priority order for picking among offered charsets. Earlier wins. Matches
 *  the Mudlet preference (UTF-8 first, then Polish/Russian, then Western). */
const CHARSET_PRIORITY = [
    'utf-8',
    'iso-8859-2',
    'windows-1250',
    'iso-8859-1',
    'iso-8859-15',
    'windows-1252',
    'koi8-r',
    'koi8-u',
];

/** What `getServerEncoding()` reports before anything has changed it. UTF-8
 *  rather than Mudlet's ASCII: a browser stream is far more likely to be UTF-8
 *  than not, and ASCII text reads identically either way. */
export const DEFAULT_SERVER_ENCODING = 'UTF-8';

// Spelled exactly as Mudlet spells them (TEncodingTable.cpp and the "ASCII"
// entry TLuaInterpreter::getServerEncodingsList prepends), space and all: a
// script or profile that says setServerEncoding("ISO 8859-1") is passing the
// name Mudlet's own list gave it, and a hyphen here would refuse it.
export const SUPPORTED_SERVER_ENCODINGS: readonly string[] = [
    'ASCII', 'UTF-8',
    'ISO 8859-1', 'ISO 8859-2', 'ISO 8859-3', 'ISO 8859-4', 'ISO 8859-5',
    'ISO 8859-6', 'ISO 8859-7', 'ISO 8859-8', 'ISO 8859-9', 'ISO 8859-10',
    'ISO 8859-11', 'ISO 8859-13', 'ISO 8859-14', 'ISO 8859-15', 'ISO 8859-16',
    // The DOS code pages, and Medievia's private-use map alphabet. TextDecoder
    // has none of them; codePages.ts carries the tables.
    'CP437', 'CP667', 'CP737', 'CP850', 'CP866', 'CP869', 'CP1161',
    'KOI8-R', 'KOI8-U', 'MACINTOSH', 'MEDIEVIA',
    'WINDOWS-1250', 'WINDOWS-1251', 'WINDOWS-1252', 'WINDOWS-1253', 'WINDOWS-1254',
    'WINDOWS-1255', 'WINDOWS-1256', 'WINDOWS-1257', 'WINDOWS-1258',
    // The multi-byte East Asian encodings, which the browser decodes for us.
    'GBK', 'GB18030', 'BIG5', 'BIG5-HKSCS', 'EUC-KR',
];

/** The {@link SUPPORTED_SERVER_ENCODINGS} entry a caller's spelling means, or
 *  null when Mudlet Web cannot decode it. Dash/space/case differences are all the
 *  same encoding — the profile XML, the wire, and Mudlet's own list disagree
 *  about which to use — so the answer is always the list's own spelling and
 *  `getServerEncoding()` reports one canonical name whatever was set. */
export function canonicalServerEncoding(raw: string): string | null {
    const given = String(raw ?? '').trim();
    // A name the list already carries is its own answer, checked before any
    // normalising: several entries deliberately share a decoder — BIG5 and
    // BIG5-HKSCS both read as big5 — and mapping through the decoder would
    // collapse them onto whichever is listed first, so getServerEncoding()
    // would answer with a name the caller never asked for. Spelling differences
    // that are only separators or case are the same name for this purpose.
    const key = (s: string) => s.toUpperCase().replace(/[-_ ]/g, '');
    const direct = SUPPORTED_SERVER_ENCODINGS.find(e => key(e) === key(given));
    if (direct) return direct;
    // Otherwise it is an alias — "Latin-1", "us-ascii", a wire spelling from
    // CHARSET — and the decoder it resolves to names the list entry.
    const iana = normalizeCharsetName(given);
    if (!iana) return null;
    return SUPPORTED_SERVER_ENCODINGS.find(e => normalizeCharsetName(e) === iana) ?? null;
}

/**
 * Char → byte for a single-byte encoding, built by decoding every byte value
 * with the browser's own TextDecoder. That table is the only encoding data a
 * browser exposes (TextEncoder writes UTF-8 and nothing else), and inverting it
 * is exact for the single-byte codepages above.
 */
const reverseTables = new Map<string, Map<string, number>>();

/** Byte value → character for a single-byte encoding, or null when `label`
 *  names a multi-byte one (which has no such table) or nothing at all. A
 *  vendored code page answers from codePages.ts; everything else is read out of
 *  the browser's own decoder one byte at a time. */
function forwardTable(label: string): readonly string[] | null {
    const own = singleByteDecodeTable(label);
    if (own) return own;
    if (MULTI_BYTE_LABELS.has(label)) return null;
    let decoder: TextDecoder;
    try { decoder = new TextDecoder(label, { fatal: false }); } catch { return null; }
    const chars: string[] = [];
    const one = new Uint8Array(1);
    for (let b = 0; b < 0x100; b++) {
        one[0] = b;
        chars.push(decoder.decode(one));
    }
    return chars;
}

function reverseTable(label: string): Map<string, number> | null {
    const cached = reverseTables.get(label);
    if (cached) return cached;
    const forward = forwardTable(label);
    if (!forward) return null;
    const table = new Map<string, number>();
    for (let b = 0; b < forward.length; b++) {
        const ch = forward[b];
        // U+FFFD is what a byte the encoding leaves undefined decodes to. Several
        // bytes can share it and none of them is a way to *write* a replacement
        // character, so it must not become one.
        if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, b);
    }
    reverseTables.set(label, table);
    return table;
}

/** Labels whose decoder reads more than one byte per character, so none of the
 *  single-byte table paths apply to them. */
const MULTI_BYTE_LABELS = new Set(['utf-8', 'gbk', 'gb18030', 'big5', 'euc-kr']);

/**
 * Whether every character of `text` survives a trip to the game under
 * `serverEncoding` — Mudlet's TEncodingHelper::canEncode, which is what decides
 * whether a send gets the "unlikely to understand it" warning.
 *
 * Anything Mudlet Web cannot judge (an unknown label) is called encodable: the point
 * is to warn about a loss that will certainly happen, not to guess.
 */
export function canEncodeForServer(text: string, serverEncoding: string): boolean {
    const iana = normalizeCharsetName(String(serverEncoding ?? ''));
    if (!iana) return true;
    if (iana === 'ascii') {
        for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x7f) return false;
        return true;
    }
    if (iana === 'utf-8') return true;
    // A multi-byte encoding has no single-byte table to consult and the browser
    // offers no encoder for one, so there is nothing here that could judge it.
    // Unjudgeable is encodable: the point is to warn about a loss that will
    // certainly happen, not to guess at one.
    const table = reverseTable(iana);
    if (!table) return true;
    for (const ch of text) if (!table.has(ch)) return false;
    return true;
}

/**
 * Decode a byte-string that is already in the game's encoding into text, the
 * way the inbound stream would have decoded it. This is the one-shot form of
 * {@link SessionCodec.decode} for callers holding a complete payload rather
 * than a socket frame — `feedTriggers(data, false)`, where the caller says the
 * bytes are pre-encoded and Mudlet must pass them through untouched rather than
 * reading them as UTF-8.
 *
 * An encoding Mudlet Web cannot name falls back to UTF-8, which is what the session
 * starts on; a label the browser refuses hands the bytes back unchanged rather
 * than losing them.
 */
export function decodeForServer(byteString: string, serverEncoding: string): string {
    const label = normalizeCharsetName(String(serverEncoding ?? '')) ?? 'utf-8';
    const table = singleByteDecodeTable(label);
    if (table) return decodeWithTable(byteString, table);
    // A sequence running off the end of a complete payload is truncated data,
    // not data still arriving, so its bytes are dropped rather than held —
    // which is what Mudlet does for anything that did not come off the socket.
    if (isMultiByteFramed(label)) return decodeMultiByte(byteString, label).text;
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i) & 0xff;
    try {
        return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
        return byteString;
    }
}

/** The 256-entry byte → character table for a single-byte `label`, or null when
 *  the label names a decoder the browser has to run (UTF-8 and the multi-byte
 *  East Asian set). ASCII is one of these: it has no table of its own, so it is
 *  built here as plain ASCII with a replacement character for every byte that
 *  has its top bit set — which is exactly what Mudlet substitutes. */
const singleByteTables = new Map<string, readonly string[] | null>();
function singleByteDecodeTable(label: string): readonly string[] | null {
    if (singleByteTables.has(label)) return singleByteTables.get(label) ?? null;
    let table: readonly string[] | null = null;
    const upper = label === 'ascii' ? null : codePageUpperHalf(label);
    if (label === 'ascii' || upper) {
        const chars: string[] = [];
        for (let b = 0; b < 0x80; b++) chars.push(String.fromCharCode(b));
        for (let b = 0x80; b < 0x100; b++) chars.push(upper ? upper[b - 0x80] : '�');
        table = chars;
    }
    singleByteTables.set(label, table);
    return table;
}

function decodeWithTable(byteString: string, table: readonly string[]): string {
    let out = '';
    for (let i = 0; i < byteString.length; i++) out += table[byteString.charCodeAt(i) & 0xff];
    return out;
}

/**
 * Parse an `IAC SB CHARSET REQUEST ...` subnegotiation body (leading byte is
 * the option code 42, then subcommand byte 1, then optional `[TTABLE]<ver>`
 * prefix, then a separator byte, then separator-delimited IANA names). Returns
 * the best match against {@link CHARSET_PRIORITY} with both the original wire
 * spelling (echoed back in the ACCEPTED reply per RFC 2066) and the normalized
 * IANA label suitable for `new TextDecoder(...)`. Returns null if no offered
 * name is supported.
 */
export function pickCharsetFromRequest(subneg: string): { original: string; normalized: string } | null {
    if (subneg.length < 4) return null;
    let i = 2; // skip option code (42) + subcommand (REQUEST = 1)
    // Optional `[TTABLE]<version>` prefix — skip the bracket-delimited tag and
    // the single version byte after it. We don't support translation tables;
    // we just step past the prefix so we can find the real separator.
    if (subneg.charCodeAt(i) === 0x5B /* '[' */) {
        const close = subneg.indexOf(']', i);
        if (close === -1) return null;
        i = close + 1;
        if (i >= subneg.length) return null;
        i++; // skip version byte
    }
    if (i >= subneg.length) return null;
    const sep = subneg[i];
    const list = subneg.substring(i).split(sep).filter(name => name.length > 0);
    if (list.length === 0) return null;
    // Build a lookup from normalized name → first occurrence with original spelling.
    const normalized = new Map<string, string>();
    for (const original of list) {
        const norm = normalizeCharsetName(original);
        if (norm && !normalized.has(norm)) normalized.set(norm, original);
    }
    for (const preferred of CHARSET_PRIORITY) {
        const original = normalized.get(preferred);
        if (original) return { original, normalized: preferred };
    }
    return null;
}

/**
 * The session's byte→char codec. Owns the streaming inbound `TextDecoder`
 * (holding trailing partial multi-byte chars across WebSocket frames) and the
 * matching outgoing encoding. Starts at UTF-8 — correct for ASCII and modern
 * MUDs — and switches when a CHARSET exchange (or an explicit
 * `setServerEncoding`) agrees on something else.
 */
export class SessionCodec {
    private decoder = new TextDecoder('utf-8', { fatal: false });
    /** Set instead of {@link decoder} while a single-byte encoding is in use. */
    private table: readonly string[] | null = null;
    /** Set instead of both while an encoding Mudlet Web frames itself is in use. */
    private framed: MultiByteLabel | null = null;
    /** Bytes of a framed sequence cut short by the end of a frame, waiting for
     *  the rest of it. TextDecoder holds this itself for the encodings it
     *  decodes; the framed ones need it kept here. */
    private pendingBytes = '';
    private currentEncoding = 'utf-8';

    /** The IANA name of the decoder currently applied to the inbound stream. */
    get encoding(): string {
        return this.currentEncoding;
    }

    /** Back to the UTF-8 baseline with a fresh decoder (call on connect). */
    reset(): void {
        this.decoder = new TextDecoder('utf-8', { fatal: false });
        this.table = null;
        this.framed = null;
        this.pendingBytes = '';
        this.currentEncoding = 'utf-8';
    }

    /** Swap the streaming decoder to a new encoding label (an IANA name the
     *  TextDecoder constructor accepts: 'utf-8', 'iso-8859-2', ...). Any partial
     *  multi-byte sequence buffered in the previous decoder is discarded —
     *  fine because CHARSET typically negotiates before any real content
     *  arrives. Returns false (leaving the current decoder untouched) when the
     *  browser refuses the label. */
    trySetEncoding(encoding: string): boolean {
        // A single-byte encoding is decoded from its own table rather than by a
        // TextDecoder: ASCII and the DOS code pages have no browser decoder to
        // ask for. Being single-byte, they also carry no state across frames,
        // so the streaming buffer simply does not apply to them.
        this.pendingBytes = '';
        const table = singleByteDecodeTable(encoding);
        if (table) {
            this.table = table;
            this.framed = null;
            this.currentEncoding = encoding;
            return true;
        }
        if (isMultiByteFramed(encoding)) {
            this.framed = encoding;
            this.table = null;
            this.currentEncoding = encoding;
            return true;
        }
        try {
            this.decoder = new TextDecoder(encoding, { fatal: false });
            this.table = null;
            this.framed = null;
            this.currentEncoding = encoding;
            return true;
        } catch {
            return false;
        }
    }

    /** Converts a Latin-1 byte-string into decoded text under the current
     *  encoding, buffering any trailing partial multi-byte sequence for the
     *  next frame. */
    decode(byteString: string): string {
        if (byteString.length === 0) return '';
        if (this.table) return decodeWithTable(byteString, this.table);
        if (this.framed) {
            const framed = decodeMultiByte(this.pendingBytes + byteString, this.framed);
            this.pendingBytes = framed.pending;
            return framed.text;
        }
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
            bytes[i] = byteString.charCodeAt(i) & 0xff;
        }
        return this.decoder.decode(bytes, { stream: true });
    }

    /** Convert a user-typed JS string (UTF-16) into the Latin-1 byte-string the
     *  socket layer expects, using the currently negotiated outgoing encoding.
     *  UTF-8 goes through TextEncoder so multi-byte chars survive; every other
     *  encoding here is single-byte and goes through the inverted decode table,
     *  which puts the codepage's own byte on the wire. (A plain `& 0xff`
     *  truncation used to stand in for that, and was right only for the
     *  Latin-1 range — every Polish, Cyrillic, or Greek character above it went
     *  out as a byte meaning something else entirely.) A character the codepage
     *  has no byte for becomes '?', as Qt's encoder does it — and the send path
     *  warns before it comes to that. */
    encodeOutgoing(text: string): string {
        if (this.currentEncoding === 'utf-8') {
            const bytes = new TextEncoder().encode(text);
            let out = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
            }
            return out;
        }
        const table = reverseTable(this.currentEncoding);
        if (!table) return text;
        let out = '';
        for (const ch of text) out += String.fromCharCode(table.get(ch) ?? 0x3f /* '?' */);
        return out;
    }
}

export interface CharsetHandlerHooks {
    sendRaw(data: string): void;
    /** Fired when an encoding switch takes effect. The argument is the
     *  wire-spelling name (e.g. "UTF-8") so listeners can surface it. */
    onNegotiated(displayName: string): void;
}

/**
 * Drives the CHARSET REQUEST/ACCEPTED/REJECTED exchange against a
 * {@link SessionCodec}. Negotiation methods are gated on `enabled` (the
 * per-profile CHARSET toggle); `setServerEncoding` is not — it's the explicit
 * Mudlet API call, honored regardless.
 */
export class CharsetHandler {
    constructor(
        private readonly codec: SessionCodec,
        private readonly enabled: boolean,
        private readonly hooks: CharsetHandlerHooks,
    ) {}

    /** Send `IAC SB CHARSET REQUEST ;UTF-8;ISO-8859-2;ISO-8859-1 IAC SE` —
     *  advertising the encodings we can decode, in preference order. Each name
     *  is prefixed by the separator (`;`) per RFC 2066 (the separator comes
     *  before each charset, not between them). The server replies ACCEPTED
     *  <name> or REJECTED; handleSubneg() processes either. */
    sendRequest(): void {
        if (!this.enabled) return;
        const PREFS = ['UTF-8', 'ISO-8859-2', 'ISO-8859-1'];
        const sep = ';';
        const body = OPT_CHARSET + CHARSET_REQUEST + sep + PREFS.join(sep);
        this.hooks.sendRaw(GMCP_IAC + GMCP_SB + body + GMCP_IAC + GMCP_SE);
    }

    /** Route an `IAC SB CHARSET ... IAC SE` subnegotiation body (leading byte
     *  is the option code, 42). Handles REQUEST (server lists charsets, we
     *  ACCEPT one or REJECT), ACCEPTED (server picked one of ours — switch
     *  codec), and REJECTED (server didn't like any of ours — stay put).
     *  TTABLE-* subcommands are silently ignored; almost no MUD uses them. */
    handleSubneg(subneg: string): void {
        if (!this.enabled) return;
        if (subneg.length < 2) return;
        const sub = subneg.charCodeAt(1);
        if (sub === CHARSET_REQUEST.charCodeAt(0)) {
            const chosen = pickCharsetFromRequest(subneg);
            if (!chosen) {
                this.hooks.sendRaw(GMCP_IAC + GMCP_SB + OPT_CHARSET + CHARSET_REJECTED + GMCP_IAC + GMCP_SE);
                return;
            }
            this.hooks.sendRaw(GMCP_IAC + GMCP_SB + OPT_CHARSET + CHARSET_ACCEPTED + chosen.original + GMCP_IAC + GMCP_SE);
            this.setEncoding(chosen.normalized, chosen.original);
        } else if (sub === CHARSET_ACCEPTED.charCodeAt(0)) {
            // Server accepted one of the names from our REQUEST. The body after
            // byte[1] is the chosen name verbatim.
            const name = subneg.substring(2);
            const norm = normalizeCharsetName(name);
            if (norm) this.setEncoding(norm, name);
        }
        // CHARSET_REJECTED — no action, keep current encoding.
    }

    /** Mudlet `setServerEncoding(name)`. Switch the inbound decoder to `name`
     *  (any value from getServerEncodingsList()). Returns false — leaving the
     *  current encoding untouched — when the name isn't one we can decode. */
    setServerEncoding(name: string): boolean {
        const norm = normalizeCharsetName(String(name ?? ''));
        if (!norm) return false;
        this.setEncoding(norm, String(name));
        return true;
    }

    private setEncoding(encoding: string, displayName: string): void {
        // A refused label (shouldn't happen for our allowlist) keeps the
        // existing decoder and suppresses the negotiated event.
        if (!this.codec.trySetEncoding(encoding)) return;
        this.hooks.onNegotiated(displayName);
    }
}
