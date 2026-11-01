import { describe, it, expect } from 'vitest';
import {
    themeTokens, contrastRatio, parseColor, toHex, applyThemeTokens, DERIVED_PROPERTIES,
    TEXT_MINIMUM_RATIO, QUIET_MINIMUM_RATIO, DISABLED_BAR_MINIMUM_RATIO, type Rgb,
} from '../../src/ui/design/themeTokens';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read from disk: Vitest's CSS handling serves `?raw` stylesheets empty.
const appCss = readFileSync(resolve(__dirname, '../../src/App.css'), 'utf8');

/** The four palette roles each stock theme names in App.css: `:root` is the
 *  dark base, and every `:root[data-theme=…]` block overrides some of it. */
function stockPalettes(): Record<string, Record<string, string>> {
    const roles = ['--bg', '--bg-input', '--text', '--accent'];
    const read = (body: string) => Object.fromEntries(roles.flatMap(r => {
        const m = new RegExp(`(?:^|[;\\s])${r}:\\s*([^;]+);`).exec(body);
        return m ? [[r, m[1].trim()]] : [];
    }));
    const base = read(/:root\s*\{([^}]*)\}/.exec(appCss)![1]);
    const out: Record<string, Record<string, string>> = { dark: base };
    for (const m of appCss.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) out[m[1]] = { ...base, ...read(m[2]) };
    return out;
}
const STOCK_PALETTES = stockPalettes();

const hex = (s: string): Rgb => parseColor(s)!;
/** Qt keeps 16 bits a channel and rounds once in `name()`; allow that step. */
const near = (actual: Rgb, expected: string) => {
    const e = hex(expected);
    for (const k of ['r', 'g', 'b'] as const) expect(Math.abs(actual[k] - e[k]), `${toHex(actual)} vs ${expected}`).toBeLessThanOrEqual(1);
};

describe('themeTokens — desktop parity', () => {
    // The table in docs/design-language.md ("The words are softened towards the
    // page") on Mudlet's ui/design-language branch: DarkTheme and Fusion light.
    it('derives the dark appearance desktop documents', () => {
        const t = themeTokens({ window: hex('#353535'), base: hex('#191919'), windowText: hex('#ffffff'), highlight: hex('#2a82da') });
        expect(t.darkPage).toBe(true);
        near(t.page, '#353535');
        near(t.card, '#414141');
        near(t.field, '#212121');
        near(t.text, '#dfdfdf');
        near(t.mutedText, '#afafaf');
        near(t.disabledBarText, '#656565');
    });

    it('derives the light appearance desktop documents', () => {
        const t = themeTokens({ window: hex('#efefef'), base: hex('#ffffff'), windowText: hex('#000000'), highlight: hex('#308cc6') });
        expect(t.darkPage).toBe(false);
        near(t.page, '#efefef');
        near(t.card, '#f8f8f8');
        near(t.field, '#ffffff');
        near(t.text, '#181818');
        near(t.mutedText, '#585858');
        near(t.disabledBarText, '#aaaaaa');
    });

    it('keeps field under page under card on the dark appearance', () => {
        const t = themeTokens({ window: hex('#353535'), base: hex('#191919'), windowText: hex('#ffffff'), highlight: hex('#2a82da') });
        expect(t.field.r).toBeLessThan(t.page.r);
        expect(t.page.r).toBeLessThan(t.card.r);
    });
});

describe('themeTokens — readability floors on every stock theme', () => {
    for (const [id, palette] of Object.entries(STOCK_PALETTES)) {
        it(id, () => {
            const t = themeTokens({
                window: hex(palette['--bg']), base: hex(palette['--bg-input']),
                windowText: hex(palette['--text']), highlight: hex(palette['--accent']),
            });
            for (const s of [t.page, t.pane, t.card]) {
                expect(contrastRatio(t.text, s)).toBeGreaterThanOrEqual(TEXT_MINIMUM_RATIO);
                expect(contrastRatio(t.mutedText, s)).toBeGreaterThanOrEqual(TEXT_MINIMUM_RATIO);
                expect(contrastRatio(t.disabledText, s)).toBeGreaterThanOrEqual(QUIET_MINIMUM_RATIO);
            }
            expect(contrastRatio(t.disabledText, t.field)).toBeGreaterThanOrEqual(QUIET_MINIMUM_RATIO);
            expect(contrastRatio(t.disabledBarText, t.page)).toBeGreaterThanOrEqual(DISABLED_BAR_MINIMUM_RATIO);
            for (const w of [t.accentWashPage, t.accentWashPane]) {
                expect(contrastRatio(t.accentText, w)).toBeGreaterThanOrEqual(TEXT_MINIMUM_RATIO);
            }
        });
    }
});

describe('applyThemeTokens', () => {
    it('reads the theme palette, writes derived properties, and re-derives from scratch', () => {
        const root = document.documentElement;
        const sheet = document.createElement('style');
        sheet.textContent = ':root { --bg: #353535; --bg-input: #191919; --text: #ffffff; --accent: #2a82da; }';
        document.head.appendChild(sheet);
        try {
            applyThemeTokens(root);
            expect(root.style.getPropertyValue('--bg-surface')).toBe('#414141');
            // A second pass must read the stylesheet palette, not its own output.
            applyThemeTokens(root);
            expect(root.style.getPropertyValue('--text')).toBe('#dfdfdf');
        } finally {
            sheet.remove();
            for (const p of DERIVED_PROPERTIES) root.style.removeProperty(p);
        }
    });

    it('leaves a theme that opts out alone', () => {
        const root = document.documentElement;
        const sheet = document.createElement('style');
        sheet.textContent = ':root { --design-derive: off; --bg: #353535; --bg-input: #191919; --text: #ffffff; --accent: #2a82da; }';
        document.head.appendChild(sheet);
        try {
            expect(applyThemeTokens(root)).toBeNull();
            expect(root.style.getPropertyValue('--bg-surface')).toBe('');
        } finally {
            sheet.remove();
        }
    });
});
