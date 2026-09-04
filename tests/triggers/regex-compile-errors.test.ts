// @vitest-environment node
//
// Regression for silently-dropped trigger patterns. A regex that fails to
// compile was swallowed by TriggerEngine's compilePcre (`catch { return null; }`)
// with no logging and no reporting channel: the trigger saved cleanly, never
// fired, and nothing appeared in the Errors tab or the console (mudlet-web#60).
//
// Desktop Mudlet builds a full message from pcre2_get_error_message in
// TTrigger::setRegexCodeList — `Error: in item %1, perl regex "%2" failed to
// compile, reason: "%3".` (src/TTrigger.cpp:144-153) — and the editor surfaces
// it on the item. This asserts the equivalent report reaches the reporter that
// ScriptingEngine wires to the error log.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';

function trig(over: Partial<TriggerNode> & { id: string; patterns: TriggerNode['patterns'] }): TriggerNode {
    return {
        name: over.id,
        enabled: true,
        isGroup: false,
        parentId: null,
        code: 'x',
        language: 'lua',
        fireLength: 0,
        multipleMatches: false,
        multiline: false,
        delta: 0,
        isFilter: false,
        ...over,
    } as TriggerNode;
}

type Report = { message: string; source?: { id: string; name: string } };

describe('TriggerEngine invalid-regex reporting', () => {
    let te: TriggerEngine;
    let reports: Report[];

    beforeEach(async () => {
        await TriggerEngine.ready();
        te = new TriggerEngine();
        reports = [];
        te.setCompileErrorReporter((message, source) => reports.push({ message, source }));
    });

    // The reporter ref is module-level, so it has to be cleared between tests.
    afterEach(() => { te.setCompileErrorReporter(null); te.destroy(); });

    it('reports a permanent trigger pattern that fails to compile', () => {
        te.loadPerm([trig({ id: 't1', name: 'qa-badregex', patterns: [{ type: 'regex', text: '(unclosed' }] })]);

        expect(reports).toHaveLength(1);
        expect(reports[0].source).toEqual({ id: 't1', name: 'qa-badregex' });
        // Mudlet's wording, including the 1-based item number and the PCRE2 reason.
        expect(reports[0].message).toMatch(/^Error: in item 1, perl regex "\(unclosed" failed to compile, reason: ".+"\.$/);
    });

    it('numbers the item by its position in the trigger\'s pattern list', () => {
        te.loadPerm([trig({
            id: 't2',
            patterns: [
                { type: 'regex', text: 'fine' },
                { type: 'regex', text: 'also fine' },
                { type: 'regex', text: '*bad' },
            ],
        })]);

        expect(reports).toHaveLength(1);
        expect(reports[0].message).toContain('in item 3');
    });

    it('reports a bad condition on an AND (multiline) trigger too', () => {
        te.loadPerm([trig({
            id: 't3',
            multiline: true,
            patterns: [
                { type: 'regex', text: '^A1$' },
                { type: 'regex', text: '(unclosed' },
            ],
        })]);

        expect(reports).toHaveLength(1);
        expect(reports[0].message).toContain('in item 2');
    });

    it('reports a temporary regex trigger that fails to compile, with no source node', () => {
        const dispose = te.addTemp('(unclosed', () => {}, 'regex', { name: 'qa-temp' });

        expect(reports).toHaveLength(1);
        expect(reports[0].source).toBeUndefined();
        expect(reports[0].message).toContain('perl regex "(unclosed" in "qa-temp" failed to compile');
        dispose();
    });

    it('reports each bad pattern once, not on every reload of an unchanged trigger', () => {
        const items = [trig({ id: 't4', patterns: [{ type: 'regex', text: '(unclosed' }] })];
        te.loadPerm(items);
        te.loadPerm(items);
        te.loadPerm(items);

        expect(reports).toHaveLength(1);
    });

    it('stays quiet for patterns that compile, and does not double-report under multipleMatches', () => {
        te.loadPerm([
            trig({ id: 'ok', patterns: [{ type: 'regex', text: '^(\\d+) gold$' }] }),
            trig({ id: 'bad', multipleMatches: true, patterns: [{ type: 'regex', text: '(unclosed' }] }),
        ]);

        expect(reports).toHaveLength(1);
        expect(reports[0].source?.id).toBe('bad');
    });
});
