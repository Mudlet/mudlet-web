// @vitest-environment node
// Aliases compile with PCRE2, as TAlias does — not as JS RegExp (issue #182).
import { beforeAll, describe, expect, it } from 'vitest';
import { AliasEngine, type AliasNode } from '../../src/mud/aliases/AliasEngine';
import Pcre2 from '../../src/mud/triggers/pcre/Pcre2';

beforeAll(async () => {
    await Pcre2.init();
});

/** Matches of every temp alias `pattern` fires for on `input`, or null if it did not fire. */
function tempMatches(pattern: string, input: string): string[] | null {
    const engine = new AliasEngine();
    let seen: string[] | null = null;
    engine.addTemp(pattern, m => { seen = Array.from(m); });
    const fired = engine.processTemp(input);
    engine.destroy();
    expect(fired).toBe(seen !== null);
    return seen;
}

function perm(pattern: string, extra: Partial<AliasNode> = {}): AliasNode {
    return {
        id: `a-${pattern}`, name: pattern, pattern, code: '', language: 'lua',
        enabled: true, isGroup: false, parentId: null, ...extra,
    } as AliasNode;
}

describe('alias patterns use PCRE syntax', () => {
    it.each([
        ['inline (?i)', '^(?i)hx (\\w+)$', 'HX foo', ['HX foo', 'foo']],
        ['\\p{L}', '^hp (\\p{L}+)$', 'hp wörld', ['hp wörld', 'wörld']],
        ['atomic group', '^ha (?>\\w+)$', 'ha foo', ['ha foo']],
        ['possessive quantifier', '^hq \\w++$', 'hq foo', ['hq foo']],
        ['\\A and \\Z', '\\Ahz\\Z', 'hz', ['hz']],
        ['extended mode (?x)', '(?x) ^hx2 \\s (\\d+) $', 'hx2 42', ['hx2 42', '42']],
    ])('%s fires', (_label, pattern, input, expected) => {
        expect(tempMatches(pattern, input)).toEqual(expected);
    });

    it('classifies \\w by Unicode property, as PCRE2_UCP does', () => {
        expect(tempMatches('^say (\\w+)$', 'say żółw')).toEqual(['say żółw', 'żółw']);
    });

    it('fires a permanent alias written in PCRE syntax', () => {
        const engine = new AliasEngine();
        engine.loadPerm([perm('^(?i)kill (\\p{L}+)$')]);
        const hits = engine.matchAllPerm('KILL örc');
        expect(hits.map(h => [h.matchedText, ...h.captures])).toEqual([['KILL örc', 'örc']]);
        engine.destroy();
    });

    it('keeps an uncompilable alias as one that never matches', () => {
        const engine = new AliasEngine();
        let fired = false;
        engine.addTemp('^(unclosed', () => { fired = true; });
        engine.loadPerm([perm('^(unclosed')]);
        expect(engine.processTemp('(unclosed')).toBe(false);
        expect(engine.matchAllPerm('(unclosed')).toEqual([]);
        expect(fired).toBe(false);
        expect(engine.tempCount).toBe(1);
        engine.destroy();
    });

    it('stops matching once a temp alias is removed', () => {
        const engine = new AliasEngine();
        let count = 0;
        const unsub = engine.addTemp('^go$', () => { count++; });
        expect(engine.processTemp('go')).toBe(true);
        unsub();
        expect(engine.processTemp('go')).toBe(false);
        expect(count).toBe(1);
    });
});

describe('alias captures', () => {
    it('drops a trailing optional group that took no part in the match', () => {
        expect(tempMatches('^hk (\\w+)(?: (\\d+))?$', 'hk orc')).toEqual(['hk orc', 'orc']);
        expect(tempMatches('^hk (\\w+)(?: (\\d+))?$', 'hk orc 2')).toEqual(['hk orc 2', 'orc', '2']);
    });

    it('keeps an unset group before a set one as an empty string', () => {
        expect(tempMatches('^(?:(a)|b)(c)$', 'bc')).toEqual(['bc', '', 'c']);
    });

    it('collects every match of an unanchored pattern, stepping past empty ones', () => {
        expect(tempMatches('(\\d*)', 'a1')).toEqual(['', '', '1', '1', '', '']);
        // A capture past a character outside the BMP is still reached.
        expect(tempMatches('(\\d*)', '😀9')).toEqual(['', '', '9', '9', '', '']);
    });

    it('exposes named groups', () => {
        const engine = new AliasEngine();
        let groups: Record<string, string> | undefined;
        engine.addTemp('^give (?<what>\\w+)(?: to (?<who>\\w+))?$', m => { groups = m.groups; });
        engine.processTemp('give sword');
        expect(groups).toEqual({ what: 'sword' });
        engine.destroy();
    });
});
