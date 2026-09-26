// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Issue #172: raiseEvent's extra arguments must reach handlers as the very
// values the caller passed. A table used to cross into JS as a wasmoon proxy
// and come back clobbered — raiseEvent("e", {a = 1}) delivered {a = nil}, and
// raiseEvent("e", {a = 1}, "s") delivered ("s", "s").
describe('raiseEvent — argument fidelity', () => {
  let t: TestRuntime;
  let errors: string[];
  let off: () => void;

  beforeEach(async () => {
    t = await createTestRuntime();
    errors = [];
    off = t.session.events.on('script.log', (text: string, level: string) => {
      if (level === 'error') errors.push(text);
    });
    t.run(`
      function describeArgs(...)
        local n = select('#', ...)
        local out = {}
        for i = 1, n do
          local v = select(i, ...)
          out[#out + 1] = type(v) == 'table' and ('{a=' .. tostring(v.a) .. '}') or tostring(v)
        end
        return n .. ':' .. table.concat(out, '|')
      end
      got = {}
      registerAnonymousEventHandler('evtT', function(...) got[#got + 1] = describeArgs(...) end)
    `);
  });

  afterEach(() => {
    off();
    t.dispose();
  });

  it('passes a table as the only extra argument', () => {
    t.run(`raiseEvent('evtT', {a = 1})`);
    expect(t.run('return got[1]')).toBe('2:evtT|{a=1}');
  });

  it('passes a table followed by a string', () => {
    t.run(`raiseEvent('evtT', {a = 1}, 's')`);
    expect(t.run('return got[1]')).toBe('3:evtT|{a=1}|s');
  });

  it('passes the same table (identity), not a copy', () => {
    t.run(`
      local payload = {a = 1}
      registerAnonymousEventHandler('evtIdentity', function(_, p) p.a = 2 end)
      raiseEvent('evtIdentity', payload)
      identityA = payload.a
    `);
    expect(t.run('return identityA')).toBe(2);
  });

  it('keeps nil and false in position', () => {
    t.run(`raiseEvent('evtT', nil, false, 'y')`);
    expect(t.run('return got[1]')).toBe('4:evtT|nil|false|y');
  });

  it('reaches a handler registered by name string too', () => {
    t.run(`
      function namedHandler(event, p) namedSaw = event .. ':' .. tostring(p.a) end
      registerAnonymousEventHandler('evtNamed', 'namedHandler')
      raiseEvent('evtNamed', {a = 7})
    `);
    expect(t.run('return namedSaw')).toBe('evtNamed:7');
  });

  it('returns false for a missing event name, true otherwise', () => {
    expect(t.run(`return raiseEvent()`)).toBe(false);
    expect(t.run(`return raiseEvent('evtNobody')`)).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

// Issue #172: Mudlet names a temp timer by the id tempTimer returned, so
// enableTimer / disableTimer reach it — before, only permanent timer names did.
describe('enableTimer / disableTimer on a temp timer id', () => {
  let t: TestRuntime;

  beforeEach(async () => { t = await createTestRuntime(); });
  afterEach(() => t.dispose());

  it('disables and re-enables a repeating temp timer', () => {
    t.run(`tid = tempTimer(0.1, function() end, true)`);
    const id = t.run('return tid') as number;
    expect(t.run('return disableTimer(tid)')).toBe(true);
    expect(t.api.timers.tempIsActive(id)).toBe(false);
    expect(t.run('return enableTimer(tid)')).toBe(true);
    expect(t.api.timers.tempIsActive(id)).toBe(true);
    // The string form of the id names the same timer.
    expect(t.run('return disableTimer(tostring(tid))')).toBe(true);
    expect(t.api.timers.tempIsActive(id)).toBe(false);
    t.run('killTimer(tid)');
  });

  it('answers false for an id that names no timer', () => {
    expect(t.run('return disableTimer(987654)')).toBe(false);
    expect(t.run('return enableTimer(987654)')).toBe(false);
  });
});
