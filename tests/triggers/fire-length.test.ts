// @vitest-environment node
//
// Regression for trigger "fire length" (Mudlet's mStayOpen/mKeepFiring): "Keep
// firing the script for this many more lines, after the trigger or chain has
// matched."
//
// Desktop arms mKeepFiring in BOTH branches of TTrigger::match — the
// single-line one at src/TTrigger.cpp:995-999 and the multiline completion at
// src/TTrigger.cpp:1016 — and spends it at src/TTrigger.cpp:1083-1090. mudix
// only armed it inside the AND (multiline) branch, so fire length was silently
// inert on single-line (OR) triggers while the editor offered the field
// identically in both modes (mudlet-web#61).

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

/** Feed each line through the engine, returning the ids that fired per line. */
function feed(te: TriggerEngine, lines: string[]): string[][] {
    return lines.map(line => {
        const fired: string[] = [];
        te.process(line, false, (m) => fired.push(m.trigger.id));
        return fired;
    });
}

describe('TriggerEngine fire length', () => {
    let te: TriggerEngine;
    beforeEach(async () => { await TriggerEngine.ready(); te = new TriggerEngine(); });

    it('keeps firing a single-line (OR) trigger for the configured number of lines', () => {
        te.loadPerm([trig({
            id: 'fl',
            fireLength: 2,
            patterns: [{ type: 'regex', text: '^FLSTART$' }],
        })]);

        // Desktop fires on FLSTART and on the next two lines, then stops.
        expect(feed(te, ['FLSTART', 'lineA', 'lineB', 'lineC']))
            .toEqual([['fl'], ['fl'], ['fl'], []]);
    });

    it('re-arms the fire length when the OR trigger matches again', () => {
        te.loadPerm([trig({
            id: 'fl',
            fireLength: 1,
            patterns: [{ type: 'regex', text: '^GO$' }],
        })]);

        expect(feed(te, ['GO', 'a', 'GO', 'b', 'c']))
            .toEqual([['fl'], ['fl'], ['fl'], ['fl'], []]);
    });

    it('leaves a fire length of zero firing only on the matching line', () => {
        te.loadPerm([trig({
            id: 'plain',
            fireLength: 0,
            patterns: [{ type: 'regex', text: '^GO$' }],
        })]);

        expect(feed(te, ['GO', 'a', 'b'])).toEqual([['plain'], [], []]);
    });

    it('does not re-run a chain head that has children (Mudlet mpMyChildrenList->empty())', () => {
        te.loadPerm([
            trig({ id: 'head', fireLength: 2, patterns: [{ type: 'regex', text: '^GO$' }] }),
            trig({ id: 'kid', parentId: 'head', patterns: [{ type: 'regex', text: 'never' }] }),
        ]);

        expect(feed(te, ['GO', 'a', 'b'])).toEqual([['head'], [], []]);
    });

    it('still honours the fire length on AND (multiline) triggers', () => {
        te.loadPerm([trig({
            id: 'and',
            multiline: true,
            fireLength: 2,
            // The two conditions land on consecutive lines, so the state has to
            // survive one line past the one that opened it — Mudlet's
            // conditonLineDelta, where 0 means the opening line only (see
            // tests/triggers/lineDelta.test.ts). Orthogonal to the fire length
            // under test, which starts counting once the trigger has completed.
            delta: 1,
            patterns: [
                { type: 'regex', text: '^A1$' },
                { type: 'regex', text: '^A2$' },
            ],
        })]);

        expect(feed(te, ['A1', 'A2', 'q', 'w', 'e']))
            .toEqual([[], ['and'], ['and'], ['and'], []]);
    });
});
