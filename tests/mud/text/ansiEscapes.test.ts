// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import {
  scanEscape,
  parseOsc8Payload,
  classifyHyperlinkUri,
  parseOscPalette,
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
    const buf = new AnsiAwareBuffer(`${ESC}[1;3;4mb${ESC}[31mx${ESC}[0m`);
    const runs = buf.toStyledRuns();
    const b = runs.filter(r => r.text === 'b');
    const x = runs.filter(r => r.text === 'x');
    expect(x).toHaveLength(1);
    expect(x[0].color).toMatch(/^#/);
    expect(x[0].italic).toBe(true);
    expect(x[0].underline).toBe(true);
    // As in Mudlet's TBuffer, SGR 1 makes a character bold only on the default
    // foreground; on a colour it picks the bright twin instead.
    expect(b[0].bold).toBe(true);
    expect(x[0].bold).toBe(false);
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

describe('parseOscPalette', () => {
  it('parses ESC]P<i><rrggbb> — one hex digit of index, six of colour', () => {
    expect(parseOscPalette('P1ff8800')).toEqual({ kind: 'set', index: 1, color: '#ff8800' });
    expect(parseOscPalette('PfABCDEF')).toEqual({ kind: 'set', index: 15, color: '#abcdef' });
  });

  it('drops a P of the wrong length or with a non-hex digit', () => {
    expect(parseOscPalette('P1ff880')).toBeNull();
    expect(parseOscPalette('P1ff88000')).toBeNull();
    expect(parseOscPalette('Pgff8800')).toBeNull();
    expect(parseOscPalette('P1ff88zz')).toBeNull();
  });

  it('parses ESC]R as the reset', () => {
    expect(parseOscPalette('R')).toEqual({ kind: 'reset' });
  });

  it('is not xterm OSC 4/104, which desktop ignores', () => {
    expect(parseOscPalette('4;1;rgb:ff/00/00')).toBeNull();
    expect(parseOscPalette('104')).toBeNull();
    expect(parseOscPalette('8;;https://x')).toBeNull();
    expect(parseOscPalette('0;window title')).toBeNull();
  });
});

// mudlet-web#363 item 2: TBuffer::decodeOSC honours the Linux-console palette
// commands and ignores xterm's.
describe('ESC]P / ESC]R palette applied through the parsers (#363)', () => {
  afterEach(() => resetAllPaletteColors());
  const fgOf = (text: string) => new AnsiAwareBuffer(text).getStateAt(0)?.foreground;

  it('ESC]P1 redefines red for SGR 31 and 38;5;1', () => {
    new AnsiAwareBuffer(`${ESC}]P1ff8800${ST}`);
    expect(colorCodes.ansi.dark[1]).toBe('#ff8800');
    expect(fgOf(`${ESC}[31mX`)).toMatchObject({ color: '#ff8800' });
    expect(colorCodes.xterm[1]).toBe('#ff8800');
  });

  it('ESC]P9 redefines light red, BEL-terminated too', () => {
    new AnsiAwareBuffer(`${ESC}]P9123456${BEL}`);
    expect(fgOf(`${ESC}[91mX`)).toMatchObject({ color: '#123456' });
    expect(fgOf(`${ESC}[1;31mX`)).toMatchObject({ color: '#123456' });
  });

  it('ESC]R puts the sixteen colours back to the built-in ones', () => {
    new AnsiAwareBuffer(`${ESC}]P3123456${ST}`);
    new AnsiAwareBuffer(`${ESC}]R${ST}`);
    expect(fgOf(`${ESC}[33mX`)).toMatchObject({ color: '#808000' });
  });

  it('ignores OSC 4 and OSC 104', () => {
    new AnsiAwareBuffer(`${ESC}]4;3;rgb:12/34/56${ST}`);
    expect(colorCodes.ansi.dark[3]).toBe('#808000');
    expect(fgOf(`${ESC}[33mX`)).toMatchObject({ color: '#808000' });
    new AnsiAwareBuffer(`${ESC}]4;196;rgb:00/00/ff${ST}`);
    expect(colorCodes.xterm[196]).not.toBe('#0000ff');
  });

  it('the MXP parser obeys the same commands', () => {
    const mxp = new MxpParser({ send: () => {} });
    mxp.parseLine(`${ESC}]P1ff8800${ST}${ESC}[31mX`);
    expect(colorCodes.ansi.dark[1]).toBe('#ff8800');
    mxp.parseLine(`${ESC}]4;3;rgb:12/34/56${ST}`);
    expect(colorCodes.ansi.dark[3]).toBe('#808000');
    mxp.parseLine(`${ESC}]R${ST}`);
    expect(colorCodes.ansi.dark[1]).toBe('#800000');
  });
});

describe('server-redefine-colors gate', () => {
  afterEach(() => {
    setServerRedefineColorsAllowed(true);
    resetAllPaletteColors();
  });

  it('ignores ESC]P and ESC]R from the server when redefinition is disabled', () => {
    setServerRedefineColorsAllowed(false);
    new AnsiAwareBuffer(`${ESC}]P1ff8800${ST}`);
    expect(colorCodes.ansi.dark[1]).toBe('#800000');
    setServerRedefineColorsAllowed(true);
    new AnsiAwareBuffer(`${ESC}]P1ff8800${ST}`);
    setServerRedefineColorsAllowed(false);
    new AnsiAwareBuffer(`${ESC}]R${ST}`);
    expect(colorCodes.ansi.dark[1]).toBe('#ff8800');
  });

  it('re-enabling restores the path', () => {
    setServerRedefineColorsAllowed(false);
    new AnsiAwareBuffer(`${ESC}]P1ff8800${ST}`);
    setServerRedefineColorsAllowed(true);
    new AnsiAwareBuffer(`${ESC}]P1ff8800${ST}`);
    expect(colorCodes.ansi.dark[1]).toBe('#ff8800');
  });
});

describe('256-colour SGR past index 255 (mudlet-web#174)', () => {
  const ESC = '\x1b';
  const fgAt = (seq: string) => new AnsiAwareBuffer(`${ESC}[${seq}mX`).getStateAt(0)?.foreground;
  const bgAt = (seq: string) => new AnsiAwareBuffer(`${ESC}[${seq}mX`).getStateAt(0)?.background;

  it('continues the greyscale ramp to 256, as Mudlet does', () => {
    expect(fgAt('38;5;256')).toEqual({ space: 'rgb', r: 248, g: 248, b: 248 });
    expect(bgAt('48;5;256')).toEqual({ space: 'rgb', r: 248, g: 248, b: 248 });
    expect(fgAt('38:5:256')).toEqual({ space: 'rgb', r: 248, g: 248, b: 248 });
  });

  it('turns a foreground with no colour black and a background default', () => {
    expect(fgAt('38;5;300')).toEqual({ space: 'rgb', r: 0, g: 0, b: 0 });
    expect(fgAt('38:5:300')).toEqual({ space: 'rgb', r: 0, g: 0, b: 0 });
    expect(bgAt('41;48;5;999')).toBeUndefined();
    expect(bgAt('41;48:5:999')).toBeUndefined();
  });

  it('never yields a hex colour without a value', () => {
    for (const seq of ['38;5;300', '48;5;300', '38;5;257', '38:5:1000']) {
      const buf = new AnsiAwareBuffer(`${ESC}[${seq}mX`);
      for (const c of [buf.getStateAt(0)?.foreground, buf.getStateAt(0)?.background]) {
        if (c?.space === 'hex') expect(typeof c.color).toBe('string');
      }
    }
  });
});
