// @vitest-environment node
//
// mudlet-web#184 — three places where trigger matching drifted from desktop
// Mudlet 5.0, measured side by side against the same lines:
//
//  1. Colour triggers compare RGB, not ANSI numbers (TTrigger::match_color_pattern
//     → `colorsMatch`, with the pattern's colour from Host::getAnsiColor). So a
//     trigger for 196 fires on `38;5;196` text and on truecolor text of the same
//     RGB, and one for 7 fires on uncoloured text, drawn in the same light grey.
//     Mudlet Web mapped colours back through the 16-colour table only.
//  2. A regex group that did not take part BEFORE the last one that did is an
//     empty string in `matches`, not nil; trailing ones are left out
//     (TTrigger::processRegexMatch copies `rc` pairs, empty for PCRE2_UNSET).
//  3. `feedTriggers("line\r\n")` reaches the triggers as `line`, so a
//     `$`-anchored pattern still matches.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, TEST_CONNECTION_ID, type TestRuntime } from '../createTestRuntime';
import { useAppStore } from '../../src/storage/appStore';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';
import { NULL_ENGINE_HOST } from '../../src/scripting/EngineHost';

describe('colour triggers compare by RGB (#184)', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    /** The run a colour trigger for (fg, bg) reports on `raw`, or null. */
    const colorRun = (raw: string, fg: number, bg: number): string | null => {
        env.api.beginLine(new AnsiAwareBuffer(raw));
        try {
            return env.api.currentLineColorMatch(fg, bg);
        } finally {
            env.api.endLine();
        }
    };

    it('matches 256-colour text by its xterm index', () => {
        expect(colorRun('C1 \x1b[38;5;196mRED256\x1b[0m', 196, -1)).toBe('RED256');
        expect(colorRun('C1 \x1b[38;5;21mBLUE\x1b[0m', 21, -1)).toBe('BLUE');
        expect(colorRun('C1 \x1b[38;5;232mGREY\x1b[0m', 232, -1)).toBe('GREY');
        expect(colorRun('C1 \x1b[38;5;196mRED256\x1b[0m', 197, -1)).toBeNull();
    });

    it('matches truecolor text of the same RGB', () => {
        // 196 is (255, 0, 0) in the xterm cube.
        expect(colorRun('C2 \x1b[38;2;255;0;0mREDTC\x1b[0m', 196, -1)).toBe('REDTC');
        // ...and so is bright red, ANSI 9.
        expect(colorRun('C2 \x1b[38;2;255;0;0mREDTC\x1b[0m', 9, -1)).toBe('REDTC');
        expect(colorRun('C2 \x1b[38;2;254;0;0mNEAR\x1b[0m', 196, -1)).toBeNull();
    });

    it('matches 256-colour backgrounds', () => {
        expect(colorRun('x \x1b[48;5;196mBG\x1b[0m', -1, 196)).toBe('BG');
    });

    it('still matches the 16 basic colours', () => {
        expect(colorRun('C3 \x1b[31mRED16\x1b[0m', 1, -1)).toBe('RED16');
        expect(colorRun('C3 \x1b[31mRED16\x1b[0m', 9, -1)).toBeNull();
    });

    it('answers a trigger for 7 on uncoloured text, drawn in the same grey', () => {
        expect(colorRun('plain', 7, -1)).toBe('plain');
        expect(colorRun('plain', -2, -1)).toBe('plain');
    });

    it('answers a trigger for background 0 on uncoloured text, drawn on black', () => {
        // Host::mBgColor starts as Qt black, the same RGB as ANSI 0, so desktop
        // fires `tempAnsiColorTrigger(-1, 0)` on plain text out of the box.
        // Mudlet Web's default console used to be #090909 and never did.
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID,
            { outputBackground: '', outputBackgroundColor: undefined });
        expect(colorRun('plain', -1, 0)).toBe('plain');
        expect(colorRun('plain', 7, 0)).toBe('plain');
        // ...but not on text given a background of its own.
        expect(colorRun('x \x1b[44mBLUEBG\x1b[0m', -1, 0)).toBe('x ');
    });

    it('keeps a background the profile chose for itself', () => {
        useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { outputBackground: '#090909' });
        try {
            expect(colorRun('plain', -1, 0)).toBeNull();
            expect(colorRun('plain', -1, -2)).toBe('plain');
        } finally {
            useAppStore.getState().patchConnectionProfile(TEST_CONNECTION_ID, { outputBackground: '' });
        }
    });

    it('matches nothing for a code outside 0-255', () => {
        expect(colorRun('plain', 300, -1)).toBeNull();
        expect(colorRun('x \x1b[38;5;300mOUT\x1b[0m', 300, -1)).toBeNull();
    });

    it('fires tempAnsiColorTrigger through the Lua binding', () => {
        env.run(`__hits = {}
            tempAnsiColorTrigger(196, -1, function() __hits[#__hits + 1] = matches[1] end)`);
        // The temp trigger rides the engine's temp list; drive it the way the
        // line pass does, with the line open for the colour lookup.
        for (const raw of ['C1 \x1b[38;5;196mRED256\x1b[0m', 'C2 \x1b[38;2;255;0;0mREDTC\x1b[0m', 'plain']) {
            const buffer = new AnsiAwareBuffer(raw);
            env.api.beginLine(buffer);
            env.api.triggers.processTemp(buffer.text);
            env.api.endLine();
        }
        expect(env.run('return table.concat(__hits, ",")')).toBe('RED256,REDTC');
    });
});

describe('skipped optional groups in trigger matches (#184)', () => {
    beforeEach(async () => { await TriggerEngine.ready(); });

    const captures = (pattern: string, line: string) => {
        const te = new TriggerEngine();
        te.loadPerm([{
            id: 't', name: 't', isGroup: false, parentId: null, enabled: true,
            language: 'lua', code: 'x', patterns: [{ type: 'regex', text: pattern }],
        } as unknown as TriggerNode]);
        const got = te.matchPerm(line);
        expect(got).toHaveLength(1);
        return [got[0].matchedText, ...got[0].captures];
    };

    it('gives a skipped group before a participating one an empty string', () => {
        expect(captures('^mid (y)?(x) end$', 'mid x end')).toEqual(['mid x end', '', 'x']);
    });

    it('leaves trailing skipped groups out', () => {
        expect(captures('^mid (x)(y)? end$', 'mid x end')).toEqual(['mid x end', 'x']);
        expect(captures('^mid (x)(y)?(z)? end$', 'mid x end')).toEqual(['mid x end', 'x']);
    });

    it('keeps every group when all take part', () => {
        expect(captures('^mid (y)?(x) end$', 'mid yx end')).toEqual(['mid yx end', 'y', 'x']);
    });
});

describe('feedTriggers with CRLF (#184)', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => { env.api.setHost(null); env.dispose(); });

    it('hands the triggers the line without its carriage return', () => {
        const batches: string[] = [];
        env.api.setHost({
            ...NULL_ENGINE_HOST,
            processFlushBatch: groups => { for (const g of groups) batches.push(g.text); },
        });
        env.run('feedTriggers("FEED line\\r\\nSECOND\\r\\n")');
        expect(batches).toEqual(['FEED line\nSECOND']);
    });
});
