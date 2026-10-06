// Mudlet/mudlet-web#351 — the server-encoding paths, each pinned against what
// desktop Mudlet (PTB 2026-10-02) put on the wire or in the buffer for the same
// bytes. Item 1 (Lua strings) needs the real runtime and lives in
// tests/scripting/luaInvalidUtf8.test.ts.
import { describe, it, expect } from 'vitest';
import { CharsetHandler, SessionCodec, canEncodeForServer, decodeForServer } from '../../../src/mud/protocol/charset';
import { createMsdpStream, encodeMsdp, type MsdpEnvelope } from '../../../src/mud/protocol/msdp';
import { decodeUtf8Stream } from '../../../src/mud/protocol/byteString';

const hex = (s: string) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => h.replace(/\s/g, '').match(/../g)!.map(b => String.fromCharCode(parseInt(b, 16))).join('');
const cps = (s: string) => [...s].map(c => c.codePointAt(0)!);

const codecFor = (name: string) => {
    const codec = new SessionCodec();
    const handler = new CharsetHandler(codec, true, { sendRaw: () => {}, onNegotiated: () => {} });
    expect(handler.setServerEncoding(name), name).toBe(true);
    return codec;
};

describe('#351 item 2: a character the encoding cannot carry', () => {
    it.each([
        ['ISO 8859-1', 'a中b', '611a62'],
        ['KOI8-R', 'aéb', '611a62'],
        ['EUC-KR', 'aéb', '611a62'],
        ['ISO 8859-15', 'a¤€b', '611aa462'],
        ['WINDOWS-1251', 'a中b', '611a62'],
    ])('goes out as SUB under %s, as desktop sends it', (name, text, wire) => {
        expect(hex(codecFor(name).encodeOutgoing(text))).toBe(wire);
    });

    it.each([
        ['CP437', 'a中b', '613f62'],
        ['GBK', 'a한b', '613f62'],
    ])('stays ? under %s, where desktop writes ? too', (name, text, wire) => {
        expect(hex(codecFor(name).encodeOutgoing(text))).toBe(wire);
    });

    it('takes EUC-KR\'s double-byte substitute past U+00FF', () => {
        expect(hex(codecFor('EUC-KR').encodeOutgoing('똠'))).toBe('affe');
    });
});

describe('#351 item 3: ISO 8859-1, 8859-9 and 8859-11 are not their Windows pages', () => {
    const c1 = Array.from({ length: 32 }, (_, i) => 0x80 + i);
    const allC1 = String.fromCharCode(...c1);

    it.each(['ISO 8859-1', 'ISO 8859-9'])('reads 0x80-0x9F as C1 controls under %s', (name) => {
        expect(cps(codecFor(name).decode(allC1))).toEqual(c1);
        expect(cps(decodeForServer(allC1, name))).toEqual(c1);
    });

    it('still reads ISO 8859-9\'s own letters', () => {
        expect(codecFor('ISO 8859-9').decode(bytes('d0 dd de f0 fd fe'))).toBe('ĞİŞğış');
    });

    it('reads nothing at 0x80-0x9F under ISO 8859-11, and its Thai above', () => {
        expect(codecFor('ISO 8859-11').decode(allC1)).toBe('\uFFFD'.repeat(32));
        expect(codecFor('ISO 8859-11').decode(bytes('a1 df'))).toBe('ก฿');
    });

    it('sends € under ISO 8859-1 as SUB, not Windows-1252\'s 0x80', () => {
        expect(hex(codecFor('ISO 8859-1').encodeOutgoing('a€b'))).toBe('611a62');
        expect(canEncodeForServer('€', 'ISO 8859-1')).toBe(false);
        // and a C1 control it does carry goes out as itself
        expect(hex(codecFor('ISO 8859-1').encodeOutgoing('\u0085'))).toBe('85');
    });
});

describe('#351 item 6: bytes the table leaves unassigned', () => {
    it.each([
        ['WINDOWS-1252', '81 8d 8f 90 9d'],
        ['WINDOWS-1250', '81 83 88 90 98'],
        ['WINDOWS-1251', '98'],
        ['WINDOWS-1253', '81 88 8a 8c 8d 8e 8f 90 98 9a 9c 9d 9e 9f'],
        ['WINDOWS-1254', '81 8d 8e 8f 90 9d 9e'],
        ['WINDOWS-1255', '81 8a 8c 8d 8e 8f 90 9a 9c 9d 9e 9f ca'],
        ['WINDOWS-1257', '81 83 88 8a 8c 90 98 9a 9c 9f'],
        ['WINDOWS-1258', '81 8a 8d 8e 8f 90 9a 9d 9e'],
        ['ISO 8859-7', 'a4 a5 aa'],
        ['ISO 8859-8', 'fd fe'],
    ])('reads U+FFFD for them under %s', (name, list) => {
        const b = bytes(list);
        expect(codecFor(name).decode(b)).toBe('\uFFFD'.repeat(b.length));
    });

    it('keeps the bytes Windows-1252 does assign', () => {
        expect(codecFor('WINDOWS-1252').decode(bytes('80 85 9f'))).toBe('€…Ÿ');
    });

    it('reads ISO 8859-8\'s 0xAF as the overline, as desktop\'s table has it', () => {
        expect(codecFor('ISO 8859-8').decode(bytes('af'))).toBe('‾');
    });
});

describe('#351 item 4: invalid UTF-8 from the game', () => {
    it.each([
        ['c0 af'],
        ['ed a0 80'],
        ['f4 90 80 80'],
    ])('is one U+FFFD per bad sequence (%s)', (seq) => {
        expect(new SessionCodec().decode(`a${bytes(seq)}b`)).toBe('a\uFFFDb');
    });

    // Desktop's TBufferEncoding_spec: a byte that cannot continue a sequence
    // ends it, and is then read in its own right.
    it.each([
        ['c3', 'AZ', '\uFFFDAZ'],
        ['e2 82', 'AZ', '\uFFFDAZ'],
        ['f0 9f 98', 'AZ', '\uFFFDAZ'],
        ['f8', 'ABCDZ', '\uFFFDABCDZ'],
        ['e2 e6 97 a5', 'Z', '\uFFFD日Z'],
        ['e2', '\r\n', '\uFFFD\r\n'],
    ])('keeps the byte that cuts %s short', (seq, after, text) => {
        expect(new SessionCodec().decode(bytes(seq) + after)).toBe(text);
    });

    it('keeps a line ending that cuts short a sequence held from the last frame', () => {
        const codec = new SessionCodec();
        expect(codec.decode('one\xe2')).toBe('one');
        expect(codec.decode('\r\ntwo')).toBe('\uFFFD\r\ntwo');
    });

    it('holds a sequence split across frames', () => {
        const codec = new SessionCodec();
        expect(codec.decode('x\xe4\xb8')).toBe('x');
        expect(codec.decode('\xadyz')).toBe('中yz');
    });

    it('holds a bad sequence split across frames as one mark too', () => {
        const codec = new SessionCodec();
        expect(codec.decode('x\xed\xa0')).toBe('x');
        expect(codec.decode('\x80y')).toBe('\uFFFDy');
    });

    it('marks a sequence a prompt cuts short and starts afresh', () => {
        const codec = new SessionCodec();
        expect(codec.decode('> \xe4\xb8', true)).toBe('> \uFFFD');
        expect(codec.decode('ok')).toBe('ok');
    });

    it('decodes valid text unchanged, BOM included', () => {
        expect(decodeUtf8Stream('\xef\xbb\xbfh\xc3\xa9', true).text).toBe('﻿hé');
        expect(new SessionCodec().decode('\xf0\x9f\x98\x80 ok')).toBe('😀 ok');
    });
});

describe('#351 item 5: MSDP under the server encoding', () => {
    const parse = (body: string, codec: SessionCodec) => {
        const out: MsdpEnvelope[] = [];
        createMsdpStream({ decode: b => codec.decodeOutOfBand(b), onEnvelope: e => out.push(e) })(
            String.fromCharCode(69) + body);
        return out;
    };

    it.each([
        ['GBK', 'd6d0cec4', '中文'],
        ['KOI8-R', 'f0d2c9', 'При'],
    ])('decodes an incoming %s value', (name, valueHex, text) => {
        expect(parse(`\x01S\x02${bytes(valueHex)}`, codecFor(name))).toEqual([{ path: 'S', value: text }]);
    });

    it.each([
        ['GBK', 'd6d0a8a6'],
        ['KOI8-R', '1a1a'],
        ['UTF-8', 'e4b8adc3a9'],
    ])('encodes sendMSDP under %s', (name, valueHex) => {
        const codec = codecFor(name);
        const frame = encodeMsdp('OUT', ['中é'], t => codec.encodeOutOfBand(t));
        expect(hex(frame)).toBe(`fffa4501${hex('OUT')}02${valueHex}fff0`);
    });

    it('still writes UTF-8 under ASCII, which desktop holds as no encoding', () => {
        expect(hex(codecFor('ASCII').encodeOutOfBand('é'))).toBe('c3a9');
    });
});
