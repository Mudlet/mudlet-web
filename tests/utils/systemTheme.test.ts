// "System setting" appearance (issue #71).
//
// The app had no way to follow the OS: the theme list offered five concrete
// palettes and nothing that tracked `prefers-color-scheme`, and the string did
// not occur anywhere in the source tree. Desktop's `comboBox_appearance`
// (ui/profile_preferences.ui:261) offers Dark / Light / System setting.
//
// `system` is a stored choice rather than a palette, so what these pin is that
// it never escapes as one: `data-theme` and every palette lookup see a concrete
// id, whatever is stored.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Listener = () => void;

/** A controllable `matchMedia` for `(prefers-color-scheme: dark)`. */
function installMatchMedia(dark: boolean, opts: { legacy?: boolean; absent?: boolean } = {}) {
    const listeners: Listener[] = [];
    const mq = {
        matches: dark,
        media: '(prefers-color-scheme: dark)',
        ...(opts.legacy
            ? {
                addListener: (fn: Listener) => { listeners.push(fn); },
                removeListener: (fn: Listener) => { listeners.splice(listeners.indexOf(fn), 1); },
            }
            : {
                addEventListener: (_: string, fn: Listener) => { listeners.push(fn); },
                removeEventListener: (_: string, fn: Listener) => { listeners.splice(listeners.indexOf(fn), 1); },
            }),
    };
    const w = globalThis as unknown as { window?: unknown };
    w.window = opts.absent ? {} : { matchMedia: () => mq };
    return {
        listeners,
        flip(next: boolean) { mq.matches = next; listeners.forEach(fn => fn()); },
    };
}

const original = (globalThis as unknown as { window?: unknown }).window;
afterEach(() => {
    (globalThis as unknown as { window?: unknown }).window = original;
    vi.resetModules();
});

/** Imported fresh each time so the module reads the matchMedia just installed. */
async function load() {
    return await import('../../src/utils/systemTheme');
}

describe('resolveTheme', () => {
    beforeEach(() => { vi.resetModules(); });

    it('leaves a concrete palette exactly as it is', async () => {
        installMatchMedia(true);
        const { resolveTheme } = await load();
        for (const theme of ['dark', 'light', 'amber', 'sky', 'graylight', 'someBrandTheme']) {
            expect(resolveTheme(theme)).toBe(theme);
        }
    });

    it('resolves the sentinel to dark when the OS asks for dark', async () => {
        installMatchMedia(true);
        const { resolveTheme, SYSTEM_THEME } = await load();
        expect(resolveTheme(SYSTEM_THEME)).toBe('dark');
    });

    it('resolves the sentinel to light when the OS asks for light', async () => {
        installMatchMedia(false);
        const { resolveTheme, SYSTEM_THEME } = await load();
        expect(resolveTheme(SYSTEM_THEME)).toBe('light');
    });

    it('never returns the sentinel itself — nothing downstream can render it', async () => {
        for (const dark of [true, false]) {
            vi.resetModules();
            installMatchMedia(dark);
            const { resolveTheme, SYSTEM_THEME } = await load();
            expect(resolveTheme(SYSTEM_THEME)).not.toBe(SYSTEM_THEME);
        }
    });

    it('falls back to dark when there is no matchMedia to ask', async () => {
        // A test environment, an old engine, or an embedder that stubs window.
        installMatchMedia(false, { absent: true });
        const { resolveTheme, SYSTEM_THEME, prefersDark } = await load();
        expect(prefersDark()).toBe(true);
        expect(resolveTheme(SYSTEM_THEME)).toBe('dark');
    });

    it('treats an unset theme as dark, the app default', async () => {
        installMatchMedia(true);
        const { resolveTheme } = await load();
        expect(resolveTheme(undefined)).toBe('dark');
    });
});

describe('isLightResolvedTheme', () => {
    beforeEach(() => { vi.resetModules(); });

    it('answers for the sentinel by resolving it first', async () => {
        installMatchMedia(false);
        const { isLightResolvedTheme, SYSTEM_THEME } = await load();
        expect(isLightResolvedTheme(SYSTEM_THEME)).toBe(true);
    });

    it('still answers for concrete palettes', async () => {
        installMatchMedia(true);
        const { isLightResolvedTheme } = await load();
        expect(isLightResolvedTheme('light')).toBe(true);
        expect(isLightResolvedTheme('graylight')).toBe(true);
        expect(isLightResolvedTheme('dark')).toBe(false);
        expect(isLightResolvedTheme('amber')).toBe(false);
    });
});

describe('onSystemThemeChange', () => {
    beforeEach(() => { vi.resetModules(); });

    it('fires when the OS preference flips, so System repaints without a reload', async () => {
        const mm = installMatchMedia(true);
        const { onSystemThemeChange, resolveTheme, SYSTEM_THEME } = await load();
        const seen: string[] = [];
        const stop = onSystemThemeChange(() => seen.push(resolveTheme(SYSTEM_THEME)));

        mm.flip(false);
        mm.flip(true);
        expect(seen).toEqual(['light', 'dark']);

        stop();
        mm.flip(false);
        expect(seen).toEqual(['light', 'dark']);
    });

    it('supports the legacy addListener spelling', async () => {
        // Safari below 14 has no addEventListener on a MediaQueryList, and is
        // still in the field on older iPads.
        const mm = installMatchMedia(true, { legacy: true });
        const { onSystemThemeChange } = await load();
        let fired = 0;
        const stop = onSystemThemeChange(() => { fired++; });
        mm.flip(false);
        expect(fired).toBe(1);
        stop();
        mm.flip(true);
        expect(fired).toBe(1);
    });

    it('is a no-op, not a crash, where matchMedia is absent', async () => {
        installMatchMedia(true, { absent: true });
        const { onSystemThemeChange } = await load();
        const stop = onSystemThemeChange(() => { throw new Error('should not fire'); });
        expect(() => stop()).not.toThrow();
    });
});

describe('the theme choice list', () => {
    it('offers System setting, and keeps a concrete palette first', async () => {
        installMatchMedia(true);
        const { getThemeChoices } = await import('../../src/branding');
        const choices = getThemeChoices();
        expect(choices.some(c => c.value === 'system')).toBe(true);
        // MudletWebApp falls back to choices[0] for an unknown stored theme, so
        // the first entry has to be something that can actually be rendered.
        expect(choices[0].value).not.toBe('system');
    });
});
