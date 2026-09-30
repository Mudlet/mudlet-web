// @vitest-environment node
//
// mudlet-web#257. Desktop Mudlet runs every script entry point — timers,
// triggers, aliases, event handlers, script bodies — on the main Lua state, so
// coroutine.running() is nil there and a stray coroutine.yield() errors. Mudlet
// Web runs each on a thread of its own (so invokeFileDialog can suspend it) and
// raiseEvent handlers on a private coroutine; neither may be visible to scripts.
// Also: a one-shot tempTimer is still alive inside its own callback.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('script entry points look like the main state (#257)', () => {
  let t: TestRuntime;
  let errors: string[];
  let off: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    t = await createTestRuntime();
    errors = [];
    off = t.session.events.on('script.log', (text: string, level: string) => {
      if (level === 'error') errors.push(text);
    });
    t.run(`R = {} function rec(...) local p = {} for i = 1, select('#', ...) do p[i] = tostring((select(i, ...))) end R[#R + 1] = table.concat(p, ' ') end`);
  });

  afterEach(() => {
    off();
    t.dispose();
    vi.useRealTimers();
  });

  const record = () => t.run(`return table.concat(R, '|')`);

  it('coroutine.running() is nil in a script body and in a timer callback', () => {
    t.rt.load(`rec('body', type(coroutine.running()))
      tempTimer(0.5, function() rec('timer', type(coroutine.running())) end)`, 'running-test');
    vi.advanceTimersByTime(600);
    expect(record()).toBe('body nil|timer nil');
  });

  it('coroutine.running() in an event handler is whatever raised it', () => {
    t.rt.load(`
      registerAnonymousEventHandler('evR', function() rec('handler', type(coroutine.running()), coroutine.running() == outer) end)
      raiseEvent('evR')
      coroutine.wrap(function() outer = coroutine.running() raiseEvent('evR') end)()
    `, 'handler-running-test');
    expect(record()).toBe('handler nil true|handler thread true');
  });

  it('a yield from a callback errors instead of suspending it', () => {
    t.rt.load(`tempTimer(0.1, function() rec('before') coroutine.yield() rec('after') end)`, 'timer-yield-test');
    vi.advanceTimersByTime(200);
    expect(record()).toBe('before');
    expect(errors.some(e => e.includes('attempt to yield across metamethod/C-call boundary'))).toBe(true);
  });

  it('a handler yielding cannot swallow the coroutine that raised the event', () => {
    // The issue's reproduction: desktop logs handler1, after_raise, timer_end —
    // the handler's yield errors inside dispatch's pcall and the caller goes on.
    t.rt.load(`
      local function wait(n) local co = coroutine.running(); tempTimer(n, function() coroutine.resume(co) end); coroutine.yield() end
      registerAnonymousEventHandler('evW', function() rec('handler1'); wait(0.3); rec('handler2') end)
      tempTimer(1, function() coroutine.wrap(function() raiseEvent('evW'); rec('after_raise') end)(); rec('timer_end') end)
    `, 'swallow-test');
    vi.advanceTimersByTime(2000);
    expect(record()).toBe('handler1|after_raise|timer_end');
    expect(errors.some(e => e.includes('attempt to yield across metamethod/C-call boundary'))).toBe(true);
  });

  it('coroutines a script makes itself still run and yield normally', () => {
    t.rt.load(`
      local co = coroutine.create(function(a) rec('in', a, coroutine.running() ~= nil) local b = coroutine.yield(a + 1) rec('back', b) return 'done' end)
      rec('first', coroutine.resume(co, 1))
      rec('second', coroutine.resume(co, 'x'))
      local gen = coroutine.wrap(function() for i = 1, 3 do coroutine.yield(i) end end)
      rec('wrap', gen(), gen(), gen())
    `, 'user-co-test');
    expect(record()).toBe('in 1 true|first true 2|back x|second true done|wrap 1 2 3');
  });

  // exists/isActive are answered by ScriptingEngine, which this runtime does
  // not wire; tests/mud/timers/timerOneShotSelf.test.ts covers those.
  it('a one-shot tempTimer can still be killed inside its own callback', () => {
    t.rt.load(`
      local a; a = tempTimer(2, function() rec('self', killTimer(a), killTimer(a)) end)
      id = a
    `, 'self-timer-test');
    vi.advanceTimersByTime(2100);
    expect(record()).toBe('self true false');
    // Freed once its callback returns, as TimerUnit::timerFired does.
    expect(t.api.timers.hasTemp(t.run('return id') as number)).toBe(false);
  });

  it('enableTimer/disableTimer on a one-shot inside its callback answer true, and it still retires', () => {
    t.rt.load(`
      local a; a = tempTimer(1, function()
        rec('toggle', disableTimer(a), enableTimer(a))
      end)
      id = a
    `, 'toggle-self-test');
    vi.advanceTimersByTime(1100);
    expect(record()).toBe('toggle true true');
    expect(t.api.timers.hasTemp(t.run('return id') as number)).toBe(false);
    // Re-enabled inside the body, yet stopped afterwards: it does not fire again.
    vi.advanceTimersByTime(5000);
    expect(record()).toBe('toggle true true');
  });
});
