// @vitest-environment node
//
// A trigger's `send()` echoes the command into the main buffer, and that echo
// must not take the trigger cursor with it (mudlet-web#180). Desktop's
// TConsole::printCommand appends the echo while the trigger engine is running
// but leaves the cursor on the line being matched, so the common "send, then
// gag" trigger —
//
//     tempTrigger("a coin falls", function() send("get coin"); deleteLine() end)
//
// — removes the game line and keeps the echo. Mudlet Web moved the cursor onto
// the echo, so deleteLine()/getCurrentLine()/selectString() acted on the
// command instead of the game text.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('send() inside a trigger', () => {
    let t: TestRuntime;
    beforeEach(async () => { t = await createTestRuntime(); });
    afterEach(() => t.dispose());

    /** Run `code` as a trigger on `line` would: with the line appended and the
     *  trigger cursor on it. */
    const onLine = (line: string, code: string): unknown => {
        t.api.beginLine(new AnsiAwareBuffer(line));
        const result = t.run(code);
        t.api.endLine();
        t.api.flushDeferredEcho();
        return result;
    };

    const lines = (): string[] => {
        const con = t.session.consoles.get('main')!;
        return con.getLines(0, con.getLineCount() + 1).map(plain).filter(l => l !== '');
    };

    it('leaves the cursor on the matched line', () => {
        expect(onLine('a coin falls', 'send("get coin"); return getCurrentLine()')).toBe('a coin falls');
    });

    it('gags the game line, not the echo, on send-then-deleteLine', () => {
        onLine('marker one', '');
        onLine('a coin falls', 'send("get coin"); deleteLine()');
        onLine('marker two', '');
        expect(lines()).toEqual(['marker one', 'get coin', 'marker two']);
    });

    it('still puts a command sent outside a trigger under the cursor', () => {
        t.session.echoCommand('look');
        expect(plain(String(t.run('return getCurrentLine()')))).toBe('look');
    });
});
