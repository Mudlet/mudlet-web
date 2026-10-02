import { describe, it, expect } from 'vitest';
import { newEnvironIsReply, mnesIsReplies, encodeMnesIs, buildNewEnvironVars, type MnesVar } from '../../../src/mud/protocol/mnes';
import {
  GMCP_IAC,
  GMCP_SB,
  GMCP_SE,
  OPT_NEW_ENVIRON,
  NEW_ENVIRON_IS,
  NEW_ENVIRON_SEND,
  NEW_ENVIRON_VAR,
  NEW_ENVIRON_VALUE,
  NEW_ENVIRON_ESC,
  NEW_ENVIRON_USERVAR,
  computeMtts,
} from '../../../src/mud/protocol/constants';

// Build a SEND request body as the telnet option parser hands it to the
// handler: the option code (NEW-ENVIRON, 39) followed by the command byte and
// any VAR/USERVAR entries. IAC SB/SE are stripped upstream, so we omit them.
const sendBody = (...parts: string[]) => OPT_NEW_ENVIRON + NEW_ENVIRON_SEND + parts.join('');
const IS = (body: string) => GMCP_IAC + GMCP_SB + OPT_NEW_ENVIRON + NEW_ENVIRON_IS + body + GMCP_IAC + GMCP_SE;
const VAR = NEW_ENVIRON_VAR, USERVAR = NEW_ENVIRON_USERVAR, VALUE = NEW_ENVIRON_VALUE;

// The expected bytes below are what Mudlet's cTelnet::sendIsNewEnvironValues /
// sendIsMNESValues produce for the same request (issue #286).
describe('newEnvironIsReply (plain NEW-ENVIRON)', () => {
  // Deliberately out of key order: Mudlet lists from a QMap, so sorted.
  const available: MnesVar[] = [
    { name: 'MTTS', value: '2349' },
    { name: 'CLIENT_NAME', value: 'MUDLET-WEB' },
    { name: 'ANSI', value: '1' },
  ];
  const all = USERVAR + 'ANSI' + VALUE + '1' + USERVAR + 'CLIENT_NAME' + VALUE + 'MUDLET-WEB' + USERVAR + 'MTTS' + VALUE + '2349';

  it('answers a bare SEND with every variable as USERVAR, in key order', () => {
    expect(newEnvironIsReply(sendBody(), available)).toBe(IS(all));
  });

  it('lists an unknown variable as undefined instead of dropping it', () => {
    expect(newEnvironIsReply(sendBody(VAR + 'IPADDRESS' + USERVAR + 'CLIENT_NAME'), available)).toBe(
      IS(VAR + 'IPADDRESS' + USERVAR + 'CLIENT_NAME' + VALUE + 'MUDLET-WEB'),
    );
  });

  it('answers an empty VAR list with an empty IS (we define no VARs)', () => {
    expect(newEnvironIsReply(sendBody(VAR), available)).toBe(IS(''));
  });

  it('answers an empty USERVAR list with every USERVAR', () => {
    expect(newEnvironIsReply(sendBody(USERVAR), available)).toBe(IS(all));
  });

  it('answers VAR <one of ours> as undefined — ours are USERVARs', () => {
    expect(newEnvironIsReply(sendBody(VAR + 'MTTS'), available)).toBe(IS(VAR + 'MTTS'));
  });

  it('answers names in request order', () => {
    expect(newEnvironIsReply(sendBody(USERVAR + 'MTTS' + USERVAR + 'ANSI'), available)).toBe(
      IS(USERVAR + 'MTTS' + VALUE + '2349' + USERVAR + 'ANSI' + VALUE + '1'),
    );
  });

  it('takes an ESC-escaped byte inside a requested name literally', () => {
    // The unknown name comes back undefined, its VAR byte escaped again.
    expect(newEnvironIsReply(sendBody(USERVAR + 'A' + NEW_ENVIRON_ESC + VAR + 'B'), available)).toBe(
      IS(USERVAR + 'A' + NEW_ENVIRON_ESC + VAR + 'B'),
    );
  });

  it('answers nothing to a non-SEND body', () => {
    expect(newEnvironIsReply(OPT_NEW_ENVIRON + NEW_ENVIRON_IS, available)).toBeNull();
    expect(newEnvironIsReply(String.fromCharCode(69) + NEW_ENVIRON_SEND, available)).toBeNull();
  });
});

describe('mnesIsReplies (MNES)', () => {
  const available: MnesVar[] = [
    { name: 'MTTS', value: '2861' },
    { name: 'CHARSET', value: 'UTF-8' },
  ];
  const all = encodeMnesIs([{ name: 'CHARSET', value: 'UTF-8' }, { name: 'MTTS', value: '2861' }]);

  it('answers a bare SEND, or a lone VAR, with every variable in one reply', () => {
    expect(mnesIsReplies(sendBody(), available)).toEqual([all]);
    expect(mnesIsReplies(sendBody(VAR), available)).toEqual([all]);
  });

  it('answers each named variable in a reply of its own', () => {
    expect(mnesIsReplies(sendBody(VAR + 'MTTS' + VAR + 'CHARSET'), available)).toEqual([
      IS(VAR + 'MTTS' + VALUE + '2861'),
      IS(VAR + 'CHARSET' + VALUE + 'UTF-8'),
    ]);
  });

  it('answers IPADDRESS as undefined and ignores names MNES does not define', () => {
    expect(mnesIsReplies(sendBody(VAR + 'NOPE' + VAR + 'IPADDRESS'), available)).toEqual([IS(VAR + 'IPADDRESS')]);
    expect(mnesIsReplies(sendBody(VAR + 'NOPE'), available)).toEqual([]);
  });

  it('follows the named replies with the full set when the list ends in an empty VAR', () => {
    expect(mnesIsReplies(sendBody(VAR + 'MTTS' + VAR), available)).toEqual([IS(VAR + 'MTTS' + VALUE + '2861'), all]);
  });

  it('answers nothing to a non-SEND body', () => {
    expect(mnesIsReplies(OPT_NEW_ENVIRON + NEW_ENVIRON_IS, available)).toBeNull();
  });
});

describe('encodeMnesIs', () => {
  it('frames an IS reply with VAR/VALUE markers and IAC SB/SE', () => {
    const out = encodeMnesIs([{ name: 'CHARSET', value: 'UTF-8' }]);
    expect(out).toBe(IS(VAR + 'CHARSET' + VALUE + 'UTF-8'));
  });

  it('emits multiple variables in order', () => {
    const out = encodeMnesIs([
      { name: 'CLIENT_NAME', value: 'MUDLET' },
      { name: 'MTTS', value: '269' },
    ]);
    expect(out).toBe(IS(VAR + 'CLIENT_NAME' + VALUE + 'MUDLET' + VAR + 'MTTS' + VALUE + '269'));
  });

  it('ESC-escapes marker bytes and doubles IAC within a value', () => {
    // cTelnet::prepareNewEnvironData: IAC is doubled, markers get ESC.
    const out = encodeMnesIs([{ name: 'X', value: 'a' + GMCP_IAC + 'b' + VALUE + 'c' }]);
    expect(out).toContain(VALUE + 'a' + GMCP_IAC + GMCP_IAC + 'b' + NEW_ENVIRON_ESC + VALUE + 'c');
  });

  it('frames names as USERVAR when given the USERVAR marker (plain NEW-ENVIRON)', () => {
    const out = encodeMnesIs([{ name: 'ANSI', value: '1' }], USERVAR);
    expect(out).toBe(IS(USERVAR + 'ANSI' + VALUE + '1'));
  });

  it('emits the name with no VALUE marker for an undefined variable', () => {
    const frame = encodeMnesIs([{ name: 'IPADDRESS', value: null }]);
    expect(frame).toBe(IS(VAR + 'IPADDRESS'));
  });

  it('still emits a VALUE marker for a defined-but-empty variable', () => {
    const frame = encodeMnesIs([{ name: 'CHARSET', value: '' }]);
    expect(frame).toBe(IS(VAR + 'CHARSET' + VALUE));
  });
});

describe('buildNewEnvironVars', () => {
  const state = { charset: 'UTF-8', utf8: true, wordWrap: 100 };

  it('reports exactly the five MNES core variables when not extended', () => {
    const vars = buildNewEnvironVars(state, false);
    expect(vars.map(v => v.name)).toEqual([
      'CHARSET', 'CLIENT_NAME', 'CLIENT_VERSION', 'MTTS', 'TERMINAL_TYPE',
    ]);
    expect(vars).toContainEqual({ name: 'CLIENT_NAME', value: 'MUDLET-WEB' });
    // MTTS is computed from live state: UTF-8 here → 2349 (matches Mudlet).
    expect(vars).toContainEqual({ name: 'MTTS', value: String(computeMtts({ utf8: true })) });
    expect(vars).toContainEqual({ name: 'MTTS', value: '2349' });
    expect(vars).toContainEqual({ name: 'CHARSET', value: 'UTF-8' });
  });

  it('adds the MNES bit to MTTS when MNES is on (2349 + 512)', () => {
    const vars = buildNewEnvironVars({ ...state, mnes: true }, false);
    expect(vars).toContainEqual({ name: 'MTTS', value: '2861' });
  });

  it('appends the extended capability set when extended', () => {
    const names = buildNewEnvironVars(state, true).map(v => v.name);
    expect(names.slice(0, 5)).toEqual([
      'CHARSET', 'CLIENT_NAME', 'CLIENT_VERSION', 'MTTS', 'TERMINAL_TYPE',
    ]);
    expect(names).toEqual(expect.arrayContaining([
      'ANSI', '256_COLORS', 'TRUECOLOR', 'UTF-8', 'TLS', 'WORD_WRAP',
      'SCREEN_READER', 'OSC_COLOR_PALETTE', 'OSC_HYPERLINKS', 'VT100',
    ]));
  });

  it('derives UTF-8 and WORD_WRAP from live state, and reports TLS as a capability', () => {
    const vars = buildNewEnvironVars({ charset: 'ASCII', utf8: false, wordWrap: 60 }, true);
    const byName = new Map(vars.map(v => [v.name, v.value]));
    expect(byName.get('CHARSET')).toBe('ASCII');
    expect(byName.get('UTF-8')).toBe('0');
    // Mudlet's getNewEnvironTLS: "1" whenever built with SSL, whatever the link.
    expect(byName.get('TLS')).toBe('1');
    // Mudlet's getNewEnvironWordWrap: Host::mWrapAt, not the window width.
    expect(byName.get('WORD_WRAP')).toBe('60');
    expect(byName.get('ANSI')).toBe('1');
    expect(byName.get('TRUECOLOR')).toBe('1');
    expect(byName.get('OSC_COLOR_PALETTE')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS')).toBe('1');
    // Only the UTF-8 bit drops: ANSI(1) + 256(8) + OSC_COLOR_PALETTE(32) +
    // TRUECOLOR(256) + SSL(2048) = 2345.
    expect(byName.get('MTTS')).toBe('2345');
    expect(byName.get('OSC_HYPERLINKS_VISIBILITY')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_SPOILER')).toBe('1');
  });

  // Mudlet 5.0's mEnableOSC8Hyperlinks drives every getNewEnvironOSCHyperlinks*
  // reply, so the whole block collapses to "0" — a server that would light up
  // its links has to be told we will not render them.
  it('reports every OSC_HYPERLINKS_* capability as 0 when the profile disabled them', () => {
    const vars = buildNewEnvironVars({ ...state, osc8Hyperlinks: false }, true);
    const osc8 = vars.filter(v => v.name.startsWith('OSC_HYPERLINKS'));
    expect(osc8.length).toBeGreaterThan(1);
    expect(osc8.every(v => v.value === '0')).toBe(true);
    const byName = new Map(vars.map(v => [v.name, v.value]));
    expect(byName.get('OSC_COLOR_PALETTE')).toBe('1');
    expect(byName.get('TRUECOLOR')).toBe('1');
  });

  it('reports SCREEN_READER and sets the MTTS bit when screenReader is advertised', () => {
    const vars = buildNewEnvironVars({ ...state, screenReader: true }, true);
    const byName = new Map(vars.map(v => [v.name, v.value]));
    expect(byName.get('SCREEN_READER')).toBe('1');
    // ANSI(1) + 256(8) + OSC_COLOR_PALETTE(32) + TRUECOLOR(256) + UTF8(4) + SSL(2048) + SCREEN_READER(64) = 2413.
    expect(byName.get('MTTS')).toBe('2413');
  });

  it('defaults SCREEN_READER to "0" when screenReader is omitted', () => {
    const vars = buildNewEnvironVars(state, true);
    const byName = new Map(vars.map(v => [v.name, v.value]));
    expect(byName.get('SCREEN_READER')).toBe('0');
  });
});
