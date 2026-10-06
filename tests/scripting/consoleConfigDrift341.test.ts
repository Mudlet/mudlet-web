// @vitest-environment node
//
// mudlet-web#341: console and config drift against desktop PTB 96fbed5 — the
// empty window name, numeric-string cursor arguments, getScroll at the bottom,
// forceNewEnvironNegotiationOff and mudlet.translations. Expectations are
// desktop's results from the issue.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { useAppStore, selectProfileField } from '../../src/storage';

describe('mudlet-web#341 — console and config drift', () => {
  let env: TestRuntime;
  beforeEach(async () => {
    env = await createTestRuntime();
    env.run('echo("l0\\nl1\\nl2\\nl3\\nl4\\n")');
  });
  afterEach(() => env.dispose());

  const run = (code: string) => env.run(code);
  const mainLines = () => run(`local n = getLastLineNumber("main")
                               return table.concat(getLines("main", 0, n + 1), "|")`);

  describe('item 1 — the main console keeps desktop\'s scrollback', () => {
    it('starts at 100000 lines with a 20000-line batch; windows keep 10000/1000', () => {
      expect(run('local a, b = getConsoleBufferSize("main") return a .. " " .. b')).toBe('100000 20000');
      run('createMiniConsole("mc341", 0, 0, 100, 100)');
      expect(run('local a, b = getConsoleBufferSize("mc341") return a .. " " .. b')).toBe('10000 1000');
    });
  });

  describe('item 2 — setConsoleBufferSize("main", …) is saved', () => {
    const profile = () => useAppStore.getState().connectionProfile[TEST_CONNECTION_ID];
    afterEach(() => {
      useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, {
        consoleBufferSize: undefined, useMaxConsoleBufferSize: undefined,
      });
    });

    it('writes the size to the profile and the next session opens on it', async () => {
      expect(run('return setConsoleBufferSize("main", 5000, 500)')).toBe(true);
      expect(run('local a, b = getConsoleBufferSize() return a .. " " .. b')).toBe('5000 500');
      expect(selectProfileField(useAppStore.getState(), TEST_CONNECTION_ID, 'consoleBufferSize')).toBe(5000);
      expect(profile()?.useMaxConsoleBufferSize).toBe(false);
      // The store write coming back to this session leaves the script's batch.
      env.session.setConsoleBufferSize(5000, false);
      expect(run('local a, b = getConsoleBufferSize() return a .. " " .. b')).toBe('5000 500');

      // "Restart": a new session gets the saved preference, as ProfileSession
      // hands it over, and the batch is the preference's 20%.
      env.dispose();
      env = await createTestRuntime();
      env.session.setConsoleBufferSize(profile()!.consoleBufferSize!, profile()!.useMaxConsoleBufferSize === true);
      expect(run('local a, b = getConsoleBufferSize() return a .. " " .. b')).toBe('5000 1000');
    });

    it('saves the "" spelling of main and the use-maximum flag too', () => {
      expect(run('return setConsoleBufferSize("", 3000, 300, true)')).toBe(true);
      expect(profile()?.useMaxConsoleBufferSize).toBe(true);
      expect(profile()?.consoleBufferSize).toBe(run('return (getConsoleBufferSize())'));
    });

    it('leaves the profile alone for a miniconsole', () => {
      run('createMiniConsole("mc341b", 0, 0, 100, 100)');
      expect(run('return setConsoleBufferSize("mc341b", 4000, 400)')).toBe(true);
      expect(profile()?.consoleBufferSize).toBeUndefined();
    });
  });

  describe('item 3 — "" names the main console', () => {
    it('the line and column readers answer for main', () => {
      expect(run('return getLineCount("")')).toBe(run('return getLineCount("main")'));
      expect(run('return getLineNumber("")')).toBe(run('return getLineNumber("main")'));
      expect(run('return getColumnNumber("")')).toBe(run('return getColumnNumber("main")'));
      expect(run('return getWindowWrap("")')).toBe(run('return getWindowWrap("main")'));
      expect(run('return scrollingActive("")')).toBe(run('return scrollingActive("main")'));
      expect(run('return getColumnCount("")')).toBe(run('return getColumnCount("main")'));
      expect(run('return getRowCount("")')).toBe(run('return getRowCount("main")'));
      expect(run('return getScroll("")')).toBe(run('return getScroll("main")'));
      expect(run('return select("#", copy(""))')).toBe(run('return select("#", copy("main"))'));
    });

    it('moveCursor, insertText and deleteLine act on main', () => {
      expect(run('return moveCursor("", 0, 2)')).toBe(true);
      expect(run('return getLineNumber()')).toBe(2);
      expect(run('return (insertText("", "X"))')).toBe(true);
      expect(mainLines()).toBe('l0|l1|Xl2|l3|l4|');
      run('moveCursor("", 0, 1); deleteLine("")');
      expect(mainLines()).toBe('l0|Xl2|l3|l4|');
    });

    it('moveCursorUp/Down/End and selectCurrentLine act on main', () => {
      run('moveCursor(0, 2)');
      run('moveCursorUp("")');
      expect(run('return getLineNumber()')).toBe(1);
      run('moveCursorDown("")');
      expect(run('return getLineNumber()')).toBe(2);
      run('selectCurrentLine("")');
      expect(run('return (getSelection())')).toBe('l2');
      run('moveCursorEnd("")');
      expect(run('return getLineNumber()')).toBe(run('return getLastLineNumber("main")'));
    });

    it('setConsoleBufferSize accepts it', () => {
      expect(run('return setConsoleBufferSize("", 5000, 500)')).toBe(true);
      expect(run('return (getConsoleBufferSize("main"))')).toBe(5000);
    });
  });

  describe('item 4 — numeric strings are numbers', () => {
    it('moveCursor takes them in every position', () => {
      expect(run('return moveCursor(0, "3")')).toBe(true);
      expect(run('return getLineNumber()')).toBe(3);
      expect(run('return moveCursor("2", 1)')).toBe(true);
      expect(run('return getLineNumber() .. ":" .. getColumnNumber()')).toBe('1:2');
      expect(run('return moveCursor("main", "1", "3")')).toBe(true);
      expect(run('return getLineNumber() .. ":" .. getColumnNumber()')).toBe('3:1');
    });

    it('selectSection takes them', () => {
      run('moveCursor(0, 1)');
      expect(run('return selectSection("0", "2")')).toBe(true);
      expect(run('return (getSelection())')).toBe('l1');
      expect(run('return selectSection("main", "0", "2")')).toBe(true);
      expect(run('return (getSelection())')).toBe('l1');
    });

    it('getTimestamp takes them', () => {
      expect(typeof run('return (getTimestamp("3"))')).toBe('string');
      expect(typeof run('return (getTimestamp("main", "3"))')).toBe('string');
    });
  });

  describe('item 5 — getScroll at the bottom is the last line', () => {
    it('equals getLastLineNumber("main") while following the output', () => {
      expect(run('return getScroll()')).toBe(run('return getLastLineNumber("main")'));
      run('for i = 1, 60 do echo("x" .. i .. "\\n") end');
      expect(run('return getScroll()')).toBe(run('return getLastLineNumber("main")'));
      run('scrollTo("main")');
      expect(run('return getScroll("main")')).toBe(run('return getLastLineNumber("main")'));
    });

    it('is the last line while a laid-out console follows, and never past it', () => {
      const wm = env.session.windows;
      const measure = { line: null as number | null };
      wm.canMeasureScroll = () => true;
      wm.getScrollLine = () => measure.line;
      // Tail mode: the buffer's last line, not the DOM's row count.
      expect(run('return getScroll()')).toBe(run('return getLastLineNumber("main")'));
      // Scrolled back: the measured line.
      measure.line = 2;
      expect(run('return getScroll()')).toBe(2);
      // A measurement past the end is clamped to it, as desktop's min().
      measure.line = 10_000;
      expect(run('return getScroll()')).toBe(run('return getLastLineNumber("main")'));
    });
  });

  describe('item 6 — forceNewEnvironNegotiationOff is NEW-ENVIRON alone', () => {
    it('leaves MNES alone in both directions', () => {
      run('setConfig("enableMNES", true); setConfig("forceNewEnvironNegotiationOff", true)');
      expect(run('return getConfig("enableMNES")')).toBe(true);
      expect(run('return getConfig("enableNEWENVIRON")')).toBe(false);
      expect(run('return getConfig("forceNewEnvironNegotiationOff")')).toBe(true);
      run('setConfig("forceNewEnvironNegotiationOff", false)');
      expect(run('return getConfig("enableMNES")')).toBe(true);
      expect(run('return getConfig("enableNEWENVIRON")')).toBe(true);
      expect(run('return getConfig("forceNewEnvironNegotiationOff")')).toBe(false);
    });

    it('reads as the inverse of enableNEWENVIRON whatever MNES is', () => {
      run('setConfig("enableMNES", true); setConfig("enableNEWENVIRON", false)');
      expect(run('return getConfig("forceNewEnvironNegotiationOff")')).toBe(true);
      run('setConfig("enableNEWENVIRON", true)');
      expect(run('return getConfig("forceNewEnvironNegotiationOff")')).toBe(false);
    });
  });

  describe('item 7 — mudlet.translations.en_US', () => {
    it('has the i and o keys', () => {
      expect(run('return mudlet.translations.en_US.i')).toBe('i');
      expect(run('return mudlet.translations.en_US.o')).toBe('o');
      // 24: desktop has 23, its "e" lost to a typo — see e2e/knownDivergences.ts.
      expect(run('local n = 0 for _ in pairs(mudlet.translations.en_US) do n = n + 1 end return n')).toBe(24);
    });
  });
});
