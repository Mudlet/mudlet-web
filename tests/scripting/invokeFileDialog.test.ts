// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { FileDialogRequest } from '../../src/mud/events';

// invokeFileDialog is synchronous in Mudlet (QFileDialog blocks the script).
// Mudlet Web implements it by parking the calling handler's coroutine at the JS
// resume boundary (LuaRuntime.parkDialogThread) and resuming it with the
// picked path once the UI resolves the 'script.filedialog' request. These
// tests drive that full loop: park → request emitted → resume with a path /
// cancel → the handler continues exactly where it left off.
describe('invokeFileDialog — coroutine park/resume', () => {
  let t: TestRuntime;
  let requests: FileDialogRequest[];
  let unsub: (() => void) | null;

  beforeEach(async () => {
    t = await createTestRuntime();
    requests = [];
    unsub = t.session.events.on('script.filedialog', (req: FileDialogRequest) => {
      requests.push(req);
    });
  });

  afterEach(() => {
    unsub?.();
    t.dispose();
  });

  it('parks the handler, then resumes it with the picked path (exec path)', () => {
    t.rt.load(
      `
      before = 'ran'
      picked = invokeFileDialog(true, 'Pick a script')
      after = 'ran too'
      `,
      'dialog-test',
    );
    // The handler is suspended mid-call: code before the dialog ran, code
    // after it did not, and the UI got the request.
    expect(t.run('return before')).toBe('ran');
    expect(t.run('return after')).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].mode).toBe('file');
    expect(requests[0].title).toBe('Pick a script');

    requests[0].onPick('/profiles/test-connection/foo.lua');
    expect(t.run('return picked')).toBe('/profiles/test-connection/foo.lua');
    expect(t.run('return after')).toBe('ran too');
  });

  it('returns "" on cancel, like Mudlet', () => {
    t.rt.load(`picked = invokeFileDialog(true, 'x')`, 'cancel-test');
    requests[0].onPick('');
    expect(t.run('return picked')).toBe('');
  });

  it('maps fileOrFolder=false to a folder request and passes the location', () => {
    t.rt.load(`picked = invokeFileDialog(false, 'Choose dir', '/profiles/test-connection/sub')`, 'folder-test');
    expect(requests[0].mode).toBe('folder');
    expect(requests[0].location).toBe('/profiles/test-connection/sub');
    requests[0].onPick('/profiles/test-connection/sub/inner');
    expect(t.run('return picked')).toBe('/profiles/test-connection/sub/inner');
  });

  it('supports two dialogs in sequence inside one handler (re-park)', () => {
    t.rt.load(
      `
      first = invokeFileDialog(true, 'one')
      second = invokeFileDialog(true, 'two')
      `,
      'twice-test',
    );
    expect(requests).toHaveLength(1);
    requests[0].onPick('/a');
    // Resuming immediately re-parked on the second call.
    expect(t.run('return first')).toBe('/a');
    expect(t.run('return second')).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1].title).toBe('two');
    requests[1].onPick('/b');
    expect(t.run('return second')).toBe('/b');
  });

  it('works from a raiseEvent handler (dispatch chunk path)', () => {
    t.rt.load(
      `
      function pickEvent()
        eventPicked = invokeFileDialog(true, 'from event')
      end
      raiseEvent('pickEvent')
      `,
      'event-test',
    );
    expect(requests).toHaveLength(1);
    expect(t.run('return eventPicked')).toBeNull();
    requests[0].onPick('/via-event');
    expect(t.run('return eventPicked')).toBe('/via-event');
  });

  it('works from a registerAnonymousEventHandler function handler', () => {
    t.rt.load(
      `
      registerAnonymousEventHandler('anonPick', function()
        anonPicked = invokeFileDialog(false, 'anon')
      end)
      raiseEvent('anonPick')
      `,
      'anon-event-test',
    );
    expect(requests).toHaveLength(1);
    requests[0].onPick('/via-anon');
    expect(t.run('return anonPicked')).toBe('/via-anon');
  });

  it('reports an error thrown after the resume to the script console', () => {
    const errors: string[] = [];
    const off = t.session.events.on('script.log', (text: string, level: string) => {
      if (level === 'error') errors.push(text);
    });
    try {
      t.rt.load(
        `
        invokeFileDialog(true, 'about to blow')
        error('boom after dialog')
        `,
        'post-error-test',
      );
      expect(errors).toHaveLength(0); // nothing yet — the handler is parked
      requests[0].onPick('/x');
      expect(errors.some(e => e.includes('boom after dialog'))).toBe(true);
    } finally {
      off();
    }
  });

  it('restores matches/multimatches around the suspension', () => {
    t.rt.load(
      `
      matches = { 'full', 'cap' }
      invokeFileDialog(true, 'm')
      restoredCap = matches[2]
      `,
      'matches-test',
    );
    // Another trigger firing while the picker is open clobbers the globals.
    t.run(`matches = { 'other-line' }`);
    requests[0].onPick('/x');
    expect(t.run('return restoredCap')).toBe('cap');
  });

  it('cancels immediately when nothing is listening (headless runtime)', () => {
    unsub?.();
    unsub = null;
    t.rt.load(`headlessPicked = invokeFileDialog(true, 'nobody home')`, 'headless-test');
    // No UI → ScriptingAPI resolves with '' synchronously; the handler ran to
    // completion in one go.
    expect(t.run('return headlessPicked')).toBe('');
  });

  it('resolving a request twice is a no-op', () => {
    t.rt.load(`picked = invokeFileDialog(true, 'once')`, 'double-resolve-test');
    requests[0].onPick('/first');
    requests[0].onPick('/second');
    expect(t.run('return picked')).toBe('/first');
  });

  it('abandons (without crashing) a handler that yields outside invokeFileDialog', () => {
    const errors: string[] = [];
    const off = t.session.events.on('script.log', (text: string, level: string) => {
      if (level === 'error') errors.push(text);
    });
    try {
      t.rt.load(`coroutine.yield('rogue')`, 'rogue-yield-test');
      expect(errors.some(e => e.includes('yield'))).toBe(true);
      // The runtime is still healthy afterwards.
      expect(t.run('return 1 + 1')).toBe(2);
    } finally {
      off();
    }
  });

  it('resolving after destroy() is a safe no-op', () => {
    t.rt.load(`invokeFileDialog(true, 'late')`, 'late-test');
    const req = requests[0];
    t.dispose();
    expect(() => req.onPick('/too-late')).not.toThrow();
    // Re-create so afterEach's dispose stays idempotent-safe.
  });
});

// __mudlet_pcall_co is the pcall replacement that lets a yield pass through a
// protected call (Lua 5.1 pcall is a C frame — yields can't cross it). It must
// still behave exactly like pcall for the error/return contract.
describe('__mudlet_pcall_co — yield-transparent pcall', () => {
  let t: TestRuntime;

  beforeEach(async () => {
    t = await createTestRuntime();
  });

  afterEach(() => {
    t.dispose();
  });

  it('returns true + results on success', () => {
    expect(t.run(`local ok, a = __mudlet_pcall_co(function() return 42 end) return ok and a`)).toBe(42);
  });

  it('catches errors like pcall', () => {
    expect(t.run(`local ok = __mudlet_pcall_co(function() error('nope') end) return ok`)).toBe(false);
    expect(
      t.run(`local ok, err = __mudlet_pcall_co(function() error('nope') end) return tostring(err)`),
    ).toContain('nope');
  });

  it('passes arguments through', () => {
    expect(t.run(`local ok, s = __mudlet_pcall_co(function(a, b) return a .. b end, 'x', 'y') return s`)).toBe('xy');
  });

  it('falls back to plain pcall for C functions (coroutine.create rejects them)', () => {
    // JS-bound API globals are C functions to Lua; they can't run on a
    // coroutine but must still get pcall semantics instead of erroring.
    expect(t.run(`local ok, s = __mudlet_pcall_co(string.rep, 'ab', 2) return ok and s`)).toBe('abab');
    expect(t.run(`local ok = __mudlet_pcall_co(error, 'from C') return ok`)).toBe(false);
  });

  it('forwards a nested yield outward and feeds the resume value back in', () => {
    // Simulate the JS boundary with a plain coroutine wrapping the trampoline.
    const result = t.run(`
      local co = coroutine.create(function()
        local ok, v = __mudlet_pcall_co(function()
          return coroutine.yield('ping')
        end)
        return ok and v
      end)
      local _, yielded = coroutine.resume(co)      -- reached the JS boundary
      local _, final = coroutine.resume(co, 'pong') -- resumed with the "picked" value
      return yielded .. '/' .. tostring(final)
    `);
    expect(result).toBe('ping/pong');
  });
});
