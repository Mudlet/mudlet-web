// Issue #128 item 1: desktop's "Enable text analyzer" — the context-menu report
// on how the selected text is encoded (TTextEdit::slot_analyseSelection). The
// point of it is the Lua-escape column: a trigger that will not match usually
// has a character in it the player cannot see, and this is how they find out
// which one and how to type it.
import { describe, it, expect } from 'vitest';
import { analyseText, byteToLuaCode, codePointLabel, firstLineOf, hex } from '../../src/mud/text/textAnalyzer';

describe('analyseText', () => {
    it('indexes plain ASCII by both UTF-16 unit and UTF-8 byte', () => {
        const rows = analyseText('ab');
        expect(rows.map(r => [r.text, r.utf16Index, r.utf8Index]))
            .toEqual([['a', 1, 1], ['b', 2, 2]]);
        expect(rows[0].utf8Bytes).toEqual([0x61]);
        expect(rows[0].codePoints).toEqual([0x61]);
    });

    // Mudlet starts the UTF-8 index at 1 "so that it directly maps to string
    // indexing in Lua" — which only pays off if a multi-byte character then
    // pushes the next one along by its byte count, not by one.
    it('advances the byte index by the UTF-8 length, not by one character', () => {
        const rows = analyseText('é!');
        expect(rows[0].utf8Bytes).toEqual([0xc3, 0xa9]);
        expect(rows[1].utf8Index).toBe(3);
        expect(rows[1].utf16Index).toBe(2);
    });

    // A grapheme cluster, not a code point: Mudlet's table folds a combining
    // mark into the base it modifies, and so does this.
    it('keeps a base and its combining mark in one row', () => {
        const rows = analyseText('é');
        expect(rows).toHaveLength(1);
        expect(rows[0].codePoints).toEqual([0x65, 0x0301]);
        expect(rows[0].label).toBeUndefined();
    });

    it('joins a surrogate pair into one code point', () => {
        const rows = analyseText('\u{1F332}');
        expect(rows).toHaveLength(1);
        expect(rows[0].codePoints).toEqual([0x1f332]);
        expect(rows[0].utf16Units).toHaveLength(2);
        expect(rows[0].utf8Bytes).toHaveLength(4);
    });

    it('names a character that draws as nothing', () => {
        const rows = analyseText('a​b');
        expect(rows[1].label).toBe('{zero width space}');
        expect(rows[0].label).toBeUndefined();
    });

    // A variation selector after a visible base does not make the cluster
    // invisible, so labelling it "{variation selector 16}" would hide the
    // character the player can actually see.
    it('leaves a visible cluster unlabelled even when part of it is invisible', () => {
        const rows = analyseText('❤️');
        expect(rows).toHaveLength(1);
        expect(rows[0].label).toBeUndefined();
    });
});

describe('codePointLabel', () => {
    it('uses Mudlet\'s own names, capitalisation included', () => {
        expect(codePointLabel(0x00a0)).toBe('{non-breaking space}');
        expect(codePointLabel(0x200c)).toBe('{Zero width non-joiner}');
        expect(codePointLabel(0x200d)).toBe('{zero width joiner}');
    });

    it('reports the noncharacter ranges', () => {
        expect(codePointLabel(0xfdd0)).toBe('{noncharacter}');
        expect(codePointLabel(0xffff)).toBe('{noncharacter}');
        expect(codePointLabel(0x1fffe)).toBe('{noncharacter}');
    });

    // U+FFFD marks something that already failed to decode upstream; showing it
    // as itself is the useful answer, so it is deliberately not a noncharacter.
    it('leaves the replacement character to draw as itself', () => {
        expect(codePointLabel(0xfffd)).toBeUndefined();
    });

    it('leaves an ordinary letter unnamed', () => {
        expect(codePointLabel(0x41)).toBeUndefined();
    });
});

describe('byteToLuaCode', () => {
    it('gives printable ASCII back as itself', () => {
        expect(byteToLuaCode(0x61)).toBe('a');
    });

    // The decimal form is what goes inside a Lua string literal, and what a
    // player pastes into a pattern to match a character they cannot type.
    it('escapes anything else as a three-digit decimal', () => {
        expect(byteToLuaCode(0x0a)).toBe('\\010');
        expect(byteToLuaCode(0xc3)).toBe('\\195');
        expect(byteToLuaCode(0x7f)).toBe('\\127');
    });

    it('round-trips a two-byte character into a pasteable pair', () => {
        const rows = analyseText('é');
        expect(rows[0].utf8Bytes.map(byteToLuaCode).join('')).toBe('\\195\\169');
    });
});

describe('hex', () => {
    it('pads and upper-cases, as Mudlet spells a code point', () => {
        expect(hex(0x200b, 4)).toBe('200B');
        expect(hex(0x0a, 2)).toBe('0A');
    });
});

describe('firstLineOf', () => {
    it('leaves a single-line selection alone', () => {
        expect(firstLineOf('one line')).toEqual({ line: 'one line', truncated: false });
    });

    it('cuts at the first break and says it did', () => {
        expect(firstLineOf('first\nsecond')).toEqual({ line: 'first', truncated: true });
    });

    // A selection that merely ran to the end of its line lost nothing, so
    // claiming it was truncated would send the player looking for a second line
    // that is not there.
    it('does not call a trailing newline a truncation', () => {
        expect(firstLineOf('first\n')).toEqual({ line: 'first', truncated: false });
        expect(firstLineOf('first\r\n')).toEqual({ line: 'first', truncated: false });
    });

    it('treats the Unicode separators as line breaks too', () => {
        expect(firstLineOf('first second').line).toBe('first');
        expect(firstLineOf('first second').truncated).toBe(true);
    });
});
