import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyVisibility,
  HyperlinkVisibilityController,
  concealDelayedReveals,
  pumpDelayedReveals,
  resetDelayedReveals,
  startsConcealed,
} from '../../../src/mud/text/hyperlinkVisibility';
import { AnsiAwareBuffer } from '../../../src/mud/text/FormatState';
import { Console } from '../../../src/mud/text/Console';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  resetDelayedReveals();
});

const span = (): HTMLElement => document.createElement('span');
const click = (el: HTMLElement): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };

describe('applyVisibility — timer/click actions', () => {
  it('reveal: starts hidden, reveals after the delay (from render)', () => {
    const el = span();
    applyVisibility(el, { action: 'reveal', delayMs: 5000 });
    expect(el.style.visibility).toBe('hidden');
    vi.advanceTimersByTime(4999);
    expect(el.style.visibility).toBe('hidden');
    vi.advanceTimersByTime(1);
    expect(el.style.visibility).toBe('visible');
  });

  it('reveal with no delay leaves the link visible', () => {
    const el = span();
    applyVisibility(el, { action: 'reveal', delayMs: 0 });
    expect(el.style.visibility).toBe('');
  });

  it('conceal: hides on click, after the delay', () => {
    const el = span();
    applyVisibility(el, { action: 'conceal', delayMs: 2000 });
    expect(el.style.visibility).toBe(''); // visible until clicked
    click(el);
    expect(el.style.visibility).toBe(''); // delay not elapsed
    vi.advanceTimersByTime(2000);
    expect(el.style.visibility).toBe('hidden');
  });

  it('conceal with zero delay hides immediately on click', () => {
    const el = span();
    applyVisibility(el, { action: 'conceal' });
    click(el);
    expect(el.style.visibility).toBe('hidden');
  });

  it('reveal-then-conceal: reveals after delay, then conceals on click', () => {
    const el = span();
    applyVisibility(el, { action: 'reveal-then-conceal', delayMs: 1000 });
    expect(el.style.visibility).toBe('hidden');
    vi.advanceTimersByTime(1000);
    expect(el.style.visibility).toBe('visible');
    click(el);
    expect(el.style.visibility).toBe('hidden');
  });

  it('deletesEntireLine: conceal removes the whole output line', () => {
    const line = document.createElement('div');
    line.className = 'output-msg';
    const el = span();
    line.appendChild(el);
    document.body.appendChild(line);
    applyVisibility(el, { action: 'conceal', deletesEntireLine: true });
    click(el);
    expect(document.body.contains(line)).toBe(false);
  });
});

describe('HyperlinkVisibilityController — expire on session events', () => {
  it('arms only after click, then conceals on the second input (first is the command itself)', () => {
    const root = document.createElement('div');
    const el = span();
    root.appendChild(el);
    applyVisibility(el, { action: 'conceal', expireOnInput: true });

    // Not armed before the click.
    const ctrl = new HyperlinkVisibilityController(() => root);
    ctrl.onInput();
    expect(el.dataset.oscVisExpire).toBeUndefined();
    expect(el.style.visibility).toBe('');

    click(el); // arms (and would have sent the link's command)
    expect(el.dataset.oscVisExpire).toBe('input');

    ctrl.onInput(); // first input = the command's own echo → skipped
    expect(el.style.visibility).toBe('');
    ctrl.onInput(); // next real input → conceal
    expect(el.style.visibility).toBe('hidden');
  });

  it('expire on prompt fires once (after skipping the response prompt)', () => {
    const root = document.createElement('div');
    const el = span();
    root.appendChild(el);
    applyVisibility(el, { action: 'conceal', expireOnPrompt: true });
    click(el);
    const ctrl = new HyperlinkVisibilityController(() => root);
    ctrl.onPrompt(); // skipped
    expect(el.style.visibility).toBe('');
    ctrl.onPrompt(); // conceal
    expect(el.style.visibility).toBe('hidden');
    // fires once — the data attr is cleared
    expect(el.dataset.oscVisExpire).toBeUndefined();
  });

  it('expire with deletesEntireLine removes the line on the trigger', () => {
    const line = document.createElement('div');
    line.className = 'output-msg';
    const el = span();
    line.appendChild(el);
    document.body.appendChild(line);
    applyVisibility(el, { action: 'conceal', expireOnOutput: true, deletesEntireLine: true });
    click(el);
    const ctrl = new HyperlinkVisibilityController(() => document);
    ctrl.onOutput(); // skipped
    expect(document.body.contains(line)).toBe(true);
    ctrl.onOutput(); // removes the line
    expect(document.body.contains(line)).toBe(false);
  });

  it('ignores triggers that do not match the armed set', () => {
    const root = document.createElement('div');
    const el = span();
    root.appendChild(el);
    applyVisibility(el, { action: 'conceal', expireOnInput: true });
    click(el);
    const ctrl = new HyperlinkVisibilityController(() => root);
    ctrl.onPrompt(); ctrl.onPrompt(); ctrl.onOutput(); // wrong triggers
    expect(el.style.visibility).toBe('');
  });
});

describe('toDom wires visibility', () => {
  const ESC = '\x1b';
  const ST = `${ESC}\\`;
  it('a reveal link renders hidden and appears after its delay', () => {
    const buf = new AnsiAwareBuffer(
      `${ESC}]8;;send:x?config={"visibility":{"action":"reveal","delay":3000}}${ST}Soon${ESC}]8;;${ST}`,
    );
    const el = buf.toDom().querySelector('[data-output-clickable]') as HTMLElement;
    expect(el.style.visibility).toBe('hidden');
    vi.advanceTimersByTime(3000);
    expect(el.style.visibility).toBe('visible');
  });
});

// The buffer half. Mudlet writes a delayed-reveal link into its buffer as
// spaces and puts the text back when the delay is up, so a script reading the
// line back sees what the player can see. Hiding the ELEMENT is not enough for
// that — getLines() reads the buffer, not the DOM.
describe('concealDelayedReveals', () => {
  const ESC = '\x1b';
  const ST = `${ESC}\\`;
  const link = (config: string, text: string): string =>
    `${ESC}]8;;send:x?config=${config}${ST}${text}${ESC}]8;;${ST}`;

  const reveal250 = '{"visibility":{"action":"reveal","delay":250}}';

  it('replaces the link text space for space, and puts it back on time', () => {
    const buf = new AnsiAwareBuffer(`before(${link(reveal250, 'HIDDENWORD')})after`);
    const before = buf.text;
    concealDelayedReveals(buf);
    expect(buf.text).toBe('before(          )after');
    // Character count preserved, so every column a script holds stays valid.
    expect(buf.text.length).toBe(before.length);

    expect(pumpDelayedReveals(Date.now() + 249)).toBe(false);
    expect(pumpDelayedReveals(Date.now() + 250)).toBe(true);
    expect(buf.text).toBe(before);
  });

  it('leaves a link with no visibility settings alone', () => {
    const buf = new AnsiAwareBuffer(`see ${link('{"style":{"color":"red"}}', 'this')}`);
    concealDelayedReveals(buf);
    expect(buf.text).toBe('see this');
  });

  it('leaves a zero-delay reveal visible — nothing would put it back', () => {
    expect(startsConcealed({ action: 'reveal', delayMs: 0 })).toBe(false);
    const buf = new AnsiAwareBuffer(link('{"visibility":{"action":"reveal"}}', 'now'));
    concealDelayedReveals(buf);
    expect(buf.text).toBe('now');
  });

  it('leaves a conceal-on-click link visible until it is clicked', () => {
    expect(startsConcealed({ action: 'conceal', delayMs: 2000 })).toBe(false);
    const buf = new AnsiAwareBuffer(link('{"visibility":{"action":"conceal","delay":2000}}', 'secret'));
    concealDelayedReveals(buf);
    expect(buf.text).toBe('secret');
  });

  it('does not hide the element again when the revealed line re-renders', () => {
    const buf = new AnsiAwareBuffer(link(reveal250, 'HIDDENWORD'));
    concealDelayedReveals(buf);
    pumpDelayedReveals(Date.now() + 250);
    const el = buf.toDom().querySelector('[data-output-clickable]') as HTMLElement;
    expect(el.style.visibility).toBe('');
  });

  it('a console conceals every line it stores', () => {
    const con = new Console();
    con.echo(`OSCREVEAL1(${link(reveal250, 'HIDDENWORD')})OSCREVEAL1\n`);
    expect(con.getLines(0, 1)[0]).toBe('OSCREVEAL1(          )OSCREVEAL1');
    pumpDelayedReveals(Date.now() + 250);
    expect(con.getLines(0, 1)[0]).toBe('OSCREVEAL1(HIDDENWORD)OSCREVEAL1');
  });
});
