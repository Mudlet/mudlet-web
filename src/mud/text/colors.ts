import xterm256 from "./xterm256";

// Mudlet's own defaults (Host.h's mBlack/mRed/… QColorConstants), which are
// also xterm's first sixteen. mudix used to ship a brighter set (#bb0000 and
// friends), and that put the client at odds with itself: `color_table` — the
// table Lua scripts read, vendored from Mudlet — says ansi_001 is (128,0,0),
// while the renderer painted (187,0,0) for the same colour. A profile that has
// customised its palette is unaffected; these are only the untouched slots.
const DEFAULT_ANSI_DARK = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0"];
const DEFAULT_ANSI_BRIGHT = ["#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];

// Pristine copy of the built-in 256-colour table. `colorCodes.xterm` below is a
// *copy* so OSC 4 palette redefinition (which mutates it) never corrupts the
// imported module array, and OSC 104 can restore exact defaults from here.
const DEFAULT_XTERM: readonly string[] = [...(xterm256 as string[])];

export const colorCodes = {
    xterm: [...(xterm256 as string[])],
    ansi: {
        bright: [...DEFAULT_ANSI_BRIGHT],
        dark:   [...DEFAULT_ANSI_DARK],
    },
};

// The "base" 16-colour palette OSC 104 resets back to: the user-configured
// palette (set via applyAnsiPalette) or the built-in defaults. Tracked
// separately from the live colorCodes.ansi arrays, which OSC 4 may have
// overwritten since.
let baseAnsiDark = [...DEFAULT_ANSI_DARK];
let baseAnsiBright = [...DEFAULT_ANSI_BRIGHT];

/** Built-in 16-color ANSI palette. Index 0–7 dark, 8–15 bright. The Settings
 *  modal uses this as the fallback when a profile hasn't overridden a slot. */
export const DEFAULT_ANSI_PALETTE: readonly string[] = [...DEFAULT_ANSI_DARK, ...DEFAULT_ANSI_BRIGHT];

// Whether the server may redefine the palette via OSC 4/104 (Mudlet's "Allow
// server to redefine your colors", default on). The ANSI/MXP parsers run with
// no access to profile settings, so the gate lives here as a single module-level
// flag that `applyOscPaletteOps` consults. Set from ProfileSession per profile.
let serverRedefineAllowed = true;

/** Enable/disable server-driven OSC 4/104 palette redefinition. */
export function setServerRedefineColorsAllowed(allowed: boolean): void {
    serverRedefineAllowed = allowed;
}

/** Whether the server is currently allowed to redefine palette colors. */
export function isServerRedefineColorsAllowed(): boolean {
    return serverRedefineAllowed;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Apply an override palette to the global ANSI table (mutates colorCodes.ansi
 *  in place so FormatState picks it up without plumbing). Pass `undefined` or
 *  a sparse array to restore defaults for unspecified / invalid slots. The
 *  palette layout is `[...dark(8), ...bright(8)]`. */
export function applyAnsiPalette(palette?: readonly (string | undefined)[]): void {
    for (let i = 0; i < 8; i++) {
        const v = palette?.[i];
        const dark = (typeof v === 'string' && HEX_RE.test(v)) ? v : DEFAULT_ANSI_DARK[i];
        colorCodes.ansi.dark[i] = dark;
        baseAnsiDark[i] = dark;
        colorCodes.xterm[i] = dark; // 38;5;0..7 mirrors the dark ANSI slots
    }
    for (let i = 0; i < 8; i++) {
        const v = palette?.[i + 8];
        const bright = (typeof v === 'string' && HEX_RE.test(v)) ? v : DEFAULT_ANSI_BRIGHT[i];
        colorCodes.ansi.bright[i] = bright;
        baseAnsiBright[i] = bright;
        colorCodes.xterm[i + 8] = bright; // 38;5;8..15 mirrors the bright slots
    }
}

/**
 * OSC 4 palette redefinition: point colour index `index` (0–255) at `hex`
 * (`#rrggbb`). Indices 0–15 also update the 16-colour ANSI table so subsequent
 * SGR 30–37/40–47/90–107 pick up the change, keeping the two tables coherent.
 * Out-of-range indices and malformed colours are ignored.
 */
export function setPaletteColor(index: number, hex: string): void {
    if (!Number.isInteger(index) || index < 0 || index > 255) return;
    if (!HEX_RE.test(hex)) return;
    colorCodes.xterm[index] = hex;
    if (index < 8) colorCodes.ansi.dark[index] = hex;
    else if (index < 16) colorCodes.ansi.bright[index - 8] = hex;
}

/** OSC 104 single-index reset: restore one palette entry to its base value (the
 *  user palette for 0–15, the built-in xterm default otherwise). */
export function resetPaletteColor(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 255) return;
    if (index < 8) {
        colorCodes.ansi.dark[index] = baseAnsiDark[index];
        colorCodes.xterm[index] = baseAnsiDark[index];
    } else if (index < 16) {
        colorCodes.ansi.bright[index - 8] = baseAnsiBright[index - 8];
        colorCodes.xterm[index] = baseAnsiBright[index - 8];
    } else {
        colorCodes.xterm[index] = DEFAULT_XTERM[index];
    }
}

/** OSC 104 with no index: restore the entire palette to its base state. */
export function resetAllPaletteColors(): void {
    for (let i = 16; i < colorCodes.xterm.length; i++) colorCodes.xterm[i] = DEFAULT_XTERM[i];
    for (let i = 0; i < 8; i++) resetPaletteColor(i);
    for (let i = 8; i < 16; i++) resetPaletteColor(i);
}
