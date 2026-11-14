// @vitest-environment node

// GMCP bodies reach the Lua `gmcp` table through json_to_value, as desktop's
// TLuaInterpreter::parseJSON decodes them (GMCP_spec "Tests that GMCP data
// decodes as json_to_value decodes it"): a script's own decoder gets every
// body, and a decoder that raises leaves the previous value in place.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('GMCP decoded by json_to_value', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('builds the value the stock decoder builds', () => {
    expect(env.rt.setGmcpValue('Char.Vitals', undefined, '{"hp":5,"list":[1,null]}')).toBe(true);
    expect(env.run('return gmcp.Char.Vitals.hp')).toBe(5);
    expect(env.run('return rawequal(gmcp.Char.Vitals.list[2], yajl.null)')).toBe(true);
  });

  it('decodes a document nested past 64 levels', () => {
    const deep = '['.repeat(70) + '1' + ']'.repeat(70);
    expect(env.rt.setGmcpValue('Deep.Doc', undefined, deep)).toBe(true);
    expect(env.run('local v = gmcp.Deep.Doc for _ = 1, 70 do v = v[1] end return v')).toBe(1);
  });

  it("hands the body to a script's own json_to_value", () => {
    env.run('__seen = nil; json_to_value = function(text) __seen = text; return "replaced" end');
    expect(env.rt.setGmcpValue('Own.Doc', undefined, '{"a":1}')).toBe(true);
    expect(env.run('return gmcp.Own.Doc')).toBe('replaced');
    expect(env.run('return __seen')).toBe('{"a":1}');
  });

  it('keeps the previous value when the decoder raises, and reports nothing stored', () => {
    expect(env.rt.setGmcpValue('Keep.Doc', undefined, '"before"')).toBe(true);
    env.run('json_to_value = function() error("raised while decoding") end');
    expect(env.rt.setGmcpValue('Keep.Doc', undefined, '{"a":1}')).toBe(false);
    expect(env.run('return gmcp.Keep.Doc')).toBe('before');
  });

  it('keeps the previous value for a body that is not JSON', () => {
    expect(env.rt.setGmcpValue('Bad.Doc', undefined, '"before"')).toBe(true);
    expect(env.rt.setGmcpValue('Bad.Doc', undefined, '{broken')).toBe(false);
    expect(env.run('return gmcp.Bad.Doc')).toBe('before');
  });
});
