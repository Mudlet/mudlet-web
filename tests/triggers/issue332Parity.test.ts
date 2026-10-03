// @vitest-environment node
//
// Trigger tree drift measured against Mudlet desktop (issue #332). Each case
// below is a row from the issue, with desktop's result as the expectation.
//
//  1. A folder with patterns is a trigger like any other: it fires (command,
//     highlight) without a script, can be multiline, and keeps firing for its
//     fire length.
//  2. A script that disables its chain head or folder does not take the line
//     from the remaining children: desktop checks the parent's isActive() once,
//     on entry.
//  3. Fire-length windows and AND line deltas count the lines the trigger is
//     actually checked on, not raw line numbers — and switching a multiline
//     trigger off does not throw its partial states away.
//  4. A line spacer on a trigger that is not multiline lets every line through
//     to its children without running anything.
//  5. A colour pattern captures and highlights every run of its colour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    TriggerEngine,
    highlightTargets,
    type TriggerMatch,
    type TriggerNode,
} from '../../src/mud/triggers/TriggerEngine';

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

const re = (text: string): TriggerNode['patterns'] => [{ type: 'regex', text }];

/** The `matches` list ScriptingEngine hands the script for a fire. */
function luaMatches(m: TriggerMatch): (string | undefined)[] {
    return m.captureless ? [] : [m.matchedText, ...m.captures];
}

/**
 * Feed lines through the engine and collect the ids that fired per line.
 * `scripts` stands in for the trigger scripts: run on each fire, and handed a
 * way to flip a trigger's switch the way enableTrigger/disableTrigger do —
 * the store changes, and the engine is told mid-line.
 */
function makeFeeder(
    te: TriggerEngine,
    items: TriggerNode[],
    scripts: Record<string, (set: (id: string, on: boolean) => void) => void> = {},
) {
    let current = items;
    te.loadPerm(current);
    const set = (id: string, on: boolean) => {
        current = current.map(t => (t.id === id ? { ...t, enabled: on } : t));
        te.updateEnabled(current);
    };
    return (lines: string[]): string[][] => lines.map(line => {
        const fired: string[] = [];
        te.process(line, false, m => {
            fired.push(m.trigger.id);
            scripts[m.trigger.id]?.(set);
        });
        // The store's coalesced reload, between lines.
        te.loadPerm(current);
        return fired;
    });
}

describe('issue #332 — trigger tree parity with desktop', () => {
    let te: TriggerEngine;
    beforeEach(async () => {
        await TriggerEngine.ready();
        te = new TriggerEngine();
    });
    afterEach(() => {
        te.setColorMatcher(null);
        te.destroy();
    });

    describe('1. a folder with patterns runs like any trigger', () => {
        it('fires without a script, so its command is sent', () => {
            const group = trig({ id: 'g', isGroup: true, code: '', command: 'gcmdsent', patterns: re('GCMD') });
            const fired: TriggerMatch[] = [];
            te.loadPerm([group]);
            te.process('GCMD here', false, m => fired.push(m));
            expect(fired.map(m => m.trigger.id)).toEqual(['g']);
            expect(fired[0].trigger.command).toBe('gcmdsent');
            expect(luaMatches(fired[0])).toEqual(['GCMD']);
        });

        it('fires without a script, so its highlight has a match to paint', () => {
            const group = trig({
                id: 'g', isGroup: true, code: '', patterns: re('GHL'),
                highlight: { fg: '#ff0000', bg: '' },
            } as Partial<TriggerNode> & { id: string; patterns: TriggerNode['patterns'] });
            const fired: TriggerMatch[] = [];
            te.loadPerm([group]);
            te.process('a GHL b', false, m => fired.push(m));
            expect(fired).toHaveLength(1);
            expect(highlightTargets(luaMatches(fired[0]), fired[0].matchStart, fired[0].captureSpans, fired[0].groupCount))
                .toEqual([{ text: 'GHL', span: { start: 2, length: 3 } }]);
        });

        it('is multiline (AND) when asked to be, not OR', () => {
            const feed = makeFeeder(te, [trig({
                id: 'g', isGroup: true, code: '', multiline: true, delta: 1,
                patterns: [{ type: 'regex', text: 'GA1' }, { type: 'regex', text: 'GA2' }],
            })]);
            expect(feed(['GA1 first', 'GA2 second', 'GA2 alone'])).toEqual([[], ['g'], []]);
        });

        it('keeps firing for its fire length when it has no children', () => {
            const fired: TriggerMatch[][] = [];
            te.loadPerm([trig({ id: 'g', isGroup: true, code: '', fireLength: 2, patterns: re('GNK') })]);
            for (const line of ['GNK one', 'after1', 'after2', 'after3']) {
                const row: TriggerMatch[] = [];
                te.process(line, false, m => row.push(m));
                fired.push(row);
            }
            expect(fired.map(r => r.map(m => m.trigger.id))).toEqual([['g'], ['g'], ['g'], []]);
            // The kept lines run with no capture groups set: m = {}.
            expect(luaMatches(fired[1][0])).toEqual([]);
            expect(luaMatches(fired[2][0])).toEqual([]);
        });
    });

    describe('2. disabling the chain head or folder mid-line', () => {
        it('a head that disables itself still hands the line to its child', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'so', patterns: re('^SO') }),
                trig({ id: 'soc', parentId: 'so', patterns: re('SO') }),
            ], { so: set => set('so', false) });
            expect(feed(['SO line', 'SO again'])).toEqual([['so', 'soc'], []]);
        });

        it('a child that disables the head leaves the later children the line', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'cp', patterns: re('^CP') }),
                trig({ id: 'cp1', parentId: 'cp', patterns: re('CP') }),
                trig({ id: 'cp2', parentId: 'cp', patterns: re('CP') }),
            ], { cp1: set => set('cp', false) });
            expect(feed(['CP line', 'CP again'])).toEqual([['cp', 'cp1', 'cp2'], []]);
        });

        it('a child that disables its plain folder leaves its siblings the line', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'fold', isGroup: true, code: '', patterns: [] }),
                trig({ id: 'fo1', parentId: 'fold', patterns: re('FO') }),
                trig({ id: 'fo2', parentId: 'fold', patterns: re('FO') }),
            ], { fo1: set => set('fold', false) });
            expect(feed(['FO line', 'FO again'])).toEqual([['fo1', 'fo2'], []]);
        });

        it('a folder enabled by an earlier trigger on the line is open to its children', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'on', patterns: re('^ON') }),
                trig({ id: 'fold', isGroup: true, code: '', enabled: false, patterns: [] }),
                trig({ id: 'kid', parentId: 'fold', patterns: re('ON') }),
            ], { on: set => set('fold', true) });
            expect(feed(['ON now'])).toEqual([['on', 'kid']]);
        });
    });

    describe('3. fire length and AND deltas count checked lines', () => {
        it('a fire-length window behind a closed gate pauses until the gate opens', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'gate', patterns: re('GGATE') }),
                trig({ id: 'ppx', parentId: 'gate', fireLength: 3, patterns: re('PPX') }),
                trig({ id: 'cz', parentId: 'ppx', patterns: re('cz') }),
            ]);
            const fired = feed(['GGATE PPX cz1', 'cz2', 'GGATE cz3', 'GGATE cz4', 'GGATE cz5', 'GGATE cz6']);
            expect(fired.map(ids => ids.includes('cz'))).toEqual([true, false, true, true, true, false]);
        });

        it('a head switched off mid-window resumes it when switched back on', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'off', patterns: re('^DPOFF') }),
                trig({ id: 'on', patterns: re('^DPON') }),
                trig({ id: 'dp', fireLength: 3, patterns: re('DPX') }),
                trig({ id: 'dk', parentId: 'dp', patterns: re('dk') }),
            ], {
                off: set => set('dp', false),
                on: set => set('dp', true),
            });
            const fired = feed(['DPX dk1', 'dk2', 'DPOFF dk3', 'dk4', 'dk5', 'DPON', 'dk6', 'dk7']);
            expect(fired.map(ids => ids.includes('dk'))).toEqual([true, true, false, false, false, false, true, false]);
        });

        it('an AND child behind a gate ages only on the lines the gate lets through', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'gate', patterns: re('^ANDP') }),
                trig({
                    id: 'and', parentId: 'gate', multiline: true, delta: 1,
                    patterns: [{ type: 'regex', text: 'MA' }, { type: 'regex', text: 'MB' }],
                }),
            ]);
            expect(feed(['ANDP MA', 'filler1', 'filler2', 'ANDP MB'])).toEqual([['gate'], [], [], ['gate', 'and']]);
        });

        it('an AND trigger switched off between its conditions completes once back on', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'off', patterns: re('^OFFD') }),
                trig({ id: 'on', patterns: re('^OND') }),
                trig({
                    id: 'and', multiline: true, delta: 1,
                    patterns: [{ type: 'regex', text: 'DA1' }, { type: 'regex', text: 'DA2' }],
                }),
            ], {
                off: set => set('and', false),
                on: set => set('and', true),
            });
            expect(feed(['DA1', 'OFFD', 'f1', 'f2', 'OND DA2'])).toEqual([[], ['off'], [], [], ['on', 'and']]);
        });

        it('an AND child of a filter ages once per capture it is handed', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'fx', isFilter: true, patterns: re('^FX (\\w+) (\\w+)') }),
                trig({
                    id: 'and', parentId: 'fx', multiline: true, delta: 0,
                    patterns: [{ type: 'regex', text: 'p1' }, { type: 'regex', text: 'p2' }],
                }),
            ]);
            expect(feed(['FX p1 p2'])).toEqual([['fx']]);
        });

        it('setTriggerStayOpen on a head behind a closed gate is spent only when the gate is open', () => {
            const items = [
                trig({ id: 'gate', patterns: re('^G') }),
                trig({ id: 'head', parentId: 'gate', patterns: re('NEVER') }),
                trig({ id: 'kid', parentId: 'head', patterns: re('k') }),
            ];
            const feed = makeFeeder(te, items);
            te.setStayOpen(['head'], 2);
            const fired = feed(['k1', 'G k2', 'k3', 'G k4', 'G k5']);
            expect(fired.map(ids => ids.includes('kid'))).toEqual([false, true, false, true, false]);
        });
    });

    describe('4. a line spacer outside multiline mode', () => {
        it('is an always-open gate that runs nothing itself', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'spc', command: 'never', patterns: [{ type: 'lineSpacer', text: '1' }] }),
                trig({ id: 'kid', parentId: 'spc', patterns: re('SPCK') }),
            ]);
            expect(feed(['SPCK one', 'nothing', 'SPCK two'])).toEqual([['kid'], [], ['kid']]);
        });

        it('lets the line through after an OR pattern before it fails', () => {
            const feed = makeFeeder(te, [
                trig({
                    id: 'or',
                    patterns: [{ type: 'regex', text: 'NEVERMATCHES' }, { type: 'lineSpacer', text: '2' }],
                }),
                trig({ id: 'kid', parentId: 'or', patterns: re('SPOK') }),
            ]);
            expect(feed(['SPOK'])).toEqual([['kid']]);
        });

        it('hands a filter\'s children nothing', () => {
            const feed = makeFeeder(te, [
                trig({ id: 'f', isFilter: true, patterns: [{ type: 'lineSpacer', text: '1' }] }),
                trig({ id: 'kid', parentId: 'f', patterns: re('X') }),
            ]);
            expect(feed(['X'])).toEqual([[]]);
        });
    });

    describe('5. a colour pattern with several runs on the line', () => {
        // `a ␛[33myel1␛[0m b ␛[33myel2␛[0m c`
        const line = 'a yel1 b yel2 c';
        const runs = [{ text: 'yel1', start: 2 }, { text: 'yel2', start: 9 }];

        it('captures and highlights every run', () => {
            te.setColorMatcher(() => runs);
            te.loadPerm([trig({ id: 'c', patterns: [{ type: 'colorTrigger', text: 'ANSI_COLORS_F{003}_B{IGNORE}' }] })]);
            const fired: TriggerMatch[] = [];
            te.process(line, false, m => fired.push(m));
            expect(fired).toHaveLength(1);
            expect(luaMatches(fired[0])).toEqual(['yel1', 'yel2']);
            expect(highlightTargets(luaMatches(fired[0]), fired[0].matchStart, fired[0].captureSpans, fired[0].groupCount))
                .toEqual([
                    { text: 'yel1', span: { start: 2, length: 4 } },
                    { text: 'yel2', span: { start: 9, length: 4 } },
                ]);
        });

        it('captures every run for a filter\'s own script, and hands each to its children', () => {
            te.setColorMatcher(() => [{ text: 'green1', start: 2 }, { text: 'green2', start: 11 }]);
            te.loadPerm([
                trig({ id: 'f', isFilter: true, patterns: [{ type: 'colorTrigger', text: 'ANSI_COLORS_F{002}_B{IGNORE}' }] }),
                trig({ id: 'kid', parentId: 'f', patterns: re('green\\d') }),
            ]);
            const fired: TriggerMatch[] = [];
            te.process('a green1 b green2 c', false, m => fired.push(m));
            expect(fired.map(m => [m.trigger.id, luaMatches(m)])).toEqual([
                ['f', ['green1', 'green2']],
                ['kid', ['green1']],
                ['kid', ['green2']],
            ]);
        });
    });
});
