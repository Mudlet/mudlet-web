import { describe, it, expect } from 'vitest';
import { createMsdpStream, type MsdpEnvelope } from '../../../src/mud/protocol/msdp';
import {
  OPT_MSDP,
  MSDP_VAR,
  MSDP_VAL,
  MSDP_TABLE_OPEN,
  MSDP_TABLE_CLOSE,
  MSDP_ARRAY_OPEN,
  MSDP_ARRAY_CLOSE,
} from '../../../src/mud/protocol/constants';

// Build a subnegotiation body as createMsdpStream expects it: the option byte
// (MSDP, 69) followed by the MSDP_VAR/VAL grammar. IAC SB/SE are stripped by
// the telnet option parser before the stream sees the data, so we omit them.
const body = (...parts: string[]) => OPT_MSDP + parts.join('');

function collect(data: string): MsdpEnvelope[] {
  const out: MsdpEnvelope[] = [];
  createMsdpStream({ onEnvelope: (e) => out.push(e) })(data);
  return out;
}

describe('createMsdpStream', () => {
  it('parses a single scalar variable', () => {
    expect(collect(body(MSDP_VAR + 'HEALTH' + MSDP_VAL + '5000'))).toEqual([
      { path: 'HEALTH', value: '5000' },
    ]);
  });

  it('parses multiple top-level variables as separate envelopes', () => {
    expect(
      collect(
        body(
          MSDP_VAR + 'HEALTH' + MSDP_VAL + '5000' +
          MSDP_VAR + 'HEALTH_MAX' + MSDP_VAL + '5500',
        ),
      ),
    ).toEqual([
      { path: 'HEALTH', value: '5000' },
      { path: 'HEALTH_MAX', value: '5500' },
    ]);
  });

  it('parses an array value into an ordered list', () => {
    expect(
      collect(
        body(
          MSDP_VAR + 'REPORTABLE_VARIABLES' + MSDP_VAL +
          MSDP_ARRAY_OPEN +
          MSDP_VAL + 'HEALTH' +
          MSDP_VAL + 'HEALTH_MAX' +
          MSDP_ARRAY_CLOSE,
        ),
      ),
    ).toEqual([{ path: 'REPORTABLE_VARIABLES', value: ['HEALTH', 'HEALTH_MAX'] }]);
  });

  it('parses a table value into a string-keyed object', () => {
    expect(
      collect(
        body(
          MSDP_VAR + 'ROOM' + MSDP_VAL +
          MSDP_TABLE_OPEN +
          MSDP_VAR + 'VNUM' + MSDP_VAL + '6008' +
          MSDP_VAR + 'NAME' + MSDP_VAL + 'A forest clearing' +
          MSDP_TABLE_CLOSE,
        ),
      ),
    ).toEqual([
      { path: 'ROOM', value: { VNUM: '6008', NAME: 'A forest clearing' } },
    ]);
  });

  it('parses nested tables and arrays', () => {
    const [env] = collect(
      body(
        MSDP_VAR + 'ROOM' + MSDP_VAL +
        MSDP_TABLE_OPEN +
        MSDP_VAR + 'EXITS' + MSDP_VAL +
        MSDP_TABLE_OPEN +
        MSDP_VAR + 'n' + MSDP_VAL + '6011' +
        MSDP_VAR + 'e' + MSDP_VAL + '6012' +
        MSDP_TABLE_CLOSE +
        MSDP_TABLE_CLOSE,
      ),
    );
    expect(env).toEqual({
      path: 'ROOM',
      value: { EXITS: { n: '6011', e: '6012' } },
    });
  });

  it('decodes UTF-8 in values', () => {
    const bytes = String.fromCharCode(...new TextEncoder().encode('café'));
    expect(collect(body(MSDP_VAR + 'NAME' + MSDP_VAL + bytes))).toEqual([
      { path: 'NAME', value: 'café' },
    ]);
  });

  it('treats a variable with no value byte as empty string', () => {
    expect(collect(body(MSDP_VAR + 'PING'))).toEqual([{ path: 'PING', value: '' }]);
  });

  it('ignores subnegotiations whose option byte is not MSDP', () => {
    // 201 = GMCP; the MSDP stream must not consume it.
    expect(collect(String.fromCharCode(201) + 'Char.Vitals {}')).toEqual([]);
    expect(collect('')).toEqual([]);
  });
});

// The malformed and multi-value cases upstream pinned in
// src/mudlet-lua/tests/Telnet_spec.lua ("Tests MSDP", :294-345 @124ee8b5f).
// The expectations are Mudlet's own, taken from what
// TLuaInterpreter::msdp2Lua hands to setMSDPTable: an unmarked adjacent-value
// list becomes an array scoped to the variable that carried it, and a variable
// whose table/array markers do not balance is dropped without ever reaching
// setMSDPTable — so it raises no arrival event either.
describe('createMsdpStream: Mudlet parity on malformed and multi-value input', () => {
  const cases: { name: string; payload: string; expected: MsdpEnvelope[] }[] = [
    {
      // Telnet_spec.lua "keeps a table's shape when it holds an array of two or
      // more elements" — adjacent values inside an explicit array must not add
      // an array level the variable never had.
      name: "keeps a table's shape when it holds an array of two or more elements",
      payload:
        MSDP_VAR + 'MSDPSHAPE' + MSDP_VAL +
        MSDP_TABLE_OPEN +
        MSDP_VAR + 'L' + MSDP_VAL +
        MSDP_ARRAY_OPEN + MSDP_VAL + 'a' + MSDP_VAL + 'b' + MSDP_ARRAY_CLOSE +
        MSDP_VAR + 'Z' + MSDP_VAL + 'plain' +
        MSDP_TABLE_CLOSE,
      expected: [{ path: 'MSDPSHAPE', value: { L: ['a', 'b'], Z: 'plain' } }],
    },
    {
      // Telnet_spec.lua "still turns adjacent top-level values into a list" —
      // the specification's unmarked list for command-like variables.
      name: 'still turns adjacent top-level values into a list',
      payload: MSDP_VAR + 'MSDPCMD' + MSDP_VAL + 'alpha' + MSDP_VAL + 'beta',
      expected: [{ path: 'MSDPCMD', value: ['alpha', 'beta'] }],
    },
    {
      // Telnet_spec.lua "wraps only the variable that was an unmarked list" —
      // the wrap is scoped to its own variable, not to whichever comes last.
      name: 'wraps only the variable that was an unmarked list',
      payload:
        MSDP_VAR + 'MSDPLIST' + MSDP_VAL + 'a' + MSDP_VAL + 'b' +
        MSDP_VAR + 'MSDPSOLO' + MSDP_VAL + 'solo',
      expected: [
        { path: 'MSDPLIST', value: ['a', 'b'] },
        { path: 'MSDPSOLO', value: 'solo' },
      ],
    },
    {
      // Telnet_spec.lua "drops a variable whose table the game never closed,
      // without an event" — IAC SE has already arrived, so nothing more is
      // coming for it. The complete variable ahead of it has to survive.
      name: 'drops a variable whose table the game never closed, without an event',
      payload:
        MSDP_VAR + 'MSDPWHOLE' + MSDP_VAL + 'fine' +
        MSDP_VAR + 'MSDPCUT' + MSDP_VAL + MSDP_TABLE_OPEN,
      expected: [{ path: 'MSDPWHOLE', value: 'fine' }],
    },
    {
      // Telnet_spec.lua "yields no variable and no event when the game closes a
      // table it never opened" — and the malformed variable must not take the
      // rest of the message with it.
      name: 'yields no variable and no event when the game closes a table it never opened',
      payload:
        MSDP_VAR + 'MSDPOVER' + MSDP_VAL + MSDP_TABLE_CLOSE +
        MSDP_VAR + 'MSDPNEXT' + MSDP_VAL + 'ok',
      expected: [{ path: 'MSDPNEXT', value: 'ok' }],
    },
  ];

  for (const { name, payload, expected } of cases) {
    it(name, () => {
      expect(collect(body(payload))).toEqual(expected);
    });
  }

  it('drops a variable whose array the game never closed', () => {
    // the same imbalance as MSDPCUT with the other pair of markers
    expect(
      collect(
        body(
          MSDP_VAR + 'KEPT' + MSDP_VAL + 'yes' +
          MSDP_VAR + 'CUTARRAY' + MSDP_VAL + MSDP_ARRAY_OPEN + MSDP_VAL + 'a',
        ),
      ),
    ).toEqual([{ path: 'KEPT', value: 'yes' }]);
  });

  it('drops a variable whose value is followed by a stray close marker', () => {
    // the close belongs to the variable that was still being read, so that
    // variable goes rather than the message surviving intact
    expect(collect(body(MSDP_VAR + 'STRAY' + MSDP_VAL + 'a' + MSDP_ARRAY_CLOSE))).toEqual([]);
  });
});
