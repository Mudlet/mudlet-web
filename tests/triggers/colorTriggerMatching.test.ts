// @vitest-environment node
//
// The end-to-end half of issue #102, driven through the engine the way the
// issue's evidence was gathered: four triggers, each holding one fg-only colour
// pattern, fed three uncoloured lines then one red line and one green line.
//
// Desktop Mudlet's measured counts, from the issue:
//
//   FG4BG0                                 plain 0/3   red 1/1   green 0/1
//   FG4BG-2                                plain 0/3   red 1/1   green 0/1
//   FG(4)BG(-2)                            plain 0/3   red 0/1   green 0/1
//   ANSI_COLORS_F{001}_B{IGNORE} (control) plain 0/3   red 1/1   green 0/1
//
// Mudlet Web reported plain 3/3 for the first three: an unparsable pattern
// became the "any colour" pair, and the runtime read that as "matches
// everything" rather than as desktop's "no pattern at all".

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';

/** ANSI foreground of each fed line, in the order they are fed: three lines
 *  with no colour, then red (1) and green (2). */
const LINES: { text: string; fg: number }[] = [
    { text: 'plain one', fg: -2 },
    { text: 'plain two', fg: -2 },
    { text: 'plain three', fg: -2 },
    { text: 'a red line', fg: 1 },
    { text: 'a green line', fg: 2 },
];

function trig(id: string, patternText: string): TriggerNode {
    return {
        id,
        name: id,
        enabled: true,
        isGroup: false,
        parentId: null,
        code: 'x',
        language: 'lua',
        fireLength: 0,
        multipleMatches: false,
        multiline: false,
        delta: 0,
        isFilter: false,
        patterns: [{ type: 'colorTrigger', text: patternText }],
    } as TriggerNode;
}

/** Feed every line and count fires, with the colour matcher standing in for
 *  ScriptingAPI.currentLineMatchesColor: -1 is "any", so a channel set to it
 *  matches whatever the line carries. */
function countFires(te: TriggerEngine, patternText: string): { plain: number; red: number; green: number } {
    te.loadPerm([trig('t', patternText)]);
    const out = { plain: 0, red: 0, green: 0 };
    for (const line of LINES) {
        te.setColorMatcher((fg, bg) => (fg === -1 || fg === line.fg) && (bg === -1 || bg === -2));
        let fired = false;
        te.process(line.text, false, () => { fired = true; });
        if (!fired) continue;
        if (line.fg === 1) out.red++;
        else if (line.fg === 2) out.green++;
        else out.plain++;
    }
    return out;
}

describe('colour trigger patterns, against desktop\'s measured behaviour', () => {
    let te: TriggerEngine;
    beforeEach(async () => {
        await TriggerEngine.ready();
        te = new TriggerEngine();
    });

    it('fires the modern control on the red line only', () => {
        expect(countFires(te, 'ANSI_COLORS_F{001}_B{IGNORE}'))
            .toEqual({ plain: 0, red: 1, green: 0 });
    });

    it('fires a legacy FG4BG0 pattern on the red line only, not on every line', () => {
        expect(countFires(te, 'FG4BG0')).toEqual({ plain: 0, red: 1, green: 0 });
    });

    it('fires a legacy FG4BG-2 pattern on the red line only', () => {
        expect(countFires(te, 'FG4BG-2')).toEqual({ plain: 0, red: 1, green: 0 });
    });

    it('fires the parenthesised form on nothing at all, as desktop does', () => {
        // Neither legacy nor modern: desktop's remap regex skips it, its decode
        // yields both-ignored, and setupColorTrigger then registers nothing.
        expect(countFires(te, 'FG(4)BG(-2)')).toEqual({ plain: 0, red: 0, green: 0 });
    });

    it('fires an explicitly both-ignored pattern on nothing', () => {
        expect(countFires(te, 'ANSI_COLORS_F{IGNORE}_B{IGNORE}'))
            .toEqual({ plain: 0, red: 0, green: 0 });
    });

    it('still matches a green line when the pattern asks for green', () => {
        // FG6 is green → ANSI 2, so the remap has to be a lookup and not a
        // passthrough for this to land on the right line.
        expect(countFires(te, 'FG6BG-2')).toEqual({ plain: 0, red: 0, green: 1 });
    });
});
