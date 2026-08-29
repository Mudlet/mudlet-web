import { describe, it, expect, afterEach } from 'vitest';
import { AnsiAwareBuffer } from '../../../src/mud/text/FormatState';
import { HyperlinkPresetRegistry, setOsc8HyperlinksEnabled } from '../../../src/mud/text/hyperlinkConfig';

const ESC = '\x1b';
const ST = `${ESC}\\`;
const open = (uri: string) => `${ESC}]8;;${uri}${ST}`;
const close = `${ESC}]8;;${ST}`;

describe('OSC 8 config carried to the buffer at parse time', () => {
  it('stores the cleaned command + parsed config on the hyperlink', () => {
    const buf = new AnsiAwareBuffer(
      `${open('send:attack?config={"style":{"color":"red","bold":true},"tooltip":"hit"}')}Attack${close}`,
    );
    expect(buf.text).toBe('Attack');
    const hl = buf.getStateAt(0)?.hyperlink;
    expect(hl?.url).toBe('send:attack'); // query stripped
    expect(hl?.config?.style?.foreground).toEqual({ space: 'rgb', r: 255, g: 0, b: 0 });
    expect(hl?.config?.style?.bold).toBe(true);
    expect(hl?.config?.tooltip).toBe('hit');
  });

  it('carries the id= parameter for grouping', () => {
    const buf = new AnsiAwareBuffer(`${ESC}]8;id=grp;send:x${ST}A${close}`);
    expect(buf.getStateAt(0)?.hyperlink?.linkId).toBe('grp');
  });

  it('resolves a preset defined on an earlier buffer (shared registry)', () => {
    const reg = new HyperlinkPresetRegistry();
    new AnsiAwareBuffer(`${open('preset:btn?config={"s":{"c":"white","b":true}}')}${close}`, undefined, reg);
    const buf = new AnsiAwareBuffer(`${open('send:go?preset=btn')}Go${close}`, undefined, reg);
    const hl = buf.getStateAt(0)?.hyperlink;
    expect(hl?.config?.style?.bold).toBe(true);
    expect(hl?.config?.style?.foreground).toEqual({ space: 'rgb', r: 255, g: 255, b: 255 });
  });

  it('does not create a hyperlink for a preset definition itself', () => {
    const reg = new HyperlinkPresetRegistry();
    const buf = new AnsiAwareBuffer(`${open('preset:btn?config={"s":{"c":"white"}}')}${close}after`, undefined, reg);
    expect(buf.text).toBe('after');
    expect(buf.getStateAt(0)?.hyperlink).toBeUndefined();
  });
});

describe('toHtml renders OSC 8 link styling', () => {
  it('applies config.style colour/bold and emits data-link-id', () => {
    const buf = new AnsiAwareBuffer(
      `${ESC}]8;id=g1;send:x?config={"style":{"color":"#ff0000","bold":true}}${ST}X${close}`,
    );
    const html = buf.toHtml();
    expect(html).toContain('color: #ff0000');
    expect(html).toContain('font-weight: bold');
    expect(html).toContain('data-link-id="g1"');
  });

  it('emits underline variant + decoration-colour longhand', () => {
    const buf = new AnsiAwareBuffer(
      `${open('send:x?config={"style":{"underline":"wavy","text-decoration-color":"#00ff00"}}')}X${close}`,
    );
    const html = buf.toHtml();
    expect(html).toContain('text-decoration: underline');
    expect(html).toContain('text-decoration-style: wavy');
    expect(html).toContain('text-decoration-color: #00ff00');
  });

  it('config.style colour overrides the run\'s SGR colour', () => {
    // SGR green inside the link, but config says red → red wins.
    const buf = new AnsiAwareBuffer(`${open('send:x?config={"style":{"color":"red"}}')}${ESC}[32mX${close}`);
    const html = buf.toHtml();
    expect(html).toContain('color: #ff0000');
    expect(html).not.toContain('color: #00bb00');
  });
});

describe('toDom OSC 8 interactions', () => {
  it('applies base style and marks the link clickable', () => {
    const buf = new AnsiAwareBuffer(`${open('send:x?config={"style":{"color":"#0000ff"}}')}X${close}`);
    const span = buf.toDom().querySelector('[data-output-clickable]') as HTMLElement;
    expect(span).toBeTruthy();
    expect(span.style.cssText).toContain('#0000ff');
    expect(span.style.cssText).toContain('cursor: pointer');
  });

  it('swaps to the hover style on mouseenter and reverts on mouseleave', () => {
    const buf = new AnsiAwareBuffer(
      `${open('send:x?config={"style":{"color":"#0000ff","hover":{"color":"#ff0000"}}}')}X${close}`,
    );
    const span = buf.toDom().querySelector('span') as HTMLElement;
    span.dispatchEvent(new Event('mouseenter'));
    expect(span.style.cssText).toContain('#ff0000');
    span.dispatchEvent(new Event('mouseleave'));
    expect(span.style.cssText).toContain('#0000ff');
    expect(span.style.cssText).not.toContain('#ff0000');
  });

  it('groups a multicolour link\'s runs under one data-link-group key', () => {
    // An SGR colour change splits the link into two runs; both belong to one
    // logical link, so keyboard nav treats them as a single stop.
    const buf = new AnsiAwareBuffer(
      `${open('send:flame')}Fla${ESC}[31ming${close}`,
    );
    const runs = Array.from(buf.toDom().querySelectorAll('[data-output-clickable]')) as HTMLElement[];
    expect(runs.length).toBe(2);
    expect(runs[0].dataset.linkGroup).toBeTruthy();
    expect(runs[0].dataset.linkGroup).toBe(runs[1].dataset.linkGroup);
  });

  it('gives links on separate rendered lines distinct nav keys (no cross-line collision)', () => {
    const root = document.createElement('div');
    root.appendChild(new AnsiAwareBuffer(`${open('send:a')}A${close}`).toDom());
    root.appendChild(new AnsiAwareBuffer(`${open('send:b')}B${close}`).toDom());
    const runs = Array.from(root.querySelectorAll('[data-output-clickable]')) as HTMLElement[];
    expect(runs.length).toBe(2);
    expect(runs[0].dataset.linkGroup).not.toBe(runs[1].dataset.linkGroup);
  });

  it('keeps distinct no-url links (MXP/scripted) as separate nav stops', () => {
    // Two separate setHyperlink ranges with different handlers must not collapse
    // into one nav group just because neither carries a url.
    const buf = new AnsiAwareBuffer('AB');
    buf.setHyperlink([0, 1], { onClick: () => {} });
    buf.setHyperlink([1, 2], { onClick: () => {} });
    const runs = Array.from(buf.toDom().querySelectorAll('[data-output-clickable]')) as HTMLElement[];
    expect(runs.length).toBe(2);
    expect(runs[0].dataset.linkGroup).not.toBe(runs[1].dataset.linkGroup);
  });

  it('groups a single no-url link applied over a multicolour range as one stop', () => {
    // One setHyperlink call spreads the same handler across both colour runs.
    const buf = new AnsiAwareBuffer(`X${ESC}[31mY${ESC}[0m`);
    buf.setHyperlink([0, 2], { onClick: () => {} });
    const runs = Array.from(buf.toDom().querySelectorAll('[data-output-clickable]')) as HTMLElement[];
    expect(runs.length).toBe(2);
    expect(runs[0].dataset.linkGroup).toBe(runs[1].dataset.linkGroup);
  });

  it('hover propagates to every run sharing the same id', () => {
    // The `\e[1m` splits the link into two runs that share id=g.
    const buf = new AnsiAwareBuffer(
      `${ESC}]8;id=g;send:x?config={"style":{"color":"#0000ff","hover":{"color":"#ff0000"}}}${ST}A${ESC}[1mB${close}`,
    );
    const spans = Array.from(buf.toDom().querySelectorAll('[data-link-id="g"]')) as HTMLElement[];
    expect(spans.length).toBe(2);
    spans[0].dispatchEvent(new Event('mouseenter'));
    expect(spans[0].style.cssText).toContain('#ff0000');
    expect(spans[1].style.cssText).toContain('#ff0000');
    spans[1].dispatchEvent(new Event('mouseleave'));
    expect(spans[0].style.cssText).toContain('#0000ff');
    expect(spans[1].style.cssText).toContain('#0000ff');
  });

  it('renders a disabled link with a default cursor', () => {
    const buf = new AnsiAwareBuffer(
      `${open('send:x?config={"disabled":true,"style":{"color":"#888888"}}')}X${close}`,
    );
    const span = buf.toDom().querySelector('[data-output-clickable]') as HTMLElement;
    expect(span.style.cssText).toContain('cursor: default');
  });

  it('emits selection data + the selected style variant, applying initial selected', () => {
    const buf = new AnsiAwareBuffer(
      `${open('send:easy?config={"selection":{"group":"diff","value":"easy","exclusive":true,"selected":true},"style":{"selected":{"bg":"green"}}}')}Easy${close}`,
    );
    const span = buf.toDom().querySelector('[data-osc-group]') as HTMLElement;
    expect(span.dataset.oscGroup).toBe('diff');
    expect(span.dataset.oscValue).toBe('easy');
    expect(span.dataset.oscExclusive).toBe('true');
    expect(span.dataset.cssSelected).toContain('#008000'); // green selected bg
    expect(span.dataset.cssBase).toBeTruthy();
    // server pre-selected → the selected style is applied at render
    expect(span.style.cssText).toContain('#008000');
  });

  it('conceals a spoiler until the first click reveals it', () => {
    const buf = new AnsiAwareBuffer(
      `${open('send:x?config={"spoiler":true,"style":{"color":"#ffff00"}}')}42${close}`,
    );
    const span = buf.toDom().querySelector('[data-output-clickable]') as HTMLElement;
    expect(span.dataset.spoiler).toBe('hidden');
    expect(span.style.cssText).toContain('color: transparent');
    expect(span.style.cssText).toContain('background-color: #ffff00'); // block in the text colour
    span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(span.dataset.spoiler).toBe('shown');
    expect(span.style.cssText).not.toContain('transparent');
  });
});

// Mudlet 5.0's mEnableOSC8Hyperlinks (Host preference / profile XML). The flag
// is module-global because the ANSI parser has no access to profile settings —
// same shape as colors.ts's server-redefine gate.
describe('OSC 8 disabled (Mudlet mEnableOSC8Hyperlinks = false)', () => {
  afterEach(() => setOsc8HyperlinksEnabled(true));

  it('renders the linked text plain, with the sequence still consumed', () => {
    setOsc8HyperlinksEnabled(false);
    const buf = new AnsiAwareBuffer(`before${open('send:attack')}Attack${close}after`);
    expect(buf.text).toBe('beforeAttackafter');
    expect(buf.getStateAt(6)?.hyperlink).toBeUndefined();
  });

  it('still honours a close, so a link caught mid-flight cannot run on forever', () => {
    // Open while enabled, disable, then close: the close must clear the link
    // rather than being refused along with the opens (TBuffer::decodeOSC puts
    // its gate below the terminator branch for exactly this).
    const buf = new AnsiAwareBuffer(`${open('send:attack')}Attack`);
    expect(buf.getStateAt(0)?.hyperlink?.url).toBe('send:attack');
    setOsc8HyperlinksEnabled(false);
    const after = new AnsiAwareBuffer(`Attack${close}plain`, buf.getStateAt(0));
    expect(after.getStateAt(0)?.hyperlink?.url).toBe('send:attack');
    expect(after.getStateAt(6)?.hyperlink).toBeUndefined();
  });

  it('links come back once it is turned on again', () => {
    setOsc8HyperlinksEnabled(false);
    expect(new AnsiAwareBuffer(`${open('send:x')}X${close}`).getStateAt(0)?.hyperlink).toBeUndefined();
    setOsc8HyperlinksEnabled(true);
    expect(new AnsiAwareBuffer(`${open('send:x')}X${close}`).getStateAt(0)?.hyperlink?.url).toBe('send:x');
  });
});
