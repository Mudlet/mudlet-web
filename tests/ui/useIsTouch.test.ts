import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useIsTouch, useIsMobile } from '../../src/hooks/useViewportMode';

// The breakpoints say how much room the UI has; they do not say what covers
// that room when the player types. mudlet.org embeds this client in a 563px
// frame on desktops of any size — phone-sized by the breakpoints, driven by a
// mouse, with no on-screen keyboard to hide behind — so anything that exists
// *because* of that keyboard has to ask the pointer instead of the width.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Stands in for window.matchMedia, answering `true` only for `matching`.
 *  Returns the listener registry, so a test can assert the hook subscribes
 *  rather than sampling once — a device can change pointer under it. */
function stubMatchMedia(matching: string[]) {
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: matching.includes(query),
        media: query,
        addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
        removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    }));
    return listeners;
}

/** Renders a probe that just reports what the two hooks make of the stub. */
function read(): { mobile: boolean; touch: boolean } {
    const seen = { mobile: false, touch: false };
    function Probe() {
        seen.mobile = useIsMobile();
        seen.touch = useIsTouch();
        return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(createElement(Probe)); });
    return seen;
}

afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
});

const NARROW = ['(max-width: 600px)', '(max-width: 900px)'];

describe('useIsTouch', () => {
    it('is true when the primary pointer is coarse', () => {
        stubMatchMedia(['(pointer: coarse)']);
        expect(read().touch).toBe(true);
    });

    it('is false for a mouse, however narrow the window', () => {
        stubMatchMedia(NARROW);
        expect(read().touch).toBe(false);
    });

    it('subscribes, and lets go on unmount', () => {
        const listeners = stubMatchMedia([]);
        read();
        expect(listeners.size).toBeGreaterThan(0);
        act(() => { root!.unmount(); });
        root = null;
        expect(listeners.size).toBe(0);
    });

    /** The regression this exists for: blurring the command box on width alone
     *  took the caret away from every desktop visitor to mudlet.org's front
     *  page after every command they sent. */
    it('separates a narrow embed on a desktop from a real phone', () => {
        // matchMedia is only how these hooks *subscribe*; the width itself is
        // read off the window, so a narrow viewport has to be stubbed there.
        vi.stubGlobal('innerWidth', 563);

        stubMatchMedia(NARROW);
        expect(read()).toEqual({ mobile: true, touch: false });

        act(() => { root!.unmount(); });
        host!.remove();
        root = null;

        vi.stubGlobal('innerWidth', 563);
        stubMatchMedia([...NARROW, '(pointer: coarse)']);
        expect(read()).toEqual({ mobile: true, touch: true });
    });
});
