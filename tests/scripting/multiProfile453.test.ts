// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { ProfilesPresence } from '../../src/scripting/profilesPresence';
import { GlobalEventChannel } from '../../src/scripting/GlobalEventChannel';
import { PLATFORM_DIVERGENCES } from '../../e2e/knownDivergences';

// mudlet-web#453 — scripted multi-playing. Each profile is a browser tab, so:
//  1. loadProfile() can only open one tab per user gesture (none from a
//     trigger); a refused call leaves a clickable "Open profile" line instead
//     of failing silently.
//  2. setActiveProfile() for a profile in another tab can't bring it forward,
//     so it answers false and flags that tab rather than claiming success.
//  3. raiseGlobalEvent() reaches other tabs a task later — recorded, not fixed.

/** Mirrors ScriptingEngine.processFlushBatch for one network line with a
 *  trigger body running on it (see trigger-echo-placement.test.ts). */
function feedLine(env: TestRuntime, text: string, triggerBody?: string): void {
  const buffer = new AnsiAwareBuffer(text);
  env.api.beginLine(buffer);
  if (triggerBody) env.run(triggerBody);
  env.api.endLine();
  if (!buffer.deleted) env.session.events.emit('message', buffer, 'mud', Date.now());
  env.api.flushDeferredEcho();
}

interface Presence {
  loadedIds: () => string[];
  requestAttention: (id: string) => boolean;
}

describe('loadProfile when the browser blocks the new tab (#453)', () => {
  let env: TestRuntime;
  let opened: string[];
  /** window.open's answers, in order; once used up it answers null (blocked). */
  let allow: boolean[];
  let lines: AnsiAwareBuffer[];

  beforeEach(async () => {
    env = await createTestRuntime();
    opened = [];
    allow = [];
    lines = [];
    const w = globalThis.window as unknown as {
      location: { href: string };
      open: (url: string, target: string) => unknown;
    };
    w.location = { href: 'https://app.example/' };
    w.open = (url: string) => {
      if (!allow.shift()) return null;
      opened.push(new URL(url).searchParams.get('profile') ?? '');
      return {};
    };
    env.session.events.on('message', (line?: AnsiAwareBuffer | string) => {
      if (line instanceof AnsiAwareBuffer) lines.push(line);
    });
    useAppStore.setState(s => ({
      connections: [
        ...s.connections.filter(c => c.id !== 'alt-profile' && c.id !== 'third-profile'),
        { id: 'alt-profile', name: 'Alt', url: 'ws://localhost' },
        { id: 'third-profile', name: 'Third', url: 'ws://localhost' },
      ],
    }));
  });

  afterEach(() => {
    env.dispose();
    useAppStore.setState(s => ({
      connections: s.connections.filter(c => c.id !== 'alt-profile' && c.id !== 'third-profile'),
    }));
  });

  /** The "Open profile <name>" link's click handler on the line holding it. */
  function linkFor(name: string): () => void {
    const line = lines.find(l => l.text.includes(`Open profile ${name}`));
    expect(line, `no "Open profile ${name}" line in ${JSON.stringify(env.mainOutput)}`).toBeDefined();
    const onClick = line!.getStateAt(line!.text.indexOf(`Open profile ${name}`))?.hyperlink?.onClick;
    expect(onClick).toBeTypeOf('function');
    return () => onClick!({} as MouseEvent);
  }

  it('opens the first of two profiles from one alias and leaves a link for the second', () => {
    allow = [true]; // one gesture, one tab
    const result = env.run(`
      local a, b = loadProfile("Alt"); local c, d = loadProfile("Third")
      return tostring(a) .. "|" .. tostring(b) .. "|" .. tostring(c) .. "|" .. tostring(d)`);
    expect(result).toBe(
      "true|nil|nil|loadProfile: could not open profile 'Third', the browser blocked the new tab; "
      + 'click the link in the main window to open it');
    expect(opened).toEqual(['alt-profile']);
    expect(env.mainOutput).toContain("The browser blocked opening profile 'Third' from a script. Open profile Third");

    // The click is a gesture of its own, so the browser lets it through.
    allow = [true];
    linkFor('Third')();
    expect(opened).toEqual(['alt-profile', 'third-profile']);
  });

  it('puts the link on a line of its own after the line a trigger fired on', () => {
    feedLine(env, 'AUTOLOAD Alt', 'loadProfile("Alt")');
    expect(opened).toEqual([]);
    expect(env.mainOutput).toEqual([
      'AUTOLOAD Alt',
      "The browser blocked opening profile 'Alt' from a script. Open profile Alt",
    ]);
    allow = [true];
    linkFor('Alt')();
    expect(opened).toEqual(['alt-profile']);
  });

  it('does not open a second tab from a link once the profile is open', () => {
    env.run('loadProfile("Alt")');
    const presence = (env.api as unknown as { presence: Presence }).presence;
    presence.loadedIds = () => ['test-connection', 'alt-profile'];
    allow = [true];
    linkFor('Alt')();
    expect(opened).toEqual([]);
    expect(env.mainOutput.at(-1)).toBe("Profile 'Alt' is already open.");
  });

  it('says so when the click itself is refused', () => {
    env.run('loadProfile("Alt")');
    linkFor('Alt')(); // allow is empty: still blocked (pop-ups disabled outright)
    expect(env.mainOutput.at(-1)).toMatch(/^The browser blocked opening profile 'Alt'; allow pop-ups/);
  });
});

describe('setActiveProfile for a profile in another tab (#453)', () => {
  let env: TestRuntime;
  let presence: Presence;
  let flagged: string[];

  beforeEach(async () => {
    env = await createTestRuntime();
    presence = (env.api as unknown as { presence: Presence }).presence;
    flagged = [];
    presence.requestAttention = (id) => { flagged.push(id); return true; };
    useAppStore.setState(s => ({
      connections: [
        ...s.connections.filter(c => c.id !== 'main-profile'),
        { id: 'main-profile', name: 'Main', url: 'ws://localhost' },
      ],
    }));
  });

  afterEach(() => {
    env.dispose();
    useAppStore.setState(s => ({ connections: s.connections.filter(c => c.id !== 'main-profile') }));
  });

  it('answers false with the reason, and flags the other tab, rather than claiming a switch', () => {
    presence.loadedIds = () => ['test-connection', 'main-profile'];
    expect(env.run('local ok, err = setActiveProfile("main") return tostring(ok) .. "|" .. err')).toBe(
      "false|setActiveProfile: profile 'Main' is open in another browser tab, which a page cannot bring "
      + "to the front; that tab's title is flashing instead");
    expect(flagged).toEqual(['main-profile']);
  });

  it('still answers true for this tab\'s own profile, without flagging anything', () => {
    expect(env.run('return setActiveProfile("Test")')).toBe(true);
    expect(flagged).toEqual([]);
  });

  it('flags nothing for a profile that is not loaded', () => {
    expect(env.run('local ok, err = setActiveProfile("Main") return tostring(ok) .. "|" .. err'))
      .toBe("false|setActiveProfile: profile 'Main' is not loaded");
    expect(flagged).toEqual([]);
  });
});

describe('ProfilesPresence attention requests', () => {
  it('delivers an attention request to the tab that owns the profile, and only to it', async () => {
    const a = new ProfilesPresence('profile-a', () => false);
    const b = new ProfilesPresence('profile-b', () => false);
    const c = new ProfilesPresence('profile-c', () => false);
    const bFlagged = vi.fn();
    const cFlagged = vi.fn();
    b.onAttentionRequested = bFlagged;
    c.onAttentionRequested = cFlagged;
    try {
      expect(a.requestAttention('profile-b')).toBe(true);
      await vi.waitFor(() => expect(bFlagged).toHaveBeenCalledTimes(1));
      expect(cFlagged).not.toHaveBeenCalled();
    } finally {
      a.destroy();
      b.destroy();
      c.destroy();
    }
  });
});

describe('raiseGlobalEvent timing (#453)', () => {
  // Pins the recorded divergence: another tab's handler has not run when
  // raiseGlobalEvent returns, only on a later task. If this ever starts
  // running inline, the knownDivergences entry and docs are stale.
  it('reaches the other profile after the call returns, not during it', async () => {
    const received: unknown[][] = [];
    const main = new GlobalEventChannel(() => {}, () => 'Main');
    const alt = new GlobalEventChannel((_name, args) => received.push(args), () => 'Alt');
    try {
      main.raise('whatHP', []);
      expect(received).toEqual([]);
      await vi.waitFor(() => expect(received).toEqual([['Main']]));
    } finally {
      main.close();
      alt.close();
    }
  });

  it('never delivers to the sending profile, as desktop\'s postInterHostEvent skips the sender', async () => {
    const mine: string[] = [];
    const theirs: string[] = [];
    const main = new GlobalEventChannel((name) => mine.push(name), () => 'Main');
    const alt = new GlobalEventChannel((name) => theirs.push(name), () => 'Alt');
    try {
      main.raise('ping', []);
      await vi.waitFor(() => expect(theirs).toEqual(['ping']));
      expect(mine).toEqual([]);
    } finally {
      main.close();
      alt.close();
    }
  });

  it('every point of the issue is recorded as a known divergence', () => {
    const apis = PLATFORM_DIVERGENCES.filter(d => d.issue === '#453').map(d => d.api);
    expect(apis).toEqual(['loadProfile(name)', 'setActiveProfile(name)', 'raiseGlobalEvent(name, ...)']);
  });
});
