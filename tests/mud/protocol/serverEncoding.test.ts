import { describe, it, expect } from 'vitest';
import {
    SUPPORTED_SERVER_ENCODINGS,
    canonicalServerEncoding,
    canEncodeForServer,
    SessionCodec,
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
        expect(canonicalServerEncoding('BIG5')).toBeNull();
        expect(canonicalServerEncoding('')).toBeNull();
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
