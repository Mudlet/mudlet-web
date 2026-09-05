// @vitest-environment node
//
// The map symbol font is a free-text profile field that ends up inside a CSS
// font-family list, so it has to be escaped as a CSS string literal. CodeQL
// alert 23 caught the first version escaping the quote but not the backslash,
// which is the one ordering that is worse than doing nothing.
import { describe, it, expect } from 'vitest';
import { cssFontFamilyLiteral, mapSymbolFontStack, BUNDLED_SYMBOL_FONT } from '../../src/map/mapImageExport';
import { symbolFontSource } from '../../src/storage/schema';

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

// The field the escaping protects grew from a bare family name into the same
// OutputFontSource the main display's font uses, so a room-symbol font can be
// installed, fetched from a URL, or read out of the profile's own files — which
// matters more for symbols than for body text, since a symbol is chosen for its
// glyph and the font that has it is often one the machine does not. Old
// profiles still hold the string, in localStorage and in profile.json both, so
// it is normalised on read rather than migrated.
describe('symbolFontSource', () => {
    it('reads an older profile\'s bare family name as an installed font', () => {
        expect(symbolFontSource('Fira Code')).toEqual({ kind: 'system', family: 'Fira Code' });
    });

    it('passes a source through untouched', () => {
        const font = { kind: 'url' as const, family: 'Noto Sans Symbols', url: 'https://example.invalid/f.css' };
        expect(symbolFontSource(font)).toBe(font);
    });

    it('treats unset, empty and whitespace alike as no font', () => {
        expect(symbolFontSource(undefined)).toBeUndefined();
        expect(symbolFontSource('')).toBeUndefined();
        expect(symbolFontSource('   ')).toBeUndefined();
        expect(symbolFontSource({ kind: 'system', family: '  ' })).toBeUndefined();
    });
});

describe('mapSymbolFontStack', () => {
    it('falls back to the bundled font when the profile has chosen none', () => {
        expect(mapSymbolFontStack(undefined)).toBe(`'${BUNDLED_SYMBOL_FONT}', sans-serif`);
        expect(mapSymbolFontStack({})).toBe(`'${BUNDLED_SYMBOL_FONT}', sans-serif`);
    });

    // The bundled font stays behind whatever was chosen, so a family this
    // device turns out not to have still lands somewhere sensible rather than
    // on the browser's generic default.
    it('puts the chosen font first and keeps the bundled one behind it', () => {
        expect(mapSymbolFontStack({ symbolFont: 'Fira Code' }))
            .toBe(`'Fira Code', '${BUNDLED_SYMBOL_FONT}', sans-serif`);
        expect(mapSymbolFontStack({ symbolFont: { kind: 'system', family: 'Fira Code' } }))
            .toBe(`'Fira Code', '${BUNDLED_SYMBOL_FONT}', sans-serif`);
    });

    // The escaping itself is covered above; what matters here is that the stack
    // goes through it rather than concatenating the raw family, in both the
    // string and the source shape.
    it('escapes the chosen family, whichever shape it arrived in', () => {
        const hostile = "Weird'Font\\";
        const quoted = cssFontFamilyLiteral(hostile);
        expect(mapSymbolFontStack({ symbolFont: hostile }).startsWith(quoted)).toBe(true);
        expect(mapSymbolFontStack({ symbolFont: { kind: 'system', family: hostile } }).startsWith(quoted)).toBe(true);
    });
});
