// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Issue #282 item 1. Host::raiseEvent runs every script's event-handler-list
// handler first, in the order the scripts were registered (tree order), then
// the scripts listing "*", and only then the registerAnonymousEventHandler
// functions. Mudlet Web used to register a script's list as anonymous handlers
// right after its body ran, so the two kinds interleaved by registration order.
describe('script event-handler lists run before anonymous handlers', () => {
  let t: TestRuntime;

  beforeEach(async () => { t = await createTestRuntime(); });
  afterEach(() => t.dispose());

  const sync = (...entries: { id: string; name: string; active?: boolean; events: string[] }[]) =>
    t.rt.syncScriptHandlers(entries.map(e => ({ active: true, ...e })));

  const order = () => t.run(`return table.concat(order, ',')`);

  it('runs script handlers in tree order, then anonymous ones', () => {
    // The issue's shape: A both lists evX and registers an anonymous handler,
    // D and G register anonymous ones, and the anonymous registrations happen
    // in between the scripts' — desktop still runs all scripts first.
    t.run(`
      order = {}
      function A() order[#order + 1] = 'A script' end
      function F() order[#order + 1] = 'F' end
      function B() order[#order + 1] = 'B' end
      function D() order[#order + 1] = 'D script' end
      function H() order[#order + 1] = 'H script' end
      registerAnonymousEventHandler('evX', function() order[#order + 1] = 'A anon' end)
      registerAnonymousEventHandler('evX', function() order[#order + 1] = 'D anon' end)
      registerAnonymousEventHandler('evX', function() order[#order + 1] = 'G anon' end)
    `);
    sync(
      { id: 'a', name: 'A', events: ['evX'] },
      { id: 'f', name: 'F', events: ['evX'] },
      { id: 'b', name: 'B', events: ['evX'] },
      { id: 'd', name: 'D', events: ['evX'] },
      { id: 'h', name: 'H', events: ['evX'] },
    );
    t.run(`raiseEvent('evX')`);
    expect(order()).toBe('A script,F,B,D script,H script,A anon,D anon,G anon');
  });

  it('runs "*" script handlers after the named ones and before anonymous handlers', () => {
    t.run(`
      order = {}
      function Star(e) order[#order + 1] = 'star:' .. e end
      function Named(e) order[#order + 1] = 'named:' .. e end
      registerAnonymousEventHandler('evS', function(e) order[#order + 1] = 'anon:' .. e end)
    `);
    sync({ id: 's', name: 'Star', events: ['*'] }, { id: 'n', name: 'Named', events: ['evS'] });
    t.run(`raiseEvent('evS')`);
    expect(order()).toBe('named:evS,star:evS,anon:evS');
  });

  it('passes the event name first, then the arguments', () => {
    t.run(`function Args(...) got = {...} end`);
    sync({ id: 'x', name: 'Args', events: ['evA'] });
    t.run(`raiseEvent('evA', 1, 'two')`);
    expect(t.run(`return table.concat(got, ',')`)).toBe('evA,1,two');
  });

  it('keeps an inactive script registered but does not call it', () => {
    t.run(`order = {}
           function P() order[#order + 1] = 'P' end
           function Q() order[#order + 1] = 'Q' end`);
    sync({ id: 'p', name: 'P', events: ['evI'] }, { id: 'q', name: 'Q', events: ['evI'] });
    sync({ id: 'p', name: 'P', active: false, events: ['evI'] });
    t.run(`raiseEvent('evI')`);
    expect(order()).toBe('Q');
    // Switched back on, it keeps its place ahead of Q.
    sync({ id: 'p', name: 'P', active: true, events: ['evI'] });
    t.run(`order = {} raiseEvent('evI')`);
    expect(order()).toBe('P,Q');
  });

  it('moves a script to the end when its list changes, and drops it with an empty one', () => {
    t.run(`order = {}
           function P() order[#order + 1] = 'P' end
           function Q() order[#order + 1] = 'Q' end`);
    sync({ id: 'p', name: 'P', events: ['evM'] }, { id: 'q', name: 'Q', events: ['evM'] });
    sync({ id: 'p', name: 'P', events: ['evM', 'evOther'] });
    t.run(`raiseEvent('evM')`);
    expect(order()).toBe('Q,P');
    sync({ id: 'p', name: 'P', events: [] });
    t.run(`order = {} raiseEvent('evM') raiseEvent('evOther')`);
    expect(order()).toBe('Q');
  });

  it('a script registered while the event dispatches waits for the next raise', () => {
    // Host::raiseEvent copies the script list before calling into it.
    t.run(`order = {}
           function Late() order[#order + 1] = 'Late' end
           function Early() order[#order + 1] = 'Early'; __mudlet_sync_script_handlers('l\\2Late\\0021\\2evL') end`);
    sync({ id: 'e', name: 'Early', events: ['evL'] });
    t.run(`raiseEvent('evL')`);
    expect(order()).toBe('Early');
    t.run(`order = {} raiseEvent('evL')`);
    expect(order()).toBe('Early,Late');
  });
});
