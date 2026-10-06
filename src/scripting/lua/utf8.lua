-- https://github.com/Stepets/utf8.lua
-- $Id: utf8.lua 179 2009-04-03 18:10:03Z pasta $
--
-- Provides UTF-8 aware string functions implemented in pure lua:
-- * utf8len(s)
-- * utf8sub(s, i, j)
-- * utf8reverse(s)
-- * utf8char(unicode)
-- * utf8unicode(s, i, j)
-- * utf8gensub(s, sub_len)
--
-- (mudlet: its pattern functions are gone — find/match/gmatch/gsub are
-- luautf8's own, ported at the end of this file.)
--
-- If utf8data.lua (containing the lower<->upper case mappings) is loaded, these
-- additional functions are available:
-- * utf8upper(s)
-- * utf8lower(s)
--
-- All functions behave as their non UTF-8 aware counterparts with the exception
-- that UTF-8 characters are used instead of bytes for all units.

--[[
Copyright (c) 2006-2007, Kyle Smith
All rights reserved.

Contributors:
Alimov Stepan

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.
* Neither the name of the author nor the names of its contributors may be
used to endorse or promote products derived from this software without
specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
--]]

-- ABNF from RFC 3629
--
-- UTF8-octets = *( UTF8-char )
-- UTF8-char   = UTF8-1 / UTF8-2 / UTF8-3 / UTF8-4
-- UTF8-1      = %x00-7F
-- UTF8-2      = %xC2-DF UTF8-tail
-- UTF8-3      = %xE0 %xA0-BF UTF8-tail / %xE1-EC 2( UTF8-tail ) /
--               %xED %x80-9F UTF8-tail / %xEE-EF 2( UTF8-tail )
-- UTF8-4      = %xF0 %x90-BF 2( UTF8-tail ) / %xF1-F3 3( UTF8-tail ) /
--               %xF4 %x80-8F 2( UTF8-tail )
-- UTF8-tail   = %x80-BF
--

local byte    = string.byte
local char    = string.char
local dump    = string.dump
local find    = string.find
local format  = string.format
local len     = string.len
local lower   = string.lower
local rep     = string.rep
local sub     = string.sub
local upper   = string.upper

-- returns the number of bytes used by the UTF-8 character at byte i in s
-- also doubles as a UTF-8 character validator
local function utf8charbytes (s, i)
	-- argument defaults
	i = i or 1

	-- argument checking
	if type(s) ~= "string" then
		error("bad argument #1 to 'utf8charbytes' (string expected, got ".. type(s).. ")")
	end
	if type(i) ~= "number" then
		error("bad argument #2 to 'utf8charbytes' (number expected, got ".. type(i).. ")")
	end

	local c = byte(s, i)

	-- determine bytes needed for character, based on RFC 3629
	-- validate byte 1
	if c >= 0 and c <= 127 then
		-- UTF8-1
		return 1

	elseif c >= 194 and c <= 223 then
		-- UTF8-2
		local c2 = byte(s, i + 1)

		if not c2 then
			error("UTF-8 string terminated early")
		end

		-- validate byte 2
		if c2 < 128 or c2 > 191 then
			error("Invalid UTF-8 character")
		end

		return 2

	elseif c >= 224 and c <= 239 then
		-- UTF8-3
		local c2 = byte(s, i + 1)
		local c3 = byte(s, i + 2)

		if not c2 or not c3 then
			error("UTF-8 string terminated early")
		end

		-- validate byte 2
		if c == 224 and (c2 < 160 or c2 > 191) then
			error("Invalid UTF-8 character")
		elseif c == 237 and (c2 < 128 or c2 > 159) then
			error("Invalid UTF-8 character")
		elseif c2 < 128 or c2 > 191 then
			error("Invalid UTF-8 character")
		end

		-- validate byte 3
		if c3 < 128 or c3 > 191 then
			error("Invalid UTF-8 character")
		end

		return 3

	elseif c >= 240 and c <= 244 then
		-- UTF8-4
		local c2 = byte(s, i + 1)
		local c3 = byte(s, i + 2)
		local c4 = byte(s, i + 3)

		if not c2 or not c3 or not c4 then
			error("UTF-8 string terminated early")
		end

		-- validate byte 2
		if c == 240 and (c2 < 144 or c2 > 191) then
			error("Invalid UTF-8 character")
		elseif c == 244 and (c2 < 128 or c2 > 143) then
			error("Invalid UTF-8 character")
		elseif c2 < 128 or c2 > 191 then
			error("Invalid UTF-8 character")
		end

		-- validate byte 3
		if c3 < 128 or c3 > 191 then
			error("Invalid UTF-8 character")
		end

		-- validate byte 4
		if c4 < 128 or c4 > 191 then
			error("Invalid UTF-8 character")
		end

		return 4

	else
		error("Invalid UTF-8 character")
	end
end

-- returns the number of characters in a UTF-8 string
local function utf8len (s)
	-- argument checking
	if type(s) ~= "string" then
		for k,v in pairs(s) do print('"',tostring(k),'"',tostring(v),'"') end
		error("bad argument #1 to 'utf8len' (string expected, got ".. type(s).. ")")
	end

	local pos = 1
	local bytes = len(s)
	local length = 0

	while pos <= bytes do
		length = length + 1
		pos = pos + utf8charbytes(s, pos)
	end

	return length
end

-- functions identically to string.sub except that i and j are UTF-8 characters
-- instead of bytes
local function utf8sub (s, i, j)
	-- argument defaults
	j = j or -1

	local pos = 1
	local bytes = len(s)
	local length = 0

	-- only set l if i or j is negative
	local l = (i >= 0 and j >= 0) or utf8len(s)
	local startChar = (i >= 0) and i or l + i + 1
	local endChar   = (j >= 0) and j or l + j + 1

	-- can't have start before end!
	if startChar > endChar then
		return ""
	end

	-- byte offsets to pass to string.sub
	local startByte,endByte = 1,bytes

	while pos <= bytes do
		length = length + 1

		if length == startChar then
			startByte = pos
		end

		pos = pos + utf8charbytes(s, pos)

		if length == endChar then
			endByte = pos - 1
			break
		end
	end

	if startChar > length then startByte = bytes+1   end
	if endChar   < 1      then endByte   = 0         end

	return sub(s, startByte, endByte)
end

--[[
-- replace UTF-8 characters based on a mapping table
local function utf8replace (s, mapping)
	-- argument checking
	if type(s) ~= "string" then
		error("bad argument #1 to 'utf8replace' (string expected, got ".. type(s).. ")")
	end
	if type(mapping) ~= "table" then
		error("bad argument #2 to 'utf8replace' (table expected, got ".. type(mapping).. ")")
	end

	local pos = 1
	local bytes = len(s)
	local charbytes
	local newstr = ""

	while pos <= bytes do
		charbytes = utf8charbytes(s, pos)
		local c = sub(s, pos, pos + charbytes - 1)

		newstr = newstr .. (mapping[c] or c)

		pos = pos + charbytes
	end

	return newstr
end

-- identical to string.upper except it knows about unicode simple case conversions
local function utf8upper (s)
	return utf8replace(s, utf8_lc_uc)
end

-- identical to string.lower except it knows about unicode simple case conversions
local function utf8lower (s)
	return utf8replace(s, utf8_uc_lc)
end
]]

-- identical to string.reverse except that it supports UTF-8
local function utf8reverse (s)
	-- argument checking
	if type(s) ~= "string" then
		error("bad argument #1 to 'utf8reverse' (string expected, got ".. type(s).. ")")
	end

	local bytes = len(s)
	local pos = bytes
	local charbytes
	local newstr = ""

	while pos > 0 do
		local c = byte(s, pos)
		while c >= 128 and c <= 191 do
			pos = pos - 1
			c = byte(s, pos)
		end

		charbytes = utf8charbytes(s, pos)

		newstr = newstr .. sub(s, pos, pos + charbytes - 1)

		pos = pos - 1
	end

	return newstr
end

-- http://en.wikipedia.org/wiki/Utf8
-- http://developer.coronalabs.com/code/utf-8-conversion-utility
local function utf8char(unicode)
	if unicode <= 0x7F then return char(unicode) end

	if (unicode <= 0x7FF) then
		local Byte0 = 0xC0 + math.floor(unicode / 0x40);
		local Byte1 = 0x80 + (unicode % 0x40);
		return char(Byte0, Byte1);
	end;

	if (unicode <= 0xFFFF) then
		local Byte0 = 0xE0 +  math.floor(unicode / 0x1000);
		local Byte1 = 0x80 + (math.floor(unicode / 0x40) % 0x40);
		local Byte2 = 0x80 + (unicode % 0x40);
		return char(Byte0, Byte1, Byte2);
	end;

	if (unicode <= 0x10FFFF) then
		local code = unicode
		local Byte3= 0x80 + (code % 0x40);
		code       = math.floor(code / 0x40)
		local Byte2= 0x80 + (code % 0x40);
		code       = math.floor(code / 0x40)
		local Byte1= 0x80 + (code % 0x40);
		code       = math.floor(code / 0x40)
		local Byte0= 0xF0 + code;

		return char(Byte0, Byte1, Byte2, Byte3);
	end;

	error 'Unicode cannot be greater than U+10FFFF!'
end

local shift_6  = 2^6
local shift_12 = 2^12
local shift_18 = 2^18

local utf8unicode
utf8unicode = function(str, i, j, byte_pos)
	i = i or 1
	j = j or i

	if i > j then return end

	local ch,bytes

	if byte_pos then
		bytes = utf8charbytes(str,byte_pos)
		ch  = sub(str,byte_pos,byte_pos-1+bytes)
	else
		ch,byte_pos = utf8sub(str,i,i), 0
		bytes       = #ch
	end

	local unicode

	if bytes == 1 then unicode = byte(ch) end
	if bytes == 2 then
		local byte0,byte1 = byte(ch,1,2)
		local code0,code1 = byte0-0xC0,byte1-0x80
		unicode = code0*shift_6 + code1
	end
	if bytes == 3 then
		local byte0,byte1,byte2 = byte(ch,1,3)
		local code0,code1,code2 = byte0-0xE0,byte1-0x80,byte2-0x80
		unicode = code0*shift_12 + code1*shift_6 + code2
	end
	if bytes == 4 then
		local byte0,byte1,byte2,byte3 = byte(ch,1,4)
		local code0,code1,code2,code3 = byte0-0xF0,byte1-0x80,byte2-0x80,byte3-0x80
		unicode = code0*shift_18 + code1*shift_12 + code2*shift_6 + code3
	end

	return unicode,utf8unicode(str, i+1, j, byte_pos+bytes)
end

-- Returns an iterator which returns the next substring and its byte interval
local function utf8gensub(str, sub_len)
	sub_len        = sub_len or 1
	local byte_pos = 1
	local length   = #str
	return function(skip)
		if skip then byte_pos = byte_pos + skip end
		local char_count = 0
		local start      = byte_pos
		repeat
			if byte_pos > length then return end
			char_count  = char_count + 1
			local bytes = utf8charbytes(str,byte_pos)
			byte_pos    = byte_pos+bytes

		until char_count == sub_len

		local last  = byte_pos-1
		local slice = sub(str,start,last)
		return slice, start, last
	end
end

-- EXPORT

local M = {}

function M.reverse(s)
	return utf8reverse(s)
end
function M.char(...)
	local n = select('#', ...)
	if n == 1 then return utf8char((...)) end
	local out = {}
	for k = 1, n do out[k] = utf8char((select(k, ...))) end
	return table.concat(out)
end
function M.unicode(s, i, j)
	return utf8unicode(s, i, j)
end
function M.gensub(s, sub_len)
	return utf8gensub(s, sub_len)
end
function M.dump(s)
	return dump(s)
end
function M.format(s)
	return format(s)
end
-- Unicode simple case mapping, as luautf8 does it. The tables are built on
-- first use from __mudlet_utf8_casemap (LuaRuntime), which lists every
-- non-ASCII character whose mapping is a single other character as
-- "u<TAB>from<TAB>to<LF>" / "l<TAB>...". ASCII goes through string.upper/lower;
-- anything unmapped, invalid bytes included, is left as it was.
local caseMaps
local function getCaseMaps()
	if caseMaps then return caseMaps end
	local up, low, titleOnly = {}, {}, {}
	local src = type(__mudlet_utf8_casemap) == 'function' and __mudlet_utf8_casemap() or ''
	for kind, from, to in src:gmatch('([ult])\t([^\t]+)\t([^\n]+)\n') do
		if kind == 'u' then up[from] = to
		elseif kind == 'l' then low[from] = to
		else titleOnly[from] = to end
	end
	-- Titlecase is the uppercase except where UnicodeData says otherwise
	-- (the "t" lines: the Dž-style digraphs, and Georgian, which titles as
	-- itself).
	local title = {}
	for k, v in pairs(up) do title[k] = v end
	for k, v in pairs(titleOnly) do title[k] = v end
	caseMaps = { up = up, low = low, title = title }
	return caseMaps
end
local MULTIBYTE = '[\194-\244][\128-\191]*'
-- luautf8's converters also take a codepoint and hand one back.
local function convertCode(cp, map, ascii)
	if cp < 0x80 then return byte(ascii(char(cp))) end
	local ok, ch = pcall(utf8char, cp)
	if not ok then return cp end
	local to = map[ch]
	if to == nil then return cp end
	return utf8unicode(to, 1, 1)
end
function M.lower(s)
	if type(s) == 'number' then return convertCode(s, getCaseMaps().low, lower) end
	s = lower(s)
	return (s:gsub(MULTIBYTE, getCaseMaps().low))
end
function M.upper(s)
	if type(s) == 'number' then return convertCode(s, getCaseMaps().up, upper) end
	s = upper(s)
	return (s:gsub(MULTIBYTE, getCaseMaps().up))
end
-- utf8.title(s): every character to its titlecase — character by character,
-- as luautf8 does it, not word-initial capitalisation: title("élan") is "ÉLAN".
function M.title(s)
	if type(s) == 'number' then return convertCode(s, getCaseMaps().title, upper) end
	s = upper(s)
	return (s:gsub(MULTIBYTE, getCaseMaps().title))
end

-- luautf8's / Lua 5.3's pattern matching exactly one UTF-8 sequence. Lua 5.1
-- patterns can't hold a literal NUL, hence %z.
M.charpattern = '[%z\1-\127\194-\244][\128-\191]*'

-- utf8.codepoint(s [, i [, j]]): the codepoints of every character starting
-- between byte positions i and j (default i = 1, j = i).
function M.codepoint(s, i, j)
	local bytes = len(s)
	i = i or 1
	if i < 0 then i = bytes + i + 1 end
	j = j or i
	if j < 0 then j = bytes + j + 1 end
	if i < 1 then error("bad argument #2 to 'codepoint' (out of bounds)", 2) end
	if j > bytes then error("bad argument #3 to 'codepoint' (out of bounds)", 2) end
	local out, pos = {}, i
	while pos <= j do
		local ok, size = pcall(utf8charbytes, s, pos)
		if not ok then error("invalid UTF-8 code", 2) end
		out[#out + 1] = utf8unicode(s, 1, 1, pos)
		pos = pos + size
	end
	return unpack(out)
end

function M.rep()
	return rep(s)
end

-- ─────────────────────────────────────────────────────────────────────────────
-- luautf8 (starwing) extensions. Mudlet ships luautf8, so scripts and packages
-- expect these on top of the Stepets base above. Implemented in pure Lua over
-- the helpers already defined in this file (utf8charbytes / utf8len / utf8sub /
-- utf8unicode / utf8char). Signatures follow the luautf8 documentation.
--
-- Limitations vs the C library (documented so callers know what to expect):
--   • Display width (width / widthindex) ports Markus Kuhn's wcwidth ranges
--     (zero-width combining marks → 0, East-Asian wide/fullwidth → 2, else 1).
--     The East-Asian "ambiguous" class isn't tabulated, so `ambi_is_double` is
--     accepted but treated as width 1.
-- ─────────────────────────────────────────────────────────────────────────────

local concat = table.concat
local mfloor = math.floor

-- wcwidth tables (Markus Kuhn). Sorted, non-overlapping; binary-searched.
local zero_ranges = {
	{0x0300, 0x036F}, {0x0483, 0x0489}, {0x0591, 0x05BD}, {0x0610, 0x061A},
	{0x064B, 0x065F}, {0x0670, 0x0670}, {0x06D6, 0x06DC}, {0x0E31, 0x0E31},
	{0x0E34, 0x0E3A}, {0x0EB1, 0x0EB1}, {0x1AB0, 0x1AFF}, {0x1DC0, 0x1DFF},
	{0x200B, 0x200F}, {0x202A, 0x202E}, {0x2060, 0x2063}, {0x20D0, 0x20FF},
	{0xFE00, 0xFE0F}, {0xFE20, 0xFE2F}, {0xFEFF, 0xFEFF},
}
local wide_ranges = {
	{0x1100, 0x115F}, {0x2329, 0x232A}, {0x2E80, 0x303E}, {0x3041, 0x33FF},
	{0x3400, 0x4DBF}, {0x4E00, 0x9FFF}, {0xA000, 0xA4CF}, {0xAC00, 0xD7A3},
	{0xF900, 0xFAFF}, {0xFE10, 0xFE19}, {0xFE30, 0xFE6F}, {0xFF00, 0xFF60},
	{0xFFE0, 0xFFE6}, {0x20000, 0x2FFFD}, {0x30000, 0x3FFFD},
}

local function inRanges(cp, ranges)
	local lo, hi = 1, #ranges
	while lo <= hi do
		local mid = mfloor((lo + hi) / 2)
		local r = ranges[mid]
		if cp < r[1] then hi = mid - 1
		elseif cp > r[2] then lo = mid + 1
		else return true end
	end
	return false
end

local function codeWidth(cp, default)
	if cp == 0 then return 0 end
	if cp < 32 or (cp >= 0x7F and cp < 0xA0) then return default end
	if inRanges(cp, zero_ranges) then return 0 end
	if inRanges(cp, wide_ranges) then return 2 end
	return 1
end

-- utf8.width(s [, ambi_is_double [, default_width]]): display width in columns.
-- A number is treated as a single codepoint. `ambi_is_double` is accepted for
-- compatibility (see header). `default_width` is used for unprintable chars
-- (default 1).
function M.width(s, _ambi, default)
	default = default or 1
	if type(s) == 'number' then return codeWidth(s, default) end
	local w, pos, nbytes = 0, 1, len(s)
	while pos <= nbytes do
		w = w + codeWidth(utf8unicode(s, 1, 1, pos), default)
		pos = pos + utf8charbytes(s, pos)
	end
	return w
end

-- ─────────────────────────────────────────────────────────────────────────────
-- The rest of luautf8 0.2.1 (starwing/luautf8, lutf8lib.c) — the version the
-- luautf8 rock desktop links is at. Ported from the C, argument checks and
-- edge cases included; the Unicode tables NFC and grapheme clusters need come
-- from the JS engine (LuaRuntime.installUtf8Natives).
-- ─────────────────────────────────────────────────────────────────────────────

M.version = "0.2.1"

local function argError(n, fname, msg)
	error("bad argument #" .. n .. " to '" .. fname .. "' (" .. msg .. ")")
end

local function checkString(v, n, fname)
	local t = type(v)
	if t == 'string' then return v end
	if t == 'number' then return tostring(v) end
	argError(n, fname, "string expected, got " .. (v == nil and 'no value' or t))
end

local function optInteger(v, n, fname, default)
	if v == nil then return default end
	local x = tonumber(v)
	if x == nil then argError(n, fname, "number expected, got " .. type(v)) end
	return x >= 0 and mfloor(x) or -mfloor(-x)
end

-- byte_relat: a negative byte position counts back from the end.
local function byteRelat(pos, slen)
	if pos >= 0 then return pos end
	if -pos > slen then return 0 end
	return slen + pos + 1
end

local function isCont(c) return c ~= nil and c >= 0x80 and c <= 0xBF end

-- utf8_decode: the codepoint at byte i and the position after it, or nil for
-- an invalid sequence. Lax by default (up to 0x7FFFFFFF, surrogates allowed);
-- strict rejects surrogates and anything past U+10FFFF. Past the end the C
-- reads the string's terminating NUL, hence the `or 0`.
local DECODE_LIMITS = { [0] = math.huge, 0x80, 0x800, 0x10000, 0x200000, 0x4000000 }
local function luDecode(s, i, strict)
	local c = byte(s, i) or 0
	if c < 0x80 then return c, i + 1 end
	local res, count = 0, 0
	while mfloor(c / 0x40) % 2 == 1 do
		count = count + 1
		local cc = byte(s, i + count) or 0
		if not isCont(cc) then return nil end
		res = res * 64 + cc % 64
		c = c * 2
	end
	res = res + (c % 0x80) * 2 ^ (count * 5)
	if count > 5 or res > 0x7FFFFFFF or res < DECODE_LIMITS[count] then return nil end
	if strict and (res > 0x10FFFF or (res >= 0xD800 and res <= 0xDFFF)) then return nil end
	return res, i + count + 1
end

local function safeDecode(s, i)
	local code, nxt = luDecode(s, i, false)
	if code == nil then error("invalid UTF-8 code") end
	return code, nxt
end

-- utf8_next / utf8_prev over 1-based positions; slen + 1 is the end.
local function nextPos(s, p, slen)
	while p <= slen and isCont(byte(s, p + 1)) do p = p + 1 end
	if p <= slen then return p + 1 end
	return slen + 1
end
local function prevPos(s, first, e)
	while first < e and isCont(byte(s, e - 1)) do e = e - 1 end
	if first < e then return e - 1 end
	return first
end

-- utf8.codes(s [, lax]): for pos, code in utf8.codes(s). Strict unless `lax`
-- is true, raising on a surrogate or a codepoint past U+10FFFF.
local function codesIterator(strict)
	return function(s, n)
		local slen = len(s)
		local p = (n or 0) <= 0 and 1 or nextPos(s, n, slen)
		if p > slen then return nil end
		local code = safeDecode(s, p)
		if strict and (code > 0x10FFFF or (code >= 0xD800 and code <= 0xDFFF)) then
			error("invalid UTF-8 code")
		end
		return p, code
	end
end
local codesStrict, codesLax = codesIterator(true), codesIterator(false)
function M.codes(s, lax)
	s = checkString(s, 1, 'codes')
	return lax and codesLax or codesStrict, s, 0
end

-- utf8_invalid_offset: the 1-based position of the first byte of the first
-- invalid sequence at or after `p`, or nil when the rest is valid UTF-8.
local CODE_UNIT_LEN = { 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, 2, 2, 3, 4 }
local function invalidOffset(s, p, slen)
	while p <= slen do
		local c = byte(s, p)
		if c >= 0x80 then
			if c < 0xC2 or c >= 0xF5 then return p end
			local need = CODE_UNIT_LEN[mfloor(c / 16) + 1]
			if slen - p + 1 < need then return p end
			local c2 = byte(s, p + 1)
			if not isCont(c2) then return p end
			if need >= 3 then
				local c3 = byte(s, p + 2)
				if not isCont(c3) then return p end
				if need == 3 then
					if c == 0xE0 and c2 < 0xA0 then return p end
					if c == 0xED and c2 >= 0xA0 then return p end
				else
					local c4 = byte(s, p + 3)
					if not isCont(c4) then return p end
					if c == 0xF0 and c2 < 0x90 then return p end
					if c == 0xF4 and c2 >= 0x90 then return p end
				end
			end
			p = p + need
		else
			p = p + 1
		end
	end
	return nil
end

function M.isvalid(s)
	s = checkString(s, 1, 'isvalid')
	return invalidOffset(s, 1, len(s)) == nil
end

-- utf8.invalidoffset(s [, i]): where the first invalid sequence at or after
-- byte i starts, or nil.
function M.invalidoffset(s, i)
	s = checkString(s, 1, 'invalidoffset')
	local slen = len(s)
	local offset = optInteger(i, 2, 'invalidoffset', 0)
	local start = 1
	if offset > 1 then
		start = offset
		if start > slen then return nil end
	elseif offset < 0 and -slen < offset then
		start = slen + offset + 1
	end
	return invalidOffset(s, start, slen)
end

-- utf8.clean(s [, replacement]): each run of invalid bytes replaced (by
-- U+FFFD unless given), and whether the string was clean already.
function M.clean(s, ...)
	s = checkString(s, 1, 'clean')
	local r = ...
	if r == nil then r = "\239\191\189" else r = checkString(r, 2, 'clean') end
	if select('#', ...) > 0 and invalidOffset(r, 1, len(r)) ~= nil then
		error("replacement string must be valid UTF-8", 0)
	end
	local slen = len(s)
	local bad = invalidOffset(s, 1, slen)
	if bad == nil then return s, true end
	local out, p = {}, 1
	while true do
		out[#out + 1] = sub(s, p, bad - 1)
		out[#out + 1] = r
		p = bad
		while p == bad do
			p = p + 1
			bad = invalidOffset(s, p, slen)
		end
		if bad == nil then
			out[#out + 1] = sub(s, p)
			return concat(out), false
		end
	end
end

-- NFC needs the Unicode composition tables; the JS engine has them.
local function nfcOf(s, fname)
	local slen, p = len(s), 1
	while p <= slen do
		local _, nxt = luDecode(s, p, true)
		if nxt == nil then argError(1, fname, "string is not valid UTF-8") end
		p = nxt
	end
	local native = __mudlet_utf8_nfc
	if type(native) ~= 'function' then return s end
	return __mudlet_unarmor(native(__mudlet_armor(s)))
end

function M.isnfc(s)
	s = checkString(s, 1, 'isnfc')
	return nfcOf(s, 'isnfc') == s
end

-- utf8.normalize_nfc(s): the NFC form, and whether s was in it already.
function M.normalize_nfc(s)
	s = checkString(s, 1, 'normalize_nfc')
	local nfc = nfcOf(s, 'normalize_nfc')
	if nfc == s then return s, true end
	return nfc, false
end

-- utf8.widthlimit(s, width [, i [, j [, ambi_is_double [, default_width]]]]):
-- how far into s (bytes i..j) `width` columns reach. A negative width counts
-- from the end. Returns the byte position and the width left over. The
-- argument numbers in its range errors are luautf8's own.
function M.widthlimit(s, width, i, j, ambi, default)
	s = checkString(s, 1, 'widthlimit')
	local slen = len(s)
	if width == nil then argError(2, 'widthlimit', "number expected, got no value") end
	width = optInteger(width, 2, 'widthlimit', 0)
	local posi = byteRelat(optInteger(i, 3, 'widthlimit', 1), slen)
	local posj = byteRelat(optInteger(j, 4, 'widthlimit', slen), slen)
	optInteger(ambi, 5, 'widthlimit', 1)
	local defaultWidth = optInteger(default, 6, 'widthlimit', 0)
	if not (posi >= 1 and posi - 1 <= slen) then argError(2, 'widthlimit', "initial position out of bounds") end
	if not (posj - 1 < slen) then argError(3, 'widthlimit', "final position out of bounds") end
	-- 1-based: [first, last] is the byte range, last + 1 its end.
	local first, stop = posi, posj + 1
	if width >= 0 then
		while first < stop and width ~= 0 do
			local code, nxt = safeDecode(s, first)
			local w = codeWidth(code, defaultWidth)
			if width < w then break end
			first, width = nxt, width - w
		end
		return first - 1, width
	end
	while first < stop and width ~= 0 do
		local p = prevPos(s, first, stop)
		local code = safeDecode(s, p)
		local w = codeWidth(code, defaultWidth)
		if -width < w then break end
		stop, width = p, width + w
	end
	return stop, width
end

-- utf8.grapheme_indices(s [, i [, j]]): for first, last in ... — the byte
-- span of each extended grapheme cluster in bytes i..j. Clusters come from the
-- engine's Intl.Segmenter (UAX #29); a string that only decodes laxly (a
-- surrogate, a five-byte form) is split per codepoint.
function M.grapheme_indices(s, i, j)
	s = checkString(s, 1, 'grapheme_indices')
	local slen = len(s)
	local start = byteRelat(optInteger(i, 2, 'grapheme_indices', 1), slen)
	local stop = byteRelat(optInteger(j, 3, 'grapheme_indices', slen), slen)
	if start < 1 then argError(2, 'grapheme_indices', "out of range") end
	if stop > slen then argError(3, 'grapheme_indices', "out of range") end
	local spans, k, at
	return function()
		if spans == nil then
			spans, at = {}, 0
			if start <= stop then
				local text = sub(s, start, stop)
				local native = __mudlet_utf8_graphemes
				if invalidOffset(text, 1, #text) == nil and type(native) == 'function' then
					for n in native(__mudlet_armor(text)):gmatch('%d+') do spans[#spans + 1] = tonumber(n) end
				else
					local p = 1
					while p <= #text do
						local _, nxt = safeDecode(text, p)
						spans[#spans + 1] = nxt - p
						p = nxt
					end
				end
			end
			k = start
		end
		at = at + 1
		local n = spans[at]
		if n == nil then return nil end
		local first = k
		k = k + n
		return first, k - 1
	end
end

-- ─────────────────────────────────────────────────────────────────────────────
-- luautf8 0.2.1's positions, case folding and pattern matching, ported from
-- lutf8lib.c. Positions are 1-based bytes, slen + 1 the end of the string. As
-- in the C, walking from character to character (utf8_next / utf8_prev) only
-- skips continuation bytes, so invalid bytes are characters of their own;
-- only the functions that decode a character raise on one.
-- ─────────────────────────────────────────────────────────────────────────────

-- utf8_encode: up to 0x7FFFFFFF, in the 5- and 6-byte forms past U+1FFFFF.
local function encode(x)
	if x < 0x80 then return char(x) end
	local bytes, mfb = {}, 0x3F
	repeat
		table.insert(bytes, 1, 0x80 + x % 64)
		x = mfloor(x / 64)
		mfb = mfloor(mfb / 2)
	until x <= mfb
	table.insert(bytes, 1, (0xFF - 2 * mfb - 1) % 256 + x)
	return char(unpack(bytes))
end

-- utf8_offset: from byte position `offset`, idx characters on (or back); the
-- position reached, or nil when the string runs out first.
local function uOffset(s, slen, offset, idx)
	local p = offset
	if idx >= 0 then
		while p <= slen and idx > 0 do p, idx = nextPos(s, p, slen), idx - 1 end
	else
		while 1 < p and idx < 0 do p, idx = prevPos(s, 1, p), idx + 1 end
	end
	if idx == 0 then return p end
	return nil
end

-- utf8_relat: where character idx starts (negative from the end).
local function uRelat(s, slen, idx)
	if idx >= 0 then return uOffset(s, slen, 1, idx - 1) end
	return uOffset(s, slen, slen + 1, idx)
end

-- utf8_range: characters i..j as the 0-based byte span [i, j), and whether
-- it is not empty.
local function uRange(s, slen, i, j)
	local ps, pe = uRelat(s, slen, i), uRelat(s, slen, j)
	i = ps and ps - 1 or (i > 0 and slen or 0)
	j = pe and nextPos(s, pe, slen) - 1 or (j > 0 and slen or 0)
	return i, j, i < j
end

local function checkInteger(v, n, fname)
	if v == nil then argError(n, fname, "number expected, got no value") end
	return optInteger(v, n, fname, 0)
end

-- utf8.len(s [, i [, j [, lax]]]): characters starting between bytes i and j;
-- strictly, nil and the position of the first invalid one.
function M.len(s, i, j, lax)
	s = checkString(s, 1, 'len')
	local slen = len(s)
	local posi = byteRelat(optInteger(i, 2, 'len', 1), slen)
	local posj = byteRelat(optInteger(j, 3, 'len', slen), slen)
	if not (posi >= 1 and posi - 1 <= slen) then argError(2, 'len', "initial position out of bounds") end
	if not (posj - 1 < slen) then argError(3, 'len', "final position out of bounds") end
	local p, e, n = posi, posj + 1, 0
	while p < e do
		if lax then
			p = nextPos(s, p, e - 1)
		else
			local code, nxt = luDecode(s, p, true)
			if code == nil then return nil, p end
			p = nxt
		end
		n = n + 1
	end
	return n
end

-- utf8.sub(s, i [, j]): characters i..j.
function M.sub(s, i, j)
	s = checkString(s, 1, 'sub')
	local slen = len(s)
	local a, b, ok = uRange(s, slen, checkInteger(i, 2, 'sub'), optInteger(j, 3, 'sub', -1))
	if ok then return sub(s, a + 1, b) end
	return ""
end

-- utf8.byte(s [, i [, j]]): the codepoints of characters i..j.
function M.byte(s, i, j)
	s = checkString(s, 1, 'byte')
	local slen = len(s)
	local posi = optInteger(i, 2, 'byte', 1)
	local a, b, ok = uRange(s, slen, posi, optInteger(j, 3, 'byte', posi))
	if not ok then return end
	local out, p = {}, a + 1
	while p <= b do
		local code
		code, p = safeDecode(s, p)
		out[#out + 1] = code
	end
	return unpack(out)
end

-- utf8.offset(s, n [, i]): Lua 5.3's, with luautf8's second value — where
-- the character ends.
function M.offset(s, n, i)
	s = checkString(s, 1, 'offset')
	local slen = len(s)
	n = checkInteger(n, 2, 'offset')
	local posi = byteRelat(optInteger(i, 3, 'offset', n >= 0 and 1 or slen + 1), slen)
	if not (posi >= 1 and posi - 1 <= slen) then argError(3, 'offset', "position out of range") end
	posi = posi - 1 -- 0-based from here, as in the C
	local function cont(at) return isCont(byte(s, at + 1)) end
	if n == 0 then
		while posi > 0 and cont(posi) do posi = posi - 1 end
	else
		if cont(posi) then error("initial position is a continuation byte") end
		if n < 0 then
			while n < 0 and posi > 0 do
				repeat posi = posi - 1 until not (posi > 0 and cont(posi))
				n = n + 1
			end
		else
			n = n - 1
			while n > 0 and posi < slen do
				repeat posi = posi + 1 until not cont(posi)
				n = n - 1
			end
		end
	end
	if n ~= 0 then return nil end
	local first = posi + 1
	if (byte(s, posi + 1) or 0) >= 0x80 then
		repeat posi = posi + 1 until not cont(posi + 1)
	end
	return first, posi + 1
end

-- push_offset: the character idx on from byte `offset` (idx 0: the one
-- holding that byte), as its position and codepoint.
local function pushOffset(s, slen, offset, idx)
	local p
	if idx ~= 0 then
		p = uOffset(s, slen, offset, idx)
	else
		p = offset
		if isCont(byte(s, p)) then p = prevPos(s, 1, p) end
	end
	if p == nil or p == slen + 1 then return end
	return p, luDecode(s, p, false) or 0
end

-- utf8.charpos(s [[, i,] n]): with one number it counts characters from the
-- start (negative from the end); with two, n characters on from byte i.
function M.charpos(s, i, n)
	s = checkString(s, 1, 'charpos')
	local slen = len(s)
	if n == nil then
		local idx, offset = optInteger(i, 2, 'charpos', 0), 1
		if idx > 0 then idx = idx - 1 elseif idx < 0 then offset = slen + 1 end
		return pushOffset(s, slen, offset, idx)
	end
	local offset = byteRelat(optInteger(i, 2, 'charpos', 1), slen)
	if offset < 1 then offset = 1 end
	return pushOffset(s, slen, offset, checkInteger(n, 3, 'charpos'))
end

-- utf8.next(s [, i [, n]]): the character n on from byte i (default: the
-- first one), so `for p, c in utf8.next, s do` walks the string.
function M.next(s, i, n)
	s = checkString(s, 1, 'next')
	local slen = len(s)
	local offset = byteRelat(optInteger(i, 2, 'next', 1), slen)
	return pushOffset(s, slen, offset, optInteger(n, 3, 'next', i ~= nil and 1 or 0))
end

-- utf8.insert(s [, idx], substring): before character idx; at the end when
-- idx is left out or 0.
function M.insert(s, ...)
	s = checkString(s, 1, 'insert')
	local slen = len(s)
	local first, nargs = slen + 1, 2
	local idx = ...
	if type(idx) == 'number' then
		idx = optInteger(idx, 2, 'insert', 0)
		if idx ~= 0 then first = uRelat(s, slen, idx) end
		if not first then argError(2, 'insert', "invalid index") end
		nargs = 3
	end
	local subs = checkString((select(nargs - 1, ...)), nargs, 'insert')
	return sub(s, 1, first - 1) .. subs .. sub(s, first)
end

-- utf8.remove(s [, i [, j]]): without characters i..j (default the last one).
function M.remove(s, i, j)
	s = checkString(s, 1, 'remove')
	local slen = len(s)
	local a, b, ok = uRange(s, slen, optInteger(i, 2, 'remove', -1), optInteger(j, 3, 'remove', -1))
	if not ok then return s end
	return sub(s, 1, a) .. sub(s, b + 1)
end

-- utf8.escape(s): %ddd and %{ddd} decimal, %xhhh and %x{hhh} hex, %uddd and
-- %u{ddd} decimal again (only x reads hex), and % before anything else is
-- that character.
function M.escape(s)
	s = checkString(s, 1, 'escape')
	local slen = len(s)
	local out, p = {}, 1
	while p <= slen do
		local ch
		ch, p = safeDecode(s, p)
		if ch == 37 then
			local c, hex, parse = byte(s, p) or 0, false, false
			if (c >= 48 and c <= 57) or c == 123 then
				parse = true
			elseif c == 120 or c == 88 or c == 117 or c == 85 then
				if p + 1 <= slen then
					hex, parse, p = (c == 120 or c == 88), true, p + 1
				end
			end
			if parse then
				local code, inBracket = 0, false
				if byte(s, p) == 123 then p, inBracket = p + 1, true end
				while p <= slen do
					local d = byte(s, p)
					if d >= 48 and d <= 57 then d = d - 48
					elseif hex and d >= 65 and d <= 70 then d = d - 55
					elseif hex and d >= 97 and d <= 102 then d = d - 87
					elseif not inBracket then break
					elseif d == 125 then p = p + 1; break
					else error("invalid escape '" .. char(d) .. "'") end
					code = code * (hex and 16 or 10) + d
					p = p + 1
				end
				ch = code
			else
				ch, p = safeDecode(s, p)
			end
		end
		out[#out + 1] = encode(ch)
	end
	return concat(out)
end

-- luautf8's tofold table (unidata.h): first, last, step, offset.
local FOLD = {
	0x41,0x5A,1,32, 0xB5,0xB5,1,775, 0xC0,0xD6,1,32, 0xD8,0xDE,1,32, 0x100,0x12E,2,1, 0x132,0x136,2,1,
	0x139,0x147,2,1, 0x14A,0x176,2,1, 0x178,0x178,1,-121, 0x179,0x17D,2,1, 0x17F,0x17F,1,-268,
	0x181,0x181,1,210, 0x182,0x184,2,1, 0x186,0x186,1,206, 0x187,0x187,1,1, 0x189,0x18A,1,205,
	0x18B,0x18B,1,1, 0x18E,0x18E,1,79, 0x18F,0x18F,1,202, 0x190,0x190,1,203, 0x191,0x191,1,1,
	0x193,0x193,1,205, 0x194,0x194,1,207, 0x196,0x196,1,211, 0x197,0x197,1,209, 0x198,0x198,1,1,
	0x19C,0x19C,1,211, 0x19D,0x19D,1,213, 0x19F,0x19F,1,214, 0x1A0,0x1A4,2,1, 0x1A6,0x1A6,1,218,
	0x1A7,0x1A7,1,1, 0x1A9,0x1A9,1,218, 0x1AC,0x1AC,1,1, 0x1AE,0x1AE,1,218, 0x1AF,0x1AF,1,1,
	0x1B1,0x1B2,1,217, 0x1B3,0x1B5,2,1, 0x1B7,0x1B7,1,219, 0x1B8,0x1BC,4,1, 0x1C4,0x1C4,1,2,
	0x1C5,0x1C5,1,1, 0x1C7,0x1C7,1,2, 0x1C8,0x1C8,1,1, 0x1CA,0x1CA,1,2, 0x1CB,0x1DB,2,1,
	0x1DE,0x1EE,2,1, 0x1F1,0x1F1,1,2, 0x1F2,0x1F4,2,1, 0x1F6,0x1F6,1,-97, 0x1F7,0x1F7,1,-56,
	0x1F8,0x21E,2,1, 0x220,0x220,1,-130, 0x222,0x232,2,1, 0x23A,0x23A,1,10795, 0x23B,0x23B,1,1,
	0x23D,0x23D,1,-163, 0x23E,0x23E,1,10792, 0x241,0x241,1,1, 0x243,0x243,1,-195, 0x244,0x244,1,69,
	0x245,0x245,1,71, 0x246,0x24E,2,1, 0x345,0x345,1,116, 0x370,0x372,2,1, 0x376,0x376,1,1,
	0x37F,0x37F,1,116, 0x386,0x386,1,38, 0x388,0x38A,1,37, 0x38C,0x38C,1,64, 0x38E,0x38F,1,63,
	0x391,0x3A1,1,32, 0x3A3,0x3AB,1,32, 0x3C2,0x3C2,1,1, 0x3CF,0x3CF,1,8, 0x3D0,0x3D0,1,-30,
	0x3D1,0x3D1,1,-25, 0x3D5,0x3D5,1,-15, 0x3D6,0x3D6,1,-22, 0x3D8,0x3EE,2,1, 0x3F0,0x3F0,1,-54,
	0x3F1,0x3F1,1,-48, 0x3F4,0x3F4,1,-60, 0x3F5,0x3F5,1,-64, 0x3F7,0x3F7,1,1, 0x3F9,0x3F9,1,-7,
	0x3FA,0x3FA,1,1, 0x3FD,0x3FF,1,-130, 0x400,0x40F,1,80, 0x410,0x42F,1,32, 0x460,0x480,2,1,
	0x48A,0x4BE,2,1, 0x4C0,0x4C0,1,15, 0x4C1,0x4CD,2,1, 0x4D0,0x52E,2,1, 0x531,0x556,1,48,
	0x10A0,0x10C5,1,7264, 0x10C7,0x10CD,6,7264, 0x13F8,0x13FD,1,-8, 0x1C80,0x1C80,1,-6222,
	0x1C81,0x1C81,1,-6221, 0x1C82,0x1C82,1,-6212, 0x1C83,0x1C84,1,-6210, 0x1C85,0x1C85,1,-6211,
	0x1C86,0x1C86,1,-6204, 0x1C87,0x1C87,1,-6180, 0x1C88,0x1C88,1,35267, 0x1C90,0x1CBA,1,-3008,
	0x1CBD,0x1CBF,1,-3008, 0x1E00,0x1E94,2,1, 0x1E9B,0x1E9B,1,-58, 0x1E9E,0x1E9E,1,-7615,
	0x1EA0,0x1EFE,2,1, 0x1F08,0x1F0F,1,-8, 0x1F18,0x1F1D,1,-8, 0x1F28,0x1F2F,1,-8, 0x1F38,0x1F3F,1,-8,
	0x1F48,0x1F4D,1,-8, 0x1F59,0x1F5F,2,-8, 0x1F68,0x1F6F,1,-8, 0x1F88,0x1F8F,1,-8,
	0x1F98,0x1F9F,1,-8, 0x1FA8,0x1FAF,1,-8, 0x1FB8,0x1FB9,1,-8, 0x1FBA,0x1FBB,1,-74,
	0x1FBC,0x1FBC,1,-9, 0x1FBE,0x1FBE,1,-7173, 0x1FC8,0x1FCB,1,-86, 0x1FCC,0x1FCC,1,-9,
	0x1FD3,0x1FD3,1,-7235, 0x1FD8,0x1FD9,1,-8, 0x1FDA,0x1FDB,1,-100, 0x1FE3,0x1FE3,1,-7219,
	0x1FE8,0x1FE9,1,-8, 0x1FEA,0x1FEB,1,-112, 0x1FEC,0x1FEC,1,-7, 0x1FF8,0x1FF9,1,-128,
	0x1FFA,0x1FFB,1,-126, 0x1FFC,0x1FFC,1,-9, 0x2126,0x2126,1,-7517, 0x212A,0x212A,1,-8383,
	0x212B,0x212B,1,-8262, 0x2132,0x2132,1,28, 0x2160,0x216F,1,16, 0x2183,0x2183,1,1,
	0x24B6,0x24CF,1,26, 0x2C00,0x2C2F,1,48, 0x2C60,0x2C60,1,1, 0x2C62,0x2C62,1,-10743,
	0x2C63,0x2C63,1,-3814, 0x2C64,0x2C64,1,-10727, 0x2C67,0x2C6B,2,1, 0x2C6D,0x2C6D,1,-10780,
	0x2C6E,0x2C6E,1,-10749, 0x2C6F,0x2C6F,1,-10783, 0x2C70,0x2C70,1,-10782, 0x2C72,0x2C75,3,1,
	0x2C7E,0x2C7F,1,-10815, 0x2C80,0x2CE2,2,1, 0x2CEB,0x2CED,2,1, 0x2CF2,0xA640,31054,1,
	0xA642,0xA66C,2,1, 0xA680,0xA69A,2,1, 0xA722,0xA72E,2,1, 0xA732,0xA76E,2,1, 0xA779,0xA77B,2,1,
	0xA77D,0xA77D,1,-35332, 0xA77E,0xA786,2,1, 0xA78B,0xA78B,1,1, 0xA78D,0xA78D,1,-42280,
	0xA790,0xA792,2,1, 0xA796,0xA7A8,2,1, 0xA7AA,0xA7AA,1,-42308, 0xA7AB,0xA7AB,1,-42319,
	0xA7AC,0xA7AC,1,-42315, 0xA7AD,0xA7AD,1,-42305, 0xA7AE,0xA7AE,1,-42308, 0xA7B0,0xA7B0,1,-42258,
	0xA7B1,0xA7B1,1,-42282, 0xA7B2,0xA7B2,1,-42261, 0xA7B3,0xA7B3,1,928, 0xA7B4,0xA7C2,2,1,
	0xA7C4,0xA7C4,1,-48, 0xA7C5,0xA7C5,1,-42307, 0xA7C6,0xA7C6,1,-35384, 0xA7C7,0xA7C9,2,1,
	0xA7D0,0xA7D6,6,1, 0xA7D8,0xA7F5,29,1, 0xAB70,0xABBF,1,-38864, 0xFB05,0xFB05,1,1,
	0xFF21,0xFF3A,1,32, 0x10400,0x10427,1,40, 0x104B0,0x104D3,1,40, 0x10570,0x1057A,1,39,
	0x1057C,0x1058A,1,39, 0x1058C,0x10592,1,39, 0x10594,0x10595,1,39, 0x10C80,0x10CB2,1,64,
	0x118A0,0x118BF,1,32, 0x16E40,0x16E5F,1,32, 0x1E900,0x1E921,1,34
}
local function toFold(ch)
	local lo, hi = 0, #FOLD / 4
	while lo < hi do
		local mid = mfloor((lo + hi) / 2)
		local b = mid * 4
		if FOLD[b + 2] < ch then lo = mid + 1
		elseif FOLD[b + 1] > ch then hi = mid
		elseif (ch - FOLD[b + 1]) % FOLD[b + 3] == 0 then return ch + FOLD[b + 4]
		else return ch end
	end
	return ch
end

-- utf8.fold(s): case folded for comparison; a number is one codepoint.
function M.fold(s)
	local t = type(s)
	if t == 'number' then return toFold(optInteger(s, 1, 'fold', 0)) end
	if t ~= 'string' then error("number/string expected, got " .. (s == nil and 'no value' or t)) end
	local out, p, slen = {}, 1, len(s)
	while p <= slen do
		local code
		code, p = safeDecode(s, p)
		out[#out + 1] = encode(toFold(code))
	end
	return concat(out)
end

-- utf8.ncasecmp(a, b): -1, 0 or 1, comparing the case-folded codepoints.
function M.ncasecmp(a, b)
	a, b = checkString(a, 1, 'ncasecmp'), checkString(b, 2, 'ncasecmp')
	local p1, e1, p2, e2 = 1, len(a) + 1, 1, len(b) + 1
	while p1 < e1 or p2 < e2 do
		local c1, c2 = 0, 0
		if p1 == e1 then c2 = 1
		elseif p2 == e2 then c1 = 1
		else
			c1, p1 = safeDecode(a, p1)
			c2, p2 = safeDecode(b, p2)
			c1, c2 = toFold(c1), toFold(c2)
		end
		if c1 ~= c2 then return c1 > c2 and 1 or -1 end
	end
	return 0
end

-- utf8.widthindex(s, width [, i [, j [, ambi_is_double [, default_width]]]]):
-- the character that column `width` falls in, the column within it and its
-- width; past the end, the number of characters alone.
function M.widthindex(s, width, i, j, ambi, default)
	s = checkString(s, 1, 'widthindex')
	local slen = len(s)
	width = checkInteger(width, 2, 'widthindex')
	local posi = byteRelat(optInteger(i, 3, 'widthindex', 1), slen)
	local posj = byteRelat(optInteger(j, 4, 'widthindex', slen), slen)
	optInteger(ambi, 5, 'widthindex', 1)
	local defaultWidth = optInteger(default, 6, 'widthindex', 0)
	if not (posi >= 1 and posi - 1 <= slen) then argError(2, 'widthindex', "initial position out of bounds") end
	if not (posj - 1 < slen) then argError(3, 'widthindex', "final position out of bounds") end
	local idx, p, e = 0, posi, posj + 1
	while p < e do
		local code
		code, p = safeDecode(s, p)
		local w = codeWidth(code, defaultWidth)
		if width <= w then return idx + 1, width, w end
		idx, width = idx + 1, width - w
	end
	return idx
end

-- ── Pattern matching (lutf8lib.c's MatchState) ───────────────────────────────

local CAP_UNFINISHED, CAP_POSITION = -1, -2
local MAXCCALLS = 200
local SPECIALS = '[%^%$%*%+%?%.%(%[%%%-]'

-- Class membership comes from the engine's Unicode tables, the ones the native
-- matcher (utf8Patterns.ts) uses, so both matchers agree; cached per class.
local isClass = __mudlet_utf8_isclass
local classCache = {}
local function inClass(cl, c)
	local t = classCache[cl]
	if not t then t = {}; classCache[cl] = t end
	local r = t[c]
	if r == nil then
		if type(isClass) == 'function' then
			r = isClass(cl, c) and true or false
		elseif c < 0x80 then
			local pat = cl == 'g' and '[%w%p]' or cl == 't' and '$^' or '%' .. cl
			r = char(c):find(pat) ~= nil
		else
			r = false
		end
		t[c] = r
	end
	return r
end

local function matchClass(c, cl)
	local lc = cl
	if cl >= 65 and cl <= 90 then lc = cl + 32 end
	local name = char(lc % 256)
	local res
	if lc == 122 then res = c == 0 -- z
	elseif lc < 128 and ('acdglpstuwx'):find(name, 1, true) then res = inClass(name, c)
	else return cl == c end
	if lc == cl then return res end
	return not res
end

local function matchBracketClass(ms, c, p, ec)
	local P, sig = ms.p, true
	p = p + 1
	if byte(P, p) == 94 then sig, p = false, p + 1 end
	while p < ec do
		local ch
		ch, p = safeDecode(P, p)
		if ch == 37 then
			ch, p = safeDecode(P, p)
			if matchClass(c, ch) then return sig end
		else
			local nx, np = safeDecode(P, p)
			if nx == 45 and np < ec then
				nx, p = safeDecode(P, np)
				if ch <= c and c <= nx then return sig end
			elseif ch == c then
				return sig
			end
		end
	end
	return not sig
end

local function classEnd(ms, p)
	local P, pend = ms.p, ms.pend
	local ch
	ch, p = safeDecode(P, p)
	if ch == 37 then
		if p == pend then error("malformed pattern (ends with '%')") end
		return nextPos(P, p, pend - 1)
	elseif ch == 91 then
		if byte(P, p) == 94 then p = p + 1 end
		repeat
			if p == pend then error("malformed pattern (missing ']')") end
			local c = byte(P, p)
			p = p + 1
			if c == 37 and p < pend then p = p + 1 end
		until byte(P, p) == 93
		return p + 1
	end
	return p
end

local function singleMatch(ms, s, p, ep)
	if s >= ms.send then return false end
	local ch = safeDecode(ms.s, s)
	local pch, q = safeDecode(ms.p, p)
	if pch == 46 then return true end
	if pch == 37 then return matchClass(ch, (safeDecode(ms.p, q))) end
	if pch == 91 then return matchBracketClass(ms, ch, p, ep - 1) end
	return pch == ch
end

local doMatch

local function matchBalance(ms, s, p)
	local P, S = ms.p, ms.s
	local b, e, ch
	b, p = safeDecode(P, p)
	if p >= ms.pend then error("malformed pattern (missing arguments to '%b')") end
	e, p = safeDecode(P, p)
	ch, s = safeDecode(S, s)
	if ch ~= b then return nil, p end
	local cont = 1
	while s < ms.send do
		ch, s = safeDecode(S, s)
		if ch == e then
			cont = cont - 1
			if cont == 0 then return s, p end
		elseif ch == b then
			cont = cont + 1
		end
	end
	return nil, p
end

local function maxExpand(ms, s, p, ep)
	local m = s
	while singleMatch(ms, m, p, ep) do m = nextPos(ms.s, m, ms.slen) end
	while s <= m do
		local res = doMatch(ms, m, ep + 1)
		if res then return res end
		if s == m then break end
		m = prevPos(ms.s, s, m)
	end
	return nil
end

local function minExpand(ms, s, p, ep)
	while true do
		local res = doMatch(ms, s, ep + 1)
		if res then return res end
		if singleMatch(ms, s, p, ep) then s = nextPos(ms.s, s, ms.slen) else return nil end
	end
end

local function startCapture(ms, s, p, what)
	local level = ms.level
	if level >= 32 then error("too many captures") end
	ms.cinit[level + 1], ms.clen[level + 1] = s, what
	ms.level = level + 1
	local res = doMatch(ms, s, p)
	if not res then ms.level = ms.level - 1 end
	return res
end

local function endCapture(ms, s, p)
	local l = ms.level
	while l >= 1 and ms.clen[l] ~= CAP_UNFINISHED do l = l - 1 end
	if l < 1 then error("invalid pattern capture") end
	ms.clen[l] = s - ms.cinit[l]
	local res = doMatch(ms, s, p)
	if not res then ms.clen[l] = CAP_UNFINISHED end
	return res
end

local function matchCapture(ms, s, l)
	l = l - 49
	if l < 0 or l >= ms.level or ms.clen[l + 1] == CAP_UNFINISHED then
		error("invalid capture index %" .. (l + 1))
	end
	local n = ms.clen[l + 1]
	if n < 0 then return nil end
	local init = ms.cinit[l + 1]
	if ms.send - s >= n and sub(ms.s, init, init + n - 1) == sub(ms.s, s, s + n - 1) then
		return s + n
	end
	return nil
end

doMatch = function(ms, s, p)
	if ms.depth == 0 then error("pattern too complex") end
	ms.depth = ms.depth - 1
	local P, pend = ms.p, ms.pend
	while p ~= pend do
		local ch = byte(P, p)
		if ch == 40 then -- (
			if byte(P, p + 1) == 41 then
				s = startCapture(ms, s, p + 2, CAP_POSITION)
			else
				s = startCapture(ms, s, p + 1, CAP_UNFINISHED)
			end
			break
		elseif ch == 41 then -- )
			s = endCapture(ms, s, p + 1)
			break
		elseif ch == 36 and p + 1 == pend then -- $ at the end
			if s ~= ms.send then s = nil end
			break
		end
		local dflt = true
		if ch == 37 then -- %
			local c2, np = safeDecode(P, p + 1)
			if c2 == 98 then -- %b
				local ns
				ns, np = matchBalance(ms, s, np)
				if not ns then s = nil; break end
				s, p, dflt = ns, np, false
			elseif c2 == 102 then -- %f
				p = np
				if byte(P, p) ~= 91 then error("missing '[' after '%f' in pattern") end
				local ep = classEnd(ms, p)
				local previous, current = 0, 0
				if s ~= 1 then previous = luDecode(ms.s, prevPos(ms.s, 1, s), false) or 0 end
				if s ~= ms.send then current = luDecode(ms.s, s, false) or 0 end
				if matchBracketClass(ms, previous, p, ep - 1) or not matchBracketClass(ms, current, p, ep - 1) then
					s = nil
					break
				end
				p, dflt = ep, false
			elseif c2 >= 48 and c2 <= 57 then -- %0-%9
				s = matchCapture(ms, s, c2)
				if not s then break end
				p, dflt = np, false
			end
		end
		if dflt then
			local ep = classEnd(ms, p)
			local epc = byte(P, ep)
			if not singleMatch(ms, s, p, ep) then
				if epc == 42 or epc == 63 or epc == 45 then -- * ? -
					p = ep + 1
				else
					s = nil
					break
				end
			else
				local nexts = nextPos(ms.s, s, ms.slen)
				if epc == 63 then -- ?
					local nextep = nextPos(P, ep, pend - 1)
					local res = doMatch(ms, nexts, nextep)
					if res then s = res; break end
					p = nextep
				elseif epc == 43 then -- +
					s = maxExpand(ms, nexts, p, ep)
					break
				elseif epc == 42 then -- *
					s = maxExpand(ms, s, p, ep)
					break
				elseif epc == 45 then -- -
					s = minExpand(ms, s, p, ep)
					break
				else
					s, p = nexts, ep
				end
			end
		end
	end
	ms.depth = ms.depth + 1
	return s
end

local function newState(s, p)
	local slen, plen = len(s), len(p)
	return { s = s, slen = slen, send = slen + 1, p = p, pend = plen + 1,
	         level = 0, cinit = {}, clen = {}, depth = MAXCCALLS }
end

-- get_index: how many characters from `from` to `p`.
local function getIndex(ms, p, from)
	local idx = 0
	while from < ms.send and from < p do
		from, idx = nextPos(ms.s, from, ms.slen), idx + 1
	end
	if from == p then return idx end
	return idx - 1
end

local function oneCapture(ms, i, s, e)
	if i >= ms.level then
		if i == 0 then return sub(ms.s, s, e - 1) end
		error("invalid capture index")
	end
	local l = ms.clen[i + 1]
	if l == CAP_UNFINISHED then error("unfinished capture") end
	if l == CAP_POSITION then return getIndex(ms, ms.cinit[i + 1], 1) + 1 end
	return sub(ms.s, ms.cinit[i + 1], ms.cinit[i + 1] + l - 1)
end

local function captures(ms, s, e)
	local n = (ms.level == 0 and s) and 1 or ms.level
	local out = {}
	for i = 1, n do out[i] = oneCapture(ms, i - 1, s, e) end
	return unpack(out, 1, n)
end

-- The engine's matcher, where the pattern is one a regex can express: the
-- first match at or after byte `at`, or false; nil when it has to be ours.
-- The bridge would cut a string at a NUL, so those stay here too.
local findb = __mudlet_utf8_findb
local function nativeFrom(s, p, at)
	if type(findb) ~= 'function' or find(s, '%z') or find(p, '%z') then return nil end
	local r = findb(s, p, at)
	if r == nil or r == false then return r end
	local out, n = {}, 0
	while r[n] ~= nil do
		out[n + 1] = r[n]
		n = n + 1
	end
	return out
end

local nativeFind = __mudlet_utf8_find

-- find_aux: find (positions in characters, then the captures) or match.
local function findAux(isFind, fname, s, p, init, plain)
	s = checkString(s, 1, fname)
	p = checkString(p, 2, fname)
	local slen = len(s)
	local idx = optInteger(init, 3, fname, 1)
	if idx == 0 then idx = 1 end
	local at = uRelat(s, slen, idx)
	if at == nil then
		if idx > 0 then return nil end
		at = 1
	end
	if isFind and (plain or not find(p, SPECIALS)) then
		local s2 = find(s, p, at, true)
		if not s2 then return nil end
		local ms = newState(s, p)
		local e2 = s2 + len(p)
		if isCont(byte(s, e2)) then e2 = nextPos(s, e2, slen) end
		local first = getIndex(ms, s2, 1) + 1
		return first, first + getIndex(ms, e2, s2) - 1
	end
	if idx > 0 and type(nativeFind) == 'function' and not find(s, '%z') and not find(p, '%z') then
		local found = nativeFind(s, p, idx, false)
		if found == false then return nil end
		if found ~= nil then
			local out, n = {}, 0
			while found[n] ~= nil do
				out[n + 1] = found[n]
				n = n + 1
			end
			if isFind then return unpack(out, 1, n) end
			if n > 2 then return unpack(out, 3, n) end
			return M.sub(s, out[1], out[2])
		end
	end
	local ms = newState(s, p)
	local pstart, anchor = 1, byte(p, 1) == 94
	if anchor then pstart = 2 end
	if idx < 0 then idx = idx + M.len(s, 1, -1, true) + 1 end
	repeat
		ms.level = 0
		local res = doMatch(ms, at, pstart)
		if res then
			if isFind then
				local n = ms.level
				local out = { idx, idx + getIndex(ms, res, at) - 1 }
				for i = 1, n do out[i + 2] = oneCapture(ms, i - 1, nil, nil) end
				return unpack(out, 1, n + 2)
			end
			return captures(ms, at, res)
		end
		if at == ms.send then break end
		idx, at = idx + 1, nextPos(s, at, slen)
	until not (at <= ms.send and not anchor)
	return nil
end

function M.find(s, p, init, plain)
	return findAux(true, 'find', s, p, init, plain)
end

function M.match(s, p, init)
	return findAux(false, 'match', s, p, init)
end

-- The next match at or after byte `src`, for gmatch and gsub: its first byte,
-- the byte after it, and the state holding its captures.
local function nextMatch(ms, src, pstart, anchor, native)
	if src > ms.send then return nil end
	if native then
		local r = nativeFrom(ms.s, ms.p, src)
		if r == false then return nil end
		if r ~= nil then
			if anchor and r[1] ~= src then return nil end
			ms.level = #r - 2
			for i = 1, ms.level do
				ms.cinit[i] = r[i + 2]
				ms.clen[i] = 'native'
			end
			return r[1], r[2]
		end
	end
	while src <= ms.send do
		ms.level = 0
		local e = doMatch(ms, src, pstart)
		if e then return src, e end
		if src == ms.send or anchor then break end
		src = nextPos(ms.s, src, ms.slen)
	end
	return nil
end

-- A capture of the last match, whichever matcher found it.
local function capOf(ms, i, s, e)
	if ms.clen[i + 1] == 'native' and i < ms.level then return ms.cinit[i + 1] end
	return oneCapture(ms, i, s, e)
end

local function capsOf(ms, s, e)
	local n = ms.level == 0 and 1 or ms.level
	local out = {}
	for i = 1, n do out[i] = capOf(ms, i - 1, s, e) end
	return unpack(out, 1, n)
end

-- utf8.gmatch(s, pattern): as Lua 5.1's, so an empty match may follow
-- another one straight away; a leading ^ is an ordinary character.
function M.gmatch(s, p)
	s = checkString(s, 1, 'gmatch')
	p = checkString(p, 2, 'gmatch')
	local ms = newState(s, p)
	local native = byte(p, 1) ~= 94
	local start = 1
	return function()
		local from, e = nextMatch(ms, start, 1, false, native)
		if not from then
			start = ms.send + 1
			return nil
		end
		start = e == from and e + 1 or e
		return capsOf(ms, from, e)
	end
end

-- utf8.gsub(s, pattern, repl [, n]): repl a string (%0-%9, %% — %1 is the
-- whole match when there are no captures), a table looked up by the first
-- capture, or a function given the captures; n caps the replacements.
function M.gsub(s, p, repl, n)
	s = checkString(s, 1, 'gsub')
	p = checkString(p, 2, 'gsub')
	local tr = type(repl)
	if tr ~= 'number' and tr ~= 'string' and tr ~= 'function' and tr ~= 'table' then
		argError(3, 'gsub', "string/function/table expected")
	end
	local slen = len(s)
	local maxS = optInteger(n, 4, 'gsub', slen + 1)
	local anchor = byte(p, 1) == 94
	local ms = newState(s, p)
	local out, count, at = {}, 0, 1
	local pstart = anchor and 2 or 1
	if tr == 'number' then repl = tostring(repl) end
	while count < maxS do
		local from, e = nextMatch(ms, at, pstart, anchor, true)
		if not from then break end
		if from > at then
			-- What luautf8 copies character by character, decoding each.
			local q = at
			while q < from do
				local _, nq = safeDecode(s, q)
				q = nq
			end
			out[#out + 1] = sub(s, at, from - 1)
			at = from
		end
		count = count + 1
		if tr == 'function' then
			local v = repl(capsOf(ms, at, e))
			if not v then v = sub(s, at, e - 1)
			elseif type(v) ~= 'string' and type(v) ~= 'number' then
				error("invalid replacement value (a " .. type(v) .. ")")
			end
			out[#out + 1] = tostring(v)
		elseif tr == 'table' then
			local v = repl[capOf(ms, 0, at, e)]
			if not v then v = sub(s, at, e - 1)
			elseif type(v) ~= 'string' and type(v) ~= 'number' then
				error("invalid replacement value (a " .. type(v) .. ")")
			end
			out[#out + 1] = tostring(v)
		else
			local rlen, q = len(repl), 1
			while q <= rlen do
				local ch, nq = safeDecode(repl, q)
				if ch ~= 37 then
					out[#out + 1] = sub(repl, q, nq - 1)
				else
					ch, nq = safeDecode(repl, nq)
					if ch < 48 or ch > 57 then
						if ch ~= 37 then error("invalid use of '%' in replacement string") end
						out[#out + 1] = '%'
					elseif ch == 48 then
						out[#out + 1] = sub(s, at, e - 1)
					else
						out[#out + 1] = tostring(capOf(ms, ch - 49, at, e))
					end
				end
				q = nq
			end
		end
		if e > at then
			at = e
		elseif at < ms.send then
			local _, nq = safeDecode(s, at)
			out[#out + 1] = sub(s, at, nq - 1)
			at = nq
		else
			break
		end
		if anchor then break end
	end
	out[#out + 1] = sub(s, at)
	return concat(out), count
end


return M