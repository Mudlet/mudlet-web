import { describe, it, expect } from 'vitest';
import { CLIENT_NAME, CLIENT_VERSION, TERMINAL_TYPE, GIT_COMMIT } from '../../../src/version';
import { buildNewEnvironVars } from '../../../src/mud/protocol/mnes';
import pkg from '../../../package.json';

// The client's wire identity used to be spelled three ways across four
// protocols, with two different version numbers (MNES said "0.1.0", MXP said
// "1.0"), while the About dialog reported a third, hardcoded "0.0.1".
// src/version.ts is now the single source; these tests keep it that way.
describe('client identity', () => {
    // Guards the Vite `define` wiring in buildInfo.ts, not a hand-kept copy:
    // if the substitution breaks, CLIENT_VERSION is undefined and this fails.
    it('reports the package version', () => {
        expect(CLIENT_VERSION).toBe(pkg.version);
        expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('exposes a build hash, or an empty string where git is unavailable', () => {
        expect(typeof GIT_COMMIT).toBe('string');
        if (GIT_COMMIT) expect(GIT_COMMIT).toMatch(/^[0-9a-f]{7,40}$/);
    });

    it('uses an uppercase token distinct from desktop Mudlet', () => {
        // Server authors feature-detect off this; Mudlet Web is not
        // feature-identical to desktop Mudlet, so it must not claim to be it.
        expect(CLIENT_NAME).toBe('MUDLET-WEB');
        expect(CLIENT_NAME).not.toBe('MUDLET');
        expect(CLIENT_NAME).toBe(CLIENT_NAME.toUpperCase());
    });

    it('feeds the MNES core variables from the shared constants', () => {
        const vars = buildNewEnvironVars(
            { charset: 'UTF-8', utf8: true, wordWrap: 100 },
            false,
        );
        expect(vars).toContainEqual({ name: 'CLIENT_NAME', value: CLIENT_NAME });
        expect(vars).toContainEqual({ name: 'CLIENT_VERSION', value: CLIENT_VERSION });
        expect(vars).toContainEqual({ name: 'TERMINAL_TYPE', value: TERMINAL_TYPE });
    });
});
