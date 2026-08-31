// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { MxpParser } from '../../../src/mud/protocol/mxp';
import type { BufferSegment } from '../../../src/mud/text/FormatState';

const ESC = '\x1b';
const SECURE = `${ESC}[1z`; // switch the current line into SECURE mode

/** A parser whose handshake sends are captured for assertions. */
function makeParser() {
  const sent: string[] = [];
  const parser = new MxpParser({ send: (raw) => sent.push(raw) });
  return { parser, sent };
}

/** Find the snapshot state covering a given plain-text substring. */
function stateOf(segments: BufferSegment[], substr: string) {
  return segments.find(s => s.text.includes(substr))?.state;
}

describe('MxpParser — formatting & entities', () => {
  it('applies bold/italic/underline/strikeout formatting tags', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}<b>A</b><i>B</i><u>C</u><s>D</s>`);
    expect(r.plain).toBe('ABCD');
    expect(stateOf(r.segments, 'A')?.bold).toBe(true);
    expect(stateOf(r.segments, 'B')?.italic).toBe(true);
    expect(stateOf(r.segments, 'C')?.underline).toBe(true);
    expect(stateOf(r.segments, 'D')?.strikethrough).toBe(true);
  });

  it('resolves named, hex, and rgb colors via <COLOR>/<FONT>', () => {
    const { parser } = makeParser();
    let r = parser.parseLine(`${SECURE}<color red>X</color>`);
    expect(r.plain).toBe('X');
    expect(stateOf(r.segments, 'X')?.foreground).toEqual({ space: 'rgb', r: 255, g: 0, b: 0 });

    r = parser.parseLine(`${SECURE}<color #00ff00>Y</color>`);
    expect(stateOf(r.segments, 'Y')?.foreground).toEqual({ space: 'rgb', r: 0, g: 255, b: 0 });

    r = parser.parseLine(`${SECURE}<font color="rgb(0,0,255)">Z</font>`);
    expect(stateOf(r.segments, 'Z')?.foreground).toEqual({ space: 'rgb', r: 0, g: 0, b: 255 });
  });

  it('keeps the MXP <COLOR> over embedded ANSI SGR for the whole span', () => {
    const { parser } = makeParser();
    const silver = { space: 'rgb' as const, r: 0xc0, g: 0xc0, b: 0xc0 };
    // Mirrors the server's clickable-item markup: a <COLOR> span whose middle
    // run carries its own ANSI fg. Mudlet paints the whole span the MXP colour;
    // the embedded ANSI only matters once the tag closes. (Base colour carried
    // in, as on the real line, so the post-</color> run is unambiguous.)
    const r = parser.parseLine(
      `${SECURE}<color #c0c0c0>name${ESC}[38;5;2m550114${ESC}[38;5;7m</color> desc`,
      { foreground: silver },
    );
    expect(r.plain).toBe('name550114 desc');
    expect(stateOf(r.segments, 'name')?.foreground).toEqual(silver);
    // The digits must stay silver, not the embedded ANSI green (38;5;2).
    expect(stateOf(r.segments, '550114')?.foreground).toEqual(silver);
    expect(stateOf(r.segments, 'desc')?.foreground).toEqual(silver);
  });

  it('decodes builtin and numeric entities into plain text', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}&lt;tag&gt; &amp; &#65;&#x42;`);
    expect(r.plain).toBe('<tag> & AB');
  });

  it('layers MXP formatting on top of interspersed ANSI SGR', () => {
    const { parser } = makeParser();
    // ANSI red, then MXP bold — the 'hi' run should be both.
    const r = parser.parseLine(`${SECURE}${ESC}[31m<b>hi</b>`);
    const st = stateOf(r.segments, 'hi');
    expect(st?.bold).toBe(true);
    expect(st?.foreground).toBeTruthy();
  });
});

describe('MxpParser — secure-mode gating', () => {
  it('ignores <SEND> in OPEN mode (no link, text rendered literally)', () => {
    const { parser } = makeParser();
    const r = parser.parseLine('<send>north</send>'); // default OPEN mode
    expect(r.plain).toBe('north');
    expect(r.links).toHaveLength(0);
  });

  it('honors <SEND> in SECURE mode', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}<send>north</send>`);
    expect(r.plain).toBe('north');
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ kind: 'command', payload: 'north', start: 0, end: 5 });
  });

  it('treats a LOCKED line as literal text', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${ESC}[2z<b>not bold</b>`);
    expect(r.plain).toBe('<b>not bold</b>');
    expect(r.links).toHaveLength(0);
  });

  it('lets a per-line SECURE tag override a locked-locked default (Avalon)', () => {
    // Avalon wraps every MXP control in ESC[1z … ESC[7z: ESC[7z (lock-locked)
    // sets the *default* line mode, ESC[1z re-enters SECURE for the next tag.
    // A lock mode must not beat a per-line mode tag on the same/following line,
    // or every tag after the first ESC[7z degrades to literal text.
    const { parser, sent } = makeParser();

    // Handshake frame: ESC[7z poisons the locked default; the second handshake
    // tag must still fire its reply.
    parser.parseLine(`${SECURE}<support>${ESC}[7z${SECURE}<version>${ESC}[7z`);
    expect(sent.some(s => /<SUPPORTS /.test(s))).toBe(true);
    expect(sent.some(s => /<VERSION /.test(s))).toBe(true);

    // Later game line: a <send> wrapped the same way must still produce a link.
    const r = parser.parseLine(`Tippe ${SECURE}<send hilfe>${ESC}[7zhilfe${SECURE}</send> dazu`);
    expect(r.plain).toBe('Tippe hilfe dazu');
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ kind: 'command', payload: 'hilfe' });
  });
});

describe('MxpParser — links', () => {
  it('uses an explicit href and hint, computes offsets across entities', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}go <send href="open door" hint="Open it">&lt;door&gt;</send>!`);
    expect(r.plain).toBe('go <door>!');
    expect(r.links).toHaveLength(1);
    const link = r.links[0];
    expect(link.payload).toBe('open door');
    expect(link.hint).toBe('Open it');
    expect(r.plain.slice(link.start, link.end)).toBe('<door>');
  });

  it('opens http(s) <A HREF> as a url link', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}<a href="https://example.com">site</a>`);
    expect(r.links[0]).toMatchObject({ kind: 'url', payload: 'https://example.com' });
  });

  it('substitutes &text; in href with the display text', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}<send href="kill &text;">orc</send>`);
    expect(r.links[0].payload).toBe('kill orc');
  });

  it('builds a multi-command popup from a cmd1|cmd2 list', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}<send href="look|get all" hint="tip|Look|Get all">chest</send>`);
    const link = r.links[0];
    expect(link.payload).toBe('look');
    expect(link.hint).toBe('tip');
    expect(link.prompts).toEqual({ cmds: ['look', 'get all'], hints: ['Look', 'Get all'] });
  });
});

describe('MxpParser — custom definitions', () => {
  it('expands a <!ELEMENT> definition with attribute substitution', () => {
    const { parser } = makeParser();
    parser.parseLine(`${SECURE}<!ELEMENT greet "<COLOR &col;>" ATT="col=white">`);
    const r = parser.parseLine(`${SECURE}<greet col=red>hi</greet>`);
    expect(r.plain).toBe('hi');
    expect(stateOf(r.segments, 'hi')?.foreground).toEqual({ space: 'rgb', r: 255, g: 0, b: 0 });
  });

  it('defines and expands a custom entity', () => {
    const { parser } = makeParser();
    parser.parseLine(`${SECURE}<!ENTITY world "Earth">`);
    const r = parser.parseLine('hello &world;');
    expect(r.plain).toBe('hello Earth');
  });
});

describe('MxpParser — handshake', () => {
  it('replies to <SUPPORT> with a secure-prefixed <SUPPORTS> list', () => {
    const { parser, sent } = makeParser();
    parser.parseLine('<support>');
    expect(sent).toHaveLength(1);
    // The ESC[1z secure-line marker must lead the reply so the server parses it
    // as MXP input rather than a command (Discworld login otherwise reads it as
    // a character name).
    expect(sent[0]).toMatch(/^\x1b\[1z<SUPPORTS .*\+send/);
  });

  it('replies to <VERSION> with a secure-prefixed reply', () => {
    const { parser, sent } = makeParser();
    parser.parseLine('<version>');
    expect(sent[0]).toMatch(/^\x1b\[1z<VERSION .*CLIENT="MUDLET-WEB"/);
  });
});

describe('MxpParser — robustness', () => {
  it('reunites a tag split across two parseLine calls', () => {
    const { parser } = makeParser();
    const a = parser.parseLine(`${SECURE}go <sen`);
    expect(a.plain).toBe('go '); // partial tag held back
    const b = parser.parseLine('d>north</send>');
    expect(b.plain).toBe('north');
    expect(b.links).toHaveLength(1);
    expect(b.links[0].payload).toBe('north');
  });

  it('emits a lone "<" that is not a tag as literal text', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}5 < 10 and 10 > 5`);
    expect(r.plain).toBe('5 < 10 and 10 > 5');
  });

  it('carries open formatting across lines via trailingSnapshot', () => {
    const { parser } = makeParser();
    const a = parser.parseLine(`${SECURE}<b>start`); // <b> left open
    expect(a.trailingSnapshot?.bold).toBe(true);
    const b = parser.parseLine('continues', a.trailingSnapshot);
    expect(stateOf(b.segments, 'continues')?.bold).toBe(true);
  });

  it('reset() clears definitions, entities, and open tags', () => {
    const { parser } = makeParser();
    parser.parseLine(`${SECURE}<!ENTITY x "Y">`);
    parser.reset();
    const r = parser.parseLine('&x;');
    expect(r.plain).toBe('&x;'); // entity no longer defined → literal
  });
});

// <HR> is not written out as a rule, it is fed back through the parser as text
// (Mudlet's TMxpHRTagHandler): a newline to commit whatever the line held, the
// dashes, and a newline so the next text stands on its own.
describe('MxpParser — HR', () => {
  it('draws the rule as wide as the window wraps', () => {
    const sent: string[] = [];
    const parser = new MxpParser({ send: (r) => sent.push(r), wrapWidth: () => 100 });
    const r = parser.parseLine(`${SECURE}MXPRULE1<hr>MXPRULE2`);
    expect(r.plain).toBe(`MXPRULE1\n${'-'.repeat(100)}\nMXPRULE2`);
  });

  it('holds a forty column floor however narrowly the window wraps', () => {
    const sent: string[] = [];
    const parser = new MxpParser({ send: (r) => sent.push(r), wrapWidth: () => 10 });
    expect(parser.parseLine(`${SECURE}<hr>`).plain).toBe(`\n${'-'.repeat(40)}\n`);
  });

  it('falls back to eighty columns when nothing reports a width', () => {
    const { parser } = makeParser();
    expect(parser.parseLine(`${SECURE}<hr>`).plain).toBe(`\n${'-'.repeat(80)}\n`);
  });
});

// Mudlet applies an ESC[#z only to data flagged as coming from the server
// (TBuffer.cpp's isFromServer gate on mMxpProcessor.setMode). A script feeding a
// captured game line must not be able to leave the parser in whatever mode that
// capture ended on — the next real tag would then be discarded as unsafe.
describe('MxpParser — ESC[#z only switches mode for server data', () => {
  it('consumes the sequence either way, so it is never printed', () => {
    const { parser } = makeParser();
    expect(parser.parseLine(`${SECURE}<b>hi</b>${ESC}[7z`, undefined, false).plain).toBe('hi');
  });

  // The setup a script feeding markup actually runs under: the processor forced
  // on, which locks secure mode (specialForceMXPProcessorOn). A captured game
  // line ending on ESC[7z must not take that lock away, or every later tag the
  // script feeds is discarded as unsafe — which is what MXP_spec's frame setup
  // ran into.
  it('a locally-fed lock cannot undo the forced secure mode', () => {
    const { parser } = makeParser();
    parser.lockSecureMode(true);
    parser.parseLine(`${ESC}[7z`, undefined, false);
    expect(parser.parseLine('<frame Status>', undefined, false).frames?.[0]?.name).toBe('Status');
  });

  it('the same lock from the game does take effect', () => {
    const { parser } = makeParser();
    parser.lockSecureMode(true);
    parser.parseLine(`${ESC}[7z`);
    expect(parser.parseLine('<frame Status>', undefined, false).frames).toBeUndefined();
  });
});
