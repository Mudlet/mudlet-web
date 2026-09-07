// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Regression: ScriptingEngine raises an event literally named "disconnect",
// which collides with the JS-bound disconnect() API global. The dispatcher's
// "call a global named after the event" convenience must skip C/JS-bound
// functions — with pcall it silently re-invoked the API; after the
// __mudlet_pcall_co switch it errored ("bad argument #1 to 'create'").
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

  it('still calls a user-defined Lua function named after the event', () => {
    t.run(`function myCustomEvent(arg) customSeen = arg end`);
    t.rt.emitEvent('myCustomEvent', ['hello']);
    expect(t.run('return customSeen')).toBe('hello');
    expect(errors).toHaveLength(0);
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
