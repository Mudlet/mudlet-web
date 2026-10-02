// @vitest-environment node
//
// mudlet-web#272, items 2 and 3 — measured against the Mudlet PTB:
//  - `CSI n C` (cursor forward) is n spaces whose foreground is the background;
//    `ESC[C` and `ESC[0C` are ignored.
//  - A colon-joined SGR parameter other than 38/48/3/4 (SGR 58/59 underline
//    colour, `1:3`) is ignored whole rather than read as codes of its own.
// Both the plain ANSI parser and the MXP parser read incoming lines, so each
// case runs through both.
import { describe, it, expect } from 'vitest';
import { AnsiAwareBuffer, type FormatStateSnapshot } from '../../../src/mud/text/FormatState';
import { MxpParser } from '../../../src/mud/protocol/mxp';
import { MAX_CURSOR_FORWARD } from '../../../src/mud/text/ansiEscapes';

const E = '\x1b';

type Parsed = { text: string; stateAt: (i: number) => FormatStateSnapshot | undefined };

function viaAnsi(raw: string): Parsed {
    const b = new AnsiAwareBuffer(raw);
    return { text: b.text, stateAt: i => b.getStateAt(i) };
}

function viaMxp(raw: string): Parsed {
    const r = new MxpParser({ send: () => {} }).parseLine(raw);
    const b = new AnsiAwareBuffer(r.segments);
    return { text: r.plain, stateAt: i => b.getStateAt(i) };
}

/** The attributes getTextFormat would report, as a sorted list. */
function attrs(s: FormatStateSnapshot | undefined): string[] {
    if (!s) return [];
    const out: string[] = [];
    if (s.bold) out.push('bold');
    if (s.italic) out.push('italic');
    if (s.underline) out.push(`underline=${s.underlineStyle ?? 'solid'}`);
    if (s.inverse) out.push('reverse');
    if (s.strikethrough) out.push('strikeout');
    if (s.slowBlink) out.push('blink=slow');
    if (s.rapidBlink) out.push('blink=fast');
    return out.sort();
}

describe.each([
    ['ANSI parser', viaAnsi],
    ['MXP parser', viaMxp],
])('mudlet-web#272 via the %s', (_name, parse) => {
    describe('CSI n C — cursor forward', () => {
        it.each([
            [`U1 a${E}[3CXXb`, 'U1 a   XXb'],
            [`Z2 ${E}[10Cindented`, 'Z2           indented'],
            [`Z3 ${E}[1;32mName${E}[0m${E}[8CLevel`, 'Z3 Name        Level'],
        ])('%j stands for spaces', (raw, want) => {
            expect(parse(raw).text).toBe(want);
        });

        it.each([`a${E}[Cb`, `a${E}[0Cb`, `a${E}[1;2Cb`])('%j is ignored', raw => {
            expect(parse(raw).text).toBe('ab');
        });

        it('clamps a huge count instead of throwing, and the text after it still renders', () => {
            const p = parse(`a${E}[999999999C${E}[32mafter`);
            expect(p.text).toBe(`a${' '.repeat(MAX_CURSOR_FORWARD)}after`);
            expect(p.stateAt(p.text.length - 1)?.foreground).toEqual({ space: 'hex', color: '#008000' });
        });

        it('paints the spaces in the background colour, keeping the attributes', () => {
            const p = parse(`a${E}[31;44;4m${E}[2Cb`);
            expect(p.text).toBe('a  b');
            const gap = p.stateAt(1)!;
            expect(gap.background).toEqual(gap.foreground);
            expect(gap.background).toBeDefined();
            expect(gap.underline).toBe(true);
            // The text after it is back in the pen's own colours.
            expect(p.stateAt(3)!.foreground).not.toEqual(p.stateAt(3)!.background);
        });
    });

    describe('SGR sub-parameters that Mudlet ignores', () => {
        it.each([
            [`${E}[58:5:3m`, []],
            [`${E}[58:2::1:2:1m`, []],
            [`${E}[58:2:4:5:7m`, []],
            [`${E}[4:3;58:5:9m`, ['underline=wavy']],
            [`${E}[59:1m`, []],
            [`${E}[1:3m`, []],
            [`${E}[4:3;58:2::255:0:0m`, ['underline=wavy']],
        ])('%j', (seq, want) => {
            const p = parse(`${seq}X`);
            expect(attrs(p.stateAt(0))).toEqual(want);
        });

        it('58:5:5 after a colon 256-colour foreground adds no format', () => {
            const p = parse(`${E}[38:5:9mcolon256 ${E}[58:5:5mulcolor`);
            expect(attrs(p.stateAt(p.text.indexOf('ulcolor')))).toEqual([]);
        });
    });
});
