// @vitest-environment node
//
// Mudlet's end-of-session command-line history save: Host::saveProfile() emits
// signal_saveCommandLinesHistory and each TCommandLine writes its own
// `command_history_<name>` — newest first, one per line, capped at the
// profile-wide save size. Nothing else ever writes those files, so cutting the
// wire is silent until the next launch, which is why Miscallaneous_spec removes
// the file and asks for the save back.
//
// Node env (createTestRuntime needs the WASM loaded off disk, see its header),
// so localStorage — where mudix keeps the history — is stubbed in before
// anything that reads it is imported.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { createTestRuntime } = await import('../createTestRuntime');
const { historyStorageKey, saveHistory } = await import('../../src/ui/commandHistory');

const TEST_CONNECTION_ID = 'test-connection';

describe('command-line history files a save writes', () => {
  let env: Awaited<ReturnType<typeof createTestRuntime>>;
  beforeEach(async () => { store.clear(); env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  const seed = (items: string[]): void =>
    saveHistory(items, historyStorageKey(TEST_CONNECTION_ID), items.length);

  it('writes the main history newest-first, one command per line', () => {
    seed(['look', 'north', 'kill rat']);
    env.run('setConfig("commandLineHistorySaveSize", 10)');
    expect(env.api.commandLineHistoryFiles())
      .toEqual([{ name: 'command_history_main', content: 'look\nnorth\nkill rat' }]);
  });

  it('caps the file at the profile-wide save size', () => {
    seed(['a', 'b', 'c', 'd']);
    env.run('setConfig("commandLineHistorySaveSize", 2)');
    expect(env.api.commandLineHistoryFiles()[0].content).toBe('a\nb');
  });

  it('writes nothing while the profile-wide size is zero', () => {
    seed(['look']);
    env.run('setConfig("commandLineHistorySaveSize", 0)');
    expect(env.api.commandLineHistoryFiles()).toEqual([]);
  });

  it('writes nothing while this command line has its own switch off', () => {
    seed(['look']);
    env.run(`setConfig("commandLineHistorySaveSize", 10)
      setSaveCommandHistory("main", false)`);
    expect(env.api.commandLineHistoryFiles()).toEqual([]);
  });

  it('writes an empty file rather than none when there is no history yet', () => {
    env.run('setConfig("commandLineHistorySaveSize", 10)');
    expect(env.api.commandLineHistoryFiles())
      .toEqual([{ name: 'command_history_main', content: '' }]);
  });
});
