// @vitest-environment node
//
// A match-all trigger on a long line costs time in proportion to the line, not
// to its square (Trigger_spec "costs under sixteen times as much for eight
// times the line").
//
// pcre2-wasm-universal compiles every pattern with PCRE2_UTF, and its `_match`
// export passes pcre2_match options 0, so each call checks the subject is valid
// UTF-16 from its start offset to the END of the line. A global match makes one
// call per match, so 13 000 words on a 64 kB line meant 13 000 scans of up to
// 64 kB each — twenty times the cost of an 8 kB line for eight times the text.
// The wasm is patched as it is served (vite-plugin/pcre2Wasm.ts, applied under
// vitest by vitest.config.ts) so `_match` takes an options argument, and
// Pcre2.matchAll checks the line once and passes PCRE2_NO_UTF_CHECK after that.
//
// Timing is too noisy for a unit test, so this counts the checks instead: every
// `_match` call with options 0 is one full scan of the rest of the line.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import libpcre2 from 'pcre2-wasm-universal/libpcre2';
import Pcre2, { PCRE2_NO_UTF_CHECK } from '../../src/mud/triggers/pcre/Pcre2';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';
import { patchLibpcre2Wasm } from '../../vite-plugin/pcre2Wasm';

const shippedWasm = () => {
    const require = createRequire(import.meta.url);
    return readFileSync(join(dirname(require.resolve('pcre2-wasm-universal/libpcre2')), 'libpcre2.wasm'));
};

/** Every `_match` call's options argument while `run` runs. */
function optionsPassed(run: () => void): number[] {
    const spy = vi.spyOn(libpcre2 as unknown as { _match: (...a: number[]) => number }, '_match');
    try {
        run();
        return spy.mock.calls.map(args => args[5] ?? 0);
    } finally {
        spy.mockRestore();
    }
}

describe('patching the pcre2 wasm', () => {
    it('recognises the installed pcre2-wasm-universal build', () => {
        // A new build of the dependency that this patch no longer fits would
        // otherwise go out unpatched without a word, and the trigger engine
        // would quietly go back to quadratic.
        const patched = patchLibpcre2Wasm(shippedWasm());
        expect(patched).not.toBeNull();
        expect(WebAssembly.validate(patched!)).toBe(true);
    });

    it('changes nothing but the options argument, and only once', () => {
        const shipped = shippedWasm();
        const patched = patchLibpcre2Wasm(shipped)!;
        expect(patched.length).toBe(shipped.length);
        let changed = 0;
        for (let i = 0; i < shipped.length; i++) if (shipped[i] !== patched[i]) changed++;
        // the type index, and `i32.const 0` becoming `local.get 5`
        expect(changed).toBe(3);
        expect(patchLibpcre2Wasm(patched)).toEqual(patched);
    });

    it('turns down bytes it was not written for', () => {
        expect(patchLibpcre2Wasm(new Uint8Array([1, 2, 3]))).toBeNull();
        // a wasm header, but cut off before the sections the patch needs
        expect(patchLibpcre2Wasm(shippedWasm().subarray(0, 64))).toBeNull();
    });
});

describe('match-all checks the line once', () => {
    beforeAll(async () => { await TriggerEngine.ready(); await Pcre2.init(); });
    afterEach(() => vi.restoreAllMocks());

    it('runs the wasm this suite patched', () => {
        // Skipping the check on a lone surrogate is only possible if pcre2_match
        // actually received the option. The shipped `_match` drops it and
        // reports PCRE2_ERROR_UTF16_ERR1 (-24, a high surrogate ending the
        // subject) instead.
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
            expect(starts).toEqual([0, 1, 3]);
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
