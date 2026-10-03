// @vitest-environment node
//
// Text/time utilities that answered differently from desktop Mudlet
// (mudlet-web#294): getTime's z/zz/tttt tokens, os.clock as wall time,
// selectString skipping overlapping occurrences, copy() keeping a stale
// clipboard, the user dictionary's sort and case handling, and the "0x"
// coercion divergence (tonumber("0x") itself is #308). getTimestamp's trailing
// space is pinned in added-apis.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configure, InMemory, mkdirSync } from '@zenfs/core';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { timeZoneLongName } from '../../src/utils/timeZone';

describe('getTime(true, fmt) — Qt 6 z/zz and tttt', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => {
        vi.useRealTimers();
        env.dispose();
    });

    const at = (ms: number) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 26, 18, 57, 11, ms));
    };
    const fmt = (f: string) => env.run(`return getTime(true, ${JSON.stringify(f)})`);

    it('drops trailing zeros from z and zz, never leading ones', () => {
        at(820);
        expect(fmt('zzz|zz|z|ss.z')).toBe('820|82|82|11.82');
        at(1);
        expect(fmt('zzz|zz|z|ss.z')).toBe('001|001|001|11.001');
        at(18);
        expect(fmt('zzz=z|zz|zzz')).toBe('018=018|018|018');
        at(699);
        expect(fmt('zzz=z|zz|zzz')).toBe('699=699|699|699');
        at(100);
        expect(fmt('z|zz')).toBe('1|1');
        at(0);
        expect(fmt('ss.z')).toBe('11.0');
    });

    it('reads zzzz as zzz followed by z', () => {
        at(820);
        expect(fmt('zzzz')).toBe('82082');
    });

    it('formats tttt as the zone long name, not its IANA id', () => {
        at(0);
        const when = new Date(2026, 8, 26, 18, 57, 11, 0);
        expect(fmt('tttt')).toBe(timeZoneLongName(when));
        // In a UTC process (as the issue's probe ran) this is the long name.
        if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC') {
            expect(fmt('tttt')).toBe('Coordinated Universal Time');
        }
        expect(fmt('tttt')).not.toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});

describe('os.clock() — stands still while idle', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('does not advance across an idle wait', async () => {
        const before = env.run('return os.clock()') as number;
        await new Promise(r => setTimeout(r, 300));
        const after = env.run('return os.clock()') as number;
        expect(after - before).toBeLessThan(0.1);
    });

    it('measures busy time inside one call', () => {
        const spent = env.run(`
            local t0 = os.clock()
            while os.clock() - t0 < 0.15 do end
            return os.clock() - t0
        `) as number;
        expect(spent).toBeGreaterThanOrEqual(0.15);
        expect(spent).toBeLessThan(1);
    });

    it('banks busy time across calls, so it never goes backwards', async () => {
        const a = env.run(`
            local t0 = os.clock()
            while os.clock() - t0 < 0.05 do end
            return os.clock()
        `) as number;
        await new Promise(r => setTimeout(r, 50));
        const b = env.run('return os.clock()') as number;
        expect(b).toBeGreaterThanOrEqual(a);
        expect(b - a).toBeLessThan(0.04);
    });
});

describe('selectString — overlapping occurrences', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.run('createBuffer("ovl"); echo("ovl", "OVL aaaa banana\\n"); moveCursor("ovl", 0, 0)');
    });
    afterEach(() => env.dispose());

    const starts = (text: string, n: number) => {
        const out: unknown[] = [];
        for (let i = 1; i <= n; i++) out.push(env.run(`return selectString("ovl", "${text}", ${i})`));
        return out.join(',');
    };

    it('resumes each search one past the last start, as desktop does', () => {
        expect(env.run('return getCurrentLine("ovl")')).toBe('OVL aaaa banana');
        expect(starts('aa', 5)).toBe('4,5,6,-1,-1');
        expect(starts('ana', 4)).toBe('10,12,-1,-1');
        expect(starts('an', 3)).toBe('10,12,-1');
    });

    it('selects the occurrence it reports', () => {
        env.run('selectString("ovl", "aa", 2)');
        expect(env.run('local _, s, e = getSelection("ovl") return s')).toBe(5);
    });

    it('refuses an occurrence below 1', () => {
        expect(env.run('return selectString("ovl", "aa", 0)')).toBe(-1);
    });
});

describe('copy() — always replaces the clipboard', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.run('createBuffer("src"); echo("src", "copy me\\n"); moveCursor("src", 0, 0); createBuffer("dst")');
    });
    afterEach(() => env.dispose());

    const dst = () => env.run('return table.concat(getLines("dst", 0, getLineCount("dst")), "|")');

    it('copies an empty selection after a failed selectString or a deselect', () => {
        env.run(`
            selectString("src", "copy", 1); copy("src"); appendBuffer("dst")
            selectString("src", "nomatch", 1); copy("src"); appendBuffer("dst")
            selectString("src", "copy", 1); deselect("src"); copy("src"); appendBuffer("dst")
        `);
        // Desktop: "copy" | "" | "". Keeping the old clipboard gave copy|copy|copy.
        expect(dst()).toBe('copy||');
    });

    it('copies nothing from a window that does not own the selection', () => {
        env.run('selectString("src", "copy", 1); copy("src"); copy("dst"); appendBuffer("dst")');
        expect(dst()).not.toContain('copy');
    });

    it('leaves the clipboard alone for a window that does not exist', () => {
        env.run('selectString("src", "copy", 1); copy("src"); copy("nope"); appendBuffer("dst")');
        expect(dst()).toContain('copy');
    });
});

describe('user dictionary — order and hunspell case rules', () => {
    const PROFILE = '/profiles/dict-parity';
    let env: TestRuntime;
    beforeEach(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        // The constructor is private: mount() insists on IndexedDB or a linked
        // folder, neither of which exists under node.
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        env = await createTestRuntime({ vfs: new Ctor('dict-parity', {}, 'idb') });
        env.run('addWordToDictionary("Zorkmid"); addWordToDictionary("apple"); addWordToDictionary("Banana")');
    });
    afterEach(() => env.dispose());

    it('lists words sorted case-insensitively', () => {
        expect(env.run('return table.concat(getDictionaryWordList(), ",")')).toBe('apple,Banana,Zorkmid');
    });

    it('accepts all-caps and capitalised forms the way hunspell does', () => {
        const words = ['Zorkmid', 'ZORKMID', 'zorkmid', 'APPLE', 'Apple', 'aPPle', 'banana'];
        const got = words.map(w => env.run(`return spellCheckWord("${w}", true)`));
        expect(got).toEqual([true, true, false, true, true, false, false]);
    });

    it('suggests the capitalisation fix', () => {
        expect(env.run('return table.concat(spellSuggestWord("zorkmid", true), ",")')).toBe('Zorkmid');
    });

    it('suggests a word the dictionary accepts as itself, in the case asked (mudlet-web#331)', () => {
        env.run('addWordToDictionary("xylo"); addWordToDictionary("McGuffin")');
        const words = ['Zorkmid', 'apple', 'Banana', 'BANANA', 'Apple', 'APPLE', 'xylo', 'McGuffin'];
        const got = words.map(w => env.run(`return table.concat(spellSuggestWord("${w}", true), ",")`));
        expect(got).toEqual(words);
    });
});

describe('"0x" string coercion', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('still coerces "0x" to 0 in arithmetic (recorded divergence)', () => {
        // See PLATFORM_DIVERGENCES in e2e/knownDivergences.ts: this is the C-level
        // parse, which no tonumber wrapper can reach. Desktop raises here.
        expect(env.run('return "0x" + 1')).toBe(1);
    });
});
