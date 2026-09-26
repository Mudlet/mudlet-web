/**
 * Transcoding between the wire and JS strings, for the protocol handlers that
 * carry UTF-8 text inside a telnet subnegotiation (GMCP, MSDP, MSSP).
 *
 * Everything upstream of these speaks *byte-strings*: `bytesToLatin1` in
 * `MudClient.ts` maps each socket byte to one char, and the client's `sendBytes`
 * reverses it with `charCodeAt(i) & 0xff`. Subnegotiations are extracted from that byte-string
 * before the session codec ever runs (`stripTelnetSequences` precedes
 * `codec.decode`), which is what makes these three protocols independent of the
 * session's text encoding — and what obliges each of them to do its own
 * transcoding here.
 */

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

export interface DecodedByteString {
    text: string;
    /** The bytes weren't valid UTF-8, so `text` contains U+FFFD where they were.
     *  Callers that can report it should; nothing downstream is able to notice,
     *  since the substitution is indistinguishable from a legitimate U+FFFD. */
    malformed: boolean;
}

/** Decode a Latin-1 byte-string (one char per byte, as produced upstream) as
 *  UTF-8. Decoding is lenient by design — a replacement character in one field
 *  beats dropping the whole message — but a strict pass runs first so the
 *  caller can tell the two apart and say so. */
export const fromByteString = (s: string): DecodedByteString => {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    try {
        return { text: utf8StrictDecoder.decode(bytes), malformed: false };
    } catch {
        return { text: utf8Decoder.decode(bytes), malformed: true };
    }
};

/** UTF-8-encode into a Latin-1 byte-string, for `MudClient.sendBytes`. Inverse
 *  of {@link fromByteString} for well-formed input only — both directions are
 *  non-fatal, so invalid UTF-8 inbound and lone surrogates outbound each
 *  collapse to U+FFFD rather than round-tripping. Plain ASCII is unchanged. */
export const toByteString = (s: string): string => {
    const bytes = utf8Encoder.encode(s);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
};

/** Render a byte-string as hex, for diagnostics that would otherwise print the
 *  post-decode text — where every malformed sequence has already collapsed to
 *  an indistinguishable U+FFFD. Truncated: the head is where the fault is. */
export const toHex = (s: string): string => {
    const shown = [...s.slice(0, 64)].map(c => (c.charCodeAt(0) & 0xff).toString(16).padStart(2, "0"));
    return shown.join(" ") + (s.length > 64 ? " …" : "");
};

/** Decode a byte-string as UTF-8 the way Mudlet's `TBuffer::processUtf8Sequence`
 *  does, for text that reaches the buffer without cTelnet in front of it
 *  (`feedTriggers` under UTF-8 hands its bytes straight to the buffer). It
 *  differs from the WHATWG decoder in how much a bad sequence eats: the lead
 *  byte declares a length, and a malformed sequence — bad continuation,
 *  overlong, surrogate, past U+10FFFF, 5/6-byte — becomes ONE replacement mark
 *  spanning all of it, where WHATWG re-reads the offending byte as the start of
 *  something new. That is what makes a carriage return after a truncated lead
 *  byte part of the rejected sequence instead of a line ending. A UTF-8 BOM
 *  arrives as U+FEFF rather than vanishing. A sequence cut short by the end of
 *  the input keeps the lenient decoder's answer, as before. */
export const decodeUtf8AsTBuffer = (s: string): string => {
    const n = s.length;
    const byte = (i: number) => s.charCodeAt(i) & 0xff;
    let out = "";
    let run = 0; // start of the pending ASCII run, copied in bulk
    let i = 0;
    while (i < n) {
        const b0 = byte(i);
        if (b0 < 0x80) { i++; continue; }
        out += s.substring(run, i);
        const len = (b0 & 0xe0) === 0xc0 ? 2
            : (b0 & 0xf0) === 0xe0 ? 3
            : (b0 & 0xf8) === 0xf0 ? 4
            : (b0 & 0xfc) === 0xf8 ? 5
            : (b0 & 0xfe) === 0xfc ? 6
            : 1;
        if (i + len > n) {
            out += fromByteString(s.substring(i)).text;
            return out;
        }
        let valid = len >= 2 && len <= 4;
        for (let k = 1; valid && k < len; k++) {
            if ((byte(i + k) & 0xc0) !== 0x80) valid = false;
        }
        let bom = false;
        if (valid) {
            const b1 = byte(i + 1);
            if ((b0 & 0xfe) === 0xc0 || (b0 === 0xe0 && (b1 & 0xe0) === 0x80) || (b0 === 0xf0 && (b1 & 0xf0) === 0x80)) {
                valid = false; // overlong
            } else if (len === 3 && (b0 & 0x0f) === 0x0d && (b1 & 0x20) === 0x20) {
                valid = false; // UTF-16 surrogate
            } else if (len === 4 && ((b0 & 0x07) > 0x04 || ((b0 & 0x07) === 0x04 && (b1 & 0x3f) > 0x0f))) {
                valid = false; // past U+10FFFF
            } else if (len === 3 && b0 === 0xef && b1 === 0xbb && byte(i + 2) === 0xbf) {
                bom = true;
            }
        }
        if (bom) {
            out += "\uFEFF";
        } else if (valid) {
            let cp = b0 & (len === 2 ? 0x1f : len === 3 ? 0x0f : 0x07);
            for (let k = 1; k < len; k++) cp = (cp << 6) | (byte(i + k) & 0x3f);
            out += String.fromCodePoint(cp);
        } else {
            out += "\uFFFD";
        }
        i += len;
        run = i;
    }
    return out + s.substring(run);
};
