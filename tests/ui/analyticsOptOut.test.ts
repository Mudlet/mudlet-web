import { describe, it, expect, beforeEach } from 'vitest';
// Read through Vite, like the help topics: the suite runs under happy-dom,
// where import.meta.url is not a file: URL and node:fs cannot resolve it.
import indexHtml from '../../index.html?raw';
import { ANALYTICS_OPT_OUT_KEY, analyticsOptedOut, setAnalyticsOptedOut } from '../../src/analytics';

beforeEach(() => localStorage.clear());

describe('analytics opt-out', () => {
    it('counts you by default', () => {
        expect(analyticsOptedOut()).toBe(false);
    });

    it('round-trips through localStorage', () => {
        setAnalyticsOptedOut(true);
        expect(analyticsOptedOut()).toBe(true);
        setAnalyticsOptedOut(false);
        expect(analyticsOptedOut()).toBe(false);
    });

    it('clears the key rather than storing a falsy value', () => {
        setAnalyticsOptedOut(true);
        setAnalyticsOptedOut(false);
        // A leftover "0" would be read as opted-in by the inline script's
        // `=== '1'` test anyway, but leaving nothing behind is the honest state.
        expect(localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBeNull();
    });

    it('survives storage that throws', () => {
        const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem');
        Storage.prototype.getItem = () => { throw new Error('site data blocked'); };
        try {
            // Private mode / blocked site data must not take the settings dialog
            // down with it; the tracker's own cookie is equally unavailable there.
            expect(() => analyticsOptedOut()).not.toThrow();
            expect(analyticsOptedOut()).toBe(false);
        } finally {
            if (original) Object.defineProperty(Storage.prototype, 'getItem', original);
        }
    });

    it('uses the same key index.html reads before any module loads', () => {
        // The tracker fires before the store hydrates, so it reads the key with
        // a bare localStorage.getItem. Nothing but this test ties the two
        // spellings together — drift would silently re-enable tracking for
        // everyone who had opted out.
        expect(indexHtml).toContain(`localStorage.getItem('${ANALYTICS_OPT_OUT_KEY}')`);
        expect(indexHtml).toContain(`=== '1'`);
    });
});
