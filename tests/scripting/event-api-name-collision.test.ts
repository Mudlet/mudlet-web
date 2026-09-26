// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Regression: ScriptingEngine raises an event literally named "disconnect",
// which collides with the JS-bound disconnect() API global. The dispatcher
// once called any global named after the event — with pcall it silently
// re-invoked the API; after the __mudlet_pcall_co switch it errored ("bad
// argument #1 to 'create'"). It now calls registered handlers only.
describe('event dispatch — event names colliding with API globals', () => {
  let t: TestRuntime;
  let errors: string[];
  let off: () => void;

  beforeEach(async () => {
    t = await createTestRuntime();
    errors = [];
    off = t.session.events.on('script.log', (text: string, level: string) => {
      if (level === 'error') errors.push(text);
    });
  });

  afterEach(() => {
    off();
    t.dispose();
  });

  it('raising "disconnect" neither calls the disconnect() API nor errors', () => {
    const apiSpy = vi.spyOn(t.api, 'disconnect').mockImplementation(() => {});
    t.rt.emitEvent('disconnect', []);
    expect(apiSpy).not.toHaveBeenCalled();
    expect(errors).toHaveLength(0);
  });

  // Mudlet calls registered handlers only (issue #172). A user's global
  // `function connect()` used to run on every connection change.
  it('does not call a user-defined Lua function merely named after the event', () => {
    t.run(`function myCustomEvent(arg) customSeen = arg end`);
    t.rt.emitEvent('myCustomEvent', ['hello']);
    t.run(`raiseEvent('myCustomEvent', 'again')`);
    expect(t.run('return customSeen')).toBeNull();
    expect(errors).toHaveLength(0);
  });

  it('does not call a global function named connect / disconnect', () => {
    t.run(`function connect() connectCalled = true end
           function disconnect() disconnectCalled = true end`);
    t.rt.emitEvent('connect', []);
    t.rt.emitEvent('disconnect', []);
    expect(t.run('return connectCalled')).toBeNull();
    expect(t.run('return disconnectCalled')).toBeNull();
  });

  it('registered handlers for a colliding event name still fire', () => {
    t.run(`
      registerAnonymousEventHandler('disconnect', function()
        disconnectSeen = true
      end)
    `);
    t.rt.emitEvent('disconnect', []);
    expect(t.run('return disconnectSeen')).toBe(true);
    expect(errors).toHaveLength(0);
  });
});
