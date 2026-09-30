// @vitest-environment node
//
// Trigger kinds only a package can carry, as upstream Trigger_spec's
// "trigger kinds that only a package can carry" and "colour pattern triggers"
// pin them (Mudlet/mudlet-web#256):
//
//  - a colour pattern naming a colour no palette has leaves its trigger in
//    place but switched off, like a regex that does not compile;
//  - a colour filter hands EVERY coloured run on the line to its children;
//  - a multiline filter hands down each row of the completed state — a regex
//    row's groups, the matched text of a row whose pattern has none;
//  - a lua condition in a multiline trigger takes an empty multimatches row.

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerNode, type TriggerMatch } from '../../src/mud/triggers/TriggerEngine';

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

function feed(te: TriggerEngine, lines: string[]): TriggerMatch[][] {
    return lines.map(line => {
        const fired: TriggerMatch[] = [];
        te.process(line, false, m => fired.push(m));
        return fired;
    });
}

describe('trigger kinds only a package can carry', () => {
    let te: TriggerEngine;
    beforeEach(async () => { await TriggerEngine.ready(); te = new TriggerEngine(); });

    it('switches off a trigger whose colour pattern names no ANSI colour', () => {
        te.setColorMatcher(() => [{ text: 'greenrun', start: 0 }]);
        te.loadPerm([
            trig({ id: 'usable', patterns: [{ type: 'colorTrigger', text: 'ANSI_COLORS_F{002}_B{IGNORE}' }] }),
            trig({
                id: 'unusable', patterns: [
                    { type: 'colorTrigger', text: 'ANSI_COLORS_F{002}_B{IGNORE}' },
                    { type: 'colorTrigger', text: 'ANSI_COLORS_F{999}_B{IGNORE}' },
                ],
            }),
        ]);
        expect(te.hasInvalidPattern('usable')).toBe(false);
        expect(te.hasInvalidPattern('unusable')).toBe(true);
        expect(feed(te, ['greenrun'])[0].map(m => m.trigger.id)).toEqual(['usable']);
    });

    it('passes every coloured run on to a colour filter\'s children', () => {
        const line = 'plain first run plain second end';
        te.setColorMatcher(() => [
            { text: 'first run', start: line.indexOf('first run') },
            { text: 'second', start: line.indexOf('second') },
        ]);
        te.loadPerm([
            trig({ id: 'parent', isFilter: true, patterns: [{ type: 'colorTrigger', text: 'ANSI_COLORS_F{002}_B{IGNORE}' }] }),
            trig({ id: 'child', parentId: 'parent', patterns: [{ type: 'regex', text: '^(.+)$' }] }),
        ]);
        const fired = feed(te, [line])[0];
        expect(fired.filter(m => m.trigger.id === 'child').map(m => m.captures[0]))
            .toEqual(['first run', 'second']);
    });

    it('passes a completed multiline state\'s rows on', () => {
        te.loadPerm([
            trig({
                id: 'parent', isFilter: true, multiline: true, delta: 3, patterns: [
                    { type: 'regex', text: '^tkmlf (\\w+)$' },
                    { type: 'substring', text: 'tkmlf end' },
                ],
            }),
            trig({ id: 'child', parentId: 'parent', patterns: [{ type: 'regex', text: '^(.+)$' }] }),
        ]);
        const [first, second] = feed(te, ['tkmlf alpha', 'then tkmlf end of it']);
        expect(first).toEqual([]);
        expect(second.filter(m => m.trigger.id === 'child').map(m => m.captures[0]))
            .toEqual(['alpha', 'tkmlf end']);
    });

    it('gives a lua condition of a multiline trigger an empty row', () => {
        te.setLuaEval((_code, text) => text.includes('tkmlk lua'));
        te.loadPerm([
            trig({
                id: 'kinds', multiline: true, delta: 5, patterns: [
                    { type: 'startOfLine', text: 'tkmlk start' },
                    { type: 'luaFunction', text: 'return true' },
                    { type: 'substring', text: 'tkmlk middle' },
                ],
            }),
        ]);
        const fired = feed(te, ['tkmlk start here', 'the tkmlk lua line', 'it has tkmlk middle in it']).flat();
        expect(fired).toHaveLength(1);
        expect(fired[0].multimatches?.map(row => row.join('|')))
            .toEqual(['tkmlk start', '', 'tkmlk middle']);
    });
});
