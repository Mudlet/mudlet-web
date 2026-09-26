// @vitest-environment node
//
// The main console's default background is desktop's (Host::mBgColor, Qt
// black), and it has to be the same colour in two places: App.css paints it
// (`--console-bg`), and ScriptingAPI reports it to scripts and compares colour
// triggers against it (DEFAULT_BG_RGB). If they drift apart, a trigger for
// background 0 stops matching text that is visibly on black, which is how
// #090909 went unnoticed (the follow-up to #184).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/App.css', import.meta.url), 'utf8');

/** Every `--console-bg` a stock theme block declares, keyed by its selector. */
function consoleBgByTheme(): Record<string, string> {
    const out: Record<string, string> = {};
    const block = /(:root(?:\[data-theme="[^"]+"\])?)\s*\{([^}]*)\}/g;
    for (const [, selector, body] of css.matchAll(block)) {
        const m = /--console-bg:\s*([^;]+);/.exec(body);
        if (m) out[selector] = m[1].trim();
    }
    return out;
}

describe('default console background', () => {
    it('is black in the base theme, not the app chrome colour', () => {
        expect(consoleBgByTheme()[':root']).toBe('#000000');
    });

    it('is black in every stock theme that sets its own', () => {
        const themes = consoleBgByTheme();
        expect(Object.keys(themes).length).toBeGreaterThan(1);
        for (const [selector, value] of Object.entries(themes)) {
            expect(value, selector).toBe('#000000');
        }
    });
});
