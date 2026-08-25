// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * `rex.*` used to die on any pattern that can match nothing.
 *
 * There are two PCRE2 wrappers in the tree over the one wasm module. The trigger
 * engine uses the vendored fork (`src/mud/triggers/pcre/Pcre2.ts`), whose
 * global-match loop steps past a zero-width match the way Mudlet's own does.
 * `rex.ts` used the upstream `pcre2-wasm-universal` wrapper, which resumes at
 * `iter[0].end` unconditionally: an empty match leaves the offset where it was,
 * the loop re-finds the same empty match for ever, and upstream's hardcoded
 * 1000-iteration cap throws `safety limit exceeded`. So `rex.gmatch`,
 * `rex.gsub`, `rex.split` and `rex.count` all failed outright on `(\d*)` — no
 * exotic input needed, a plain ASCII subject was enough.
 *
 * Mudlet has the neighbouring bug (Mudlet/Mudlet#10113): its match-all loop
 * advances one BYTE, which lands mid-character on a non-ASCII line and drops
 * every capture after it. The fork advances by a whole code point, so the
 * surrogate-pair case is covered here too.
 */
describe('rex with an empty-capable pattern', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  // The exact pattern Mudlet's Trigger_spec/Alias_spec use for this.
  const P = '[[(\\d*)]]';

  it('gmatch terminates instead of hitting the safety cap', () => {
    expect(run(`
      local n = 0
      for _ in rex.gmatch("abc 42 def", ${P}) do n = n + 1 end
      return n
    `)).toBeGreaterThan(0);
  });

  it('gmatch yields the digits it matched', () => {
    expect(run(`
      local found = {}
      for cap in rex.gmatch("abc 42 def", ${P}) do
        if cap and cap ~= "" then found[#found + 1] = cap end
      end
      return table.concat(found, ",")
    `)).toBe('42');
  });

  it('keeps a capture that follows a multi-byte character', () => {
    // Mudlet/Mudlet#10113's own reproduction: the 9 is dropped when the loop
    // resumes mid-character.
    expect(run(`
      local found = {}
      for cap in rex.gmatch("caf\\195\\169 9", ${P}) do
        if cap and cap ~= "" then found[#found + 1] = cap end
      end
      return table.concat(found, ",")
    `)).toBe('9');
  });

  it('keeps a capture that follows a surrogate pair', () => {
    // U+1F642 is two UTF-16 code units, and PCRE2 in 16-bit mode refuses an
    // offset that splits one — a one-unit step would throw BADUTFOFFSET.
    expect(run(`
      local found = {}
      for cap in rex.gmatch("\\240\\159\\153\\130 7", ${P}) do
        if cap and cap ~= "" then found[#found + 1] = cap end
      end
      return table.concat(found, ",")
    `)).toBe('7');
  });

  it('count returns a number rather than throwing', () => {
    expect(typeof run(`return rex.count("abc 42 def", ${P})`)).toBe('number');
  });

  it('gsub replaces without spinning', () => {
    expect(run(`return (rex.gsub("a1b", ${P}, "#"))`)).toContain('#');
  });

  it('split terminates', () => {
    expect(run(`
      local n = 0
      for _ in rex.split("a1b", ${P}) do
        n = n + 1
        if n > 50 then break end
      end
      return n
    `)).toBeLessThan(50);
  });

  it('a pattern that cannot match empty is unaffected', () => {
    // After an ordinary match the loop resumes at `ovector[1]`, which is always
    // on a character boundary, so this path never depended on the fix. The `é`
    // is absent because `\w` without UCP is ASCII-only — PCRE's own semantics,
    // not the stepping.
    expect(run(`
      local found = {}
      for cap in rex.gmatch("caf\\195\\169 au lait", [[(\\w+)]]) do
        found[#found + 1] = cap
      end
      return table.concat(found, ",")
    `)).toBe('caf,au,lait');
  });
});
