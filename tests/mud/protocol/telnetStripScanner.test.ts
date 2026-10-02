import { describe, it, expect } from 'vitest';
import { stripTelnetSequences, createTelnetOptionParser, type TelnetOptionHandler } from '../../../src/mud/protocol/gmcp';

/**
 * stripTelnetSequences is a single-pass scanner standing in for a regex
 * replace that CodeQL flagged (js/polynomial-redos): the lazy `IAC SB … IAC SE`
 * branch rescanned to end-of-buffer from every IAC SB without a terminator.
 * The scanner has to be the regex's exact equal — same sequences handed to
 * the handler, in the same order, and the same text out — so the regex
 * version is kept here as the reference.
 */
const REFERENCE_REGEX = /\xFF\xFA[\s\S]*?\xFF\xF0|\xFF[\xFB-\xFE][\s\S]|\xFF[\s\S]/g;
const REFERENCE_REGEX_NO_SB = /\xFF[\xFB-\xFE][\s\S]|\xFF[\s\S]/g;

const referenceStrip = (data: string, handler: TelnetOptionHandler): string => {
    const re = data.includes('\xFF\xF0') ? REFERENCE_REGEX : REFERENCE_REGEX_NO_SB;
    const text = data.replace(re, handler).replace(/\xFF/g, '');
    return text.includes('\0') ? text.replace(/\0/g, '') : text;
};

/** Run both implementations, recording every sequence each handler is given. */
function compare(data: string, opts: { promptMarkerAsNewline?: boolean } = {}) {
    const run = (strip: typeof stripTelnetSequences) => {
        const calls: string[] = [];
        const subs: string[] = [];
        const inner = createTelnetOptionParser((d) => subs.push(d), opts);
        const out = strip(data, (seq) => {
            calls.push(seq);
            return inner(seq);
        });
        return { out, calls, subs };
    };
    expect(run(stripTelnetSequences)).toEqual(run(referenceStrip));
}

const IAC = '\xFF', SB = '\xFA', SE = '\xF0', WILL = '\xFB', WONT = '\xFC', DO = '\xFD', DONT = '\xFE';
const GA = '\xF9', EOR = '\xEF', GMCP = '\xC9';

const CORPUS: string[] = [
    '',
    'plain text with no telnet at all\r\n',
    'nul\0in\0text\0',
    '\0',
    IAC,
    'trailing' + IAC,
    IAC + IAC,
    IAC + IAC + IAC,
    'a' + IAC + IAC + 'b',
    IAC + WILL,
    'x' + IAC + DO,
    IAC + WILL + '\x01',
    IAC + WONT + '\x01' + IAC + DO + '\x18' + IAC + DONT + '\x1F',
    'prompt>' + IAC + GA,
    'prompt>' + IAC + EOR + '\x1b[K',
    IAC + SB,
    IAC + SB + 'never terminated',
    IAC + SB + GMCP + 'Core.Ping' + IAC + SE,
    'a' + IAC + SB + GMCP + 'Char.Vitals {"hp":10}' + IAC + SE + 'b',
    'a\0b' + IAC + SB + GMCP + 'x\0y' + IAC + SE + 'c\0',
    IAC + SB + GMCP + 'with ' + IAC + GA + ' inside' + IAC + SE + 'after' + IAC + GA,
    IAC + SB + IAC + SE,
    IAC + SB + SE,
    IAC + SB + IAC + IAC + SE + 'rest',
    IAC + SE + IAC + SB + 'x',
    IAC + SE + (IAC + SB).repeat(20),
    (IAC + SB).repeat(5) + IAC + SE + (IAC + SB).repeat(5),
    IAC + SB + 'one' + IAC + SE + IAC + SB + 'two' + IAC + SE + IAC + SB + 'three',
    IAC + SB + 'x' + IAC + WILL + IAC + SE,
    IAC + WILL + IAC + SE,
    IAC + WILL + IAC,
    'ÿú stray latin-1 looking bytes ÿð',
    '\x1b[1;31mred\x1b[0m' + IAC + GA + '\r\n',
];

describe('stripTelnetSequences matches the regex it replaced', () => {
    it('on a hand-built corpus of edge cases', () => {
        for (const data of CORPUS) {
            compare(data);
            compare(data, { promptMarkerAsNewline: true });
        }
    });

    it('when the handler returns IAC or NUL in its replacement', () => {
        for (const data of CORPUS) {
            const handler: TelnetOptionHandler = (seq) => (seq.length % 2 ? 'r' + IAC + '\0' : IAC);
            expect(stripTelnetSequences(data, handler)).toBe(referenceStrip(data, handler));
        }
    });

    it('on random byte soup weighted towards telnet bytes', () => {
        // Deterministic LCG so a failure reproduces.
        let seed = 0x272;
        const rand = (n: number) => {
            seed = (seed * 1103515245 + 12345) >>> 0;
            return seed % n;
        };
        const alphabet = [IAC, IAC, IAC, SB, SE, WILL, WONT, DO, DONT, GA, EOR, GMCP, '\0', '\r', '\n', 'a', 'b', '\x1b', '\x01'];
        for (let n = 0; n < 3000; n++) {
            let s = '';
            const len = rand(40);
            for (let i = 0; i < len; i++) s += alphabet[rand(alphabet.length)];
            compare(s);
            compare(s, { promptMarkerAsNewline: true });
        }
    });
});

describe('stripTelnetSequences is linear on hostile input', () => {
    const BUDGET_MS = 500;
    const timed = (data: string) => {
        const handler = createTelnetOptionParser(() => {});
        const t0 = performance.now();
        stripTelnetSequences(data, handler);
        const ms = performance.now() - t0;
        expect(ms, `took ${ms.toFixed(0)}ms`).toBeLessThan(BUDGET_MS);
    };

    it('on 50k repetitions of IAC SB', () => {
        timed((IAC + SB).repeat(50_000));
    });

    it('on 50k repetitions of IAC SB after an IAC SE', () => {
        // The case the IAC SE pre-check could not cover: a terminator exists,
        // but before every IAC SB rather than after it. The regex rescanned to
        // end-of-buffer from each one (seconds at this size).
        timed(IAC + SE + (IAC + SB).repeat(50_000));
    });
});
