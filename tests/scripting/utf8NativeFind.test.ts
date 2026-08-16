// @vitest-environment node
//
// The seam between utf8.lua and the native matcher: utf8Patterns.test.ts covers
// the translation itself, this covers the hand-off. Three things can only go
// wrong here — the flat result array arrives 0-indexed from wasmoon and has to
// be unpacked as such, "no match" (false) has to stay distinct from "not my
// pattern" (nil) or a fallback would be read as a miss, and match/gmatch/gsub
// have to inherit all of it by routing through the same local.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('utf8 native find', () => {
    let rt: TestRuntime;
    beforeAll(async () => { rt = await createTestRuntime(); });
    afterAll(() => rt.dispose());

    const run = (code: string) => rt.run(code);

    it('returns positions and captures through the bridge', () => {
        expect(run('local s, e, c = utf8.find("John Smith", "(%a+) Smith") return s .. "," .. e .. "," .. c'))
            .toBe('1,10,John');
    });

    it('reports no match as nil, not as a fallback', () => {
        expect(run('return utf8.find("abc", "%d")')).toBeNull();
    });

    it('classifies by Unicode, which the Lua matcher does not', () => {
        expect(run('return utf8.match("caf\\195\\169 done", "caf%a")')).toBe('café');
    });

    it('counts positions in characters, not bytes', () => {
        // The dragon is one character and four UTF-8 bytes.
        expect(run('local s, e = utf8.find("a\\240\\159\\144\\137bc", "bc") return s .. "," .. e'))
            .toBe('3,4');
    });

    it('carries through to match, gmatch and gsub', () => {
        expect(run('return utf8.match("Der H\\195\\164ndler", "H%a+")')).toBe('Händler');
        expect(run(`
            local out = {}
            for w in utf8.gmatch("caf\\195\\169 th\\195\\169", "%a+") do out[#out + 1] = w end
            return table.concat(out, "|")`)).toBe('café|thé');
        expect(run('local s, n = utf8.gsub("you have 42 gold", "%d", "0") return s .. ";" .. n'))
            .toBe('you have 00 gold;2');
    });

    it('hands a pattern it cannot express back to the Lua matcher', () => {
        // %b is the classic one: balanced delimiters have no regex form.
        expect(run('local s, e = utf8.find("x (a (b) c) y", "%b()") return s .. "," .. e'))
            .toBe('3,11');
    });

    it('advances past an empty match instead of looping on it', () => {
        // replaceAll relies on this: a pattern that can match nothing must still
        // report a position it can resume after.
        expect(run('local s, e = utf8.find("abc", "x*") return s .. "," .. e')).toBe('1,0');
    });
});
