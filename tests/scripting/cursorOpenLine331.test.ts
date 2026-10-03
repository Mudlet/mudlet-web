// @vitest-environment node
//
// mudlet-web#331 item 1: a console whose text ends in "\n" has an empty open
// line after it, and desktop's cursor can sit on it — moveCursorEnd() outside
// a trigger, or moveCursor() onto that line. getCurrentLine() reads '' there
// and insertText()/insertLink() start the new line. Mudlet Web reported the
// same line number but acted on the line above, gluing the text onto it.
// Expectations are desktop PTB 96fbed5's results from the issue.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('mudlet-web#331 — the cursor on the trailing empty line', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  const linesOf = (win: string) =>
    env.run(`local n = getLastLineNumber("${win}")
             return table.concat(getLines("${win}", 0, n + 1), "|")`);

  it('moveCursorEnd on main outside a trigger parks on the empty last line', () => {
    env.run('echo("main tail\\n")');
    env.run('moveCursorEnd()');
    expect(env.run('return (getLineNumber() - getLastLineNumber("main"))')).toBe(0);
    expect(env.run('return (getColumnNumber())')).toBe(0);
    expect(env.run('return (getCurrentLine())')).toBe('');
    env.run('insertText("[I]")');
    const n = env.run('return (getLastLineNumber("main"))') as number;
    expect(env.run(`return (table.concat(getLines("main", ${n - 1}, ${n + 1}), "|"))`))
      .toBe('main tail|[I]');
  });

  it('insertLink after moveCursorEnd starts a new line in a miniconsole', () => {
    env.run('createMiniConsole("m6", 0, 0, 400, 200)');
    env.run('echo("m6", "abc\\ndef\\n"); moveCursorEnd("m6"); insertLink("m6", "[L]", "", "")');
    expect(linesOf('m6')).toBe('abc|def|[L]');
  });

  it('insertText after moveCursorEnd starts a new line in a miniconsole and a buffer', () => {
    env.run('createMiniConsole("m7", 0, 0, 400, 200)');
    env.run('echo("m7", "abc\\ndef\\n"); moveCursorEnd("m7"); insertText("m7", "[i]")');
    expect(linesOf('m7')).toBe('abc|def|[i]');

    env.run('createBuffer("b7")');
    env.run('echo("b7", "abc\\ndef\\n"); moveCursorEnd("b7"); insertText("b7", "[i]")');
    expect(linesOf('b7')).toBe('abc|def|[i]');
  });

  it('moveCursor onto the trailing empty line reads it as empty', () => {
    env.run('createMiniConsole("m5", 0, 0, 400, 200)');
    env.run('echo("m5", "abc\\n")');
    expect(env.run('return (moveCursor("m5", 0, 1))')).toBe(true);
    expect(env.run('return (getLineNumber("m5"))')).toBe(1);
    expect(env.run('return (getCurrentLine("m5"))')).toBe('');
    expect(env.run('return (copy2decho("m5"))')).toBe('');
    env.run('selectCurrentLine("m5")');
    expect(env.run('return (getSelection("m5"))')).toBe('');
    env.run('insertText("m5", "INS")');
    expect(linesOf('m5')).toBe('abc|INS');
  });

  it('selectCurrentLine on the empty line does not recolour the line above', () => {
    env.run('createMiniConsole("m8", 0, 0, 400, 200)');
    env.run('echo("m8", "one\\n"); moveCursor("m8", 0, 1)');
    env.run('selectCurrentLine("m8"); setFgColor("m8", 255, 0, 0); resetFormat("m8")');
    env.run('moveCursor("m8", 0, 0)');
    expect(env.run('return (copy2decho("m8"))')).not.toContain('255,0,0');
  });

  it('a line-by-line dump stops at the empty last line (MDK consoleToString)', () => {
    env.run('createMiniConsole("m9", 0, 0, 400, 200)');
    env.run('echo("m9", "red tell\\nrest\\n")');
    expect(env.run(`
      local out = {}
      for line = 0, getLineCount("m9") do
        moveCursor("m9", 0, line)
        selectCurrentLine("m9")
        out[#out + 1] = getCurrentLine("m9")
      end
      return table.concat(out, "\\n")`)).toBe('red tell\nrest\n');
  });
});
