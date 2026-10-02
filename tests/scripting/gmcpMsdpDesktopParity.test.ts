// @vitest-environment node

// Lua-side halves of issue #287, each pinned against what Mudlet desktop does
// (measured on the 5.0.0 PTB; the C++ is cited per case).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { encodeMsdp } from '../../src/mud/protocol/msdp';
import { GMCP_IAC, GMCP_SB, GMCP_SE, OPT_MSDP, MSDP_VAR, MSDP_VAL } from '../../src/mud/protocol/constants';

describe('issue #287 — GMCP/MSDP desktop parity', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  /** Pretend the socket is up, so the Lua wrappers reach the JS send. */
  const connect = () => {
    const info = env.api.getConnectionInfo();
    vi.spyOn(env.api, 'getConnectionInfo').mockReturnValue({ ...info, connected: true });
  };

  // Item 2: yajl keeps an escaped NUL inside a decoded string (Lua strings are
  // counted); lua_pushstring would cut the string at it.
  it('keeps a NUL inside a GMCP string value', () => {
    env.rt.setGmcpValue('Q.Nul', JSON.parse('"x\\u0000y"'));
    env.rt.setGmcpValue('T.Uni', JSON.parse('{"z":"a\\u0000b"}'));
    expect(env.run('return gmcp.Q.Nul == "x\\0y"')).toBe(true);
    expect(env.run('return #gmcp.Q.Nul')).toBe(3);
    expect(env.run('return gmcp.T.Uni.z == "a\\0b"')).toBe(true);
  });

  it('keeps a NUL inside an MSDP value too', () => {
    env.rt.setMsdpValue('V', 'p\0q');
    expect(env.run('return msdp.V == "p\\0q"')).toBe(true);
  });

  // Item 3: parseJSON splits the key with QString::split('.'), which keeps
  // empty segments.
  it('keeps empty package-name segments as "" keys', () => {
    env.rt.setGmcpValue('A..B', { v: 1 });
    env.rt.setGmcpValue('A.', { v: 2 });
    env.rt.setGmcpValue('.A', { v: 3 });
    expect(env.run('return gmcp.A[""].v')).toBe(2);
    expect(env.run('return gmcp.A[""].B')).toBe(null);
    expect(env.run('return gmcp.A.v')).toBe(null);
    expect(env.run('return gmcp[""].A.v')).toBe(3);
  });

  it('still nests an ordinary dotted key', () => {
    env.rt.setGmcpValue('Char.Vitals', { hp: 5 });
    expect(env.run('return gmcp.Char.Vitals.hp')).toBe(5);
  });

  // Item 4: sendGMCP appends " what" only `if (!what.empty())`.
  it('sendGMCP with an empty data argument adds no trailing space', () => {
    connect();
    const sent = vi.spyOn(env.api, 'sendGmcp').mockImplementation(() => {});
    env.run('sendGMCP("Out.C", "")');
    env.run('sendGMCP("Out.D", "1")');
    env.run('sendGMCP("Out.E")');
    expect(sent.mock.calls.map(c => c[0])).toEqual(['Out.C', 'Out.D 1', 'Out.E']);
  });

  // Item 4: sendMSDP frames one VAL per value argument, an empty one included.
  it('sendMSDP with an empty value sends an empty VAL', () => {
    connect();
    const sent = vi.spyOn(env.api, 'sendMSDP').mockReturnValue(true);
    env.run('sendMSDP("X", "")');
    env.run('sendMSDP("Y")');
    env.run('sendMSDP("Z", "a", "")');
    expect(sent.mock.calls).toEqual([['X', ['']], ['Y', []], ['Z', ['a', '']]]);
    expect(encodeMsdp('X', [''])).toBe(
      GMCP_IAC + GMCP_SB + OPT_MSDP + MSDP_VAR + 'X' + MSDP_VAL + GMCP_IAC + GMCP_SE,
    );
  });

  // Item 5: Mudlet's LuaGlobal.lua declares gmcp and mssp but not msdp, which
  // setMSDPTable creates on the first variable.
  it('has no msdp global until the first MSDP variable arrives', () => {
    expect(env.run('return type(msdp)')).toBe('nil');
    expect(env.run('return type(gmcp)')).toBe('table');
    env.rt.setMsdpValue('HEALTH', '5');
    expect(env.run('return msdp.HEALTH')).toBe('5');
  });
});
