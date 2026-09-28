// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('createBuffer / copy / paste / appendBuffer', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('reports an off-screen buffer via windowType', () => {
    env.run('createBuffer("tb")');
    expect(env.run('return (windowType("tb"))')).toBe('buffer');
  });

  it('keeps formatted output in the buffer without opening a window', () => {
    env.run('createBuffer("tb")');
    env.run('cecho("tb", "<red>Hello <green>World<reset>\\n")');
    expect(env.run('return (getCurrentLine("tb"))')).toBe('Hello World');
    // A buffer must NOT register as an on-screen window.
    expect(env.api.windows.has('tb')).toBe(false);
  });

  it('copies a selection and appends it to the main window', () => {
    env.run('createBuffer("tb")');
    env.run('cecho("tb", "<red>Hello <green>World<reset>\\n")');
    env.run('selectCurrentLine("tb")');
    expect(env.run('return (getSelection("tb"))')).toBe('Hello World');

    env.run('copy("tb")');
    env.run('appendBuffer("main")');
    expect(env.mainOutput).toContain('Hello World');
  });

  it('paste APPENDS when the cursor is on the last line', () => {
    env.run('createBuffer("tb"); cecho("tb", "Hello World\\n"); selectCurrentLine("tb"); copy("tb")');
    // A buffer's cursor stays on line 0 until moved, as Mudlet's does, so the
    // script parks it on the open last line first.
    env.run('createBuffer("tb2"); cecho("tb2", "line-A\\n"); moveCursorEnd("tb2"); paste("tb2")');
    expect(env.run('return (getCurrentLine("tb2"))')).toBe('Hello World');
    expect(env.run('return (table.concat(getLines("tb2", 0, 2), "|"))')).toBe('line-A|Hello World');
  });

  it('paste INSERTS on line 0 when the cursor was never moved (Mudlet/mudlet-web#236)', () => {
    env.run('createBuffer("tb"); cecho("tb", "Hello World\\n"); selectCurrentLine("tb"); copy("tb")');
    env.run('createBuffer("tb2"); cecho("tb2", "line-A\\n"); paste("tb2")');
    expect(env.run('return (getCurrentLine("tb2"))')).toBe('Hello Worldline-A');
  });

  it('paste INSERTS at the cursor when above the last line', () => {
    env.run('createBuffer("tb"); cecho("tb", "Hello World\\n"); selectCurrentLine("tb"); copy("tb")');
    env.run('createBuffer("tb3"); cecho("tb3", "AAAA\\n"); cecho("tb3", "BBBB\\n")');
    env.run('moveCursor("tb3", 2, 0)'); // line 0 ("AAAA"), column 2
    env.run('paste("tb3")');
    expect(env.run('return (getCurrentLine("tb3"))')).toBe('AAHello WorldAA');
  });

  it('clearWindow empties an off-screen buffer', () => {
    env.run('createBuffer("tb"); cecho("tb", "something\\n")');
    expect(env.run('return (getCurrentLine("tb"))')).toBe('something');
    env.run('clearWindow("tb")');
    expect(env.run('return (getCurrentLine("tb"))')).toBe('');
  });

  // Regression for the bug this suite was written alongside: cecho/decho/hecho
  // call resetFormat(win) internally, which used to null the GLOBAL selection.
  // Echoing to one window must not drop a selection made in another, or
  // select(buf) -> copy(buf) breaks when unrelated output goes to main between.
  it('does not clobber a cross-window selection on unrelated echo', () => {
    env.run('createBuffer("tb"); cecho("tb", "<red>Hi<reset>\\n"); selectCurrentLine("tb")');
    env.run('cecho("main", "unrelated output\\n")'); // pre-fix: this nulled the selection
    env.run('copy("tb")');
    env.run('createBuffer("dst"); appendBuffer("dst")');
    expect(env.run('return (getCurrentLine("dst"))')).toBe('Hi');
  });
});
