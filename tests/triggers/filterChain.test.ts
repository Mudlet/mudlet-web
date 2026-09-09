// @vitest-environment node
//
// Parity for what a FILTER trigger ("only pass matches to children") hands its
// children, and for what its children see once the chain is only being held
// open by the fire length.
//
// Desktop reaches a filter's children exclusively through `TTrigger::filter()`
// — the ordinary children loop in `TTrigger::match` is guarded by
// `!mFilterTrigger` (src/TTrigger.cpp:1072) — and the regex path only calls it
// when the capture list holds more than the whole match
// (src/TTrigger.cpp:419-438). So a filter whose pattern has no capture groups
// passes NOTHING down, and its children never see the line (mudlet-web#157).
//
// The one way past that is the `mKeepFiring` branch (:1083-1093), which runs on
// a line the trigger did NOT match and hands the children the haystack it was
// given — unfiltered. Mudlet Web instead left the last capture standing, so a child
// on a later line of the chain matched against text from the line before
// (mudlet-web#160).

import { describe, it, expect, beforeEach } from 'vitest';
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

/** Feed each line, returning `id:matches[1]` for everything that fired on it. */
function feed(te: TriggerEngine, lines: string[]): string[][] {
    return lines.map(line => {
        const fired: string[] = [];
        te.process(line, false, (m) => fired.push(`${m.trigger.id}:${m.matchedText}`));
        return fired;
    });
}

describe('filter triggers', () => {
    let te: TriggerEngine;
    beforeEach(async () => { await TriggerEngine.ready(); te = new TriggerEngine(); });

    it('passes nothing to children when the regex has no capture groups', () => {
        // mudlet-web#157: desktop fires only the parent here. Mudlet Web handed the
        // child the whole match ("test456"), which `^test` then matched.
        te.loadPerm([
            trig({ id: 'parent', isFilter: true, patterns: [{ type: 'regex', text: 'test\\d+$' }] }),
            trig({ id: 'child', parentId: 'parent', patterns: [{ type: 'regex', text: '^test' }] }),
        ]);

        expect(feed(te, ['123test456'])).toEqual([['parent:test456']]);
    });

    it('passes each capture group, and only the capture groups', () => {
        te.loadPerm([
            trig({ id: 'parent', isFilter: true, patterns: [{ type: 'regex', text: 'hit (\\w+) for (\\d+)' }] }),
            trig({ id: 'child', parentId: 'parent', patterns: [{ type: 'regex', text: '^.+$' }] }),
        ]);

        // Two offerings, so the child runs twice — never with the whole match.
        expect(feed(te, ['you hit orc for 12 damage']))
            .toEqual([['parent:hit orc for 12', 'child:orc', 'child:12']]);
    });

    it('still passes the whole match for a substring pattern', () => {
        // processSubstringMatch filters `captureList.front()` unconditionally
        // (src/TTrigger.cpp:498) — the group-less rule is regex-only.
        te.loadPerm([
            trig({ id: 'parent', isFilter: true, patterns: [{ type: 'substring', text: 'orc' }] }),
            trig({ id: 'child', parentId: 'parent', patterns: [{ type: 'regex', text: '^orc$' }] }),
        ]);

        expect(feed(te, ['you hit the orc'])).toEqual([['parent:orc', 'child:orc']]);
    });

    it('gives the children the unfiltered line while the fire length holds the chain open', () => {
        // mudlet-web#160, transcribed from the issue's desktop transcript.
        te.loadPerm([
            trig({ id: 'parent', isFilter: true, fireLength: 1, patterns: [{ type: 'regex', text: '^test$' }] }),
            trig({ id: 'child', parentId: 'parent', patterns: [{ type: 'regex', text: '^.*$' }] }),
        ]);

        expect(feed(te, ['test', 'foo'])).toEqual([
            ['parent:test'],   // no capture groups → the child gets no look
            ['child:foo'],     // keepFiring branch → the child sees the whole line
        ]);
    });

    it('keeps the filtered text for the children on the line the filter matched', () => {
        te.loadPerm([
            trig({ id: 'parent', isFilter: true, fireLength: 1, patterns: [{ type: 'regex', text: '^say (.+)$' }] }),
            trig({ id: 'child', parentId: 'parent', patterns: [{ type: 'regex', text: '^.*$' }] }),
        ]);

        expect(feed(te, ['say hello', 'say hello'])).toEqual([
            ['parent:say hello', 'child:hello'],
            ['parent:say hello', 'child:hello'],
        ]);
    });
});
