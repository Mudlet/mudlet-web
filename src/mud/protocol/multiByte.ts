/**
 * Sequence framing for the East Asian multi-byte encodings.
 *
 * The browser can decode GBK, GB18030, Big5, EUC-KR, Shift_JIS and EUC-JP, and this module leans on
 * it to do so — the character tables are enormous and there is no reason to
 * carry a second copy. What it does NOT borrow is the browser's error recovery,
 * because that differs from Mudlet's in ways a MUD player would see:
 *
 *  - **How much a bad sequence eats.** Both now put a trail byte that cannot
 *    belong to the sequence back onto the stream (`C4 20 5A` under GBK renders
 *    as `<?> Z`), but Mudlet consumes a trail that is merely out of range with
 *    its lead, and frames GB18030's four-byte form its own way.
 *  - **Which bytes count as valid at all.** The two disagree on GBK 0x80, which
 *    WHATWG maps to a euro sign and Mudlet rejects, and on EUC-KR 0x7F, which
 *    WHATWG passes through as DEL and Mudlet rejects.
 *
 * So the framing here decides where each sequence starts and ends and whether
 * it is valid, using the ranges from `TBuffer::processGBSequence`,
 * `processBig5Sequence` and `processEUC_KRSequence`; a valid sequence is then
 * handed to the browser to map, and an invalid one becomes exactly one
 * replacement character however many bytes it consumed.
 *
 * Input and output are byte-strings (one char per byte), as everywhere else on
 * the inbound path.
 */

/** The encodings this module frames. UTF-8 is multi-byte too but the browser's
 *  handling of it already matches, and it is far too hot a path to re-frame. */
export type MultiByteLabel = 'gbk' | 'gb18030' | 'big5' | 'euc-kr' | 'shift_jis' | 'euc-jp';

export const MULTI_BYTE_FRAMED: ReadonlySet<string> = new Set<MultiByteLabel>(['gbk', 'gb18030', 'big5', 'euc-kr', 'shift_jis', 'euc-jp']);

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
 *
 * A byte below 0x80 cannot be a sequence's second byte: it is the game's own —
 * its line ending, a colour code's ESC, the next letter — so a pair cut short
 * by one loses only its lead byte and that byte is read afresh, as browsers do.
 * A high byte that is merely out of range is consumed with its lead.
 */
function frameAt(bytes: Uint8Array, pos: number, label: MultiByteLabel): Frame | null {
    const b1 = bytes[pos];
    const remaining = bytes.length - pos;
    const invalidPair = (b2: number): Frame => ({ length: b2 < 0x80 ? 1 : 2, valid: false });

    if (label === 'shift_jis' || label === 'euc-jp') {
        // TBuffer::processJapaneseSequence: a lead decides how many bytes
        // follow — EUC-JP's 0x8F three, its 0x8E (half-width katakana) and
        // double-byte leads two, Shift_JIS's double-byte leads two — and a byte
        // that breaks the sequence starts the next one. Any other byte stands
        // alone, read by the decoder (Shift_JIS's half-width katakana).
        if (b1 < 0x80) return { length: 1, valid: true };
        let count = 1;
        if (label === 'shift_jis') {
            if (isDoubleByteLead(b1, label)) count = 2;
        } else if (b1 === 0x8f) {
            count = 3;
        } else if (b1 === 0x8e || isDoubleByteLead(b1, label)) {
            count = 2;
        }
        for (let offset = 1; offset < count; offset++) {
            if (offset >= remaining) return null;
            const trail = bytes[pos + offset];
            const valid = label === 'euc-jp' && b1 === 0x8e ? trail >= 0xa1 && trail <= 0xdf : isDoubleByteTrail(trail, label);
            if (!valid) return { length: offset, valid: false };
        }
        return { length: count, valid: true };
    }

    if (label === 'euc-kr') {
        // Strictly below 0x7F: DEL itself is not ASCII here, it is rejected.
        if (b1 < 0x7f) return { length: 1, valid: true };
        if (b1 < 0xa1 || b1 === 0xff) return { length: 1, valid: false };
        if (remaining < 2) return null;
        const b2 = bytes[pos + 1];
        return b2 < 0xa1 || b2 === 0xff ? invalidPair(b2) : { length: 2, valid: true };
    }

    if (label === 'big5') {
        if (b1 < 0x80) return { length: 1, valid: true };
        if (b1 === 0x80 || b1 > 0xfe) return { length: 1, valid: false };
        if (remaining < 2) return null;
        const b2 = bytes[pos + 1];
        return b2 < 0x40 || (b2 > 0x7e && b2 < 0xa1) || b2 > 0xfe ? invalidPair(b2) : { length: 2, valid: true };
    }

    // GBK and GB18030 share everything but the four-byte form.
    if (b1 < 0x80) return { length: 1, valid: true };
    if (b1 === 0x80) return { length: 1, valid: false };
    if (remaining < 2) return null;
    const b2 = bytes[pos + 1];

    if (label === 'gb18030' && b1 >= 0x81 && b1 <= 0xfe && b2 >= 0x30 && b2 <= 0x39) {
        // A four-byte sequence, which is the one thing GB18030 has that GBK does
        // not. A third or fourth byte that cannot belong to it ends it at its
        // lead — the third as soon as it is seen, rather than being held for a
        // fourth that cannot help — so the digit that made it look like one is
        // shown.
        if (remaining >= 3 && (bytes[pos + 2] < 0x81 || bytes[pos + 2] === 0xff)) return { length: 1, valid: false };
        if (remaining < 4) return null;
        if (bytes[pos + 3] < 0x30 || bytes[pos + 3] > 0x39) return { length: 1, valid: false };
        // The lead-byte range is narrower than the pair test that got us here,
        // so a sequence can be framed as four bytes and still be invalid.
        return { length: 4, valid: b1 <= 0x84 || (b1 >= 0x90 && b1 <= 0xe3) };
    }

    // In GBK the lead pair of a GB18030 four-byte sequence is no character either;
    // its digit is below 0x80, so it is shown after the replacement mark.
    return isGbTwoByte(b1, b2) ? { length: 2, valid: true } : invalidPair(b2);
}

/** TBuffer::doubleByteLead: a byte that may start a full-width character, and
 *  so may be held over a colour change until its trail byte arrives. */
function isDoubleByteLead(b: number, label: MultiByteLabel): boolean {
    if (label === 'euc-kr' || label === 'euc-jp') return b >= 0xa1 && b <= 0xfe;
    if (label === 'shift_jis') return (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
    return b >= 0x81 && b <= 0xfe;
}

/** TBuffer::doubleByteTrail: the widest range of a character's second byte. */
function isDoubleByteTrail(b: number, label: MultiByteLabel): boolean {
    if (label === 'euc-kr' || label === 'euc-jp') return b >= 0xa1 && b <= 0xfe;
    if (label === 'big5') return (b >= 0x40 && b <= 0x7e) || (b >= 0xa1 && b <= 0xfe);
    if (label === 'shift_jis') return b >= 0x40 && b <= 0xfc && b !== 0x7f;
    return b >= 0x40 && b <= 0xfe && b !== 0x7f;
}

/**
 * Where the run of SGR sequences starting at `pos` ends — one or more
 * `ESC [ <parameters> m` with no intermediate byte — or -1 when `pos` does not
 * start one, or null when the input runs out inside one.
 */
function sgrRunEnd(bytes: Uint8Array, pos: number): number | null {
    let j = pos;
    while (j < bytes.length && bytes[j] === 0x1b) {
        if (j + 1 >= bytes.length) return null;
        if (bytes[j + 1] !== 0x5b) break;
        let k = j + 2;
        while (k < bytes.length && bytes[k] >= 0x30 && bytes[k] <= 0x3f) k++;
        if (k >= bytes.length) return null;
        if (bytes[k] !== 0x6d) break;
        j = k + 1;
    }
    return j === pos ? -1 : j;
}

/**
 * Decode `byteString` under `label`, framing each sequence the way Mudlet does.
 * Any trailing incomplete sequence comes back as `pending` rather than being
 * decoded or dropped.
 *
 * Some games restyle the right half of a full-width character between its two
 * bytes. Mudlet holds the lead byte over the SGR and decodes the pair whole
 * once its trail arrives, the character keeping the colour it started in; so
 * here the character comes out first and the SGR after it, which the line
 * parser then reads the same way. Any other sequence, or a byte that cannot be
 * the trail, ends the character as a replacement mark in front of it.
 */
export function decodeMultiByte(byteString: string, label: MultiByteLabel): FramedDecode {
    const decoder = decoderFor(label);
    if (!decoder) return { text: byteString, pending: '' };

    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i) & 0xff;

    // A sequence in range that the browser still cannot map comes back as a
    // replacement character; Mudlet treats that as a rejection too.
    const decodeSequence = (seq: Uint8Array): string | null => {
        const decoded = decoder.decode(seq);
        return decoded.length === 0 || decoded.includes(REPLACEMENT) ? null : decoded;
    };

    let out = '';
    let pos = 0;
    while (pos < bytes.length) {
        const b1 = bytes[pos];
        if (bytes[pos + 1] === 0x1b && isDoubleByteLead(b1, label)) {
            const sgrEnd = sgrRunEnd(bytes, pos + 1);
            if (sgrEnd === null || sgrEnd >= bytes.length) return { text: out, pending: byteString.substring(pos) };
            if (sgrEnd > 0 && isDoubleByteTrail(bytes[sgrEnd], label)) {
                const pair = Uint8Array.of(b1, bytes[sgrEnd]);
                const frame = frameAt(pair, 0, label);
                out += (frame?.valid && frame.length === 2 && decodeSequence(pair)) || REPLACEMENT;
                out += byteString.substring(pos + 1, sgrEnd);
                pos = sgrEnd + 1;
                continue;
            }
            // Not restyled by an SGR the character can be held across: its lead
            // is lost and the sequence is read as ever.
            out += REPLACEMENT;
            pos += 1;
            continue;
        }
        const frame = frameAt(bytes, pos, label);
        if (!frame) return { text: out, pending: byteString.substring(pos) };
        let length = frame.length;
        if (!frame.valid) {
            out += REPLACEMENT;
        } else if (length === 1 && b1 < 0x80) {
            out += String.fromCharCode(b1);
        } else {
            const decoded = decodeSequence(bytes.subarray(pos, pos + length));
            out += decoded ?? REPLACEMENT;
            // An unmappable pair whose second byte is ASCII loses only its lead.
            if (decoded === null && length === 2 && bytes[pos + 1] < 0x80) length = 1;
        }
        pos += length;
    }
    return { text: out, pending: '' };
}
