import { createContext, createElement, useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/**
 * Responsive breakpoints (px). Kept in sync with the `--bp-*` tokens and the
 * `@media` blocks in App.css — change them in both places.
 *   mobile  : width ≤ 600            (phones — single-column layout branch)
 *   tablet  : 601 ≤ width ≤ 900      (fluid modals, desktop-ish layout)
 *   desktop : width > 900            (full dock/float UX)
 */
export const MOBILE_MAX_WIDTH = 600;
export const TABLET_MAX_WIDTH = 900;

export type ViewportMode = 'mobile' | 'tablet' | 'desktop';

function modeFor(width: number): ViewportMode {
    if (width <= MOBILE_MAX_WIDTH) return 'mobile';
    if (width <= TABLET_MAX_WIDTH) return 'tablet';
    return 'desktop';
}

function readMode(): ViewportMode {
    if (typeof window === 'undefined') return 'desktop';
    return modeFor(window.innerWidth);
}

/** Set by ViewportModeProvider. Null means "nobody is measuring a container —
 *  fall back to the window", which is what the connection screen does. */
const ViewportModeContext = createContext<ViewportMode | null>(null);

/**
 * matchMedia is the cheap, debounced-by-the-browser way to subscribe: we only
 * re-render when crossing a breakpoint, not on every resize pixel. We listen on
 * both boundaries and recompute the mode from innerWidth on either change.
 */
function subscribe(onChange: () => void): () => void {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const queries = [
        window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`),
        window.matchMedia(`(max-width: ${TABLET_MAX_WIDTH}px)`),
    ];
    for (const q of queries) q.addEventListener('change', onChange);
    return () => {
        for (const q of queries) q.removeEventListener('change', onChange);
    };
}

/** Current responsive mode, re-rendering the caller when it changes. Reads the
 *  nearest measured container, and the window when there is not one. */
export function useViewportMode(): ViewportMode {
    const fromContainer = useContext(ViewportModeContext);
    const fromWindow = useSyncExternalStore<ViewportMode>(subscribe, readMode, () => 'desktop');
    return fromContainer ?? fromWindow;
}

/** Convenience: true on phone-sized viewports (the single-column layout branch). */
export function useIsMobile(): boolean {
    return useViewportMode() === 'mobile';
}

const COARSE_POINTER = '(pointer: coarse)';

function subscribeTouch(onChange: () => void): () => void {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const query = window.matchMedia(COARSE_POINTER);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

function readTouch(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(COARSE_POINTER).matches;
}

/**
 * Whether the primary pointer is a touch screen — which is really the question
 * "is there an on-screen keyboard", and a different question from the one the
 * breakpoints above answer.
 *
 * Width says how much room the UI has. It does not say what covers that room
 * when the player types, and those two come apart exactly where this client is
 * embedded: the hero on mudlet.org is a 563px frame on a desktop of any size,
 * so it is phone-sized by every measure the layout cares about and has no
 * keyboard to hide behind. Anything that exists *because* of the on-screen
 * keyboard has to ask this rather than the breakpoint, or it fires on a mouse.
 *
 * Note this is the primary pointer: a laptop with a touch screen and a
 * trackpad reports fine, which is the answer we want — it has a real keyboard.
 */
export function useIsTouch(): boolean {
    return useSyncExternalStore<boolean>(subscribeTouch, readTouch, () => false);
}

/**
 * The same breakpoints, measured against an element instead of the window.
 *
 * The window is the wrong ruler when the client is not the whole page. Mudlet
 * Web is embedded in a ~560px frame on mudlet.org, and `window.innerWidth`
 * inside that frame is 560 — so the client concluded it was on a phone and
 * switched to the single-column layout, putting its panels behind a tab strip
 * on a 2560px screen. What decides the layout is how much room the client has,
 * which is what its own root element knows.
 *
 * Thresholds are unchanged: a full-window client on a real phone still measures
 * a phone-sized root and still gets the phone layout.
 */
export function useElementViewportMode(element: HTMLElement | null): ViewportMode {
    const [mode, setMode] = useState<ViewportMode>(() =>
        element ? modeFor(element.clientWidth) : readMode());

    useLayoutEffect(() => {
        if (!element || typeof ResizeObserver === 'undefined') return;

        // The functional form is the whole debounce: a ResizeObserver fires on
        // every pixel, and returning the previous value makes React bail out of
        // the render entirely. Only a crossed breakpoint reaches the tree.
        const apply = (width: number) =>
            setMode(prev => {
                const next = modeFor(width);
                return next === prev ? prev : next;
            });

        apply(element.clientWidth);
        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            apply(entry ? entry.contentRect.width : element.clientWidth);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);

    return mode;
}

/**
 * Publishes the mode measured from `element` to everything below it. Consumers
 * that are not under a provider — the connection screen, tests — keep reading
 * the window, so this is additive.
 */
export function ViewportModeProvider(
    { element, children }: { element: HTMLElement | null; children: ReactNode },
) {
    const mode = useElementViewportMode(element);
    return createElement(ViewportModeContext.Provider, { value: mode }, children);
}
