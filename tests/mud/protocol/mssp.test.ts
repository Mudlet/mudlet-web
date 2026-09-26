import { describe, it, expect } from 'vitest';
import { createMsspStream, parseMssp, type MsspEnvelope } from '../../../src/mud/protocol/mssp';
import { OPT_MSSP, MSSP_VAR, MSSP_VAL } from '../../../src/mud/protocol/constants';

// Build a subnegotiation body as createMsspStream expects it: the option byte
// (MSSP, 70) followed by the MSSP_VAR/VAL grammar. IAC SB/SE are stripped by the
// telnet option parser before the stream sees the data, so we omit them.
const body = (...parts: string[]) => OPT_MSSP + parts.join('');

function collect(data: string): MsspEnvelope[] {
  const out: MsspEnvelope[] = [];
  createMsspStream({ onEnvelope: (e) => out.push(e) })(data);
  return out;
}

describe('parseMssp', () => {
  it('parses a single variable', () => {
    expect(parseMssp(MSSP_VAR + 'PLAYERS' + MSSP_VAL + '52')).toEqual([
      { name: 'PLAYERS', value: '52' },
    ]);
  });

  it('parses multiple variables in order', () => {
    expect(
      parseMssp(
        MSSP_VAR + 'PLAYERS' + MSSP_VAL + '52' +
        MSSP_VAR + 'UPTIME' + MSSP_VAL + '1234567890' +
        MSSP_VAR + 'NAME' + MSSP_VAL + 'Example MUD',
      ),
    ).toEqual([
      { name: 'PLAYERS', value: '52' },
      { name: 'UPTIME', value: '1234567890' },
      { name: 'NAME', value: 'Example MUD' },
    ]);
  });

  it('skips a variable with no value byte, like Mudlet (#4233)', () => {
    expect(parseMssp(MSSP_VAR + 'CRAWL DELAY')).toEqual([]);
  });

  it('keeps reading past a variable with no value byte', () => {
    expect(parseMssp(MSSP_VAR + 'NOVALUE' + MSSP_VAR + 'PLAYERS' + MSSP_VAL + '3')).toEqual([
      { name: 'PLAYERS', value: '3' },
    ]);
  });

  it('keeps only the first value of a list-valued variable (Mudlet parity)', () => {
    expect(
      parseMssp(MSSP_VAR + 'FAMILY' + MSSP_VAL + 'DikuMUD' + MSSP_VAL + 'Custom'),
    ).toEqual([{ name: 'FAMILY', value: 'DikuMUD' }]);
  });

  it('decodes UTF-8 in values', () => {
    const bytes = String.fromCharCode(...new TextEncoder().encode('café'));
    expect(parseMssp(MSSP_VAR + 'NAME' + MSSP_VAL + bytes)).toEqual([
      { name: 'NAME', value: 'café' },
    ]);
  });

  it('ignores stray bytes before the first VAR', () => {
    expect(parseMssp('garbage' + MSSP_VAR + 'PLAYERS' + MSSP_VAL + '1')).toEqual([
      { name: 'PLAYERS', value: '1' },
    ]);
  });
});

describe('createMsspStream', () => {
  it('emits one envelope per variable', () => {
    expect(
      collect(body(MSSP_VAR + 'PLAYERS' + MSSP_VAL + '52' + MSSP_VAR + 'PORT' + MSSP_VAL + '4000')),
    ).toEqual([
      { name: 'PLAYERS', value: '52' },
      { name: 'PORT', value: '4000' },
    ]);
  });

  it('ignores subnegotiations whose option byte is not MSSP', () => {
    // 201 = GMCP; the MSSP stream must not consume it.
    expect(collect(String.fromCharCode(201) + 'Char.Vitals {}')).toEqual([]);
    expect(collect('')).toEqual([]);
  });
});
