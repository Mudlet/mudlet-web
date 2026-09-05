/**
 * Keep the browser's page pinch-zoom out of the map panel, which implements its
 * OWN pinch-to-zoom — without this, a two-finger drag on the map zooms the map
 * *and* the page at the same time.
 *
 * Everywhere else the page zooms normally. It used to be suppressed app-wide
 * (plus `maximum-scale=1, user-scalable=no` in the viewport meta), on the theory
 * that a fixed app UI only ever gets zoomed by accident. That reasoning does not
 * survive contact with a text-dense console: pinch zoom is the magnification
 * affordance a low-vision user reaches for first, and taking it away fails
 * WCAG 1.4.4 (Resize text). The accidental-zoom annoyance is the cheaper cost.
 *
 * iOS Safari reports pinch via the non-standard `gesture*` events rather than
 * multi-touch `touchmove`, so both paths are handled.
 */
const MAP_SELECTOR = '.map-panel';

function inMap(target: EventTarget | null): boolean {
    const el = target as Element | null;
    return !!el && typeof el.closest === 'function' && el.closest(MAP_SELECTOR) !== null;
}

export function installPinchZoomGuard(): void {
    // iOS Safari: pinch is reported via non-standard gesture* events; cancelling
    // the start aborts the page zoom so only the map's own zoom runs.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        document.addEventListener(type, (e) => {
            if (inMap(e.target)) e.preventDefault();
        }, { passive: false });
    }

    // Everywhere else: a 2-finger touchmove is a pinch. Single-finger scrolling
    // (touches.length === 1) is never touched, so normal scroll is unaffected.
    document.addEventListener('touchmove', (e) => {
        if (e.touches.length > 1 && inMap(e.target)) e.preventDefault();
    }, { passive: false });
}
