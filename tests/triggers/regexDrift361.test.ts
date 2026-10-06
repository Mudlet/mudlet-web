// @vitest-environment node
//
// Trigger and alias regex behaviour that drifted from desktop Mudlet's PTB
// (mudlet-web#361). Each expectation is what desktop produced for the same
// pattern and line; the PCRE2-version items of that issue are recorded in
// e2e/knownDivergences.ts instead.
import { beforeAll, describe, expect, it } from 'vitest';
import Pcre2 from '../../src/mud/triggers/pcre/Pcre2';
import { TriggerEngine, type TriggerMatch, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';
import { AliasEngine, type AliasNode, type PermAliasMatch } from '../../src/mud/aliases/AliasEngine';

beforeAll(async () => {
    await Pcre2.init();
});

function trigger(id: string, pattern: string, multipleMatches = false): TriggerNode {
    return {
        id, name: id, enabled: true, isGroup: false, parentId: null,
        code: '', language: 'lua', fireLength: 0, multipleMatches,
        multiline: false, delta: 0, isFilter: false,
        patterns: [{ type: 'regex', text: pattern }],
    } as TriggerNode;
}

function alias(id: string, pattern: string): AliasNode {
    return {
        id, name: id, pattern, code: '', language: 'lua',
        enabled: true, isGroup: false, parentId: null,
    } as AliasNode;
}

/** `matches` as the trigger's script sees it, by trigger id. */
function fire(triggers: TriggerNode[], line: string): Map<string, { list: TriggerMatch['captures']; named?: Record<string, string> }> {
    const te = new TriggerEngine();
    te.loadPerm(triggers);
    const out = new Map<string, { list: TriggerMatch['captures']; named?: Record<string, string> }>();
    te.process(line, false, m => {
        out.set(m.trigger.id, { list: [m.matchedText, ...m.captures], named: m.namedGroups });
    });
    te.destroy();
    return out;
}

function aliasHits(aliases: AliasNode[], input: string): PermAliasMatch[] {
    const engine = new AliasEngine();
    engine.loadPerm(aliases);
    const hits = engine.matchAllPerm(input);
    engine.destroy();
    return hits;
}

const BACKTRACKER = '^(a+)+$';
const LONG = 'a'.repeat(28) + 'b';

describe('a pattern that hits PCRE2\'s match limit is a pattern that did not match', () => {
    it('lets the triggers after it fire', () => {
        const fired = fire([
            trigger('before', '^a'),
            trigger('runaway', BACKTRACKER),
            trigger('after', '^aaaa'),
        ], LONG);
        expect([...fired.keys()]).toEqual(['before', 'after']);
    }, 60000);

    it('lets a match-all trigger after it fire, and is no match itself under match-all', () => {
        const fired = fire([
            trigger('runaway', BACKTRACKER, true),
            trigger('after', 'a{4}', true),
        ], LONG);
        expect([...fired.keys()]).toEqual(['after']);
        expect(fired.get('after')!.list).toHaveLength(7);
    }, 60000);

    it('lets the aliases after it fire', () => {
        const hits = aliasHits([alias('runaway', BACKTRACKER), alias('after', '^aaaa')], LONG);
        expect(hits.map(h => h.alias.id)).toEqual(['after']);
    }, 60000);

    it('fires a temp trigger after it', () => {
        const te = new TriggerEngine();
        const seen: string[] = [];
        te.addTemp(BACKTRACKER, () => seen.push('runaway'));
        te.addTemp('^aaaa', () => seen.push('after'));
        te.process(LONG, false, () => {});
        te.destroy();
        expect(seen).toEqual(['after']);
    }, 60000);
});

describe('match-all named groups come from the first match only', () => {
    const pattern = '(?:Q(?<x>\\d)|Z)';

    it('in a trigger', () => {
        const hit = fire([trigger('t', pattern, true)], 'MAN Z Q1 Q2').get('t')!;
        expect(hit.list).toEqual(['Z', 'Q1', '1', 'Q2', '2']);
        expect(hit.named).toBeUndefined();
    });

    it('in an alias', () => {
        const [hit] = aliasHits([alias('a', pattern)], 'Z Q1 Q2');
        expect([hit.matchedText, ...hit.captures]).toEqual(['Z', 'Q1', '1', 'Q2', '2']);
        expect(hit.named).toEqual({});
    });

    it('still reports the first match\'s own names', () => {
        const [hit] = aliasHits([alias('a', 'Q(?<x>\\d)')], 'Q1 Q2');
        expect(hit.named).toEqual({ x: '1' });
    });
});

describe('(?J) duplicate names keep the last group that took part', () => {
    const pattern = '(?J)^add (?<n>a)(?<n>b)';

    it('in an alias', () => {
        const [hit] = aliasHits([alias('a', pattern)], 'add ab');
        expect(hit.named).toEqual({ n: 'b' });
    });

    it('in a trigger', () => {
        expect(fire([trigger('t', pattern)], 'add ab').get('t')!.named).toEqual({ n: 'b' });
    });

    it('skips a same-named group that did not take part', () => {
        const [hit] = aliasHits([alias('a', '(?J)^add (?:(?<n>a)|(?<n>b))')], 'add a');
        expect(hit.named).toEqual({ n: 'a' });
    });
});

describe('empty matches in match-all retry at the same offset, as desktop does', () => {
    it('trigger (\\d*) reaches the final offset', () => {
        const hit = fire([trigger('t', '(\\d*)', true)], 'EMD 12 x').get('t')!;
        // nine whole-match/group pairs: four empties, "12", then empties at
        // 6, 7, the line's newline and its very end
        expect(hit.list).toEqual([
            '', '', '', '', '', '', '', '',
            '12', '12',
            '', '', '', '', '', '', '', '',
        ]);
    });

    it('trigger a?? finds the non-empty match after each empty one', () => {
        const hit = fire([trigger('t', 'a??', true)], 'EML aa').get('t')!;
        expect(hit.list).toEqual(['', '', '', '', '', 'a', '', 'a', '', '']);
    });

    it('alias (?<=alazy )a?? gives the empty match then "a"', () => {
        const [hit] = aliasHits([alias('a', '(?<=alazy )a??')], 'alazy aa');
        expect([hit.matchedText, ...hit.captures]).toEqual(['', 'a']);
    });

    it('steps a whole surrogate pair after a failed retry', () => {
        const re = new Pcre2('(*UTF)x*');
        try {
            expect(re.matchAll('a\u{1F600}b').map(m => m[0].start)).toEqual([0, 1, 3, 4]);
        } finally {
            re.destroy();
        }
    });
});

// Recorded in e2e/knownDivergences.ts (PLATFORM_DIVERGENCES, #361): the PCRE2
// build itself differs. Pinned so a newer library shows up here, and the
// divergence entry can go.
describe('PCRE2 10.34 in 16-bit mode (a recorded divergence)', () => {
    const yezidi = '\u{10E80}';

    it('does not know Unicode 13 letters', () => {
        const fired = fire([trigger('l', '^UL (\\p{L}+)'), trigger('w', '^UW (\\w+)')], `UL ${yezidi}`);
        expect(fired.size).toBe(0);
        expect(() => new Pcre2('(*UTF)(*UCP)^YZ (\\p{Yezidi}*)')).toThrow();
    });

    it('accepts \\K in a lookaround', () => {
        expect(fire([trigger('k', '^KL a(?=b\\K)')], 'KL ab').get('k')?.list).toEqual(['b']);
    });

    it('matches \\C as one UTF-16 code unit', () => {
        expect(fire([trigger('c', '^BC (\\C)')], 'BC é').get('c')?.list).toEqual(['BC é', 'é']);
    });
});
