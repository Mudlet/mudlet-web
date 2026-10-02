// @vitest-environment node
//
// A column edit that splits a surrogate pair leaves half of it in the line;
// desktop Mudlet's QString::toUtf8() drops that half on the way into Lua, so
// scripts see neither the orphan nor a corrupted neighbour (mudlet-web#281).
// emscripten's encoder used to fuse a lone surrogate with the next character.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { dropLoneSurrogates } from '../../src/scripting/lua/wellFormedStrings';

const HEX = 'local function hex(s) return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end)) end ';

describe('a split surrogate pair on its way into Lua', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    const onLine = (line: string, script: string) => {
        env.api.beginLine(new AnsiAwareBuffer(line));
        try {
            env.rt.runWithMatches(HEX + script, 'edit', [line], undefined, undefined, [], undefined, { start: 0, length: line.length });
        } finally {
            env.api.endLine();
        }
    };

    it('drops the orphaned half after replace() over the first half', () => {
        onLine('S1 x😀y end', 'selectSection(4, 1); SEL = hex(getSelection()); replace("#"); LINE = hex(getCurrentLine())');
        expect(env.run('return SEL')).toBe(''); // desktop
        expect(env.run('return LINE')).toBe('53312078237920656e64'); // desktop: "S1 x#y end"
    });

    it('drops both halves around text inserted between them', () => {
        onLine('S2 x😀y end', 'moveCursor(5, getLineNumber()); insertText("#"); LINE = hex(getCurrentLine())');
        expect(env.run('return LINE')).toBe('53322078237920656e64'); // desktop: "S2 x#y end"
    });

    it('leaves a whole pair alone', () => {
        onLine('S3 x😀y', 'LINE = hex(getCurrentLine())');
        expect(env.run('return LINE')).toBe('53332078f09f988079');
    });
});

describe('dropLoneSurrogates', () => {
    it('keeps well-formed text as the same string', () => {
        const s = 'abc 😀 漢';
        expect(dropLoneSurrogates(s)).toBe(s);
    });

    it('drops unpaired halves only', () => {
        expect(dropLoneSurrogates('x\uD83Dy')).toBe('xy');
        expect(dropLoneSurrogates('x\uDE00y')).toBe('xy');
        expect(dropLoneSurrogates('\uD83D😀\uDE00')).toBe('😀');
    });
});
