// Mudlet's design language, derived the way desktop derives it.
//
// A transcription of `uiDesign::themeTokens()` (src/uiDesign.cpp on Mudlet's
// `ui/design-language` branch, MorquinDevlar/Mudlet). Desktop mixes every
// chrome colour at runtime from four palette roles — Window, Base, WindowText
// and Highlight — and walks the inks until they clear a measured contrast
// floor. Here the four roles are a theme's `--bg`, `--bg-input`, `--text` and
// `--accent`, so stock themes and brand themes alike come out of one recipe.
//
// The branch is not merged upstream and is followed by hand: when it moves,
// update the constants below from its uiDesign.cpp/uiDesign.h and note the
// commit in docs/design-language.md.

export interface Rgb { r: number; g: number; b: number }

/** The four palette roles desktop reads (`QApplication::palette()`). */
export interface Palette {
    window: Rgb;
    base: Rgb;
    windowText: Rgb;
    highlight: Rgb;
}

export interface ThemeTokens {
    darkPage: boolean;
    page: Rgb;
    card: Rgb;
    pane: Rgb;
    field: Rgb;
    border: Rgb;
    separator: Rgb;
    text: Rgb;
    mutedText: Rgb;
    disabledText: Rgb;
    disabledBarText: Rgb;
    accent: Rgb;
    accentText: Rgb;
    /** Accent at {@link SOFT_WASH} alpha — the chosen thing's wash. */
    accentSoft: string;
    /** Text at {@link HOVER_WASH} alpha — the pointer's wash. */
    hoverSoft: string;
    /** The deepest accent wash, solid, over the page (a chosen row). */
    accentWashPage: Rgb;
    accentWashPane: Rgb;
    /** A full-window content surface the page's chrome frames (the launcher):
     *  the palette's Base on a dark page, where the grey page would read as a
     *  dialog; the page itself on a light one. */
    deep: Rgb;
    /** A window's title bar: the platform draws desktop's (#262626 over a
     *  #353535 page on macOS dark), so a web window's header takes that step
     *  below the page and the toolbar under it needs no rule between. */
    titleBar: Rgb;
    /** The code pane, from the edbee theme desktop pairs with the appearance
     *  (src/edbee_defaults/Mudlet Dark.tmTheme / Mudlet Light.tmTheme). */
    code: { background: Rgb; text: Rgb; lineHighlight: Rgb; selection: Rgb; invisibles: Rgb };
    marker: Rgb;
    /** A push button's face, a step off the card (`buttonFaceColour`). */
    buttonFace: Rgb;
    /** An unavailable field's fill and hairline. */
    disabledField: Rgb;
    disabledBorder: Rgb;
    /** A check box's or radio's hairline at rest, and the ink its mark is
     *  drawn in once set (`choiceMarkInks`). */
    choiceOutline: Rgb;
    markInk: Rgb;
    ok: Rgb;
    warning: Rgb;
    error: Rgb;
}

// ── Constants (uiDesign.cpp / uiDesign.h) ─────────────────────────────────
const CARD_LIFT_ON_DARK = 0.06;
const CARD_LIFT_ON_LIGHT = 0.55;
const MINIMUM_CARD_LIFT = 6;
const PAGE_DROP_UNDER_CARD = 0.05;
const PANE_LIFT_TOWARDS_CARD = 0.2;
const SEPARATOR_DROP_ON_DARK = 0.36;
const SEPARATOR_DROP_ON_LIGHT = 0.10;
const TEXT_SOFTEN_ON_DARK = 0.16;
const TEXT_SOFTEN_ON_LIGHT = 0.10;
const FIELD_LIFT_ON_DARK = 0.30;
const DISABLED_TEXT_WEIGHT = 0.32;
const DISABLED_BAR_TEXT_WEIGHT = 0.20;
const MUTED_TEXT_WEIGHT = 0.70;
const ACCENT_TEXT_LIFT_ON_DARK = 0.45;
const ACCENT_TEXT_DROP_ON_LIGHT = 0.2;
const TONE_WEIGHT_STEP = 0.02;
const READABILITY_STEPS = 12;
const STATE_SATURATION = 0.55;
const ERROR_STATE_SATURATION = 0.85;
const STATE_LIGHTNESS_ON_DARK = 0.58;
const STATE_LIGHTNESS_ON_LIGHT = 0.36;
const MARKER_HUE = 0.13;
const MARKER_SATURATION = 0.9;
const MARKER_LIGHTNESS_ON_DARK = 0.34;
const MARKER_LIGHTNESS_ON_LIGHT = 0.72;
const BUTTON_FACE_LIFT_ON_DARK = 0.08;
const BUTTON_FACE_LIFT_ON_LIGHT = 0.04;
const DISABLED_FIELD_TOWARDS_PAGE = 0.6;
const DISABLED_BORDER_WEIGHT = 0.10;
const CHOICE_OUTLINE = 0.55;
// Measured off desktop's window: #353535 page under a #262626 title bar.
const TITLE_BAR_DROP_ON_DARK = 0.28;
const TITLE_BAR_DROP_ON_LIGHT = 0.05;
export const STATE_HUE_OK = 0.58;
export const STATE_HUE_WARNING = 0.09;
export const STATE_HUE_ERROR = 0.01;
export const ACCENT_WASH = 0.24;
export const SOFT_WASH = 0.14;
export const HOVER_WASH = 0.07;

/** Body text and every muted word clear this on page, pane and card. */
export const TEXT_MINIMUM_RATIO = 4.5;
/** An inactive word clears this on every surface and the field. */
export const QUIET_MINIMUM_RATIO = 3.0;
/** An unavailable toolbar button clears this on the page. */
export const DISABLED_BAR_MINIMUM_RATIO = 2.0;

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

// The two edbee themes desktop ships for the code pane and switches with the
// appearance (EditorThemePairTest). Their colours are the theme's, not mixed
// from the palette — the same exemption desktop's `theme-fixed` marks. Light's
// file uses #bbbbbb for both the current line and the selection, which on
// white makes the line look selected; the line highlight is softened here.
const MUDLET_DARK_CODE = {
    background: { r: 0x1a, g: 0x1a, b: 0x1d }, text: { r: 0xde, g: 0xde, b: 0xdd },
    lineHighlight: { r: 0x23, g: 0x23, b: 0x29 }, selection: { r: 0x33, g: 0x33, b: 0x3a },
    invisibles: { r: 0x3a, g: 0x3a, b: 0x42 },
};
const MUDLET_LIGHT_CODE = {
    background: { r: 255, g: 255, b: 255 }, text: { r: 0, g: 0, b: 0 },
    lineHighlight: { r: 0xee, g: 0xee, b: 0xee }, selection: { r: 0xbb, g: 0xbb, b: 0xbb },
    invisibles: { r: 0xbb, g: 0xbb, b: 0xbb },
};
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

// ── Colour helpers ────────────────────────────────────────────────────────

/** Qt's `QColor::fromRgbF` keeps 16 bits a channel; round once, at the end. */
function quantise(c: Rgb): Rgb {
    return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
}

/** `uiDesign::blend` — straight per-channel mix, `amount` of the way to `to`. */
export function blend(from: Rgb, to: Rgb, amount: number): Rgb {
    return quantise({
        r: from.r + (to.r - from.r) * amount,
        g: from.g + (to.g - from.g) * amount,
        b: from.b + (to.b - from.b) * amount,
    });
}

/** `QColor::lightness()` — HSL lightness on 0..255. */
export function lightness(c: Rgb): number {
    return Math.round((Math.max(c.r, c.g, c.b) + Math.min(c.r, c.g, c.b)) / 2);
}

function linearised(channel: number): number {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(c: Rgb): number {
    return 0.2126 * linearised(c.r) + 0.7152 * linearised(c.g) + 0.0722 * linearised(c.b);
}

/** WCAG 2 contrast ratio. */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `QColor::fromHslF`. */
export function fromHsl(h: number, s: number, l: number): Rgb {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return quantise({ r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 });
}

/** `uiDesign::readableOn` — `wanted` walked along lightness until it reads. */
export function readableOn(background: Rgb, wanted: Rgb, fallback: Rgb, minimumRatio: number): Rgb {
    if (contrastRatio(background, wanted) >= minimumRatio) return wanted;
    const limit = lightness(background) < 128 ? WHITE : BLACK;
    for (let step = 1; step <= READABILITY_STEPS; ++step) {
        const moved = blend(wanted, limit, step / READABILITY_STEPS);
        if (contrastRatio(background, moved) >= minimumRatio) return moved;
    }
    return fallback;
}

export function stateColor(hue: number, darkPage: boolean): Rgb {
    const saturation = hue === STATE_HUE_ERROR ? ERROR_STATE_SATURATION : STATE_SATURATION;
    return fromHsl(hue, saturation, darkPage ? STATE_LIGHTNESS_ON_DARK : STATE_LIGHTNESS_ON_LIGHT);
}

export function toHex(c: Rgb): string {
    const h = (n: number) => n.toString(16).padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function rgba(c: Rgb, alpha: number): string {
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha.toFixed(3)})`;
}

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()` as the browser
 *  serialises a computed custom property. Alpha is dropped: a palette role
 *  is a solid colour. Returns null for anything else. */
export function parseColor(input: string): Rgb | null {
    const s = input.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) {
        const [r, g, b] = m[1].split('').map(ch => parseInt(ch + ch, 16));
        return { r, g, b };
    }
    m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
    if (m) {
        const n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
    if (m) return quantise({ r: +m[1], g: +m[2], b: +m[3] });
    return null;
}

// ── themeTokens() ─────────────────────────────────────────────────────────

export function themeTokens(palette: Palette): ThemeTokens {
    const accent = palette.highlight;
    let page = palette.window;
    const darkPage = lightness(page) < 128;
    let card = blend(page, WHITE, darkPage ? CARD_LIFT_ON_DARK : CARD_LIFT_ON_LIGHT);
    if (lightness(card) - lightness(page) < MINIMUM_CARD_LIFT) {
        card = page;
        page = blend(page, BLACK, PAGE_DROP_UNDER_CARD);
    }
    const text = blend(palette.windowText, page, darkPage ? TEXT_SOFTEN_ON_DARK : TEXT_SOFTEN_ON_LIGHT);
    const field = darkPage ? blend(palette.base, page, FIELD_LIFT_ON_DARK) : palette.base;
    const pane = blend(page, card, PANE_LIFT_TOWARDS_CARD);
    const separator = blend(page, BLACK, darkPage ? SEPARATOR_DROP_ON_DARK : SEPARATOR_DROP_ON_LIGHT);
    const border = blend(page, text, darkPage ? 0.22 : 0.18);

    const walk = (start: number, surfaces: Rgb[], floor: number): Rgb => {
        let weight = start;
        let ink = blend(page, text, weight);
        while (weight < 1.0 && surfaces.some(s => contrastRatio(ink, s) < floor)) {
            weight = Math.min(1.0, weight + TONE_WEIGHT_STEP);
            ink = blend(page, text, weight);
        }
        return ink;
    };
    const mutedText = walk(MUTED_TEXT_WEIGHT, [page, pane, card], TEXT_MINIMUM_RATIO);
    const disabledText = walk(DISABLED_TEXT_WEIGHT, [page, pane, card, field], QUIET_MINIMUM_RATIO);
    const disabledBarText = walk(DISABLED_BAR_TEXT_WEIGHT, [page], DISABLED_BAR_MINIMUM_RATIO);

    const limit = darkPage ? WHITE : BLACK;
    const started = blend(accent, limit, darkPage ? ACCENT_TEXT_LIFT_ON_DARK : ACCENT_TEXT_DROP_ON_LIGHT);
    const washes = [page, pane, card].map(s => blend(s, accent, ACCENT_WASH));
    let accentText = started;
    for (let step = 1; step <= READABILITY_STEPS && washes.some(w => contrastRatio(accentText, w) < TEXT_MINIMUM_RATIO); ++step) {
        accentText = blend(started, limit, step / READABILITY_STEPS);
    }

    const marker = fromHsl(MARKER_HUE, MARKER_SATURATION, darkPage ? MARKER_LIGHTNESS_ON_DARK : MARKER_LIGHTNESS_ON_LIGHT);
    // State inks are walked to read on the separator, the darkest surface any
    // of them sits on (desktop's errorInk()); a lighter surface is easier.
    const state = (hue: number) => readableOn(separator, stateColor(hue, darkPage), text, TEXT_MINIMUM_RATIO);

    return {
        darkPage, page, card, pane, field, border, separator, text,
        mutedText, disabledText, disabledBarText, accent, accentText,
        accentSoft: rgba(accent, SOFT_WASH),
        hoverSoft: rgba(text, HOVER_WASH),
        accentWashPage: washes[0],
        accentWashPane: washes[1],
        deep: darkPage ? palette.base : page,
        titleBar: blend(page, BLACK, darkPage ? TITLE_BAR_DROP_ON_DARK : TITLE_BAR_DROP_ON_LIGHT),
        code: darkPage ? MUDLET_DARK_CODE : MUDLET_LIGHT_CODE,
        marker,
        buttonFace: blend(card, text, darkPage ? BUTTON_FACE_LIFT_ON_DARK : BUTTON_FACE_LIFT_ON_LIGHT),
        disabledField: blend(field, page, DISABLED_FIELD_TOWARDS_PAGE),
        disabledBorder: blend(page, text, DISABLED_BORDER_WEIGHT),
        choiceOutline: blend(card, text, CHOICE_OUTLINE),
        markInk: readableOn(field, accent, text, QUIET_MINIMUM_RATIO),
        ok: state(STATE_HUE_OK),
        warning: state(STATE_HUE_WARNING),
        error: state(STATE_HUE_ERROR),
    };
}

// ── Inked glyphs ──────────────────────────────────────────────────────────
// A check box's tick or a select's chevron is a picture, and a picture in CSS
// cannot take a custom property for its colour — so, as desktop writes a
// tinted PNG per theme (`themedGlyphFile`), the token pass writes each one as
// an SVG data URI in its ink. Paths are Lucide's check, minus and
// chevron-down (control-check.svg, control-minus.svg, editor-chevron-down.svg).
// The marks are drawn at 9px in a 13px box, where Lucide's stroke reads as a
// hairline, so they carry a heavier stroke than the chrome glyphs.
const TICK = '<path d="M20 6 9 17l-5-5" stroke-width="3.2"/>';
const DASH = '<path d="M5 12h14" stroke-width="3.2"/>';
const DOT = '<circle cx="12" cy="12" r="6" stroke="none" fill="currentColor"/>';
const CHEVRON_DOWN = '<path d="m6 9 6 6 6-6" stroke-width="2"/>';

function glyphUrl(body: string, ink: Rgb): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
        + `stroke-linecap="round" stroke-linejoin="round" color="${toHex(ink)}">${body}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// ── CSS custom properties ─────────────────────────────────────────────────

/** Every property {@link applyThemeTokens} writes, so it can clear them
 *  before reading the theme's own palette back. */
export const DERIVED_PROPERTIES = [
    '--bg', '--bg-surface', '--bg-panel', '--bg-input', '--bg-glass', '--text',
    '--text-dim', '--text-muted', '--text-disabled', '--text-disabled-bar',
    '--border', '--separator', '--accent-text', '--accent-soft', '--accent-wash',
    '--accent-wash-pane', '--bg-deep', '--bg-titlebar', '--code-bg', '--code-text', '--code-line',
    '--code-selection', '--code-invisibles', '--accent-glow', '--hover-bg', '--hover-bg-strong',
    '--marker', '--button-face', '--field-disabled', '--border-disabled',
    '--choice-outline', '--mark-ink', '--mark-tick', '--mark-dash', '--mark-dot',
    '--mark-tick-quiet', '--mark-dash-quiet', '--mark-dot-quiet', '--chevron-down',
    '--chevron-down-lit', '--state-ok', '--state-warning', '--state-error', '--danger',
] as const;

/** The tokens as CSS custom properties. Legacy names (`--bg-surface`,
 *  `--text-dim`, `--hover-bg`, …) are pointed at the token they always meant,
 *  so every surface written against them takes the design at once. */
export function tokenProperties(t: ThemeTokens): Record<(typeof DERIVED_PROPERTIES)[number], string> {
    return {
        '--bg': toHex(t.page),
        '--bg-surface': toHex(t.card),
        '--bg-panel': toHex(t.pane),
        '--bg-input': toHex(t.field),
        '--bg-glass': rgba(t.card, 0.92),
        '--text': toHex(t.text),
        '--text-dim': toHex(t.mutedText),
        '--text-muted': toHex(t.mutedText),
        '--text-disabled': toHex(t.disabledText),
        '--text-disabled-bar': toHex(t.disabledBarText),
        '--border': toHex(t.border),
        '--separator': toHex(t.separator),
        '--accent-text': toHex(t.accentText),
        '--accent-soft': t.accentSoft,
        '--accent-wash': toHex(t.accentWashPage),
        '--accent-wash-pane': toHex(t.accentWashPane),
        '--bg-deep': toHex(t.deep),
        '--bg-titlebar': toHex(t.titleBar),
        '--code-bg': toHex(t.code.background),
        '--code-text': toHex(t.code.text),
        '--code-line': toHex(t.code.lineHighlight),
        '--code-selection': toHex(t.code.selection),
        '--code-invisibles': toHex(t.code.invisibles),
        '--accent-glow': t.accentSoft,
        '--hover-bg': t.hoverSoft,
        '--hover-bg-strong': rgba(t.text, HOVER_WASH * 2),
        '--marker': toHex(t.marker),
        '--button-face': toHex(t.buttonFace),
        '--field-disabled': toHex(t.disabledField),
        '--border-disabled': toHex(t.disabledBorder),
        '--choice-outline': toHex(t.choiceOutline),
        '--mark-ink': toHex(t.markInk),
        '--mark-tick': glyphUrl(TICK, t.markInk),
        '--mark-dash': glyphUrl(DASH, t.markInk),
        '--mark-dot': glyphUrl(DOT, t.markInk),
        '--mark-tick-quiet': glyphUrl(TICK, t.disabledText),
        '--mark-dash-quiet': glyphUrl(DASH, t.disabledText),
        '--mark-dot-quiet': glyphUrl(DOT, t.disabledText),
        '--chevron-down': glyphUrl(CHEVRON_DOWN, t.mutedText),
        '--chevron-down-lit': glyphUrl(CHEVRON_DOWN, t.accentText),
        '--state-ok': toHex(t.ok),
        '--state-warning': toHex(t.warning),
        '--state-error': toHex(t.error),
        '--danger': toHex(t.error),
    };
}

/**
 * Derive the design tokens from the theme currently on `root` and write them
 * as inline custom properties, which win over every stylesheet. The theme's
 * own `--bg`, `--bg-input`, `--text` and `--accent` are read back first (with
 * the previous derivation cleared), so a theme only has to name its palette.
 *
 * A theme opts out by setting `--design-derive: off` — its own values then
 * stand as written.
 */
export function applyThemeTokens(root: HTMLElement): ThemeTokens | null {
    for (const prop of DERIVED_PROPERTIES) root.style.removeProperty(prop);
    const view = root.ownerDocument.defaultView;
    if (!view) return null;
    const style = view.getComputedStyle(root);
    if (style.getPropertyValue('--design-derive').trim() === 'off') return null;
    const read = (name: string) => parseColor(style.getPropertyValue(name));
    const window = read('--bg');
    const base = read('--bg-input');
    const windowText = read('--text');
    const highlight = read('--accent');
    if (!window || !base || !windowText || !highlight) return null;
    const tokens = themeTokens({ window, base, windowText, highlight });
    for (const [prop, value] of Object.entries(tokenProperties(tokens))) root.style.setProperty(prop, value);
    return tokens;
}
