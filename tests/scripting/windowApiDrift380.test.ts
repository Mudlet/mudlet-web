// @vitest-environment node

// Window API checked against desktop Mudlet PTB side by side
// (Mudlet/mudlet-web#380): a createBuffer buffer is a full console to the
// window functions, createMiniConsole/createLabel don't take over another
// console's name, setMiniConsoleFontSize is setFontSize under another name, and
// a user window's default title and echoUserWindow's return match desktop.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/** Lua helper: every value a call returns, joined with " | ". */
const PACK = `function P(...) local o = {}
  for i = 1, select("#", ...) do o[#o + 1] = tostring((select(i, ...))) end
  return table.concat(o, " | ") end`;

describe('window API matches desktop (#380)', () => {
  let env: TestRuntime;
  beforeEach(async () => {
    env = await createTestRuntime();
    env.run(PACK);
  });
  afterEach(() => env.dispose());

  const all = (expr: string) => env.run(`return P(${expr})`);

  describe('a createBuffer buffer takes the window functions', () => {
    beforeEach(() => env.run('createBuffer("bf")'));

    it('keeps a background colour', () => {
      expect(all('setBackgroundColor("bf", 10, 20, 30, 40)')).toBe('true');
      expect(all('getBackgroundColor("bf")')).toBe('10 | 20 | 30 | 40');
    });

    it('keeps a font size, without a sysFontChangeEvent', () => {
      env.api.setHost({ ...env.api.engineHost, raiseEvent: (event: string, args: unknown[]) => env.rt.emitEvent(event, args) });
      env.run('R = 0; registerAnonymousEventHandler("sysFontChangeEvent", function() R = R + 1 end)');
      expect(all('setFontSize("bf", 11)')).toBe('true');
      expect(all('getFontSize("bf")')).toBe('11');
      expect(env.run('return R')).toBe(0);
    });

    it('is found, hidden, by windowVisible and the show/raise/lower calls', () => {
      expect(all('windowVisible("bf")')).toBe('false');
      expect(all('showWindow("bf")')).toBe('true');
      expect(all('raiseWindow("bf")')).toBe('true');
      expect(all('lowerWindow("bf")')).toBe('true');
      // Still no panel: a buffer is never drawn.
      expect(env.api.windows.has('bf')).toBe(false);
    });

    it('keeps the geometry moveWindow/resizeWindow give it', () => {
      env.run('moveWindow("bf", 10, 10); resizeWindow("bf", 100, 100)');
      expect(all('getWindowGeometry("bf")')).toBe('10 | 10 | 100 | 100');
    });

    it('is emptied by clearUserWindow', () => {
      env.run('echo("bf", "one\\ntwo\\n")');
      expect(env.run('return getLineCount("bf")')).toBe(2);
      env.run('clearUserWindow("bf")');
      expect(env.run('return getLineCount("bf")')).toBe(0);
    });

    it('is deleted by deleteMiniConsole, which raises sysMiniConsoleDeleted', () => {
      env.api.setHost({ ...env.api.engineHost, raiseEvent: (event: string, args: unknown[]) => env.rt.emitEvent(event, args) });
      env.run('R = {}; registerAnonymousEventHandler("sysMiniConsoleDeleted", function(e, n) R[#R + 1] = e .. " " .. n end)');
      env.run('echo("bf", "kept?\\n")');
      expect(all('deleteMiniConsole("bf")')).toBe('true');
      expect(env.run('return table.concat(R, "|")')).toBe('sysMiniConsoleDeleted bf');
      expect(env.run('return (windowType("bf"))')).toBeNull();
      expect(env.api.isBuffer('bf')).toBe(false);
      // Made again, it starts empty.
      env.run('createBuffer("bf")');
      expect(env.run('return getLineCount("bf")')).toBe(0);
    });
  });

  describe("creating a console over another one's name", () => {
    it('createMiniConsole over a buffer moves it and leaves it a buffer', () => {
      env.run('createBuffer("b2")');
      expect(all('createMiniConsole("b2", 5, 6, 70, 80)'))
        .toBe("false | miniconsole 'b2' already exists, moving/resizing 'b2'");
      expect(env.run('return (windowType("b2"))')).toBe('buffer');
      expect(all('getWindowGeometry("b2")')).toBe('5 | 6 | 70 | 80');
      expect(env.api.windows.has('b2')).toBe(false);
    });

    it('createMiniConsole over a user window is refused and leaves it alone', () => {
      env.run('openUserWindow("u1"); setUserWindowTitle("u1", "Mine")');
      expect(all('createMiniConsole("u1", 0, 0, 100, 100)'))
        .toBe("false | miniconsole/userwindow 'u1' already exists");
      expect(env.run('return (windowType("u1"))')).toBe('userwindow');
      expect(env.run('return (getUserWindowTitle("u1"))')).toBe('Mine');
    });

    it('createLabel over a buffer is refused', () => {
      env.run('createBuffer("b3")');
      expect(all('createLabel("b3", 0, 0, 10, 10, 1)'))
        .toBe("false | a miniconsole/userwindow with the name 'b3' already exists");
      expect(env.run('return (windowType("b3"))')).toBe('buffer');
    });

    it('createMiniConsole still repositions an existing miniconsole', () => {
      env.run('createMiniConsole("mc", 0, 0, 100, 100)');
      expect(all('createMiniConsole("mc", 10, 20, 100, 100)'))
        .toBe("false | miniconsole 'mc' already exists, moving/resizing 'mc'");
      expect(env.run('return (windowType("mc"))')).toBe('miniconsole');
    });
  });

  describe('setMiniConsoleFontSize is setFontSize', () => {
    it('sets main by name', () => {
      expect(all('setMiniConsoleFontSize("main", 13)')).toBe('true');
      expect(env.run('return getFontSize("main")')).toBe(13);
    });

    it('sets main with no name', () => {
      expect(all('setMiniConsoleFontSize(12)')).toBe('true');
      expect(env.run('return getFontSize()')).toBe(12);
    });

    it("is not redirected by a script's own setFontSize", () => {
      env.run('local real = setFontSize; setFontSize = function() return "hijacked" end; '
        + 'R = setMiniConsoleFontSize("main", 14); setFontSize = real');
      expect(env.run('return R')).toBe(true);
      expect(env.run('return getFontSize("main")')).toBe(14);
    });

    it('reports an unknown window as setFontSize does', () => {
      expect(all('setMiniConsoleFontSize("nope", 12)')).toBe('nil | window "nope" not found');
    });
  });

  describe('user windows', () => {
    it('setUserWindowTitle with no title goes back to "User window - <profile> - <name>"', () => {
      env.session.windows.profileName = 'Prof';
      env.run('openUserWindow("tw"); setUserWindowTitle("tw", "x")');
      env.run('setUserWindowTitle("tw")');
      expect(env.run('return (getUserWindowTitle("tw"))')).toBe('User window - Prof - tw');
      env.run('setUserWindowTitle("tw", "x"); resetUserWindowTitle("tw")');
      expect(env.run('return (getUserWindowTitle("tw"))')).toBe('User window - Prof - tw');
    });

    it('echoUserWindow returns nothing', () => {
      env.run('openUserWindow("tw")');
      expect(env.run('return select("#", echoUserWindow("tw", "x\\n"))')).toBe(0);
      expect(env.run('return (getCurrentLine("tw"))')).toBe('x');
    });
  });
});
