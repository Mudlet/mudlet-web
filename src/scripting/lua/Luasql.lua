-- luasql.sqlite3 for Mudlet Web: LuaSQL 2.6's sqlite3 driver (ls_sqlite3.c),
-- reproduced over the sqlite-wasm bridge in LuaRuntime.ts / sqliteClient.ts.
-- Mudlet's DB.lua and scripts that use LuaSQL directly both run on it, so it
-- answers the way desktop's binding does, down to the error text:
--
--   local luasql = require "luasql.sqlite3"
--   local env  = luasql.sqlite3()
--   local conn = env:connect(path)                -- nil, "LuaSQL: ..." on failure
--   local cur  = conn:execute(sql)                -- a cursor for a statement with columns
--   local n    = conn:execute("INSERT ...")       -- otherwise sqlite3_changes()
--   local row  = cur:fetch({}, "a")               -- nil once the rows run out
--   cur:close(); conn:close(); env:close()
--
-- What the JS side owns, and why it is there rather than here:
--   * Every connection is its own sqlite handle on the database file, so two
--     connections lock each other out and do not see each other's uncommitted
--     work, exactly as two handles on one file do on desktop. Closing a
--     connection rolls back what it never committed (sqlite3_close).
--   * SQL text and every TEXT/BLOB value cross the wasmoon bridge as bytes —
--     armored on the way out (__mudlet_armor, Bridge.lua), a Lua source literal
--     of \DDD escapes on the way back — so latin1 or binary data is stored and
--     read back byte for byte instead of being UTF-8 "repaired" to U+FFFD.
--
-- Environments, connections and cursors are userdata, as they are on desktop:
-- DB.lua branches on `type(cur) == "userdata"`. The methods live on a metatable
-- shared per class and look their object's state up by `self`, which is how the
-- C methods behave (calling one on the wrong object is a type error, not a
-- silent call on whichever object the method was fetched from).

local CURSOR = "SQLite3 cursor"
local CONNECTION = "SQLite3 connection"
local ENVIRONMENT = "SQLite3 environment"
local PREFIX = "LuaSQL: "

local type, tostring, error, select, rawset, unpack, loadstring, setmetatable, getmetatable, newproxy =
      type, tostring, error, select, rawset, unpack, loadstring, setmetatable, getmetatable, newproxy
-- The stock getinfo: argerror counts this file's own frames, which the
-- debug.getinfo Bridge.lua installs would fold into one C frame.
local getinfo = __mudlet_stock_getinfo or (debug and debug.getinfo)

-- Object state, keyed by the userdata. Weak keys, so state goes with its
-- object; Lua 5.1 keeps a key that is being finalized until after its __gc.
local cursors = setmetatable({}, { __mode = "k" })
local connections = setmetatable({}, { __mode = "k" })
local environments = setmetatable({}, { __mode = "k" })

-- luaL_argerror, as lauxlib.c words it. The C functions raise with no position
-- prefix (luaL_where on a C function is empty), hence level 0. `level` is the
-- stack level of the API function relative to this one.
local function argerror(level, narg, extramsg)
    local ar = getinfo and getinfo(level + 1, "n")
    local name = ar and ar.name
    if ar and ar.namewhat == "method" then
        narg = narg - 1
        if narg == 0 then
            error("calling '" .. tostring(name) .. "' on bad self (" .. extramsg .. ")", 0)
        end
    end
    error("bad argument #" .. narg .. " to '" .. (name or "?") .. "' (" .. extramsg .. ")", 0)
end

-- luaL_typerror's "X expected, got Y", where an absent argument is "no value".
local function typename(present, v)
    if not present then return "no value" end
    return type(v)
end

-- luaL_checkudata + the closed check every method makes first.
local function checkobject(store, kind, what, level, nargs, self)
    local st = store[self]
    if st == nil then
        argerror(level + 1, 1, kind .. " expected, got " .. typename(nargs >= 1, self))
    end
    if st.closed then
        argerror(level + 1, 1, PREFIX .. what .. " is closed")
    end
    return st
end

-- luaL_checkstring: a string, or a number in its %.14g spelling.
local function checkstring(level, narg, present, v)
    local t = type(v)
    if t == "string" then return v end
    if t == "number" then return tostring(v) end
    argerror(level + 1, narg, "string expected, got " .. typename(present, v))
end

-- The bridge hands back results as Lua source (one loadstring instead of one
-- boundary crossing per cell); a parse failure would be a bridge bug.
local function evalsource(src)
    local fn, err = loadstring(src, "=luasql")
    if not fn then error(PREFIX .. "internal error: " .. tostring(err), 0) end
    return fn()
end

-- Created at the bottom, once the method tables exist.
local cursor_proto, connection_proto

-- ── Cursor ────────────────────────────────────────────────────────────────

-- cur_nullify: the cursor is closed, its connection's count of open cursors
-- drops, and the statement (and any read lock it holds) is let go.
local function nullify_cursor(st)
    st.closed = true
    st.rows = nil
    local conn = st.conn
    conn.cur_counter = conn.cur_counter - 1
    if st.needs_release and not __luasql_dead then
        __sql_cursor_close(st.id)
    end
    st.needs_release = false
end

local cursor_methods = {}

function cursor_methods.fetch(...)
    local self, t, mode = ...
    local nargs = select("#", ...)
    local st = checkobject(cursors, CURSOR, "cursor", 1, nargs, self)
    if st.rows == nil then
        -- The first fetch runs the statement, as desktop's does (execute only
        -- stepped it to learn its shape, then reset it). From here until the
        -- rows run out, the cursor holds its read lock like a live statement.
        local rows, err, needs_release = evalsource(__sql_cursor_fetch(st.id))
        st.rows, st.n, st.err, st.needs_release = rows, #rows, err, needs_release
    end
    local pos = st.pos + 1
    if pos > st.n then
        -- the step that found no row finalizes the statement and closes the cursor
        local err = st.err
        nullify_cursor(st)
        if err then return nil, err end
        return nil
    end
    st.pos = pos
    local row = st.rows[pos]
    local ncols = st.numcols
    if type(t) == "table" then
        if mode == nil then
            mode = "n"
        elseif type(mode) == "number" then
            mode = tostring(mode)
        elseif type(mode) ~= "string" then
            argerror(1, 3, "string expected, got " .. type(mode))
        end
        if mode:find("n", 1, true) then
            for i = 1, ncols do rawset(t, i, row[i]) end
        end
        if mode:find("a", 1, true) then
            local names = st.colnames
            for i = 1, ncols do rawset(t, names[i], row[i]) end
        end
        return t
    end
    return unpack(row, 1, ncols)
end

function cursor_methods.close(...)
    local self = ...
    local st = cursors[self]
    if st == nil then
        argerror(1, 1, CURSOR .. " expected, got " .. typename(select("#", ...) >= 1, self))
    end
    if st.closed then return false end
    nullify_cursor(st)
    return true
end

-- The same table every time, as desktop keeps it in the registry.
function cursor_methods.getcolnames(...)
    local self = ...
    return checkobject(cursors, CURSOR, "cursor", 1, select("#", ...), self).colnames
end

function cursor_methods.getcoltypes(...)
    local self = ...
    return checkobject(cursors, CURSOR, "cursor", 1, select("#", ...), self).coltypes
end

local function cursor_gc(self)
    local st = cursors[self]
    if st ~= nil and not st.closed then nullify_cursor(st) end
end

-- ── Connection ────────────────────────────────────────────────────────────

local connection_methods = {}

local function close_connection(st)
    st.closed = true
    if not __luasql_dead then __sql_close(st.id) end
end

function connection_methods.execute(...)
    local self, statement = ...
    local nargs = select("#", ...)
    local st = checkobject(connections, CONNECTION, "connection", 1, nargs, self)
    statement = checkstring(1, 2, nargs >= 2, statement)
    local r = __sql_exec(st.id, __mudlet_armor(statement))
    if type(r) == "number" then return r end
    local id, colnames, coltypes = evalsource(r)
    if id == nil then return nil, colnames end -- nil, "LuaSQL: <why>"
    st.cur_counter = st.cur_counter + 1
    local cur = newproxy(cursor_proto)
    cursors[cur] = {
        id = id, conn = st, connobj = self, closed = false,
        numcols = #colnames, colnames = colnames, coltypes = coltypes,
        pos = 0, rows = nil, needs_release = true,
    }
    return cur
end

-- sqlite3_mprintf("%q") of luaL_checklstring: quotes doubled, and %q stops at
-- the first NUL. It never looks at the connection, closed or not.
function connection_methods.escape(...)
    local self, from = ...
    from = checkstring(1, 2, select("#", ...) >= 2, from)
    return (from:match("^[^%z]*"):gsub("'", "''"))
end

local function run_script(st, sql)
    local err = __sql_script(st.id, sql)
    if err ~= nil then return nil, PREFIX .. __mudlet_unarmor(err) end
    return true
end

-- With autocommit off desktop re-opens the transaction in the same breath, and
-- with it on, a COMMIT outside any transaction is SQLite's own error.
function connection_methods.commit(...)
    local self = ...
    local st = checkobject(connections, CONNECTION, "connection", 1, select("#", ...), self)
    return run_script(st, st.auto_commit and "COMMIT" or "COMMIT;BEGIN")
end

function connection_methods.rollback(...)
    local self = ...
    local st = checkobject(connections, CONNECTION, "connection", 1, select("#", ...), self)
    return run_script(st, st.auto_commit and "ROLLBACK" or "ROLLBACK;BEGIN")
end

-- Turning autocommit back on ROLLS BACK the open transaction, ignoring errors;
-- turning it off opens one, and a failure to (one already open) raises.
function connection_methods.setautocommit(...)
    local self, on = ...
    local st = checkobject(connections, CONNECTION, "connection", 1, select("#", ...), self)
    if on then
        st.auto_commit = true
        __sql_script(st.id, "ROLLBACK")
    else
        st.auto_commit = false
        local err = __sql_script(st.id, "BEGIN")
        if err ~= nil then error(PREFIX .. __mudlet_unarmor(err), 0) end
    end
    return true
end

function connection_methods.getlastautoid(...)
    local self = ...
    local st = checkobject(connections, CONNECTION, "connection", 1, select("#", ...), self)
    return __sql_lastid(st.id)
end

-- conn_close → conn_gc: refused (raised, the connection stays open) while a
-- cursor is open; false when already closed.
function connection_methods.close(...)
    local self = ...
    local st = connections[self]
    if st == nil then
        argerror(1, 1, CONNECTION .. " expected, got " .. typename(select("#", ...) >= 1, self))
    end
    if st.closed then return false end
    if st.cur_counter > 0 then error(PREFIX .. "there are open cursors", 0) end
    close_connection(st)
    return true
end

local function connection_gc(self)
    local st = connections[self]
    -- a cursor holds its connection, so by the time a connection is garbage
    -- every cursor on it has been finalized already
    if st ~= nil and not st.closed then close_connection(st) end
end

-- ── Environment ───────────────────────────────────────────────────────────

local environment_methods = {}

-- env:connect(path [, busy_timeout [, read_only]]). A path containing
-- ":memory:" is a private in-memory database, as SQLITE_OPEN_MEMORY makes it.
-- The busy timeout is not applied: sqlite here runs on the page's only
-- thread, where waiting for a lock to clear would wait forever.
function environment_methods.connect(...)
    local self, sourcename, _, readonly = ...
    local nargs = select("#", ...)
    checkobject(environments, ENVIRONMENT, "environment", 1, nargs, self)
    sourcename = checkstring(1, 2, nargs >= 2, sourcename)
    local id = __sql_open(sourcename, readonly == true)
    if type(id) ~= "number" then return nil, PREFIX .. tostring(id) end
    local conn = newproxy(connection_proto)
    connections[conn] = {
        id = id, env = self, closed = false, auto_commit = true, cur_counter = 0,
    }
    return conn
end

function environment_methods.close(...)
    local self = ...
    local st = environments[self]
    if st == nil then
        argerror(1, 1, ENVIRONMENT .. " expected, got " .. typename(select("#", ...) >= 1, self))
    end
    if st.closed then return false end
    st.closed = true
    return true
end

local function environment_gc(self)
    local st = environments[self]
    if st ~= nil then st.closed = true end
end

-- ── Classes and module ────────────────────────────────────────────────────

local function makeproto(kind, store, methods, gc)
    local proto = newproxy(true)
    local mt = getmetatable(proto)
    local function describe(self)
        local st = store[self]
        if st == nil or st.closed then return kind .. " (closed)" end
        -- %p of the object, as luasql prints it: the stock tostring() of the
        -- userdata, read with this __tostring briefly out of the way
        mt.__tostring = nil
        local raw = tostring(self)
        mt.__tostring = describe
        return kind .. " (" .. (raw:match("0x%x+") or raw:match(": (.+)$") or raw) .. ")"
    end
    mt.__index = methods
    mt.__gc = gc
    mt.__tostring = describe
    mt.__metatable = PREFIX .. "you're not allowed to get this metatable"
    return proto
end

cursor_proto = makeproto(CURSOR, cursors, cursor_methods, cursor_gc)
connection_proto = makeproto(CONNECTION, connections, connection_methods, connection_gc)
local environment_proto = makeproto(ENVIRONMENT, environments, environment_methods, environment_gc)

local mod = {
    sqlite3 = function()
        local env = newproxy(environment_proto)
        environments[env] = { closed = false }
        return env
    end,
    _COPYRIGHT = "Copyright (C) 2003-2020 Kepler Project",
    _DESCRIPTION = "LuaSQL is a simple interface from Lua to a DBMS",
    _VERSION = "LuaSQL 2.6.0 (for Lua 5.1)",
    _CLIENTVERSION = __sql_version,
}

-- Populate both package.preload (so `require("luasql.sqlite3")` works) and
-- package.loaded (so DB.lua's `if package.loaded[...]` check passes without a
-- prior require).
package.preload["luasql.sqlite3"] = function() return mod end
package.loaded["luasql.sqlite3"] = mod
