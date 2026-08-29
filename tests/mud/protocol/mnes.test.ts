import { describe, it, expect } from 'vitest';
import { parseMnesRequest, encodeMnesIs, selectMnesVars, MNES_UNMAINTAINED, buildNewEnvironVars, type MnesVar } from '../../../src/mud/protocol/mnes';
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

describe('parseMnesRequest', () => {
  it('treats a bare SEND as "send everything"', () => {
    expect(parseMnesRequest(sendBody())).toEqual({ isSend: true, requested: [] });
  });

  it('parses specific requested variable names in order', () => {
    const body = sendBody(
      NEW_ENVIRON_VAR + 'CLIENT_NAME' +
      NEW_ENVIRON_VAR + 'MTTS',
    );
    expect(parseMnesRequest(body)).toEqual({
      isSend: true,
      requested: ['CLIENT_NAME', 'MTTS'],
    });
  });

  it('parses USERVAR entries the same as VAR entries', () => {
    const body = sendBody(NEW_ENVIRON_USERVAR + 'FOO' + NEW_ENVIRON_VAR + 'CHARSET');
    expect(parseMnesRequest(body)).toEqual({
      isSend: true,
      requested: ['FOO', 'CHARSET'],
    });
  });

  it('ignores empty names (a bare VAR marker = request all)', () => {
    expect(parseMnesRequest(sendBody(NEW_ENVIRON_VAR))).toEqual({ isSend: true, requested: [] });
  });

  it('unescapes ESC-prefixed bytes inside a requested name', () => {
    // A name containing a literal VAR byte, escaped per RFC 1572.
    const body = sendBody(NEW_ENVIRON_VAR + 'A' + NEW_ENVIRON_ESC + NEW_ENVIRON_VAR + 'B');
    expect(parseMnesRequest(body)).toEqual({
      isSend: true,
      requested: ['A' + NEW_ENVIRON_VAR + 'B'],
    });
  });

  it('rejects a non-SEND command (e.g. an IS body)', () => {
    expect(parseMnesRequest(OPT_NEW_ENVIRON + NEW_ENVIRON_IS)).toEqual({ isSend: false, requested: [] });
  });

  it('rejects a body whose option byte is not NEW-ENVIRON', () => {
    expect(parseMnesRequest(String.fromCharCode(69) + NEW_ENVIRON_SEND)).toEqual({ isSend: false, requested: [] });
  });
});

describe('encodeMnesIs', () => {
  it('frames an IS reply with VAR/VALUE markers and IAC SB/SE', () => {
    const out = encodeMnesIs([{ name: 'CHARSET', value: 'UTF-8' }]);
    expect(out).toBe(
      GMCP_IAC + GMCP_SB +
      OPT_NEW_ENVIRON + NEW_ENVIRON_IS +
      NEW_ENVIRON_VAR + 'CHARSET' + NEW_ENVIRON_VALUE + 'UTF-8' +
      GMCP_IAC + GMCP_SE,
    );
  });

  it('emits multiple variables in order', () => {
    const out = encodeMnesIs([
      { name: 'CLIENT_NAME', value: 'MUDLET' },
      { name: 'MTTS', value: '269' },
    ]);
    expect(out).toBe(
      GMCP_IAC + GMCP_SB +
      OPT_NEW_ENVIRON + NEW_ENVIRON_IS +
      NEW_ENVIRON_VAR + 'CLIENT_NAME' + NEW_ENVIRON_VALUE + 'MUDLET' +
      NEW_ENVIRON_VAR + 'MTTS' + NEW_ENVIRON_VALUE + '269' +
      GMCP_IAC + GMCP_SE,
    );
  });

  it('escapes control bytes within a value', () => {
    // A value containing IAC (255) must be escaped with ESC.
    const out = encodeMnesIs([{ name: 'X', value: 'a' + GMCP_IAC + 'b' }]);
    expect(out).toContain(NEW_ENVIRON_VALUE + 'a' + NEW_ENVIRON_ESC + GMCP_IAC + 'b');
  });

  it('frames names as USERVAR when given the USERVAR marker (plain NEW-ENVIRON)', () => {
    const out = encodeMnesIs([{ name: 'ANSI', value: '1' }], NEW_ENVIRON_USERVAR);
    expect(out).toBe(
      GMCP_IAC + GMCP_SB +
      OPT_NEW_ENVIRON + NEW_ENVIRON_IS +
      NEW_ENVIRON_USERVAR + 'ANSI' + NEW_ENVIRON_VALUE + '1' +
      GMCP_IAC + GMCP_SE,
    );
  });

  it('defaults to the VAR marker (MNES) when no marker is given', () => {
    const out = encodeMnesIs([{ name: 'MTTS', value: '269' }]);
    expect(out).toContain(NEW_ENVIRON_VAR + 'MTTS' + NEW_ENVIRON_VALUE + '269');
  });
});

describe('buildNewEnvironVars', () => {
  const state = { charset: 'UTF-8', utf8: true, tls: true, wrapColumns: 80 };

  it('reports exactly the five MNES core variables when not extended', () => {
    const vars = buildNewEnvironVars(state, false);
    expect(vars.map(v => v.name)).toEqual([
      'CHARSET', 'CLIENT_NAME', 'CLIENT_VERSION', 'MTTS', 'TERMINAL_TYPE',
    ]);
    expect(vars).toContainEqual({ name: 'CLIENT_NAME', value: 'MUDLET-WEB' });
    // MTTS is computed from live state: UTF-8 + TLS here → 2349 (matches Mudlet).
    expect(vars).toContainEqual({ name: 'MTTS', value: String(computeMtts({ utf8: true, tls: true })) });
    expect(vars).toContainEqual({ name: 'MTTS', value: '2349' });
    expect(vars).toContainEqual({ name: 'CHARSET', value: 'UTF-8' });
  });

  it('appends the extended capability set when extended', () => {
    const names = buildNewEnvironVars(state, true).map(v => v.name);
    // Core five still come first, in order.
    expect(names.slice(0, 5)).toEqual([
      'CHARSET', 'CLIENT_NAME', 'CLIENT_VERSION', 'MTTS', 'TERMINAL_TYPE',
    ]);
    // Plus the extended capability vars.
    expect(names).toEqual(expect.arrayContaining([
      'ANSI', '256_COLORS', 'TRUECOLOR', 'UTF-8', 'TLS', 'WORD_WRAP',
      'SCREEN_READER', 'OSC_COLOR_PALETTE', 'OSC_HYPERLINKS', 'VT100',
    ]));
  });

  it('derives UTF-8/TLS/WORD_WRAP capability values from live state', () => {
    const vars = buildNewEnvironVars({ charset: 'ASCII', utf8: false, tls: false, wrapColumns: 0 }, true);
    const byName = new Map(vars.map(v => [v.name, v.value]));
    expect(byName.get('CHARSET')).toBe('ASCII');
    expect(byName.get('UTF-8')).toBe('0');
    expect(byName.get('TLS')).toBe('0');
    expect(byName.get('WORD_WRAP')).toBe('0');
    // Static capabilities mudix always supports.
    expect(byName.get('ANSI')).toBe('1');
    expect(byName.get('TRUECOLOR')).toBe('1');
    expect(byName.get('OSC_COLOR_PALETTE')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS')).toBe('1');
    // MTTS drops the UTF-8 and SSL bits when neither is active: ANSI(1) +
    // 256(8) + OSC_COLOR_PALETTE(32) + TRUECOLOR(256) = 297.
    expect(byName.get('MTTS')).toBe('297');
    // Implemented sub-features (Phases A–D) read "1".
    expect(byName.get('OSC_HYPERLINKS_VISIBILITY')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_SELECTION')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_SEND')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_STYLE_BASIC')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_STYLE_STATES')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_TOOLTIP')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_DISABLED')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_COMPACT')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_PRESETS')).toBe('1');
    expect(byName.get('OSC_HYPERLINKS_MENU')).toBe('1');
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
    // Neighbouring capabilities are untouched — this is not a blanket "0".
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

describe('selectMnesVars', () => {
  const available: MnesVar[] = [
    { name: 'CHARSET', value: 'UTF-8' },
    { name: 'CLIENT_NAME', value: 'MUDLET' },
    { name: 'MTTS', value: '269' },
  ];

  it('returns everything for a bare SEND', () => {
    expect(selectMnesVars({ isSend: true, requested: [] }, available)).toEqual(available);
  });

  it('returns only requested known vars, in request order', () => {
    expect(
      selectMnesVars({ isSend: true, requested: ['MTTS', 'CHARSET'] }, available),
    ).toEqual([
      { name: 'MTTS', value: '269' },
      { name: 'CHARSET', value: 'UTF-8' },
    ]);
  });

  // This used to answer a request for one unknown name with the whole set, on
  // the reasoning that the server still learns who we are. Mudlet does not
  // (cTelnet::sendIsMNESValues only reaches sendAllMNESValues when the request
  // named nothing), and neither does the request: a server probing for one
  // variable should not get an unsolicited dump.
  it('selects nothing when no requested name is known', () => {
    expect(
      selectMnesVars({ isSend: true, requested: ['UNKNOWN'] }, available),
    ).toEqual([]);
  });

  // RFC 1572 distinguishes structurally: a name with no VALUE after it is
  // undefined, which is not a name with a VALUE and nothing after it (defined,
  // and empty). Mudlet lists IPADDRESS as an MNES variable while deliberately
  // not supplying it, and answers it the first way.
  it('answers a known-but-unsupplied name as undefined rather than omitting it', () => {
    expect(
      selectMnesVars({ isSend: true, requested: ['IPADDRESS'] }, available, MNES_UNMAINTAINED),
    ).toEqual([{ name: 'IPADDRESS', value: null }]);
  });

  it('keeps undefined answers in request order beside real values', () => {
    expect(
      selectMnesVars(
        { isSend: true, requested: ['MTTS', 'IPADDRESS', 'NOPE', 'CHARSET'] },
        available,
        MNES_UNMAINTAINED,
      ),
    ).toEqual([
      { name: 'MTTS', value: '269' },
      { name: 'IPADDRESS', value: null },
      // 'NOPE' is not an MNES name at all — left out entirely, not answered.
      { name: 'CHARSET', value: 'UTF-8' },
    ]);
  });

  it('does not treat IPADDRESS as known when the caller does not pass the list', () => {
    // Plain NEW-ENVIRON has no unsupplied name: everything it defines, it reports.
    expect(
      selectMnesVars({ isSend: true, requested: ['IPADDRESS'] }, available),
    ).toEqual([]);
  });
});

describe('encodeMnesIs with an undefined variable', () => {
  const VAR = '\x00', VALUE = '\x01';

  it('emits the name with no VALUE marker', () => {
    const frame = encodeMnesIs([{ name: 'IPADDRESS', value: null }]);
    expect(frame).toContain(VAR + 'IPADDRESS');
    // No VALUE byte anywhere after the name — that is what makes it undefined
    // rather than defined-and-empty.
    expect(frame.slice(frame.indexOf('IPADDRESS'))).not.toContain(VALUE);
  });

  it('still emits a VALUE marker for a defined-but-empty variable', () => {
    const frame = encodeMnesIs([{ name: 'CHARSET', value: '' }]);
    expect(frame).toContain(VAR + 'CHARSET' + VALUE);
  });

  it('mixes defined and undefined variables in one reply', () => {
    const frame = encodeMnesIs([
      { name: 'MTTS', value: '269' },
      { name: 'IPADDRESS', value: null },
      { name: 'CHARSET', value: 'UTF-8' },
    ]);
    expect(frame).toContain(VAR + 'MTTS' + VALUE + '269');
    expect(frame).toContain(VAR + 'IPADDRESS' + VAR + 'CHARSET' + VALUE + 'UTF-8');
  });
});
