/**
 * Char → bytes for the East Asian multi-byte encodings, the outgoing half of
 * multiByte.ts.
 *
 * The browser decodes GBK, GB18030, Big5 and EUC-KR but will not encode them —
 * TextEncoder writes UTF-8 and nothing else. So the encode tables are built by
 * running every sequence the encoding defines through the browser's own
 * decoder and inverting the result, exactly as the single-byte tables in
 * charset.ts are. That keeps the two directions in agreement by construction
 * and spares carrying a second copy of tables the browser already has.
 *
 * Which sequences get enumerated follows the inbound framing in multiByte.ts
 * (Mudlet's TBuffer ranges), so nothing is written that this client would not
 * itself read back:
 *
 *  - **GBK / GB18030**: every lead 0x81–0xFE with every trail 0x40–0xFE bar
 *    0x7F. GB18030 adds its four-byte form — the BMP part enumerated like the
 *    pairs, the supplementary planes computed, since they are a straight line.
 *    The single byte 0x80, which WHATWG's GBK reads as a euro sign and Mudlet
 *    rejects, is never written; € goes out as its pair, A2 E3.
 *  - **Big5**: leads 0xA1–0xFE with trails 0x40–0x7E and 0xA1–0xFE. The HKSCS
 *    leads below 0xA1 are only written for BIG5-HKSCS; a plain Big5 game has
 *    no reading for them, so there a character found only there is unencodable
 *    and the send path warns about it. Where one character has two codes, the
 *    first wins (as in the WHATWG Big5 encoder, with the same six exceptions
 *    that take the last) — but see buildTable for HKSCS's order.
 *  - **EUC-KR**: leads and trails 0xA1–0xFE — KS X 1001, which is all Mudlet's
 *    framing accepts. The browser's decoder also reads the wider UHC (CP949)
 *    range, but a game that declared EUC-KR is not promised to.
 *
 * Output is a byte-string (one char per byte), as the socket layer expects.
 */

export type MultiByteEncoding = 'gbk' | 'gb18030' | 'big5' | 'big5-hkscs' | 'euc-kr';

const tables = new Map<MultiByteEncoding, Map<string, string> | null>();

/** Decode each candidate sequence in one pass, newline-separated, and record
 *  which character each came out as. The separator is safe: 0x0A is no valid
 *  trail byte in any of these, so a bad sequence can never swallow it, and the
 *  "prepend the offending byte" recovery just leaves it where it was. A
 *  sequence that decodes to nothing, to U+FFFD, or to more than one code point
 *  (Big5 has four such, for combining sequences) is no way to write a single
 *  character and is skipped. The first sequence for a character keeps it,
 *  except for those in `takeLast`, which the last one does. */
function addSequences(
    table: Map<string, string>,
    decoderLabel: string,
    sequences: readonly string[],
    takeLast?: ReadonlySet<string>,
): void {
    let decoder: TextDecoder;
    try { decoder = new TextDecoder(decoderLabel, { fatal: false }); } catch { return; }
    const buf = new Uint8Array(sequences.reduce((n, s) => n + s.length + 1, 0));
    let at = 0;
    for (const seq of sequences) {
        for (let i = 0; i < seq.length; i++) buf[at++] = seq.charCodeAt(i);
        buf[at++] = 0x0a;
    }
    const decoded = decoder.decode(buf).split('\n');
    for (let i = 0; i < sequences.length; i++) {
        const ch = decoded[i];
        if (!ch || ch === '�' || [...ch].length !== 1 || ch.codePointAt(0)! < 0x80) continue;
        if (!table.has(ch) || takeLast?.has(ch)) table.set(ch, sequences[i]);
    }
}

function pairs(leadMin: number, leadMax: number, trail: (b: number) => boolean): string[] {
    const out: string[] = [];
    for (let b1 = leadMin; b1 <= leadMax; b1++) {
        for (let b2 = 0x40; b2 <= 0xfe; b2++) {
            if (trail(b2)) out.push(String.fromCharCode(b1, b2));
        }
    }
    return out;
}

/** The four bytes of GB18030 four-byte pointer `p` (GB18030 §6.3.3). */
function gb18030FourByte(p: number): string {
    return String.fromCharCode(
        Math.floor(p / 12600) + 0x81,
        Math.floor((p % 12600) / 1260) + 0x30,
        Math.floor((p % 1260) / 10) + 0x81,
        (p % 10) + 0x30,
    );
}

/** Every pointer of the BMP four-byte block: 0x81 30 81 30 up to 0x84 31 A4 39. */
const GB18030_BMP_POINTERS = 39420;

/** Code points the WHATWG Big5 encoder writes with the LAST of their codes. */
const BIG5_TAKE_LAST = new Set(['═', '╞', '╡', '╪', '十', '卅']);

function buildTable(encoding: MultiByteEncoding): Map<string, string> | null {
    const table = new Map<string, string>();
    switch (encoding) {
        case 'gbk':
        case 'gb18030': {
            addSequences(table, encoding, pairs(0x81, 0xfe, b => b !== 0x7f));
            if (encoding === 'gb18030') {
                const four: string[] = [];
                for (let p = 0; p < GB18030_BMP_POINTERS; p++) four.push(gb18030FourByte(p));
                addSequences(table, encoding, four);
            }
            break;
        }
        case 'big5':
        case 'big5-hkscs': {
            const trail = (b: number) => b <= 0x7e || b >= 0xa1;
            // Sequences run in code order and a later pass cannot displace an
            // entry already there, so the first code wins — except for the
            // take-last six, which are let be overwritten.
            if (encoding === 'big5') {
                addSequences(table, 'big5', pairs(0xa1, 0xfe, trail), BIG5_TAKE_LAST);
                break;
            }
            // HKSCS: standard Big5 first, so a character it also carries keeps
            // its standard code; then HKSCS's own leads; the user-defined area
            // 0xFA–0xFE last. The browser's table has HKSCS characters there
            // too, duplicating codes HKSCS itself puts below 0xA1 — 嘅 is both
            // FB 48 and 9D EF — and HKSCS writes the latter, as Mudlet does.
            addSequences(table, 'big5', pairs(0xa1, 0xf9, trail), BIG5_TAKE_LAST);
            addSequences(table, 'big5', pairs(0x81, 0xa0, trail));
            addSequences(table, 'big5', pairs(0xfa, 0xfe, trail));
            break;
        }
        case 'euc-kr':
            addSequences(table, 'euc-kr', pairs(0xa1, 0xfe, b => b >= 0xa1));
            break;
    }
    return table.size > 0 ? table : null;
}

function tableFor(encoding: MultiByteEncoding): Map<string, string> | null {
    if (tables.has(encoding)) return tables.get(encoding) ?? null;
    const built = buildTable(encoding);
    tables.set(encoding, built);
    return built;
}

/**
 * The bytes (as a byte-string) that write the single code point `ch` in
 * `encoding`, or null when it has none. ASCII is written as itself. Null also
 * when the browser cannot decode the encoding at all, since then there is no
 * table to build.
 */
export function encodeMultiByteChar(ch: string, encoding: MultiByteEncoding): string | null {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) return ch;
    if (encoding === 'gb18030' && cp >= 0x10000) return gb18030FourByte(189000 + cp - 0x10000);
    return tableFor(encoding)?.get(ch) ?? null;
}

/** Whether the browser can supply the tables for `encoding` at all. */
export function canBuildMultiByteEncoder(encoding: MultiByteEncoding): boolean {
    return tableFor(encoding) !== null;
}
