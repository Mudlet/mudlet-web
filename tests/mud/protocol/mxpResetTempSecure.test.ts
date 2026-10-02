// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { MxpParser } from '../../../src/mud/protocol/mxp';

/**
 * Issue #279 (follow-up to #258): `ESC[3z` (reset) and the end of an `ESC[4z`
 * (temp secure) tag go back to the DEFAULT mode — Mudlet's
 * `mMXP_MODE = mMXP_DEFAULT` — not to OPEN. A bare `IAC SB MXP IAC SE` starts
 * the processor with LOCKED as the default, so on such a session both leave
 * the rest of the line, and the next line, literal.
 */

const ESC = '\x1b';
const LINE = (n: string) => `<B>w${n}</B> &amp;`;

function lockedParser() {
  const parser = new MxpParser({ send: () => {} });
  parser.setLockedMode('locked'); // what the bare SB asks for
  return parser;
}

describe('MXP ESC[3z / ESC[4z return to the default mode (issue #279)', () => {
  it('ESC[3z on a locked-default session leaves the line literal', () => {
    const parser = lockedParser();
    expect(parser.parseLine(`${ESC}[3z${LINE('08')}`).plain).toBe('<B>w08</B> &amp;');
    expect(parser.parseLine(LINE('09')).plain).toBe('<B>w09</B> &amp;');
  });

  it('ESC[4z parses exactly one tag, then the default (LOCKED) mode holds', () => {
    const parser = lockedParser();
    const r = parser.parseLine(`${ESC}[4z${LINE('10')}`);
    expect(r.plain).toBe('w10</B> &amp;');
    expect(r.segments.find(s => s.text.includes('w10'))?.state?.bold).toBe(true);
    expect(parser.parseLine(LINE('11')).plain).toBe('<B>w11</B> &amp;');
  });

  it('ESC[3z keeps a lock the game set with ESC[7z', () => {
    const parser = new MxpParser({ send: () => {} });
    parser.parseLine(`${ESC}[7z`);
    expect(parser.parseLine(`${ESC}[3z${LINE('1')}`).plain).toBe('<B>w1</B> &amp;');
  });

  it('on an OPEN-default session both still return to OPEN', () => {
    const parser = new MxpParser({ send: () => {} });
    expect(parser.parseLine(`${ESC}[3z${LINE('1')}`).plain).toBe('w1 &');
    expect(parser.parseLine(`${ESC}[4z<B>a</B> &amp;`).plain).toBe('a &');
  });

  it('after ESC[4z on a line locked by ESC[2z, the line does not go back to LOCKED but to the default', () => {
    const parser = new MxpParser({ send: () => {} });
    expect(parser.parseLine(`${ESC}[2z${ESC}[4z<B>a</B> <B>b</B>`).plain).toBe('a b');
  });

  it('an unrecognised tag does not spend the temp-secure mode', () => {
    const parser = lockedParser();
    expect(parser.parseLine(`${ESC}[4z<nosuchtag><B>x</B> <B>y</B>`).plain).toBe('<nosuchtag>x</B> <B>y</B>');
  });
});
