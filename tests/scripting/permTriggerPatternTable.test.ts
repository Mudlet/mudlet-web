// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * Mudlet reads a perm*Trigger's pattern table with lua_next and keeps a value
 * only when `lua_type(L, -1) == LUA_TSTRING` (TLuaInterpreterMudletObjects.cpp):
 * keyed entries count, entries past a hole count, and a NUMBER is dropped —
 * this check does not coerce, unlike the getVerified* argument checks.
 *
 * Bridge.lua used ipairs + tostring, the exact opposite on all three: a keyed
 * table made an empty group, a hole cut the list short, and {"numz", 5} became
 * a two-pattern AND trigger (mudlet-web#291). These cases pin the list that
 * reaches the engine.
 */
describe('perm*Trigger pattern tables (mudlet-web#291)', () => {
  let t: TestRuntime;

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());
  afterEach(() => vi.restoreAllMocks());

  const fns = [
    'permSubstringTrigger',
    'permRegexTrigger',
    'permBeginOfLineStringTrigger',
    'permExactMatchTrigger',
  ] as const;

  /** The pattern list `fn` hands the engine for the Lua table literal `table`. */
  const patternsFor = (fn: typeof fns[number], table: string): string[] => {
    const spy = vi.spyOn(t.api, fn).mockReturnValue(7);
    expect(t.run(`return ${fn}("t", "", ${table}, "")`)).toBe(7);
    expect(spy).toHaveBeenCalledTimes(1);
    const patterns = spy.mock.calls[0][2] as string[];
    spy.mockRestore();
    return patterns;
  };

  for (const fn of fns) {
    describe(fn, () => {
      it('drops a number instead of stringifying it', () => {
        expect(patternsFor(fn, '{"numz", 5}')).toEqual(['numz']);
        expect(patternsFor(fn, '{7}')).toEqual([]);
      });

      it('keeps a keyed entry', () => {
        expect(patternsFor(fn, '{k = "keyedz"}')).toEqual(['keyedz']);
      });

      it('reads past a hole', () => {
        expect(patternsFor(fn, '{[1] = "holez1", [3] = "holez3"}')).toEqual(['holez1', 'holez3']);
      });

      it('drops booleans and tables too', () => {
        expect(patternsFor(fn, '{"a", true, {}, "b"}')).toEqual(['a', 'b']);
      });

      it('keeps an ordinary list as it was', () => {
        expect(patternsFor(fn, '{"a", "b", "c"}')).toEqual(['a', 'b', 'c']);
      });
    });
  }
});
