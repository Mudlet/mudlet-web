// @vitest-environment node
// MXP drift against Mudlet desktop reported in mudlet/mudlet-web#353: the
// entity table, &newline;, a game's entities overriding built-in names, a
// stray `<` inside an unfinished tag, closing an EMPTY element, QColor's
// colour names and hex forms, and an <A> click that must never reach the game.
import { describe, it, expect } from 'vitest';
import { MxpParser, splitMxpResultLines } from '../../../src/mud/protocol/mxp';
import { mxpColor } from '../../../src/mud/text/colorParsers';
import type { BufferSegment } from '../../../src/mud/text/FormatState';
import { MudSession } from '../../../src/mud/MudSession';
import { AliasEngine } from '../../../src/mud/aliases/AliasEngine';
import { TriggerEngine } from '../../../src/mud/triggers/TriggerEngine';
import { TimerEngine } from '../../../src/mud/timers/TimerEngine';
import { KeyEngine } from '../../../src/mud/keybindings/KeyEngine';
import { ScriptingAPI } from '../../../src/scripting/ScriptingAPI';

const ESC = '\x1b';
const SECURE = `${ESC}[1z`;

function stateOf(segments: BufferSegment[], substr: string) {
  return segments.find(s => s.text.includes(substr))?.state;
}

const rgb = (r: number, g: number, b: number) => ({ space: 'rgb', r, g, b });

describe('#353 — entities', () => {
  it('resolves the whole of Mudlet\'s named entity table', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine('&quot;q&quot; &copy; &eacute; &szlig; &excl; &tab;tb &frac12; &deg;');
    expect(r.plain).toBe('"q" © é ß ! \ttb ½ °');
  });

  it('matches a built-in name as written first, then lowercased', () => {
    const parser = new MxpParser({ send: () => {} });
    expect(parser.parseLine('&Auml; &auml; &COPY; &AMP;').plain).toBe('Ä ä © &');
  });

  it('does not find names on Object\'s prototype', () => {
    const parser = new MxpParser({ send: () => {} });
    expect(parser.parseLine('&constructor; &toString;').plain).toBe('&constructor; &toString;');
  });

  it('fills named entities into a SEND\'s command', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine(`${SECURE}<SEND "say &copy;">x</SEND>`);
    expect(r.links[0].payload).toBe('say ©');
  });

  it('&newline; breaks the line', () => {
    const parser = new MxpParser({ send: () => {} });
    const parts = splitMxpResultLines(parser.parseLine('X21 aa&newline;X22 bb'));
    expect(parts.map(p => p.plain)).toEqual(['X21 aa', 'X22 bb']);
  });

  it('a game\'s <!ENTITY> overrides a built-in name, by any case', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine(`${SECURE}<!ENTITY lt "LT"><!ENTITY amp "AMP">&lt; &amp; &LT;`);
    expect(r.plain).toBe('LT AMP LT');
  });

  it('a game\'s entity is found by any case, and deleted by any case', () => {
    const parser = new MxpParser({ send: () => {} });
    expect(parser.parseLine(`${SECURE}<!ENTITY Hp "50">&hp; &HP;`).plain).toBe('50 50');
    expect(parser.parseLine(`${SECURE}<!ENTITY HP DELETE>&hp;`).plain).toBe('&hp;');
  });
});

describe('#353 — a stray < inside an unfinished tag', () => {
  it('leaves the first < as text on a secure line', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine(`${SECURE}a<b and <3> ok`);
    expect(r.plain).toBe('a<b and <3> ok');
    expect(stateOf(r.segments, 'ok')?.bold).toBeFalsy();
    // and no bold carries into the next line
    const next = parser.parseLine('after');
    expect(stateOf(next.segments, 'after')?.bold).toBeFalsy();
  });

  it('leaves it as text on an open line', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine('x<i love <3> it');
    expect(r.plain).toBe('x<i love <3> it');
    expect(stateOf(r.segments, 'it')?.bold).toBeFalsy();
    expect(stateOf(r.segments, 'it')?.italic).toBeFalsy();
  });

  it('still reads the tag that follows the stray <', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine('a<b <b>bold</b>');
    expect(r.plain).toBe('a<b bold');
    expect(stateOf(r.segments, 'bold')?.bold).toBe(true);
  });

  it('a < inside a quoted value is part of the tag', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine(`${SECURE}<SEND href="say <3">heart</SEND>`);
    expect(r.plain).toBe('heart');
    expect(r.links[0].payload).toBe('say <3');
  });
});

describe('#353 — EMPTY elements', () => {
  it('</name> closes what an EMPTY element\'s definition opened', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine(`${SECURE}<!ELEMENT rd '<COLOR red><B>' EMPTY><rd>ra</rd> rb`);
    expect(r.plain).toBe('ra rb');
    expect(stateOf(r.segments, 'ra')?.foreground).toEqual(rgb(255, 0, 0));
    expect(stateOf(r.segments, 'ra')?.bold).toBe(true);
    expect(stateOf(r.segments, 'rb')?.foreground).toBeUndefined();
    expect(stateOf(r.segments, 'rb')?.bold).toBeFalsy();
  });

  it('an EMPTY element left unclosed keeps its formatting', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine(`${SECURE}<!ELEMENT rd '<B>' EMPTY><rd>ra rb`);
    expect(stateOf(r.segments, 'rb')?.bold).toBe(true);
  });
});

describe('#353 — <COLOR> resolves what QColor(name) resolves', () => {
  it.each([
    ['aliceblue', 240, 248, 255],
    ['cornflowerblue', 100, 149, 237],
    ['darkgoldenrod', 184, 134, 11],
    ['mediumseagreen', 60, 179, 113],
    ['slategray', 112, 128, 144],
    ['yellowgreen', 154, 205, 50],
    ['YellowGreen', 154, 205, 50],
    ['yellow green', 154, 205, 50],
    ['transparent', 0, 0, 0],
    ['#80ff0000', 255, 0, 0],
    ['#123456789', 18, 69, 120],
    ['#f00', 255, 0, 0],
    ['#ffff00000000', 255, 0, 0],
  ])('%s', (name, r, g, b) => {
    expect(mxpColor(name)).toEqual(rgb(r, g, b));
  });

  it('rejects hex of a length Qt does not read', () => {
    expect(mxpColor('#12345')).toBeNull();
    expect(mxpColor('#gg0000')).toBeNull();
  });

  it('colours text in a <COLOR> tag', () => {
    const parser = new MxpParser({ send: () => {} });
    const r = parser.parseLine(`${SECURE}<COLOR cornflowerblue>x</COLOR>`);
    expect(stateOf(r.segments, 'x')?.foreground).toEqual(rgb(100, 149, 237));
  });
});

describe('#353 — an <A> is opened, never sent to the game', () => {
  function makeApi() {
    const w = globalThis as { window?: unknown };
    const opened: string[] = [];
    w.window = { innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {},
      open: (u: string) => { opened.push(u); return {}; } };
    const api = new ScriptingAPI(
      new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(),
      'test-connection',
    );
    const sent: string[] = [];
    (api as unknown as { send: (c: string) => void }).send = (c: string) => { sent.push(c); };
    return { api, sent, opened };
  }

  it('reports every <A> as a url link', () => {
    const parser = new MxpParser({ send: () => {} });
    const kinds = [
      `${SECURE}<A href="RESULT a1">x</A>`,
      `${SECURE}<A>RESULT a3</A>`,
      `${SECURE}<A href="RESULT www.example.invalid/x">x</A>`,
      `${SECURE}<A href="www.site.com">x</A>`,
      `${SECURE}<A href="https://mudlet.org/">x</A>`,
    ].map(l => parser.parseLine(l).links[0].kind);
    expect(kinds).toEqual(['url', 'url', 'url', 'url', 'url']);
  });

  it('a click sends nothing to the game, and opens only a web address', () => {
    const { api, sent, opened } = makeApi();
    for (const href of ['RESULT a1', 'www.site.com', 'javascript:alert(1)', 'https://mudlet.org/']) {
      api.createMxpHyperlink('url', href).onClick?.(new Event('click') as MouseEvent);
    }
    expect(sent).toEqual([]);
    expect(opened).toEqual(['https://mudlet.org/']);
  });
});
