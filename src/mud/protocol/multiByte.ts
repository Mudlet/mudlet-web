/**
 * Sequence framing for the East Asian multi-byte encodings.
 *
 * The browser can decode GBK, GB18030, Big5 and EUC-KR, and this module leans on
 * it to do so — the character tables are enormous and there is no reason to
 * carry a second copy. What it does NOT borrow is the browser's error recovery,
 * because that differs from Mudlet's in ways a MUD player would see:
 *
 *  - **How much a bad sequence eats.** The WHATWG decoders "prepend" the
 *    offending trail byte back onto the stream, so `C4 20 5A` under GBK renders
 *    as `<?> Z` — the space reappears as text. Mudlet consumes the whole pair
 *    and renders `<?>Z`. On a game that mixes encodings mid-line (which is why
 *    anyone hits this at all) the browser's version sprays stray punctuation
 *    through the output.
 *  - **Which bytes count as valid at all.** The two disagree on GBK 0x80, which
 *    WHATWG maps to a euro sign and Mudlet rejects, and on EUC-KR 0x7F, which
 *    WHATWG passes through as DEL and Mudlet rejects.
 *
 * So the framing here decides where each sequence starts and ends and whether
 * it is valid, using the ranges from `TBuffer::processGBSequence`,
 * `processBig5Sequence` and `processEUC_KRSequence`; a valid sequence is then
 * handed to the browser to map, and an invalid one becomes exactly one
 * replacement character however many bytes it spanned.
 *
 * Input and output are byte-strings (one char per byte), as everywhere else on
 * the inbound path.
 */

/** The encodings this module frames. UTF-8 is multi-byte too but the browser's
 *  handling of it already matches, and it is far too hot a path to re-frame. */
export type MultiByteLabel = 'gbk' | 'gb18030' | 'big5' | 'euc-kr';

export const MULTI_BYTE_FRAMED: ReadonlySet<string> = new Set<MultiByteLabel>(['gbk', 'gb18030', 'big5', 'euc-kr']);

export function isMultiByteFramed(label: string): label is MultiByteLabel {
    return MULTI_BYTE_FRAMED.has(label);
}

export interface FramedDecode {
    /** What the complete sequences in the input decoded to. */
    text: string;
    /** Bytes of a sequence that ran off the end of the input, for the caller to
     *  put back in front of the next chunk. Empty unless the input was cut
     *  mid-sequence. */
    pending: string;
}

const REPLACEMENT = '�';

/** One decoder per encoding, reused across calls — each is handed a single
 *  already-framed sequence, so it needs no streaming state of its own. */
const decoders = new Map<string, TextDecoder>();
function decoderFor(label: MultiByteLabel): TextDecoder | null {
    const cached = decoders.get(label);
    if (cached) return cached;
    try {
        const made = new TextDecoder(label, { fatal: false });
        decoders.set(label, made);
        return made;
    } catch {
        return null;
    }
}

/** How a lead byte (and what follows it) is to be read. */
interface Frame {
    /** Bytes this sequence spans. */
    length: number;
    /** False when the bytes are in no range the encoding defines. */
    valid: boolean;
}

// ── GBK / GB18030 two-byte areas ──────────────────────────────────────────────
// Straight from the range deductions in TBuffer::processGBSequence, which takes
// them from https://en.wikipedia.org/wiki/GBK#Encoding. The 0x7F exclusions are
// real: several areas run through a range that carves out DEL.
function isGbTwoByte(b1: number, b2: number): boolean {
    // Area 3
    if (b1 >= 0x81 && b1 <= 0xA0 && b2 >= 0x40 && b2 <= 0xFE && b2 !== 0x7F) return true;
    // Area 1 (and GB2312)
    if (b1 >= 0xA1 && b1 <= 0xA9 && b2 >= 0xA1 && b2 <= 0xFE) return true;
    // Area 2 (and GB2312)
    if (b1 >= 0xB0 && b1 <= 0xF7 && b2 >= 0xA1 && b2 <= 0xFE) return true;
    // Area 5
    if (b1 >= 0xA8 && b1 <= 0xA9 && b2 >= 0x40 && b2 <= 0xA0 && b2 !== 0x7F) return true;
    // Area 4
    if (b1 >= 0xAA && b1 <= 0xFE && b2 >= 0x40 && b2 <= 0xA0 && b2 !== 0x7F) return true;
    // User-defined areas 1-3. Not characters this client can draw on its own,
    // but a game shipping its own font uses them, so they are passed through.
    if (b1 >= 0xAA && b1 <= 0xAF && b2 >= 0xA1 && b2 <= 0xFE) return true;
    if (b1 >= 0xF8 && b1 <= 0xFE && b2 >= 0xA1 && b2 <= 0xFE) return true;
    if (b1 >= 0xA1 && b1 <= 0xA7 && b2 >= 0xA1 && b2 <= 0xFE && b2 !== 0x7F) return true;
    return false;
}

/**
 * Frame the sequence starting at `pos`, or null when the input ends before the
 * sequence does (the caller carries those bytes into the next chunk).
 */
function frameAt(bytes: Uint8Array, pos: number, label: MultiByteLabel): Frame | null {
    const b1 = bytes[pos];
    const remaining = bytes.length - pos;

    if (label === 'euc-kr') {
        // Strictly below 0x7F: DEL itself is not ASCII here, it is rejected.
        if (b1 < 0x7f) return { length: 1, valid: true };
        if (b1 < 0xa1 || b1 === 0xff) return { length: 1, valid: false };
        if (remaining < 2) return null;
        const b2 = bytes[pos + 1];
        return { length: 2, valid: !(b2 < 0xa1 || b2 === 0xff) };
    }

    if (label === 'big5') {
        if (b1 < 0x80) return { length: 1, valid: true };
        if (b1 === 0x80 || b1 > 0xfe) return { length: 1, valid: false };
        if (remaining < 2) return null;
        const b2 = bytes[pos + 1];
        return { length: 2, valid: !(b2 < 0x40 || (b2 > 0x7e && b2 < 0xa1) || b2 > 0xfe) };
    }

    // GBK and GB18030 share everything but the four-byte form.
    if (b1 < 0x80) return { length: 1, valid: true };
    if (b1 === 0x80) return { length: 1, valid: false };
    if (remaining < 2) return null;
    const b2 = bytes[pos + 1];

    if (label === 'gb18030' && b1 >= 0x81 && b1 <= 0xfe && b2 >= 0x30 && b2 <= 0x39) {
        // A four-byte sequence, which is the one thing GB18030 has that GBK does
        // not. The lead-byte range is narrower than the pair test that got us
        // here, so a sequence can be framed as four bytes and still be invalid.
        if (remaining < 4) return null;
        const b3 = bytes[pos + 2];
        const b4 = bytes[pos + 3];
        const leadOk = b1 <= 0x84 || (b1 >= 0x90 && b1 <= 0xe3);
        return { length: 4, valid: leadOk && b3 >= 0x81 && b3 <= 0xfe && b4 >= 0x30 && b4 <= 0x39 };
    }

    if (label === 'gbk') {
        // In GBK the lead pair of a GB18030 four-byte sequence is not a
        // character, and rejecting it as a pair (rather than letting it fall
        // through to the area tests) is what keeps the trailing digit from
        // being printed as text.
        const looksFourByte = ((b1 >= 0x90 && b1 <= 0xe3) || (b1 >= 0xfd && b1 <= 0xfe))
            && b2 >= 0x30 && b2 <= 0x39;
        if (looksFourByte) return { length: 2, valid: false };
    }

    return { length: 2, valid: isGbTwoByte(b1, b2) };
}

/**
 * Decode `byteString` under `label`, framing each sequence the way Mudlet does.
 * Any trailing incomplete sequence comes back as `pending` rather than being
 * decoded or dropped.
 */
export function decodeMultiByte(byteString: string, label: MultiByteLabel): FramedDecode {
    const decoder = decoderFor(label);
    if (!decoder) return { text: byteString, pending: '' };

    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i) & 0xff;

    let out = '';
    let pos = 0;
    while (pos < bytes.length) {
        const frame = frameAt(bytes, pos, label);
        if (!frame) return { text: out, pending: byteString.substring(pos) };
        if (!frame.valid) {
            out += REPLACEMENT;
        } else if (frame.length === 1) {
            out += String.fromCharCode(bytes[pos]);
        } else {
            const decoded = decoder.decode(bytes.subarray(pos, pos + frame.length));
            // A sequence in range that the browser still cannot map comes back
            // as a replacement character; Mudlet treats that as a rejection
            // too, so the two agree on how many marks appear.
            out += decoded.length === 0 ? REPLACEMENT : decoded;
        }
        pos += frame.length;
    }
    return { text: out, pending: '' };
}
