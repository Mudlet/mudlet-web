// @vitest-environment node
//
// A command echo must close the in-flight script partial before it prints.
//
// `echo("TEST")` with no trailing newline leaves the main console's `partial`
// open and accumulating, and flushOutput emits that WHOLE partial as a
// 'script-partial' message each time — the renderer updates one element in
// place, so re-emitting the same growing text is normally free. A command echo
// breaks that: 'echo' is a non-partial message, so the renderer finalizes the
// element and the next 'script-partial' has to build a new one — which then
// contains everything the finalized element is already showing.
//
// Reported against an alias whose code is `echo("TEST")`: repeating it printed
// ggTEST, ggTESTTEST, ggTESTTESTTEST… where Mudlet prints one TEST per gg
// (its printCommand writes into the very buffer line echo() is building, so
// there is no second copy to make).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/** Strip the SGR escapes styleEchoCommand wraps a command echo in. */
const plain = (message: unknown): string => {
    const text = typeof message === 'string' ? message : String((message as { text?: string })?.text ?? message);
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '');
};

describe('command echo vs. an open script partial', () => {
    let t: TestRuntime;
    let messages: [string, string][];

    beforeEach(async () => {
        t = await createTestRuntime();
        messages = [];
        t.session.events.on('message', (text, kind) => {
            messages.push([kind ?? '', plain(text)]);
        });
    });
    afterEach(() => t.dispose());

    it('emits each echo once, however many commands interleave', () => {
        // The reported sequence: an alias that echoes, run three times, with the
        // typed command echoed in between each run.
        for (let i = 0; i < 3; i++) {
            t.session.echoCommand('gg');
            t.api.echo('TEST');
            t.api.flushOutput();
        }
        expect(messages).toEqual([
            ['echo', 'gg'], ['script-partial', 'TEST'],
            ['echo', 'gg'], ['script-partial', 'TEST'],
            ['echo', 'gg'], ['script-partial', 'TEST'],
        ]);
    });

    it('still accumulates a partial across echoes with no command between', () => {
        // Nothing finalizes the element in this case, so the console is right to
        // keep building one line — that is what Mudlet's open line does too.
        t.api.echo('A');
        t.api.flushOutput();
        t.api.echo('B');
        t.api.flushOutput();
        expect(messages).toEqual([
            ['script-partial', 'A'],
            ['script-partial', 'AB'],
        ]);
    });

    it('keeps the closed partial in the buffer, above the command', () => {
        // Closing it must not lose it: getLines()/the cursor APIs still have to
        // see what the player can plainly read.
        t.api.echo('TEST');
        t.api.flushOutput();
        t.session.echoCommand('gg');
        // Asked for the lines that exist rather than a round number: getLines()
        // does not clamp — it answers exactly abs(to - from) entries, filling
        // past the end with Mudlet's invalid-line string — so a 10-wide window
        // on a two-line buffer is eight sentinels and the open line, not a short
        // list. That is the contract EmptyBufferOps_spec is built on.
        const con = t.session.consoles.get('main')!;
        const lines = con.getLines(0, con.getLineCount() + 1).map(plain);
        expect(lines).toEqual(['TEST', 'gg']);
    });
});
