// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import zlib from 'node:zlib';
import { MccpHandler } from '../../../src/mud/protocol/mccp';

const START = '\xFF\xFA\x56\xFF\xF0'; // IAC SB COMPRESS2 IAC SE

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

/** A zlib stream the way a server's deflater emits it: `flushed` holds one
 *  Z_SYNC_FLUSH'd chunk per text (the first carrying the zlib header), `end`
 *  is what finishing the stream adds (the final block plus the Adler-32
 *  trailer). Built from raw deflate so every chunk boundary is exact. */
function serverStream(...texts: string[]): { flushed: string[]; end: string } {
    const flushed = texts.map((t, i) => {
        const body = zlib.deflateRawSync(Buffer.from(t, 'latin1'), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        return latin1(i === 0 ? Buffer.concat([Buffer.from([0x78, 0x9c]), body]) : body);
    });
    const adler = Buffer.alloc(4);
    adler.writeUInt32BE(adler32(Buffer.from(texts.join(''), 'latin1')));
    return { flushed, end: latin1(Buffer.concat([zlib.deflateRawSync(Buffer.alloc(0)), adler])) };
}

function adler32(buf: Buffer): number {
    let a = 1, b = 0;
    for (const byte of buf) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function handler(): MccpHandler {
    return new MccpHandler(() => {});
}

describe('MCCP2 end of compressed stream (#176)', () => {
    it('sanity: the helper produces a stream zlib itself accepts', () => {
        const s = serverStream('K1 compressed\r\n', 'K2 more\r\n');
        const bytes = Buffer.from(s.flushed.join('') + s.end, 'latin1');
        expect(zlib.inflateSync(bytes).toString('latin1')).toBe('K1 compressed\r\nK2 more\r\n');
    });

    it('drops back to plain text when the end arrives in its own packet', () => {
        const m = handler();
        const s = serverStream('K1 compressed\r\n');
        expect(m.processData(START)).toBe('');
        expect(m.isActive()).toBe(true);
        expect(m.processData(s.flushed[0])).toBe('K1 compressed\r\n');
        expect(m.processData(s.end)).toBe('');
        expect(m.isActive()).toBe(false);
        expect(m.processData('K4 plain after end\r\n')).toBe('K4 plain after end\r\n');
    });

    it('passes through plain text that shares a packet with the end of the stream', () => {
        const m = handler();
        const s = serverStream('K1 compressed\r\n');
        m.processData(START + s.flushed[0]);
        expect(m.processData(s.end + 'K4 plain after end\r\n')).toBe('K4 plain after end\r\n');
        expect(m.isActive()).toBe(false);
    });

    it('handles start, data, end and trailing text all in one packet', () => {
        const m = handler();
        const s = serverStream('K1 compressed\r\n');
        expect(m.processData('pre ' + START + s.flushed[0] + s.end + 'after\r\n'))
            .toBe('pre K1 compressed\r\nafter\r\n');
        expect(m.isActive()).toBe(false);
    });

    it('copes with the zlib header and trailer split across packets', () => {
        const m = handler();
        const s = serverStream('K1 compressed\r\n');
        const body = s.flushed[0];
        expect(m.processData(START + body[0])).toBe('');
        expect(m.processData(body.slice(1))).toBe('K1 compressed\r\n');
        const end = s.end;
        const split = end.length - 2; // inside the Adler-32 trailer
        expect(m.processData(end.slice(0, split))).toBe('');
        expect(m.isActive()).toBe(true);
        expect(m.processData(end.slice(split) + 'plain\r\n')).toBe('plain\r\n');
        expect(m.isActive()).toBe(false);
    });

    it('decompresses a stream the server restarts after ending the previous one', () => {
        const m = handler();
        const a = serverStream('first\r\n');
        const b = serverStream('second\r\n');
        m.processData(START + a.flushed[0]);
        expect(m.processData(a.end + 'between\r\n' + START + b.flushed[0])).toBe('between\r\nsecond\r\n');
        expect(m.isActive()).toBe(true);
        expect(m.processData(b.end + 'after\r\n')).toBe('after\r\n');
    });

    it('works with a stream produced by a real streaming deflater', () => {
        const m = handler();
        const whole = latin1(zlib.deflateSync(Buffer.from('K1 compressed\r\n')));
        expect(m.processData(START + whole + 'K4 plain after end\r\n'))
            .toBe('K1 compressed\r\nK4 plain after end\r\n');
    });

    it('keeps output larger than one inflate chunk intact across the end', () => {
        const m = handler();
        const big = Array.from({ length: 4000 }, (_, i) => `line ${i} of compressed output\r\n`).join('');
        const whole = latin1(zlib.deflateSync(Buffer.from(big, 'latin1')));
        expect(m.processData(START + whole + 'plain\r\n')).toBe(big + 'plain\r\n');
        expect(m.isActive()).toBe(false);
    });

    it('never shows compressed bytes as text when inflation fails', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const m = handler();
        const s = serverStream('ok\r\n');
        m.processData(START + s.flushed[0]);
        expect(m.processData('\xFF\xFF\xFF\xFF garbage')).toBe('');
        expect(m.isActive()).toBe(false);
        err.mockRestore();
    });
});
