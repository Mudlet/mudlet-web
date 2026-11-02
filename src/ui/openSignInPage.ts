/**
 * Open a sign-in page in a new tab without asking, as Mudlet does with
 * `QDesktopServices::openUrl`. A page may only open a tab while it holds
 * transient user activation — a few seconds after a click or key press — and
 * a GMCP `Char.Login.URL` usually lands well inside that window, because it
 * answers the menu choice the player just typed. Outside it the browser would
 * block the popup, so this returns false without trying and the caller falls
 * back to the sign-in dialog, whose button is a gesture of its own.
 *
 * Opened blank first, so whether the browser allowed it is known (a
 * `noopener` open always returns null), then cut off from us before it
 * navigates: the provider's page gets no handle back on ours.
 */
export function openSignInPage(url: string, win: Window = window): boolean {
    const activation = (win.navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (!activation?.isActive) return false;
    let tab: Window | null;
    try {
        tab = win.open('about:blank', '_blank');
    } catch {
        return false;
    }
    if (!tab) return false;
    try {
        tab.opener = null;
        tab.location.href = url;
    } catch {
        tab.close();
        return false;
    }
    return true;
}
