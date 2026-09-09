// Colour triggers saved by Mudlet before 3.17 (issue #102).
//
// Those builds wrote `FG<n>BG<n>` — no parentheses — and the numbers are
// indices into Mudlet's own old colour list, not ANSI. Nothing remapped them,
// and `parseColorPattern` read `FG4BG0` as `Number("FG4BG0")` → NaN → the
// "any colour" pair, which the runtime treated as a pattern that matches
// everything. Every pre-3.17 colour trigger therefore fired its script on every
// line of game output.
//
// The expectations below are the ones measured against desktop Mudlet and
// recorded in the issue: the two legacy forms behave exactly like the modern
// control, and the parenthesised form — which desktop's regex does not match
// either — fires on nothing at all.

import { describe, it, expect } from 'vitest';
import {
    COLOR_DEFAULT,
    COLOR_IGNORED,
    colorPatternText,
    parseColorPattern,
    remapLegacyColorPattern,
} from '../../src/mud/triggers/legacyColorPatterns';

describe('remapLegacyColorPattern', () => {
    it('remaps the real on-disk legacy form through Mudlet\'s table', () => {
        // FG4 is red → ANSI 1; BG0 is the default colour → scmDefault.
        expect(remapLegacyColorPattern('FG4BG0')).toBe('ANSI_COLORS_F{001}_B{DEFAULT}');
    });

    it('reads -2 as "ignore", the code pre-3.17 builds did not handle', () => {
        expect(remapLegacyColorPattern('FG4BG-2')).toBe('ANSI_COLORS_F{001}_B{IGNORE}');
    });

    it('is a lookup, not a passthrough — the old numbers are not ANSI', () => {
        // The old list interleaves light and normal, so no offset can express
        // it: 3 is light red but 4 is red, 5 is light green but 6 is green.
        expect(remapLegacyColorPattern('FG3BG-2')).toBe('ANSI_COLORS_F{009}_B{IGNORE}');
        expect(remapLegacyColorPattern('FG5BG-2')).toBe('ANSI_COLORS_F{010}_B{IGNORE}');
        expect(remapLegacyColorPattern('FG6BG-2')).toBe('ANSI_COLORS_F{002}_B{IGNORE}');
        expect(remapLegacyColorPattern('FG16BG-2')).toBe('ANSI_COLORS_F{007}_B{IGNORE}');
    });

    it('passes an index outside the table through, as desktop\'s default arm does', () => {
        expect(remapLegacyColorPattern('FG200BG-2')).toBe('ANSI_COLORS_F{200}_B{IGNORE}');
    });

    it('leaves the modern form exactly as it is', () => {
        const modern = 'ANSI_COLORS_F{001}_B{IGNORE}';
        expect(remapLegacyColorPattern(modern)).toBe(modern);
    });

    it('leaves anything that is neither form alone', () => {
        // Desktop's regex does not match the parenthesised spelling either —
        // which is why that form matches nothing there rather than being fixed.
        expect(remapLegacyColorPattern('FG(4)BG(-2)')).toBe('FG(4)BG(-2)');
        expect(remapLegacyColorPattern('')).toBe('');
    });

    it('collapses both-ignored to the empty pattern, as createColorPatternText does', () => {
        expect(colorPatternText(COLOR_IGNORED, COLOR_IGNORED)).toBe('');
        expect(remapLegacyColorPattern('FG-2BG-2')).toBe('');
    });

    it('spells the two sentinels out and zero-pads everything else', () => {
        expect(colorPatternText(1, COLOR_DEFAULT)).toBe('ANSI_COLORS_F{001}_B{DEFAULT}');
        expect(colorPatternText(COLOR_IGNORED, 15)).toBe('ANSI_COLORS_F{IGNORE}_B{015}');
    });
});

describe('parseColorPattern', () => {
    // mudlet-web#158: the editor carried its own parser that read only the
    // plain pair, so a colour trigger that arrived with a package fired
    // correctly (the engine understood the wire form) but showed up in the
    // pattern row as "any/any". One parser, all three spellings.
    it('reads the wire form desktop writes', () => {
        expect(parseColorPattern('ANSI_COLORS_F{003}_B{IGNORE}')).toEqual([3, COLOR_IGNORED]);
        expect(parseColorPattern('ANSI_COLORS_F{DEFAULT}_B{012}')).toEqual([COLOR_DEFAULT, 12]);
    });

    it('reads the pre-3.17 save-file form, remapped to ANSI', () => {
        expect(parseColorPattern('FG4BG0')).toEqual([1, COLOR_DEFAULT]);
    });

    it('reads the plain pair the editor used to write', () => {
        expect(parseColorPattern('3,-1')).toEqual([3, COLOR_IGNORED]);
        expect(parseColorPattern(' 7 , 0 ')).toEqual([7, 0]);
    });

    it('falls back to "any" for anything it cannot read', () => {
        expect(parseColorPattern('')).toEqual([COLOR_IGNORED, COLOR_IGNORED]);
        expect(parseColorPattern('FG(4)BG(2)')).toEqual([COLOR_IGNORED, COLOR_IGNORED]);
    });

    it('round-trips whatever colorPatternText writes', () => {
        for (const pair of [[1, 2], [255, COLOR_DEFAULT], [COLOR_DEFAULT, COLOR_IGNORED]] as const) {
            expect(parseColorPattern(colorPatternText(pair[0], pair[1]))).toEqual([pair[0], pair[1]]);
        }
    });
});
