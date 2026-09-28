// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';
import { ProfilesPresence } from '../../src/scripting/profilesPresence';

// closeProfile(name) closes an open profile: this one, or one open in another
// tab, which is asked to close itself over the profiles-presence channel. It
// answers true, or nil plus "closeProfile: profile 'x' does not exist" — the
// shape desktop Mudlet's TLuaInterpreter::closeProfile returns.
describe('closeProfile', () => {
  let env: TestRuntime;
  let presence: { loadedIds: () => string[]; requestClose: (id: string) => boolean };

  beforeEach(async () => {
    env = await createTestRuntime();
    presence = (env.api as unknown as { presence: typeof presence }).presence;
    useAppStore.setState(s => ({
      connections: [
        ...s.connections.filter(c => c.id !== 'other-profile'),
        { id: 'other-profile', name: 'Other', url: 'ws://localhost' },
      ],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    env.dispose();
    useAppStore.setState(s => ({ connections: s.connections.filter(c => c.id !== 'other-profile') }));
  });

  it('is a function', () => {
    expect(env.run('return type(closeProfile)')).toBe('function');
  });

  it('returns nil and a message for an unknown profile', () => {
    expect(env.run('local ok, err = closeProfile("Nope") return tostring(ok) .. "|" .. err'))
      .toBe("nil|closeProfile: profile 'Nope' does not exist");
  });

  it('returns nil and a message for a configured profile that is not open', () => {
    expect(env.run('local ok, err = closeProfile("Other") return tostring(ok) .. "|" .. err'))
      .toBe("nil|closeProfile: profile 'Other' does not exist");
  });

  it('closes this profile after the calling script has returned', () => {
    vi.useFakeTimers();
    const closed = vi.fn();
    env.api.setCloseProfileCallback(closed);
    expect(env.run('local ok = closeProfile("Test") return ok')).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('asks the tab holding another open profile to close it', () => {
    presence.loadedIds = () => ['test-connection', 'other-profile'];
    const requested: string[] = [];
    presence.requestClose = (id) => { requested.push(id); return true; };
    expect(env.run('return closeProfile("Other")')).toBe(true);
    expect(requested).toEqual(['other-profile']);
  });

  it('raises for a name that is not a string', () => {
    expect(() => env.run('closeProfile()'))
      .toThrow(/closeProfile: bad argument #1 type \(profile name as string expected, got nil!\)/);
  });
});

describe('ProfilesPresence close requests', () => {
  it('delivers a close request to the tab that owns the profile, and only to it', async () => {
    const a = new ProfilesPresence('profile-a', () => false);
    const b = new ProfilesPresence('profile-b', () => false);
    const c = new ProfilesPresence('profile-c', () => false);
    const bClosed = vi.fn();
    const cClosed = vi.fn();
    b.onCloseRequested = bClosed;
    c.onCloseRequested = cClosed;
    try {
      expect(a.requestClose('profile-b')).toBe(true);
      await vi.waitFor(() => expect(bClosed).toHaveBeenCalledTimes(1));
      expect(cClosed).not.toHaveBeenCalled();
    } finally {
      a.destroy();
      b.destroy();
      c.destroy();
    }
  });
});
