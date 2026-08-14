-- luasql.sqlite3 shim backed by the main-thread sqlite-wasm bridge in
-- LuaRuntime.ts. Mudlet's DB.lua expects this module to look like the real
-- LuaSQL binding:
--   local luasql = require "luasql.sqlite3"
--   local env  = luasql.sqlite3()
--   local conn = env:connect(path)
--   local cur, err = conn:execute(sql)            -- cursor for SELECT
--   local n = conn:execute("INSERT ...")          -- rowcount otherwise
--   local row = cur:fetch({}, "a")                -- assoc-mode row, or nil
--   cur:close(); conn:close(); env:close()
--
-- The JS bridge functions (__sql_*) are synchronous — they return a value
-- directly, no Promise / __await dance.

-- A LuaSQL cursor must be a *userdata*, not a Lua table: Mudlet's DB.lua
-- branches on `type(cur) == "userdata"` (e.g. db:_migrate reads existing
-- columns from a `PRAGMA table_info` cursor only when that test passes). The
-- real luasql.sqlite3 binding returns userdata cursors, so the shim has to as
-- well, or _migrate treats every existing table as brand-new and clobbers it.
-- Lua 5.1's newproxy(true) gives us a userdata with a fresh metatable; methods
-- live on its __index and close over this cursor's row/position state.
local function make_cursor(rows, columns)
    local pos = 0
    local n = #rows

    local cur = newproxy(true)
    local mt = getmetatable(cur)
    mt.__index = {
        fetch = function(_, t, mode)
            pos = pos + 1
            if pos > n then return nil end
            t = t or {}
            local row = rows[pos]
            if mode == "a" then
                for i = 1, #columns do
                    t[columns[i]] = row[i]
                end
            else
                for i = 1, #columns do
                    t[i] = row[i]
                end
            end
            return t
        end,

        close = function() return true end,

        getcolnames = function()
            local r = {}
            for i = 1, #columns do r[i] = columns[i] end
            return r
        end,
    }

    return cur
end

local function make_conn(conn_id)
    local conn = {}

    -- Transaction handling mirrors LuaSQL's sqlite3 driver: autocommit is on
    -- until setautocommit(false), which opens a transaction there and then and
    -- re-opens one after every commit/rollback. db:create turns it off for every
    -- database it makes, so db.Database:_begin (which only stops db:add from
    -- committing each row) leaves the rows inside the open transaction for
    -- _rollback to discard. Treating commit/rollback as no-ops — as this shim
    -- used to — made _rollback silently keep every "discarded" row.
    local auto_commit = true
    local in_transaction = false
    local function begin_transaction()
        if not in_transaction then
            __sql_exec(conn_id, "BEGIN")
            in_transaction = true
        end
    end
    local function finish(verb)
        if in_transaction then
            __sql_exec(conn_id, verb)
            in_transaction = false
        end
        if not auto_commit then begin_transaction() end
        return true
    end

    function conn:execute(sql)
        local result = __sql_exec(conn_id, sql)
        if result == nil then
            return nil, "sqlite returned nil"
        end
        if result.kind == "error" then
            return nil, result.message
        elseif result.kind == "rows" then
            -- Rows arrive as a Lua source literal (`{{...},{...},...}`) rather
            -- than a pre-pushed table. Avoids wasmoon's per-cell pushTable cost
            -- on big fetches — one boundary crossing for the source string, one
            -- in-wasm Lua parse, no JS round-trip per value.
            local fn, parse_err = loadstring("return " .. result.rowsSrc, "sql_rows")
            if not fn then
                return nil, "sql rows parse error: " .. tostring(parse_err)
            end
            local ok, rows = pcall(fn)
            if not ok then
                return nil, "sql rows eval error: " .. tostring(rows)
            end
            return make_cursor(rows, result.columns)
        else
            return result.changes or 0
        end
    end

    function conn:escape(s)
        return __sql_escape(s)
    end

    local closed = false
    function conn:close()
        -- Closing a connection twice is false, not true: luasql answers that
        -- way, and db:_closeAll() reads it to name the databases something else
        -- closed behind its back.
        if closed then return false end
        closed = true
        -- Commit rather than drop: closing with work pending should persist it,
        -- which is what a caller that never called commit() expects.
        auto_commit = true
        finish("COMMIT")
        __sql_close(conn_id)
        return true
    end

    function conn:commit() return finish("COMMIT") end
    function conn:rollback() return finish("ROLLBACK") end

    function conn:setautocommit(on)
        auto_commit = on ~= false
        if auto_commit then
            if in_transaction then
                __sql_exec(conn_id, "COMMIT")
                in_transaction = false
            end
        else
            begin_transaction()
        end
        return true
    end

    return conn
end

local function make_env()
    local env = {}

    function env:connect(path)
        local conn_id = __sql_open(path)
        if conn_id == nil then
            return nil, "failed to open " .. tostring(path)
        end
        return make_conn(conn_id)
    end

    function env:close() return true end

    return env
end

local mod = {
    sqlite3 = function() return make_env() end,
}

-- Populate both package.preload (so `require("luasql.sqlite3")` works) and
-- package.loaded (so DB.lua's `if package.loaded[...]` check passes without a
-- prior require).
package.preload["luasql.sqlite3"] = function() return mod end
package.loaded["luasql.sqlite3"] = mod
