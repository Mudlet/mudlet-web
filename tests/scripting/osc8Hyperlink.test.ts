// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { MudSession } from '../../src/mud/MudSession';
import { AliasEngine } from '../../src/mud/aliases/AliasEngine';
import { TriggerEngine } from '../../src/mud/triggers/TriggerEngine';
import { TimerEngine } from '../../src/mud/timers/TimerEngine';
import { KeyEngine } from '../../src/mud/keybindings/KeyEngine';
import { ScriptingAPI } from '../../src/scripting/ScriptingAPI';

// Build a bare ScriptingAPI (no Lua runtime / socket) and capture sends.
function makeApi(): { api: ScriptingAPI; sent: string[] } {
  const w = globalThis as { window?: unknown };
  if (typeof w.window === 'undefined') {
    w.window = { innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {} };
  }
  const api = new ScriptingAPI(
    new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(),
    'test-connection',
  );
  const sent: string[] = [];
  (api as unknown as { send: (c: string) => void }).send = (c: string) => { sent.push(c); };
  return { api, sent };
}

describe('createOsc8Hyperlink — OSC 8 extension query never leaks into commands', () => {
  let api: ScriptingAPI;
  let sent: string[];
  beforeAll(() => { ({ api, sent } = makeApi()); });

  it('strips ?config={…} from a send: command (regression: no JSON in the command)', () => {
    const hl = api.createOsc8Hyperlink('send:attack?config={"style":{"color":"red"},"tooltip":"hit"}');
    expect(hl).toBeTruthy();
    expect(hl?.title).toBe('attack'); // clean command, not "attack?config=…"
    sent.length = 0;
    hl?.onClick?.(new Event('click') as MouseEvent);
    expect(sent).toEqual(['attack']);
  });

  it('strips the whole query from a prompt: command', () => {
    const hl = api.createOsc8Hyperlink('prompt:cast fireball?preset=warn&config={"s":{"c":"red"}}');
    expect(hl?.title).toBe('cast fireball');
  });

  it('leaves a bare send: link unchanged', () => {
    const hl = api.createOsc8Hyperlink('send:look');
    expect(hl?.title).toBe('look');
  });

  it('keeps user query params on web links but drops config/preset', () => {
    const hl = api.createOsc8Hyperlink('https://mudlet.org/?id=42&lang=en&config={"style":{"bold":true}}');
    expect(hl?.title).toBe('https://mudlet.org/?id=42&lang=en');
  });

  it('does not auto-underline OSC 8 links (Mudlet parity)', () => {
    // Mudlet's HyperlinkStyling::isUnderlined defaults to false: OSC 8 links are
    // not underlined unless their config asks. Only MXP links auto-underline.
    expect(api.createOsc8Hyperlink('send:look')?.autoUnderline).toBeUndefined();
    expect(api.createMxpHyperlink('command', 'look').autoUnderline).toBe(true);
  });

  it('still drops disallowed schemes', () => {
    expect(api.createOsc8Hyperlink('javascript:alert(1)?config={}')).toBeUndefined();
  });

  it('uses config.tooltip as the title and carries config/id forward', () => {
    const hl = api.createOsc8Hyperlink('send:look', {
      url: 'send:look',
      config: { tooltip: 'Look around', style: { bold: true } },
      linkId: 'g7',
    });
    expect(hl?.title).toBe('Look around'); // tooltip overrides default "look"
    expect(hl?.config?.style?.bold).toBe(true);
    expect(hl?.linkId).toBe('g7');
    expect(hl?.onClick).toBeTypeOf('function');
  });

  it('makes a disabled link non-clickable but keeps its tooltip', () => {
    const hl = api.createOsc8Hyperlink('send:locked', {
      url: 'send:locked',
      config: { disabled: true, tooltip: 'Requires level 10' },
    });
    expect(hl?.onClick).toBeUndefined();
    expect(hl?.title).toBe('Requires level 10');
  });

  it('attaches a right-click handler only when config.menu is present', () => {
    const plain = api.createOsc8Hyperlink('send:x', { url: 'send:x', config: {} });
    expect(plain?.onContextMenu).toBeUndefined();
    const withMenu = api.createOsc8Hyperlink('send:attack', {
      url: 'send:attack',
      config: { menu: [{ label: 'Strike', action: 'send:strike' }] },
    });
    expect(withMenu?.onContextMenu).toBeTypeOf('function');
    expect(withMenu?.onClick).toBeTypeOf('function'); // primary still fires
  });

  it('a disabled link still opens its menu', () => {
    const hl = api.createOsc8Hyperlink('send:attack', {
      url: 'send:attack',
      config: { disabled: true, menu: [{ label: 'Strike', action: 'send:strike' }] },
    });
    expect(hl?.onClick).toBeUndefined();
    expect(hl?.onContextMenu).toBeTypeOf('function');
  });

  it('a selection send appends &selected and toggles (checkbox)', () => {
    const hl = api.createOsc8Hyperlink('send:equip sword', {
      url: 'send:equip sword',
      config: { selection: { group: 'buffs', value: 'sword', exclusive: false } },
    });
    sent.length = 0;
    hl?.onClick?.(undefined as unknown as MouseEvent); // no event → restyle no-ops in node
    expect(sent).toEqual(['equip sword&selected=true']);
    hl?.onClick?.(undefined as unknown as MouseEvent);
    expect(sent).toEqual(['equip sword&selected=true', 'equip sword&selected=false']);
  });
});

// TBuffer::decodeOSC builds `send([[cmd]], false)` for a `send:` link and for
// a `send:` menu item, so Mudlet sends either without echoing the command.
// (MXP <send> and label links use the echoing form and are not affected.)
describe('createOsc8Hyperlink — send: links do not echo', () => {
  it('sends a clicked link and a menu item with echo off', () => {
    const { api } = makeApi();
    const calls: [string, boolean | undefined][] = [];
    (api as unknown as { send: (c: string, e?: boolean) => void }).send = (c, e) => { calls.push([c, e]); };
    api.createOsc8Hyperlink('send:2?config={"style":{"color":"#66ccff"}}')?.onClick?.(new Event('click') as MouseEvent);
    (api as unknown as { runHyperlinkUri: (u: string) => void }).runHyperlinkUri('send:strike');
    expect(calls).toEqual([['2', false], ['strike', false]]);
  });
});
