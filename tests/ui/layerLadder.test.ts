// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Read as text rather than imported: Vite hands a stylesheet to its CSS
// pipeline, and what comes back is a module, not the source these assertions
// are about.
const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

const layersCss = read('ui/layout/layers.css');
const appCss = read('App.css');
const scriptWindowCss = read('ui/layout/ScriptWindow.css');
const menuBarCss = read('ui/menu/MenuBar.css');
const buttonsBarCss = read('ui/buttons/ButtonsBar.css');

// The client's stacking order is one ladder (src/ui/layout/layers.css), and the
// surfaces that compare against each other name a rung on it rather than
// picking a number. This file pins the two things that made issue #145: the
// order of the rungs, and which rung each surface takes.
//
// Ordering is the part a stylesheet cannot check itself — every one of these
// rules reads fine on its own, and the bug was only in how two of them ranked.

/** `--z-foo: 40;` → { 'z-foo': 40 }, in declaration order. */
function tokens(css: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [, name, value] of css.matchAll(/--(z-[a-z-]+):\s*(\d+);/g)) {
        out.set(name, Number(value));
    }
    return out;
}

/** The z-index declared by the first rule whose selector list mentions
 *  `selector`, verbatim — so a `var(--…)` reference comes back as written.
 *  The class name must end where it is written, or `.modal` would answer with
 *  `.modal-overlay`'s value. */
function zIndexOf(css: string, selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`${escaped}(?![\\w-])[^{}]*\\{[^}]*?z-index:\\s*([^;]+);`);
    return css.match(rule)?.[1].trim() ?? null;
}

const LADDER = tokens(layersCss);

describe('the layer ladder', () => {
    // Bottom to top: what is inside a console, then the window frame, then the
    // things Mudlet makes real top-level windows of, then popups over all of it.
    const order = [
        'z-console-overlay',
        'z-console-caret',
        'z-console-find',
        'z-chrome',
        'z-toolbar-float',
        'z-window',
        'z-dialog',
        'z-modal',
        'z-modal-child',
        'z-modal-top',
        'z-popup',
        'z-tooltip',
        'z-skip-link',
    ];

    it('defines every rung, and nothing else', () => {
        expect([...LADDER.keys()]).toEqual(order);
    });

    it('is strictly ascending, with room between rungs', () => {
        const values = order.map(name => LADDER.get(name)!);
        for (let i = 1; i < values.length; i++) {
            // Room matters: a modal's backdrop takes the rung and the surface it
            // dims takes `calc(rung + 1)`, so adjacent rungs cannot be adjacent
            // numbers.
            expect(values[i]).toBeGreaterThan(values[i - 1] + 1);
        }
    });
});

describe('what each surface takes', () => {
    it('puts the client bars below the floating windows — issue #145', () => {
        // The whole bug: the bar outranked the floating layer, so a window drawn
        // in its strip took no clicks at all. A floating user window is a
        // top-level window in Mudlet and may cover the menu bar.
        expect(zIndexOf(appCss, '.mudlet-topbar')).toBe('var(--z-chrome)');
        expect(zIndexOf(scriptWindowCss, '.floating-window-root')).toBe('var(--z-window)');
        expect(LADDER.get('z-chrome')!).toBeLessThan(LADDER.get('z-window')!);
    });

    it('puts menus above the windows, which is why the bar no longer has to be', () => {
        // A Qt menu is its own top-level window. Portaled to <body>
        // (anchoredPopup.ts), it clears a floating window from this rung alone —
        // the bar it hangs from does not have to climb with it.
        expect(zIndexOf(menuBarCss, '.menu-list')).toBe('var(--z-popup)');
        expect(LADDER.get('z-popup')!).toBeGreaterThan(LADDER.get('z-window')!);
    });

    it('keeps the console\'s own overlays under everything above the console', () => {
        // Labels, mini-consoles, command lines and scroll boxes rank against
        // each other inside this wrapper (overlayLayerOrder.ts); the wrapper is
        // the stacking context that stops those ordinals escaping the console.
        expect(zIndexOf(appCss, '.main-overlay-root')).toBe('var(--z-console-overlay)');
        expect(LADDER.get('z-console-overlay')!).toBeLessThan(LADDER.get('z-chrome')!);
    });

    it('floats a detached button bar just under the user windows', () => {
        expect(zIndexOf(buttonsBarCss, '.mudlet-floating-toolbars-root')).toBe('var(--z-toolbar-float)');
        expect(LADDER.get('z-chrome')!).toBeLessThan(LADDER.get('z-toolbar-float')!);
        expect(LADDER.get('z-toolbar-float')!).toBeLessThan(LADDER.get('z-window')!);
    });

    it('opens the client\'s dialogs over the windows they cover', () => {
        expect(zIndexOf(appCss, '.resizable-modal')).toBe('var(--z-dialog)');
        expect(zIndexOf(appCss, '.modal-overlay')).toBe('var(--z-modal)');
        expect(zIndexOf(appCss, '.modal')).toBe('calc(var(--z-modal) + 1)');
        expect(LADDER.get('z-window')!).toBeLessThan(LADDER.get('z-dialog')!);
    });
});
