-- Desktop-width integers for the stdlib functions that narrow a Lua number.
--
-- Desktop Mudlet links stock Lua 5.1 built for a 64-bit host, where lua_Integer
-- (ptrdiff_t) and the `long` behind string.format's %d/%x and tonumber's
-- strtoul are 64 bits. This client's Lua is wasm32, where they are 32 bits, so
-- a number of 2^31 or more — gold, XP, an epoch in milliseconds — came out as
-- INT_MIN, clamped, or 0 (issue #275). The wasm can't be rebuilt from here, so
-- string.format, tonumber and table.insert are wrapped:
--
--   * The normal range goes straight to the C original after a couple of type
--     checks and comparisons — no bridge, no allocation.
--   * A value the 32-bit build would mangle takes a Lua path that works out
--     what the 64-bit build does and, where it can, hands the original
--     arguments it can no longer get wrong.
--   * Arguments the original would REJECT never reach it from the fast path:
--     a C function called from here would blame this chunk's line, not the
--     caller's. They go through `reraise`, which takes the original's own
--     message and raises it at the caller's level under the name the caller
--     used — the "bad argument #N to 'format'" desktop prints, at the script
--     line desktop prints it at.
--
-- string.sub and string.byte are deliberately NOT wrapped, though they narrow
-- a position of 2^31 or more the same way: they are among the hottest
-- functions in any script, a wrapper costs them ~5x on every call, and no
-- real script slices a string at position two billion. Recorded in
-- e2e/knownDivergences.ts (PLATFORM_DIVERGENCES).
--
-- Where the desktop result is the platform's doing — a double outside int64
-- cast to an integer — this follows x86-64 Linux (cvttsd2si: anything
-- unrepresentable becomes INT64_MIN), the platform the issue was measured on.
--
-- Runs before Bridge.lua and the bundled Mudlet Lua, so nothing captures an
-- unwrapped original as an upvalue (`local format = string.format`).
do
  local type, select, unpack, next, pcall, error = type, select, unpack, next, pcall, error
  local rawget, rawset, tostring = rawget, rawset, tostring
  local floor, ceil, concat = math.floor, math.ceil, table.concat
  local sub, byte, format, find, match, rep = string.sub, string.byte, string.format, string.find, string.match, string.rep
  local insert, tonumber = table.insert, tonumber
  local getinfo = debug.getinfo

  local TWO32 = 4294967296
  local TWO63 = 9223372036854775808
  -- Exclusive bounds of what the 32-bit build converts exactly.
  local LO, HI = -2147483648, 2147483648

  -- Raise the error `f(...)` raises, as if f had been called where the wrapper
  -- was. Must be called as a plain statement from the wrapper itself (level 2)
  -- so the wrapper's caller is level 3. Called from C (pcall) the original has
  -- no name and no location either, so that falls out the same.
  --
  -- The one thing that can't be recovered: a wrapper TAIL-called from Lua
  -- (`return string.format(...)`) has no caller frame left — Lua 5.1 drops it,
  -- where a tail-called C function keeps it — so the message carries no
  -- script location. It still names the function, by its stock name.
  local function reraise(stockname, f, ...)
    local ok, msg = pcall(f, ...)
    if ok then return end -- the caller falls back to calling f itself
    if type(msg) == 'string' then
      local ar = getinfo(2, 'n')
      local name = ar and ar.name
      if not name then
        local caller = getinfo(3, 'S')
        name = (caller and caller.what == 'tail') and stockname or '?'
      end
      local narg, rest = match(msg, "^bad argument #(%d+) to '%?' (.*)$")
      if narg then
        narg = tonumber(narg)
        if ar and ar.namewhat == 'method' then
          narg = narg - 1 -- luaL_argerror doesn't count `self`
          if narg == 0 then
            error(format("calling '%s' on bad self %s", name, rest), 3)
          end
        end
        msg = format("bad argument #%d to '%s' %s", narg, name, rest)
      end
    end
    error(msg, 3)
  end

  -- (lua_Integer)n on a 64-bit desktop: truncation toward zero, and INT64_MIN
  -- for NaN or anything outside int64.
  local function toint(n)
    if n ~= n or n >= TWO63 or n < -TWO63 then return -TWO63 end
    if n >= 0 then return floor(n) end
    return ceil(n)
  end

  -- luaL_checkint: (int)(lua_Integer)n — the low 32 bits, signed.
  local function toint32(n)
    n = toint(n) % TWO32
    if n >= HI then n = n - TWO32 end
    return n
  end

  -- What luaL_checklstring accepts.
  local function stringish(v)
    local t = type(v)
    return t == 'string' or t == 'number'
  end

  ------------------------------------------------------- 64-bit digit strings
  -- A 64-bit value is carried as two exact doubles, hi and lo, each in
  -- [0, 2^32) — a double alone can't hold every integer past 2^53, and %x of a
  -- negative number needs the full two's-complement bit pattern.
  local function split(m) -- m: a whole double in [0, 2^64)
    local hi = floor(m / TWO32)
    return hi, m - hi * TWO32
  end

  local function negate(hi, lo) -- two's complement within 64 bits
    if lo == 0 then return (TWO32 - hi) % TWO32, 0 end
    return TWO32 - 1 - hi, TWO32 - lo
  end

  local DIGITS_LOWER = '0123456789abcdef'
  local DIGITS_UPPER = '0123456789ABCDEF'

  local function digits(hi, lo, base, set)
    local out, n = {}, 0
    repeat
      local hq = floor(hi / base)
      local cur = (hi - hq * base) * TWO32 + lo -- < base * 2^32: still exact
      local lq = floor(cur / base)
      local r = cur - lq * base
      hi, lo = hq, lq
      n = n + 1
      out[n] = sub(set, r + 1, r + 1)
    until hi == 0 and lo == 0
    for a = 1, floor(n / 2) do out[a], out[n + 1 - a] = out[n + 1 - a], out[a] end
    return concat(out)
  end

  -- printf of one integer conversion under glibc's flag rules, for a value
  -- the 32-bit build would narrow. `flags`, `width` and `prec` are the spec's
  -- own text (prec nil when there was no '.').
  local function format_int(flags, width, prec, conv, n)
    local neg, hi, lo = false, 0, 0
    if conv == 'd' or conv == 'i' then
      local v = toint(n) -- (long)n
      if v < 0 then neg = true; v = -v end
      hi, lo = split(v)
    else
      -- (unsigned long)n as gcc emits it on x86-64: below 2^63 through the
      -- signed conversion (so a negative number wraps), from 2^63 by offset.
      if n ~= n or n < -TWO63 then hi, lo = 2147483648, 0
      elseif n >= TWO32 * TWO32 then hi, lo = 0, 0
      elseif n >= 0 then hi, lo = split(floor(n))
      else hi, lo = negate(split(floor(-n))) end
    end
    local base = (conv == 'o' and 8) or ((conv == 'x' or conv == 'X') and 16) or 10
    local body = digits(hi, lo, base, conv == 'X' and DIGITS_UPPER or DIGITS_LOWER)
    local zero = hi == 0 and lo == 0
    local p = prec and (tonumber(prec) or 0)
    if p then
      if p == 0 and zero then body = '' end
      if #body < p then body = rep('0', p - #body) .. body end
    end
    local prefix = ''
    if conv == 'd' or conv == 'i' then
      if neg then prefix = '-'
      elseif find(flags, '+', 1, true) then prefix = '+'
      elseif find(flags, ' ', 1, true) then prefix = ' ' end
    elseif find(flags, '#', 1, true) then
      if conv == 'o' then
        if sub(body, 1, 1) ~= '0' then body = '0' .. body end
      elseif not zero then
        prefix = conv == 'X' and '0X' or '0x'
      end
    end
    local w = tonumber(width) or 0
    local len = #prefix + #body
    if len >= w then return prefix .. body end
    if find(flags, '-', 1, true) then return prefix .. body .. rep(' ', w - len) end
    if not p and find(flags, '0', 1, true) then return prefix .. rep('0', w - len) .. body end
    return rep(' ', w - len) .. prefix .. body
  end

  ------------------------------------------------------------- string.format
  -- str_format's reading of a format string, parsed once per string: false
  -- when it is malformed (the original raises), else a list of every item,
  -- each { kind, start, end, flags, width, precision, conversion }, where
  -- kind is what luaL_check* the original applies to the item's argument.
  local KIND = {
    d = 'signed', i = 'signed',
    o = 'unsigned', u = 'unsigned', x = 'unsigned', X = 'unsigned',
    c = 'number', e = 'number', E = 'number', f = 'number', g = 'number', G = 'number',
    q = 'string', s = 'string',
  }

  local function parse(fmt)
    local items, kinds, count, pos = {}, {}, 0, 1
    while true do
      local s = find(fmt, '%', pos, true)
      if not s then break end
      if sub(fmt, s + 1, s + 1) == '%' then
        pos = s + 2
      else
        local flags = match(fmt, '^[-+ #0]*', s + 1)
        if #flags >= 6 then return false end -- "repeated flags"
        local q = s + 1 + #flags
        local width = match(fmt, '^%d?%d?', q)
        q = q + #width
        local prec
        if sub(fmt, q, q) == '.' then
          prec = match(fmt, '^%d?%d?', q + 1)
          q = q + 1 + #prec
        end
        local conv = sub(fmt, q, q)
        local kind = KIND[conv]
        if not kind then return false end -- a digit too many, or an unknown option
        count = count + 1
        items[count] = { kind, s, q, flags, width, prec, conv }
        kinds[count] = kind
        pos = q + 1
      end
    end
    items.kinds = kinds
    return items
  end

  -- Whether the original takes v for this kind of item, and converts it
  -- exactly: (long) truncates toward zero, so -2^31-1 < v < 2^31 survives;
  -- (unsigned long) is exact on [0, 2^32).
  local SIGNED_LO = LO - 1
  local function fits(kind, v)
    local t = type(v)
    if t ~= 'number' then
      if t ~= 'string' then return false end
      if kind == 'string' then return true end
      v = tonumber(v)
      if v == nil then return false end
    end
    if kind == 'signed' then return v > SIGNED_LO and v < HI end
    if kind == 'unsigned' then return v >= 0 and v < TWO32 end
    return true
  end

  -- Whether the original accepts v at all.
  local function accepts(kind, v)
    if kind == 'string' then return stringish(v) end
    return tonumber(v) ~= nil
  end

  local cache, cached = {}, 0

  -- Every argument is acceptable and at least one integer item is out of the
  -- 32-bit range: format those items here and pass them as %s.
  local function wide_format(fmt, items, n, ...)
    local args = { ... }
    local out, last = {}, 1
    for k = 1, #items do
      local it = items[k]
      local v = tonumber(args[k])
      if (it[1] == 'signed' or it[1] == 'unsigned') and not fits(it[1], v) then
        out[#out + 1] = sub(fmt, last, it[2] - 1)
        out[#out + 1] = '%s'
        args[k] = format_int(it[4], it[5], it[6], it[7], v)
        last = it[3] + 1
      end
    end
    out[#out + 1] = sub(fmt, last)
    return format(concat(out), unpack(args, 1, n))
  end

  string.format = function(...)
    local fmt = ...
    if type(fmt) ~= 'string' then
      if type(fmt) ~= 'number' then reraise('format', format, ...); return format(...) end
      fmt = tostring(fmt)
    end
    local items = cache[fmt]
    if items == nil then
      items = parse(fmt)
      if cached >= 256 then cache, cached = {}, 0 end
      cache[fmt] = items
      cached = cached + 1
    end
    if not items then reraise('format', format, ...); return format(...) end
    local kinds = items.kinds
    local nk = #kinds
    local n = select('#', ...) - 1
    if nk > n then reraise('format', format, ...); return format(...) end -- "no value"
    -- The first three arguments without a select() call each: this loop runs
    -- on every format, so the common case stays a handful of VM instructions.
    local _, a1, a2, a3 = ...
    local wide = false
    for k = 1, nk do
      local v
      if k == 1 then v = a1 elseif k == 2 then v = a2 elseif k == 3 then v = a3
      else v = (select(k + 1, ...)) end
      local kind, t = kinds[k], type(v)
      if t == 'number' then
        if kind == 'signed' then
          if not (v > SIGNED_LO and v < HI) then wide = true end
        elseif kind == 'unsigned' then
          if not (v >= 0 and v < TWO32) then wide = true end
        end
      elseif kind ~= 'string' or t ~= 'string' then
        if not accepts(kind, v) then reraise('format', format, ...); return format(...) end
        if not fits(kind, v) then wide = true end
      end
    end
    if wide then return wide_format(fmt, items, n, select(2, ...)) end
    return format(...)
  end

  ------------------------------------------------------------------ tonumber
  -- glibc strtoul(s, &end, base) followed by luaB_tonumber's trailing check,
  -- with a 64-bit unsigned long. Returns the number, or nil.
  local function strtoul(s, base)
    s = match(s, '^[^%z]*') -- C stops at the first NUL
    local p = #match(s, '^%s*') + 1
    local c = sub(s, p, p)
    local negative = c == '-'
    if c == '-' or c == '+' then p = p + 1 end
    if base == 16 and find(s, '^0[xX]%x', p) then p = p + 2 end
    local hi, lo, overflow, any = 0, 0, false, false
    while true do
      local ch = byte(s, p)
      if not ch then break end
      local d
      if ch >= 48 and ch <= 57 then d = ch - 48
      elseif ch >= 97 and ch <= 122 then d = ch - 87
      elseif ch >= 65 and ch <= 90 then d = ch - 55 end
      if not d or d >= base then break end
      any = true
      if not overflow then
        local l = lo * base + d
        local carry = floor(l / TWO32)
        lo = l - carry * TWO32
        hi = hi * base + carry
        if hi >= TWO32 then overflow = true end
      end
      p = p + 1
    end
    if not any then return nil end
    if not find(s, '^%s*$', p) then return nil end
    if overflow then return TWO32 * TWO32 - 1 end -- ULONG_MAX, as a double
    if negative then hi, lo = negate(hi, lo) end
    return hi * TWO32 + lo
  end

  -- "0x" with no digit after it: the wasm libc reads the prefix as a complete
  -- 0, glibc stops after the 0 and leaves an unparsed "x", so desktop says nil.
  local HEX_STUB = '^%s*[-+]?0[xX]%s*$'

  _G.tonumber = function(...)
    local e, base = ...
    -- The one-argument form — nearly every call — is the original plus one
    -- comparison: only a 0 can be the misread "0x".
    if base == nil and e ~= nil then
      local r = tonumber(e)
      if r ~= 0 then return r end
      if type(e) == 'string' and find(e, HEX_STUB) then return nil end
      return r
    end
    if base == nil or base == 10 then
      if e == nil and select('#', ...) == 0 then reraise('tonumber', tonumber, ...); return tonumber(...) end
      local r = tonumber(e, base)
      if r == 0 and type(e) == 'string' and find(e, HEX_STUB) then return nil end
      return r
    end
    local te = type(e)
    if type(base) == 'number' and base >= 2 and base <= 36 and base % 1 == 0
      and (te == 'string' or te == 'number') then
      local r = tonumber(e, base)
      -- The wasm strtoul agrees with glibc's for an unsigned value between
      -- 1 and its own ULONG_MAX. 0 may be a bare "0x" (desktop: nil), a
      -- clamped result may be anything, and a '-' wraps at 32 bits.
      if r == nil or (r > 0 and r < 4294967295 and not find(e, '-', 1, true)) then return r end
      return strtoul(tostring(e), base)
    end
    -- A base given as a string or a fraction (luaL_optint takes both), or an
    -- argument the original rejects.
    local b = tonumber(base)
    if b ~= nil then b = toint32(b) end
    if b == nil or b < 2 or b > 36 or not stringish(e) then
      reraise('tonumber', tonumber, ...)
      return tonumber(...)
    end
    if b == 10 then
      local r = tonumber(e, 10)
      if r == 0 and te == 'string' and find(e, HEX_STUB) then return nil end
      return r
    end
    return strtoul(tostring(e), b)
  end

  -------------------------------------------------------------- table.insert
  -- tinsert moves t[e..pos+1] up one slot at a time, so the 32-bit build's
  -- INT_MIN for a position past 2^31 meant ~2^31 iterations: a frozen tab.
  -- Desktop takes the low 32 bits of the 64-bit integer instead (2^32+1 -> 1).
  -- A position still at or below 0 then does what desktop does — every
  -- integer key from pos to #t moves up one — but visits only keys that exist,
  -- so a huge negative position doesn't hang either.
  local function shift_insert(t, pos, v)
    local e = #t + 1
    local olds = {}
    for k, val in next, t do
      if type(k) == 'number' and k <= 0 and k >= pos and k == floor(k) then olds[k] = val end
    end
    for i = e, 1, -1 do rawset(t, i, rawget(t, i - 1)) end
    for k in next, olds do
      if k > pos then rawset(t, k, nil) end
    end
    for k, val in next, olds do
      if k < 0 then rawset(t, k + 1, val) end
    end
    rawset(t, pos, v)
  end

  -- The append, table.insert(t, v), is the hot form and has no position to
  -- narrow: one arity check and one type check, then the original. The type
  -- check is what keeps `table.insert(nil, x)` blamed on the script's line —
  -- a bad `t` reaching the original from here would be reported at this one.
  table.insert = function(t, ...)
    local n = select('#', ...)
    if n == 1 and type(t) == 'table' then return insert(t, ...) end
    local pos, v = ...
    if n == 2 and type(t) == 'table' and type(pos) == 'number' and pos >= 1 and pos < HI then
      return insert(t, pos, v)
    end
    local p = tonumber(pos)
    if n ~= 2 or type(t) ~= 'table' or p == nil then
      reraise('insert', insert, t, ...)
      return insert(t, ...)
    end
    p = toint32(p)
    if p >= 1 then return insert(t, p, v) end
    shift_insert(t, p, v)
  end
end
