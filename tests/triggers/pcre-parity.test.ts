// @vitest-environment node
//
// The match shape the PCRE2 wrapper (`src/mud/triggers/pcre/Pcre2.ts`) hands
// the trigger engine: full match, captures with their offsets, named groups,
// an unset optional group as start/end -1, and no match as null. The wrapper
// shares a pre-encoded line buffer and reuses match data across calls; these
// expectations were recorded from the upstream `pcre2-wasm-universal` wrapper
// it was forked from (PCRE2 10.34), which the module built by
// wasm/pcre2/build.sh replaced, so a change of engine or wrapper that alters
// what a trigger sees fails here.

import { describe, it, expect } from 'vitest';
import VendoredPCRE from '../../src/mud/triggers/pcre/Pcre2';

type Group = { start: number; end: number; match: string; name?: string };
type Norm = { length: number; groups: Group[]; named: Record<string, string> } | null;

// Collapse a wrapper match result into a structure comparable across the two
// implementations: positional groups plus the named-group map.
function normalize(m: unknown): Norm {
    if (m === null || m === undefined) return null;
    const rec = m as Record<string | number, { start: number; end: number; match: string; name?: string } | number>;
    const length = rec.length as number;
    const groups: Group[] = [];
    for (let i = 0; i < length; i++) {
        const g = rec[i] as { start: number; end: number; match: string; name?: string };
        groups.push({ start: g.start, end: g.end, match: g.match, name: g.name });
    }
    const named: Record<string, string> = {};
    for (const k of Object.keys(rec)) {
        if (k === 'length' || /^\d+$/.test(k)) continue;
        const g = rec[k] as { match: string };
        named[k] = g.match;
    }
    return { length, groups, named };
}

type G = [start: number, end: number, match: string];
const g = (start: number, end: number, match: string, name?: string): Group => ({ start, end, match, name });
const m = (groups: G[], named: Record<string, string> = {}): Norm =>
    ({ length: groups.length, groups: groups.map(([s, e, t]) => g(s, e, t, Object.keys(named).find(k => named[k] === t && t !== ''))), named });

const CASES: Array<{ pattern: string; line: string; expected: Norm }> = [
    { pattern: '(\\d+) gold', line: 'you find 42 gold coins', expected: m([[9, 16, '42 gold'], [9, 11, '42']]) },
    { pattern: '^You see (.+) here\\.$', line: 'You see a rusty sword here.',
        expected: m([[0, 27, 'You see a rusty sword here.'], [8, 21, 'a rusty sword']]) },
    { pattern: '(?<hp>\\d+)/(?<max>\\d+)', line: 'HP: 30/100 remaining',
        expected: m([[4, 10, '30/100'], [4, 6, '30'], [7, 10, '100']], { hp: '30', max: '100' }) },
    // unmatched optional group
    { pattern: 'foo(bar)?baz', line: 'foobaz', expected: m([[0, 6, 'foobaz'], [-1, -1, '']]) },
    { pattern: 'foo(bar)?baz', line: 'foobarbaz', expected: m([[0, 9, 'foobarbaz'], [3, 6, 'bar']]) },
    { pattern: '^(\\w+) tells you: (.+)$', line: 'Gandalf tells you: run',
        expected: m([[0, 22, 'Gandalf tells you: run'], [0, 7, 'Gandalf'], [19, 22, 'run']]) },
    { pattern: '\\b(\\w+)@(\\w+)\\.(\\w{2,4})\\b', line: 'mail me at bob@example.com today',
        expected: m([[11, 26, 'bob@example.com'], [11, 14, 'bob'], [15, 22, 'example'], [23, 26, 'com']]) },
    { pattern: 'nothing-here', line: 'this line will not match at all', expected: null },
    // empty-line anchor
    { pattern: '^$', line: '', expected: m([[0, 0, '']]) },
    { pattern: '(a|b)(c|d)', line: 'zzz bd zzz', expected: m([[4, 6, 'bd'], [4, 5, 'b'], [5, 6, 'd']]) },
];

describe('the PCRE2 wrapper\'s match shape', () => {
    it('matches the corpus as the upstream wrapper did', async () => {
        await VendoredPCRE.init();
        for (const { pattern, line, expected } of CASES) {
            const v = new VendoredPCRE(pattern);
            expect(normalize(v.match(line)), `pattern ${pattern} / line "${line}"`).toEqual(expected);
            v.destroy();
        }
    }, 60000);

    it('matches all as the upstream wrapper did', async () => {
        await VendoredPCRE.init();
        const v = new VendoredPCRE('(\\d+)');
        expect((v.matchAll('rooms 1 and 22 and 333 and 4') as unknown[]).map(normalize)).toEqual([
            m([[6, 7, '1'], [6, 7, '1']]),
            m([[12, 14, '22'], [12, 14, '22']]),
            m([[19, 22, '333'], [19, 22, '333']]),
            m([[27, 28, '4'], [27, 28, '4']]),
        ]);
        v.destroy();
    }, 60000);

    it('reuses the shared line buffer across patterns without corruption', async () => {
        await VendoredPCRE.init();
        // Same line reference handed to many patterns (the per-line scan shape):
        // the second pattern must not see a buffer truncated/grown by the first.
        const line = 'The dragon hits you for 250 damage and you have 30/100 hp';
        const a = new VendoredPCRE('(\\d+) damage');
        const b = new VendoredPCRE('(\\d+)/(\\d+) hp');
        const ra = normalize(a.match(line));
        const rb = normalize(b.match(line));
        expect(ra?.groups[1].match).toBe('250');
        expect(rb?.groups[1].match).toBe('30');
        expect(rb?.groups[2].match).toBe('100');
        // Re-match the first pattern after a longer line forced a buffer grow.
        const longLine = line + ' '.repeat(500) + 'extra 999 damage';
        expect(normalize(a.match(longLine))?.groups[1].match).toBe('250');
        a.destroy();
        b.destroy();
    }, 60000);
});
