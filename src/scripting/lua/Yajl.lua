-- Mudlet's yajl module: JSON encode/decode for Lua.
--
-- Desktop Mudlet links lua-yajl (brimworks/lua-yajl, lua_yajl.c, over yajl
-- 2.1). This file reproduces its surface — to_value, to_string, generator,
-- parser and the null sentinel — and its output byte for byte where a script
-- could tell the difference. Line references below are to lua_yajl.c.
--
--   to_value   JSON.parse in JS and Lua table-constructor source back
--              (__yajl_parse_src__), or the raw lua_* builder for documents too
--              deep to express as source (__yajl_parse__) — see yajl.ts. Input
--              JSON.parse rejects, and the comment/no-UTF-8-check options, go
--              through the Lua push parser below, which also renders yajl's own
--              error text.
--   to_string  a Lua port of yajl_gen's state machine driven the way
--              js_generator_value drives it.
--   parser     a Lua port of yajl's push parser and lexer.

yajl = {}

-- A zero-size-looking userdata the JS side built and parked in the registry
-- under "yajl.null", exactly where lua_yajl keeps its own (luaopen_yajl).
yajl.null = __yajl_null__
__yajl_null__ = nil
getmetatable(yajl.null).__tostring = function() return 'null' end -- js_null_tostring

-- lua_yajl compares against the sentinel it created, not whatever yajl.null
-- holds now (lua_topointer(L, 2) == js_null), so capture it.
local NULL = yajl.null

local byte, char, find, sub, format, rep = string.byte, string.char, string.find, string.sub, string.format, string.rep
local concat = table.concat
local next, type, rawget, rawset, rawequal = next, type, rawget, rawset, rawequal
local tonumber, error, select = tonumber, error, select
local floor, huge = math.floor, math.huge
local getmetatable_raw = (debug and debug.getmetatable) or getmetatable

local FILE = 'lua_yajl.c'

-- luaL_argerror from a method call (the generator's methods): the self slot is
-- not counted and, raised from a C frame, there is no position prefix.
local function arg_error(n, fname, expected, got)
    error(format("bad argument #%d to '%s' (%s expected, got %s)", n, fname, expected, got), 0)
end

-- ── Push parser (yajl_parser.c / yajl_lex.c) ────────────────────────────────

-- Lexical errors (yajl_lex_error_to_string).
local LEX_INVALID_UTF8 = 'invalid bytes in UTF8 string.'
local LEX_BAD_ESCAPE = "inside a string, '\\' occurs before a character which it may not."
local LEX_BAD_STRING_CHAR = 'invalid character inside string.'
local LEX_BAD_HEX = "invalid (non-hex) character occurs after '\\u' inside string."
local LEX_INVALID_CHAR = 'invalid char in json text.'
local LEX_INVALID_STRING = 'invalid string in json text.'
local LEX_EXPONENT = 'malformed number, a digit is required after the exponent.'
local LEX_DECIMAL = 'malformed number, a digit is required after the decimal point.'
local LEX_MINUS = 'malformed number, a digit is required after the minus sign.'
local LEX_COMMENT = 'probable comment found in input text, comments are not enabled.'

-- Parser states (yajl_state).
local P_START, P_COMPLETE, P_ERROR = 1, 2, 3
local P_MAP_START, P_MAP_NEED_KEY, P_MAP_SEP, P_MAP_NEED_VAL, P_MAP_GOT_VAL = 4, 5, 6, 7, 8
local P_ARRAY_START, P_ARRAY_NEED_VAL, P_ARRAY_GOT_VAL = 9, 10, 11

local ESCAPE_CHARS = { [34] = '"', [92] = '\\', [47] = '/', [98] = '\b', [102] = '\f', [110] = '\n', [114] = '\r', [116] = '\t' }

local function is_hex(c)
    return c and ((c >= 48 and c <= 57) or (c >= 65 and c <= 70) or (c >= 97 and c <= 102))
end

-- Utf32toUtf8 (yajl_encode.c).
local function utf8_encode(cp)
    if cp < 0x80 then return char(cp) end
    if cp < 0x800 then return char(0xC0 + floor(cp / 0x40), 0x80 + cp % 0x40) end
    if cp < 0x10000 then
        return char(0xE0 + floor(cp / 0x1000), 0x80 + floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
    end
    if cp < 0x200000 then
        return char(0xF0 + floor(cp / 0x40000), 0x80 + floor(cp / 0x1000) % 0x40,
            0x80 + floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
    end
    return '?'
end

-- yajl_string_decode: the body of a string token that contains escapes.
local function decode_string(s)
    local out, n, i, len = {}, 0, 1, #s
    while i <= len do
        local j = find(s, '\\', i, true)
        if not j then n = n + 1; out[n] = sub(s, i); break end
        if j > i then n = n + 1; out[n] = sub(s, i, j - 1) end
        local e = byte(s, j + 1)
        if e == 117 then -- \uXXXX
            local cp = tonumber(sub(s, j + 2, j + 5), 16)
            i = j + 6
            if cp >= 0xD800 and cp <= 0xDBFF then
                if sub(s, i, i + 1) == '\\u' then
                    local lo = tonumber(sub(s, i + 2, i + 5), 16) or 0
                    cp = (cp % 0x40) * 0x400 + (floor(cp / 0x40) % 0x10 + 1) * 0x10000 + lo % 0x400
                    i = i + 6
                    n = n + 1; out[n] = utf8_encode(cp)
                else
                    n = n + 1; out[n] = '?'
                end
            else
                n = n + 1; out[n] = utf8_encode(cp)
            end
        else
            n = n + 1; out[n] = ESCAPE_CHARS[e]
            i = j + 2
        end
    end
    return concat(out)
end

-- The lexer proper (yajl_lex_lex). Returns kind, value, next position; or
-- 'eof' when the token runs off the end of the text (it is kept for the next
-- chunk); or 'error', message, offset. Offsets are 0-based bytes consumed, as
-- yajl reports them.
local function lex(self, text, pos)
    local len = #text
    while true do
        if pos > len then return 'eof', nil, pos end
        local c = byte(text, pos)
        if c == 32 or (c >= 9 and c <= 13) then
            pos = pos + 1
        elseif c == 47 then -- '/'
            if not self.allow_comments then return 'error', LEX_COMMENT, pos - 1 end
            if pos == len then return 'eof', nil, pos end
            local c2 = byte(text, pos + 1)
            if c2 == 42 then -- /* ... */
                local e = find(text, '*/', pos + 2, true)
                if not e then return 'eof', nil, pos end
                pos = e + 2
            elseif c2 == 47 then -- // ... \n
                local e = find(text, '\n', pos + 2, true)
                if not e then return 'eof', nil, pos end
                pos = e + 1
            else
                return 'error', LEX_INVALID_CHAR, pos + 1
            end
        else
            break
        end
    end
    local start = pos
    local c = byte(text, pos)
    if c == 123 then return '{', nil, pos + 1 end
    if c == 125 then return '}', nil, pos + 1 end
    if c == 91 then return '[', nil, pos + 1 end
    if c == 93 then return ']', nil, pos + 1 end
    if c == 58 then return ':', nil, pos + 1 end
    if c == 44 then return ',', nil, pos + 1 end
    if c == 34 then
        local i, escapes = pos + 1, false
        local check = self.check_utf8
        while true do
            local j = find(text, check and '[%z\1-\31"\\\128-\255]' or '[%z\1-\31"\\]', i)
            if not j then return 'eof', nil, start end
            local b = byte(text, j)
            if b == 34 then
                local body = sub(text, pos + 1, j - 1)
                return 'string', escapes and decode_string(body) or body, j + 1
            elseif b == 92 then
                if j == len then return 'eof', nil, start end
                local e = byte(text, j + 1)
                if e == 117 then
                    for k = j + 2, j + 5 do
                        if k > len then return 'eof', nil, start end
                        if not is_hex(byte(text, k)) then return 'error', LEX_BAD_HEX, k end
                    end
                    i = j + 6
                elseif ESCAPE_CHARS[e] then
                    i = j + 2
                else
                    return 'error', LEX_BAD_ESCAPE, j + 1
                end
                escapes = true
            elseif b < 32 then
                return 'error', LEX_BAD_STRING_CHAR, j
            else -- a UTF-8 lead byte (yajl_lex_utf8_char)
                local need
                if b >= 0xC0 and b < 0xE0 then need = 1
                elseif b >= 0xE0 and b < 0xF0 then need = 2
                elseif b >= 0xF0 and b < 0xF8 then need = 3
                else return 'error', LEX_INVALID_UTF8, j end
                for k = j + 1, j + need do
                    if k > len then return 'eof', nil, start end
                    local cb = byte(text, k)
                    if cb < 0x80 or cb >= 0xC0 then return 'error', LEX_INVALID_UTF8, k end
                end
                i = j + need + 1
            end
        end
    end
    if c == 45 or (c >= 48 and c <= 57) then -- yajl_lex_number
        local i = pos
        if c == 45 then
            i = i + 1
            if i > len then return 'eof', nil, start end
            c = byte(text, i)
        end
        if c == 48 then
            i = i + 1
        elseif c and c >= 49 and c <= 57 then
            repeat
                i = i + 1
                if i > len then return 'eof', nil, start end
                c = byte(text, i)
            until not (c >= 48 and c <= 57)
        else
            return 'error', LEX_MINUS, i - 1
        end
        if i > len then return 'eof', nil, start end
        c = byte(text, i)
        if c == 46 then -- fraction
            local digits = 0
            repeat
                i = i + 1
                if i > len then return 'eof', nil, start end
                c = byte(text, i)
                if c >= 48 and c <= 57 then digits = digits + 1 end
            until not (c >= 48 and c <= 57)
            if digits == 0 then return 'error', LEX_DECIMAL, i - 1 end
        end
        if c == 101 or c == 69 then -- exponent
            i = i + 1
            if i > len then return 'eof', nil, start end
            c = byte(text, i)
            if c == 43 or c == 45 then
                i = i + 1
                if i > len then return 'eof', nil, start end
                c = byte(text, i)
            end
            if c >= 48 and c <= 57 then
                repeat
                    i = i + 1
                    if i > len then return 'eof', nil, start end
                    c = byte(text, i)
                until not (c >= 48 and c <= 57)
            else
                return 'error', LEX_EXPONENT, i - 1
            end
        end
        -- strtod, as todouble() does: 1e999 is inf, -0 keeps its sign.
        return 'number', tonumber(sub(text, start, i - 1)), i
    end
    local word = (c == 116 and 'true') or (c == 102 and 'false') or (c == 110 and 'null')
    if word then
        for k = 2, #word do
            local p = pos + k - 1
            if p > len then return 'eof', nil, start end
            if byte(text, p) ~= byte(word, k) then return 'error', LEX_INVALID_STRING, p end
        end
        if word == 'null' then return 'null', NULL, pos + 4 end
        return 'boolean', word == 'true', pos + #word
    end
    return 'error', LEX_INVALID_CHAR, pos
end

-- yajl_render_error_string, verbose: the message, then up to 30 bytes either
-- side of the offset with newlines blanked, aligned so the offset sits under
-- the arrow at column 41.
local function render_error(kind, msg, text, offset)
    local len = #text
    local spaces = offset < 30 and 40 - offset or 10
    local first = offset >= 30 and offset - 30 or 0
    local last = offset + 30 > len and len or offset + 30
    local context = sub(text, first + 1, last):gsub('[\n\r]', ' ')
    return kind .. ' error: ' .. msg .. '\n' .. rep(' ', spaces) .. context .. '\n'
        .. '                     (right here) ------^\n'
end

local Parser = {}
Parser.__index = Parser

local function new_parser(sink, allow_comments, check_utf8)
    return setmetatable({
        sink = sink,
        allow_comments = allow_comments and true or false,
        check_utf8 = check_utf8 ~= false,
        states = { P_START }, -- yajl's state stack
        sp = 1,
        held = '', -- a token split across chunks
    }, Parser)
end

-- yajl_do_parse over one chunk. Returns nil, or an error message rendered
-- against `context` (the text yajl would be handed for the error report).
function Parser:feed(chunk, context)
    if self.failed then
        return render_error(self.failed_kind, self.failed, context or chunk, 0)
    end
    local base = #self.held
    local text = self.held .. chunk
    self.held = ''
    local pos = 1
    local states, sink = self.states, self.sink

    local function fail(kind, msg, offset)
        states[self.sp] = P_ERROR
        self.failed, self.failed_kind = msg, kind
        offset = offset - base
        if offset < 0 then offset = 0 end
        return render_error(kind, msg, context or chunk, offset)
    end

    while true do
        local st = states[self.sp]
        local tok, val, npos = lex(self, text, pos)
        if tok == 'eof' then
            self.held = sub(text, npos)
            return nil
        end
        if st == P_COMPLETE then
            -- yajl_allow_trailing_garbage is off: anything but whitespace is an error.
            return fail('parse', 'trailing garbage', tok == 'error' and npos or npos - 1)
        end
        if tok == 'error' then return fail('lexical', val, npos) end
        local tok_start = pos
        pos = npos

        if st == P_START or st == P_MAP_NEED_VAL or st == P_ARRAY_NEED_VAL or st == P_ARRAY_START then
            local push
            if tok == 'string' then
                sink:value(val, 'string')
            elseif tok == 'number' then
                sink:value(val, 'number')
            elseif tok == 'boolean' then
                sink:value(val, 'boolean')
            elseif tok == 'null' then
                sink:value(NULL, 'null')
            elseif tok == '{' then
                sink:open_object()
                push = P_MAP_START
            elseif tok == '[' then
                sink:open_array()
                push = P_ARRAY_START
            elseif tok == ']' and st == P_ARRAY_START then
                sink:close('array')
                self.sp = self.sp - 1
                st = nil
            else
                return fail('parse', 'unallowed token at this point in JSON text', pos - 1)
            end
            if st then
                if st == P_START then states[self.sp] = P_COMPLETE
                elseif st == P_MAP_NEED_VAL then states[self.sp] = P_MAP_GOT_VAL
                else states[self.sp] = P_ARRAY_GOT_VAL end
                if push then
                    self.sp = self.sp + 1
                    states[self.sp] = push
                end
            end
        elseif st == P_MAP_START or st == P_MAP_NEED_KEY then
            if tok == 'string' then
                sink:object_key(val)
                states[self.sp] = P_MAP_SEP
            elseif tok == '}' and st == P_MAP_START then
                sink:close('object')
                self.sp = self.sp - 1
            else
                return fail('parse', 'invalid object key (must be a string)', pos - 1)
            end
        elseif st == P_MAP_SEP then
            if tok == ':' then
                states[self.sp] = P_MAP_NEED_VAL
            else
                return fail('parse', "object key and value must be separated by a colon (':')", pos - 1)
            end
        elseif st == P_MAP_GOT_VAL then
            if tok == '}' then
                sink:close('object')
                self.sp = self.sp - 1
            elseif tok == ',' then
                states[self.sp] = P_MAP_NEED_KEY
            else
                -- yajl backs the offset up over the offending token here.
                return fail('parse', "after key and value, inside map, I expect ',' or '}'", tok_start - 1)
            end
        elseif st == P_ARRAY_GOT_VAL then
            if tok == ']' then
                sink:close('array')
                self.sp = self.sp - 1
            elseif tok == ',' then
                states[self.sp] = P_ARRAY_NEED_VAL
            else
                return fail('parse', "after array element, I expect ',' or ']'", tok_start - 1)
            end
        end
    end
end

-- yajl_complete_parse: flush a trailing number by feeding a space, then demand
-- a complete value.
function Parser:finish(context)
    local err = self:feed(' ', context or '')
    if err then return err end
    if self.states[self.sp] ~= P_COMPLETE then
        self.states[self.sp] = P_ERROR
        self.failed, self.failed_kind = 'premature EOF', 'parse'
        return render_error('parse', 'premature EOF', context or '', 1)
    end
end

-- Sink that builds the value, the way js_to_value's callbacks do — iteratively,
-- and refusing the same depth lua_checkstack refuses there.
local MAX_DECODE_DEPTH = 2665

local function value_builder()
    local tables, keys, arrays, sp = {}, {}, {}, 0
    local b = {}
    local function put(v)
        if sp == 0 then b.result = v; return end
        local k = keys[sp]
        rawset(tables[sp], k, v)
        if arrays[sp] then keys[sp] = k + 1 end
    end
    function b.value(_, v) put(v) end
    function b.object_key(_, k) keys[sp] = k end
    local function open(is_array)
        if sp >= MAX_DECODE_DEPTH then error('lua stack overflow', 0) end
        sp = sp + 1
        tables[sp] = {}
        keys[sp] = is_array and 1 or nil
        arrays[sp] = is_array
    end
    function b.open_object() open(false) end
    function b.open_array() open(true) end
    function b.close()
        local t = tables[sp]
        tables[sp], keys[sp] = nil, nil
        sp = sp - 1
        put(t)
    end
    return b
end

-- Sink that forwards to a yajl.parser events table (js_parser_* callbacks):
-- each looks the handler up afresh, and skips it if it is nil.
local function events_sink(events)
    local s = {}
    function s.value(_, v, kind)
        local f = events.value
        if f ~= nil then f(events, v, kind) end
    end
    function s.open_object()
        local f = events.open_object
        if f ~= nil then f(events) end
    end
    function s.object_key(_, k)
        local f = events.object_key
        if f ~= nil then f(events, k) end
    end
    function s.close(_, kind)
        local f = events.close
        if f ~= nil then f(events, kind) end
    end
    function s.open_array()
        local f = events.open_array
        if f ~= nil then f(events) end
    end
    return s
end

local function invalid_input(msg, line)
    error('InvalidJSONInput: ' .. msg .. ' at ' .. FILE .. ' line ' .. line, 0)
end

-- js_to_value through the Lua parser.
local function to_value_lua(s, allow_comments, check_utf8)
    local b = value_builder()
    local p = new_parser(b, allow_comments, check_utf8)
    local err = p:feed(s, s)
    if err then invalid_input(err, 345) end
    err = p:finish(s)
    if err then invalid_input(err, 353) end
    return b.result
end

-- ── Decoder ────────────────────────────────────────────────────────────────

local parse_src, parse_raw = __yajl_parse_src__, __yajl_parse__

local function check_string(v, n, fname)
    local tv = type(v)
    if tv == 'string' then return v end
    if tv == 'number' then return v .. '' end
    error(format("bad argument #%d to '%s' (string expected, got %s)", n, fname, tv == 'nil' and 'no value' or tv), 0)
end

function yajl.to_value(s, opts)
    s = check_string(s, 1, 'to_value')
    if type(opts) == 'table' then
        local allow_comments, check_utf8 = opts.allow_comments, opts.check_utf8
        -- Options JSON.parse can't honour: comments, and raw non-UTF-8 bytes
        -- (which the JS string bridge would replace).
        if (allow_comments ~= nil and allow_comments ~= false) or (check_utf8 ~= nil and not check_utf8) then
            return to_value_lua(s, allow_comments, check_utf8)
        end
    end
    -- Fast path: Lua source for the whole value, compiled by Lua's own parser.
    local src = parse_src(s)
    if src then
        if sub(src, 1, 6) ~= 'local ' then
            if sub(src, 1, 17) == 'InvalidJSONInput:' then
                -- JSON.parse refused it. Run yajl's grammar for yajl's own error
                -- text (and, should the two ever disagree, yajl's verdict).
                return to_value_lua(s)
            end
            error(src, 0)
        end
        local chunk = loadstring(src, '=yajl')
        if chunk then return chunk(NULL) end
    end
    -- Too deep for constructors, or too big to compile: build it directly.
    local v, err = parse_raw(s)
    if v == nil then
        if err and sub(err, 1, 17) == 'InvalidJSONInput:' then return to_value_lua(s) end
        error(err or 'InvalidJSONInput: could not decode', 0)
    end
    return v
end

function yajl.parser(opts)
    if type(opts) ~= 'table' then arg_error(1, 'parser', 'table', type(opts)) end
    local p = new_parser(events_sink(opts.events), opts.allow_comments, opts.check_utf8)
    return function(chunk)
        local err
        if chunk == nil then
            err = p:finish(nil)
            if err then invalid_input(err, 546) end
        else
            chunk = check_string(chunk, 1, '?')
            err = p:feed(chunk, chunk)
            if err then invalid_input(err, 557) end
        end
    end
end

-- ── Generator (yajl_gen.c, driven as lua_yajl.c drives it) ─────────────────

local G_START, G_MAP_START, G_MAP_KEY, G_MAP_VAL, G_ARRAY_START, G_IN_ARRAY, G_COMPLETE = 1, 2, 3, 4, 5, 6, 7
local MAX_GEN_DEPTH = 128 -- YAJL_MAX_DEPTH

local KEYS_MUST_BE_STRINGS = 'InvalidState: expected either a call to close() or string() since we are in the middle of an object declaration'
local MAX_DEPTH_EXCEEDED = "StackOverflow: YAJL's max generation depth was exceeded"

local function gen_error(msg, line)
    error(msg .. ' at ' .. FILE .. ' line ' .. line, 0)
end

-- yajl_string_encode: only these are escaped, control bytes as \u00XX with
-- UPPERCASE hex; '/' and DEL pass through.
local STRING_ESCAPES = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
    ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
for i = 0, 31 do
    local c = char(i)
    if not STRING_ESCAPES[c] then STRING_ESCAPES[c] = format('\\u%04X', i) end
end

local function quote(s)
    return '"' .. (s:gsub('[%z\1-\31"\\]', STRING_ESCAPES)) .. '"'
end

local Generator = {}
Generator.__index = Generator

local function emit(g, s)
    local printer = g._printer
    if printer then
        printer(s)
    else
        local n = g._n + 1
        g._n = n
        g._buf[n] = s
    end
end

-- INSERT_SEP + INSERT_WHITESPACE for the current state.
local function prefix(g)
    local st = g._state[g._depth]
    local s = ''
    if st == G_MAP_KEY or st == G_IN_ARRAY then
        s = g._beautify and ',\n' or ','
    elseif st == G_MAP_VAL then
        s = g._beautify and ': ' or ':'
    end
    if g._beautify and st ~= G_MAP_VAL then s = s .. rep(g._indent, g._depth) end
    return s
end

-- APPENDED_ATOM
local function appended(g)
    local d = g._depth
    local st = g._state[d]
    if st == G_START then g._state[d] = G_COMPLETE
    elseif st == G_MAP_START or st == G_MAP_KEY then g._state[d] = G_MAP_VAL
    elseif st == G_ARRAY_START then g._state[d] = G_IN_ARRAY
    elseif st == G_MAP_VAL then g._state[d] = G_MAP_KEY end
end

-- FINAL_NEWLINE
local function final_newline(g)
    if g._beautify and g._state[g._depth] == G_COMPLETE then return '\n' end
    return ''
end

local function ensure_not_key(g, line)
    local st = g._state[g._depth]
    if st == G_MAP_KEY or st == G_MAP_START then gen_error(KEYS_MUST_BE_STRINGS, line) end
end

-- Any atom. A value after the top-level one is complete is yajl's
-- yajl_gen_generation_complete, which lua_yajl treats as success: dropped.
local function atom(g, text, line, is_string)
    if g._state[g._depth] == G_COMPLETE then return end
    if not is_string then ensure_not_key(g, line) end
    local pre = prefix(g)
    appended(g)
    emit(g, pre .. text .. final_newline(g))
end

local function gen_open(g, bracket, state, kind, line)
    -- lua_yajl records what it opened even when yajl ignores the call.
    if g._state[g._depth] == G_COMPLETE then g._open[#g._open + 1] = kind; return end
    ensure_not_key(g, line)
    local pre = prefix(g)
    local d = g._depth + 1
    g._depth = d
    if d >= g._max_depth then
        if pre ~= '' then emit(g, pre) end
        gen_error(MAX_DEPTH_EXCEEDED, line)
    end
    g._state[d] = state
    emit(g, pre .. bracket .. (g._beautify and '\n' or ''))
    g._open[#g._open + 1] = kind
end

local function gen_close(g)
    local open = g._open
    local kind = open[#open]
    if kind == nil then
        error('StackUnderflow: Attempt to call close() when no array or object has been opened at '
            .. FILE .. ' line 744', 0)
    end
    open[#open] = nil
    if g._state[g._depth] == G_COMPLETE then return end
    g._depth = g._depth - 1
    local s = g._beautify and '\n' or ''
    appended(g)
    if g._beautify and g._state[g._depth] ~= G_MAP_VAL then s = s .. rep(g._indent, g._depth) end
    emit(g, s .. (kind == 'object' and '}' or ']') .. final_newline(g))
end

local function gen_number(g, v)
    local num = tonumber(v)
    if num == nil then arg_error(1, 'number', 'number', type(v)) end
    local text
    if num == huge then text = '1e+666'
    elseif num == -huge then text = '-1e+666'
    elseif num ~= num then text = '-0'
    else text = type(v) == 'number' and (v .. '') or v end -- the argument's own spelling
    atom(g, text, 679)
end

local function gen_string(g, v, fname)
    local tv = type(v)
    if tv == 'number' then v = v .. ''
    elseif tv ~= 'string' then arg_error(1, fname or 'string', 'string', tv) end
    atom(g, quote(v), 689, true)
end

local gen_value

-- js_generator_value
gen_value = function(g, v)
    local tv = type(v)
    if tv == 'nil' then return atom(g, 'null', 696) end
    if tv == 'number' then return gen_number(g, v) end
    if tv == 'boolean' then return atom(g, v and 'true' or 'false', 705) end
    if tv == 'string' then return atom(g, quote(v), 689, true) end
    if tv == 'userdata' and rawequal(v, NULL) then return atom(g, 'null', 696) end

    local mt = getmetatable_raw(v)
    if type(mt) == 'table' then
        local custom = rawget(mt, '__gen_json')
        if type(custom) == 'function' then
            custom(v, g)
            return
        end
    end
    if tv ~= 'table' then
        -- functions, threads, other userdata: their tostring() as a string
        return atom(g, quote(tostring(v)), 689, true)
    end

    -- An array iff every key is an integral number; the length is the largest
    -- one (stored in a C int, so keys past its range don't count), holes null.
    local max, is_array = 0, true
    for k in next, v do
        if type(k) ~= 'number' or k ~= floor(k) then is_array = false; break end
        if k > max and k < 2147483648 then max = k end
    end

    if is_array then
        gen_open(g, '[', G_ARRAY_START, 'array', 727)
        for i = 1, max do gen_value(g, v[i]) end
    else
        gen_open(g, '{', G_MAP_START, 'object', 715)
        for k, val in next, v do
            local tk = type(k)
            if tk == 'string' or tk == 'number' then gen_string(g, k)
            else gen_string(g, tostring(k)) end
            gen_value(g, val)
        end
    end
    gen_close(g)
end

function Generator:value(...)
    if select('#', ...) == 0 then
        error('MissingArgument: second parameter to js_generator_value() must be defined', 0)
    end
    gen_value(self, (...))
end

function Generator:integer(v)
    local num = tonumber(v)
    if num == nil then arg_error(1, 'integer', 'number', type(v)) end
    num = num >= 0 and floor(num) or -floor(-num) -- a C cast truncates
    if num == 0 then num = 0 end -- and has no -0
    atom(self, format('%.0f', num), 637)
end

function Generator:double(v)
    local num = tonumber(v)
    if num == nil then arg_error(1, 'double', 'number', type(v)) end
    if self._state[self._depth] == G_COMPLETE then return end
    ensure_not_key(self, 645)
    if num ~= num or num == huge or num == -huge then
        gen_error('Unreachable: yajl_gen_status (5) not recognized', 645) -- yajl_gen_invalid_number
    end
    local text = format('%.20g', num)
    if not find(text, '[^%d%-]') then text = text .. '.0' end
    atom(self, text, 645)
end

function Generator:number(v) gen_number(self, v) end
function Generator:string(v) gen_string(self, v) end
function Generator:null() atom(self, 'null', 696) end

function Generator:boolean(v)
    if type(v) ~= 'boolean' then arg_error(1, 'boolean', 'boolean', type(v)) end
    atom(self, v and 'true' or 'false', 705)
end

function Generator:open_object() gen_open(self, '{', G_MAP_START, 'object', 715) end
function Generator:open_array() gen_open(self, '[', G_ARRAY_START, 'array', 727) end
function Generator:close() gen_close(self) end

-- yajl_gen_config(yajl_gen_indent_string) accepts whitespace only; anything
-- else leaves yajl with no indent string at all (and desktop crashing on the
-- first indented line), so it is treated as an empty indent here.
local function indent_string(v)
    local s = (type(v) == 'string' or type(v) == 'number') and (v .. '') or ''
    if find(s, '[^ \t\n\r\v\f]') then return '' end
    return s
end

local function new_generator(opts)
    if type(opts) ~= 'table' then arg_error(1, 'generator', 'table', type(opts)) end
    local printer = opts.printer
    if printer ~= nil and type(printer) ~= 'function' then
        arg_error(-1, 'generator', 'function', type(printer))
    end
    local indent = opts.indent
    return setmetatable({
        _printer = printer,
        _buf = {},
        _n = 0,
        _depth = 0,
        _state = { [0] = G_START },
        _open = {},
        _beautify = indent ~= nil,
        _indent = indent ~= nil and indent_string(indent) or '    ',
        _max_depth = MAX_GEN_DEPTH,
    }, Generator)
end
yajl.generator = new_generator

-- js_to_string: a generator over the options with any printer removed (from
-- the caller's own table, as lua_yajl does), fed the value, buffer returned.
function yajl.to_string(v, opts)
    if type(opts) == 'table' then
        rawset(opts, 'printer', nil)
    else
        opts = {}
    end
    local g = new_generator(opts)
    gen_value(g, v)
    return concat(g._buf, '', 1, g._n)
end

-- Mudlet Web's own JSON hand-offs to JS (the Variables view and the saved-
-- variables snapshot) describe user data of any depth, wrapping each level in
-- a descriptor. yajl's 128-level limit is parity for scripts, not something
-- those snapshots should trip over, so they encode without it.
function __mudlet_json_encode(v)
    local g = new_generator({})
    g._max_depth = huge
    gen_value(g, v)
    return concat(g._buf, '', 1, g._n)
end
