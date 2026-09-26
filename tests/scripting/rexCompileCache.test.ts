// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * `rex` used to compile its pattern on every call and destroy it straight
 * after, and a `rex.new` object only carries the pattern string — so a trigger
 * testing each line against a few dozen cached `rex.new` shapes recompiled all
 * of them per line. Under an output flood that alone was seconds of lag (#195).
 * Compiled patterns are now cached; these pin the cache and the behaviour that
 * must survive it.
 */
const compiles = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/mud/triggers/pcre/Pcre2', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/mud/triggers/pcre/Pcre2')>();
  class Counting extends mod.default {
    constructor(pattern: string, flags?: string) {
      super(pattern, flags);
      compiles.n++;
    }
  }
  return { ...mod, default: Counting };
});

describe('rex compiled-pattern cache', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  it('compiles a repeated pattern once, not per call', () => {
    const before = compiles.n;
    expect(run(`
      local re = rex.new("^HP:(\\\\d+)/(\\\\d+)")
      local hits = 0
      for i = 1, 500 do
        if re:match("HP:" .. i .. "/500") then hits = hits + 1 end
        rex.find("line " .. i, "\\\\d+")
      end
      return hits
    `)).toBe(500);
    expect(compiles.n - before).toBe(2);
  });

  it('keeps flags part of the key', () => {
    expect(run(`return rex.match("ABC", "abc", 1, "i")`)).toBe('ABC');
    expect(run(`return rex.match("ABC", "abc")`)).toBeNull();
    expect(run(`return rex.match("ABC", "abc", 1, "i")`)).toBe('ABC');
  });

  it('lets a gsub replacement function use the same pattern', () => {
    expect(run(`
      return rex.gsub("a1 b2", "(\\\\d)", function(d)
        return rex.gsub(d .. d, "(\\\\d)", function(x) return "<" .. x .. ">" end)
      end)
    `)).toBe('a<1><1> b<2><2>');
  });

  it('still reports a bad pattern on every call', () => {
    expect(run(`return (pcall(rex.match, "x", "(bad"))`)).toBe(false);
    expect(run(`return (pcall(rex.match, "x", "(bad"))`)).toBe(false);
  });
});
