// @vitest-environment node
//
// mudlet-web#369: scrolling drift against desktop PTB 96fbed5, from Lua. The
// DOM side — which edge of the view a line lands on, PageUp/PageDown — is in
// tests/ui/scrollDrift369.test.ts. Expectations are desktop's results from the
// issue.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('mudlet-web#369 — scrolling drift', () => {
  let env: TestRuntime;
  beforeEach(async () => {
    env = await createTestRuntime();
    env.run('for i = 1, 100 do echo("L" .. i .. "\\n") end');
    env.run('createMiniConsole("mc369", 0, 0, 100, 100) for i = 1, 100 do echo("mc369", "m" .. i .. "\\n") end');
  });
  afterEach(() => env.dispose());

  const run = (code: string) => env.run(code);

  describe('item 1 — scrollTo(lineNumber) scrolls main', () => {
    it('takes a lone number as a line on main, not a window name', () => {
      expect(run('local a, b = scrollTo(40) return tostring(a) .. "/" .. tostring(b)')).toBe('nil/nil');
      expect(run('return getScroll()')).toBe(40);
    });

    it('takes a numeric string the same way, as lua_isnumber does', () => {
      run('scrollTo("40")');
      expect(run('return getScroll("main")')).toBe(40);
    });

    it('still reports a window name nobody has used', () => {
      expect(run('local a, b = scrollTo("nope369") return tostring(a) .. "/" .. b')).toBe('nil/window "nope369" not found');
    });
  });

  describe('item 3 — disableScrolling closes the split', () => {
    it('returns a scrolled-up miniconsole to its last line', () => {
      run('scrollTo("mc369", 30)');
      expect(run('return getScroll("mc369")')).toBe(30);
      run('disableScrolling("mc369")');
      expect(run('return getScroll("mc369")')).toBe(run('return getLastLineNumber("mc369")'));
    });
  });

  describe('item 4 — getScroll does not keep a scrolled-to line the view has left', () => {
    it('follows new lines after clearWindow on a scrolled miniconsole', () => {
      run('scrollTo("mc369", 30)');
      run('clearWindow("mc369")');
      expect(run('return getScroll("mc369")')).toBe(0);
      run('for i = 1, 50 do echo("mc369", "n" .. i .. "\\n") end');
      expect(run('return getScroll("mc369")')).toBe(50);
    });

    it('follows new lines after clearWindow on a scrolled buffer', () => {
      run('createBuffer("buf369") for i = 1, 100 do echo("buf369", "b" .. i .. "\\n") end');
      run('scrollTo("buf369", 30)');
      run('clearWindow("buf369")');
      run('for i = 1, 50 do echo("buf369", "n" .. i .. "\\n") end');
      expect(run('return getScroll("buf369")')).toBe(50);
    });

    it('follows new lines after scrollTo past the end', () => {
      run('scrollTo("main", 20)');
      run('scrollTo("main", 99999)');
      expect(run('return getScroll()')).toBe(run('return getLastLineNumber("main")'));
      run('for i = 1, 6 do echo("more" .. i .. "\\n") end');
      expect(run('return getScroll()')).toBe(106);
      expect(run('return getScroll()')).toBe(run('return getLastLineNumber("main")'));
    });
  });

  describe('item 6 — return values', () => {
    it('scrollTo returns nothing, scrolling disabled or not', () => {
      expect(run('return select("#", scrollTo("main", 10))')).toBe(0);
      expect(run('return select("#", scrollTo(10))')).toBe(0);
      expect(run('return select("#", scrollTo())')).toBe(0);
      run('disableScrolling("mc369")');
      expect(run('return select("#", scrollTo("mc369", 10))')).toBe(0);
    });

    it('clearWindow and clearUserWindow return nothing', () => {
      expect(run('return select("#", clearWindow("mc369"))')).toBe(0);
      expect(run('return select("#", clearUserWindow("mc369"))')).toBe(0);
      expect(run('return select("#", clearWindow("nope369"))')).toBe(0);
      expect(run('return select("#", clearWindow())')).toBe(0);
    });
  });
});
