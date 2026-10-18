// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { decodeMultiByte } from '../../../src/mud/protocol/multiByte';

const bytes = (...b: number[]) => String.fromCharCode(...b);
const R = '�';

describe('decodeMultiByte framing (TBuffer::process*Sequence)', () => {
  it('loses only the lead of a pair cut short by an ASCII byte', () => {
    expect(decodeMultiByte(bytes(0xc4, 0x20, 0x5a), 'gbk').text).toBe(`${R} Z`);
    expect(decodeMultiByte(bytes(0x81, 0x7f), 'gbk').text).toBe(`${R}\x7f`);
    expect(decodeMultiByte(bytes(0xa7, 0x20), 'big5').text).toBe(`${R} `);
    expect(decodeMultiByte(bytes(0xc7, 0x20), 'euc-kr').text).toBe(`${R} `);
    expect(decodeMultiByte(bytes(0x90, 0x30), 'gbk').text).toBe(`${R}0`);
  });

  it('still consumes a high trail byte that is merely out of range', () => {
    expect(decodeMultiByte(bytes(0xa7, 0x80), 'big5').text).toBe(R);
  });

  it('ends a GB18030 four-byte sequence at its lead once a later byte cannot belong to it', () => {
    expect(decodeMultiByte(bytes(0x81, 0x30, 0x0d), 'gb18030')).toEqual({ text: `${R}0\r`, pending: '' });
    expect(decodeMultiByte(bytes(0x81, 0x30, 0x81), 'gb18030')).toEqual({ text: '', pending: bytes(0x81, 0x30, 0x81) });
    expect(decodeMultiByte(bytes(0x81, 0x30, 0x81, 0x0d), 'gb18030').text).toBe(`${R}0${R}\r`);
  });

  it('frames Shift_JIS and EUC-JP as TBuffer::processJapaneseSequence does', () => {
    // 日 is 93 FA in Shift_JIS and C6 FC in EUC-JP; ｱ is B1 / 8E B1
    expect(decodeMultiByte(bytes(0x93, 0xfa, 0xb1), 'shift_jis').text).toBe('日ｱ');
    expect(decodeMultiByte(bytes(0xc6, 0xfc, 0x8e, 0xb1), 'euc-jp').text).toBe('日ｱ');
    // a byte that breaks the sequence starts the next one
    expect(decodeMultiByte(bytes(0x93, 0x20), 'shift_jis').text).toBe(`${R} `);
    expect(decodeMultiByte(`${bytes(0x93)}\x1b[32m${bytes(0xfa)}`, 'shift_jis').text).toBe('日\x1b[32m');
    expect(decodeMultiByte(bytes(0xc6), 'euc-jp')).toEqual({ text: '', pending: bytes(0xc6) });
  });

  it('decodes a character restyled between its bytes whole, the SGR after it', () => {
    expect(decodeMultiByte(`${bytes(0xd6)}\x1b[32m${bytes(0xd0)}X`, 'gbk').text).toBe('中\x1b[32mX');
    // any other sequence, or no trail, ends it at its lead
    expect(decodeMultiByte(`${bytes(0xd6)}\x1b[1 m${bytes(0xd0)}`, 'gbk').text.startsWith(`${R}\x1b[1 m`)).toBe(true);
    expect(decodeMultiByte(`${bytes(0xd6)}\x1b[31m X`, 'gbk').text).toBe(`${R}\x1b[31m X`);
    // the run off the end is held, lead and all
    expect(decodeMultiByte(`${bytes(0xd6)}\x1b[3`, 'gbk')).toEqual({ text: '', pending: `${bytes(0xd6)}\x1b[3` });
  });
});
