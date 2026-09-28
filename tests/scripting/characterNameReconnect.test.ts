// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';

const setLogin = (account: string | undefined) => useAppStore.setState(s => ({
    connections: s.connections.map(c => c.id === TEST_CONNECTION_ID ? { ...c, charLoginAccount: account } : c),
}));

// Issue #237.
describe('getCharacterName()', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); setLogin(undefined); });
    afterEach(() => { setLogin(undefined); env.dispose(); });

    // TLuaInterpreter::getCharacterName reads Host::getLogin() — the character
    // the profile logs in as, not the profile's own name.
    it('answers nil + "no character name set" when no login is saved', () => {
        expect(env.run('local n, e = getCharacterName(); return tostring(n) .. "|" .. tostring(e)'))
            .toBe('nil|no character name set');
    });

    it('is not the profile name', () => {
        env.api.profileName = 'Achaea';
        expect(env.run('return getProfileName()')).toBe('Achaea');
        expect(env.run('return (getCharacterName())')).toBeNull();
    });

    it('answers the saved login name', () => {
        setLogin('Pp-vcn');
        expect(env.run('return (getCharacterName())')).toBe('Pp-vcn');
        expect(env.run('return select("#", getCharacterName())')).toBe(1);
    });
});

describe('reconnect()', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    // Desktop's returns nothing at all — the outcome arrives as an event.
    it('returns nothing', () => {
        expect(env.run('return select("#", reconnect())')).toBe(0);
    });
});
