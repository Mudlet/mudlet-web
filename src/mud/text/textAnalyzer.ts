/**
 * Mudlet's text analyser, ported from `TTextEdit::slot_analyseSelection` and
 * `TTextEdit::convertWhitespaceToVisual` (Mudlet/src/TTextEdit.cpp:2717-3300).
 *
 * Desktop puts a context-menu entry on the main display — gated on the
 * "Enable text analyzer" preference — that reports, for the selected text, how
 * each character is encoded: its UTF-16 code units, a visible stand-in for
 * characters that draw as nothing, its UTF-8 bytes, and the `\ddd` escapes Lua
 * needs to write the same character into a string literal. That last column is
 * the point of the whole feature: a pattern that will not match usually has a
 * character in it the player cannot see, and the analyser is how they find out
 * which one and how to type it.
 *
 * This module is the analysis; the table lives in `TextAnalyzerModal`. Both
 * halves stay pure of Qt's quirks: desktop escapes `<` and `>` because it
 * builds an HTML tooltip by hand, and pads its counts with spaces so a
 * `QTableWidget` sorts them correctly. Neither applies here.
 */

import { segmentCells } from './wcwidth';

/** One grapheme cluster of the analysed text, with everything the report shows
 *  about it. A cluster, not a code point: `é` written as `e` + U+0301 is one
 *  cell on screen and one row here, carrying both of its code points. */
export interface AnalysedGrapheme {
    /** The cluster itself, for rendering as the game drew it. */
    text: string;
    /** 1-based index of the cluster's first UTF-16 code unit, so it lines up
     *  with what a Qt/JS string index would report. */
    utf16Index: number;
    /** The cluster's UTF-16 code units, in order. */
    utf16Units: number[];
    /** The cluster's Unicode code points (surrogate pairs already joined). */
    codePoints: number[];
    /** 1-based index of the cluster's first UTF-8 byte. Mudlet starts this at 1
     *  "so that it directly maps to string indexing in Lua" (TTextEdit.cpp:2975). */
    utf8Index: number;
    /** The cluster's UTF-8 bytes, in order. */
    utf8Bytes: number[];
    /** A name in braces for a character that draws as nothing or as whitespace
     *  ("{zero width space}"), or undefined when the cluster draws as itself. */
    label?: string;
}

/**
 * Names for the code points a player cannot see — Mudlet's
 * `convertWhitespaceToVisual` switch, verbatim including its capitalisation,
 * which is inconsistent in the original ("{Zero width non-joiner}" beside
 * "{zero width joiner}") and is left that way: these are Mudlet's strings.
 */
const CODE_POINT_NAMES: Readonly<Record<number, string>> = {
    0x0009: 'tab',
    0x000a: 'line-feed',
    0x000d: 'carriage-return',
    0x0020: 'space',
    0x00a0: 'non-breaking space',
    0x00ad: 'soft hyphen',
    0x034f: 'combining grapheme joiner',
    0x1680: 'ogham space mark',
    0x2000: "'n' quad",
    0x2001: "'m' quad",
    0x2002: "'n' space",
    0x2003: "'m' space",
    0x2004: '3-per-em space',
    0x2005: '4-per-em space',
    0x2006: '6-per-em space',
    0x2007: 'digit space',
    0x2008: 'punctuation wide space',
    0x2009: '5-per-em space',
    0x200a: 'hair width space',
    0x200b: 'zero width space',
    0x200c: 'Zero width non-joiner',
    0x200d: 'zero width joiner',
    0x200e: 'left-to-right mark',
    0x200f: 'right-to-left mark',
    0x2028: 'line separator',
    0x2029: 'paragraph separator',
    0x202a: 'Left-to-right embedding',
    0x202b: 'right-to-left embedding',
    0x202c: 'pop directional formatting',
    0x202d: 'Left-to-right override',
    0x202e: 'right-to-left override',
    0x202f: 'narrow width no-break space',
    0x205f: 'medium width mathematical space',
    0x2060: 'zero width non-breaking space',
    0x2061: 'function application',
    0x2062: 'invisible times',
    0x2063: 'invisible separator',
    0x2064: 'invisible plus',
    0x2066: 'left-to-right isolate',
    0x2067: 'right-to-left isolate',
    0x2068: 'first strong isolate',
    0x2069: 'pop directional isolate',
    0x206a: 'inhibit symmetrical swapping',
    0x206b: 'activate symmetrical swapping',
    0x206c: 'inhibit arabic form-shaping',
    0x206d: 'activate arabic form-shaping',
    0x206e: 'national digit shapes',
    0x206f: 'nominal Digit shapes',
    0x3000: 'ideographic space',
    0xfe00: 'variation selector 1',
    0xfe01: 'variation selector 2',
    0xfe02: 'variation selector 3',
    0xfe03: 'variation selector 4',
    0xfe04: 'variation selector 5',
    0xfe05: 'variation selector 6',
    0xfe06: 'variation selector 7',
    0xfe07: 'variation selector 8',
    0xfe08: 'variation selector 9',
    0xfe09: 'variation selector 10',
    0xfe0a: 'variation selector 11',
    0xfe0b: 'variation selector 12',
    0xfe0c: 'variation selector 13',
    0xfe0d: 'variation selector 14',
    0xfe0e: 'variation selector 15',
    0xfe0f: 'variation selector 16',
    0xfeff: 'zero width no-break space',
    0xfff9: 'interlinear annotation anchor',
    0xfffa: 'interlinear annotation separator',
    0xfffb: 'interlinear annotation terminator',
    0xfffc: 'object replacement character',
    0x1f3fb: 'FitzPatrick modifier 1 or 2',
    0x1f3fc: 'FitzPatrick modifier 3',
    0x1f3fd: 'FitzPatrick modifier 4',
    0x1f3fe: 'FitzPatrick modifier 5',
    0x1f3ff: 'FitzPatrick modifier 6',
};

/**
 * Mudlet's noncharacter ranges (TTextEdit.cpp:2879-2892). U+FFFD is
 * deliberately absent: it is the replacement character, which by the time it
 * reaches the analyser marks something that already failed to decode, and
 * showing it as itself is the useful answer.
 */
function isNoncharacter(cp: number): boolean {
    if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
    if (cp >= 0xfff0 && cp <= 0xfff8) return true;
    return (cp & 0xffff) === 0xfffe || (cp & 0xffff) === 0xffff;
}

/**
 * The brace-wrapped name for a code point that draws as nothing, or undefined
 * when it draws as itself. C0 controls other than tab / LF / CR have no name in
 * Mudlet's table (they are filtered out of its buffer long before this), but
 * they can reach a browser selection through a script's `echo`, so they are
 * named here as their Unicode abbreviations rather than left invisible.
 */
export function codePointLabel(cp: number): string | undefined {
    const named = CODE_POINT_NAMES[cp];
    if (named) return `{${named}}`;
    if (isNoncharacter(cp)) return '{noncharacter}';
    if (cp < 0x20 || cp === 0x7f) return `{control U+${hex(cp, 4)}}`;
    return undefined;
}

/** Uppercase hex, zero-padded — the spelling Mudlet uses for code points
 *  (`U+0200B`) and, at width 2, for UTF-8 bytes (`0x0a`, which it leaves
 *  lower-case; this pads both the same and lower-cases the byte column at the
 *  point of display). */
export function hex(value: number, width: number): string {
    return value.toString(16).toUpperCase().padStart(width, '0');
}

/**
 * How Lua would have to spell one UTF-8 byte inside a string literal —
 * Mudlet's `byteToLuaCodeOrChar` (TTextEdit.cpp:2919). Printable ASCII is
 * itself; everything else is the decimal escape `\ddd`, which is what a player
 * copies into a trigger pattern to match a character they cannot type.
 */
export function byteToLuaCode(byte: number): string {
    if (byte < 0x20 || byte >= 0x7f) return `\\${String(byte).padStart(3, '0')}`;
    return String.fromCharCode(byte);
}

const utf8Encoder = new TextEncoder();

/**
 * Analyse one line of text into per-grapheme rows.
 *
 * Mudlet analyses only the first line of a selection (its menu entry says so:
 * "only the first line!"), because its buffer is a list of lines and the
 * selection's second line starts over at column 0. The caller here does the
 * same trimming, so this takes text that is already one line.
 */
export function analyseText(text: string): AnalysedGrapheme[] {
    const rows: AnalysedGrapheme[] = [];
    let utf16Index = 1;
    let utf8Index = 1;
    for (const cell of segmentCells(text)) {
        const utf16Units: number[] = [];
        for (let i = 0; i < cell.text.length; i++) utf16Units.push(cell.text.charCodeAt(i));
        const codePoints: number[] = [];
        for (const ch of cell.text) codePoints.push(ch.codePointAt(0)!);
        const utf8Bytes = Array.from(utf8Encoder.encode(cell.text));

        // A cluster is labelled when every code point in it is invisible: a
        // base letter followed by a variation selector still draws as the
        // letter, and calling that "{variation selector 16}" would hide the
        // thing the player can see.
        const labels = codePoints.map(codePointLabel);
        const label = labels.every(l => l !== undefined)
            ? labels.join('')
            : undefined;

        rows.push({
            text: cell.text,
            utf16Index,
            utf16Units,
            codePoints,
            utf8Index,
            utf8Bytes,
            label,
        });
        utf16Index += utf16Units.length;
        utf8Index += utf8Bytes.length;
    }
    return rows;
}


/**
 * The first line of a selection, which is all Mudlet analyses (its menu entry
 * says so: "only the first line!"). A selection spanning several lines is cut
 * at the first line break; the modal says so rather than silently analysing a
 * fragment.
 */
export function firstLineOf(text: string): { line: string; truncated: boolean } {
    const at = indexOfLineBreak(text);
    if (at < 0) return { line: text, truncated: false };
    // A selection that merely runs to the end of its line lost nothing: the
    // rest is truncation only if something other than line breaks follows.
    let truncated = false;
    for (let i = at; i < text.length; i++) {
        if (!isLineBreak(text.charCodeAt(i))) { truncated = true; break; }
    }
    return { line: text.slice(0, at), truncated };
}

/** CR, LF, and the two Unicode separators a script can echo (U+2028 LINE
 *  SEPARATOR, U+2029 PARAGRAPH SEPARATOR) — both of which the browser lays out
 *  as a line break, so a selection can span one. Compared by code unit rather
 *  than matched by a pattern: a literal separator in this source would be
 *  invisible to anyone reading it. */
function isLineBreak(unit: number): boolean {
    return unit === 0x0a || unit === 0x0d || unit === 0x2028 || unit === 0x2029;
}

function indexOfLineBreak(text: string): number {
    for (let i = 0; i < text.length; i++) {
        if (isLineBreak(text.charCodeAt(i))) return i;
    }
    return -1;
}
