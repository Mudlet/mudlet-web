// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { useAppStore, selectProfileField } from '../../src/storage';

/**
 * A script's setServerEncoding() is saved to the profile, as
 * cTelnet::setEncoding(…, saveValue = true) writes it in Mudlet — so the next
 * session opens on it, not back on UTF-8 (Mudlet/mudlet-web#191).
 */
describe('setServerEncoding from a script', () => {
    let t: TestRuntime;
    const saved = () => selectProfileField(useAppStore.getState(), TEST_CONNECTION_ID, 'serverEncoding');

    beforeEach(async () => {
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { serverEncoding: undefined });
        t = await createTestRuntime();
    });
    afterEach(() => t.dispose());

    it('saves the encoding, in the list\'s own spelling', () => {
        expect(t.run('return setServerEncoding("iso-8859-2")')).toBe(true);
        expect(saved()).toBe('ISO 8859-2');
        expect(t.run('return setServerEncoding("CP866")')).toBe(true);
        expect(saved()).toBe('CP866');
    });

    it('saves nothing for one it refuses', () => {
        t.run('setServerEncoding("GBK")');
        t.run('__r = {setServerEncoding("CP1161")}');
        expect(t.run('return __r[1]')).toBeNull();
        expect(String(t.run('return __r[2]'))).toContain('Encoding "CP1161" does not exist');
        expect(saved()).toBe('GBK');
    });
});
