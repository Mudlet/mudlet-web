// @vitest-environment node
//
// mudlet-web#272, item 5 — `tempTrigger("")` and `tempRegexTrigger("")` make a
// trigger and return its id on desktop Mudlet, and it never fires: blank
// patterns are compacted out as the trigger is compiled
// (TTrigger::setRegexCodeList). Mudlet Web fired both on every line.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { TriggerEngine } from '../../src/mud/triggers/TriggerEngine';

describe('temp triggers with an empty pattern (#272)', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        await TriggerEngine.ready();
        env = await createTestRuntime();
    });
    afterEach(() => env.dispose());

    const feed = (...lines: string[]) => {
        for (const raw of lines) {
            const buffer = new AnsiAwareBuffer(raw);
            env.api.beginLine(buffer);
            env.api.triggers.processTemp(buffer.text);
            env.api.endLine();
        }
    };

    it.each(['tempTrigger', 'tempRegexTrigger', 'tempBeginOfLineTrigger', 'tempExactMatchTrigger'])(
        '%s("") returns an id and never fires',
        (fn) => {
            const id = env.run(`__hits = 0
                return ${fn}("", function() __hits = __hits + 1 end)`);
            expect(typeof id).toBe('number');
            feed('P0 before', '', 'P1 after');
            expect(env.run('return __hits')).toBe(0);
            // The id is a real trigger's: killTrigger finds it.
            expect(env.run(`return killTrigger(${id as number})`)).toBe(true);
        },
    );

    it('a non-empty pattern still fires', () => {
        env.run(`__hits = 0
            tempTrigger("P", function() __hits = __hits + 1 end)`);
        feed('P0 before', 'x', 'P1 after');
        expect(env.run('return __hits')).toBe(2);
    });
});
