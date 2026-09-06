// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import {
  scanEscape,
  parseOsc8Payload,
  classifyHyperlinkUri,
  parseXColorSpec,
  parseOscColorPalette,
} from '../../../src/mud/text/ansiEscapes';
import { AnsiAwareBuffer } from '../../../src/mud/text/FormatState';
import { colorCodes, resetAllPaletteColors, setServerRedefineColorsAllowed } from '../../../src/mud/text/colors';
import { MxpParser } from '../../../src/mud/protocol/mxp';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

describe('scanEscape', () => {
  it('classifies an SGR CSI and reports its final byte + params', () => {
    const s = `${ESC}[1;31mX`;
    const esc = scanEscape(s, 0);
    expect(esc).toMatchObject({ kind: 'csi', finalByte: 'm', params: '1;31', end: 7 });
  });

  it('classifies a non-SGR CSI (cursor move) without consuming following text', () => {
    const s = `${ESC}[2JX`;
    const esc = scanEscape(s, 0);
    expect(esc).toMatchObject({ kind: 'csi', finalByte: 'J', end: 4 });
  });

  it('classifies an OSC 8 sequence terminated by BEL', () => {
    const s = `${ESC}]8;;https://example.com${BEL}link`;
    const esc = scanEscape(s, 0);
    expect(esc.kind).toBe('osc');
    expect(esc.oscPayload).toBe('8;;https://example.com');
    expect(s.slice(esc.end)).toBe('link');
  });

  it('classifies an OSC sequence terminated by ST (ESC \\)', () => {
    const s = `${ESC}]0;window title${ST}rest`;
    const esc = scanEscape(s, 0);
    expect(esc.kind).toBe('osc');
    expect(s.slice(esc.end)).toBe('rest');
  });

  it('reports an unterminated sequence as incomplete', () => {
    const esc = scanEscape(`${ESC}[1;31`, 0);
    expect(esc.kind).toBe('incomplete');
  });

  it('classifies a short escape (charset designation)', () => {
    const s = `${ESC}(BX`;
    const esc = scanEscape(s, 0);
    expect(esc).toMatchObject({ kind: 'esc', end: 3 });
  });
});

describe('AnsiAwareBuffer escape handling', () => {
  it('still parses SGR colour as before', () => {
    const buf = new AnsiAwareBuffer(`${ESC}[31mred${ESC}[0m`);
    expect(buf.text).toBe('red');
    expect(buf.getStateAt(0)?.foreground).toBeTruthy();
  });

  it('parses OSC 8 hyperlinks into a link span without leaking the wrapper', () => {
    const buf = new AnsiAwareBuffer(`${ESC}]8;;https://example.com${ST}click here${ESC}]8;;${ST}`);
    // Wrapper bytes never reach the screen.
    expect(buf.text).toBe('click here');
    // The link text carries the URI (handlers are wired later by the engine).
    expect(buf.getStateAt(0)?.hyperlink?.url).toBe('https://example.com');
    // The closing OSC 8;; ends the link.
    const tail = new AnsiAwareBuffer(`${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}after`);
    expect(tail.text).toBe('linkafter');
    expect(tail.getStateAt('linkafter'.indexOf('after'))?.hyperlink).toBeUndefined();
  });

  it('renders OSC 8 link text as clickable but NOT underlined in toHtml', () => {
    // Mudlet's HyperlinkStyling::isUnderlined defaults to false — OSC 8 links
    // are deliberately not underlined unless their config asks for it.
    const buf = new AnsiAwareBuffer(`${ESC}]8;;https://example.com${ST}go${ESC}]8;;${ST}`);
    const html = buf.toHtml();
    expect(html).toContain('data-output-clickable="true"');
    expect(html).not.toContain('text-decoration: underline');
  });

  it('underlines an OSC 8 link when its config asks for it', () => {
    const uri = 'send:go?config={"style":{"underline":true}}';
    const html = new AnsiAwareBuffer(`${ESC}]8;;${uri}${ST}go${ESC}]8;;${ST}`).toHtml();
    expect(html).toContain('text-decoration: underline');
  });

  it('drops OSC 8 links with a disallowed scheme (no link span)', () => {
    const buf = new AnsiAwareBuffer(`${ESC}]8;;javascript:alert(1)${ST}evil${ESC}]8;;${ST}`);
    expect(buf.text).toBe('evil');
    expect(buf.getStateAt(0)?.hyperlink).toBeUndefined();
  });

  it('binds OSC 8 link URIs to handlers via bindUrlHyperlinks', () => {
    const buf = new AnsiAwareBuffer(`${ESC}]8;;send:look${ST}look${ESC}]8;;${ST}`);
    let bound: string | undefined;
    buf.bindUrlHyperlinks((url) => { bound = url; return { onClick: () => {}, title: url }; });
    expect(bound).toBe('send:look');
    expect(buf.getStateAt(0)?.hyperlink?.onClick).toBeTypeOf('function');
  });

  it('ignores a non-SGR CSI without eating the text after it', () => {
    const buf = new AnsiAwareBuffer(`before${ESC}[2Jafter`);
    expect(buf.text).toBe('beforeafter');
  });

  it('does not run a cursor move into a later SGR (old indexOf("m") bug)', () => {
    // ESC[H has no 'm'; the old parser searched forward and swallowed up to the
    // next SGR's 'm', corrupting the line. Now each sequence ends at its own final.
    const buf = new AnsiAwareBuffer(`${ESC}[Hhome ${ESC}[32mgreen`);
    expect(buf.text).toBe('home green');
  });

  it('drops a truncated escape at end of line rather than rendering it', () => {
    const buf = new AnsiAwareBuffer(`text${ESC}[1;3`);
    expect(buf.text).toBe('text');
  });

  it('renders reverse video on default colours by swapping to console defaults', () => {
    // \e[7m with no explicit fg/bg used to render nothing — the colour swap
    // produced two undefined sources. Now it falls back to the console defaults.
    const buf = new AnsiAwareBuffer(`${ESC}[7mrev${ESC}[0m`);
    const html = buf.toHtml();
    expect(html).toContain('color: var(--console-bg)');
    expect(html).toContain('background: var(--console-text)');
  });

  it('swaps explicit fg/bg under reverse video', () => {
    // \e[31m sets red fg; reverse paints red as the background and the text
    // colour falls back to the console default (the swapped-in bg was unset).
    const buf = new AnsiAwareBuffer(`${ESC}[31;7mx${ESC}[0m`);
    const html = buf.toHtml();
    expect(html).toContain('background: rgb(');
    expect(html).toContain('color: var(--console-bg)');
  });
});

describe('AnsiAwareBuffer.toStyledRuns (copy-as-image)', () => {
  it('returns default (uncoloured) runs without colour/attrs', () => {
    const runs = new AnsiAwareBuffer('plain').toStyledRuns();
    expect(runs).toEqual([
      { text: 'plain', bold: false, italic: false, underline: false },
    ]);
  });

  it('resolves SGR colour and attributes to concrete values', () => {
    const buf = new AnsiAwareBuffer(`${ESC}[1;3;4;31mx${ESC}[0m`);
    const runs = buf.toStyledRuns().filter(r => r.text === 'x');
    expect(runs).toHaveLength(1);
    expect(runs[0].color).toMatch(/^#/);
    expect(runs[0].bold).toBe(true);
    expect(runs[0].italic).toBe(true);
    expect(runs[0].underline).toBe(true);
  });

  it('emits console-default CSS vars for reverse video on default colours', () => {
    const runs = new AnsiAwareBuffer(`${ESC}[7mrev${ESC}[0m`).toStyledRuns()
      .filter(r => r.text === 'rev');
    expect(runs[0].color).toBe('var(--console-bg)');
    expect(runs[0].background).toBe('var(--console-text)');
  });

  it('does not mark a plain OSC 8 link as underlined', () => {
    const buf = new AnsiAwareBuffer(`${ESC}]8;;https://example.com${ST}go${ESC}]8;;${ST}`);
    const runs = buf.toStyledRuns().filter(r => r.text === 'go');
    expect(runs[0].underline).toBe(false);
  });

  it('keeps the underline an SGR run already carries under an OSC 8 link', () => {
    const buf = new AnsiAwareBuffer(`${ESC}[4m${ESC}]8;;send:go${ST}go${ESC}]8;;${ST}${ESC}[0m`);
    const runs = buf.toStyledRuns().filter(r => r.text === 'go');
    expect(runs[0].underline).toBe(true);
  });
});

describe('MxpParser escape handling', () => {
  function parse(line: string) {
    const parser = new MxpParser({ send: () => {} });
    return parser.parseLine(line);
  }

  it('parses OSC 8 hyperlinks into a link span without leaking the wrapper', () => {
    const r = parse(`${ESC}]8;;https://example.com${ST}shop${ESC}]8;;${ST}`);
    expect(r.plain).toBe('shop');
    const linked = r.segments.find((s) => s.state?.hyperlink?.url);
    expect(linked?.state?.hyperlink?.url).toBe('https://example.com');
  });

  it('still applies SGR and consumes other CSI finals', () => {
    const r = parse(`${ESC}[31mred${ESC}[2Jmore`);
    expect(r.plain).toBe('redmore');
  });
});

describe('parseOsc8Payload', () => {
  it('splits params and URI', () => {
    expect(parseOsc8Payload('8;;https://example.com')).toEqual({ uri: 'https://example.com', id: undefined });
  });

  it('reads the id= param (colon-separated key=value pairs)', () => {
    expect(parseOsc8Payload('8;id=abc:foo=bar;https://x')).toEqual({ uri: 'https://x', id: 'abc' });
  });

  it('treats an empty URI as a close', () => {
    expect(parseOsc8Payload('8;;')).toEqual({ uri: '', id: undefined });
  });

  it('returns null for non-OSC-8 payloads (window title, malformed)', () => {
    expect(parseOsc8Payload('0;window title')).toBeNull();
    expect(parseOsc8Payload('8;onlyonefield')).toBeNull();
  });
});

describe('classifyHyperlinkUri', () => {
  it('maps send:/prompt: to game actions', () => {
    expect(classifyHyperlinkUri('send:look')).toEqual({ kind: 'send', command: 'look' });
    expect(classifyHyperlinkUri('prompt:cast fireball')).toEqual({ kind: 'prompt', command: 'cast fireball' });
  });

  it('percent-decodes send/prompt commands (%20 → space)', () => {
    expect(classifyHyperlinkUri('send:cast%20fireball')).toEqual({ kind: 'send', command: 'cast fireball' });
    expect(classifyHyperlinkUri('prompt:say%20hi%20there')).toEqual({ kind: 'prompt', command: 'say hi there' });
    // malformed escape is left intact rather than throwing
    expect(classifyHyperlinkUri('send:50%off')).toEqual({ kind: 'send', command: '50%off' });
  });

  it('maps http/https/ftp to external URLs (scheme case-insensitive)', () => {
    expect(classifyHyperlinkUri('https://mudlet.org')).toEqual({ kind: 'url', url: 'https://mudlet.org' });
    expect(classifyHyperlinkUri('HTTP://x')).toEqual({ kind: 'url', url: 'HTTP://x' });
    expect(classifyHyperlinkUri('ftp://files.example.com')).toEqual({ kind: 'url', url: 'ftp://files.example.com' });
  });

  it('rejects unsafe / unknown schemes', () => {
    expect(classifyHyperlinkUri('javascript:alert(1)')).toBeNull();
    expect(classifyHyperlinkUri('data:text/html,x')).toBeNull();
    expect(classifyHyperlinkUri('file:///etc/passwd')).toBeNull();
    expect(classifyHyperlinkUri('not a uri')).toBeNull();
  });
});

describe('parseXColorSpec', () => {
  it('parses rgb:RR/GG/BB (8-bit channels)', () => {
    expect(parseXColorSpec('rgb:ff/80/00')).toBe('#ff8000');
  });

  it('scales wider rgb: channels to 8 bits', () => {
    expect(parseXColorSpec('rgb:ffff/0000/8080')).toBe('#ff0080');
    expect(parseXColorSpec('rgb:f/0/8')).toBe('#ff0088'); // f→255, 8→136
  });

  it('parses #-hex of 3/6/12 digits', () => {
    expect(parseXColorSpec('#f80')).toBe('#ff8800');
    expect(parseXColorSpec('#ff8000')).toBe('#ff8000');
    expect(parseXColorSpec('#ffff00008080')).toBe('#ff0080');
  });

  it('rejects named colours and other X forms', () => {
    expect(parseXColorSpec('red')).toBeNull();
    expect(parseXColorSpec('rgbi:1.0/0.5/0.0')).toBeNull();
    expect(parseXColorSpec('#abcd')).toBeNull(); // 4 digits: not divisible by 3
  });
});

describe('parseOscColorPalette', () => {
  it('parses an OSC 4 set with one index', () => {
    expect(parseOscColorPalette('4;1;rgb:ff/00/00')).toEqual([{ kind: 'set', index: 1, color: '#ff0000' }]);
  });

  it('parses multiple index/spec pairs in one OSC 4', () => {
    expect(parseOscColorPalette('4;0;#000000;15;#ffffff')).toEqual([
      { kind: 'set', index: 0, color: '#000000' },
      { kind: 'set', index: 15, color: '#ffffff' },
    ]);
  });

  it('skips the query form (4;index;?) without producing an op', () => {
    expect(parseOscColorPalette('4;2;?')).toEqual([]);
  });

  it('parses OSC 104 reset-all and per-index resets', () => {
    expect(parseOscColorPalette('104')).toEqual([{ kind: 'reset-all' }]);
    expect(parseOscColorPalette('104;3;7')).toEqual([
      { kind: 'reset', index: 3 },
      { kind: 'reset', index: 7 },
    ]);
  });

  it('returns null for non-palette OSC payloads', () => {
    expect(parseOscColorPalette('8;;https://x')).toBeNull();
    expect(parseOscColorPalette('0;window title')).toBeNull();
  });
});

describe('OSC 4/104 palette applied through the parser', () => {
  const ESC = '\x1b';
  const ST = `${ESC}\\`;
  afterEach(() => resetAllPaletteColors());

  it('OSC 4 retargets a palette index for following 256-colour SGR', () => {
    // Redefine index 196 to pure blue, then use it via 38;5;196.
    new AnsiAwareBuffer(`${ESC}]4;196;rgb:00/00/ff${ST}`);
    expect(colorCodes.xterm[196]).toBe('#0000ff');
    const buf = new AnsiAwareBuffer(`${ESC}[38;5;196mX${ESC}[0m`);
    expect(buf.getStateAt(0)?.foreground).toMatchObject({ space: 'hex', color: '#0000ff' });
  });

  it('OSC 4 on a low index also updates the 16-colour ANSI table (SGR 31)', () => {
    new AnsiAwareBuffer(`${ESC}]4;1;#00ff00${ST}`);
    expect(colorCodes.ansi.dark[1]).toBe('#00ff00');
    const buf = new AnsiAwareBuffer(`${ESC}[31mred-now-green${ESC}[0m`);
    expect(buf.getStateAt(0)?.foreground).toMatchObject({ space: 'hex', color: '#00ff00' });
  });

  it('OSC 104 resets a redefined index back to default', () => {
    const original = colorCodes.xterm[196];
    new AnsiAwareBuffer(`${ESC}]4;196;rgb:00/00/ff${ST}`);
    new AnsiAwareBuffer(`${ESC}]104;196${ST}`);
    expect(colorCodes.xterm[196]).toBe(original);
  });
});

describe('server-redefine-colors gate', () => {
  const ESC = '\x1b';
  const ST = `${ESC}\\`;
  afterEach(() => {
    setServerRedefineColorsAllowed(true);
    resetAllPaletteColors();
  });

  it('ignores OSC 4 from the server when redefinition is disabled', () => {
    const original = colorCodes.xterm[196];
    setServerRedefineColorsAllowed(false);
    new AnsiAwareBuffer(`${ESC}]4;196;rgb:00/00/ff${ST}`);
    expect(colorCodes.xterm[196]).toBe(original);
  });

  it('re-enabling restores the OSC 4 path', () => {
    setServerRedefineColorsAllowed(false);
    new AnsiAwareBuffer(`${ESC}]4;196;rgb:00/00/ff${ST}`);
    setServerRedefineColorsAllowed(true);
    new AnsiAwareBuffer(`${ESC}]4;196;rgb:00/00/ff${ST}`);
    expect(colorCodes.xterm[196]).toBe('#0000ff');
  });
});
