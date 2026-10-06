// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import zlib from 'node:zlib';
import { MccpHandler, MCCP_MAX_INFLATED_PER_READ } from '../../../src/mud/protocol/mccp';

const START = '\xFF\xFA\x56\xFF\xF0'; // IAC SB COMPRESS2 IAC SE
const WILL = '\xFF\xFB\x56';          // IAC WILL COMPRESS2
const WONT = '\xFF\xFC\x56';          // IAC WONT COMPRESS2
const DO = '\xFF\xFD\x56';            // IAC DO COMPRESS2
const DONT = '\xFF\xFE\x56';          // IAC DONT COMPRESS2

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

/** A handler that has taken up the server's offer of MCCP v2 — only then is
 *  a start sequence the start of a stream. */
function handler(sent: string[] = []): MccpHandler {
    const m = new MccpHandler((data) => sent.push(data));
    m.processData(WILL);
    return m;
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

    it('hands what follows a break in a stream that was working back as plain text', () => {
        const m = handler();
        const s = serverStream('ok\r\n');
        m.processData(START + s.flushed[0]);
        // 0xFF opens a block of the reserved type: zlib takes that one byte
        // and gives up there, and desktop reprocesses the rest as plain data
        const pieces = m.processPieces('\xFF\xFF\xFF\xFF garbage');
        expect(pieces[0]).toEqual({ notice: expect.stringContaining('MCCP decompression error (data error)') });
        expect(pieces.slice(1).join('')).toBe('\xFF\xFF\xFF garbage');
        expect(m.isActive()).toBe(false);
    });
});

const NOTICE_BROKEN = (error: string) => ({
    notice: `[ WARN  ]  - MCCP decompression error (${error}), compression disabled.\n`
        + 'If the display looks garbled, please reconnect to the game.',
});

describe('MCCP negotiation, broken streams and the per-read cap (Telnet_spec)', () => {
    it('takes a start sequence as one only once WILL COMPRESS2 has been answered, and not after WONT', () => {
        const sent: string[] = [];
        const m = new MccpHandler((d) => sent.push(d));
        expect(m.processData(START)).toBe(START);
        expect(m.isActive()).toBe(false);
        m.processData(WILL);
        expect(sent).toEqual([DO]);
        m.processData(WONT);
        expect(m.processData(START)).toBe(START);
        // in stream order within one read
        expect(m.processData(WILL + START)).toBe(WILL);
        expect(m.isActive()).toBe(true);
    });

    it('warns, refuses the stream and hands back every byte of a text that was never compressed', () => {
        const sent: string[] = [];
        const m = handler(sent);
        expect(m.processPieces(START + 'MCCPNOTCOMPRESSED\r\n'))
            .toEqual([NOTICE_BROKEN('data error'), 'MCCPNOTCOMPRESSED\r\n']);
        expect(sent).toEqual([DO, DONT]);
        expect(m.isActive()).toBe(false);
        // refused: the next start sequence is not one until the game offers again
        expect(m.processData(START + 'x')).toBe(START + 'x');
        m.processData(WILL);
        expect(m.processData(START)).toBe('');
        expect(m.isActive()).toBe(true);
    });

    it('hands back a header byte held over from an earlier read once, before the rest', () => {
        const m = handler();
        expect(m.processPieces(START + 'M')).toEqual([]);
        expect(m.processPieces('CCPSPLIT\r\n')).toEqual([NOTICE_BROKEN('data error'), 'M', 'CCPSPLIT\r\n']);
    });

    it('hands back the six bytes of a header asking for a preset dictionary', () => {
        const m = handler();
        expect(m.processPieces(START + '8nMCCPDICT\r\n')).toEqual([NOTICE_BROKEN('need dictionary'), '8nMCCPDICT\r\n']);
    });

    it('rejects a stream whose Adler-32 trailer does not match', () => {
        const m = handler();
        const s = serverStream('K1\r\n');
        const end = s.end.slice(0, -1) + String.fromCharCode(s.end.charCodeAt(s.end.length - 1) ^ 1);
        const pieces = m.processPieces(START + s.flushed[0] + end + 'after\r\n');
        // desktop posts the warning before it shows what the read inflated to
        expect(pieces).toEqual([NOTICE_BROKEN('data error'), 'K1\r\n', 'after\r\n']);
    });

    it('reports the end of a stream so the option can be offered afresh', () => {
        const ended = vi.fn();
        const m = new MccpHandler(() => {}, ended);
        m.processData(WILL);
        m.processData(START + latin1(zlib.deflateSync(Buffer.from('x'))));
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it('refuses a stream that inflates past the cap in one read, dropping the rest of the read', () => {
        const sent: string[] = [];
        const m = handler(sent);
        const bomb = latin1(zlib.deflateSync(Buffer.concat([Buffer.alloc(MCCP_MAX_INFLATED_PER_READ + 10), Buffer.from('TAIL\r\n')])));
        const pieces = m.processPieces(START + bomb + 'dropped\r\n');
        const text = pieces.filter((p): p is string => typeof p === 'string').join('');
        expect(text.length).toBe(MCCP_MAX_INFLATED_PER_READ);
        expect(text).not.toContain('TAIL');
        expect(text).not.toContain('dropped');
        expect(pieces[pieces.length - 1]).toEqual({ notice: expect.stringContaining('Too much compressed data to process at once') });
        expect(sent).toEqual([DO, DONT]);
        expect(m.processData('plain\r\n')).toBe('plain\r\n');
    });

    it('lets a large stream through that inflates within the cap read by read', () => {
        const m = handler();
        const big = 'A'.repeat(MCCP_MAX_INFLATED_PER_READ - 100);
        const s = serverStream(big, big, big);
        let out = m.processData(START);
        for (const read of [...s.flushed, s.end]) out += m.processData(read);
        expect(m.isActive()).toBe(false);
        expect(out).toBe(big + big + big);
    });
});
