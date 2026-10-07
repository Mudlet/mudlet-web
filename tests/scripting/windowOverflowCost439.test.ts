// @vitest-environment node
//
// mudlet-web#439: every line written to a miniconsole counted the rows its pane
// shows — a getComputedStyle and clientHeight read that lays out everything the
// console holds — only for WindowManager.noteLineOverflow to throw the count
// away, because a console that scrolls (the default) never overflows. Each
// line a chat window took cost more the fuller it was.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('mudlet-web#439 — writing to a miniconsole', () => {
  let env: TestRuntime;
  beforeEach(async () => {
    env = await createTestRuntime();
    env.run('createMiniConsole("chat439", 0, 0, 100, 100)');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.dispose();
  });

  it('does not count rows while the console scrolls', () => {
    const rows = vi.spyOn(env.api, 'getRowCount');
    env.run('for i = 1, 200 do echo("chat439", "line " .. i .. "\\n") end');
    expect(env.run('return getLineCount("chat439")')).toBe(200);
    expect(rows).not.toHaveBeenCalled();
  });

  it('still raises sysWindowOverflowEvent once scrolling is disabled', () => {
    // The test runtime has no ScriptingEngine to route window events to Lua.
    const raised: unknown[][] = [];
    env.session.windows.onRaiseEvent = (event, args) => {
      if (event === 'sysWindowOverflowEvent') raised.push(args);
    };
    const rows = vi.spyOn(env.api, 'getRowCount').mockReturnValue(3);
    env.run('disableScrolling("chat439")');
    env.run('for i = 1, 4 do echo("chat439", "line " .. i .. "\\n") end');
    expect(rows).toHaveBeenCalled();
    // lineCount includes the line the cursor is on: full at 2 lines + 1.
    expect(raised).toEqual([['chat439', 1], ['chat439', 2]]);
  });
});
