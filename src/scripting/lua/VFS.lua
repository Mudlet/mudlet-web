-- VFS.lua: io + lfs + dofile backed by the profile virtual filesystem
do
    local _open        = __vfs_io_open__
    local _read        = __vfs_io_read__
    local _write_fn    = __vfs_io_write__
    local _seek        = __vfs_io_seek__
    local _close_fn    = __vfs_io_close__
    local _exists      = __vfs_exists__
    local _err         = __vfs_err__
    local _errno       = __vfs_errno__
    local _profile_dir = __vfs_profile_dir__
    local _os_remove   = __vfs_os_remove__
    local _os_rename   = __vfs_os_rename__
    local _chdir       = __vfs_lfs_chdir__
    local _currentdir  = __vfs_lfs_currentdir__
    local _mkdir       = __vfs_lfs_mkdir__
    local _rmdir       = __vfs_lfs_rmdir__
    local _dir_list    = __vfs_lfs_dir__
    local _stat        = __vfs_lfs_stat__
    local _touch       = __vfs_lfs_touch__

    __vfs_io_open__        = nil
    __vfs_io_read__        = nil
    __vfs_io_write__       = nil
    __vfs_io_seek__        = nil
    __vfs_io_close__       = nil
    __vfs_exists__         = nil
    __vfs_err__            = nil
    __vfs_errno__          = nil
    __vfs_profile_dir__    = nil
    __vfs_os_remove__      = nil
    __vfs_os_rename__      = nil
    __vfs_lfs_chdir__      = nil
    __vfs_lfs_currentdir__ = nil
    __vfs_lfs_mkdir__      = nil
    __vfs_lfs_rmdir__      = nil
    __vfs_lfs_dir__        = nil
    __vfs_lfs_stat__       = nil
    __vfs_lfs_touch__      = nil

    -- A failed call answers the way stock Lua's io/os and LuaFileSystem do:
    -- nil, the message, and the errno (nil when the failure has none).
    local function _fail()
        return nil, _err(), _errno()
    end

    -- Every io payload crosses the wasmoon bridge "armored" as pure ASCII,
    -- because that bridge is UTF-8-based and would otherwise truncate binary
    -- content at NUL and mangle 0x80–0xFF. The scheme, and why it is written the
    -- way it is, lives in Bridge.lua next to __mudlet_armor; the JS hooks in
    -- LuaRuntime mirror it. Taken as locals here so the hot read/write paths do
    -- a local lookup rather than a global one.
    local _armor, _unarmor = __mudlet_armor, __mudlet_unarmor

    local function argError(n, fname, msg)
        error("bad argument #" .. n .. " to '" .. fname .. "' (" .. msg .. ")")
    end

    -- luaL_checkstring: a string, or a number as one.
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
        return x >= 0 and math.floor(x) or -math.floor(-x)
    end

    -- luaL_checkoption
    local function checkOption(v, n, fname, default, options)
        if v == nil then v = default end
        local s = type(v) == 'string' and v or (type(v) == 'number' and tostring(v)) or nil
        if s == nil then argError(n, fname, "string expected, got " .. (v == nil and 'no value' or type(v))) end
        for _, o in ipairs(options) do if o == s then return s end end
        argError(n, fname, "invalid option '" .. s .. "'")
    end

    -- ── File handles ─────────────────────────────────────────────────────────
    -- Lua 5.1's liolib, over the VFS. A handle is userdata, as it is on
    -- desktop (type(io.stdout) == "userdata"), sharing one metatable whose
    -- __index holds the methods; what each one refers to lives in `files`.
    --   kind 'vfs'    — a VFS file (or io.tmpfile()'s unnamed one), by JS id
    --   kind 'stdin'  — always at end of file
    --   kind 'stdout' / 'stderr' — the process streams desktop writes to; here
    --                   the browser console (see __mudlet_stdio_write)
    local _tmpfile = __vfs_io_tmpfile__
    local _stdio = __mudlet_stdio_write
    __vfs_io_tmpfile__, __mudlet_stdio_write = nil, nil

    local files = setmetatable({}, { __mode = 'k' })
    local proto = newproxy(true)
    local fmeta = getmetatable(proto)
    local methods = {}
    fmeta.__index = methods
    fmeta.__tostring = function(f)
        local st = files[f]
        if st == nil or st.closed then return 'file (closed)' end
        return st.label
    end
    local nextLabel = 0x5a0
    local function newFile(kind, id, mode)
        local f = newproxy(proto)
        nextLabel = nextLabel + 0x1e0
        local readable = mode == nil or mode:sub(1, 1) == 'r' or mode:find('+', 1, true) ~= nil
        local writable = mode == nil or mode:sub(1, 1) ~= 'r' or mode:find('+', 1, true) ~= nil
        files[f] = {
            kind = kind, id = id, closed = false,
            readable = kind ~= 'stdout' and kind ~= 'stderr' and readable,
            writable = kind ~= 'stdin' and writable,
            label = string.format('file (0x%x)', nextLabel),
        }
        return f
    end

    local EBADF_MSG, EBADF = 'Bad file descriptor', 9

    -- tofile: a FILE* that is still open.
    local function tofile(f, n, fname)
        local st = files[f]
        if st == nil then
            argError(n, fname, "FILE* expected, got " .. (f == nil and 'no value' or type(f)))
        end
        if st.closed then error("attempt to use a closed file") end
        return st
    end

    -- One read format. Returns the value, or nil at end of file; a handle that
    -- can't be read at all returns false.
    local function readOne(st, fmt)
        if not st.readable then return false end
        if st.kind ~= 'vfs' then return nil end
        local v = _read(st.id, fmt)
        if type(v) == 'string' then v = _unarmor(v) end
        return v
    end

    -- g_read: each format in turn, stopping at the first that fails (its slot
    -- comes back nil); a stream error is nil, message, errno instead.
    local function g_read(st, ...)
        local n = select('#', ...)
        if n == 0 then
            local v = readOne(st, '*l')
            if v == false then return nil, EBADF_MSG, EBADF end
            return v
        end
        local out = {}
        for i = 1, n do
            local fmt = select(i, ...)
            local v
            if type(fmt) == 'number' then
                v = readOne(st, fmt)
            else
                if type(fmt) ~= 'string' or fmt:sub(1, 1) ~= '*' then argError(i, 'read', 'invalid option') end
                local c = fmt:sub(2, 2)
                if c ~= 'n' and c ~= 'l' and c ~= 'a' then argError(i, 'read', 'invalid format') end
                v = readOne(st, '*' .. c)
            end
            if v == false then return nil, EBADF_MSG, EBADF end
            out[i] = v
            if v == nil then return unpack(out, 1, i) end
        end
        return unpack(out, 1, n)
    end

    -- g_write: numbers as "%.14g", strings as they are, anything else an
    -- argument error. Lua 5.1 answers true (not the file — that is 5.2).
    local function g_write(st, fname, ...)
        local n = select('#', ...)
        local ok = true
        for i = 1, n do
            local v = select(i, ...)
            local t = type(v)
            local s
            if t == 'number' then
                s = string.format('%.14g', v)
            elseif t == 'string' then
                s = v
            else
                argError(i, fname, "string expected, got " .. (v == nil and 'nil' or t))
            end
            if ok then
                if not st.writable then
                    ok = false
                elseif st.kind == 'vfs' then
                    ok = _write_fn(st.id, _armor(s)) == nil
                else
                    _stdio(st.kind == 'stderr' and 2 or 1, _armor(s))
                end
            end
        end
        if not ok then return nil, EBADF_MSG, EBADF end
        return true
    end

    local function closeFile(st)
        if st.kind ~= 'vfs' then
            return nil, 'cannot close standard file'
        end
        local e = _close_fn(st.id)
        st.closed = true
        if e then return nil, e end
        return true
    end

    function methods.read(f, ...)
        return g_read(tofile(f, 1, 'read'), ...)
    end

    function methods.write(f, ...)
        return g_write(tofile(f, 1, 'write'), 'write', ...)
    end

    function methods.close(f)
        return closeFile(tofile(f, 1, 'close'))
    end

    function methods.flush(f)
        tofile(f, 1, 'flush')
        return true
    end

    function methods.seek(f, whence, offset)
        local st = tofile(f, 1, 'seek')
        whence = checkOption(whence, 1, 'seek', 'cur', { 'set', 'cur', 'end' })
        offset = optInteger(offset, 2, 'seek', 0)
        if st.kind ~= 'vfs' then return nil, 'Illegal seek', 29 end
        local pos = _seek(st.id, whence, offset)
        if pos == nil then return _fail() end
        return pos
    end

    function methods.setvbuf(f, mode, size)
        tofile(f, 1, 'setvbuf')
        checkOption(mode, 1, 'setvbuf', nil, { 'no', 'full', 'line' })
        optInteger(size, 2, 'setvbuf', 0)
        return true
    end

    -- f:lines(): an iterator over the rest of the file. Unlike io.lines(name)
    -- it leaves the file open at the end.
    function methods.lines(f)
        tofile(f, 1, 'lines')
        return function()
            local st = files[f]
            if st.closed then error("file is already closed") end
            local v = readOne(st, '*l')
            if v == false then error(EBADF_MSG) end
            return v
        end
    end

    local current = {}
    local function iofile(which)
        local f = current[which]
        if files[f].closed then error("standard " .. which .. " file is closed") end
        return f, files[f]
    end

    local function openFile(filename, mode)
        local base = mode:sub(1, 1)
        if base ~= 'r' and base ~= 'w' and base ~= 'a' then
            -- glibc's fopen accepts nothing else as the first mode character.
            return nil, filename .. ': Invalid argument', 22
        end
        -- The rest of the mode as glibc reads it: up to six more characters,
        -- stopping at the end or a ','; '+' opens for update, 'x' exclusively.
        local plus, excl = false, false
        for k = 2, 7 do
            local c = mode:sub(k, k)
            if c == '' or c == ',' then break end
            if c == '+' then plus = true elseif c == 'x' then excl = true end
        end
        if excl and base ~= 'r' and _exists(filename) then
            return nil, filename .. ': File exists', 17
        end
        local m = base .. (plus and '+' or '')
        local id = _open(filename, m)
        if not id then return _fail() end
        return newFile('vfs', id, m)
    end

    local function g_iofile(which, fname, mode, file)
        if file ~= nil then
            if type(file) == 'string' or type(file) == 'number' then
                local name = tostring(file)
                local f, msg = openFile(name, mode)
                if not f then argError(1, fname, msg) end
                current[which] = f
            else
                tofile(file, 1, fname)
                current[which] = file
            end
        end
        return current[which]
    end

    io = {
        stdin = newFile('stdin', nil, 'r'),
        stdout = newFile('stdout', nil, 'w'),
        stderr = newFile('stderr', nil, 'w'),

        open = function(filename, mode)
            filename = checkString(filename, 1, 'open')
            mode = mode == nil and 'r' or checkString(mode, 2, 'open')
            return openFile(filename, mode)
        end,

        -- io.close([file]): with no file, the default output.
        close = function(...)
            local f = ...
            if select('#', ...) == 0 then f = current.output end
            return closeFile(tofile(f, 1, 'close'))
        end,

        -- io.lines([filename]): with no name, the default input, left open;
        -- with one, that file, closed at the end.
        lines = function(filename)
            if filename == nil then
                local f = iofile('input')
                return methods.lines(f)
            end
            filename = checkString(filename, 1, 'lines')
            local f, msg = openFile(filename, 'r')
            if not f then argError(1, 'lines', msg) end
            return function()
                local st = files[f]
                if st.closed then error("file is already closed") end
                local v = readOne(st, '*l')
                if v == nil then closeFile(st) end
                return v
            end
        end,

        input = function(file) return g_iofile('input', 'input', 'r', file) end,
        output = function(file) return g_iofile('output', 'output', 'w', file) end,

        read = function(...)
            local _, st = iofile('input')
            return g_read(st, ...)
        end,

        write = function(...)
            local _, st = iofile('output')
            return g_write(st, 'write', ...)
        end,

        flush = function()
            iofile('output')
            return true
        end,

        -- An unnamed file that is gone once closed.
        tmpfile = function()
            local id = _tmpfile()
            if not id then return _fail() end
            return newFile('vfs', id, 'w+')
        end,

        -- A browser can't start a process: what a Lua built without popen says.
        popen = function()
            error("'popen' not supported")
        end,

        type = function(...)
            if select('#', ...) == 0 then argError(1, 'type', 'value expected') end
            local st = files[(...)]
            if st == nil then return nil end
            if st.closed then return 'closed file' end
            return 'file'
        end,
    }
    current.input, current.output = io.stdin, io.stdout
    -- require "io" hands back this table, as it does on desktop.
    package.loaded.io = io

    -- ── lfs (LuaFileSystem 1.9.0, src/lfs.c) ──────────────────────────────────
    local _lstat    = __vfs_lfs_lstat__
    local _readlink = __vfs_lfs_readlink__
    local _link     = __vfs_lfs_link__
    __vfs_lfs_lstat__, __vfs_lfs_readlink__, __vfs_lfs_link__ = nil, nil, nil

    local MODE_NAMES = { dir = 'directory', file = 'file', link = 'link' }
    local function attributeTable(s)
        return {
            mode         = MODE_NAMES[s.type] or 'other',
            size         = s.size,
            modification = s.modification,
            access       = s.access,
            change       = s.change,
            permissions  = s.permissions,
            dev          = s.dev,
            ino          = s.ino,
            nlink        = s.nlink,
            uid          = s.uid,
            gid          = s.gid,
            rdev         = s.rdev,
            blocks       = s.blocks,
            blksize      = s.blksize,
        }
    end

    -- _file_info_: the whole table, one named field, or the fields written
    -- into a table passed in.
    local function fileInfo(s, attrib)
        local t = attributeTable(s)
        if type(attrib) == 'string' or type(attrib) == 'number' then
            local v = t[tostring(attrib)]
            if v == nil then error("invalid attribute name '" .. tostring(attrib) .. "'") end
            return v
        end
        if type(attrib) == 'table' then
            for k, v in pairs(t) do attrib[k] = v end
            return attrib
        end
        return t
    end

    -- Directory iterators: userdata with next/close, as lfs.dir returns.
    local dirs = setmetatable({}, { __mode = 'k' })
    local dproto = newproxy(true)
    local dmethods = {}
    getmetatable(dproto).__index = dmethods
    local function dirIter(d)
        local st = dirs[d]
        if st == nil then
            argError(1, '(for generator)', "directory metatable expected, got " .. type(d))
        end
        if st.closed then argError(1, '(for generator)', 'closed directory') end
        local name = st.entries[st.i]
        st.i = st.i + 1
        if name == nil then
            st.closed = true
            return
        end
        return name
    end
    dmethods.next = dirIter
    dmethods.close = function(d)
        local st = dirs[d]
        if st then st.closed = true end
    end

    -- lock_dir's lock: userdata with free().
    local locks = setmetatable({}, { __mode = 'k' })
    local lproto = newproxy(true)
    local lmethods = {}
    getmetatable(lproto).__index = lmethods
    lmethods.free = function(l)
        local ln = locks[l]
        if ln then
            _os_remove(ln)
            locks[l] = nil
        end
    end

    -- check_file: an open FILE*, for lock / unlock / setmode.
    local function checkFile(f, fname)
        local st = files[f]
        if st == nil then argError(1, fname, "FILE* expected, got " .. (f == nil and 'no value' or type(f))) end
        if st.closed then error(fname .. ": closed file") end
        return st
    end

    -- A profile's files belong to the one tab that holds its lock, so a
    -- record lock never meets a competing one; what fcntl would still refuse
    -- is a lock the handle's mode can't carry.
    local function fileLock(st, mode, fname)
        local c = mode:sub(1, 1)
        if c ~= 'r' and c ~= 'w' and c ~= 'u' then error(fname .. ": invalid mode") end
        if (c == 'w' and not st.writable) or (c == 'r' and not st.readable) then
            return nil, EBADF_MSG
        end
        return true
    end

    lfs = {
        _VERSION = "LuaFileSystem 1.9.0",
        _DESCRIPTION = "LuaFileSystem is a Lua library developed to complement the set of functions related to file systems offered by the standard Lua distribution",

        currentdir = function()
            return _currentdir()
        end,

        chdir = function(path)
            path = checkString(path, 1, 'chdir')
            local ok = _chdir(path)
            if not ok then
                local reason = _err() == 'not a directory' and 'Not a directory' or 'No such file or directory'
                return nil, "Unable to change working directory to '" .. path .. "'\n" .. reason .. "\n"
            end
            return true
        end,

        mkdir = function(path)
            local ok = _mkdir(checkString(path, 1, 'mkdir'))
            if not ok then return _fail() end
            return true
        end,

        -- Removes an empty directory only, as LuaFileSystem does; anything
        -- else is refused with nil, message, errno.
        rmdir = function(path)
            local ok = _rmdir(checkString(path, 1, 'rmdir'))
            if not ok then return _fail() end
            return true
        end,

        -- lfs.dir(path) → iterator, directory object. A directory that can't
        -- be opened is an error, not a nil.
        dir = function(path)
            path = checkString(path, 1, 'dir')
            local entries = _dir_list(path)
            if entries == nil then error("cannot open " .. path .. ": " .. _err()) end
            -- entries is a 0-indexed JS array
            local d = newproxy(dproto)
            dirs[d] = { entries = entries, i = 0, closed = false }
            return dirIter, d
        end,

        attributes = function(path, attrib)
            local s = _stat(checkString(path, 1, 'attributes'))
            if not s then return _fail() end
            return fileInfo(s, attrib)
        end,

        -- As attributes, but about a symbolic link itself (lstat), with its
        -- target added; attribute "target" is the target alone.
        symlinkattributes = function(path, attrib)
            path = checkString(path, 1, 'symlinkattributes')
            if attrib == 'target' then
                local target = _readlink(path)
                if target == nil then
                    local msg, errno = _err(), _errno()
                    return nil, "could not obtain link target: " .. msg, errno
                end
                return target
            end
            local s = _lstat(path)
            if not s then return _fail() end
            local r = fileInfo(s, attrib)
            if type(r) == 'table' and s.type == 'link' then
                local target = _readlink(path)
                if target ~= nil then r.target = target end
            end
            return r
        end,

        -- lfs.link(old, new [, symlink]): a hard link, or a symbolic one.
        link = function(old, new, symbolic)
            old = checkString(old, 1, 'link')
            new = checkString(new, 2, 'link')
            if not _link(old, new, symbolic and true or false) then return _fail() end
            return true
        end,

        lock = function(fh, mode, start, len)
            local st = checkFile(fh, 'lock')
            mode = checkString(mode, 2, 'lock')
            optInteger(start, 3, 'lock', 0)
            optInteger(len, 4, 'lock', 0)
            return fileLock(st, mode, 'lock')
        end,

        unlock = function(fh, start, len)
            local st = checkFile(fh, 'unlock')
            optInteger(start, 2, 'unlock', 0)
            optInteger(len, 3, 'unlock', 0)
            return fileLock(st, 'u', 'unlock')
        end,

        -- Text and binary mode are the same thing off Windows: LuaFileSystem
        -- reports "binary" either way.
        setmode = function(fh, mode)
            checkFile(fh, 'setmode')
            checkOption(mode, 2, 'setmode', nil, { 'binary', 'text' })
            return true, 'binary'
        end,

        -- lfs.lock_dir(path): the POSIX version, a "lockfile.lfs" symlink in
        -- the directory; fails with nil, message while someone holds it.
        lock_dir = function(path)
            path = checkString(path, 1, 'lock_dir')
            local ln = path .. '/lockfile.lfs'
            if not _link('lock', ln, true) then return nil, _err() end
            local l = newproxy(lproto)
            locks[l] = ln
            return l
        end,

        -- Sets the access and modification times; like LuaFileSystem it never
        -- creates the file. With no times given both become now; a missing
        -- mtime takes atime's value.
        touch = function(path, ...)
            path = checkString(path, 1, 'touch')
            local atime, mtime
            if select('#', ...) == 0 then
                atime = os.time()
                mtime = atime
            else
                local a, m = ...
                atime = tonumber(a) or 0
                mtime = tonumber(m) or atime
            end
            if not _touch(path, atime, mtime) then return _fail() end
            return true
        end,

        -- Not in LuaFileSystem; kept for scripts written against Mudlet Web.
        isfile = function(path)
            local s = _stat(tostring(path))
            return s ~= nil and s.type == 'file'
        end,

        isdir = function(path)
            local s = _stat(tostring(path))
            return s ~= nil and s.type == 'dir'
        end,
    }
    package.loaded.lfs = lfs

    function getMudletHomeDir()
        return _profile_dir()
    end

    -- Lua's LUA_IDSIZE = 60 truncates `short_src` in error/traceback formatting,
    -- producing `...<tail>` for long chunknames. The profile root prefix
    -- `/profiles/<uuid>/` alone burns ~48 chars, so VFS-loaded files almost
    -- always get chopped. Strip the prefix so chunknames are VFS-relative and
    -- the error renderer can match them as hyperlinkable paths.
    local function _short_chunkname(path)
        local prefix = _profile_dir() .. '/'
        if path:sub(1, #prefix) == prefix then
            return path:sub(#prefix + 1)
        end
        return path
    end

    -- Seed package.path with the profile directory so vanilla require() works,
    -- and so user scripts can prepend extra patterns (Mudlet idiom):
    --   package.path = getMudletHomeDir() .. "/foo/?.lua;" .. package.path
    package.path = string.format(
        "%s/?.lua;%s/?/init.lua;%s",
        _profile_dir(), _profile_dir(), package.path or ""
    )

    -- VFS-backed require loader: walk package.path patterns and try each one
    -- through io.open (which is wired to the VFS above). Mirrors Lua's default
    -- loader semantics so package.path edits behave the way Mudlet packages expect.
    table.insert(package.loaders, 2, function(modname)
        local base = modname:gsub("%.", "/")
        local errs = ""
        for pattern in string.gmatch(package.path, "[^;]+") do
            local fullpath = pattern:gsub("%?", base)
            local f = io.open(fullpath, "r")
            if f then
                local code = f:read("*a")
                f:close()
                local fn, ce = loadstring(code, "@" .. _short_chunkname(fullpath))
                if not fn then error(ce) end
                return fn
            end
            errs = errs .. "\n\tno file '" .. fullpath .. "' in VFS"
        end
        return errs
    end)

    function dofile(path)
        local f, e = io.open(path, 'r')
        if not f then error(e, 2) end
        local code = f:read('*a')
        f:close()
        local chunk, ce = loadstring(code, '@' .. _short_chunkname(path))
        if not chunk then error(ce, 2) end
        return chunk()
    end

    function loadfile(path)
        local f, e = io.open(path, 'r')
        if not f then return nil, e end
        local code = f:read('*a')
        f:close()
        return loadstring(code, '@' .. _short_chunkname(path))
    end

    os.remove = function(path)
        if not _os_remove(tostring(path)) then
            return _fail()
        end
        return true
    end

    os.rename = function(old, new)
        if not _os_rename(tostring(old), tostring(new)) then
            return _fail()
        end
        return true
    end

    -- ── zip ──────────────────────────────────────────────────────────────────
    -- Mudlet preloads brimworks' lua-zip as `zip`, a required rock on every
    -- platform, so bundled code indexes it without a guard — LuaGlobal's
    -- unzip() calls zip.open() on line one and the spec corpus unpacks its map
    -- fixtures with it. A nil `zip` is therefore a broken environment rather
    -- than a missing optional.
    --
    -- Lives here rather than in a module of its own because an entry's bytes
    -- have to come back through the same armoring io does: the wasmoon string
    -- bridge truncates at NUL and mangles the high bytes, and an archive is
    -- binary by definition.
    do
        local _zopen  = __zip_open__
        local _znames = __zip_names__
        local _zread  = __zip_read__
        local _zclose = __zip_close__
        __zip_open__, __zip_names__, __zip_read__, __zip_close__ = nil, nil, nil, nil

        -- An entry is read whole and handed out in slices: the archive is
        -- already in memory, so a chunked read is a substring, and callers that
        -- loop until the empty string (which is how lua-zip is used) terminate.
        local function _make_entry(content)
            local pos = 1
            return {
                read = function(self, count)
                    if pos > #content then return nil end
                    local n = tonumber(count)
                    -- lua-zip's read takes a byte count; anything else reads on
                    -- to the end, which is what "*a" means to a caller used to
                    -- io handles.
                    if n == nil or n < 0 then n = #content - pos + 1 end
                    local chunk = content:sub(pos, pos + n - 1)
                    pos = pos + #chunk
                    return chunk
                end,
                close = function() return true end,
                seek = function(self, _, offset) pos = (tonumber(offset) or 0) + 1 return pos - 1 end,
            }
        end

        zip = {
            open = function(path)
                local id = _zopen(tostring(path))
                -- (nil, message) rather than an error: unzip() is written to
                -- report a bad archive to the player, and raising here would
                -- take the whole calling script down instead.
                if id == nil then
                    return nil, "could not open zip archive '" .. tostring(path) .. "'"
                end
                local names = _znames(id)
                local archive
                archive = {
                    open = function(self, name)
                        local content = _zread(id, tostring(name))
                        if content == nil then
                            return nil, "no entry named '" .. tostring(name) .. "' in the archive"
                        end
                        return _make_entry(_unarmor(content))
                    end,
                    close = function(self)
                        _zclose(id)
                        return true
                    end,
                    -- The names, 0-indexed as they cross from JS.
                    files = function(self)
                        local i = 0
                        return function()
                            local name = names[i]
                            i = i + 1
                            if name == nil then return nil end
                            return { filename = name }
                        end
                    end,
                }
                return archive
            end,

            -- zip.OR(...): the flags OR'd together, as lua-zip's S_OR does.
            OR = function(...)
                local result = 0
                for i = select('#', ...), 1, -1 do
                    local v = tonumber((select(i, ...)))
                    if v == nil then
                        error("bad argument #" .. i .. " to 'OR' (number expected, got "
                            .. type((select(i, ...))) .. ")")
                    end
                    v = v >= 0 and math.floor(v) or -math.floor(-v)
                    -- Bitwise OR, one bit at a time: Lua 5.1 has no operator.
                    local r, bit, a, b = 0, 1, result, v
                    while a > 0 or b > 0 do
                        if a % 2 == 1 or b % 2 == 1 then r = r + bit end
                        a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
                    end
                    result = r
                end
                return result
            end,

            -- libzip's flag values, which lua-zip exports under these names.
            CREATE = 1,
            EXCL = 2,
            CHECKCONS = 4,
            FL_NOCASE = 1,
            FL_NODIR = 2,
            FL_COMPRESSED = 4,
            FL_UNCHANGED = 8,
            FL_RECOMPRESS = 16,
        }
        -- Desktop loads it as `zip = require "brimworks.zip"`.
        package.loaded["brimworks.zip"] = zip
    end
end
