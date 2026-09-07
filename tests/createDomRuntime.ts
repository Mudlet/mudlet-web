import { createTestRuntime, type TestRuntime } from './createTestRuntime';
import { setupOutputRenderer, type OutputRendererControls, type MessageSource } from '../src/ui/output/OutputRenderer';

export interface DomTestRuntime extends TestRuntime {
  /** Container holding rendered `<div class="output-msg">` line elements (the
   *  real OutputRenderer output for the MAIN window). */
  outputWrapper: HTMLElement;
  /** `document.body` — popup menus (`#mudlet-popup-menu`) are appended here. */
  body: HTMLElement;
  controls: OutputRendererControls;
}

/**
 * A {@link createTestRuntime} that additionally mounts a REAL DOM and the
 * production {@link setupOutputRenderer}, so tests can assert on rendered HTML,
 * dispatch mouse events at echoed links/popups, and observe in-place re-renders
 * (`wrapLine`, `replace`, colour edits).
 *
 * Why this works despite the "no document in tests" rule: the two WASM
 * libraries (wasmoon, pcre2) decide whether to load their `.wasm` from the
 * filesystem (node) or via `document.baseURI` (web) AT INIT TIME. createTestRuntime
 * finishes that init while `document` is still absent, so they pick fs/node mode.
 * Only AFTER that do we install happy-dom's `document`/`window` — neither
 * library re-resolves paths later, so fs loading stays intact and the renderer
 * gets a genuine DOM. (Run these files with `// @vitest-environment node`.)
 */
// Globals we install for the DOM; snapshotted + restored per runtime so the
// next WASM init (this file or a later node-env file sharing the process) sees
// NO `document` and loads its `.wasm` from the filesystem again.
const DOM_GLOBAL_KEYS = ['window', 'document', 'location', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

export async function createDomRuntime(): Promise<DomTestRuntime> {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(DOM_GLOBAL_KEYS.map((k) => [k, g[k]]));
  const restoreGlobals = () => {
    for (const k of DOM_GLOBAL_KEYS) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  };

  // Init WASM with NO document present so wasmoon/pcre2 pick fs/node loading.
  for (const k of DOM_GLOBAL_KEYS) delete g[k];
  const env = await createTestRuntime();

  // WASM is fully loaded now — safe to introduce a real DOM.
  const { Window } = await import('happy-dom');
  const win = new Window({ url: 'http://localhost/' });
  g.window = win;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  g.MouseEvent = win.MouseEvent;
  // No-op rAF: the renderer only uses it to scroll, which is meaningless in a
  // detached DOM — and a real happy-dom rAF would queue a task that fires after
  // teardown (when globals are gone), crashing the worker.
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};

  const doc = win.document as unknown as Document;
  const outputWrapper = doc.createElement('div');
  const sentinel = doc.createElement('div');
  outputWrapper.appendChild(sentinel);
  const stickyArea = doc.createElement('div');
  doc.body.appendChild(outputWrapper);
  doc.body.appendChild(stickyArea);

  const controls = setupOutputRenderer(env.session.events as unknown as MessageSource, {
    outputWrapper,
    sentinel,
    stickyArea,
    isSplitView: () => false,
    stickyLines: 0,
  });

  // Run a clicked link/popup command as Lua so tests can assert side effects.
  const lua = (env.rt as unknown as { lua: { doStringSync: (s: string) => unknown } }).lua;
  env.api.setHost({
    ...env.api.engineHost,
    runLinkCode: (code: string) => { lua.doStringSync(code); },
  });

  return {
    ...env,
    outputWrapper,
    body: doc.body as unknown as HTMLElement,
    controls,
    dispose: () => {
      try { controls.teardown(); } catch { /* best-effort */ }
      env.dispose();
      // Cancel happy-dom's pending async tasks/timers before the globals vanish,
      // otherwise a late task fires against deleted globals and crashes the worker.
      try { win.happyDOM.abort(); } catch { /* best-effort */ }
      try { win.close(); } catch { /* best-effort */ }
      restoreGlobals();
    },
  };
}
