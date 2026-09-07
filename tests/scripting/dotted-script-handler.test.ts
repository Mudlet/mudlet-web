// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * Regression: a Mudlet script whose *name* is a dotted path never fired its
 * event handlers.
 *
 * Mudlet resolves the handler function by evaluating the script name as a Lua
 * expression (`TLuaInterpreter::callEventHandler` runs `return <name>`), so a
 * script named `mmp.centerRoominfo` that defines `function mmp.centerRoominfo()`
 * works. wrapScript used a flat `_G[name]` lookup, which is nil for any dotted
 * name — and the wrapper's `if type(fn) == 'function'` guard swallowed it, so
 * the handler silently never ran.
 *
 * That killed real functionality: mudlet-mapper's follow-the-player handler is a
 * script named `mmp.centerRoominfo` bound to `gmcp.Room`, the only thing that
 * calls `centerview()` on movement. The package installed and reported itself
 * loaded while the map simply never tracked the player.
 */
describe('event handlers on dotted script names', () => {
  let t: TestRuntime;

  beforeEach(async () => { t = await createTestRuntime(); });
  afterEach(() => { t.dispose(); });

  describe('__mudlet_resolve_handler', () => {
    it('walks a dotted name to the function', () => {
      t.run(`mmp = { deep = {} }
             function mmp.handler() end
             function mmp.deep.nested() end
             function plain() end`);
      expect(t.run(`return type(__mudlet_resolve_handler('mmp.handler'))`)).toBe('function');
      expect(t.run(`return type(__mudlet_resolve_handler('mmp.deep.nested'))`)).toBe('function');
      // The undotted case has to keep working — most scripts use it.
      expect(t.run(`return type(__mudlet_resolve_handler('plain'))`)).toBe('function');
    });

    it('returns nil rather than erroring on names that do not resolve', () => {
      // A missing/mistyped handler name must no-op like Mudlet, not throw.
      // Lua nil arrives as null across the wasmoon boundary.
      t.run(`mmp = { notafunction = 42 }`);
      expect(t.run(`return __mudlet_resolve_handler('mmp.missing')`)).toBeNull();
      expect(t.run(`return __mudlet_resolve_handler('nosuchtable.field')`)).toBeNull();
      expect(t.run(`return __mudlet_resolve_handler('mmp.notafunction')`)).toBeNull();
      // Indexing *through* a non-table must not error either.
      expect(t.run(`return __mudlet_resolve_handler('mmp.notafunction.deeper')`)).toBeNull();
      expect(t.run(`return __mudlet_resolve_handler('')`)).toBeNull();
    });

    it('resolves late, so re-saving a script swaps the function', () => {
      // wrapScript resolves per dispatch rather than capturing a reference.
      t.run(`mmp = {}; function mmp.handler() return 'first' end`);
      expect(t.run(`return __mudlet_resolve_handler('mmp.handler')()`)).toBe('first');
      t.run(`function mmp.handler() return 'second' end`);
      expect(t.run(`return __mudlet_resolve_handler('mmp.handler')()`)).toBe('second');
    });
  });

  it('fires a dotted-name handler on raiseEvent, with the event args', () => {
    // Exactly the shape ScriptingEngine.wrapScript emits for a script named
    // "mmp.centerRoominfo" with eventHandlers ["gmcp.Room"], and the argument
    // list Mudlet's raiseEvent passes (eventName, then the event's own args).
    t.run(`
      mmp = {}
      seen = {}
      function mmp.centerRoominfo(...)
        seen = { ... }
      end
      registerAnonymousEventHandler('gmcp.Room', function(...)
        local __fn = __mudlet_resolve_handler('mmp.centerRoominfo')
        if __fn then return __fn(...) end
      end)
      raiseEvent('gmcp.Room', 'gmcp.Room', 'gmcp.Room.Info')
    `);
    // Mudlet passes the event name first, then the event's own args — and for
    // GMCP those args are (token, fullKey), so the name appears twice.
    expect(t.run(`return #seen`)).toBe(3);
    expect(t.run(`return seen[1]`)).toBe('gmcp.Room');
    expect(t.run(`return seen[2]`)).toBe('gmcp.Room');
    expect(t.run(`return seen[3]`)).toBe('gmcp.Room.Info');
  });

  it('drives centerview through the mapper-shaped handler chain', () => {
    // The end-to-end path that was dead: a gmcp.Room event reaching a dotted
    // handler that reads gmcp.Room.Info.num and calls centerview.
    t.run(`
      addRoom(7)
      gmcp = gmcp or {}
      gmcp.Room = { Info = { num = 7 } }
      mmp = {}
      function mmp.centerRoominfo()
        if gmcp.Room.Info and gmcp.Room.Info.num then centerview(gmcp.Room.Info.num) end
      end
      registerAnonymousEventHandler('gmcp.Room', function(...)
        local __fn = __mudlet_resolve_handler('mmp.centerRoominfo')
        if __fn then return __fn(...) end
      end)
      raiseEvent('gmcp.Room', 'gmcp.Room', 'gmcp.Room.Info')
    `);
    // centerview sets the player room (Mudlet parity), so this proves the whole
    // chain ran, not just that the handler was reached.
    expect(t.run(`return getPlayerRoom()`)).toBe(7);
  });
});
