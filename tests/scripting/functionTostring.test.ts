// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// wasmoon gives every JS function it pushes a metatable whose __tostring/__index
// dereference the JS value behind it. Lua 5.1's lua_setmetatable on a function
// sets the metatable for the *whole function type*, so that metatable ends up on
// every Lua function — and stringifying one made wasmoon look up a JS ref that was
// never registered. The resulting JS TypeError is not a Lua error: it unwinds past
// pcall and out of doStringSync, taking the lua_State with it. LuaRuntime installs
// a safe `tostring` (see installSafeFunctionTostring) before Bridge.lua.
describe('tostring on functions', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // Mudlet prints `function: 0x55d3…` for every function, whatever its origin.
  const POINTER = /^function: 0x[0-9a-f]+$/;

  it('stringifies a plain Lua function', () => {
    expect(env.run('return tostring(function() end)')).toMatch(POINTER);
  });

  it('stringifies a stock C function', () => {
    expect(env.run('return tostring(type)')).toMatch(POINTER);
  });

  // The JS-backed globals are the ones that *did* work — before the fix they
  // stringified into their entire JS source text, which Mudlet never does.
  it('stringifies a JS-bound global the same way, not as JS source', () => {
    const s = env.run('return tostring(send)') as string;
    expect(s).toMatch(POINTER);
    expect(s).not.toContain('=>');  // no JS source body
  });

  it('survives print(), which reads the global tostring at call time', () => {
    expect(env.run('print(print) return true')).toBe(true);
  });

  // Mudlet's own TableUtils walks arbitrary values through tostring; a table
  // holding a function used to kill the runtime outright.
  it('lets printTable render a table holding functions', () => {
    expect(env.run('printTable({ fn = print, nested = {}, flag = true }) return true')).toBe(true);
  });

  it('leaves non-function values to Lua', () => {
    expect(env.run('return tostring(nil) .. "/" .. tostring(true) .. "/" .. tostring(12)'))
      .toBe('nil/true/12');
    expect(env.run('return tostring({})')).toMatch(/^table: 0x[0-9a-f]+$/);
  });

  // The metatable is restored after each call, so indexing a JS-backed function
  // (which routes through that same metatable) keeps working afterwards.
  it('restores the shared metatable it borrows', () => {
    expect(env.run('tostring(print) return debug.getmetatable(print) ~= nil')).toBe(true);
  });
});
