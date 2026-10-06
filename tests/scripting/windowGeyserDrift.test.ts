// @vitest-environment node

// Window/Geyser behaviour checked against desktop Mudlet PTB side by side
// (Mudlet/mudlet-web#236): the sysWindowResizeEvent arguments, which consoles
// raise sysUserWindowResizeEvent, the miniconsole user cursor, a new
// miniconsole's font size, and a label's stylesheet after setBackgroundColor.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';

/** A stand-in for the `.main-viewport` element: only its box is ever read. */
function fakeViewport(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }),
    style: {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLElement;
}

describe('Window/Geyser parity with Mudlet (#236)', () => {
  let env: TestRuntime;
  beforeEach(async () => {
    env = await createTestRuntime();
    env.session.windows.setConnectionId(TEST_CONNECTION_ID);
    useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { outputBorders: undefined });
    // What ScriptingEngine wires up: WindowManager's events reach Lua.
    env.session.windows.onRaiseEvent = (event, args) => env.rt.emitEvent(event, args);
    env.api.setHost({ ...env.api.engineHost, raiseEvent: (event: string, args: unknown[]) => env.rt.emitEvent(event, args) });
    env.run('R = {}');
  });
  afterEach(() => {
    useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { outputBorders: undefined });
    env.dispose();
  });

  describe('sysWindowResizeEvent', () => {
    beforeEach(() => {
      env.run(`registerAnonymousEventHandler("sysWindowResizeEvent", function(_, w, h, name)
        R[#R + 1] = w .. "x" .. h .. ":" .. tostring(name)
      end)`);
    });

    it('passes the console name "main" as its fourth argument', () => {
      env.session.windows.registerMainViewport(fakeViewport(1600, 900));
      env.session.windows.primeMainResize();
      expect(env.run('return table.concat(R, ",")')).toBe('1600x900:main');
    });

    it('reports the console area inside the borders after a border change', () => {
      env.session.windows.registerMainViewport(fakeViewport(1600, 900));
      env.run('setBorderLeft(100)');
      env.run('setBorderBottom(40)');
      expect(env.run('return R[#R]')).toBe('1500x860:main');
    });

    it('reports the inset size on a real resize too, while getMainWindowSize keeps the whole viewport', () => {
      env.run('setBorderTop(10); setBorderRight(20)');
      env.run('R = {}');
      env.session.windows.registerMainViewport(fakeViewport(800, 600));
      env.session.windows.primeMainResize();
      expect(env.run('return table.concat(R, ",")')).toBe('780x590:main');
      expect(env.run('local w, h = getMainWindowSize(); return w .. "x" .. h')).toBe('800x600');
    });

    it('does not let a script-raised resize poison the getMainWindowSize cache', () => {
      env.session.windows.registerMainViewport(fakeViewport(640, 480));
      env.run('raiseEvent("sysWindowResizeEvent", 1, 2, "main")');
      expect(env.run('local w, h = getMainWindowSize(); return w .. "x" .. h')).toBe('640x480');
    });
  });

  describe('sysUserWindowResizeEvent', () => {
    beforeEach(() => {
      env.run(`registerAnonymousEventHandler("sysUserWindowResizeEvent", function(_, w, h, name)
        R[#R + 1] = name
      end)`);
    });

    it('is not raised for a miniconsole', () => {
      env.run('createMiniConsole("mm", 0, 0, 300, 100)');
      env.session.windows.announceCreatedSize('mm');
      env.session.windows.pumpCreatedSizes();
      expect(env.run('return #R')).toBe(0);
    });

    it('is still raised for a user window', () => {
      env.run('openUserWindow("uw")');
      env.session.windows.pumpCreatedSizes();
      expect(env.run('return table.concat(R, ",")')).toBe('uw');
    });
  });

  describe('miniconsole user cursor', () => {
    it('stays on line 0 however much is echoed, as Mudlet\'s does', () => {
      env.run('createMiniConsole("mm", 0, 0, 300, 100); echo("mm", "abc\\n"); echo("mm", "def")');
      expect(env.run('return getLineNumber("mm")')).toBe(0);
      expect(env.run('return getCurrentLine("mm")')).toBe('abc');
    });

    it('reports line 0 on a fresh miniconsole', () => {
      env.run('createMiniConsole("fresh", 0, 0, 300, 100)');
      expect(env.run('return getLineNumber("fresh")')).toBe(0);
    });

    it('selects on line 0 until the script moves the cursor', () => {
      env.run('createMiniConsole("mini", 0, 0, 300, 300); echo("mini", "alpha one\\n"); echo("mini", "beta two\\n")');
      expect(env.run('return getLineNumber("mini")')).toBe(0);
      expect(env.run('return selectString("mini", "two", 1)')).toBe(-1);
      expect(env.run('return selectString("mini", "one", 1)')).toBe(6);
      env.run('moveCursor("mini", 0, 1)');
      expect(env.run('return selectString("mini", "two", 1)')).toBe(5);
      expect(env.run('return getCurrentLine("mini")')).toBe('beta two');
    });

    it('moveCursorEnd still parks it on the open last line', () => {
      env.run('createMiniConsole("mm", 0, 0, 300, 100); echo("mm", "abc\\ndef\\n"); moveCursorEnd("mm")');
      expect(env.run('return getLineNumber("mm")')).toBe(2);
      expect(env.run('return getLineNumber("mm") == getLastLineNumber("mm")')).toBe(true);
    });

    // TConsole::clear empties the buffer and leaves mUserCursor alone
    // (ConsoleClearByName_spec), so the cursor is still on line 1 after it.
    it('stays on its line through clearWindow', () => {
      env.run('createMiniConsole("mm", 0, 0, 300, 100); echo("mm", "abc\\ndef\\n"); moveCursor("mm", 0, 1)');
      expect(env.run('return getCurrentLine("mm")')).toBe('def');
      env.run('clearWindow("mm")');
      expect(env.run('return getLineNumber("mm")')).toBe(1);
      env.run('echo("mm", "x\\ny\\n")');
      expect(env.run('return getLineNumber("mm")')).toBe(1);
      expect(env.run('return getCurrentLine("mm")')).toBe('y');
    });

    it('takes a negative column, as Mudlet does, and paste then leaves the line alone', () => {
      env.run('createMiniConsole("src", 0, 0, 300, 100); echo("src", "beta\\n"); selectCurrentLine("src"); copy("src")');
      env.run('createMiniConsole("dst", 0, 0, 300, 100); echo("dst", "xxxxx\\nyyy\\n")');
      expect(env.run('return moveCursor("dst", -1, 0)')).toBe(true);
      expect(env.run('return getColumnNumber("dst")')).toBe(0);
      env.run('paste("dst")');
      expect(env.run('return table.concat(getLines("dst", 0, 3), "|")')).toBe('xxxxx|yyy|');
    });

    it('leaves the main console following its output', () => {
      env.run('echo("first\\n"); echo("second\\n")');
      expect(env.run('return getCurrentLine()')).toBe('second');
    });
  });

  describe('createMiniConsole font size', () => {
    it('defaults to 12, not the profile size', () => {
      useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { fontSize: 11 });
      env.run('createMiniConsole("mm", 0, 0, 300, 100)');
      expect(env.run('return getFontSize("mm")')).toBe(12);
    });

    it('keeps a size the script set when the miniconsole is re-created', () => {
      env.run('createMiniConsole("mm", 0, 0, 300, 100); setFontSize("mm", 9)');
      env.run('createMiniConsole("mm", 10, 10, 300, 100)');
      expect(env.run('return getFontSize("mm")')).toBe(9);
    });
  });

  describe('getLabelStyleSheet', () => {
    it('reads back the background-color a new label starts with', () => {
      env.run('createLabel("A0", 0, 0, 100, 100, 0)');
      expect(env.run('return getLabelStyleSheet("A0")')).toBe('background-color: rgba(32, 32, 32, 255);');
    });

    it('reads back setBackgroundColor', () => {
      env.run('createLabel("A", 0, 0, 100, 100, 1); setBackgroundColor("A", 255, 0, 0, 100)');
      expect(env.run('return getLabelStyleSheet("A")')).toBe('background-color: rgba(255, 0, 0, 100);');
    });

    it('patches the declaration in a sheet the script set, and appends to one without', () => {
      env.run('createLabel("B", 0, 0, 100, 100, 1)');
      env.run('setLabelStyleSheet("B", "border: 1px solid red; background-color: blue;")');
      env.run('setBackgroundColor("B", 1, 2, 3, 4)');
      expect(env.run('return getLabelStyleSheet("B")')).toBe('border: 1px solid red; background-color: rgba(1, 2, 3, 4);');
      env.run('setLabelStyleSheet("B", "border: 0;")');
      env.run('setBackgroundColor("B", 5, 6, 7, 8)');
      expect(env.run('return getLabelStyleSheet("B")')).toBe('border: 0;\nbackground-color: rgba(5, 6, 7, 8);');
    });

    it('covers Geyser Label:setColor', () => {
      env.run('local l = Geyser.Label:new({name = "G236", x = 0, y = 0, width = 50, height = 50}); l:setColor(0, 128, 0, 200)');
      expect(env.run('return getLabelStyleSheet("G236")')).toBe('background-color: rgba(0, 128, 0, 200);');
    });
  });
});
