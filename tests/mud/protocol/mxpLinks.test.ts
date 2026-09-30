// @vitest-environment node
// The Lua an MXP link reports, the EXPIRE tag that retires links, and the
// line-boundary rules of #258 — each pinned against what Mudlet does.
import { describe, it, expect } from 'vitest';
import { MxpParser } from '../../../src/mud/protocol/mxp';
import { quoteLuaLiteral } from '../../../src/mud/protocol/luaLiteral';
import type { BufferSegment } from '../../../src/mud/text/FormatState';

const ESC = '\x1b';
const SECURE = `${ESC}[1z`;

type Event = { name: string; attrs: Record<string, string>; body?: { text: string; actions: string[] } };

function makeParser() {
  const events: Event[] = [];
  const parser = new MxpParser({
    send: () => {},
    onElementEvent: (name, attrs, body) => events.push({ name, attrs, body }),
  });
  // A plain element fed after a link reports the newest link's actions, as
  // the busted specs read them.
  parser.parseLine(`${SECURE}<!ELEMENT probe FLAG='probe'>`);
  const currentActions = () => {
    parser.parseLine(`${SECURE}<probe>p</probe>`);
    return events.filter(e => e.name === 'probe').at(-1)?.body?.actions;
  };
  const lastSend = () => events.filter(e => e.name === 'send').at(-1);
  return { parser, events, currentActions, lastSend };
}

function stateOf(segments: BufferSegment[], substr: string) {
  return segments.find(s => s.text.includes(substr))?.state;
}

describe('quoteLuaLiteral', () => {
  it('uses a plain long bracket when nothing in the text can end it', () => {
    expect(quoteLuaLiteral('look')).toBe('[[\nlook]]');
  });

  it.each([
    ['x]]..os.exit()..[[', '[=[\nx]]..os.exit()..[[]=]'],
    // `]=]` and `[=[` only end or open a level-one bracket, so level zero holds them
    ['x]=]..os.exit()..[=[', '[[\nx]=]..os.exit()..[=[]]'],
    ['x]]]=]', '[==[\nx]]]=]]==]'],
    ['x]', '[=[\nx]]=]'],
    ['x[[y', '[=[\nx[[y]=]'],
  ])('raises the level past %j', (text, quoted) => {
    expect(quoteLuaLiteral(text)).toBe(quoted);
  });
});

describe('MxpParser — the Lua a link reports', () => {
  it('quotes every command of a SEND menu, &text; filled in before quoting', () => {
    const { parser, lastSend } = makeParser();
    parser.parseLine(`${SECURE}<SEND href="look &text;|get &text;" hint="menu|l|g">x]]..os.exit()--</SEND>`);
    expect(lastSend()?.body?.actions).toEqual([
      'send([=[\nlook x]]..os.exit()--]=])',
      'send([=[\nget x]]..os.exit()--]=])',
    ]);
  });

  it('reports an A link to the next custom element as openUrl', () => {
    const { parser, currentActions } = makeParser();
    parser.parseLine(`${SECURE}<A href="https://example.com/a]]">x</A>`);
    expect(currentActions()).toEqual(['openUrl([=[\nhttps://example.com/a]]]=])']);
  });

  it('takes a bare A address from its own text only', () => {
    const { parser, currentActions } = makeParser();
    parser.parseLine(`${SECURE}<A>https://first.example/</A>`);
    parser.parseLine(`${SECURE}<A>https://second.example/</A>`);
    expect(currentActions()).toEqual(['openUrl([[\nhttps://second.example/]])']);
  });

  it('leaves out of &text; a tag inside the link that was shown as text', () => {
    const { parser, currentActions } = makeParser();
    const r = parser.parseLine(`${SECURE}<A>https://outer.example/<A hint="tip"></A></A>`);
    expect(r.plain).toBe('https://outer.example/<A hint="tip">');
    expect(currentActions()).toEqual(['openUrl([[\nhttps://outer.example/]])']);
  });

  it('shows an A with attributes but no address as text', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`${SECURE}<A hint="nowhere">text</A>`);
    expect(r.plain).toBe('<A hint="nowhere">text');
    expect(r.links).toEqual([]);
  });

  it('fills the game\'s entities into a SEND href', () => {
    const { parser, lastSend } = makeParser();
    parser.parseLine(`${SECURE}<!ENTITY dir "north">`);
    const r = parser.parseLine(`${SECURE}<SEND href="go &dir;">GO</SEND>`);
    expect(r.links[0].payload).toBe('go north');
    expect(lastSend()?.body?.actions).toEqual(['send([[\ngo north]])']);
  });

  // An element's attribute goes into its definition's tags after they have
  // been read, so a quote in the value cannot end the attribute it lands in.
  it('keeps an element attribute with a quote in it inside its attribute', () => {
    const { parser, lastSend } = makeParser();
    parser.parseLine(`${SECURE}<!ELEMENT tell '<SEND href="tell &who; " PROMPT>' ATT='who'>`);
    parser.parseLine(`${SECURE}<tell 'x")..os.exit()..("'>who</tell>`);
    expect(lastSend()?.body?.actions).toEqual(['printCmdLine([[\ntell x")..os.exit()..(" ]])']);
  });
});

describe('MxpParser — EXPIRE', () => {
  it('retires only the links made with the name it gives', () => {
    const { parser, currentActions } = makeParser();
    const kept = parser.parseLine(`${SECURE}<SEND href="a" expire=keep>A</SEND>`).links[0];
    const gone = parser.parseLine(`${SECURE}<SEND href="b" expire=gone>B</SEND>`).links[0];
    const plain = parser.parseLine(`${SECURE}<SEND href="c">C</SEND>`).links[0];
    const r = parser.parseLine(`${SECURE}before<EXPIRE gone>after`);
    expect(r.plain).toBe('beforeafter');
    expect(parser.isLinkLive(kept.id)).toBe(true);
    expect(parser.isLinkLive(gone.id)).toBe(false);
    expect(parser.isLinkLive(plain.id)).toBe(true);
    // The newest link was not in the group, so it is still reported
    expect(currentActions()).toEqual(['send([[\nc]])']);
  });

  it('empties the newest link when it is retired, by NAME too', () => {
    const { parser, currentActions } = makeParser();
    parser.parseLine(`${SECURE}<A href="https://example.com/" expire=grp>x</A>`);
    parser.parseLine(`${SECURE}<EXPIRE name="grp">`);
    expect(currentActions()).toEqual([]);
  });

  it('shows an EXPIRE that names nothing as text', () => {
    const { parser } = makeParser();
    expect(parser.parseLine(`${SECURE}<EXPIRE>rest`).plain).toBe('<EXPIRE>rest');
  });
});

describe('MxpParser — definitions Mudlet cannot act on', () => {
  it('shows an element definition with nothing after the name as text', () => {
    const { parser } = makeParser();
    expect(parser.parseLine(`${SECURE}<!ELEMENT bare>after`).plain).toBe('<!ELEMENT bare>after');
  });

  it('shows an entity definition that names nothing as text', () => {
    const { parser } = makeParser();
    expect(parser.parseLine(`${SECURE}<!ENTITY>after`).plain).toBe('<!ENTITY>after');
  });
});

describe('MxpParser — line modes (#258)', () => {
  it('closes the tags an OPEN line left open at its end', () => {
    const { parser } = makeParser();
    const a = parser.parseLine('<B>bold unclosed');
    expect(stateOf(a.segments, 'bold')?.bold).toBe(true);
    expect(a.trailingSnapshot?.bold).toBeFalsy();
    const b = parser.parseLine('after', a.trailingSnapshot);
    expect(stateOf(b.segments, 'after')?.bold).toBeFalsy();
  });

  it('closes open-mode tags when the line switches to secure', () => {
    const { parser } = makeParser();
    const r = parser.parseLine(`<I>open${SECURE}secure`);
    expect(stateOf(r.segments, 'open')?.italic).toBe(true);
    expect(stateOf(r.segments, 'secure')?.italic).toBeFalsy();
  });

  it('keeps a secure line\'s tags open into the next line', () => {
    const { parser } = makeParser();
    const a = parser.parseLine(`${SECURE}<B>bold`);
    expect(a.trailingSnapshot?.bold).toBe(true);
  });

  // The line stays OPEN: B is taken out and SEND is not
  it('ignores a mode switch that carries no number, or more than one', () => {
    const { parser } = makeParser();
    expect(parser.parseLine(`${ESC}[z<B>b</B><SEND href="x">N</SEND>`).plain).toBe('b<SEND href="x">N</SEND>');
    expect(parser.parseLine(`${ESC}[1;2z<B>b</B><SEND href="x">N</SEND>`).plain).toBe('b<SEND href="x">N</SEND>');
  });

  it('shows markup literally once a subnegotiation has locked the processor', () => {
    const { parser } = makeParser();
    parser.setLockedMode('locked');
    expect(parser.parseLine('X01 <B>ba</B> &lt;').plain).toBe('X01 <B>ba</B> &lt;');
  });
});
