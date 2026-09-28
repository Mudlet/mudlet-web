// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';

// loadProfile opens another profile in a new browser tab (one profile per tab)
// and connects. It looks the connection up by name, then window.open's a deep
// we can assert the URL it builds and what it returns.
// we can assert the URL it builds and the boolean it returns.
describe('loadProfile', () => {
  let env: TestRuntime;
  let opened: { url: string; target: string }[];
  let openResult: unknown;

  beforeEach(async () => {
    env = await createTestRuntime();
    opened = [];
    openResult = {}; // truthy WindowProxy stand-in
    const w = globalThis.window as unknown as {
      location: { href: string };
      open: (url: string, target: string) => unknown;
    };
    w.location = { href: 'https://app.example/' };
    w.open = (url: string, target: string) => { opened.push({ url, target }); return openResult; };

    // A second connection to load. createTestRuntime seeds 'test-connection'
    // (name 'Test') as the active profile.
    useAppStore.setState(s => ({
      connections: [
        ...s.connections.filter(c => c.id !== 'other-profile'),
        { id: 'other-profile', name: 'Other', url: 'ws://localhost' },
      ],
    }));
  });

  afterEach(() => {
    env.dispose();
    useAppStore.setState(s => ({ connections: s.connections.filter(c => c.id !== 'other-profile') }));
  });

  it('opens the named profile in a new tab with connect=1 and returns true', () => {
    const ok = env.run('return loadProfile("Other")');
    expect(ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0].target).toBe('_blank');
    const url = new URL(opened[0].url);
    expect(url.searchParams.get('profile')).toBe('other-profile');
    expect(url.searchParams.get('connect')).toBe('1');
  });

  // Mudlet answers a refusal with nil plus a message, not false.
  it('returns nil and a message for an unknown profile name', () => {
    expect(env.run('local ok, err = loadProfile("Nope") return tostring(ok) .. "|" .. err'))
      .toBe("nil|loadProfile: profile 'Nope' does not exist");
    expect(opened).toHaveLength(0);
  });

  it('returns nil and a message when targeting the profile already open in this tab', () => {
    expect(env.run('local ok, err = loadProfile("Test") return tostring(ok) .. "|" .. err'))
      .toBe("nil|loadProfile: profile 'Test' is already loaded");
    expect(opened).toHaveLength(0);
  });

  it('refuses a profile already open in another tab', () => {
    const presence = (env.api as unknown as { presence: { loadedIds: () => string[] } }).presence;
    presence.loadedIds = () => ['test-connection', 'other-profile'];
    expect(env.run('local ok, err = loadProfile("Other") return tostring(ok) .. "|" .. err'))
      .toBe("nil|loadProfile: profile 'Other' is already loaded");
    expect(opened).toHaveLength(0);
  });

  it('returns nil and a message when the popup is blocked (window.open → null)', () => {
    openResult = null;
    expect(env.run('local ok, err = loadProfile("Other") return tostring(ok) .. "|" .. err'))
      .toMatch(/^nil\|loadProfile: could not open profile 'Other'/);
  });

  it('raises for a name that is not a string', () => {
    expect(() => env.run('loadProfile({})'))
      .toThrow(/loadProfile: bad argument #1 type \(profile name as string expected, got table!\)/);
  });
});
