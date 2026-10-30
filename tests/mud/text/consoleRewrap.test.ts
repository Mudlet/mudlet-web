// @vitest-environment node
//
// What a console does with lines an earlier wrap already shaped: an indented
// line is not indented again when wrapLine() rewraps it (TBuffer::wrapLine's
// carriesIndent), and an echo onto the empty line a break left waiting drops
// the spaces it starts with (TBuffer::dropSpaceAtWrap). Mirrors ConsoleWrap_spec
// and EchoLineFeeds_spec, whose Lua runs only in the browser.
import { describe, it, expect } from 'vitest';
import { Console } from '../../../src/mud/text/Console';

/** Every line, less the empty open one a finished echo leaves at the end. */
function all(console: Console): string[] {
    return console.getLines(0, console.getLineCount() + 1).filter((_, i, a) => i < a.length - 1 || a[i] !== '');
}

function alphabet(width = 12): Console {
    const console = new Console();
    console.setWrapWidth(width, 2, 4);
    console.echoText('abcdefghijklmnopqrstuvwxyz\n');
    return console;
}

const alphabetWrapped = ['  abcdefghij', '    klmnopqr', '    stuvwxyz'];

describe('wrapLine() and an indent an earlier wrap put there', () => {
    it('leaves an indented line alone at the same width', () => {
        const console = alphabet();
        expect(all(console)).toEqual(alphabetWrapped);
        console.wrapLine(0, 12, 2, 4);
        console.wrapLine(0, 12, 2, 4);
        expect(all(console)).toEqual(alphabetWrapped);
    });

    it('indents an already indented line once when rewrapping it narrower', () => {
        const console = alphabet();
        console.wrapLine(0, 8, 2, 4);
        expect(all(console)).toEqual(['  abcdef', '    ghij', '    klmn', '    opqr', '    stuv', '    wxyz']);
    });

    it('indents a line whose leading spaces are its own text', () => {
        const console = new Console();
        console.setWrapWidth(100, 2, 4);
        console.echoText('  defghij\n');
        console.wrapLine(0, 8, 2, 4);
        expect(all(console)[0].startsWith('    ')).toBe(true);
    });
});

describe('an echo onto a line the wrap left waiting', () => {
    function waiting(): Console {
        const console = new Console();
        console.setWrapWidth(8);
        console.echoText('aaaa bbbbbbbb   ');
        return console;
    }

    it('drops the spaces the echo starts with', () => {
        const console = waiting();
        console.echoText('  cccc\n');
        expect(all(console)).toEqual(['aaaa ', 'bbbbbbbb', 'cccc']);
    });

    it('drops an echo of nothing but spaces and keeps waiting', () => {
        const console = waiting();
        console.echoText('   ');
        console.echoText(' cccc\n');
        expect(all(console)).toEqual(['aaaa ', 'bbbbbbbb', 'cccc']);
    });

    it('keeps the spaces that start a line a line feed in the same echo began', () => {
        const console = waiting();
        console.echoText('  cccc\n   dddd\n');
        expect(all(console)).toEqual(['aaaa ', 'bbbbbbbb', 'cccc', '   dddd']);
    });
});
