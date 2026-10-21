// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { MxpParser } from '../../../src/mud/protocol/mxp';

/**
 * `ESC[3z` (reset) opens the line it is on — open, not the default, or a secure
 * default would let that line use secure tags — and the end of an `ESC[4z`
 * (temp secure) tag goes back to the line's own mode (TMxpProcessor::setMode,
 * processMxpInput). The default applies again from the next line.
 */

const ESC = '\x1b';
const LINE = (n: string) => `<B>w${n}</B> &amp;`;

describe('MXP ESC[3z / ESC[4z', () => {
  it('ESC[3z opens a line under a locked default, which holds again on the next line', () => {
    const parser = new MxpParser({ send: () => {} });
    parser.parseLine(`${ESC}[7z`);
    expect(parser.parseLine(`${ESC}[3z${LINE('1')}`).plain).toBe('w1 &');
    expect(parser.parseLine(LINE('2')).plain).toBe('<B>w2</B> &amp;');
  });

  it('ESC[3z under a secure default opens the line, so secure tags stay text', () => {
    const parser = new MxpParser({ send: () => {} });
    parser.parseLine(`${ESC}[6z`);
    expect(parser.parseLine(`${ESC}[3z<SEND href="x">a</SEND>`).plain).toBe('<SEND href="x">a</SEND>');
  });

  it('ESC[4z parses exactly one tag, then the line\'s own mode holds', () => {
    const parser = new MxpParser({ send: () => {} });
    parser.parseLine(`${ESC}[7z`);
    const r = parser.parseLine(`${ESC}[4z${LINE('10')}`);
    expect(r.plain).toBe('w10</B> &amp;');
    expect(r.segments.find(s => s.text.includes('w10'))?.state?.bold).toBe(true);
    expect(parser.parseLine(LINE('11')).plain).toBe('<B>w11</B> &amp;');
  });

  it('after ESC[4z on a line opened by ESC[3z under a secure default, the line stays open', () => {
    const parser = new MxpParser({ send: () => {} });
    parser.parseLine(`${ESC}[6z`);
    expect(parser.parseLine(`${ESC}[3z${ESC}[4z<B>a</B> <SEND href="y">b</SEND>`).plain).toBe('a <SEND href="y">b</SEND>');
  });

  it('an unrecognised tag does not spend the temp-secure mode', () => {
    const parser = new MxpParser({ send: () => {} });
    parser.parseLine(`${ESC}[7z`);
    expect(parser.parseLine(`${ESC}[4z<nosuchtag><B>x</B> <B>y</B>`).plain).toBe('<nosuchtag>x</B> <B>y</B>');
  });
});
