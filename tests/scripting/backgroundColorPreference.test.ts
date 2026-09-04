// @vitest-environment node
//
// `getBackgroundColor()` ignored the profile's background preference (issue #71).
//
// The main-window branch read only `outputBackgroundColor` — the override
// `setBackgroundColor()` writes — and returned null without it, so the Lua
// wrapper substituted {0,0,0,255}. A user who set Settings → Colors → "Output
// background" saw the console repaint immediately and still got black back from
// the API, so a package colouring its Geyser UI to match the user's background
// (a very common pattern) rendered against black.
//
// Desktop reads the preference-backed model colour for the main window and says
// why: "the view's colour is a reference to this one, so read it straight from
// the model" (TLuaInterpreterUI.cpp:1217-1243).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';

describe('getBackgroundColor and the profile background preference', () => {
    let t: TestRuntime;

    beforeEach(async () => { t = await createTestRuntime(); });
    afterEach(() => { t.dispose(); });

    /** The four channels, as the Lua multi-return renders them. */
    const read = (arg = ''): string =>
        String(t.run(`return table.concat({getBackgroundColor(${arg})}, ",")`));

    const setPreference = (hex: string) => {
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { outputBackground: hex });
    };

    it('reports the preference the user set, not black', () => {
        setPreference('#301040');
        expect(read()).toBe('48,16,64,255');
    });

    it('answers the same for the explicit "main" form', () => {
        setPreference('#301040');
        expect(read('"main"')).toBe('48,16,64,255');
    });

    it('lets a script override still win, as setBackgroundColor promises', () => {
        setPreference('#301040');
        t.run('setBackgroundColor(1, 2, 3, 4)');
        expect(read()).toBe('1,2,3,4');
    });

    it('reports the preference again once the override is cleared', () => {
        setPreference('#301040');
        t.run('setBackgroundColor(1, 2, 3, 4)');
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { outputBackgroundColor: undefined });
        expect(read()).toBe('48,16,64,255');
    });

    it('is opaque — the preference is a hex colour and carries no alpha', () => {
        setPreference('#ffffff');
        expect(read()).toBe('255,255,255,255');
    });

    it('still returns nil for a window that does not exist', () => {
        // The miss case is unchanged: only the main window gained a fallback.
        expect(t.run('return (getBackgroundColor("noSuchWindowQA")) == nil')).toBe(true);
    });
});
