import { MudSession } from '../src/mud/MudSession';
import { AliasEngine } from '../src/mud/aliases/AliasEngine';
import { TriggerEngine } from '../src/mud/triggers/TriggerEngine';
import { TimerEngine } from '../src/mud/timers/TimerEngine';
import { KeyEngine } from '../src/mud/keybindings/KeyEngine';
import { ScriptingAPI } from '../src/scripting/ScriptingAPI';
import { LuaRuntime } from '../src/scripting/lua/LuaRuntime';
import { useAppStore } from '../src/storage/appStore';
import type { AnsiAwareBuffer } from '../src/mud/text/FormatState';

/** The connection id every test runtime is built for — exported so a test can
 *  reach the store slice the runtime is reading. */
export const TEST_CONNECTION_ID = 'test-connection';

export interface TestRuntime {
  session: MudSession;
  api: ScriptingAPI;
  rt: LuaRuntime;
  /** Run a Lua chunk and return its (single) value. Wrap multi-returns in
   *  parentheses (`return (getSelection("x"))`) to collapse to one value. */
  run: (code: string) => unknown;
  /** Plain text of every line echoed to the MAIN window since creation. */
  mainOutput: string[];
  dispose: () => void;
}

/**
 * Boots a real LuaRuntime + ScriptingAPI over a non-connected MudSession — the
 * same objects the app wires in ScriptingEngine.createRuntime, minus the socket,
 * store, and VFS (passed as null). The real wasmoon (Lua) and pcre2 (PCRE) WASM
 * load from disk because the suite runs in the node environment. Tests drive the
 * actual Mudlet-compatible Lua globals and read results back, so behaviour bugs
 * (e.g. a window-scoped op clobbering another window's selection) surface
 * deterministically.
 *
 * Covers the api + Lua-runtime layer directly: echo/cecho/buffers, copy/paste,
 * selection & cursor, format/colour, raiseEvent + event handlers, stopwatches,
 * and the pure string/table/colour utilities.
 *
 * NOT wired here: the trigger/alias DISPATCH pipeline and timer pump, which live
 * in ScriptingEngine (EngineHost.processFlushBatch/bridgeEvents). No engine is
 * constructed, so the API runs on its default host throughout. `tempTrigger`/
 * `tempAlias` register fine but won't fire against `feedTriggers` input, and
 * `tempTimer` won't tick. Testing those needs the full ScriptingEngine wiring —
 * a follow-up if/when trigger coverage is wanted.
 */
export interface TestRuntimeOptions {
  /** Optional (stub) ProfileVFS handed to the LuaRuntime so io/lfs tests can
   *  exercise the real wasmoon↔VFS bridge without an IndexedDB mount. */
  vfs?: import('../src/scripting/vfs/ProfileVFS').ProfileVFS | null;
}

export async function createTestRuntime(options: TestRuntimeOptions = {}): Promise<TestRuntime> {
  // Define a minimal `window` now — NOT at import time. By this point pcre2's
  // PCRE.init() has already run (during module import, while window was absent)
  // and picked node-mode WASM loading. wasmoon tolerates a window that lacks
  // `document`, and bundled Lua (Geyser) reads window.innerWidth at LuaGlobal
  // load. A `document` property must NOT be added — it would flip both WASM
  // libraries to browser/fetch mode.
  const w = globalThis as { window?: unknown };
  if (typeof w.window === 'undefined') {
    w.window = {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };
  }

  // Seed a connection record so store actions keyed by connection id (profile
  // icon, login creds — which live on the connection, not the VFS profile) have
  // a target. The real app always opens a profile against an existing connection.
  if (!useAppStore.getState().connections.some(c => c.id === TEST_CONNECTION_ID)) {
    useAppStore.setState(s => ({
      connections: [...s.connections, { id: TEST_CONNECTION_ID, name: 'Test', url: 'ws://localhost' }],
    }));
  }

  const session = new MudSession();
  const api = new ScriptingAPI(
    session,
    new AliasEngine(),
    new TriggerEngine(),
    new TimerEngine(),
    new KeyEngine(),
    TEST_CONNECTION_ID,
  );

  // raiseEvent dispatches through the runtime itself, so events work without
  // extra wiring; link clicks / expandAlias aren't exercised here. The real
  // wasmoon (Lua) + pcre2 (PCRE) WASM load from the filesystem because tests
  // using this helper run in the node environment (no browser globals).
  const rt = await LuaRuntime.create(api, options.vfs ?? null, () => undefined);

  // The wasmoon engine is private; a test helper legitimately reaches in to
  // eval Lua and read return values.
  const lua = (rt as unknown as { lua: { doStringSync: (s: string) => unknown } }).lua;
  const run = (code: string) => lua.doStringSync(code);

  // Capture everything that reaches the main output (drainMain → 'message').
  const mainOutput: string[] = [];
  session.events.on('message', (line?: AnsiAwareBuffer | string) => {
    if (line == null) return;
    mainOutput.push(typeof line === 'string' ? line : line.text);
  });

  return {
    session,
    api,
    rt,
    run,
    mainOutput,
    dispose: () => {
      // Mirror ScriptingEngine.dispose order: stop the runtime, then the api
      // (which owns the cross-tab presence channel + its poll interval).
      try { rt.destroy(); } catch { /* teardown best-effort */ }
      try { api.destroy(); } catch { /* teardown best-effort */ }
    },
  };
}
