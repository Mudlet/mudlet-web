import xterm256 from "./xterm256";

// Mudlet's own defaults (Host.h's mBlack/mRed/… QColorConstants), which are
// also xterm's first sixteen. Mudlet Web used to ship a brighter set (#bb0000 and
// friends), and that put the client at odds with itself: `color_table` — the
// table Lua scripts read, vendored from Mudlet — says ansi_001 is (128,0,0),
// while the renderer painted (187,0,0) for the same colour. A profile that has
// customised its palette is unaffected; these are only the untouched slots.
const DEFAULT_ANSI_DARK = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0"];
const DEFAULT_ANSI_BRIGHT = ["#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];

// Pristine copy of the built-in 256-colour table. `colorCodes.xterm` below is a
// *copy* so the profile palette (which mirrors into its first sixteen slots)
// never corrupts the imported module array.
const DEFAULT_XTERM: readonly string[] = [...(xterm256 as string[])];

export const colorCodes = {
    xterm: [...(xterm256 as string[])],
    ansi: {
        bright: [...DEFAULT_ANSI_BRIGHT],
        dark:   [...DEFAULT_ANSI_DARK],
    },
};

// The user-configured 16-colour palette (set via applyAnsiPalette) or the
// built-in defaults — what turning "Allow server to redefine your colors" off
// snaps back to. Tracked separately from the live colorCodes.ansi arrays, which
// the server may have overwritten since.
const baseAnsiDark = [...DEFAULT_ANSI_DARK];
const baseAnsiBright = [...DEFAULT_ANSI_BRIGHT];

/** Built-in 16-color ANSI palette. Index 0–7 dark, 8–15 bright. The Settings
 *  modal uses this as the fallback when a profile hasn't overridden a slot. */
export const DEFAULT_ANSI_PALETTE: readonly string[] = [...DEFAULT_ANSI_DARK, ...DEFAULT_ANSI_BRIGHT];

// Whether the server may redefine the palette (Mudlet's "Allow server to
// redefine your colors"). The ANSI/MXP parsers run with no access to profile
// settings, so the gate lives here as a single module-level flag that
// `applyOscPalette` consults. Set from ProfileSession per profile.
let serverRedefineAllowed = true;

/** Enable/disable server-driven palette redefinition. */
export function setServerRedefineColorsAllowed(allowed: boolean): void {
    serverRedefineAllowed = allowed;
}

/** Whether the server is currently allowed to redefine palette colors. */
export function isServerRedefineColorsAllowed(): boolean {
    return serverRedefineAllowed;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

// Told whenever one of the sixteen ANSI colours changes, whatever changed it —
// the profile palette, the server, a reset. Lua's `color_table` keeps its
// ansi_* entries in step through this (Mudlet's Host::updateAnsi16ColorsInTable,
// which every one of those paths calls).
const paletteListeners = new Set<() => void>();

/** Run `listener` after every change to the sixteen ANSI colours. Returns the
 *  unsubscribe function. */
export function onAnsiPaletteChange(listener: () => void): () => void {
    paletteListeners.add(listener);
    return () => { paletteListeners.delete(listener); };
}

function notifyPaletteChange(): void {
    for (const listener of [...paletteListeners]) listener();
}

/** The sixteen ANSI colours in force, `#rrggbb`, dark (0–7) then bright (8–15). */
export function getAnsi16Palette(): string[] {
    return [...colorCodes.ansi.dark, ...colorCodes.ansi.bright];
}

/** Point one of the sixteen ANSI colours at `hex`, mirrored into the matching
 *  256-colour slot (38;5;0..15 are the same colours). */
function writeAnsiSlot(index: number, hex: string): void {
    if (index < 8) colorCodes.ansi.dark[index] = hex;
    else colorCodes.ansi.bright[index - 8] = hex;
    colorCodes.xterm[index] = hex;
}

/** Apply an override palette to the global ANSI table (mutates colorCodes.ansi
 *  in place so FormatState picks it up without plumbing). Pass `undefined` or
 *  a sparse array to restore defaults for unspecified / invalid slots. The
 *  palette layout is `[...dark(8), ...bright(8)]`. */
export function applyAnsiPalette(palette?: readonly (string | undefined)[]): void {
    for (let i = 0; i < 16; i++) {
        const v = palette?.[i];
        const hex = (typeof v === 'string' && HEX_RE.test(v)) ? v : DEFAULT_ANSI_PALETTE[i];
        if (i < 8) baseAnsiDark[i] = hex;
        else baseAnsiBright[i - 8] = hex;
        writeAnsiSlot(i, hex);
    }
    notifyPaletteChange();
}

/**
 * The server's `ESC ] P <i> <rrggbb>`: point ANSI colour `index` (0–15) at
 * `hex` (`#rrggbb`) — SGR 30–37/40–47/90–107, `38;5;0..15` and `color_table`
 * alike (TBuffer::decodeOSC). Out-of-range indices and malformed colours are
 * ignored.
 */
export function setAnsiPaletteColor(index: number, hex: string): void {
    if (!Number.isInteger(index) || index < 0 || index > 15) return;
    if (!HEX_RE.test(hex)) return;
    writeAnsiSlot(index, hex);
    notifyPaletteChange();
}

/** The server's `ESC ] R`: the sixteen ANSI colours go back to the built-in
 *  ones — not to the profile's own, which desktop's TBuffer::resetColors
 *  overwrites with Qt's black/darkRed/… just the same. */
export function resetAnsiPaletteToDefaults(): void {
    for (let i = 0; i < 16; i++) writeAnsiSlot(i, DEFAULT_ANSI_PALETTE[i]);
    notifyPaletteChange();
}

/** Restore the entire palette to its base state: the profile's own sixteen
 *  colours, the built-in 256-colour table above them. */
export function resetAllPaletteColors(): void {
    for (let i = 16; i < colorCodes.xterm.length; i++) colorCodes.xterm[i] = DEFAULT_XTERM[i];
    for (let i = 0; i < 16; i++) writeAnsiSlot(i, i < 8 ? baseAnsiDark[i] : baseAnsiBright[i - 8]);
    notifyPaletteChange();
}
