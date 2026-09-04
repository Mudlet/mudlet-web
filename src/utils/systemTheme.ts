// Following the operating system's light/dark setting.
//
// Every theme this client ships is a concrete palette, so "System setting" is
// not one of them — it is a *stored choice* that resolves to one of them at
// read time. Desktop's `comboBox_appearance` (ui/profile_preferences.ui:261)
// offers the same three: Dark / Light / System setting.
//
// Keeping the sentinel out of everything downstream is deliberate. `data-theme`
// only ever carries a real palette id, so the whole stylesheet — brand themes
// included — needs no `prefers-color-scheme` rules of its own, and a brand that
// ships its own themes gets system-following for free.

import { isLightTheme } from '../branding';
import type { Theme } from '../storage/schema';

/** The stored value meaning "whatever the OS is set to". Never reaches
 *  `data-theme`; {@link resolveTheme} turns it into a real palette first. */
export const SYSTEM_THEME = 'system';

/** The palettes `system` resolves to. Deliberately the two plain ones rather
 *  than a brand's: a brand that wants different ones sets `availableThemes` and
 *  drops `system` from the list. */
const SYSTEM_DARK: Theme = 'dark';
const SYSTEM_LIGHT: Theme = 'light';

const QUERY = '(prefers-color-scheme: dark)';

function media(): MediaQueryList | null {
    if (typeof window === 'undefined' || !window.matchMedia) return null;
    try {
        return window.matchMedia(QUERY);
    } catch {
        // matchMedia exists but rejects the query (very old engines, some test
        // stubs). Treated as "no preference expressed".
        return null;
    }
}

/** Whether the OS is asking for a dark UI right now. Defaults to dark when
 *  nothing can be asked, which is this app's own default. */
export function prefersDark(): boolean {
    return media()?.matches ?? true;
}

/**
 * The concrete palette to render: `theme` itself, unless it is the system
 * sentinel. Safe to call with any stored value, including one from a brand.
 */
export function resolveTheme(theme: Theme | undefined): Theme {
    if (theme !== SYSTEM_THEME) return theme ?? SYSTEM_DARK;
    return prefersDark() ? SYSTEM_DARK : SYSTEM_LIGHT;
}

/** `isLightTheme` through {@link resolveTheme}, for callers holding a stored
 *  value rather than a resolved one (the editor's syntax palette). */
export function isLightResolvedTheme(theme: Theme | undefined): boolean {
    return isLightTheme(resolveTheme(theme));
}

/**
 * Call `onChange` whenever the OS preference flips, so a theme left on "System
 * setting" repaints without a reload. Returns an unsubscribe.
 *
 * Subscribed unconditionally rather than only while `system` is selected: the
 * listener is one boolean check, and gating it on the current value would mean
 * re-subscribing every time the theme changes for no saving worth having.
 */
export function onSystemThemeChange(onChange: () => void): () => void {
    const mq = media();
    if (!mq) return () => {};
    const handler = () => onChange();
    // addEventListener is the modern spelling; Safari below 14 only has
    // addListener, and it is still in the field on older iPads.
    if (mq.addEventListener) {
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
}
