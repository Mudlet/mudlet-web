// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { ALL_DEFAULTS } from '../../src/import/defaultPackages';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * The starter UI wants MSDP negotiated so games that have it but lack GMCP still
 * get gauges. It used to say so with a bare `setConfig("enableMSDP", true)` in
 * its load script — and a package's scripts run at *every* profile open, not
 * only at install. So a player who turned MSDP off in the preferences had the
 * setting quietly rewritten at the next reload: off for the session, on again
 * afterwards, with nothing to say the choice had been discarded. It contradicted
 * `PROTOCOL_DEFAULTS.msdp === false` and the setting's own help text, and no
 * other protocol toggle behaved that way, which is what made it look like MSDP
 * alone would not persist.
 *
 * The seed is now guarded by a flag in the package's settings file — the same
 * one-time-state file `announced`, `hidden` and `standingAside` already use — so
 * it happens once and a later choice stands.
 *
 * The block is lifted out of the asset `defaultPackages.ts` actually installs
 * rather than restated here, so this fails if a re-sync drops the patch
 * (scripts/mudlet-lua-patches/packages/) or the list switches back to the
 * unpatched `.mpackage`.
 */

/** Repo path of whatever asset BASE_UI declares. */
const ASSET_PATHS: Record<string, string> = {
    'mudlet-base-ui.xml': 'src/import/defaults/mudlet-base-ui/mudlet-base-ui.xml',
    'mudlet-base-ui.mpackage': 'src/import/defaults/mudlet-base-ui/mudlet-base-ui.mpackage',
};

/** The package XML as shipped, whether that is a loose file or inside the zip. */
function shippedXml(): string {
    const def = ALL_DEFAULTS.find(d => d.name === 'mudlet-base-ui');
    expect(def, 'mudlet-base-ui is no longer a bundled default').toBeTruthy();
    const path = ASSET_PATHS[def!.filename];
    expect(path, `add ${def!.filename} to ASSET_PATHS`).toBeTruthy();
    const bytes = new Uint8Array(readFileSync(path));
    if (!def!.filename.endsWith('.mpackage')) return new TextDecoder().decode(bytes);
    const entry = unzipSync(bytes)['mudlet-base-ui.xml'];
    expect(entry, `mudlet-base-ui.xml not found in ${path}`).toBeTruthy();
    return new TextDecoder().decode(entry);
}

/** The load script's MSDP stanza, verbatim. */
function seedBlock(): string {
    const xml = shippedXml();
    const start = xml.indexOf('-- negotiate MSDP up front');
    expect(start, 'the MSDP stanza is gone from the package').toBeGreaterThan(-1);
    const end = xml.indexOf('onEvent("gmcp.Char.Vitals"', start);
    expect(end, 'end of the MSDP stanza not found').toBeGreaterThan(start);
    // The package is XML, so its Lua arrives entity-encoded.
    return xml.slice(start, end)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

describe('starter UI MSDP seed', () => {
    let rt: TestRuntime;
    beforeAll(async () => { rt = await createTestRuntime(); });
    afterAll(() => rt.dispose());

    /**
     * Run the stanza `opens` times over one settings table, as reopening the
     * profile would: `BaseUI.loadSettings()` reads the flag back off disk each
     * open, so a table that survives the runs stands in for the file. Returns
     * every setConfig the stanza made.
     */
    const configWrites = (opens: number): string[] => {
        rt.run(`
            BaseUI = { settings = {} }
            function BaseUI.saveSettings() BaseUI.saved = (BaseUI.saved or 0) + 1 end
            __seedWrites = {}
            function setConfig(key, value)
              __seedWrites[#__seedWrites + 1] = tostring(key) .. "=" .. tostring(value)
            end
        `);
        const block = seedBlock();
        for (let i = 0; i < opens; i++) rt.run(block);
        const joined = rt.run('return table.concat(__seedWrites, ",")') as string;
        return joined ? joined.split(',') : [];
    };

    it('asks for MSDP on the first profile open', () => {
        expect(configWrites(1)).toEqual(['enableMSDP=true']);
    });

    it('does not ask again on later opens, so the player\'s choice stands', () => {
        // The defect: every open rewrote the preference, so turning MSDP off in
        // the preferences never survived a reload.
        expect(configWrites(5)).toEqual(['enableMSDP=true']);
    });

    it('persists the flag rather than keeping it in memory', () => {
        // Nothing is remembered across opens unless it reaches the settings
        // file, so the seed has to save as well as set.
        configWrites(1);
        expect(rt.run('return BaseUI.saved') as number).toBeGreaterThan(0);
        expect(rt.run('return BaseUI.settings.msdpSeeded') as boolean).toBe(true);
    });
});
