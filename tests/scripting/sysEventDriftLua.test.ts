// @vitest-environment node

// System events checked against desktop Mudlet PTB side by side
// (Mudlet/mudlet-web#260), Lua side: sysFontChangeEvent from consoles other
// than main, and sysTextEditDeleted. The engine-level half is
// sysEventDrift.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';

describe('Lua system events match desktop (#260)', () => {
  let env: TestRuntime;
  beforeEach(async () => {
    env = await createTestRuntime();
    env.session.windows.setConnectionId(TEST_CONNECTION_ID);
    env.session.windows.onRaiseEvent = (event, args) => env.rt.emitEvent(event, args);
    env.api.setHost({ ...env.api.engineHost, raiseEvent: (event: string, args: unknown[]) => env.rt.emitEvent(event, args) });
    env.run(`R = {}
      for _, ev in ipairs({"sysFontChangeEvent", "sysTextEditDeleted"}) do
        registerAnonymousEventHandler(ev, function(e, ...)
          local parts = {e}
          for i = 1, select("#", ...) do parts[#parts + 1] = type((select(i, ...))) .. ":" .. tostring((select(i, ...))) end
          R[#R + 1] = table.concat(parts, " ")
        end)
      end`);
  });
  afterEach(() => env.dispose());

  const events = () => env.run('return table.concat(R, "|")') as string;

  describe('sysFontChangeEvent', () => {
    it('is raised when a miniconsole is created, not when it is repositioned', () => {
      env.run('createMiniConsole("MC1", 0, 0, 200, 100)');
      const family = env.run('return getFont("MC1")');
      expect(events()).toBe(`sysFontChangeEvent string:MC1 string:${family} number:12`);
      env.run('R = {}; createMiniConsole("MC1", 10, 10, 200, 100)');
      expect(events()).toBe('');
    });

    it('is raised by setFontSize and setFont on a miniconsole, only when the font changes', () => {
      env.run('createMiniConsole("MC1", 0, 0, 200, 100); R = {}');
      env.run('setFontSize("MC1", 15)');
      env.run('setFontSize("MC1", 15)');
      env.run('setMiniConsoleFontSize("MC1", 16)');
      env.run('setFont("MC1", "Courier New")');
      env.run('setFont("MC1", "Courier New")');
      expect(events().split('|')).toEqual([
        `sysFontChangeEvent string:MC1 string:${env.run('return getFont()')} number:15`,
        `sysFontChangeEvent string:MC1 string:${env.run('return getFont()')} number:16`,
        'sysFontChangeEvent string:MC1 string:Courier New number:16',
      ]);
    });

    it('is raised when a user window is created', () => {
      env.run('openUserWindow("UW1", false, false, "f")');
      expect(events()).toMatch(/^sysFontChangeEvent string:UW1 string:.+ number:\d+$/);
      env.run('R = {}; openUserWindow("UW1", false, false, "f")');
      expect(events()).toBe('');
    });

    it('is not raised for a label', () => {
      env.run('createLabel("L1", 0, 0, 10, 10, 1); setFont("L1", "Courier New")');
      expect(events()).toBe('');
    });
  });

  it('deleteTextEdit raises sysTextEditDeleted(name)', () => {
    env.run('createTextEdit("TE1", 0, 0, 100, 50)');
    expect(env.run('return deleteTextEdit("TE1")')).toBe(true);
    expect(events()).toBe('sysTextEditDeleted string:TE1');
    env.run('R = {}; deleteTextEdit("TE1")');
    expect(events()).toBe('');
  });
});
