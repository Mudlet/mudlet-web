// Issue #70 item 4: the editor's search had Match case and Use regular
// expression but no whole-word option, so `gold` could not be told apart from
// `goldsmith`. Desktop offers Case sensitive / Include variables / Whole word
// (dlgTriggerEditor.cpp:13266-13290), implementing whole-word as the escaped
// needle wrapped in \b…\b (`findSearchMatch`, :13128-13148).
import { describe, it, expect } from 'vitest';
import { buildMatcher } from '../../src/ui/search/matcher';

const hits = (pattern: string, text: string, opts: { matchCase?: boolean; regex?: boolean; whole?: boolean } = {}) =>
    buildMatcher(pattern, opts.matchCase ?? false, opts.regex ?? false, opts.whole ?? false).ranges(text);

describe('search whole-word option', () => {
    it('is off by default, so a substring still matches', () => {
        expect(hits('gold', 'goldsmith sells gold')).toEqual([[0, 4], [16, 20]]);
    });

    it('drops the hit inside a longer word', () => {
        expect(hits('gold', 'goldsmith sells gold', { whole: true })).toEqual([[16, 20]]);
    });

    it('still honours match case', () => {
        expect(hits('Gold', 'gold Gold', { whole: true })).toEqual([[0, 4], [5, 9]]);
        expect(hits('Gold', 'gold Gold', { whole: true, matchCase: true })).toEqual([[5, 9]]);
    });

    it('treats a literal query as literal, not as a pattern', () => {
        // Without escaping, `a.c` would match `abc` too.
        expect(hits('a.c', 'a.c abc', { whole: true })).toEqual([[0, 3]]);
    });

    it('brackets a regex query so an alternation matches either word whole', () => {
        const ranges = hits('gold|silver', 'goldsmith gold silversmith silver', { whole: true, regex: true });
        expect(ranges).toEqual([[10, 14], [27, 33]]);
    });

    it('reports an unparseable regex as invalid rather than as no results', () => {
        expect(buildMatcher('gold(', false, true, true).valid).toBe(false);
    });

    it('leaves a word boundary that cannot exist with no hits', () => {
        // `_` counts as a word character, so `gold` is not a whole word here.
        expect(hits('gold', 'my_gold_pile', { whole: true })).toEqual([]);
    });
});
