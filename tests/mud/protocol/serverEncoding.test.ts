import { describe, it, expect } from 'vitest';
import {
    SUPPORTED_SERVER_ENCODINGS,
    canonicalServerEncoding,
    canEncodeForServer,
    decodeForServer,
    savedServerEncoding,
    SessionCodec,
    CharsetHandler,
} from '../../../src/mud/protocol/charset';

/**
 * Mudlet spells the Latin-N encodings with a space — "ISO 8859-1", from
 * TEncodingTable.cpp — while the wire and IANA use a dash. Both reach
 * setServerEncoding (a script copies the name out of getServerEncodingsList,
 * a CHARSET negotiation carries the IANA one), so both have to be understood
 * and both have to come back out as one canonical name.
 */
describe('server encoding names', () => {
    it('offers Mudlet\'s own spelling', () => {
        expect(SUPPORTED_SERVER_ENCODINGS).toContain('ISO 8859-1');
        expect(SUPPORTED_SERVER_ENCODINGS).toContain('ISO 8859-15');
    });

    it('accepts every spelling of one encoding and answers with the list\'s', () => {
        for (const spelling of ['ISO 8859-1', 'iso-8859-1', 'ISO_8859_1', 'Latin-1', 'latin1']) {
            expect(canonicalServerEncoding(spelling), spelling).toBe('ISO 8859-1');
        }
        expect(canonicalServerEncoding('utf8')).toBe('UTF-8');
        expect(canonicalServerEncoding('windows-1250')).toBe('WINDOWS-1250');
    });

    it('refuses one it cannot decode', () => {
        // Shift JIS is in the browser's own set but not in Mudlet's list, so it
        // is a name that reads plausibly and still has to be refused — the list
        // is the contract, not whatever TextDecoder happens to accept.
        expect(canonicalServerEncoding('SHIFT_JIS')).toBeNull();
        expect(canonicalServerEncoding('')).toBeNull();
    });

    // BIG5 and BIG5-HKSCS share a decoder, so a canonicaliser that resolved
    // names through it would answer BIG5 to both and getServerEncoding() would
    // report a name the caller never set.
    it('keeps two names that share a decoder apart', () => {
        expect(canonicalServerEncoding('BIG5')).toBe('BIG5');
        expect(canonicalServerEncoding('big5-hkscs')).toBe('BIG5-HKSCS');
    });

    // Every entry has to be settable, or the list advertises a name that is
    // then refused.
    it('canonicalises every name it advertises', () => {
        for (const name of SUPPORTED_SERVER_ENCODINGS) {
            expect(canonicalServerEncoding(name), name).toBe(name);
        }
    });
});

describe('canEncodeForServer', () => {
    it('lets UTF-8 through unchallenged', () => {
        expect(canEncodeForServer('一 café ąę', 'UTF-8')).toBe(true);
    });

    it('holds ASCII to 7 bits, whatever the decoder would accept', () => {
        expect(canEncodeForServer('plain text', 'ASCII')).toBe(true);
        // é is a perfectly good windows-1252 byte, and TextDecoder('ascii') is
        // an alias for windows-1252 — the label, not the decoder, is what says
        // this cannot be sent.
        expect(canEncodeForServer('café', 'ASCII')).toBe(false);
    });

    it('judges a single-byte codepage by what it can actually represent', () => {
        // ą (U+0105) is in Latin-2, not Latin-1
        expect(canEncodeForServer('ląka', 'ISO 8859-2')).toBe(true);
        expect(canEncodeForServer('ląka', 'ISO 8859-1')).toBe(false);
        // no ISO 8859 has a CJK ideograph
        expect(canEncodeForServer('一', 'ISO 8859-2')).toBe(false);
    });
});

describe('SessionCodec.encodeOutgoing', () => {
    const bytes = (s: string) => [...s].map(c => c.charCodeAt(0));

    it('encodes UTF-8 as UTF-8', () => {
        const codec = new SessionCodec();
        expect(bytes(codec.encodeOutgoing('é'))).toEqual([0xc3, 0xa9]);
    });

    // Sending the low byte of the UTF-16 code unit was right only inside
    // Latin-1: ą (U+0105) would have gone out as 0x05, a control character,
    // instead of Latin-2's 0xB1.
    it('puts the codepage\'s own byte on the wire, not a truncated one', () => {
        const codec = new SessionCodec();
        expect(codec.trySetEncoding('iso-8859-2')).toBe(true);
        expect(bytes(codec.encodeOutgoing('ląka'))).toEqual([0x6c, 0xb1, 0x6b, 0x61]);
    });

    it('substitutes ? for a character the codepage has no byte for', () => {
        const codec = new SessionCodec();
        codec.trySetEncoding('iso-8859-2');
        expect(codec.encodeOutgoing('a一b')).toBe('a?b');
    });
});

/**
 * The browser decodes the East Asian multi-byte encodings but cannot encode
 * them, and outgoing text used to go out as the low byte of each UTF-16 unit —
 * 中文 under GBK as `2d 87`. The expected bytes here are what desktop Mudlet
 * puts on the wire for the same text.
 */
describe('SessionCodec.encodeOutgoing — multi-byte encodings', () => {
    const bytes = (s: string) => [...s].map(c => c.charCodeAt(0));
    const via = (name: string) => {
        const codec = new SessionCodec();
        const handler = new CharsetHandler(codec, true, { sendRaw: () => {}, onNegotiated: () => {} });
        expect(handler.setServerEncoding(name), name).toBe(true);
        return codec;
    };

    it.each([
        ['GBK', '中文', [0xd6, 0xd0, 0xce, 0xc4]],
        ['BIG5', '中文', [0xa4, 0xa4, 0xa4, 0xe5]],
        ['EUC-KR', '한국어', [0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee]],
        ['GB18030', '中€', [0xd6, 0xd0, 0xa2, 0xe3]],
    ])('writes %s the way Mudlet does', (name, text, expected) => {
        expect(bytes(via(name).encodeOutgoing(`say ${text}`))).toEqual([...bytes('say '), ...expected]);
    });

    it('never writes GBK\'s lone 0x80 for the euro sign, which Mudlet will not read', () => {
        expect(bytes(via('GBK').encodeOutgoing('€'))).toEqual([0xa2, 0xe3]);
    });

    it('uses GB18030\'s four-byte form for what has no pair', () => {
        // U+00A5 ¥: 0x81 30 84 36; U+1F600 😀: the supplementary line, 0x94 39 FC 36
        expect(bytes(via('GB18030').encodeOutgoing('¥'))).toEqual([0x81, 0x30, 0x84, 0x36]);
        expect(bytes(via('GB18030').encodeOutgoing('😀'))).toEqual([0x94, 0x39, 0xfc, 0x36]);
        // GBK has no four-byte form, so what needs one is not writable there
        expect(via('GBK').encodeOutgoing('😀')).toBe('?');
    });

    // 嘅 is HKSCS 9D EF, which desktop Mudlet writes. The browser's Big5 table
    // also has it at FB 48, in the user-defined area, and that must not win.
    // The character is taken from the decoder rather than written out because
    // Node's ICU Big5 is not the WHATWG one a browser has (it reads 9D EF as a
    // private-use character); what must hold either way is that 9D EF comes back.
    it('writes the HKSCS codes for BIG5-HKSCS', () => {
        const hkscs = new TextDecoder('big5').decode(new Uint8Array([0x9d, 0xef]));
        expect(bytes(via('BIG5-HKSCS').encodeOutgoing(hkscs))).toEqual([0x9d, 0xef]);
        expect(canEncodeForServer(hkscs, 'BIG5-HKSCS')).toBe(true);
        expect(canEncodeForServer(hkscs, 'big5_hkscs')).toBe(true);
        // and a character standard Big5 has keeps its standard code there
        expect(bytes(via('BIG5-HKSCS').encodeOutgoing('中'))).toEqual([0xa4, 0xa4]);
    });

    it('never writes an HKSCS lead byte for plain Big5', () => {
        const codec = via('BIG5');
        const hkscs = new TextDecoder('big5').decode(new Uint8Array([0x9d, 0xef]));
        const out = bytes(codec.encodeOutgoing(hkscs));
        expect(out[0] === 0x3f || out[0] >= 0xa1).toBe(true);
    });

    it('takes the WHATWG encoder\'s choice where Big5 has two codes for one character', () => {
        // ═ (U+2550) is both A2 A4 and F9 F9, and is one of the six the encoder
        // takes the last code for; 十 (U+5341) is A2 CC and A4 51, another
        expect(bytes(via('BIG5').encodeOutgoing('═'))).toEqual([0xf9, 0xf9]);
        expect(bytes(via('BIG5').encodeOutgoing('十'))).toEqual([0xa4, 0x51]);
        // and everything else takes the first: ╭ (U+256D) is A2 7E and F9 FA
        expect(bytes(via('BIG5').encodeOutgoing('╭'))).toEqual([0xa2, 0x7e]);
    });

    it('holds EUC-KR to KS X 1001, which is all Mudlet reads', () => {
        // 똠 is UHC-only (0x8C 0x63): the browser decodes it, but a game that
        // declared EUC-KR need not
        expect(via('EUC-KR').encodeOutgoing('똠')).toBe('?');
    });

    it('round-trips through the inbound decoder', () => {
        for (const [name, text] of [['GBK', '中文字'], ['GB18030', '中é😀'], ['BIG5', '中文'], ['EUC-KR', '한국어']]) {
            const codec = via(name);
            expect(codec.decode(codec.encodeOutgoing(text)), name).toBe(text);
        }
    });

    it('drops back to UTF-8 on reset', () => {
        const codec = via('GBK');
        codec.reset();
        expect(bytes(codec.encodeOutgoing('中'))).toEqual([0xe4, 0xb8, 0xad]);
    });
});

describe('canEncodeForServer — multi-byte encodings', () => {
    it('judges them rather than waving everything through', () => {
        expect(canEncodeForServer('中文', 'GBK')).toBe(true);
        expect(canEncodeForServer('한국어', 'GBK')).toBe(false);
        expect(canEncodeForServer('한국어', 'EUC-KR')).toBe(true);
        expect(canEncodeForServer('😀', 'GB18030')).toBe(true);
    });
});

/**
 * Mudlet/mudlet-web#191. The expected characters are desktop Mudlet's, read out
 * of the Unicode mapping files for each page — not out of codePages.ts, which is
 * what is under test.
 */
describe('the code pages Mudlet reads from its own tables', () => {
    const bytes = (...b: number[]) => String.fromCharCode(...b);
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

    // CP866 and MACINTOSH were listed and then refused, because nothing mapped
    // either name onto a decoder.
    it('can switch to every encoding it lists', () => {
        for (const name of SUPPORTED_SERVER_ENCODINGS) {
            const handler = new CharsetHandler(new SessionCodec(), true, { sendRaw: () => {}, onNegotiated: () => {} });
            expect(handler.setServerEncoding(name), name).toBe(true);
        }
    });

    it('reads CP866 and MACINTOSH', () => {
        // "Привет" and "Ça marche"
        expect(decodeForServer(bytes(0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2), 'CP866')).toBe('Привет');
        expect(decodeForServer(bytes(0x82, 0x61, 0x20, 0x8e, 0x74, 0xe9), 'MACINTOSH')).toBe('Ça étÈ');
    });

    it('takes the WHATWG and IANA spellings of them from a game', () => {
        expect(canonicalServerEncoding('IBM866')).toBe('CP866');
        expect(canonicalServerEncoding('cp866')).toBe('CP866');
        expect(canonicalServerEncoding('x-mac-roman')).toBe('MACINTOSH');
        expect(canonicalServerEncoding('macintosh')).toBe('MACINTOSH');
    });

    // The Greek lower case sat where CP437 has its accented Latin letters.
    it('reads CP737\'s Greek lower case', () => {
        expect(decodeForServer(bytes(0x98, 0x99, 0x9a, 0x9b), 'CP737')).toBe('αβγδ');
        expect(decodeForServer(bytes(...range(0x98, 0xaf)), 'CP737')).toBe('αβγδεζηθικλμνξοπρσςτυφχψ');
        expect(decodeForServer(bytes(0xe0, 0xf0), 'CP737')).toBe('ωΏ');
    });

    it('reads CP667\'s Ó, which it lost by shifting the row after it', () => {
        expect(decodeForServer(bytes(...range(0xa0, 0xa7)), 'CP667')).toBe('ŹŻóÓńŃźż');
    });

    // The WHATWG koi8-u is KOI8-RU, which has ў/Ў where KOI8-U has box drawing.
    it('reads KOI8-U as KOI8-U, not as the browser\'s KOI8-RU', () => {
        expect(decodeForServer(bytes(0xae, 0xbe), 'KOI8-U')).toBe('╝╬');
        expect(decodeForServer(bytes(0xa4, 0xa6, 0xa7, 0xad, 0xb4, 0xb6, 0xb7, 0xbd), 'KOI8-U')).toBe('єіїґЄІЇҐ');
    });

    it('draws MEDIEVIA\'s 0xF6 as Mudlet does', () => {
        expect(decodeForServer(bytes(0xf6), 'MEDIEVIA')).toBe('∟');
    });

    // Mudlet's Thai page is CP1162; Mudlet Web offered the same table as CP1161,
    // which desktop Mudlet refuses.
    it('names the Thai page CP1162', () => {
        expect(SUPPORTED_SERVER_ENCODINGS).toContain('CP1162');
        expect(SUPPORTED_SERVER_ENCODINGS).not.toContain('CP1161');
        expect(canonicalServerEncoding('CP1161')).toBeNull();
        expect(decodeForServer(bytes(0xa1, 0xb2, 0x80), 'CP1162')).toBe('กฒ€');
    });

    it('still opens a profile saved as CP1161, on the page it meant', () => {
        expect(savedServerEncoding('CP1161')).toBe('CP1162');
        expect(savedServerEncoding('CP437')).toBe('CP437');
        expect(savedServerEncoding(undefined)).toBeUndefined();
    });
});
