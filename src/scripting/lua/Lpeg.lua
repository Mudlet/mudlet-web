-- Lpeg.lua: desktop Mudlet links the C LPeg (the lpeg rock, 1.1.0); the browser
-- has the pure-Lua LuLPeg port instead, registered under package.loaded["lpeg"]
-- before LuaGlobal.lua publishes the global. Compiled as Mudlet Web's own code
-- ("=[C]"), the way this file is, so the module reads as C to debug.getinfo.
do
    local ok, mod = pcall(function()
        local f, err = io.open("/lua/3rdparty/lulpeg.lua", "r")
        if not f then error(err, 0) end
        local code = f:read("*a")
        f:close()
        -- The same position-free `error` every internal chunk gets.
        local chunk, cerr = loadstring("local error = __mudlet_c_error; " .. code, "=[C]")
        if not chunk then error(cerr, 0) end
        return chunk()
    end)
    if not ok or type(mod) ~= 'table' then
        print("[mudlet] lpeg (LuLPeg) failed to load: " .. tostring(mod))
        return
    end

    -- LPeg 1.1: a string, where LuLPeg (written against 0.12) has a function.
    mod.version = "LPeg 1.1.0"

    -- lpeg.utfR(from, to): one UTF-8 encoded character whose codepoint lies in
    -- [from, to]. An ASCII range is a plain charset, as it is in LPeg; above
    -- that the range is split by encoded length, and each length into byte
    -- ranges, the usual way a codepoint range is turned into a byte automaton.
    local P, R = mod.P, mod.R
    local floor, char = math.floor, string.char
    local function range(lo, hi) return R(char(lo) .. char(hi)) end
    local cont = range(0x80, 0xBF)
    local LEAD = { 0x00, 0xC0, 0xE0, 0xF0, 0xF8, 0xFC }
    local MAX = { 0x7F, 0x7FF, 0xFFFF, 0x1FFFFF, 0x3FFFFFF, 0x7FFFFFFF }

    local function encode(cp, n)
        local b = {}
        for i = n, 2, -1 do
            b[i] = 0x80 + cp % 64
            cp = floor(cp / 64)
        end
        b[1] = LEAD[n] + cp
        return b
    end

    -- Byte strings from a[i..n] up to b[i..n], each position a range.
    local function span(a, b, i, n)
        if i == n then return range(a[i], b[i]) end
        if a[i] == b[i] then return P(char(a[i])) * span(a, b, i + 1, n) end
        local function tailIs(t, v)
            for k = i + 1, n do if t[k] ~= v then return false end end
            return true
        end
        local alt
        local function add(p) if alt then alt = alt + p else alt = p end end
        local lo, hi = a[i], b[i]
        if not tailIs(a, 0x80) then
            local top = {}
            for k = 1, n do top[k] = k <= i and a[k] or 0xBF end
            add(P(char(a[i])) * span(a, top, i + 1, n))
            lo = lo + 1
        end
        local partialHigh = not tailIs(b, 0xBF)
        if partialHigh then hi = hi - 1 end
        if lo <= hi then
            local p = range(lo, hi)
            for _ = i + 1, n do p = p * cont end
            add(p)
        end
        if partialHigh then
            local bottom = {}
            for k = 1, n do bottom[k] = k <= i and b[k] or 0x80 end
            add(P(char(b[i])) * span(bottom, b, i + 1, n))
        end
        return alt
    end

    local function checkint(v, n)
        local x = tonumber(v)
        if x == nil then
            error("bad argument #" .. n .. " to 'utfR' (number expected, got "
                .. (v == nil and 'no value' or type(v)) .. ")")
        end
        return x >= 0 and floor(x) or -floor(-x)
    end

    function mod.utfR(from, to)
        from, to = checkint(from, 1), checkint(to, 2)
        -- lua_Unsigned in LPeg: a negative bound wraps to a huge one.
        if from < 0 then from = from + 2 ^ 64 end
        if to < 0 then to = to + 2 ^ 64 end
        if from > to then error("bad argument #2 to 'utfR' (empty range)") end
        if to <= 0x7F then return range(from, to) end
        local alt
        local lowest = 0
        for n = 1, 6 do
            local lo = from > lowest and from or lowest
            local hi = to < MAX[n] and to or MAX[n]
            if lo <= hi then
                local p = span(encode(lo, n), encode(hi, n), 1, n)
                if alt then alt = alt + p else alt = p end
            end
            lowest = MAX[n] + 1
        end
        return alt or P(false)
    end

    package.loaded["lpeg"] = mod
end
