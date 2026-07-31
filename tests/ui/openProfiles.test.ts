import { describe, it, expect } from 'vitest';
import { openProfileIds, sameIds } from '../../src/ui/useOpenProfiles';
import { profileLockName } from '../../src/utils/profileLock';

// The connection screen marks a profile "already open in another tab" from the
// held Web Locks (see profileLock.ts). These are the two pure pieces behind the
// hook: mapping the query result to profile ids, and deciding whether the set
// actually changed (a no-op update would re-run the grid's FLIP layout effect
// on every poll tick).

describe('openProfileIds', () => {
    it('maps held profile locks back to connection ids', () => {
        const held = [{ name: profileLockName('abc') }, { name: profileLockName('def') }];
        expect(openProfileIds(held)).toEqual(new Set(['abc', 'def']));
    });

    it('ignores locks that are not profile locks', () => {
        const held = [{ name: 'some-other-feature' }, { name: profileLockName('abc') }];
        expect(openProfileIds(held)).toEqual(new Set(['abc']));
    });

    it('ignores unnamed entries', () => {
        expect(openProfileIds([{}, { name: profileLockName('abc') }])).toEqual(new Set(['abc']));
    });

    it('returns an empty set for no locks or a missing list', () => {
        expect(openProfileIds([])).toEqual(new Set());
        expect(openProfileIds(undefined)).toEqual(new Set());
    });
});

describe('sameIds', () => {
    it('is true for the same members regardless of insertion order', () => {
        expect(sameIds(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    });

    it('is false when a profile opens or closes', () => {
        expect(sameIds(new Set(['a']), new Set(['a', 'b']))).toBe(false);
        expect(sameIds(new Set(['a', 'b']), new Set(['a']))).toBe(false);
    });

    it('is false for same-size but different members', () => {
        expect(sameIds(new Set(['a']), new Set(['b']))).toBe(false);
    });
});
