/**
 * Lua patterns compiled to JavaScript regular expressions, for the `utf8`
 * module's find/match/gmatch/gsub.
 *
 * Mudlet links the C `luautf8` (starwing) for `utf8`; the browser has no such
 * library, so mudix bundles Stepets' pure-Lua `utf8.lua`. That shim is correct
 * enough for the sub/len/char half of the module but not for the pattern half,
 * in two ways that both matter:
 *
 *   * **Its character classes are ASCII.** `classMatchGenerator` writes `%a` as
 *     the two ranges A-Z and a-z, so `caf%a` does not match `café` — while
 *     luautf8 decides every class from Unicode tables. A pattern class is
 *     supposed to be the one part of `utf8.*` that is not byte-wise.
 *   * **It is slow enough to be a hazard.** One `find` over a 35-character line
 *     costs ~35,000 Lua VM instructions — it walks the subject a character at a
 *     time through a generated closure chain. `replaceAll` calls it once per
 *     replacement, on trigger output.
 *
 * So the pattern is translated to a JS `RegExp` and matched natively, with the
 * Lua implementation kept as the fallback for the constructs that have no
 * regex equivalent (`%b`, `%f`, position captures, back-references — see
 * `compileLuaPattern` returning null). Nothing gets worse for those; everything
 * else gets Unicode classes and native speed.
 *
 * Positions cross the boundary as Lua sees them: 1-based, inclusive, and
 * counted in CODE POINTS. JS regex indices are UTF-16 code units, so a subject
 * holding anything outside the BMP needs the map `codePointOffsets` builds.
 */

/**
 * Lua's character classes as JS regex atoms. `atom` is the class on its own;
 * `inSet` is how it is written inside a `[...]`, or null for the ones that can
 * only be expressed as a negated set and so cannot appear inside another.
 *
 * The Unicode categories mirror what luautf8 decides from its own tables:
 * `%a` is any letter rather than ASCII A-Za-z, `%w` adds numbers and combining
 * marks (its `alnum_extend` table), and the uppercase forms are the
 * complements. `%x` stays ASCII, as hex digits are.
 */
const CLASSES: Record<string, { atom: string; inSet: string | null }> = {
    a: { atom: '\\p{L}', inSet: '\\p{L}' },
    A: { atom: '\\P{L}', inSet: '\\P{L}' },
    c: { atom: '\\p{Cc}', inSet: '\\p{Cc}' },
    C: { atom: '\\P{Cc}', inSet: '\\P{Cc}' },
    d: { atom: '\\p{Nd}', inSet: '\\p{Nd}' },
    D: { atom: '\\P{Nd}', inSet: '\\P{Nd}' },
    g: { atom: '[^\\p{Z}\\p{C}\\s]', inSet: null },
    G: { atom: '[\\p{Z}\\p{C}\\s]', inSet: '\\p{Z}\\p{C}\\s' },
    l: { atom: '\\p{Ll}', inSet: '\\p{Ll}' },
    L: { atom: '\\P{Ll}', inSet: '\\P{Ll}' },
    p: { atom: '\\p{P}', inSet: '\\p{P}' },
    P: { atom: '\\P{P}', inSet: '\\P{P}' },
    s: { atom: '\\s', inSet: '\\s' },
    S: { atom: '\\S', inSet: '\\S' },
    u: { atom: '\\p{Lu}', inSet: '\\p{Lu}' },
    U: { atom: '\\P{Lu}', inSet: '\\P{Lu}' },
    w: { atom: '[\\p{L}\\p{N}\\p{M}]', inSet: '\\p{L}\\p{N}\\p{M}' },
    W: { atom: '[^\\p{L}\\p{N}\\p{M}]', inSet: null },
    x: { atom: '[0-9A-Fa-f]', inSet: '0-9A-Fa-f' },
    X: { atom: '[^0-9A-Fa-f]', inSet: null },
    z: { atom: '\\u0000', inSet: '\\u0000' },
    Z: { atom: '[^\\u0000]', inSet: null },
};

// Unicode-mode regexes reject a backslash before anything that does not need
// one, so the escape has to be exact rather than generous: only these, plus `-`
// inside a set, may carry one.
const SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);
const escapeLiteral = (ch: string): string => (SYNTAX.has(ch) ? `\\${ch}` : ch);
const escapeInSet = (ch: string): string => (SYNTAX.has(ch) || ch === '-' ? `\\${ch}` : ch);

type SetToken =
    | { kind: 'char'; src: string; ch: string }
    | { kind: 'class'; src: string }
    | { kind: 'dash' };

/**
 * Translate a `[...]` set starting at `p[i]`. Returns the JS atom and the index
 * just past the closing bracket, or null for a set holding a class that only
 * exists as a negation (`[%W]`) — a union with one of those cannot be written
 * as a single JS set.
 */
function parseSet(p: string[], i: number): { atom: string; next: number } | null {
    let j = i + 1;
    const negated = p[j] === '^';
    if (negated) j++;

    const tokens: SetToken[] = [];
    let first = true;
    let closed = false;
    while (j < p.length) {
        const c = p[j];
        // A `]` straight after the opening bracket is a member, not the end —
        // which is the only way to put one in a set.
        if (c === ']' && !first) { closed = true; j++; break; }
        first = false;
        if (c === '%') {
            const n = p[j + 1];
            if (n === undefined) return null;
            const cls = CLASSES[n];
            if (cls) {
                if (cls.inSet === null) return null;
                tokens.push({ kind: 'class', src: cls.inSet });
            } else {
                tokens.push({ kind: 'char', src: escapeInSet(n), ch: n });
            }
            j += 2;
        } else if (c === '-') {
            tokens.push({ kind: 'dash' });
            j++;
        } else {
            tokens.push({ kind: 'char', src: escapeInSet(c), ch: c });
            j++;
        }
    }
    if (!closed || tokens.length === 0) return null;

    // A `-` is a range only between two plain characters; anywhere else (either
    // end of the set, or beside a class) Lua reads it as the character itself.
    let body = '';
    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.kind === 'dash') {
            const prev = tokens[k - 1];
            const next = tokens[k + 1];
            if (prev?.kind === 'char' && next?.kind === 'char' && prev.ch <= next.ch) {
                body = body.slice(0, body.length - prev.src.length);
                body += `${prev.src}-${next.src}`;
                k++;
            } else {
                body += '\\-';
            }
        } else {
            body += t.src;
        }
    }
    return { atom: `[${negated ? '^' : ''}${body}]`, next: j };
}

export type CompiledLuaPattern = {
    re: RegExp;
    /** `^` at the start of a Lua pattern anchors at `init`, not at the start of
     *  the subject — which is a sticky regex, not a `^`. */
    anchored: boolean;
    captures: number;
};

// Patterns repeat: replaceAll re-finds with the same one until it stops
// matching, gsub once per replacement. Bounded because a script can build
// patterns from game text.
const CACHE_LIMIT = 512;
const cache = new Map<string, CompiledLuaPattern | null>();

/** Compile a Lua pattern, or null when it uses something a regex cannot express
 *  (`%b`, `%f`, a position capture, a back-reference) and the caller should fall
 *  back to the Lua implementation. */
export function compileLuaPattern(pattern: string): CompiledLuaPattern | null {
    const hit = cache.get(pattern);
    if (hit !== undefined) return hit;
    const built = buildLuaPattern(pattern);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(pattern, built);
    return built;
}

function buildLuaPattern(pattern: string): CompiledLuaPattern | null {
    // By code point: a literal outside the BMP must stay one atom, or its
    // quantifier would bind to the trailing surrogate alone.
    const p = Array.from(pattern);
    let i = 0;
    let source = '';
    let captures = 0;
    let open = 0;

    const anchored = p[0] === '^';
    if (anchored) i = 1;

    while (i < p.length) {
        const c = p[i];
        if (c === '(') {
            // `()` is a position capture: it yields the offset as a number,
            // which no JS capture group can report.
            if (p[i + 1] === ')') return null;
            source += '(';
            captures++;
            open++;
            i++;
            continue;
        }
        if (c === ')') {
            if (open === 0) return null;
            source += ')';
            open--;
            i++;
            continue;
        }
        // `$` is an anchor only as the last character, `^` only as the first
        // (handled above) — anywhere else both are ordinary characters.
        if (c === '$' && i === p.length - 1) {
            source += '$';
            i++;
            continue;
        }

        let atom: string;
        if (c === '%') {
            const n = p[i + 1];
            if (n === undefined) return null;
            // %b (balanced) and %f (frontier) have no regex equivalent, and a
            // back-reference is left alone rather than guessed at.
            if (n === 'b' || n === 'f' || (n >= '0' && n <= '9')) return null;
            atom = CLASSES[n]?.atom ?? escapeLiteral(n);
            i += 2;
        } else if (c === '[') {
            const set = parseSet(p, i);
            if (!set) return null;
            atom = set.atom;
            i = set.next;
        } else if (c === '.') {
            // Lua's `.` includes newline; JS's does not without the `s` flag,
            // which would also change nothing else here.
            atom = '[\\s\\S]';
            i++;
        } else {
            atom = escapeLiteral(c);
            i++;
        }

        // Lua quantifies a single class only, so it always binds to `atom`.
        // `-` is the lazy one.
        const q = p[i];
        if (q === '*' || q === '+' || q === '?') { source += atom + q; i++; }
        else if (q === '-') { source += `${atom}*?`; i++; }
        else source += atom;
    }
    if (open !== 0) return null;

    try {
        return { re: new RegExp(source, anchored ? 'yu' : 'gu'), anchored, captures };
    } catch {
        return null;
    }
}

/**
 * Byte offset of each code point, for a subject that has any outside the BMP.
 * Null when the subject has none, which is the common case and means code-point
 * and code-unit indices are the same number.
 */
function codePointOffsets(s: string): number[] | null {
    if (!/[\uD800-\uDBFF]/.test(s)) return null;
    const offsets: number[] = [];
    for (let u = 0; u < s.length;) {
        offsets.push(u);
        u += (s.codePointAt(u) as number) > 0xffff ? 2 : 1;
    }
    offsets.push(s.length);
    return offsets;
}

const toUnit = (offsets: number[] | null, cp: number): number =>
    (offsets ? (offsets[cp] ?? offsets[offsets.length - 1]) : cp);

const toCodePoint = (offsets: number[] | null, unit: number): number => {
    if (!offsets) return unit;
    // Offsets ascend, so the position is a binary search away.
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < unit) lo = mid + 1; else hi = mid;
    }
    return lo;
};

export type LuaFindResult =
    /** The pattern needs a construct a regex cannot express — use the Lua one. */
    | { kind: 'unsupported' }
    | { kind: 'nomatch' }
    /** `start`/`end` are Lua positions: 1-based, inclusive, in code points. An
     *  empty match reports `end === start - 1`, as `string.find` does. */
    | { kind: 'match'; start: number; end: number; captures: string[] };

/**
 * `string.find` over UTF-8, natively. `init` follows Lua: 1-based, negative
 * counts from the end, and past the end of the subject there is no match.
 */
export function findLuaPattern(
    subject: string,
    pattern: string,
    init: number,
    plain: boolean,
): LuaFindResult {
    const offsets = codePointOffsets(subject);
    const length = offsets ? offsets.length - 1 : subject.length;

    let from = Math.trunc(Number.isFinite(init) ? init : 1);
    if (from < 0) from = Math.max(length + from + 1, 1);
    else if (from === 0) from = 1;
    if (from > length + 1) return { kind: 'nomatch' };
    const startUnit = toUnit(offsets, from - 1);

    if (plain) {
        const at = subject.indexOf(pattern, startUnit);
        if (at === -1) return { kind: 'nomatch' };
        const patternOffsets = codePointOffsets(pattern);
        const patternLength = patternOffsets ? patternOffsets.length - 1 : pattern.length;
        const start = toCodePoint(offsets, at) + 1;
        return { kind: 'match', start, end: start + patternLength - 1, captures: [] };
    }

    const compiled = compileLuaPattern(pattern);
    if (!compiled) return { kind: 'unsupported' };

    compiled.re.lastIndex = startUnit;
    const m = compiled.re.exec(subject);
    if (!m) return { kind: 'nomatch' };

    const start = toCodePoint(offsets, m.index) + 1;
    const end = toCodePoint(offsets, m.index + m[0].length);
    // A group that did not participate cannot happen: Lua has no optional
    // capture, so every `(` in a matched pattern captured something.
    return { kind: 'match', start, end, captures: m.slice(1).map(c => c ?? '') };
}
