// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

// Coverage for the Mudlet 4.21 parity additions: getBorderColor, the memory
// introspection pair, the warning-emitting no-op stubs for inapplicable APIs
// (Discord / IRC / spawn / spell-check), and the bundled pure-Lua lpeg (LuLPeg).
// permExactMatchTrigger's CRUD lives in ScriptingEngine (not wired into this
// harness), so here we only assert its Lua binding is callable without error.
describe('Mudlet 4.21 API additions', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  describe('getBorderColor', () => {
    it('returns the setBorderColor override', () => {
      const v = env.run(`setBorderColor(10, 20, 30)
        local r, g, b = getBorderColor()
        return r .. "," .. g .. "," .. b`);
      expect(v).toBe('10,20,30');
    });

    it('returns three numeric channels by default', () => {
      const n = env.run('return select("#", getBorderColor())');
      expect(n).toBe(3);
      expect(env.run('return type((getBorderColor()))')).toBe('number');
    });
  });

  describe('memory introspection', () => {
    it('getProcessMemoryUsage returns a number', () => {
      expect(typeof env.run('return getProcessMemoryUsage()')).toBe('number');
    });

    it('getSubsystemMemoryStats returns a table with the documented keys', () => {
      expect(env.run('return type(getSubsystemMemoryStats())')).toBe('table');
      // mapRooms is 0 on a fresh (empty) map; the key must still be present.
      expect(env.run('return getSubsystemMemoryStats().mapRooms')).toBe(0);
      // luaMemoryKb is folded in by the Bridge wrapper via collectgarbage.
      expect(env.run('return getSubsystemMemoryStats().luaMemoryKb > 0')).toBe(true);
    });
  });

  describe('no-op stubs for inapplicable APIs', () => {
    it('Discord getters are callable and return nil', () => {
      // Lua nil round-trips to JS as null through doStringSync.
      expect(env.run('return getDiscordDetail()')).toBeNull();
    });
    it('spawn validates its arguments, then reports the start failure', () => {
      // Not a stub any more: a browser tab has no subprocesses, so every call
      // fails — but it fails the way Mudlet's TForkedProcess does, because a
      // no-op returning false told the caller a process had started when none
      // had. Argument checking runs first and in Mudlet's order; the upstream
      // Spawn_spec pins the exact messages.
      expect(env.run('local ok, e = pcall(spawn, "ls") return e'))
        .toBe('Need read function and process name as parameters.');
      expect(env.run('local ok, e = pcall(spawn, "ls", "arg") return e'))
        .toBe('Need read function as first parameter.');
      expect(env.run('local ok, e = pcall(spawn, function() end, "ls") return e'))
        .toContain("Failed to start process 'ls'");
    });
    it('spellCheckWord treats every word as correct', () => {
      expect(env.run('return spellCheckWord("qwerty")')).toBe(true);
    });
    it('spellSuggestWord / getDictionaryWordList return empty tables', () => {
      expect(env.run('return #spellSuggestWord("qwerty")')).toBe(0);
      expect(env.run('return type(getDictionaryWordList())')).toBe('table');
    });
    it('IRC getters return the documented defaults', () => {
      expect(env.run('return type(getIrcChannels())')).toBe('table');
      expect(env.run('return getIrcNick()')).toBe('');
    });
  });

  describe('MMCP stubs', () => {
    it('mudlet.supports.mmcp is false', () => {
      expect(env.run('return mudlet.supports.mmcp')).toBe(false);
    });
    // No peer can ever connect in a browser, so mmcp reports an empty peer list
    // in Mudlet's shape — (nil, reason) — rather than a bare false. That is the
    // genuine state of the client list, and what scripts branch on.
    it('mmcp.* reports an empty peer list in Mudlet\'s shape', () => {
      expect(env.run('return type(mmcp)')).toBe('table');
      expect(env.run('local _, e = mmcp.chatAll("hi") return e')).toMatch(/no connected clients/);
      expect(env.run('local _, e = mmcp.getClientFlags("x") return e')).toMatch(/no connected clients/);
      expect(env.run('local _, e = mmcp.chatTo("nobody", "hi") return e'))
        .toMatch(/no client by that name or id/);
      expect(env.run('return mmcp.getClientList()')).toBeNull();
      expect(env.run('return mmcp.chatName()')).toBe('');
    });
  });

  describe('permExactMatchTrigger binding', () => {
    it('is callable and runs the flatten/split path', () => {
      // Creation fails because ScriptingEngine's CRUD callback isn't wired in
      // this harness, and Mudlet's perm* report that by raising. The raise
      // happens after Bridge.lua's flatten and the JS split, so this still
      // exercises the path it is here to cover.
      expect(() => env.run('return permExactMatchTrigger("t", "", {"exact"}, "")'))
        .toThrow(/permExactMatchTrigger: cannot create trigger/);
    });
  });

  describe('MXP FRAME/DEST consumer (ScriptingAPI)', () => {
    it('mxpFrame opens a mini-console and ACTION=close removes it', () => {
      env.api.mxpFrame('StatusBar', { NAME: 'StatusBar', WIDTH: '200', HEIGHT: '80', LEFT: '0', TOP: '0' });
      expect(env.session.windows.isMiniConsole('StatusBar')).toBe(true);
      env.api.mxpFrame('StatusBar', { NAME: 'StatusBar', ACTION: 'close' });
      expect(env.session.windows.isMiniConsole('StatusBar')).toBe(false);
    });

    it('mxpWriteToFrame: false for a missing frame, true once the frame exists', () => {
      expect(env.api.mxpWriteToFrame('Nope', new AnsiAwareBuffer('hi'), false)).toBe(false);
      env.api.mxpFrame('F', { NAME: 'F' });
      expect(env.api.mxpWriteToFrame('F', new AnsiAwareBuffer('hi'), false)).toBe(true);
      expect(env.api.mxpWriteToFrame('F', new AnsiAwareBuffer('clear-me'), true)).toBe(true); // eof clears
    });
  });

  describe('lpeg (LuLPeg)', () => {
    it('is published as a global', () => {
      expect(env.run('return type(lpeg)')).toBe('table');
    });
    it('matches a repetition pattern', () => {
      expect(env.run('return lpeg.match(lpeg.P("a")^1, "aaa")')).toBe(4); // position after match
    });
    it('supports captures and grammars', () => {
      const v = env.run(`local digit = lpeg.R("09")
        local ws = lpeg.S(" ")^0
        local list = lpeg.Ct((lpeg.C(digit^1) * ws)^0)
        local t = lpeg.match(list, "1 22 333")
        return t[1] .. "," .. t[2] .. "," .. t[3]`);
      expect(v).toBe('1,22,333');
    });
  });
});
