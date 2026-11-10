// @vitest-environment node
//
// A match-all trigger on a long line costs time in proportion to the line, not
// to its square (Trigger_spec "costs under sixteen times as much for eight
// times the line").
//
// Every pattern is compiled with PCRE2_UTF, so each pcre2_match call checks
// the subject is valid UTF-16 from its start offset to the END of the line
// unless it is passed PCRE2_NO_UTF_CHECK. A global match makes one call per
// match, so 13 000 words on a 64 kB line meant 13 000 scans of up to 64 kB
// each — twenty times the cost of an 8 kB line for eight times the text.
// Pcre2.matchAll checks the line once and passes PCRE2_NO_UTF_CHECK after
// that, which the module's `match` export (wasm/pcre2/bridge.c) hands to
// pcre2_match.
//
// Timing is too noisy for a unit test, so this counts the checks instead: every
// `match` call with options 0 is one full scan of the rest of the line.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import Pcre2, { PCRE2_NO_UTF_CHECK, pcre2Bindings } from '../../src/mud/triggers/pcre/Pcre2';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';

/** Every `match` call's options argument while `run` runs. */
function optionsPassed(run: () => void): number[] {
    const spy = vi.spyOn(pcre2Bindings(), 'match');
    try {
        run();
        return spy.mock.calls.map(args => args[5] ?? 0);
    } finally {
        spy.mockRestore();
    }
}

describe('match-all checks the line once', () => {
    beforeAll(async () => { await TriggerEngine.ready(); await Pcre2.init(); });
    afterEach(() => vi.restoreAllMocks());

    it('hands the options to pcre2_match', () => {
        // Skipping the check on a lone surrogate is only possible if pcre2_match
        // actually received the option; without it the subject is refused with
        // PCRE2_ERROR_UTF16_ERR1 (-24, a high surrogate ending the subject).
        const re = new Pcre2('x');
        try {
            expect(re.matchFrom('x\uD800', 0, PCRE2_NO_UTF_CHECK)?.[0].start).toBe(0);
            // Without the option the check still runs and still refuses it.
            expect(() => re.matchFrom('x\uD800', 0)).toThrow(/PCRE2 match error -24/);
        } finally {
            re.destroy();
        }
    });

    it('checks once however many matches the line holds', () => {
        const re = new Pcre2('(*UTF)(*UCP)(\\S+)');
        try {
            for (const words of [10, 1000, 13104]) {
                const line = 'word '.repeat(words) + '\n';
                let found = 0;
                const options = optionsPassed(() => { found = re.matchAll(line).length; });
                expect(found).toBe(words);
                // one call per match plus the one that finds no more
                expect(options.length).toBe(words + 1);
                expect(options.filter(o => o === 0)).toHaveLength(1);
                expect(options[0]).toBe(0);
            }
        } finally {
            re.destroy();
        }
    });

    it('still refuses a line that is not valid UTF-16', () => {
        const re = new Pcre2('(*UTF)(\\S+)');
        try {
            expect(() => re.matchAll('fine words then a lone \uDC00 surrogate')).toThrow(/PCRE2 match error/);
        } finally {
            re.destroy();
        }
    });

    it('steps over a zero-width match by a whole surrogate pair', () => {
        // An offset between the halves of a pair is what the check also guards;
        // the loop must never hand one over once the check is off.
        const re = new Pcre2('(*UTF)x*');
        try {
            const line = 'a\u{1F600}b';
            const starts = re.matchAll(line).map(m => m[0].start);
            // and on to the end of the line, where Mudlet's loop matches too
            expect(starts).toEqual([0, 1, 3, 4]);
        } finally {
            re.destroy();
        }
    });

    it('checks a match-all trigger\'s line once per pass', () => {
        const te = new TriggerEngine();
        te.loadPerm([{
            id: 'all', name: 'all', enabled: true, isGroup: false, parentId: null,
            code: 'x', language: 'lua', fireLength: 0, multipleMatches: true,
            multiline: false, delta: 0, isFilter: false,
            patterns: [{ type: 'regex', text: '(\\S+)' }],
        } as TriggerNode]);
        const words = 13104;
        let collected = 0;
        const options = optionsPassed(() => {
            te.process('word '.repeat(words), false, m => { collected = 1 + m.captures.length; });
        });
        // the whole match and its group for every word, as `#matches` counts them
        expect(collected).toBe(words * 2);
        // the single-match test the trigger's pattern runs first, and the
        // match-all loop's first call — each a scan of the whole line; nothing
        // proportional to the number of words
        expect(options.filter(o => o === 0).length).toBeLessThanOrEqual(2);
        expect(options.length).toBeGreaterThan(words);
    });
});
