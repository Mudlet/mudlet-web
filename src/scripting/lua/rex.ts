// The trigger engine's vendored wrapper, not `pcre2-wasm-universal` itself.
// Both drive the same wasm module, but upstream's `matchAll` resumes at
// `iter[0].end` unconditionally: a pattern that can match empty never advances,
// spins to its hardcoded 1000-iteration cap and throws — so `rex.gmatch`,
// `rex.gsub`, `rex.split` and `rex.count` failed outright on something as
// ordinary as `(\d*)`, ASCII subject and all. The fork steps past a zero-width
// match (by a whole code point, so a surrogate pair is never split) the way
// Mudlet's own global-match loop does.
import PCRE from '../../mud/triggers/pcre/Pcre2';
import type { Lua } from 'wasmoon-lua5.1';

type MatchGroup = { start: number; end: number; match: string; name?: string };
type MatchResult = Record<number, MatchGroup> & { length: number };

// PCRE2 compile-option bitmask constants (subset of pcre2.h). Exposed to Lua
// via rex.flags() so Mudlet code that does `rex.flags().CASELESS` gets the
// integer it expects. We accept these as the `cf` (compile flags) arg to
// rex.new / rex.match / etc. and translate them into PCRE2 inline modifiers
// on the pattern, since pcre2-wasm-universal's flag-letter parser is opaque.
const PCRE2_FLAGS: Record<string, number> = {
    ANCHORED: 0x80000000,
    NO_UTF_CHECK: 0x40000000,
    ENDANCHORED: 0x20000000,
    ALLOW_EMPTY_CLASS: 0x00000001,
    ALT_BSUX: 0x00000002,
    AUTO_CALLOUT: 0x00000004,
    CASELESS: 0x00000008,
    DOLLAR_ENDONLY: 0x00000010,
    DOTALL: 0x00000020,
    DUPNAMES: 0x00000040,
    EXTENDED: 0x00000080,
    FIRSTLINE: 0x00000100,
    MATCH_UNSET_BACKREF: 0x00000200,
    MULTILINE: 0x00000400,
    NEVER_UCP: 0x00000800,
    NEVER_UTF: 0x00001000,
    NO_AUTO_CAPTURE: 0x00002000,
    NO_AUTO_POSSESS: 0x00004000,
    NO_DOTSTAR_ANCHOR: 0x00008000,
    NO_START_OPTIMIZE: 0x00010000,
    UCP: 0x00020000,
    UNGREEDY: 0x00040000,
    UTF: 0x00080000,
    NEVER_BACKSLASH_C: 0x00100000,
    ALT_CIRCUMFLEX: 0x00200000,
    ALT_VERBNAMES: 0x00400000,
    USE_OFFSET_LIMIT: 0x00800000,
    EXTENDED_MORE: 0x01000000,
    LITERAL: 0x02000000,
};

// PCRE2 inline-modifier letters we can prepend to a pattern. The C library
// understands `(?imsxUJn)` syntax natively, so this avoids any dependency on
// how pcre2-wasm-universal parses its `flags` string argument.
const INLINE_FLAG_BITS: Array<[number, string]> = [
    [PCRE2_FLAGS.CASELESS, 'i'],
    [PCRE2_FLAGS.MULTILINE, 'm'],
    [PCRE2_FLAGS.DOTALL, 's'],
    [PCRE2_FLAGS.EXTENDED, 'x'],
    [PCRE2_FLAGS.UNGREEDY, 'U'],
    [PCRE2_FLAGS.DUPNAMES, 'J'],
    [PCRE2_FLAGS.NO_AUTO_CAPTURE, 'n'],
];

const INLINE_LETTERS = new Set(['i', 'm', 's', 'x', 'U', 'J', 'n']);

function buildInlinePrefix(flags: string | number | null | undefined): string {
    if (flags == null) return '';
    let letters = '';
    if (typeof flags === 'number') {
        if (flags === 0) return '';
        for (const [bit, letter] of INLINE_FLAG_BITS) {
            if (flags & bit) letters += letter;
        }
    } else if (typeof flags === 'string') {
        for (const ch of flags) {
            if (INLINE_LETTERS.has(ch)) letters += ch;
        }
    }
    return letters ? `(?${letters})` : '';
}

const withRe = <T>(
    pattern: string,
    flags: string | number | null | undefined,
    fn: (re: InstanceType<typeof PCRE>) => T,
): T => {
    if (typeof pattern !== 'string') {
        throw new TypeError(
            `rex: pattern must be a string, got ${typeof pattern}. ` +
            `Pass either a string or a compiled object from rex.new().`,
        );
    }
    return fn(compiled(buildInlinePrefix(flags) + pattern));
};

// Compiled patterns, most recently used last. Every rex call used to compile
// its pattern afresh and throw it away, and a `rex.new` object only carries the
// pattern string — so a trigger testing each line against a few dozen cached
// `rex.new` shapes recompiled every one of them per line, which under an output
// flood was seconds of lag on its own (#195). A compiled pattern is reusable:
// `match` hands back fresh objects, so a `gsub` replacement function that calls
// rex with the same pattern mid-loop cannot disturb the outer call.
const RE_CACHE_LIMIT = 256;
const reCache = new Map<string, InstanceType<typeof PCRE>>();

function compiled(source: string): InstanceType<typeof PCRE> {
    const hit = reCache.get(source);
    if (hit) {
        reCache.delete(source);
        reCache.set(source, hit);
        return hit;
    }
    // A pattern that fails to compile throws here and is not cached, so every
    // call reports the error just as before.
    const re = new PCRE(source, '');
    reCache.set(source, re);
    if (reCache.size > RE_CACHE_LIMIT) {
        const [oldest, evicted] = reCache.entries().next().value!;
        reCache.delete(oldest);
        evicted.destroy();
    }
    return re;
}

// The wrapper's safety cap scales with the subject, so it now fires only on a
// genuinely non-advancing loop rather than on any pattern that can match empty.
// Log enough to identify one if that ever happens.
function logSafetyLimit(callsite: string, pattern: string, subject: string): void {
    const ansiCount = (subject.match(/\x1b\[/g) ?? []).length;
    console.error('[matchAll safety limit]', {
        callsite,
        pattern,
        subjectLength: subject.length,
        ansiEscapeCount: ansiCount,
        subjectHead: subject.slice(0, 200),
        subjectTail: subject.slice(-200),
    });
}

function safeMatchAll<T>(
    re: InstanceType<typeof PCRE>, subject: string, callsite: string, pattern: string, includeEnd = false,
): T {
    try {
        return re.matchAll(subject, includeEnd) as T;
    } catch (err) {
        if (err instanceof Error && err.message.includes('safety limit exceeded')) {
            logSafetyLimit(callsite, pattern, subject);
        }
        throw err;
    }
}

// ── Byte offsets ─────────────────────────────────────────────────────────────
// Lua strings are bytes and lrexlib reports and accepts BYTE offsets, the same
// as string.find — so string.sub on a rex.find result cuts where it should. The
// subject reaches JS as a UTF-16 string, so every position crossing the bridge
// is translated: a code unit below 0x80 is one byte, below 0x800 two, a
// surrogate pair four, anything else three.

/** UTF-8 byte length of subject[from, to). */
function utf8Bytes(subject: string, from: number, to: number): number {
    let n = 0;
    for (let i = from; i < to; i++) {
        const c = subject.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
            const d = subject.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
        } else n += 3;
    }
    return n;
}

/** UTF-16 index of the first character starting at or after byte `byte` (0-based). */
function indexAtByte(subject: string, byte: number): number {
    let b = 0;
    let i = 0;
    while (i < subject.length && b < byte) {
        const pair = subject.charCodeAt(i) >= 0xd800 && subject.charCodeAt(i) <= 0xdbff
            && i + 1 < subject.length
            && subject.charCodeAt(i + 1) >= 0xdc00 && subject.charCodeAt(i + 1) <= 0xdfff;
        const step = pair ? 2 : 1;
        b += utf8Bytes(subject, i, i + step);
        i += step;
    }
    return i;
}

/**
 * lrexlib's `init`: a 1-based byte position, negative counts back from the
 * end, and a start past the end is no match at all (-1 here). One exactly at
 * the end is allowed — `$` still matches there.
 */
function resolveInit(subject: string, init: number | null | undefined): number {
    if (init == null || init === 0) return 0;
    const total = utf8Bytes(subject, 0, subject.length);
    const byte = init > 0 ? init - 1 : Math.max(0, total + init);
    if (byte > total) return -1;
    return indexAtByte(subject, byte);
}

/** The 1-based start and inclusive end byte offsets of a match group. */
function byteSpan(subject: string, g: MatchGroup): [number, number] {
    const start = utf8Bytes(subject, 0, g.start);
    return [start + 1, start + utf8Bytes(subject, g.start, g.end)];
}

function extractCaptures(m: MatchResult): (string | false)[] {
    const caps: (string | false)[] = [];
    // pcre2-wasm-universal's `m.length` is the ovector pair count, which includes
    // the full match at index 0 — capture groups live at 1..length-1.
    for (let i = 1; i < m.length; i++) {
        // PCRE2 sets ovector to PCRE2_UNSET for unmatched optional groups,
        // which the wasm bridge reads as start === -1. The match object still
        // exists (with match === ""), so we must check the offset, not truthiness,
        // to distinguish "did not match" from "matched empty string".
        const cap = m[i];
        caps.push(cap && cap.start >= 0 ? cap.match : false);
    }
    return caps;
}

type NamedCapture = { index: number; name?: string; value: string | false };

function extractNamedCaptures(m: MatchResult): NamedCapture[] {
    const out: NamedCapture[] = [];
    for (let i = 1; i < m.length; i++) {
        const cap = m[i];
        const matched = !!cap && cap.start >= 0;
        out.push({
            index: i,
            name: cap?.name,
            value: matched ? cap.match : false,
        });
    }
    return out;
}

/** Register __rex_* JS helpers and put rex_pcre2 into package.loaded. */
export async function setupRex(lua: Lua): Promise<void> {
    await PCRE.init();

    type FlagsArg = string | number | null | undefined;

    // match(subject, pattern, flags?, init?) → table [cap1, cap2, ...] or nil
    lua.global.set('__rex_match__', (subject: string, pattern: string, flags: FlagsArg, init?: number) => {
        return withRe(pattern, flags, re => {
            const start = resolveInit(subject, init);
            const m = start < 0 ? null : re.matchFrom(subject, start);
            if (!m) return null;
            const caps = extractCaptures(m);
            return caps.length > 0 ? caps : [m[0].match];
        });
    });

    // find(subject, pattern, flags?, init?) → table [start, end, cap1, ...] or nil  (1-indexed)
    lua.global.set('__rex_find__', (subject: string, pattern: string, flags: FlagsArg, init?: number) => {
        return withRe(pattern, flags, re => {
            const start = resolveInit(subject, init);
            const m = start < 0 ? null : re.matchFrom(subject, start);
            if (!m) return null;
            return [...byteSpan(subject, m[0]), ...extractCaptures(m)];
        });
    });

    // tfind(subject, pattern, flags?, init?) → { startIdx, endIdx, captures: [{index,name?,value}] } or nil
    // Lua-side assembles a captures table keyed by both numeric index and (when present) name.
    lua.global.set('__rex_tfind__', (subject: string, pattern: string, flags: FlagsArg, init?: number) => {
        return withRe(pattern, flags, re => {
            const start = resolveInit(subject, init);
            const m = start < 0 ? null : re.matchFrom(subject, start);
            if (!m) return null;
            const [startIdx, endIdx] = byteSpan(subject, m[0]);
            return {
                startIdx,
                endIdx,
                captures: extractNamedCaptures(m),
            };
        });
    });

    // split(subject, pattern, flags?) → array of [section, cap1, ...] for Lua iterator
    lua.global.set('__rex_split__', (subject: string, pattern: string, flags: FlagsArg) => {
        return withRe(pattern, flags, re => {
            const matches = safeMatchAll<MatchResult[]>(re, subject, 'rex.split', pattern);
            const results: (string | false)[][] = [];
            let lastEnd = 0;
            for (const m of matches) {
                results.push([subject.slice(lastEnd, m[0].start), ...extractCaptures(m)]);
                lastEnd = m[0].end;
            }
            results.push([subject.slice(lastEnd)]);
            return results;
        });
    });

    // gsub(subject, pattern, flags?, limit?) → { pieces, rows, ncap }
    // Only the matching happens here: `pieces` is the unmatched text around the
    // matches (one more than there are rows) and each row is [whole, cap1, ...].
    // The Lua side applies the replacement, so a table or function repl is a
    // real Lua value and the result string never round-trips through JS.
    lua.global.set('__rex_gsub__', (subject: string, pattern: string, flags: FlagsArg, limit?: number | null) => {
        return withRe(pattern, flags, re => {
            let matches = safeMatchAll<MatchResult[]>(re, subject, 'rex.gsub', pattern, true);
            if (typeof limit === 'number') matches = matches.slice(0, Math.max(0, Math.floor(limit)));
            const pieces: string[] = [];
            const rows: (string | false)[][] = [];
            let lastEnd = 0;
            for (const m of matches) {
                pieces.push(subject.slice(lastEnd, m[0].start));
                rows.push([m[0].match, ...extractCaptures(m)]);
                lastEnd = m[0].end;
            }
            pieces.push(subject.slice(lastEnd));
            return { pieces, rows, ncap: matches.length > 0 ? matches[0].length - 1 : 0 };
        });
    });

    // exec(subject, pattern, flags?, init?) → [start, end, s1, e1, s2, e2, ...] or nil
    // (byte offsets; an unmatched group's pair is false, false)
    lua.global.set('__rex_exec__', (subject: string, pattern: string, flags: FlagsArg, init?: number) => {
        return withRe(pattern, flags, re => {
            const start = resolveInit(subject, init);
            const m = start < 0 ? null : re.matchFrom(subject, start);
            if (!m) return null;
            const out: (number | false)[] = [...byteSpan(subject, m[0])];
            for (let i = 1; i < m.length; i++) {
                const cap = m[i];
                if (cap && cap.start >= 0) out.push(...byteSpan(subject, cap));
                else out.push(false, false);
            }
            return out;
        });
    });

    // compile(pattern, flags?) → error message, or nil when the pattern compiles.
    // rex.new compiles up front, as lrexlib does, so a bad pattern fails there.
    lua.global.set('__rex_compile__', (pattern: string, flags: FlagsArg) => {
        try {
            withRe(pattern, flags, () => undefined);
            return null;
        } catch (err) {
            const e = err as Error & { offset?: number };
            return typeof e.offset === 'number'
                ? `${e.message} (pattern offset: ${e.offset + 1})`
                : e.message;
        }
    });

    // gmatch(subject, pattern, flags?) → array of per-match capture rows for Lua iterator
    // Each row is the capture list, or [full_match] if there are no capture groups.
    lua.global.set('__rex_gmatch__', (subject: string, pattern: string, flags: FlagsArg) => {
        return withRe(pattern, flags, re => {
            const matches = safeMatchAll<MatchResult[]>(re, subject, 'rex.gmatch', pattern, true);
            return matches.map(m => {
                const caps = extractCaptures(m);
                return caps.length > 0 ? caps : [m[0].match];
            });
        });
    });

    // count(subject, pattern, flags?) → number of non-overlapping matches
    lua.global.set('__rex_count__', (subject: string, pattern: string, flags: FlagsArg) => {
        return withRe(pattern, flags, re => {
            return safeMatchAll<MatchResult[]>(re, subject, 'rex.count', pattern, true).length;
        });
    });

    // Expose the PCRE2 flag constants table to Lua, so rex.flags() can return it.
    lua.global.set('__rex_flag_constants__', PCRE2_FLAGS);

    const rexModule = await lua.doString(`
        local _match  = __rex_match__
        local _find   = __rex_find__
        local _tfind  = __rex_tfind__
        local _split  = __rex_split__
        local _gsub   = __rex_gsub__
        local _gmatch = __rex_gmatch__
        local _count  = __rex_count__
        local _exec   = __rex_exec__
        local _compile = __rex_compile__
        local _flags  = __rex_flag_constants__

        local M = {}

        -- JS arrays use 0-based indexing. Collect all elements into a proper
        -- 1-based Lua table (stopping at the first nil) then unpack it.
        local function jsarr2vararg(t)
            local r = {}
            local i = 0
            while true do
                local v = t[i]
                if v == nil then break end
                r[i + 1] = v
                i = i + 1
            end
            return unpack(r)
        end

        -- Convert a 0-indexed JS array of NamedCapture objects into a Lua
        -- captures table keyed by both numeric index and (when present) name.
        -- Unmatched optional groups arrive as boolean false.
        local function buildCaptures(groups)
            local t = {}
            local i = 0
            while true do
                local g = groups[i]
                if g == nil then break end
                local v = g.value
                if v == nil then v = false end
                t[g.index] = v
                if g.name and g.name ~= nil then t[g.name] = v end
                i = i + 1
            end
            return t
        end

        -- Mudlet's rex_pcre2 accepts either a raw pattern string OR a compiled
        -- pattern object (from rex.new) as the pattern argument to module-level
        -- functions like rex.gsub / rex.match. We tag compiled objects with
        -- __pattern/__flags and unwrap them here before forwarding to the JS
        -- bridge — passing the table itself would silently coerce to a bogus
        -- pattern in PCRE and can spin matchAll until the safety cap fires.
        local function unwrap(p)
            local t = type(p)
            if (t == 'table' or t == 'userdata') and p.__pattern then
                return p.__pattern, p.__flags
            end
            return p, nil
        end

        -- Resolve effective compile flags: caller-supplied cf wins, otherwise
        -- fall back to whatever the compiled pattern carries.
        local function effFlags(cf, compiledFlags)
            if cf ~= nil then return cf end
            return compiledFlags
        end

        M.flags = function() return _flags end

        M.match = function(subject, pattern, init, cf)
            local p, cflags = unwrap(pattern)
            local t = _match(subject, p, effFlags(cf, cflags), init)
            if t == nil then return nil end
            return jsarr2vararg(t)
        end

        M.find = function(subject, pattern, init, cf)
            local p, cflags = unwrap(pattern)
            local t = _find(subject, p, effFlags(cf, cflags), init)
            if t == nil then return nil end
            return jsarr2vararg(t)
        end

        -- Returns: start_idx, end_idx, captures_table (both numeric and named keys)
        M.tfind = function(subject, pattern, init, cf)
            local p, cflags = unwrap(pattern)
            local r = _tfind(subject, p, effFlags(cf, cflags), init)
            if r == nil then return nil end
            return r.startIdx, r.endIdx, buildCaptures(r.captures)
        end

        M.split = function(subject, pattern, cf)
            local p, cflags = unwrap(pattern)
            local results = _split(subject, p, effFlags(cf, cflags))
            local i = -1
            return function()
                i = i + 1
                local row = results[i]
                if row == nil then return nil end
                -- row is a 0-indexed JS array: [section, cap1, cap2, ...]
                return row[0], row[1], row[2]
            end
        end

        -- lrexlib's gsub: repl is a string (%0 the whole match, %1-%9 the
        -- captures, %1 the whole match when there are none, % before anything
        -- else is that character), a table indexed by the first capture, or a
        -- function called with the captures. A table or function yielding
        -- false/nil keeps the match as it was. n caps the number of matches.
        -- Returns the new string, the number of matches and the number of
        -- substitutions made.
        local function expand(repl, row, ncap)
            local out = {}
            local i, len = 1, #repl
            while i <= len do
                local c = repl:sub(i, i)
                if c == "%" and i < len then
                    local nx = repl:sub(i + 1, i + 1)
                    local d = tonumber(nx)
                    if d then
                        local v
                        if d == 0 or (d == 1 and ncap == 0) then
                            v = row[0]
                        elseif d <= ncap then
                            v = row[d]
                        else
                            error("invalid capture index %" .. nx .. " in replacement string", 3)
                        end
                        if v then out[#out + 1] = v end
                    else
                        out[#out + 1] = nx
                    end
                    i = i + 2
                else
                    out[#out + 1] = c
                    i = i + 1
                end
            end
            return table.concat(out)
        end

        M.gsub = function(subject, pattern, repl, n, cf)
            local p, cflags = unwrap(pattern)
            local rt = type(repl)
            if rt == "number" then repl = tostring(repl); rt = "string" end
            if rt ~= "string" and rt ~= "table" and rt ~= "function" then
                error("bad argument #3 to 'gsub' (string, table or function expected, got " .. rt .. ")", 2)
            end
            local r = _gsub(subject, p, effFlags(cf, cflags), type(n) == "number" and n or nil)
            local pieces, rows, ncap = r.pieces, r.rows, r.ncap
            local out = { pieces[0] }
            local nmatch, nsub = 0, 0
            while true do
                local row = rows[nmatch]
                if row == nil then break end
                nmatch = nmatch + 1
                local whole = row[0]
                local v
                if rt == "string" then
                    v = expand(repl, row, ncap)
                else
                    local first = row[ncap > 0 and 1 or 0]
                    if rt == "table" then
                        v = repl[first]
                    elseif ncap == 0 then
                        v = repl(whole)
                    else
                        local args = {}
                        for k = 1, ncap do args[k] = row[k] end
                        v = repl(unpack(args, 1, ncap))
                    end
                end
                if v == nil or v == false then
                    out[#out + 1] = whole
                else
                    local vt = type(v)
                    if vt ~= "string" and vt ~= "number" then
                        error("invalid replacement value (a " .. vt .. ")", 2)
                    end
                    out[#out + 1] = tostring(v)
                    nsub = nsub + 1
                end
                out[#out + 1] = pieces[nmatch]
            end
            return table.concat(out), nmatch, nsub
        end

        -- Returns start, end and a table of capture offsets {s1, e1, s2, e2, ...}
        -- (false for a group that did not take part), all byte positions.
        M.exec = function(subject, pattern, init, cf)
            local p, cflags = unwrap(pattern)
            local t = _exec(subject, p, effFlags(cf, cflags), init)
            if t == nil then return nil end
            local offsets = {}
            local i = 2
            while true do
                local v = t[i]
                if v == nil then break end
                offsets[i - 1] = v
                i = i + 1
            end
            return t[0], t[1], offsets
        end

        -- gmatch returns an iterator yielding captures of each match.
        -- If the pattern has no capture groups, yields the whole match.
        M.gmatch = function(subject, pattern, cf)
            local p, cflags = unwrap(pattern)
            local rows = _gmatch(subject, p, effFlags(cf, cflags))
            local i = -1
            return function()
                i = i + 1
                local row = rows[i]
                if row == nil then return nil end
                return jsarr2vararg(row)
            end
        end

        M.count = function(subject, pattern, cf)
            local p, cflags = unwrap(pattern)
            return _count(subject, p, effFlags(cf, cflags))
        end

        -- A compiled pattern is USERDATA, not a table. The distinction is
        -- visible: lrexlib hands back userdata, and scripts check for it —
        -- Mudlet's own starter UI verifies its patterns compiled by asserting
        -- type(compiled) == "userdata", and treats a table as "this one fell
        -- back to recompiling per line". newproxy is Lua 5.1's only way to make
        -- one from Lua; the fields and methods hang off its metatable.
        M.new = function(pattern, flags)
            if type(pattern) ~= "string" then
                error("bad argument #1 to 'new' (string expected, got " .. type(pattern) .. ")", 2)
            end
            local err = _compile(pattern, flags)
            if err then error(err, 2) end
            local methods = {
                match  = function(self, subject, init, ef) return M.match(subject, self, init) end,
                find   = function(self, subject, init, ef) return M.find(subject, self, init)  end,
                tfind  = function(self, subject, init, ef) return M.tfind(subject, self, init) end,
                exec   = function(self, subject, init, ef) return M.exec(subject, self, init) end,
                gsub   = function(self, subject, repl, n) return M.gsub(subject, self, repl, n) end,
                split  = function(self, subject) return M.split(subject, self) end,
                gmatch = function(self, subject) return M.gmatch(subject, self) end,
                count  = function(self, subject) return M.count(subject, self) end,
            }
            local fields = { __pattern = pattern, __flags = flags }
            local ok, proxy = pcall(newproxy, true)
            if not ok or proxy == nil then
                -- No newproxy (a stripped 5.1, or 5.2+): a table still works
                -- for everything except the type() check.
                return setmetatable(fields, { __index = methods })
            end
            local mt = getmetatable(proxy)
            mt.__index = function(_, key)
                local v = fields[key]
                if v ~= nil then return v end
                return methods[key]
            end
            mt.__tostring = function() return "pcre2 (" .. tostring(pattern) .. ")" end
            return proxy
        end

        package.loaded["rex_pcre2"] = M
        package.loaded["rex_pcre"] = M

        -- clean up bridge globals
        __rex_match__  = nil
        __rex_find__   = nil
        __rex_tfind__  = nil
        __rex_split__  = nil
        __rex_gsub__   = nil
        __rex_gmatch__ = nil
        __rex_count__  = nil
        __rex_exec__   = nil
        __rex_compile__ = nil
        __rex_flag_constants__ = nil

        return M
    `);
    lua.global.set('rex', rexModule);
    lua.global.set('rex_pcre2', rexModule);
    lua.global.set('rex_pcre', rexModule);
}
