// @vitest-environment node
//
// The Lua-pattern → JS-regex translation behind `utf8.find` (and so behind
// utf8.match/gmatch/gsub, which route through it). Two properties matter and
// neither is obvious from the code:
//
//   * a pattern it CANNOT express must say so rather than guess, because the
//     Lua matcher in utf8.lua is the fallback and a wrong translation would
//     silently replace a correct answer with a plausible one;
//   * the positions it reports are Lua's — 1-based, inclusive, counted in code
//     points — while JS regex indices are UTF-16 code units, which only agree
//     while the subject stays inside the BMP.

import { describe, it, expect } from 'vitest';
import { compileLuaPattern, findLuaPattern } from '../../src/scripting/lua/utf8Patterns';

/** find, reduced to what `string.find` would return: [start, end, ...captures],
 *  or null for no match. Throws when the pattern is one for the Lua fallback,
 *  so a test asserting a result can never accidentally pass on "unsupported". */
function find(subject: string, pattern: string, init = 1, plain = false) {
    const r = findLuaPattern(subject, pattern, init, plain);
    if (r.kind === 'unsupported') throw new Error(`unsupported pattern: ${pattern}`);
    return r.kind === 'nomatch' ? null : [r.start, r.end, ...r.captures];
}

const unsupported = (pattern: string) =>
    findLuaPattern('subject', pattern, 1, false).kind === 'unsupported';

describe('utf8 Lua patterns', () => {
    describe('character classes follow Unicode, not ASCII', () => {
        it('%a matches an accented letter', () => {
            expect(find('café done', 'caf%a')).toEqual([1, 4]);
        });

        it('%w spans scripts', () => {
            expect(find('Здравствуй мир', '%w+')).toEqual([1, 10]);
        });

        it('%u and %l split case outside ASCII', () => {
            expect(find('straße Straße', '%u%l+')).toEqual([8, 13]);
        });

        it('%A is the complement of %a', () => {
            expect(find('café!', '%A')).toEqual([5, 5]);
        });

        it('%d stays off letters that merely look numeric', () => {
            expect(find('abc 42', '%d+')).toEqual([5, 6]);
        });

        it('%s covers a non-breaking space', () => {
            expect(find('a b', '%s')).toEqual([2, 2]);
        });

        it('%x is hex, so it stops at a non-hex letter', () => {
            expect(find('deadbeefzz', '%x+')).toEqual([1, 8]);
        });
    });

    describe('pattern syntax', () => {
        it('captures come back in order', () => {
            expect(find('John Smith', '(%a+) (%a+)')).toEqual([1, 10, 'John', 'Smith']);
        });

        it('- is the lazy quantifier, not a literal', () => {
            expect(find('<a><b>', '<(.-)>')).toEqual([1, 3, 'a']);
        });

        it('%- is the literal', () => {
            expect(find('a-b', '%-')).toEqual([2, 2]);
        });

        it('. matches a newline, as in Lua', () => {
            expect(find('a\nb', 'a.b')).toEqual([1, 3]);
        });

        it('^ anchors at init rather than at the start of the subject', () => {
            expect(find('abcabc', '^abc', 4)).toEqual([4, 6]);
            expect(find('xabc', '^abc', 1)).toBeNull();
        });

        it('$ anchors only as the last character', () => {
            expect(find('cost 5$', '5%$')).toEqual([6, 7]);
            expect(find('abc', 'c$')).toEqual([3, 3]);
        });

        it('a magic character is literal once escaped', () => {
            expect(find('a.b', '%.')).toEqual([2, 2]);
            expect(find('f(x)', '%(x%)')).toEqual([2, 4]);
            expect(find('a{b}', '{b}')).toEqual([2, 4]);
        });

        it('sets take ranges, classes and negation', () => {
            expect(find('xyz deaf xyz', '[a-f]+')).toEqual([5, 8]);
            expect(find('key=value', '[%a_]+')).toEqual([1, 3]);
            expect(find('abc123', '[^%d]+')).toEqual([1, 3]);
        });

        it('a dash at either end of a set is the character', () => {
            expect(find('a-b', '[-]')).toEqual([2, 2]);
            expect(find('a-b', '[a-]+')).toEqual([1, 2]);
        });

        it('a ] first in a set is a member', () => {
            expect(find('a]b', '[]]')).toEqual([2, 2]);
        });

        it('an empty match reports end one before start, as string.find does', () => {
            expect(find('abc', 'x*')).toEqual([1, 0]);
            expect(find('abc', '')).toEqual([1, 0]);
        });
    });

    describe('init', () => {
        it('resumes the search', () => {
            expect(find('abcabc', 'abc', 2)).toEqual([4, 6]);
        });

        it('counts a negative from the end', () => {
            expect(find('abcabc', 'abc', -3)).toEqual([4, 6]);
        });

        it('finds nothing past the end of the subject', () => {
            expect(find('abc', 'a', 5)).toBeNull();
        });

        it('still matches empty at exactly one past the end', () => {
            expect(find('abc', 'x*', 4)).toEqual([4, 3]);
        });
    });

    describe('positions are code points', () => {
        // A dragon is one code point but two UTF-16 code units, which is the
        // only case where a JS index and a Lua index disagree.
        it('reports a match after an astral character', () => {
            expect(find('a🐉bc', 'bc')).toEqual([3, 4]);
        });

        it('reports the astral character itself as one position', () => {
            expect(find('a🐉b', '🐉')).toEqual([2, 2]);
        });

        it('resumes from an init measured in code points', () => {
            expect(find('🐉x🐉x', 'x', 3)).toEqual([4, 4]);
        });

        it('counts a multibyte capture in characters', () => {
            expect(find('Цель: 🐉 Оружие: меч', 'Оружие: (%a+)'))
                .toEqual([9, 19, 'меч']);
        });
    });

    describe('plain find', () => {
        it('treats the pattern as text', () => {
            expect(find('a.b.c', '.', 1, true)).toEqual([2, 2]);
        });

        it('measures the needle in characters too', () => {
            expect(find('x🐉y', '🐉y', 1, true)).toEqual([2, 3]);
        });
    });

    describe('what it declines, so utf8.lua answers instead', () => {
        it('balanced and frontier patterns', () => {
            expect(unsupported('%b()')).toBe(true);
            expect(unsupported('%f[%a]')).toBe(true);
        });

        it('position captures', () => {
            expect(unsupported('()a')).toBe(true);
        });

        it('back-references', () => {
            expect(unsupported('(%a)%1')).toBe(true);
        });

        it('a class that only exists as a negation, inside a set', () => {
            expect(unsupported('[%W]')).toBe(true);
        });

        it('malformed patterns, rather than compiling something else', () => {
            expect(unsupported('(abc')).toBe(true);
            expect(unsupported('abc)')).toBe(true);
            expect(unsupported('[abc')).toBe(true);
            expect(unsupported('abc%')).toBe(true);
        });

        it('but takes the ordinary ones', () => {
            expect(compileLuaPattern('^(%a+)%s*=%s*(.-)$')).not.toBeNull();
        });
    });
});
