// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * Mudlet's argument validators coerce, because Lua 5.1's `lua_is*` follow the
 * language's own string<->number conversion:
 *
 *   getVerifiedInt / getVerifiedDouble -> lua_isnumber -> a NUMERIC STRING is a
 *     valid number, and lua_tointeger truncates it toward zero.
 *   getVerifiedString / checkStringArg -> lua_isstring -> a NUMBER is a valid
 *     string, rendered the way lua_tostring renders it.
 *   getVerifiedBool -> lua_isboolean -> genuinely strict, no coercion.
 *
 * Bridge.lua used to validate with `type(x) ~= 'number'` / `~= 'string'`, which
 * rejects both directions, so packages that work in Mudlet raised here — the
 * bug reported for setConsoleBufferSize via Geyser.MiniConsole:setBufferSize.
 * Trigger captures make this ordinary rather than exotic: `matches[2]` is always
 * a string, so `tempLineTrigger(matches[2], matches[3], code)` is normal code.
 *
 * Every call below is one real Mudlet accepts.
 */
describe('Mudlet argument coercion parity', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);

  beforeAll(async () => {
    t = await createTestRuntime();
    run('createMiniConsole("coerceMC", 0, 0, 400, 200)');
    run('createLabel("coerceLB", 0, 0, 50, 50, 1)');
  });

  afterAll(() => t?.dispose());

  describe('numeric arguments accept numeric strings', () => {
    it('setConsoleBufferSize takes them for the limit and the batch size', () => {
      expect(run('return setConsoleBufferSize("coerceMC", "5000", "500")')).toBe(true);
      expect(run('return (getConsoleBufferSize("coerceMC"))')).toBe(5000);
      expect(run('local _, b = getConsoleBufferSize("coerceMC") return b')).toBe(500);
    });

    it('setConsoleBufferSize takes them through Geyser.MiniConsole:setBufferSize', () => {
      run('geyserCoerce = Geyser.MiniConsole:new({name = "geyserCoerce", x = 0, y = 0, width = 200, height = 100})');
      expect(() => run('geyserCoerce:setBufferSize("2000", "200")')).not.toThrow();
      expect(run('return (getConsoleBufferSize("geyserCoerce"))')).toBe(2000);
    });

    it('truncates toward zero, as lua_tointeger does', () => {
      expect(run('return setConsoleBufferSize("coerceMC", "1500.7", 150)')).toBe(true);
      expect(run('return (getConsoleBufferSize("coerceMC"))')).toBe(1500);
    });

    it('reads a two-argument setConsoleBufferSize as (lines, batch), never as a name', () => {
      // Mudlet keys the optional window name off the argument COUNT (n > 2),
      // so two arguments are never a name even when the first is a string.
      expect(run('return setConsoleBufferSize("3000", "300")')).toBe(true);
      expect(run('return (getConsoleBufferSize())')).toBe(3000);
    });

    it('the border setters take them', () => {
      for (const fn of ['setBorderTop', 'setBorderBottom', 'setBorderLeft', 'setBorderRight']) {
        expect(() => run(fn + '("5")'), fn).not.toThrow();
      }
      run('setBorderTop(0) setBorderBottom(0) setBorderLeft(0) setBorderRight(0)');
    });

    it('the widget constructors take them for every coordinate', () => {
      expect(() => run('createMiniConsole("coerceMC2", "0", "0", "200", "100")')).not.toThrow();
      expect(() => run('createScrollBox("coerceSB", "0", "0", "200", "100")')).not.toThrow();
      expect(() => run('createCommandLine("coerceCL", "0", "0", "200", "30")')).not.toThrow();
      expect(() => run('createTextEdit("coerceTE", "0", "0", "200", "100")')).not.toThrow();
      // createLabel's fillBackground is lua_isnumber OR lua_isboolean.
      expect(() => run('createLabel("coerceLB2", 0, 0, 50, 50, "1")')).not.toThrow();
      // ...but the parent-window overload splits on strict lua_type, so two
      // leading strings still mean (parent, name) even when one looks numeric.
      expect(() => run('createLabel("coerceMC", "coerceLB3", "0", "0", "50", "50", "1")')).not.toThrow();
    });

    it('the timer and trigger constructors take them', () => {
      expect(() => run('tempTimer("1", "")')).not.toThrow();
      expect(() => run('tempLineTrigger("1", "1", "")')).not.toThrow();
      expect(() => run('setTriggerStayOpen("coerceMC", "3")')).not.toThrow();
      expect(() => run('tempTrigger("x", "", "3")')).not.toThrow();
      expect(() => run(
        'tempComplexRegexTrigger("coerceCX", "x", "", "0", "-1", "-1", "0", "0", "-1", "-1", "0", "0", "0")',
      )).not.toThrow();
    });

    it('the assorted numeric setters take them', () => {
      expect(() => run('setTextFormat("coerceMC", "0","0","0", "255","255","255", "0","0","0")')).not.toThrow();
      expect(() => run('setBackgroundImage("coerceLB", "x.png", "1")')).not.toThrow();
      expect(() => run('showNotification("t", "m", "5")')).not.toThrow();
      expect(() => run('setMainWindowSize("800", "600")')).not.toThrow();
      expect(() => run('getScript("nope", "1")')).not.toThrow();
      expect(() => run('addCustomLine(1, "2", "north", "solid", {255,0,0})')).not.toThrow();
    });
  });

  describe('string arguments accept numbers', () => {
    it('window and item names do', () => {
      const calls = [
        'hideWindow(1)', 'showWindow(1)', 'pasteWindow(1)', 'closeUserWindow(1)',
        'enableTimer(1)', 'disableTimer(1)', 'enableScript(1)', 'disableScript(1)',
        'startMovie(1)', 'setUserWindowTitle(1, "t")', 'getUserWindowTitle(1)',
        'setProfileIcon(1)', 'setMergeTables(42)',
      ];
      for (const call of calls) {
        expect(() => run(call), call).not.toThrow();
      }
    });

    it('raiseGlobalEvent takes a number, boolean or nil in any position', () => {
      // Mudlet's C++ switch accepts LUA_TNUMBER/TSTRING/TBOOLEAN/TNIL for every
      // argument, the event name included.
      expect(() => run('raiseGlobalEvent(1)')).not.toThrow();
      expect(() => run('raiseGlobalEvent(true)')).not.toThrow();
      expect(() => run('raiseGlobalEvent("e", 1, true, nil)')).not.toThrow();
      expect(() => run('raiseGlobalEvent({})')).toThrow(/boolean, number, string or nil/);
    });

    it('media file names do', () => {
      expect(() => run('playSoundFile(42)')).not.toThrow();
      expect(() => run('loadSoundFile(42)')).not.toThrow();
    });
  });

  describe('what must still be refused', () => {
    it('a string that is not a number at all', () => {
      expect(() => run('setConsoleBufferSize("coerceMC", "lots", 100)'))
        .toThrow(/lines limit as number expected, got string/);
      expect(() => run('tempLineTrigger("first", "1", "")'))
        .toThrow(/line number as number expected/);
    });

    it('a table, wherever a scalar was wanted', () => {
      expect(() => run('setBorderTop({})')).toThrow(/number expected, got table/);
      expect(() => run('createLabel("coerceLBX", 0, 0, 50, 50, {})')).toThrow(/boolean expected/);
    });

    it('a boolean where Mudlet uses getVerifiedString — lua_isstring is false for one', () => {
      expect(() => run('setConfig("hideMapInfo", true)')).toThrow(/value as string expected/);
    });

    it('a number where Mudlet itself tests with a strict lua_type', () => {
      // createStopWatch dispatches on LUA_TBOOLEAN / LUA_TSTRING / LUA_TNIL, and
      // HTTP header tables are checked with lua_type(..) != LUA_TSTRING.
      expect(() => run('createStopWatch(42)')).toThrow(/name as string or autostart as boolean/);
      expect(() => run('getHTTP("u", {[1]="v"})')).toThrow(/custom headers must be strings/);
    });
  });
});
