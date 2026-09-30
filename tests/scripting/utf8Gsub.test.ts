// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// utf8.gsub / utf8.gmatch against Mudlet's luautf8. generic_mapper does
// `local string = utf8` and strips the prompt with a `^…` gsub, so a gsub that
// ignored the anchor named every room after the prompt (#263).
describe('utf8.gsub / utf8.gmatch', () => {
    let rt: TestRuntime;
    beforeAll(async () => { rt = await createTestRuntime(); });
    afterAll(() => rt.dispose());

    const gsub = (args: string) => rt.run(`return table.concat({utf8.gsub(${args})}, "|")`);
    const gmatch = (args: string) =>
        rt.run(`local t = {} for m in utf8.gmatch(${args}) do t[#t+1] = m end return table.concat(t, "|")`);

    describe('a leading ^ anchors, and allows one attempt', () => {
        it.each([
            ['"abc", "^a", ""', 'bc|1'],
            ['"<1>", "^%[?%a*%]?<.*>", ""', '|1'],
            ['"aaa", "^a", "b"', 'baa|1'],
            ['"xabc", "^a", ""', 'xabc|0'],
            ['"abc", "^(a)(b)", "%2%1"', 'bac|1'],
            ['"abc", "^", "X"', 'Xabc|1'],
            ['"héllo", "^hé", "H"', 'Hllo|1'],
        ])('utf8.gsub(%s)', (args, expected) => {
            expect(gsub(args)).toBe(expected);
        });

        it('strips a prompt the way generic_mapper does', () => {
            expect(rt.run(`
                local string = utf8
                local line = "<100hp 50mp> Town Square"
                return (string.gsub(line, "^<%d+hp %d+mp> ", ""))
            `)).toBe('Town Square');
        });

        it('only a leading ^ anchors; %^ elsewhere is a literal', () => {
            expect(gsub('"a^b", "%^", "-"')).toBe('a-b|1');
        });
    });

    describe('empty matches advance instead of looping', () => {
        it.each([
            ['"abc", "x*", "-"'],
            ['"", "x*", "-"'],
            ['"ab", "%s*", "_"'],
            ['"abc", "", "."'],
        ])('utf8.gsub(%s) agrees with string.gsub on ASCII', (args) => {
            // Lua 5.1's string.gsub keeps an empty match straight after a
            // non-empty one; luautf8 (what Mudlet's utf8 is) skips it, as Lua
            // 5.4 does. Only compare where the two agree, and pin the rest.
            expect(gsub(args)).toBe(rt.run(`return table.concat({string.gsub(${args})}, "|")`));
        });

        it('skips an empty match where the previous match ended, as luautf8 does', () => {
            expect(gsub('"abc", "b*", "-"')).toBe('-a-c-|3');
            expect(gsub('"a b", "%s*", "_"')).toBe('_a_b_|3');
            expect(gmatch('"abc", "b*"')).toBe('|b|');
        });

        it('gmatch still walks every match', () => {
            expect(gmatch('"one two  three", "%a+"')).toBe('one|two|three');
            expect(gmatch('"héllo wörld", "%S+"')).toBe('héllo|wörld');
        });
    });
});
