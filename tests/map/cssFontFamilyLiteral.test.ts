// @vitest-environment node
//
// The map symbol font is a free-text profile field that ends up inside a CSS
// font-family list, so it has to be escaped as a CSS string literal. CodeQL
// alert 23 caught the first version escaping the quote but not the backslash,
// which is the one ordering that is worse than doing nothing.
import { describe, it, expect } from 'vitest';
import { cssFontFamilyLiteral } from '../../src/map/mapImageExport';

/** A literal is well-formed if it opens and closes with an unescaped quote and
 *  contains no unescaped quote in between — i.e. the run of backslashes before
 *  the final quote is even. */
function terminatesCleanly(literal: string): boolean {
    if (!literal.startsWith("'") || !literal.endsWith("'") || literal.length < 2) return false;
    const body = literal.slice(1, -1);
    let i = 0;
    while (i < body.length) {
        if (body[i] === '\\') { i += 2; continue; }   // escaped anything
        if (body[i] === "'") return false;            // bare quote ends it early
        i++;
    }
    return i === body.length;                          // no trailing lone backslash
}

describe('cssFontFamilyLiteral', () => {
    it('quotes an ordinary family name', () => {
        expect(cssFontFamilyLiteral('Bitstream Vera Sans Mono')).toBe("'Bitstream Vera Sans Mono'");
    });

    it('escapes a quote in the name', () => {
        expect(cssFontFamilyLiteral("Ye Olde 'Font'")).toBe("'Ye Olde \\'Font\\''");
    });

    it('doubles a backslash, so a trailing one cannot escape the closing quote', () => {
        // The alert-23 case. Quote-only escaping produced 'Foo\' — unterminated.
        expect(cssFontFamilyLiteral('Foo\\')).toBe("'Foo\\\\'");
        expect(terminatesCleanly(cssFontFamilyLiteral('Foo\\'))).toBe(true);
    });

    it('does not let a crafted name break out of the literal', () => {
        // Without backslash escaping this closes the string and appends a
        // declaration of its own.
        const attack = "Foo\\', monospace; background: url(http://evil/x); font-family: '";
        const out = cssFontFamilyLiteral(attack);
        expect(terminatesCleanly(out)).toBe(true);
        // Every quote inside the body is escaped, so nothing after the name is
        // read as CSS.
        expect(out.slice(1, -1)).not.toMatch(/(^|[^\\])(\\\\)*'/);
    });

    it('drops line terminators, which a CSS string cannot carry at all', () => {
        expect(cssFontFamilyLiteral('Foo\nBar\r\fBaz')).toBe("'FooBarBaz'");
    });

    it('stays well-formed across a spread of awkward inputs', () => {
        const cases = ['', ' ', '\\', '\\\\', "'", "''", "\\'", "'\\", 'a\\\\b', 'a\\\'b', '\\\\\\'];
        for (const c of cases) {
            expect(terminatesCleanly(cssFontFamilyLiteral(c))).toBe(true);
        }
    });
});
