// @vitest-environment node
//
// selectCaptureGroup() after the script edits the line it matched, and what it
// answers. TConsole moves every recorded capture position past an edit made
// during a trigger (adjustCaptureGroups — insertText, insertLink and replace
// all call it), and TLuaInterpreter::selectCaptureGroup hands back what
// TConsole::selectSection answered: a bool, as the number 1 or 0, with -1 for
// a group there is nothing to select for. ConsoleEdges_spec pins both.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

describe('selectCaptureGroup on a line the trigger edited', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.api.setCaptureShiftHook((at, delta) => env.rt.shiftCaptureSpans(at, delta));
    });
    afterEach(() => env.dispose());

    // "ceTrig alpha beta" against ^ceTrig (\w+) (\w+)$ — group 3 is "beta"
    const fire = (script: string) => {
        const line = 'ceTrig alpha beta';
        env.api.beginLine(new AnsiAwareBuffer(line));
        try {
            env.rt.runWithMatches(script, 'edit', [line, 'alpha', 'beta'], undefined, undefined,
                [{ start: 7, length: 5 }, { start: 13, length: 4 }], undefined, { start: 0, length: line.length });
        } finally {
            env.api.endLine();
        }
    };

    it.each([
        ['replace() shortens an earlier group', 'selectCaptureGroup(2); replace("x")', 'ceTrig x beta'],
        ['replace() lengthens an earlier group', 'selectCaptureGroup(2); replace("alphabetical")', 'ceTrig alphabetical beta'],
        ['insertLink() goes in front of it', 'moveCursor(0, getLineNumber()); insertLink("[L]", "", "hint")', '[L]ceTrig alpha beta'],
        ['insertText() goes in front of it', 'moveCursor(0, getLineNumber()); insertText("[T]")', '[T]ceTrig alpha beta'],
    ])('finds a later group after %s', (_what, edit, after) => {
        fire(`${edit}; R3 = selectCaptureGroup(3); G3 = getSelection(); deselect(); LINE = getCurrentLine()`);
        expect(env.run('return LINE')).toBe(after);
        expect(env.run('return R3')).toBe(1);
        expect(env.run('return G3')).toBe('beta');
    });

    it('answers -1 for a group past the last and for group 0', () => {
        fire('PAST = selectCaptureGroup(4); ZERO = selectCaptureGroup(0); NAMED = selectCaptureGroup("nope")');
        expect(env.run('return PAST')).toBe(-1);
        expect(env.run('return ZERO')).toBe(-1);
        expect(env.run('return NAMED')).toBe(-1);
    });
});
