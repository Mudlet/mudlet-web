// @vitest-environment node
//
// #435: a long line froze the page with generic_mapper installed, and a
// catastrophically backtracking trigger froze it on every short line.
//
// The first is a pattern opening with `.+` — `.+ (?:is not going to|will not)
// let you pass.$` — tried at every offset of a 20 kB line, each try running the
// `.+` to the end and back: quadratic, and over fifteen seconds in the wasm
// interpreter. Pcre2 matches such a pattern ANCHORED at the start of each
// newline-free stretch instead, which finds the same match (the argument is at
// leadingDotPlus in Pcre2.ts); these tests hold it to "the same", captures and
// all, against the unanchored search.
//
// The second is PCRE2's default match limit of ten million steps, which the
// interpreter takes seconds to reach. Trigger and alias patterns now carry a
// lower one (ENGINE_MATCH_LIMIT).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import libpcre2 from 'pcre2-wasm-universal/libpcre2';
import Pcre2, { ENGINE_MATCH_LIMIT, ENGINE_MATCH_LIMIT_VERB, leadingDotPlus } from '../../src/mud/triggers/pcre/Pcre2';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';
import { AliasPattern } from '../../src/mud/PatternEngine';

const VERBS = '(*UTF)(*UCP)';
const ANCHORED = 0x80000000;

/** A ~21 kB line of words, as a trigger sees it (the engine appends `\n`). */
const LONG_LINE = 'lorem ipsum dolor sit amet '.repeat(800) + '\n';

/** generic_mapper's two patterns from the issue. */
const MAPPER_PATTERNS = [
    '.+ (?:is not going to|will not) let you pass.$',
    '.+( \\- [A-Z].+?\\s*?) \\- (.+)',
];

beforeAll(async () => {
    await TriggerEngine.ready();
    await Pcre2.init();
});
afterEach(() => vi.restoreAllMocks());

function compile(pattern: string): Pcre2 {
    return new Pcre2(VERBS + pattern);
}

/** The same pattern, wrapped in a group so it is searched the ordinary way. */
function compileUnanchored(pattern: string): Pcre2 {
    const re = new Pcre2(`${VERBS}(?:${pattern})`);
    expect(leadingDotPlus(`${VERBS}(?:${pattern})`)).toBe(false);
    return re;
}

/** Every `_match` call's options while `run` runs. */
function optionsPassed(run: () => void): number[] {
    const spy = vi.spyOn(libpcre2 as unknown as { _match: (...a: number[]) => number }, '_match');
    try {
        run();
        return spy.mock.calls.map(args => (args[5] ?? 0) >>> 0);
    } finally {
        spy.mockRestore();
    }
}

const plain = (m: ReturnType<Pcre2['matchFrom']>) =>
    m && Array.from({ length: m.length }, (_, i) => [m[i].start, m[i].end, m[i].match]);

describe('which patterns open with an anchorable .+', () => {
    it.each([
        '.+ (?:is not going to|will not) let you pass.$',
        '.+( \\- [A-Z].+?\\s*?) \\- (.+)',
        '.+?foo',
        '.++foo',
        '.+',
        `${VERBS}.+ says`,
        `${ENGINE_MATCH_LIMIT_VERB}${VERBS}.+ says`,
        '(?i).+ SAYS',
        '(?m)(?U).+ says$',
        '.+(?:a|b)',
        '.+[|(]x',
        '.+[]|]x',
        '.+\\|x',
        '.+\\Q|(\\E',
        '.+(?#a | comment)x',
        '.+(?<=x)y',
        '.+\\Gy',
    ])('anchors %s', pattern => {
        expect(leadingDotPlus(pattern)).toBe(true);
    });

    it.each([
        '.*foo', // PCRE2 anchors this one itself
        '(.+)foo',
        '(?:.+)foo',
        '^.+foo',
        'x.+',
        '.+foo|bar',
        '.+(?:a)|b',
        '.+[x]|b',
        '(?s).+foo',
        '(?x).+ foo',
        '(?i-s).+foo',
        '(*CRLF).+foo',
        '(*ANY).+foo',
        '.+(*COMMIT)foo',
        '.+(*SKIP)foo',
        '.+(?C1)foo',
        '.+foo(?x) # | ',
        '.+{2}',
        '.',
    ])('leaves %s alone', pattern => {
        expect(leadingDotPlus(pattern)).toBe(false);
    });
});

describe('a leading .+ is matched anchored', () => {
    it('fails a 20 kB line fast', () => {
        for (const pattern of MAPPER_PATTERNS) {
            const re = compile(pattern);
            try {
                const started = performance.now();
                expect(re.matchFrom(LONG_LINE, 0)).toBeNull();
                // Over fifteen seconds before; about a millisecond now. The
                // bound only has to tell the two apart on a loaded CI box.
                expect(performance.now() - started).toBeLessThan(1500);
            } finally {
                re.destroy();
            }
        }
    });

    it('takes one anchored call for a trigger line', () => {
        const re = compile(MAPPER_PATTERNS[0]);
        try {
            const options = optionsPassed(() => { re.matchFrom(LONG_LINE, 0); });
            expect(options).toEqual([ANCHORED]);
        } finally {
            re.destroy();
        }
    });

    it('fails a 20 kB line fast in the trigger engine', () => {
        const te = new TriggerEngine();
        te.loadPerm(MAPPER_PATTERNS.map((text, i) => ({
            id: `m${i}`, name: `m${i}`, enabled: true, isGroup: false, parentId: null,
            code: 'x', language: 'lua', fireLength: 0, multipleMatches: i === 1,
            multiline: false, delta: 0, isFilter: false,
            patterns: [{ type: 'regex', text }],
        } as TriggerNode)));
        let fired = 0;
        const started = performance.now();
        te.process(LONG_LINE.slice(0, -1), false, () => { fired++; });
        expect(performance.now() - started).toBeLessThan(1500);
        expect(fired).toBe(0);
        te.destroy();
    });

    // Lines and offsets the anchored path has to agree with the plain search
    // on: hits at the start, in the middle (where the `.+` absorbs the text
    // before), after a newline (the next stretch), and misses. The long ones
    // are kept short enough for the plain search to finish.
    const MEDIUM = 'lorem ipsum dolor sit amet '.repeat(12);
    const SUBJECTS = [
        'The guard will not let you pass.\n',
        'The guard will not let you pass.',
        'xx\nThe guard is not going to let you pass.\n',
        'The guard will not let you pass. no\nhe will not let you pass.\n',
        'Room Name - Exits - North, South\n',
        'a - Bb - c - Dd - e\n',
        'line one\nRoom - Area - zone\nline three\n',
        '\n\nRoom - Area - zone',
        'nothing here\n',
        '',
        '\n',
        'ab\n\ncd foo ef foo\n',
        'foo foo foo',
        'x\u{1F600}y foo\u{1F600} says "hi"\n',
        MEDIUM + '\n',
        MEDIUM + '\nThe guard will not let you pass.',
        MEDIUM + ' - Xyz - tail\n',
    ];
    const PATTERNS = [
        ...MAPPER_PATTERNS,
        '.+?foo',
        '.++foo',
        '.+ foo',
        '.+(foo)(?: (\\w+))?',
        '.+?(foo)(.*)',
        '.+(?<n>\\w+) says "(.+)"$',
        '(?m).+$',
        '(?m).+?$',
        '.+(?<=a)',
        '.+\\G',
        '.+(?:\\n|$)',
        '.+\\b(\\w)\\1?',
        '.+',
    ];

    it.each(PATTERNS)('finds what the plain search finds: %s', pattern => {
        const anchored = compile(pattern);
        const unanchored = compileUnanchored(pattern);
        expect(leadingDotPlus(VERBS + pattern)).toBe(true);
        try {
            for (const subject of SUBJECTS) {
                const offsets = new Set([0, 1, 3, subject.indexOf('\n') + 1, subject.length]);
                for (const at of offsets) {
                    if (at > subject.length) continue;
                    for (const options of [0, 0x1 /* NOTBOL */, 0x2 /* NOTEOL */, 0x20000000 /* ENDANCHORED */]) {
                        let want: unknown;
                        let got: unknown;
                        try { want = plain(unanchored.matchFrom(subject, at, options)); } catch (e) { want = String(e); }
                        try { got = plain(anchored.matchFrom(subject, at, options)); } catch (e) { got = String(e); }
                        expect(got, `${JSON.stringify(subject.slice(0, 60))} @${at} options ${options}`).toEqual(want);
                    }
                }
                expect(anchored.matchAll(subject, true).map(plain)).toEqual(unanchored.matchAll(subject, true).map(plain));
                if (subject) expect(plain(anchored.match(subject))).toEqual(plain(unanchored.match(subject)));
            }
        } finally {
            anchored.destroy();
            unanchored.destroy();
        }
    }, 120000);

    it('keeps named groups', () => {
        const re = compile('.+?(?<who>\\w+) says "(?<what>.+)"');
        try {
            const m = re.matchFrom('Then Bob says "hi"\n', 0)!;
            expect(m.who).toMatchObject({ match: 'Bob', group: 1 });
            expect(m.what).toMatchObject({ match: 'hi', group: 2 });
            expect(m[0]).toMatchObject({ start: 0, match: 'Then Bob says "hi"' });
        } finally {
            re.destroy();
        }
    });

    it('runs the plain search for a partial match', () => {
        const re = compile('.+foo');
        try {
            const options = optionsPassed(() => {
                try { re.matchFrom('xx fo', 0, 0x10 /* PARTIAL_SOFT */); } catch { /* the code is not the point */ }
            });
            expect(options).toEqual([0x10]);
        } finally {
            re.destroy();
        }
    });
});

describe('the trigger and alias match limit', () => {
    // `(\w+\s?)+` on twenty letters and a `!` takes PCRE2 about 2.6 million
    // steps to fail: inside the library default, past the engines' limit.
    const NESTED = '^(\\w+\\s?)+$';
    const FAILING = 'a'.repeat(20) + '!';

    it('is the library default without the verb', () => {
        const re = compile(NESTED);
        try {
            expect(re.matchFrom(FAILING, 0)).toBeNull();
        } finally {
            re.destroy();
        }
    });

    it('stops an alias pattern at ENGINE_MATCH_LIMIT', () => {
        const alias = new AliasPattern(NESTED);
        try {
            expect(() => alias.compiled()!.matchFrom(FAILING, 0)).toThrow('PCRE2 match error -47');
        } finally {
            alias.destroy();
        }
    });

    it('gives a pattern\'s own (*LIMIT_MATCH) the last word', () => {
        const alias = new AliasPattern(`(*LIMIT_MATCH=10000000)${NESTED}`);
        try {
            expect(alias.compiled()!.matchFrom(FAILING, 0)).toBeNull();
        } finally {
            alias.destroy();
        }
    });

    it('still matches what an ordinary pattern needs on a 20 kB line', () => {
        expect(ENGINE_MATCH_LIMIT).toBeGreaterThanOrEqual(100_000);
        for (const [pattern, subject] of [
            [NESTED, LONG_LINE.slice(0, -1)],
            ['^(.+) says, "(.+)"$', `${LONG_LINE.slice(0, -1)}Bob says, "hi"`],
            ['^(.*) (\\w+) (.*)$', LONG_LINE.slice(0, -1)],
        ]) {
            const alias = new AliasPattern(pattern);
            try {
                expect(alias.compiled()!.matchFrom(subject, 0), pattern).not.toBeNull();
            } finally {
                alias.destroy();
            }
        }
    });

    it('gives up on a backtracking trigger quickly, and the triggers after it fire', () => {
        const line = 'Short line with some words in it and a comma, here';
        const te = new TriggerEngine();
        te.loadPerm(['runaway', 'after'].map(id => ({
            id, name: id, enabled: true, isGroup: false, parentId: null,
            code: 'x', language: 'lua', fireLength: 0, multipleMatches: false,
            multiline: false, delta: 0, isFilter: false,
            patterns: [{ type: 'regex', text: id === 'runaway' ? NESTED : '^Short' }],
        } as TriggerNode)));
        const fired: string[] = [];
        let started = performance.now();
        te.process(line, false, m => { fired.push(m.trigger.id); });
        const limited = performance.now() - started;
        te.destroy();
        expect(fired).toEqual(['after']);

        // The same pattern at the library's limit, twenty times the steps.
        const re = compile(NESTED);
        started = performance.now();
        expect(() => re.matchFrom(line + '\n', 0)).toThrow('PCRE2 match error -47');
        const unlimited = performance.now() - started;
        re.destroy();
        expect(limited * 4).toBeLessThan(unlimited);
    }, 60000);
});
