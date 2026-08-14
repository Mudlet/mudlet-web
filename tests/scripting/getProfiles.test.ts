// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';

// getProfiles() returns a table keyed by profile name with one entry per
// configured connection: { host, port, loaded, connected, description }. In the
// Node test env there's no Web Locks API, so `loaded` collapses to just the
// active profile and `connected` reflects the (disconnected) session — exactly
// the graceful-degradation path. We assert the shape and the per-field sourcing.
describe('getProfiles', () => {
  let env: TestRuntime;

  beforeEach(async () => {
    env = await createTestRuntime();
    // A second, NOT-open connection (mud mode) to prove host/port/description
    // come from the connection record and that loaded/connected are false.
    useAppStore.setState(s => ({
      connections: [
        ...s.connections.filter(c => c.id !== 'other-profile'),
        { id: 'other-profile', name: 'Other', mode: 'mud', host: 'mud.example.com', port: 4000, description: 'A second world' },
      ],
    }));
  });

  afterEach(() => {
    env.dispose();
    useAppStore.setState(s => ({ connections: s.connections.filter(c => c.id !== 'other-profile') }));
  });

  it('returns an entry per connection keyed by name', () => {
    const keys = env.run('local t = {} for k in pairs(getProfiles()) do t[#t+1] = k end table.sort(t) return table.concat(t, ",")');
    expect(keys).toBe('Other,Test');
  });

  it('reports host/port and description from the connection record', () => {
    expect(env.run('return getProfiles().Other.host')).toBe('mud.example.com');
    // Strings, as Mudlet reports them (Miscallaneous_spec asserts the type).
    expect(env.run('return getProfiles().Other.port')).toBe('4000');
    expect(env.run('return getProfiles().Other.description')).toBe('A second world');
    // ws-mode active profile: host/port parsed from ws://localhost (ws → :80).
    expect(env.run('return getProfiles().Test.host')).toBe('localhost');
    expect(env.run('return getProfiles().Test.port')).toBe('80');
  });

  it('marks the active profile loaded and others not (no Web Locks in node)', () => {
    expect(env.run('return getProfiles().Test.loaded')).toBe(true);
    expect(env.run('return getProfiles().Other.loaded')).toBe(false);
  });

  it('reports connected=false for a disconnected session', () => {
    expect(env.run('return getProfiles().Test.connected')).toBe(false);
    // Absent, not false, for a profile that isn't open: only a loaded profile
    // has a connection to report on (Miscallaneous_spec asserts the nil).
    expect(env.run('return getProfiles().Other.connected')).toBeNull();
  });

  it('setProfileInformation writes the connection description that getProfiles reads', () => {
    expect(env.run('setProfileInformation("hello world") return getProfileInformation()')).toBe('hello world');
    expect(env.run('return getProfiles().Test.description')).toBe('hello world');
    // clearProfileInformation empties it.
    expect(env.run('clearProfileInformation() return getProfiles().Test.description')).toBe('');
  });
});
