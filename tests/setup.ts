// Global test setup. Runs before each test file is imported, so polyfills are
// in place before modules that touch them at load time.
import { vi } from 'vitest';

// In the `node` environment there's no localStorage, but the app store (zustand
// persist) and StopwatchManager read it at import/construction. A Map-backed
// stub is enough — tests don't assert on persisted state. (happy-dom tests
// already have a real one, so this only fills the node-env gap.)
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

// happy-dom lacks ResizeObserver (WindowManager attaches one per window).
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// happy-dom's canvas has no 2D context; ScriptingAPI uses it only for font
// measurement, which these tests don't assert on.
if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.getContext) {
  (HTMLCanvasElement.prototype as { getContext: unknown }).getContext = () => null;
}

// Web Audio isn't present in happy-dom; SoundManager only creates a context
// when a sound actually plays, but guard against accidental access.
if (!('AudioContext' in globalThis)) {
  // @ts-expect-error minimal stub
  globalThis.AudioContext = class {};
}

// Keep test output clean: silence the runtime's console.warn for the
// "not yet implemented" stubs etc. Comment out when debugging.
vi.spyOn(console, 'warn').mockImplementation(() => {});
