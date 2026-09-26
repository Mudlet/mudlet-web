// @vitest-environment node
//
// Console-buffer APIs read from inside a trigger, checked against what desktop
// Mudlet answers for the same line (Mudlet/mudlet-web#175).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

/** The per-line sequence ScriptingEngine.processFlushBatch runs: append and open
 *  trigger processing, run the trigger body, close it, render, flush echoes. */
function feedLine(env: TestRuntime, text: string, triggerBody?: string): void {
  const buffer = new AnsiAwareBuffer(text);
  env.api.beginLine(buffer);
  if (triggerBody) env.run(triggerBody);
  env.api.endLine();
  if (!buffer.deleted) env.session.events.emit('message', buffer, 'mud', Date.now());
  env.api.flushDeferredEcho();
}

describe('console buffer APIs inside a trigger', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('getLines(from, to) without a window name reads the main window', () => {
    feedLine(env, 'L1 before');
    feedLine(env, 'L2 mid');
    feedLine(env, 'L3 after',
      'local ln = getLineNumber(); seen = table.concat(getLines(ln - 2, ln + 1), "|")');
    expect(env.run('return seen')).toBe('L1 before|L2 mid|L3 after');
  });

  it('getLineCount() and getLastLineNumber() equal getLineNumber() on the matched line', () => {
    feedLine(env, 'first');
    feedLine(env, 'second',
      'diff = getLineCount() - getLineNumber(); lastDiff = getLastLineNumber() - getLineNumber()'
      + '; prev = table.concat(getLines("main", getLineCount() - 1, getLineCount() + 1), "|")');
    expect(env.run('return diff')).toBe(0);
    expect(env.run('return lastDiff')).toBe(0);
    expect(env.run('return prev')).toBe('first|second');
  });

  it('getLineCount() counts the open line again once a trigger echo leaves the matched line', () => {
    feedLine(env, 'first');
    feedLine(env, 'second', 'echo("\\nnext"); diff = getLineCount() - getLineNumber()');
    expect(env.run('return diff')).toBe(1);
  });

  it('getLineCount() outside a trigger still counts the open line', () => {
    feedLine(env, 'first');
    feedLine(env, 'second');
    expect(env.run('return getLineCount() - getLineNumber()')).toBe(1);
  });

  it('echoLink from a trigger appends to the matched line', () => {
    feedLine(env, 'W1 base',
      'echoLink(" EL", [[send("z", false)]], "h"); seen = getCurrentLine()');
    feedLine(env, 'next');
    expect(env.run('return seen')).toBe('W1 base EL');
    expect(env.mainOutput).toEqual(['W1 base EL', 'next']);
  });

  it('cechoLink and echoPopup from a trigger append to the matched line', () => {
    feedLine(env, 'P1 base',
      'cechoLink("<red> CL", [[send("z", false)]], "h", true)'
      + '; echoPopup(" POP", {[[send("a", false)]]}, {"a"})');
    expect(env.mainOutput).toEqual(['P1 base CL POP']);
  });

  it('echoLink outside a trigger still writes to the end of the buffer', () => {
    feedLine(env, 'plain');
    env.run('echoLink("link", [[send("z", false)]], "h"); echo("\\n")');
    expect(env.mainOutput).toEqual(['plain', 'link']);
  });
});
