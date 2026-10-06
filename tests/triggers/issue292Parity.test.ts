// @vitest-environment node
//
// Trigger drift measured against Mudlet desktop (issue #292). Each case below is
// a row from the issue, with desktop's result as the expectation.
//
//  1. "Match all" on an OR trigger with several patterns used only the LAST
//     pattern: one match-all matcher per trigger, overwritten by each pattern
//     as it compiled. Desktop applies the flag per pattern inside the pattern's
//     own process*Match, and the first pattern to match wins. A multiline
//     trigger's rows likewise carry every occurrence.
//  2. A fire that set no capture groups — a Lua-function or prompt pattern, or
//     a fire-length (stay-open) line — must leave `matches` empty, not the line
//     or the opening line's captures replayed.
//  3. A capture-less multiline condition (line spacer, Lua function, prompt)
//     takes an EMPTY multimatches row, not {""}.
//  4. A Lua-function trigger's highlight paints nothing.
//  5. A substring / begin-of-line / exact-match child of a filter is positioned
//     inside the capture it matched, not at the needle's first occurrence in
//     the whole line.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    TriggerEngine,
    highlightTargets,
    type TriggerMatch,
    type TriggerNode,
} from '../../src/mud/triggers/TriggerEngine';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

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

/** The `matches` list ScriptingEngine hands the script for a fire. */
function luaMatches(m: TriggerMatch): (string | undefined)[] {
    return m.captureless ? [] : [m.matchedText, ...m.captures];
}

/** Every fire per line, in order. */
function feed(te: TriggerEngine, lines: (string | [string, boolean])[]): TriggerMatch[][] {
    return lines.map(entry => {
        const [line, isPrompt] = typeof entry === 'string' ? [entry, false] : entry;
        const fired: TriggerMatch[] = [];
        te.process(line, isPrompt, m => fired.push(m));
        return fired;
    });
}

/** The columns the built-in highlight paints for a fire, as [start, end]. */
function painted(m: TriggerMatch): [number, number][] {
    return highlightTargets(luaMatches(m), m.matchStart, m.captureSpans, m.groupCount)
        .map(({ span }) => [span!.start, span!.start + span!.length - 1]);
}

describe('issue #292 — trigger parity with desktop', () => {
    let te: TriggerEngine;
    beforeEach(async () => {
        await TriggerEngine.ready();
        te = new TriggerEngine();
    });
    afterEach(() => {
        te.setLuaEval(null);
        te.destroy();
    });

    describe('1. match all on an OR trigger uses every pattern', () => {
        it('collects the occurrences of the FIRST pattern that matches', () => {
            te.loadPerm([trig({
                id: 'ma', multipleMatches: true,
                patterns: [{ type: 'regex', text: '(a)x' }, { type: 'regex', text: '(b)x' }],
            })]);
            const [all, only] = feed(te, ['ax bx ax', 'ax only']);
            expect(all.map(luaMatches)).toEqual([['ax', 'a', 'ax', 'a']]);
            expect(only.map(luaMatches)).toEqual([['ax', 'a']]);
        });

        it('fires on an earlier substring pattern, and does not try the later ones', () => {
            te.loadPerm([trig({
                id: 'ma', multipleMatches: true,
                patterns: [{ type: 'substring', text: 'cy' }, { type: 'regex', text: '(d)y' }],
            })]);
            const [only, both] = feed(te, ['cy only', 'cy dy']);
            expect(only.map(luaMatches)).toEqual([['cy']]);
            expect(both.map(luaMatches)).toEqual([['cy']]);
        });

        it('highlights every occurrence of the pattern that matched', () => {
            te.loadPerm([trig({
                id: 'ma', multipleMatches: true,
                patterns: [{ type: 'substring', text: 'ez' }, { type: 'substring', text: 'fz' }],
            })]);
            const [[m]] = feed(te, ['ez fz ez']);
            expect(painted(m)).toEqual([[0, 1], [6, 7]]);
        });

        it('puts every occurrence in a multiline row', () => {
            te.loadPerm([trig({
                id: 'mma', multiline: true, multipleMatches: true, delta: 1,
                patterns: [{ type: 'regex', text: 'MMA(\\d)' }, { type: 'regex', text: 'MMB(\\d)' }],
            })]);
            const fired = feed(te, ['MMA1 MMA2', 'MMB3 MMB4']).flat();
            expect(fired).toHaveLength(1);
            expect(fired[0].multimatches).toEqual([
                ['MMA1', '1', 'MMA2', '2'],
                ['MMB3', '3', 'MMB4', '4'],
            ]);
        });
    });

    describe('2. a fire without captures leaves matches empty', () => {
        it('Lua-function pattern', () => {
            te.setLuaEval(() => true);
            te.loadPerm([trig({ id: 'luaf', patterns: [{ type: 'luaFunction', text: 'return true' }] })]);
            const [[m]] = feed(te, ['LUAF test']);
            expect(luaMatches(m)).toEqual([]);
        });

        it('prompt pattern', () => {
            te.loadPerm([trig({ id: 'pr', patterns: [{ type: 'prompt', text: '' }] })]);
            const [[m]] = feed(te, [['PR 100hp> ', true]]);
            expect(luaMatches(m)).toEqual([]);
        });

        it('temp prompt trigger (mudlet-web#331)', () => {
            const got: (string | undefined)[][] = [];
            te.addTemp('', matches => { got.push(matches); }, 'prompt');
            feed(te, ['not a prompt', ['PRM> ', true]]);
            expect(got).toEqual([[]]);
        });

        it('fire-length lines after the match', () => {
            te.loadPerm([trig({ id: 'so', fireLength: 2, patterns: [{ type: 'substring', text: 'STAYO' }] })]);
            const [open, a1, a2, a3] = feed(te, ['STAYO', 'after1', 'after2', 'after3']);
            expect(open.map(luaMatches)).toEqual([['STAYO']]);
            expect(a1.map(luaMatches)).toEqual([[]]);
            expect(a2.map(luaMatches)).toEqual([[]]);
            expect(a3).toEqual([]);
        });

        it('fire-length lines after a match-all match', () => {
            te.loadPerm([trig({
                id: 'soma', fireLength: 1, multipleMatches: true,
                patterns: [{ type: 'regex', text: 'SOMA(\\d)' }],
            })]);
            const [open, after] = feed(te, ['SOMA1 SOMA2', 'after']);
            expect(open.map(luaMatches)).toEqual([['SOMA1', '1', 'SOMA2', '2']]);
            expect(after.map(luaMatches)).toEqual([[]]);
            expect(after[0].multimatches).toBeUndefined();
        });

        it('fire-length lines after a multiline match carry no multimatches', () => {
            te.loadPerm([trig({
                id: 'ms', multiline: true, fireLength: 1, delta: 1,
                patterns: [{ type: 'substring', text: 'MSA' }, { type: 'substring', text: 'MSB' }],
            })]);
            const [, done, after] = feed(te, ['MSA', 'MSB', 'after1']);
            expect(done[0].multimatches).toEqual([['MSA'], ['MSB']]);
            expect(after).toHaveLength(1);
            expect(after[0].multimatches).toBeUndefined();
            expect(luaMatches(after[0])).toEqual([]);
        });
    });

    describe('3. capture-less multiline conditions take an empty row', () => {
        it('Lua function', () => {
            te.setLuaEval(() => true);
            te.loadPerm([trig({
                id: 'mx', multiline: true, delta: 1,
                patterns: [
                    { type: 'startOfLine', text: 'MXA' },
                    { type: 'luaFunction', text: 'return true' },
                    { type: 'exactMatch', text: 'MXE' },
                ],
            })]);
            const fired = feed(te, ['MXA start', 'MXE']).flat();
            expect(fired).toHaveLength(1);
            expect(fired[0].multimatches).toEqual([['MXA'], [], ['MXE']]);
        });

        it('prompt', () => {
            te.loadPerm([trig({
                id: 'rp', multiline: true,
                patterns: [{ type: 'regex', text: '^RP (\\d+)' }, { type: 'prompt', text: '' }],
            })]);
            const fired = feed(te, [['RP 5> ', true]]).flat();
            expect(fired[0].multimatches).toEqual([['RP 5', '5'], []]);
        });

        it('line spacer', () => {
            te.loadPerm([trig({
                id: 'sp', multiline: true, delta: 2,
                patterns: [
                    { type: 'substring', text: 'SPA' },
                    { type: 'lineSpacer', text: '1' },
                    { type: 'substring', text: 'SPB' },
                ],
            })]);
            const fired = feed(te, ['SPA', 'SPB']).flat();
            expect(fired[0].multimatches).toEqual([['SPA'], [], ['SPB']]);
        });
    });

    it('4. a Lua-function trigger highlights nothing', () => {
        te.setLuaEval(() => true);
        te.loadPerm([trig({
            id: 'hl', highlight: { fg: '#ff0000', bg: '#ffff00' },
            patterns: [{ type: 'luaFunction', text: 'return true' }],
        } as Partial<TriggerNode> & { id: string; patterns: TriggerNode['patterns'] })]);
        const [[m]] = feed(te, ['zz HLLUA line']);
        expect(m.matchedText).toBe('');
        expect(painted(m)).toEqual([]);
    });

    describe('5. filter children are positioned inside the capture they matched', () => {
        function filterWithChild(filterRe: string, child: TriggerNode['patterns'][number]) {
            te.loadPerm([
                trig({ id: 'f', isFilter: true, patterns: [{ type: 'regex', text: filterRe }] }),
                trig({ id: 'c', parentId: 'f', patterns: [child] }),
            ]);
        }
        const childColumns = (line: string) =>
            feed(te, [line]).flat().filter(m => m.trigger.id === 'c').flatMap(painted);

        it('substring child', () => {
            filterWithChild('^HF (\\w+) (\\w+)$', { type: 'substring', text: 'b' });
            expect(childColumns('HF abc xqrb')).toEqual([[4, 4], [10, 10]]);
            expect(childColumns('HF xyb abc')).toEqual([[5, 5], [8, 8]]);
        });

        it('begin-of-line child', () => {
            filterWithChild('^HK (\\w+) (\\w+)$', { type: 'startOfLine', text: 'xq' });
            expect(childColumns('HK xq xqrb')).toEqual([[3, 4], [6, 7]]);
        });

        it('exact-match child', () => {
            filterWithChild('^HL2 (\\w+) (\\w+)$', { type: 'exactMatch', text: 'xq' });
            expect(childColumns('HL2 xq xq')).toEqual([[4, 5], [7, 8]]);
        });
    });
});

describe('issue #292 — the script sees an empty matches table', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('after a captured fire, a capture-less one reads #matches == 0', () => {
        env.rt.runWithMatches('R1 = #matches', 'opening', ['STAYO']);
        env.rt.runWithMatches('R2 = #matches; R3 = #multimatches', 'follow-up', []);
        expect(env.run('return R1')).toBe(1);
        expect(env.run('return R2')).toBe(0);
        expect(env.run('return R3')).toBe(0);
    });
});
