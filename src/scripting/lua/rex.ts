// Desktop's rex is lrexlib (rel-2-9) over the 8-bit PCRE2 library: a subject
// and a pattern are BYTES, matched one byte per character unless the pattern
// asks for UTF, and every offset is a byte offset. The wasm PCRE2 here is the
// 16-bit library and its `compile` always sets PCRE2_UTF, so byte mode is
// emulated: Lua hands both strings over armored (byteArmor.ts — the bridge
// would otherwise UTF-8-decode them, corrupting Latin-1 and binary text), and
// they are matched as "byte-strings", one UTF-16 code unit per byte. Code units
// up to 0xFF are always valid UTF-16, so the UTF flag the library forces costs
// nothing there: `.` is one byte, `\w` is ASCII (no UCP), "日本" is six
// characters. A pattern compiled with UTF (the flag, or a leading `(*UTF)`)
// decodes both strings from UTF-8 instead and maps every offset back to bytes.
//
// Only matching happens here. The loops — gsub, gmatch, split, count — are
// lrexlib's own (algo.h), kept in one place: `__rex_all__` walks the subject
// the way all four do, and the Lua side builds each one's results from the
// offsets, cutting substrings out of the original Lua string so no captured
// text ever crosses the bridge.
import PCRE from '../../mud/triggers/pcre/Pcre2';
import { unarmor } from './byteArmor';
import type { Lua } from 'wasmoon-lua5.1';

// rex.flags(): lrexlib's pcre2_flags and pcre2_error_flags (lpcre2_f.c), with
// pcre2.h's values. lrexlib stores them as C ints, so ANCHORED is negative.
const PCRE2_FLAGS: Array<[string, number]> = [
    ['ANCHORED', -2147483648], ['NO_UTF_CHECK', 0x40000000],
    ['ALLOW_EMPTY_CLASS', 0x1], ['ALT_BSUX', 0x2], ['AUTO_CALLOUT', 0x4], ['CASELESS', 0x8],
    ['DOLLAR_ENDONLY', 0x10], ['DOTALL', 0x20], ['DUPNAMES', 0x40], ['EXTENDED', 0x80],
    ['FIRSTLINE', 0x100], ['MATCH_UNSET_BACKREF', 0x200], ['MULTILINE', 0x400],
    ['NEVER_UCP', 0x800], ['NEVER_UTF', 0x1000], ['NO_AUTO_CAPTURE', 0x2000],
    ['NO_AUTO_POSSESS', 0x4000], ['NO_DOTSTAR_ANCHOR', 0x8000], ['NO_START_OPTIMIZE', 0x10000],
    ['UCP', 0x20000], ['UNGREEDY', 0x40000], ['UTF', 0x80000], ['NEVER_BACKSLASH_C', 0x100000],
    ['ALT_CIRCUMFLEX', 0x200000], ['ALT_VERBNAMES', 0x400000], ['USE_OFFSET_LIMIT', 0x800000],
    ['JIT_COMPLETE', 1], ['JIT_PARTIAL_SOFT', 2], ['JIT_PARTIAL_HARD', 4],
    ['NOTBOL', 1], ['NOTEOL', 2], ['NOTEMPTY', 4], ['NOTEMPTY_ATSTART', 8],
    ['PARTIAL_SOFT', 0x10], ['PARTIAL_HARD', 0x20], ['DFA_RESTART', 0x40], ['DFA_SHORTEST', 0x80],
    ['SUBSTITUTE_GLOBAL', 0x100], ['SUBSTITUTE_EXTENDED', 0x200], ['SUBSTITUTE_UNSET_EMPTY', 0x400],
    ['SUBSTITUTE_UNKNOWN_UNSET', 0x800], ['SUBSTITUTE_OVERFLOW_LENGTH', 0x1000], ['NO_JIT', 0x2000],
    ['NEWLINE_CR', 1], ['NEWLINE_LF', 2], ['NEWLINE_CRLF', 3], ['NEWLINE_ANY', 4], ['NEWLINE_ANYCRLF', 5],
    ['BSR_UNICODE', 1], ['BSR_ANYCRLF', 2],
    ['INFO_ALLOPTIONS', 0], ['INFO_ARGOPTIONS', 1], ['INFO_BACKREFMAX', 2], ['INFO_BSR', 3],
    ['INFO_CAPTURECOUNT', 4], ['INFO_FIRSTCODEUNIT', 5], ['INFO_FIRSTCODETYPE', 6],
    ['INFO_FIRSTBITMAP', 7], ['INFO_HASCRORLF', 8], ['INFO_JCHANGED', 9], ['INFO_JITSIZE', 10],
    ['INFO_LASTCODEUNIT', 11], ['INFO_LASTCODETYPE', 12], ['INFO_MATCHEMPTY', 13],
    ['INFO_MATCHLIMIT', 14], ['INFO_MAXLOOKBEHIND', 15], ['INFO_MINLENGTH', 16],
    ['INFO_NAMECOUNT', 17], ['INFO_NAMEENTRYSIZE', 18], ['INFO_NAMETABLE', 19], ['INFO_NEWLINE', 20],
    ['INFO_RECURSIONLIMIT', 21], ['INFO_SIZE', 22], ['INFO_HASBACKSLASHC', 23],
];
const PCRE2_ERRORS: string[] = [
    'NOMATCH', 'PARTIAL',
    ...Array.from({ length: 21 }, (_, i) => `UTF8_ERR${i + 1}`),
    'UTF16_ERR1', 'UTF16_ERR2', 'UTF16_ERR3', 'UTF32_ERR1', 'UTF32_ERR2',
    'BADDATA', 'MIXEDTABLES', 'BADMAGIC', 'BADMODE', 'BADOFFSET', 'BADOPTION', 'BADREPLACEMENT',
    'BADUTFOFFSET', 'CALLOUT', 'DFA_BADRESTART', 'DFA_RECURSE', 'DFA_UCOND', 'DFA_UFUNC',
    'DFA_UITEM', 'DFA_WSSIZE', 'INTERNAL', 'JIT_BADOPTION', 'JIT_STACKLIMIT', 'MATCHLIMIT',
    'NOMEMORY', 'NOSUBSTRING', 'NOUNIQUESUBSTRING', 'NULL', 'RECURSELOOP', 'RECURSIONLIMIT',
    'UNAVAILABLE', 'UNSET', 'BADOFFSETLIMIT', 'BADREPESCAPE', 'REPMISSINGBRACE',
    'BADSUBSTITUTION', 'BADSUBSPATTERN', 'TOOMANYREPLACE', 'BADSERIALIZEDDATA',
];

const ANCHORED = 0x80000000;
const UTF = 0x80000;
const NO_UTF_CHECK = 0x40000000;
const ERROR_UTF8_ERR = (n: number) => -2 - n;
const ERROR_BADUTFOFFSET = -36;

// Compile options with an in-pattern spelling. Those that have none and change
// matching (DOLLAR_ENDONLY, FIRSTLINE, …) cannot reach the wasm `compile`,
// whose flag string only knows a few letters.
const INLINE_FLAG_BITS: Array<[number, string]> = [
    [0x8, 'i'], [0x400, 'm'], [0x20, 's'], [0x80, 'x'], [0x40000, 'U'], [0x40, 'J'], [0x2000, 'n'],
];
const VERB_FLAG_BITS: Array<[number, string]> = [
    [0x20000, '(*UCP)'], [0x4000, '(*NO_AUTO_POSSESS)'], [0x10000, '(*NO_START_OPT)'],
    [0x8000, '(*NO_DOTSTAR_ANCHOR)'],
];
const LEADING_VERBS = /^(?:\(\*[A-Z0-9_]+(?:=\d+)?\))*/;

interface Compiled {
    re: InstanceType<typeof PCRE>;
    utf: boolean;
    ncap: number;
    /** The options every match of this pattern adds (ANCHORED given at compile time). */
    matchOptions: number;
}

/**
 * A subject prepared for one pattern: the code units PCRE2 sees, and for a UTF
 * pattern the maps between those units and the Lua string's bytes.
 */
interface Subject {
    units: string;
    bytes: number;
    /** unit index → byte offset (UTF only; length units + 1). */
    byteAt?: Int32Array;
    /** byte offset → unit index, -1 inside a character (UTF only; length bytes + 1). */
    unitAt?: Int32Array;
}

/**
 * Decode a byte-string as UTF-8 the way PCRE2's UTF check reads it, or return
 * the PCRE2_ERROR_UTF8_ERRn code it would fail with.
 */
function decodeUtf8(bytes: string): Subject | number {
    const n = bytes.length;
    const units: number[] = [];
    const byteAt: number[] = [];
    const unitAt = new Int32Array(n + 1).fill(-1);
    let i = 0;
    while (i < n) {
        const c = bytes.charCodeAt(i);
        let cp: number;
        let len: number;
        if (c < 0x80) { cp = c; len = 1; }
        else {
            if (c < 0xc0) return ERROR_UTF8_ERR(20);
            if (c >= 0xfe) return ERROR_UTF8_ERR(21);
            len = c < 0xe0 ? 2 : c < 0xf0 ? 3 : c < 0xf8 ? 4 : c < 0xfc ? 5 : 6;
            if (i + len > n) return ERROR_UTF8_ERR(len - 1 - (n - i - 1));
            cp = c & (0x3f >> (len - 1));
            for (let k = 1; k < len; k++) {
                const cc = bytes.charCodeAt(i + k);
                if ((cc & 0xc0) !== 0x80) return ERROR_UTF8_ERR(5 + k);
                cp = cp * 64 + (cc & 0x3f);
            }
            if (len === 5) return ERROR_UTF8_ERR(11);
            if (len === 6) return ERROR_UTF8_ERR(12);
            if (cp < [0, 0, 0x80, 0x800, 0x10000][len]) return ERROR_UTF8_ERR(13 + len);
            if (cp > 0x10ffff) return ERROR_UTF8_ERR(13);
            if (cp >= 0xd800 && cp <= 0xdfff) return ERROR_UTF8_ERR(14);
        }
        unitAt[i] = units.length;
        byteAt.push(i);
        if (cp > 0xffff) {
            byteAt.push(i);
            cp -= 0x10000;
            units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
            units.push(cp);
        }
        i += len;
    }
    unitAt[n] = units.length;
    byteAt.push(n);
    let text = '';
    for (let k = 0; k < units.length; k += 0x8000) text += String.fromCharCode(...units.slice(k, k + 0x8000));
    return { units: text, bytes: n, byteAt: Int32Array.from(byteAt), unitAt };
}

// Compiled patterns, most recently used last. A compiled pattern is reusable —
// match hands back fresh objects — so a gsub replacement function calling rex
// with the same pattern mid-loop cannot disturb the outer call (#195).
const RE_CACHE_LIMIT = 256;
const reCache = new Map<string, Compiled>();

class CompileError extends Error {}

function compile(armoredPattern: string, cf: number): Compiled {
    const key = `${cf}\u0000${armoredPattern}`;
    const hit = reCache.get(key);
    if (hit) {
        reCache.delete(key);
        reCache.set(key, hit);
        return hit;
    }
    const raw = unarmor(armoredPattern);
    const verbs = LEADING_VERBS.exec(raw)![0];
    const utf = (cf & UTF) !== 0 || /\(\*UTF\)/.test(verbs);
    let source = raw;
    if (utf) {
        const d = decodeUtf8(raw);
        if (typeof d === 'number') throw new CompileError('UTF-8 error in the pattern (pattern offset: 1)');
        source = d.units;
    }
    const ownVerbs = LEADING_VERBS.exec(source)![0];
    let body = source.substring(ownVerbs.length);
    if (cf & 0x02000000) body = `\\Q${body.replace(/\\E/g, '\\E\\\\E\\Q')}\\E`; // LITERAL
    let prefix = '';
    for (const [bit, verb] of VERB_FLAG_BITS) if (cf & bit) prefix += verb;
    let letters = '';
    for (const [bit, letter] of INLINE_FLAG_BITS) if (cf & bit) letters += letter;
    if (cf & 0x01000000) letters += 'xx'; // EXTENDED_MORE
    const inline = letters ? `(?${letters})` : '';
    let re: InstanceType<typeof PCRE>;
    try {
        re = new PCRE(prefix + ownVerbs + inline + body, '');
    } catch (err) {
        const e = err as Error & { offset?: number };
        let offset = typeof e.offset === 'number' ? e.offset : 0;
        // Where in the caller's pattern: not counting what was added to it.
        if (offset >= prefix.length + ownVerbs.length + inline.length) offset -= prefix.length + inline.length;
        else if (offset >= prefix.length) offset -= prefix.length;
        throw new CompileError(`${e.message} (pattern offset: ${offset + 1})`);
    }
    const c: Compiled = {
        re,
        utf,
        ncap: re.captureCount,
        matchOptions: ((cf & ANCHORED) | NO_UTF_CHECK) >>> 0,
    };
    reCache.set(key, c);
    if (reCache.size > RE_CACHE_LIMIT) {
        const [oldest, evicted] = reCache.entries().next().value!;
        reCache.delete(oldest);
        evicted.re.destroy();
    }
    return c;
}

function prepare(c: Compiled, armoredSubject: string): Subject | number {
    const bytes = unarmor(armoredSubject);
    return c.utf ? decodeUtf8(bytes) : { units: bytes, bytes: bytes.length };
}

/**
 * One pcre2_match from byte offset `st`: the ovector as byte offsets
 * (`[s0, e0, s1, e1, …]`, -1 for a group that did not take part), null for no
 * match, or a (negative) PCRE2 error code.
 */
function execAt(c: Compiled, subj: Subject, st: number, ef: number): number[] | null | number {
    let start = st;
    if (subj.unitAt) {
        start = subj.unitAt[st];
        if (start === undefined) return -33; // BADOFFSET
        if (start < 0) return ERROR_BADUTFOFFSET;
    }
    let m;
    try {
        m = c.re.matchFrom(subj.units, start, ((ef | c.matchOptions) >>> 0));
    } catch (err) {
        const code = (err as { code?: number }).code;
        if (typeof code === 'number') return code;
        throw err;
    }
    if (!m) return null;
    const out: number[] = [];
    for (let i = 0; i <= c.ncap; i++) {
        const g = m[i];
        if (!g || g.start < 0) { out.push(-1, -1); continue; }
        if (subj.byteAt) out.push(subj.byteAt[g.start], subj.byteAt[g.end]);
        else out.push(g.start, g.end);
    }
    return out;
}

/** Register the __rex_* JS helpers and build the module. `run` executes the
 *  module's Lua source — LuaRuntime compiles it as its own ("=[C]") code, since
 *  desktop's rex is the lrexlib C library. */
export async function setupRex(lua: Lua, run: (code: string) => void = code => { lua.doStringSync(code); }): Promise<void> {
    await PCRE.init();

    const toInt = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) | 0 : 0;
    };

    // compile(pattern, cf) → capture count and the name table as
    // "name\tgroup\n…", or { err } when the pattern does not compile.
    lua.global.set('__rex_compile__', (pattern: string, cf: number) => {
        try {
            const c = compile(pattern, toInt(cf));
            return { ncap: c.ncap, names: c.re.groupNames.map(([name, n]) => `${name}\t${n}\n`).join('') };
        } catch (err) {
            if (err instanceof CompileError) return { err: err.message };
            throw err;
        }
    });

    // exec(pattern, cf, subject, st, ef) → the ovector of one match from byte
    // offset st, null, or a PCRE2 error code.
    lua.global.set('__rex_exec__', (pattern: string, cf: number, subject: string, st: number, ef: number) => {
        const c = compile(pattern, toInt(cf));
        const subj = prepare(c, subject);
        if (typeof subj === 'number') return subj;
        return execAt(c, subj, toInt(st), toInt(ef));
    });

    // all(pattern, cf, subject, ef, limit) → every ovector, end to end, of the
    // matches lrexlib's gsub/count/gmatch/split loop takes (algo.h): resume at
    // the end of a match or one byte past an empty one, and discard an empty
    // match that ends where the previous match did. limit < 0 is no limit.
    lua.global.set('__rex_all__', (pattern: string, cf: number, subject: string, ef: number, limit: number) => {
        const c = compile(pattern, toInt(cf));
        const subj = prepare(c, subject);
        if (typeof subj === 'number') return subj;
        const len = subj.bytes;
        const max = toInt(limit);
        const flags = toInt(ef);
        const out: number[] = [];
        let n = 0;
        let st = 0;
        let lastTo = -1;
        while ((max < 0 || n < max) && st <= len) {
            const r = execAt(c, subj, st, flags);
            if (r === null) break;
            if (typeof r === 'number') return r;
            const from = r[0];
            const to = r[1];
            if (to === lastTo) {
                if (st < len) { st += 1; continue; }
                break;
            }
            lastTo = to;
            n++;
            for (const v of r) out.push(v);
            if (st < from) st = from;
            if (st < to) st = to;
            else if (st < len) st += 1;
            else break;
        }
        return out;
    });

    lua.global.set('__rex_pcre_version__', PCRE.version());

    const [major, minor] = PCRE.version().split(/[.\s]/).map(Number);
    const flagsLua = [
        `MAJOR = ${major || 10}`, `MINOR = ${minor || 0}`,
        ...PCRE2_FLAGS.map(([k, v]) => `${k} = ${v}`),
        ...PCRE2_ERRORS.map((k, i) => `ERROR_${k} = ${-1 - i}`),
    ].join(', ');

    run(`
        local _compile = __rex_compile__
        local _exec    = __rex_exec__
        local _all     = __rex_all__
        local armor    = __mudlet_armor
        local type, tostring, tonumber, error, select, pairs, setmetatable =
              type, tostring, tonumber, error, select, pairs, setmetatable
        local ssub, sfind, floor, concat = string.sub, string.find, math.floor, table.concat

        local M = {}

        local FLAGS = { ${flagsLua} }
        local ERROR_KEYS = {}
        for k, v in pairs(FLAGS) do
            if k:sub(1, 6) == "ERROR_" then ERROR_KEYS[v] = k end
        end

        -- generate_error: lrexlib names the code when it is a known one.
        local function matchError(code)
            local key = ERROR_KEYS[code]
            if key then error("error PCRE2_" .. key, 3) end
            error("PCRE2 error code " .. tostring(code), 3)
        end

        local function argError(n, fname, msg)
            error("bad argument #" .. n .. " to '" .. fname .. "' (" .. msg .. ")", 3)
        end

        local function trunc(x)
            if x ~= x or x == 1/0 or x == -1/0 then return 0 end
            return x >= 0 and floor(x) or -floor(-x)
        end

        -- lua_tointeger / luaL_optinteger.
        local function optint(v, n, fname, default)
            if v == nil then return default end
            local x = tonumber(v)
            if x == nil then argError(n, fname, "number expected, got " .. type(v)) end
            return trunc(x)
        end

        -- getcflags: a number, or a string of lrexlib's letters i m s x U.
        local LETTERS = { i = FLAGS.CASELESS, m = FLAGS.MULTILINE, s = FLAGS.DOTALL,
                          x = FLAGS.EXTENDED, U = FLAGS.UNGREEDY }
        local function getcflags(v, n, fname)
            local t = type(v)
            if v == nil then return 0 end
            if t == "number" then return trunc(v) end
            if t == "string" then
                local seen, res = {}, 0
                for k = 1, #v do
                    local bit = LETTERS[ssub(v, k, k)]
                    if bit and not seen[bit] then seen[bit] = true; res = res + bit end
                end
                return res
            end
            argError(n, fname, "number or string expected, got " .. t)
        end

        -- check_subject: a string (a number converts); lrexlib's
        -- table/userdata-with-topointer subjects have no memory to point at here.
        local function checkSubject(s, n, fname)
            local t = type(s)
            if t == "string" then return s end
            if t == "number" then return tostring(s) end
            argError(n, fname, "string, table or userdata expected, got " .. (s == nil and "no value" or t))
        end

        -- Compiled patterns are userdata, as lrexlib's are (Mudlet's starter UI
        -- checks type(compiled) == "userdata"); their state lives here.
        local regexes = setmetatable({}, { __mode = "k" })
        local infoCache = setmetatable({}, { __mode = "v" })

        local function compileInfo(pat, cf)
            local key = cf .. "\\0" .. pat
            local info = infoCache[key]
            if info then return info end
            local r = _compile(pat, cf)
            if r.err then error(r.err, 3) end
            info = { pat = pat, cf = cf, ncap = r.ncap, names = {} }
            for name, idx in r.names:gmatch("([^\\t\\n]*)\\t(%d+)\\n") do
                info.names[#info.names + 1] = { name, tonumber(idx) }
            end
            infoCache[key] = info
            return info
        end

        -- check_pattern + compile_regex: a compiled pattern keeps its own
        -- flags, whatever cf the call passes.
        local function pattern(p, cf, cfpos, fname)
            local ud = regexes[p]
            if ud then return ud end
            local t = type(p)
            if t == "string" or t == "number" then
                return compileInfo(armor(tostring(p)), getcflags(cf, cfpos, fname))
            end
            argError(2, fname, "string or rex_pcre2_regex expected, got " .. (p == nil and "no value" or t))
        end

        -- get_startoffset: a 1-based init, negative from the end, as a 0-based byte.
        local function startoffset(init, len, n, fname)
            local st = optint(init, n, fname, 1)
            if st > 0 then st = st - 1
            elseif st < 0 then
                st = st + len
                if st < 0 then st = 0 end
            end
            return st
        end

        local function exec(info, s, st, ef)
            local r = _exec(info.pat, info.cf, armor(s), st, ef)
            if r == nil then return nil end
            if type(r) == "number" then matchError(r) end
            return r
        end

        -- Capture i (0 = the whole match) of an ovector read from base: the
        -- substring, or false for a group that did not take part.
        local function cap(s, r, base, i)
            local b = r[base + 2 * i]
            if b == nil or b < 0 then return false end
            return ssub(s, b + 1, r[base + 2 * i + 1])
        end

        local function captures(s, r, base, ncap)
            local t = {}
            for i = 1, ncap do t[i] = cap(s, r, base, i) end
            return unpack(t, 1, ncap)
        end

        -- do_named_subpatterns: each named group's substring (or false) into t.
        local function named(t, info, s, r)
            for _, e in ipairs(info.names) do
                if e[2] > 0 and e[2] <= info.ncap then t[e[1]] = cap(s, r, 0, e[2]) end
            end
        end

        local FIND, MATCH, EXEC, TFIND = 0, 1, 2, 3

        local function finish(method, info, s, r)
            if method == EXEC then
                local offsets = {}
                for i = 1, info.ncap do
                    local b = r[2 * i]
                    if b >= 0 then
                        offsets[2 * i - 1], offsets[2 * i] = b + 1, r[2 * i + 1]
                    else
                        offsets[2 * i - 1], offsets[2 * i] = false, false
                    end
                end
                named(offsets, info, s, r)
                return r[0] + 1, r[1], offsets
            elseif method == TFIND then
                local t = {}
                for i = 1, info.ncap do t[i] = cap(s, r, 0, i) end
                named(t, info, s, r)
                return r[0] + 1, r[1], t
            elseif method == FIND then
                if info.ncap > 0 then return r[0] + 1, r[1], captures(s, r, 0, info.ncap) end
                return r[0] + 1, r[1]
            end
            if info.ncap > 0 then return captures(s, r, 0, info.ncap) end
            return cap(s, r, 0, 0)
        end

        -- find (s, patt, [st], [cf], [ef]) / match (s, patt, [st], [cf], [ef])
        local function findFunc(method, fname)
            return function(s, p, init, cf, ef)
                s = checkSubject(s, 1, fname)
                local info = pattern(p, cf, 4, fname)
                local st = startoffset(init, #s, 3, fname)
                ef = optint(ef, 5, fname, 0)
                if st > #s then return nil end
                local r = exec(info, s, st, ef)
                if r == nil then return nil end
                return finish(method, info, s, r)
            end
        end
        M.find = findFunc(FIND, "find")
        M.match = findFunc(MATCH, "match")
        -- Not lrexlib functions (it has them only as methods), kept for
        -- scripts written against earlier Mudlet Web.
        M.tfind = findFunc(TFIND, "tfind")
        M.exec = findFunc(EXEC, "exec")

        -- Every match lrexlib's loop takes, as one flat array of ovectors.
        local function all(info, s, ef, limit)
            local r = _all(info.pat, info.cf, armor(s), ef, limit)
            if type(r) == "number" then matchError(r) end
            return r, 2 * (info.ncap + 1)
        end

        -- gmatch (s, patt, [cf], [ef]): each match's captures, or the whole match.
        function M.gmatch(s, p, cf, ef)
            s = checkSubject(s, 1, "gmatch")
            local info = pattern(p, cf, 3, "gmatch")
            ef = optint(ef, 4, "gmatch", 0)
            local r, stride = all(info, s, ef, -1)
            local base = -stride
            return function()
                base = base + stride
                if r[base] == nil then return nil end
                if info.ncap > 0 then return captures(s, r, base, info.ncap) end
                return cap(s, r, base, 0)
            end
        end

        -- split (s, patt, [cf], [ef]): the text before each match, then the
        -- match's captures (or the match itself); last, the rest on its own.
        function M.split(s, p, cf, ef)
            s = checkSubject(s, 1, "split")
            local info = pattern(p, cf, 3, "split")
            ef = optint(ef, 4, "split", 0)
            local r, stride = all(info, s, ef, -1)
            local base, prev, done = -stride, 0, false
            return function()
                if done then return nil end
                base = base + stride
                if r[base] == nil then
                    done = true
                    return ssub(s, prev + 1)
                end
                local section = ssub(s, prev + 1, r[base])
                prev = r[base + 1]
                if info.ncap > 0 then return section, captures(s, r, base, info.ncap) end
                return section, cap(s, r, base, 0)
            end
        end

        -- count (s, patt, [cf], [ef])
        function M.count(s, p, cf, ef)
            s = checkSubject(s, 1, "count")
            local info = pattern(p, cf, 3, "count")
            ef = optint(ef, 4, "count", 0)
            local r, stride = all(info, s, ef, -1)
            local n = 0
            while r[n * stride] ~= nil do n = n + 1 end
            return n
        end

        -- bufferZ_putrepstring: the replacement split into literal text and
        -- capture numbers. %0 is the whole match, %1 too when there are no
        -- captures, a higher number is an error; % before anything else is
        -- that character, and a trailing % is dropped.
        local function parseRepl(repl, ncap)
            local parts, i, len = {}, 1, #repl
            while i <= len do
                local q = sfind(repl, "%", i, true)
                if not q then parts[#parts + 1] = ssub(repl, i); break end
                if q > i then parts[#parts + 1] = ssub(repl, i, q - 1) end
                if q < len then
                    local c = ssub(repl, q + 1, q + 1)
                    if c:find("^%d$") then
                        local num = tonumber(c)
                        if num == 1 and ncap == 0 then num = 0
                        elseif num > ncap then error("invalid capture index", 3) end
                        parts[#parts + 1] = num
                    else
                        parts[#parts + 1] = c
                    end
                end
                i = q + 2
            end
            return parts
        end

        -- gsub (s, patt, repl, [n], [cf], [ef]): lrexlib's algf_gsub. n caps
        -- the matches, or is a function asked about each one (with its start,
        -- end and replacement) whether to replace it and whether to go on.
        -- Returns the result, the number of matches and of substitutions.
        function M.gsub(s, p, repl, n, cf, ef)
            s = checkSubject(s, 1, "gsub")
            local info = pattern(p, cf, 5, "gsub")
            local rt = type(repl)
            if rt == "number" then repl = tostring(repl); rt = "string" end
            if rt ~= "string" and rt ~= "table" and rt ~= "function" then
                argError(3, "gsub", "string, table or function expected, got " .. (repl == nil and "no value" or rt))
            end
            local maxmatch, cond = -1, nil
            if n == nil then
                maxmatch = -1
            elseif type(n) == "function" then
                cond = n
            elseif tonumber(n) then
                maxmatch = trunc(tonumber(n))
                if maxmatch < 0 then maxmatch = 0 end
            else
                argError(4, "gsub", "number or function expected, got " .. type(n))
            end
            ef = optint(ef, 6, "gsub", 0)
            local ncap = info.ncap
            local parts = rt == "string" and parseRepl(repl, ncap) or nil
            local r, stride = all(info, s, ef, cond and -1 or maxmatch)
            local out, st, nmatch, nsub = {}, 0, 0, 0
            local base = 0
            while r[base] ~= nil and (cond or maxmatch < 0 or nmatch < maxmatch) do
                local from, to = r[base], r[base + 1]
                nmatch = nmatch + 1
                out[#out + 1] = ssub(s, st + 1, from)
                local whole = ssub(s, from + 1, to)
                local v, subst, val
                if rt == "string" then
                    local b = {}
                    for k = 1, #parts do
                        local part = parts[k]
                        if type(part) == "number" then
                            local c = cap(s, r, base, part)
                            if c then b[#b + 1] = c end
                        else
                            b[#b + 1] = part
                        end
                    end
                    v, subst = concat(b), true
                else
                    if rt == "table" then
                        val = repl[ncap > 0 and cap(s, r, base, 1) or whole]
                    elseif ncap > 0 then
                        val = repl(captures(s, r, base, ncap))
                    else
                        val = repl(whole)
                    end
                    local vt = type(val)
                    if vt == "string" or vt == "number" then
                        v, subst = tostring(val), true
                    elseif not val then
                        v, subst = whole, false
                    else
                        error("invalid replacement value (a " .. vt .. ")", 2)
                    end
                end
                if cond then
                    local a1, a2 = cond(from + 1, to, rt == "string" and v or val)
                    local t1 = type(a1)
                    if t1 == "string" or t1 == "number" then
                        v, subst = tostring(a1), true
                    elseif not a1 then
                        v, subst = whole, false
                    end
                    if type(a2) == "number" then
                        local more = trunc(a2)
                        if more < 0 then more = 0 end
                        maxmatch, cond = nmatch + more, nil
                    elseif a2 then
                        maxmatch, cond = -1, nil
                    end
                end
                out[#out + 1] = v
                if subst then nsub = nsub + 1 end
                st = to
                base = base + stride
            end
            out[#out + 1] = ssub(s, st + 1)
            return concat(out), nmatch, nsub
        end

        -- r:find / r:match / r:tfind / r:exec (s, [st], [ef])
        local function method(kind, fname)
            return function(self, s, init, ef)
                local info = regexes[self]
                if not info then argError(1, fname, "rex_pcre2_regex expected, got " .. type(self)) end
                s = checkSubject(s, 2, fname)
                local st = startoffset(init, #s, 3, fname)
                ef = optint(ef, 4, fname, 0)
                if st > #s then return nil end
                local r = exec(info, s, st, ef)
                if r == nil then return nil end
                return finish(kind, info, s, r)
            end
        end

        local methods = {
            find  = method(FIND, "find"),
            match = method(MATCH, "match"),
            tfind = method(TFIND, "tfind"),
            exec  = method(EXEC, "exec"),
            -- Not lrexlib methods, kept for scripts written against earlier
            -- Mudlet Web: the module functions with the pattern first.
            gsub   = function(self, s, repl, n) return M.gsub(s, self, repl, n) end,
            split  = function(self, s) return M.split(s, self) end,
            gmatch = function(self, s) return M.gmatch(s, self) end,
            count  = function(self, s) return M.count(s, self) end,
        }

        -- new (patt, [cf]): compiled up front, so a bad pattern fails here.
        function M.new(p, cf)
            local t = type(p)
            if t ~= "string" and t ~= "number" then
                argError(1, "new", "string expected, got " .. (p == nil and "no value" or t))
            end
            local info = compileInfo(armor(tostring(p)), getcflags(cf, 2, "new"))
            local proxy = newproxy(true)
            local mt = getmetatable(proxy)
            local addr = tostring(proxy):match("0x%x+") or "0x0"
            mt.__index = methods
            mt.__tostring = function() return "rex_pcre2_regex (" .. addr .. ")" end
            regexes[proxy] = info
            return proxy
        end

        -- flags ([t]): every constant, into t when one is passed.
        function M.flags(...)
            local t
            if select("#", ...) == 0 then
                t = {}
            else
                t = ...
                if type(t) ~= "table" then argError(1, "flags", "not a table") end
            end
            for k, v in pairs(FLAGS) do t[k] = v end
            return t
        end

        -- lrexlib's library-level extras (lpcre2.c / lpcre2_f.c, rel-2-9-4).
        M._VERSION = "Lrexlib 2.9.4 (for PCRE2)"
        local pcreVersion = __rex_pcre_version__
        M.version = function() return pcreVersion end
        -- rex.config([t]): the PCRE2 build's pcre2_config() values, into t
        -- when one is passed. lrexlib reads every key as an int, so the two
        -- string-valued ones (VERSION, UNICODE_VERSION) never make it in, and
        -- JITTARGET only does on a JIT build — the wasm library has no JIT.
        local CONFIG = {
            PCRE2_CONFIG_BSR = 1,                 -- PCRE2_BSR_UNICODE
            PCRE2_CONFIG_JIT = 0,
            PCRE2_CONFIG_LINKSIZE = 2,
            PCRE2_CONFIG_MATCHLIMIT = 10000000,
            PCRE2_CONFIG_NEWLINE = 2,             -- PCRE2_NEWLINE_LF
            PCRE2_CONFIG_PARENSLIMIT = 250,
            PCRE2_CONFIG_RECURSIONLIMIT = 10000000,
            PCRE2_CONFIG_STACKRECURSE = 0,
            PCRE2_CONFIG_UNICODE = 1,
        }
        M.config = function(t)
            if type(t) ~= "table" then t = {} end
            for k, v in pairs(CONFIG) do t[k] = v end
            return t
        end
        -- rex.maketables(): a "chartables" userdata, which rex.new accepts in
        -- place of a locale. The wasm library has one set of tables, the C
        -- locale's, which is also what pcre2_maketables(NULL) builds there.
        M.maketables = function()
            local ud = newproxy(true)
            local addr = tostring(ud):match("0x%x+") or "0x0"
            local mt = getmetatable(ud)
            mt.__tostring = function() return "chartables (" .. addr .. ")" end
            mt.__metatable = "access denied"
            return ud
        end

        -- Desktop registers this as rex_pcre2 and binds the result to the
        -- globals (rex_pcre = require "rex_pcre2"); "rex_pcre" is a module
        -- only on a build that fell back to the old PCRE1 library, so require
        -- of it fails there.
        package.loaded["rex_pcre2"] = M
        rex, rex_pcre2, rex_pcre = M, M, M

        __rex_compile__, __rex_exec__, __rex_all__, __rex_pcre_version__ = nil, nil, nil, nil
    `);
}
