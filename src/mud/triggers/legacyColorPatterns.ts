// Colour-trigger patterns saved by Mudlet before 3.17.
//
// Those builds wrote a colour pattern as `FG<n>BG<n>` — no parentheses; the
// parentheses in Mudlet's `FG(-?\d+)BG(-?\d+)` are capture groups
// (XMLimport.cpp:1981). The numbers are *not* ANSI: they are indices into
// Mudlet's own old colour list, where 4 is red and 5 is light green, so
// carrying them across unchanged yields wrong-but-plausible colours rather than
// an obvious failure. Desktop remaps them through a lookup table as it reads
// the profile — `XMLimport::remapColorsToAnsiNumber` (XMLimport.cpp:1975),
// called unconditionally from `:1425` — and rewrites the pattern into the
// modern `ANSI_COLORS_F{…}_B{…}` text, so nothing downstream ever sees the old
// form. This is that pass.
//
// Getting it wrong is not a missed match: the runtime read `FG4BG0` as
// `Number("FG4BG0")` → NaN → the "any colour" pair, so every pre-3.17 colour
// trigger fired on every line of output (issue #102).

/** Mudlet's `TTrigger::scmIgnored` — "any colour here". */
export const COLOR_IGNORED = -1;
/** Mudlet's `TTrigger::scmDefault` — the console's own colour, a colour to
 *  match rather than an "any". */
export const COLOR_DEFAULT = -2;

/**
 * Old colour index → ANSI number, transcribed from the two identical switches
 * in `remapColorsToAnsiNumber` (XMLimport.cpp:2001-2021 for fg, :2032-2052 for
 * bg). The old list interleaves light and normal, which is why this cannot be
 * an offset: 1 is light black but 2 is black, 3 is light red but 4 is red.
 *
 * Indices outside the table fall through to the number itself, as desktop's
 * `default:` arm does.
 */
const LEGACY_TO_ANSI: Record<number, number> = {
    [-2]: COLOR_IGNORED,  // "ignored", which pre-3.17 code did not handle
    0: COLOR_DEFAULT,     // the default colour
    1: 8,                 // light black (dark gray)
    2: 0,                 // black
    3: 9,                 // light red
    4: 1,                 // red
    5: 10,                // light green
    6: 2,                 // green
    7: 11,                // light yellow
    8: 3,                 // yellow
    9: 12,                // light blue
    10: 4,                // blue
    11: 13,               // light magenta
    12: 5,                // magenta
    13: 14,               // light cyan
    14: 6,                // cyan
    15: 15,               // light white
    16: 7,                // white (light gray)
};

/** The legacy wire form. Anchored at the ends because a colour pattern holds
 *  nothing else — desktop searches rather than anchors, but it is reading a
 *  field it already knows to be a colour pattern, as we are. */
const LEGACY_COLOR_PATTERN = /^FG(-?\d+)BG(-?\d+)$/;

function toAnsi(legacy: number): number {
    return LEGACY_TO_ANSI[legacy] ?? legacy;
}

/** One channel of the modern text. Mirrors `TTrigger::createColorPatternText`
 *  (TTrigger.cpp:1422): the two sentinels are spelled out, everything else is
 *  zero-padded to three digits. */
function channelText(code: number): string {
    if (code === COLOR_IGNORED) return 'IGNORE';
    if (code === COLOR_DEFAULT) return 'DEFAULT';
    return String(code).padStart(3, '0');
}

/**
 * The modern pattern text for a colour pair.
 *
 * Both channels ignored yields the empty string, exactly as
 * `createColorPatternText` does — desktop's comment calls it "equivalent to an
 * empty other trigger type", and an empty pattern is compacted out of the list
 * rather than matching everything.
 */
export function colorPatternText(fg: number, bg: number): string {
    if (fg === COLOR_IGNORED && bg === COLOR_IGNORED) return '';
    return `ANSI_COLORS_F{${channelText(fg)}}_B{${channelText(bg)}}`;
}

/**
 * Rewrite a pre-3.17 `FG<n>BG<n>` colour pattern into the modern form, or
 * return the text unchanged when it is not one.
 *
 * Deliberately narrow: anything that is already modern, or that is neither
 * (`FG(4)BG(-2)`, a hand-typed string), is left exactly as it was, and the
 * runtime refuses it. Desktop does the same — its regex does not match the
 * parenthesised form either, which is why that form matches nothing on desktop.
 */
export function remapLegacyColorPattern(text: string): string {
    const m = LEGACY_COLOR_PATTERN.exec(text.trim());
    if (!m) return text;
    return colorPatternText(toAnsi(Number(m[1])), toAnsi(Number(m[2])));
}
