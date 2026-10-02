/**
 * Terminal display widths, as desktop Mudlet counts them.
 *
 * MUD output is laid out on a monospace grid: every character occupies an
 * integer number of cells (0, 1, or 2). Browsers don't enforce that — a glyph
 * the chosen font lacks falls back to another font with a different advance
 * width, wide CJK/emoji render at their natural width, and combining marks add
 * code-unit length but no visual width. The renderer uses these widths to box
 * each grapheme into a fixed `Nch` cell so columns stay aligned regardless of
 * the font, and the main console's wrap counts columns with them.
 *
 * Both have to agree with desktop, or a long line wraps at a different place
 * and every getLines()/cursor position after it moves. So the table is the one
 * Mudlet compiles in — ridiculousfish's widechar_width.h (see
 * scripts/generate-unicode-tables.mjs) — read the way TTextProperties.h's
 * graphemeInfo::codepointWidth reads it, and a grapheme is as wide as its base
 * character (graphemeInfo::getBaseCharacter), not its widest one.
 */
import { runLookup } from './unicodeRuns';
import { WIDTH_RUNS } from './unicodeTables.generated';

/** Width class per code point: 0, 1, 2, or 3 for East Asian ambiguous. */
const widthClass = runLookup(WIDTH_RUNS, n => new Uint8Array(n));
const AMBIGUOUS = 3;

/**
 * Display width of a single Unicode code point, in monospace cells — Mudlet's
 * graphemeInfo::codepointWidth. Nonprinting characters (C0/C1 controls, soft
 * hyphen, zero-width spaces, lone surrogates), non-characters and combining
 * marks are 0; wide and "widened in Unicode 9" (emoji presentation) are 2;
 * East Asian ambiguous follows {@link setAmbiguousWidthWide}; everything else,
 * private use and unassigned included, is 1.
 */
export function codePointWidth(cp: number): 0 | 1 | 2 {
    if (cp < 0x7f) return cp >= 0x20 ? 1 : 0;
    // Mudlet's own overrides: widecharwidth issue 11, and a red heart drawn wide.
    if (cp === 0x1f6e1 || cp === 0x2318 || cp === 0x2764) return 2;
    const cls = widthClass(cp);
    if (cls === AMBIGUOUS) return ambiguousWide ? 2 : 1;
    return cls as 0 | 1 | 2;
}

// Mudlet's "Make 'Ambiguous' E. Asian width characters wide". Module state
// rather than a parameter: codePointWidth is called per grapheme on every line
// rendered, and the alternative is threading a flag through clusterWidth,
// stringWidth, segmentCells and each of their callers to say the same thing.
// One tab holds one profile (see the multi-tab guard), so there is only ever
// one answer to carry.
let ambiguousWide = false;

/** Set by the profile's `ambiguousWidthWide` preference. Off is the common
 *  "narrow" terminal rendering and stays the default; on matches a CJK locale's
 *  terminal, which is what the games drawing box art out of these expect. */
export function setAmbiguousWidthWide(wide: boolean): void {
    ambiguousWide = wide;
}

export function isAmbiguousWidthWide(): boolean {
    return ambiguousWide;
}

/**
 * Display width of a grapheme cluster (base + any combining marks, variation
 * selectors, ZWJ sequence): the width of its base character, the way Mudlet
 * measures every grapheme. So an emoji ZWJ sequence takes its first emoji's 2,
 * a letter with diacritics its letter's 1, and U+2764 + VS16 the 2 Mudlet
 * gives the heart itself. A cluster that starts with an unpaired surrogate
 * measures that surrogate, which is nonprinting.
 */
export function clusterWidth(cluster: string): 0 | 1 | 2 {
    if (cluster.length === 0) return 0;
    return codePointWidth(cluster.codePointAt(0)!);
}

/** Total display width of a string, in monospace cells. */
export function stringWidth(text: string): number {
    let width = 0;
    for (const cell of segmentCells(text)) {
        width += cell.width;
    }
    return width;
}

export interface DisplayCell {
    /** The grapheme cluster occupying this cell. */
    text: string;
    /** Number of monospace cells the grapheme occupies (0, 1, or 2). */
    width: 0 | 1 | 2;
}

const segmenter: Intl.Segmenter | undefined =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : undefined;

/**
 * Split text into display cells, one per grapheme cluster. Uses
 * `Intl.Segmenter` for proper cluster boundaries (so combining marks fold into
 * their base), falling back to per-code-point iteration where it is missing.
 */
export function segmentCells(text: string): DisplayCell[] {
    const cells: DisplayCell[] = [];
    if (segmenter) {
        for (const { segment } of segmenter.segment(text)) {
            cells.push({ text: segment, width: clusterWidth(segment) });
        }
    } else {
        for (const ch of text) {
            cells.push({ text: ch, width: codePointWidth(ch.codePointAt(0)!) });
        }
    }
    return cells;
}

/**
 * Where each grapheme of `text` ends, indexed by the UTF-16 offset it starts
 * at (-1 at offsets inside a grapheme). The same clusters as
 * {@link segmentCells} without an object per cell, for the wrap's scan.
 */
export function graphemeEnds(text: string): Int32Array {
    const ends = new Int32Array(text.length + 1).fill(-1);
    if (segmenter) {
        let previous = -1;
        for (const { index } of segmenter.segment(text)) {
            if (previous >= 0) ends[previous] = index;
            previous = index;
        }
        if (previous >= 0) ends[previous] = text.length;
    } else {
        for (let i = 0; i < text.length;) {
            const next = i + (text.codePointAt(i)! > 0xffff ? 2 : 1);
            ends[i] = next;
            i = next;
        }
    }
    return ends;
}

/** Fast check: pure printable ASCII renders at exactly 1 cell with no boxing. */
export function isPlainAscii(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
}
