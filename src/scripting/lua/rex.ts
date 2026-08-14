import PCRE from 'pcre2-wasm-universal';
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
    const re = new PCRE(buildInlinePrefix(flags) + pattern, '');
    try { return fn(re); } finally { re.destroy(); }
};

// DEBUG: diagnose pcre2-wasm-universal's hardcoded 1000-iter cap in matchAll.
// Logs the callsite, pattern, subject length, ANSI-escape count, and head/tail
// of the subject so we can identify what's blowing past the cap.
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

function safeMatchAll<T>(re: InstanceType<typeof PCRE>, subject: string, callsite: string, pattern: string): T {
    try {
        return re.matchAll(subject) as T;
    } catch (err) {
        if (err instanceof Error && err.message.includes('safety limit exceeded')) {
            logSafetyLimit(callsite, pattern, subject);
        }
        throw err;
    }
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

function resolveInit(subject: string, init: number | undefined): number {
    if (!init || init === 0) return 0;
    if (init < 0) return Math.max(0, subject.length + init);
    return Math.max(0, init - 1);
}

/** Register __rex_* JS helpers and put rex_pcre2 into package.loaded. */
export async function setupRex(lua: Lua): Promise<void> {
    await PCRE.init();

    type FlagsArg = string | number | null | undefined;

    // match(subject, pattern, flags?, init?) → table [cap1, cap2, ...] or nil
    lua.global.set('__rex_match__', (subject: string, pattern: string, flags: FlagsArg, init?: number) => {
        return withRe(pattern, flags, re => {
            const m = re.match(subject, resolveInit(subject, init));
            if (!m) return null;
            const caps = extractCaptures(m);
            return caps.length > 0 ? caps : [m[0].match];
        });
    });

    // find(subject, pattern, flags?, init?) → table [start, end, cap1, ...] or nil  (1-indexed)
    lua.global.set('__rex_find__', (subject: string, pattern: string, flags: FlagsArg, init?: number) => {
        return withRe(pattern, flags, re => {
            const m = re.match(subject, resolveInit(subject, init));
            if (!m) return null;
            return [m[0].start + 1, m[0].end, ...extractCaptures(m)];
        });
    });

    // tfind(subject, pattern, flags?, init?) → { startIdx, endIdx, captures: [{index,name?,value}] } or nil
    // Lua-side assembles a captures table keyed by both numeric index and (when present) name.
    lua.global.set('__rex_tfind__', (subject: string, pattern: string, flags: FlagsArg, init?: number) => {
        return withRe(pattern, flags, re => {
            const m = re.match(subject, resolveInit(subject, init));
            if (!m) return null;
            return {
                startIdx: m[0].start + 1,
                endIdx: m[0].end,
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

    // gsub(subject, pattern, repl, flags?) → string  (repl: string or Lua function)
    lua.global.set('__rex_gsub__', (subject: string, pattern: string, repl: unknown, flags: FlagsArg) => {
        return withRe(pattern, flags, re => {
            const matches = safeMatchAll<MatchResult[]>(re, subject, 'rex.gsub', pattern);
            let result = '';
            let lastEnd = 0;
            for (const m of matches) {
                result += subject.slice(lastEnd, m[0].start);
                if (typeof repl === 'function') {
                    const caps = extractCaptures(m);
                    const r = (repl as (...a: unknown[]) => unknown)(...caps);
                    result += r == null ? m[0].match : String(r);
                } else {
                    result += String(repl);
                }
                lastEnd = m[0].end;
            }
            return result + subject.slice(lastEnd);
        });
    });

    // gmatch(subject, pattern, flags?) → array of per-match capture rows for Lua iterator
    // Each row is the capture list, or [full_match] if there are no capture groups.
    lua.global.set('__rex_gmatch__', (subject: string, pattern: string, flags: FlagsArg) => {
        return withRe(pattern, flags, re => {
            const matches = safeMatchAll<MatchResult[]>(re, subject, 'rex.gmatch', pattern);
            return matches.map(m => {
                const caps = extractCaptures(m);
                return caps.length > 0 ? caps : [m[0].match];
            });
        });
    });

    // count(subject, pattern, flags?) → number of non-overlapping matches
    lua.global.set('__rex_count__', (subject: string, pattern: string, flags: FlagsArg) => {
        return withRe(pattern, flags, re => {
            return safeMatchAll<MatchResult[]>(re, subject, 'rex.count', pattern).length;
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

        M.gsub = function(subject, pattern, repl, n, cf)
            local p, cflags = unwrap(pattern)
            return _gsub(subject, p, repl, effFlags(cf, cflags))
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
            local methods = {
                match  = function(self, subject, init, ef) return M.match(subject, self, init) end,
                find   = function(self, subject, init, ef) return M.find(subject, self, init)  end,
                tfind  = function(self, subject, init, ef) return M.tfind(subject, self, init) end,
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
        __rex_flag_constants__ = nil

        return M
    `);
    lua.global.set('rex', rexModule);
    lua.global.set('rex_pcre2', rexModule);
    lua.global.set('rex_pcre', rexModule);
}
