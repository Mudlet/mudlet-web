/**
 * The usage-analytics opt-out.
 *
 * The Matomo snippet in `index.html` runs before any module loads, so the
 * opt-out cannot live in the Zustand store the way every other preference does
 * — by the time `mudix_v1` has been read and hydrated, the tracker has already
 * fired. It gets its own localStorage key instead, written here and read by
 * that inline script with a bare `localStorage.getItem`.
 *
 * Desktop gates its nearest equivalent behind an explicit Always / Ask each
 * time / Never choice (`comboBox_crashReportPolicy`); the web build had no
 * switch at all, which is what this fixes.
 *
 * Client-wide rather than per-profile: a page view is not attributable to a
 * profile, and a player who does not want to be counted does not want to be
 * counted on their other characters either.
 */

/** Also spelled literally in `index.html` — keep the two in step. */
export const ANALYTICS_OPT_OUT_KEY = 'mudix_analytics_opt_out';

/** True when the user has asked not to be counted. Defaults to false (counted),
 *  and answers false when storage is unavailable — matching what the inline
 *  script does, so the toggle never claims a state the tracker disagrees with. */
export function analyticsOptedOut(): boolean {
    try {
        return localStorage.getItem(ANALYTICS_OPT_OUT_KEY) === '1';
    } catch {
        return false;
    }
}

/** Takes effect on the next page load: the tracker for this one has already
 *  run, and Matomo offers no way to un-send a page view. The Settings row says
 *  so rather than implying otherwise. */
export function setAnalyticsOptedOut(optedOut: boolean): void {
    try {
        if (optedOut) localStorage.setItem(ANALYTICS_OPT_OUT_KEY, '1');
        else localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
    } catch {
        // Private mode, or site data blocked. Nothing to do — and in that state
        // the tracker's own cookie is equally unavailable.
    }
}
