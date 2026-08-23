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
