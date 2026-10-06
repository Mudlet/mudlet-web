// @vitest-environment node
//
// mudlet-web#330 — Lua error handling measured against the Mudlet desktop PTB:
//   1. a handler's non-string error is reported and raiseEvent carries on;
//   2. an error object whose __tostring raises is reported, not a Lua panic;
//   3. a debug hook set in one callback is still set in the next;
//   4. a temp trigger or key whose code string won't compile is not active;
//   5. sendGMCP refuses before the server has offered GMCP.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { TriggerEngine } from '../../src/mud/triggers/TriggerEngine';

describe('Lua error handling matches desktop (#330)', () => {
  let t: TestRuntime;
  let errors: string[];
  let off: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TriggerEngine.ready();
    t = await createTestRuntime();
    errors = [];
    off = t.session.events.on('script.log', (text: string, level: string) => {
      if (level === 'error') errors.push(text);
    });
    t.run(`R = {} function rec(s) R[#R + 1] = tostring(s) end`);
  });

  afterEach(() => {
    off();
    t.dispose();
    vi.useRealTimers();
  });

  const record = () => t.run(`return table.concat(R, '|')`);
  const feed = (...lines: string[]) => {
    for (const raw of lines) {
      const buffer = new AnsiAwareBuffer(raw);
      t.api.beginLine(buffer);
      t.api.triggers.processTemp(buffer.text);
      t.api.endLine();
    }
  };
  const engineStopped = () => errors.some(e => e.includes('the Lua engine stopped'));

  describe('1. non-string errors in event handlers', () => {
    it.each([
      ['a table', '{code = 1}'],
      ['nil', 'nil'],
      ['false', 'false'],
      ['a function', 'print'],
      ['a table with __tostring', 'setmetatable({}, {__tostring = function() return "boom" end})'],
    ])('an anonymous handler erroring with %s does not escape raiseEvent', (_what, value) => {
      t.run(`
        registerAnonymousEventHandler("errEv", function() rec("h1") end)
        registerAnonymousEventHandler("errEv", function() error(${value}) end)`);
      t.run(`rec("pcall " .. tostring((pcall(raiseEvent, "errEv"))))`);
      t.run(`raiseEvent("errEv") rec("raise returned")`);
      expect(record()).toBe('h1|pcall true|h1|raise returned');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('an erroring script handler does not stop the next script handler or the caller', () => {
      t.run(`
        function Perm1() rec("perm h1") error({}) end
        function Perm2() rec("perm h2") end`);
      t.rt.syncScriptHandlers([
        { id: 'p1', name: 'Perm1', active: true, events: ['errEv'] },
        { id: 'p2', name: 'Perm2', active: true, events: ['errEv'] },
      ]);
      t.run(`rec("pcall raise " .. tostring((pcall(raiseEvent, "errEv"))))`);
      t.run(`raiseEvent("errEv") rec("perm raise returned")`);
      expect(record()).toBe('perm h1|perm h2|pcall raise true|perm h1|perm h2|perm raise returned');
      expect(errors.length).toBe(2);
    });

    it('covers events the client raises itself', () => {
      t.run(`
        function Conn1() rec("conn1") error({}) end
        function Conn2() rec("conn2") end
        function Load1() rec("load1") error({}) end
        function Load2() rec("load2") end`);
      t.rt.syncScriptHandlers([
        { id: 'c1', name: 'Conn1', active: true, events: ['sysConnectionEvent'] },
        { id: 'c2', name: 'Conn2', active: true, events: ['sysConnectionEvent'] },
        { id: 'l1', name: 'Load1', active: true, events: ['sysLoadEvent'] },
        { id: 'l2', name: 'Load2', active: true, events: ['sysLoadEvent'] },
      ]);
      t.rt.emitEvent('sysConnectionEvent', []);
      t.rt.emitEvent('sysLoadEvent', []);
      expect(record()).toBe('conn1|conn2|load1|load2');
    });

    it('a string error still reports and carries on, as before', () => {
      t.run(`
        registerAnonymousEventHandler("strEv", function() error("plain") end)
        registerAnonymousEventHandler("strEv", function() rec("after") end)`);
      t.run(`raiseEvent("strEv") rec("returned")`);
      expect(record()).toBe('after|returned');
      expect(errors.some(e => e.includes('plain'))).toBe(true);
    });
  });

  describe('2. an error object whose __tostring raises', () => {
    const badError = 'error(setmetatable({}, {__tostring = function() error("inner") end}))';

    it('from a temp trigger: reported, and the next trigger on the line still fires', () => {
      t.run(`
        tempTrigger("X", function() ${badError} end)
        tempTrigger("X", function() rec("next trigger") end)`);
      feed('X marks the spot');
      expect(engineStopped()).toBe(false);
      expect(record()).toBe('next trigger');
      expect(errors.length).toBeGreaterThan(0);
      // Scripts keep working: a later trigger fires and plain Lua runs.
      feed('X again');
      expect(record()).toBe('next trigger|next trigger');
      expect(t.run('return 1 + 1')).toBe(2);
    });

    it('from a temp alias', () => {
      t.run(`tempAlias("^boom$", function() ${badError} end)`);
      t.api.aliases.processTemp('boom');
      expect(engineStopped()).toBe(false);
      expect(t.run('return 2 + 2')).toBe(4);
    });

    it('from tempTimer, as a function and as code', () => {
      t.run(`
        tempTimer(0.1, function() ${badError} end)
        tempTimer(0.2, [[${badError}]])
        tempTimer(0.3, function() rec("timer after") end)`);
      vi.advanceTimersByTime(500);
      expect(engineStopped()).toBe(false);
      expect(record()).toBe('timer after');
      expect(errors.length).toBe(2);
    });

    it('from an event handler', () => {
      t.run(`
        registerAnonymousEventHandler("tsEv", function() ${badError} end)
        raiseEvent("tsEv") rec("raised")`);
      expect(engineStopped()).toBe(false);
      expect(record()).toBe('raised');
    });
  });

  describe('3. debug hooks', () => {
    it('a hook set in one callback is seen, and counts calls, in the next', () => {
      t.run(`calls = 0
        tempTimer(0.1, function() debug.sethook(function() calls = calls + 1 end, "c") end)
        tempTimer(0.2, function()
          local before = calls
          rec(tostring(debug.gethook() ~= nil))
          string.len("x")
          rec(tostring(calls > before))
        end)`);
      vi.advanceTimersByTime(300);
      expect(record()).toBe('true|true');
    });

    it('a trigger sees a hook a script body set, and clearing it holds too', () => {
      t.rt.load(`debug.sethook(function() end, "c")`, 'prof-start');
      t.run(`tempTrigger("P", function() rec(tostring(debug.gethook() ~= nil)) end)`);
      feed('P1');
      t.rt.load(`debug.sethook()`, 'prof-stop');
      feed('P2');
      expect(record()).toBe('true|false');
      expect(t.run(`return debug.gethook() == nil`)).toBe(true);
    });

    it('gethook reports the function, mask and count it was given', () => {
      t.rt.load(`hookFn = function() end; debug.sethook(hookFn, "cr", 0)`, 'set');
      t.run(`tempTimer(0.1, function() local f, m, c = debug.gethook(); rec(tostring(f == hookFn) .. " " .. m .. " " .. c) end)`);
      vi.advanceTimersByTime(200);
      t.rt.load(`debug.sethook()`, 'clear');
      expect(record()).toBe('true cr 0');
    });

    it("a script's own coroutine keeps a hook of its own", () => {
      t.rt.load(`
        co = coroutine.create(function() coroutine.yield() end)
        debug.sethook(co, function() end, "c")
        rec(tostring(debug.gethook(co) ~= nil))
        rec(tostring(debug.gethook() == nil))`, 'own-co');
      expect(record()).toBe('true|true');
    });
  });

  // ScriptingEngine.isActive(id, "trigger"/"keybind") answers from these two —
  // the runtime's temp registry and the key engine — and this runtime has no
  // engine wired, so they are asked directly.
  describe('4. temp items whose code string does not compile', () => {
    it.each([
      ['tempTrigger', 'tempTrigger("X", "x = = 1")'],
      ['tempRegexTrigger', 'tempRegexTrigger("X", "x = = 1")'],
      ['tempBeginOfLineTrigger', 'tempBeginOfLineTrigger("X", "x = = 1")'],
      ['tempExactMatchTrigger', 'tempExactMatchTrigger("X", "x = = 1")'],
      ['tempLineTrigger', 'tempLineTrigger(1, 1, "x = = 1")'],
      ['tempPromptTrigger', 'tempPromptTrigger("x = = 1")'],
    ])('%s is made but not active', (_fn, call) => {
      const id = t.run(`return ${call}`) as number;
      expect(typeof id).toBe('number');
      expect(t.rt.tempItemExists(id, 'trigger')).toBe(true);
      expect(t.rt.tempItemEnabled(id)).toBe(false);
      // Switching it on doesn't make it active, or run, either.
      t.run(`enableTrigger(${id})`);
      expect(t.rt.tempItemEnabled(id)).toBe(false);
      feed('X');
      expect(errors).toEqual([]);
      expect(t.run(`return killTrigger(${id})`)).toBe(true);
    });

    it.each([
      // tempColorTrigger's legacy scale has red at 4; ANSI's at 1.
      ['tempColorTrigger', 'tempColorTrigger(4, -1, "x = = 1")'],
      ['tempAnsiColorTrigger', 'tempAnsiColorTrigger(1, -1, "x = = 1")'],
    ])('%s is made but not active, and does not fire on a line of its colour (#371)', (_fn, call) => {
      const id = t.run(`return ${call}`) as number;
      expect(typeof id).toBe('number');
      expect(t.rt.tempItemExists(id, 'trigger')).toBe(true);
      expect(t.rt.tempItemEnabled(id)).toBe(false);
      t.run(`enableTrigger(${id})`);
      expect(t.rt.tempItemEnabled(id)).toBe(false);
      // A compiling one on the same colour proves the line is one it matches.
      const good = t.run(`return tempAnsiColorTrigger(1, -1, "rec('colour')")`) as number;
      expect(t.rt.tempItemEnabled(good)).toBe(true);
      feed('\x1b[31mX\x1b[0m');
      expect(record()).toBe('colour');
      expect(errors).toEqual([]);
    });

    it('tempComplexRegexTrigger tells the engine its body did not compile (#371)', () => {
      t.run(`
        GOT = {}
        __mudlet_tempComplexTrigger = function(...)
          GOT[#GOT + 1] = tostring(select(11, ...))
          return 7
        end`);
      expect(t.run(`return tempComplexRegexTrigger("c1", "^X", "x = = 1", 0, 0, 0, 0, 0, "red", "", "", 0, 0)`)).toBe(7);
      expect(t.run(`return tempComplexRegexTrigger("c2", "^X", "rec('ok')", 0, 0, 0, 0, 0, "red", "", "", 0, 0)`)).toBe(7);
      expect(t.run(`return tempComplexRegexTrigger("c3", "^X", function() end, 0, 0, 0, 0, 0, "", "", "", 0, 0)`)).toBe(7);
      expect(t.run(`return table.concat(GOT, '|')`)).toBe('true|false|false');
    });

    it('a compiling body is still active, and fires', () => {
      const id = t.run(`return tempTrigger("X", "rec('fired')")`) as number;
      expect(t.rt.tempItemEnabled(id)).toBe(true);
      feed('X');
      expect(record()).toBe('fired');
    });

    it('tempKey is made but not active, and does not fire', () => {
      const id = t.run(`return tempKey(0x41, "x = = 1")`) as number;
      expect(typeof id).toBe('number');
      expect(t.api.keys.hasTemp(id)).toBe(true);
      expect(t.api.keys.isTempEnabled(id)).toBe(false);
      const event = { code: 'KeyA', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as KeyboardEvent;
      expect(t.api.keys.processTemp(event)).toBe(false);
      const good = t.run(`return tempKey(0x41, "rec('key')")`) as number;
      expect(t.api.keys.isTempEnabled(good)).toBe(true);
      expect(t.api.keys.processTemp(event)).toBe(true);
      expect(record()).toBe('key');
    });
  });

  describe('5. sendGMCP before the server offers GMCP', () => {
    const connect = () => {
      const info = t.api.getConnectionInfo();
      vi.spyOn(t.api, 'getConnectionInfo').mockReturnValue({ ...info, connected: true });
    };

    it('is refused and sends nothing', () => {
      connect();
      const sent = vi.spyOn(t.api, 'sendGmcp').mockImplementation(() => {});
      t.run(`local ok, err = sendGMCP("Core.Ping") rec(tostring(ok)) rec(err)`);
      expect(record()).toBe('nil|sendGMCP: GMCP is not currently enabled');
      expect(sent).not.toHaveBeenCalled();
    });

    it('goes out once GMCP is negotiated', () => {
      connect();
      vi.spyOn(t.api, 'isGmcpEnabled').mockReturnValue(true);
      const sent = vi.spyOn(t.api, 'sendGmcp').mockImplementation(() => {});
      expect(t.run(`return sendGMCP("Core.Ping")`)).toBe(true);
      expect(sent.mock.calls).toEqual([['Core.Ping']]);
    });

    it('still says "not connected" first with no connection', () => {
      t.run(`local ok, err = sendGMCP("Core.Ping") rec(err)`);
      expect(record()).toContain('not connected to game server');
    });
  });
});
