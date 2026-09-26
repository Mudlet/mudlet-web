// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// wasmoon pushes an integral JS number with lua_pushinteger, which is 32 bits in
// this wasm build; LuaRuntime patches the push so a whole number past int32
// reaches Lua as the double it is (MapViewportLimits_spec: a map zoom of 1e40
// read back as 0).
describe('JS numbers crossing into Lua', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  const setGlobal = (name: string, fn: () => unknown) =>
    (env.rt as unknown as { lua: { global: { set(n: string, v: unknown): void } } }).lua.global.set(name, fn);

  it('keeps an integral value past int32 whole, returned or inside a table', () => {
    setGlobal('__bigNumber', () => 1e40);
    setGlobal('__bigTable', () => ({ zoom: 1e12, small: 7, negative: -3e9 }));
    expect(env.run('return __bigNumber() == 1e40')).toBe(true);
    expect(env.run('local t = __bigTable() return t.zoom == 1e12 and t.small == 7 and t.negative == -3e9')).toBe(true);
  });

  it('still hands an int32 value over unchanged', () => {
    setGlobal('__edge', () => 2147483647);
    expect(env.run('return __edge() == 2147483647')).toBe(true);
  });
});
