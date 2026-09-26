// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// A script that names a command line it hasn't created yet must not reach the
// main bar: the bindings resolve an unknown name to the main command line, so
// printCmdLine("nope", "x") used to replace what the player was typing and
// getCmdLine("nope") read it back. Mudlet refuses the name (issue #188).
describe('command-line functions given an unknown name', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  const notFound = 'command line "nope" not found';

  it('printCmdLine refuses the name and leaves the main line alone', () => {
    env.run('printCmdLine("typed by player")');
    expect(env.run('local ok, err = printCmdLine("nope", "hijack"); return ok == nil and err')).toBe(notFound);
    expect(env.run('return (getCmdLine())')).toBe('typed by player');
  });

  it('appendCmdLine refuses the name and leaves the main line alone', () => {
    env.run('printCmdLine("typed by player")');
    expect(env.run('local ok, err = appendCmdLine("nope", "hijack"); return ok == nil and err')).toBe(notFound);
    expect(env.run('return (getCmdLine())')).toBe('typed by player');
  });

  it('clearCmdLine refuses the name and leaves the main line alone', () => {
    env.run('printCmdLine("typed by player")');
    expect(env.run('local ok, err = clearCmdLine("nope"); return ok == nil and err')).toBe(notFound);
    expect(env.run('return (getCmdLine())')).toBe('typed by player');
  });

  it('getCmdLine refuses the name instead of reading the main line', () => {
    env.run('printCmdLine("typed by player")');
    expect(env.run('local ok, err = getCmdLine("nope"); return ok == nil and err')).toBe(notFound);
  });

  it('still takes a lone argument as the text for the main line', () => {
    env.run('printCmdLine("nope")');
    expect(env.run('return (getCmdLine())')).toBe('nope');
    env.run('appendCmdLine("!")');
    expect(env.run('return (getCmdLine("main"))')).toBe('nope!');
    env.run('clearCmdLine("main")');
    expect(env.run('return (getCmdLine())')).toBe('');
  });

  it('still reaches a command line once it exists', () => {
    env.run('createCommandLine("nope", 0, 0, 100, 20)');
    env.run('printCmdLine("typed by player")');
    env.run('printCmdLine("nope", "sub")');
    expect(env.run('return (getCmdLine("nope"))')).toBe('sub');
    expect(env.run('return (getCmdLine())')).toBe('typed by player');
  });
});
