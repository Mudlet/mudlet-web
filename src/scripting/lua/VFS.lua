-- VFS.lua: io + lfs + dofile backed by the profile virtual filesystem
do
    local _open        = __vfs_io_open__
    local _read        = __vfs_io_read__
    local _write_fn    = __vfs_io_write__
    local _seek        = __vfs_io_seek__
    local _close_fn    = __vfs_io_close__
    local _exists      = __vfs_exists__
    local _err         = __vfs_err__
    local _profile_dir = __vfs_profile_dir__
    local _os_remove   = __vfs_os_remove__
    local _os_rename   = __vfs_os_rename__
    local _chdir       = __vfs_lfs_chdir__
    local _currentdir  = __vfs_lfs_currentdir__
    local _mkdir       = __vfs_lfs_mkdir__
    local _rmdir       = __vfs_lfs_rmdir__
    local _dir_list    = __vfs_lfs_dir__
    local _stat        = __vfs_lfs_stat__

    __vfs_io_open__        = nil
    __vfs_io_read__        = nil
    __vfs_io_write__       = nil
    __vfs_io_seek__        = nil
    __vfs_io_close__       = nil
    __vfs_exists__         = nil
    __vfs_err__            = nil
    __vfs_profile_dir__    = nil
    __vfs_os_remove__      = nil
    __vfs_os_rename__      = nil
    __vfs_lfs_chdir__      = nil
    __vfs_lfs_currentdir__ = nil
    __vfs_lfs_mkdir__      = nil
    __vfs_lfs_rmdir__      = nil
    __vfs_lfs_dir__        = nil
    __vfs_lfs_stat__       = nil

    local _handles = {}

    -- The wasmoon Lua↔JS string bridge is UTF-8-based: crossing it truncates
    -- at NUL bytes and mangles 0x80–0xFF, so binary file content would corrupt.
    -- Every io payload therefore crosses "armored" as pure ASCII: a marker
    -- byte (\2 = raw, \1 = encoded) plus the data with NUL / '%' / high bytes
    -- as %XX escapes. The JS hooks in LuaRuntime.setupVFS mirror the scheme.
    local ENC, RAW = string.char(1), string.char(2)

    -- Both directions run over whole-file payloads, so neither may pay a Lua
    -- function call per escaped byte: reading a multi-megabyte file that way
    -- costs millions of calls and wedges the main thread for minutes (the
    -- f2ce-tools map-database import froze exactly here). gsub also accepts a
    -- replacement *table*, which it resolves in C, so precompute both maps once.
    -- The decode table carries all four case spellings of each byte since the
    -- pattern matches %x%x case-insensitively.
    local _char2hex, _hex2char = {}, {}
    for b = 0, 255 do
        local c  = string.char(b)
        local up = string.format('%02X', b)
        local lo = string.format('%02x', b)
        _char2hex[c] = '%' .. up
        _hex2char[up] = c
        _hex2char[lo] = c
        _hex2char[up:sub(1, 1) .. lo:sub(2, 2)] = c
        _hex2char[lo:sub(1, 1) .. up:sub(2, 2)] = c
    end

    local function _armor(s)
        if s:find('[%z%%\128-\255]') then
            return ENC .. s:gsub('[%z%%\128-\255]', _char2hex)
        end
        return RAW .. s
    end
    local function _unarmor(s)
        local payload = s:sub(2)
        if s:sub(1, 1) == RAW then return payload end
        return (payload:gsub('%%(%x%x)', _hex2char))
    end

    local function _make_handle(id)
        local mt = {
            __index = {
                read = function(self, fmt, ...)
                    local formats = {fmt or '*l', ...}
                    local out = {}
                    for i = 1, #formats do
                        local v = _read(id, formats[i])
                        if type(v) == 'string' then v = _unarmor(v) end
                        out[i] = v
                    end
                    return unpack(out)
                end,
                write = function(self, ...)
                    local args = {...}
                    for i = 1, #args do
                        local e = _write_fn(id, _armor(tostring(args[i])))
                        if e then return nil, e end
                    end
                    return self
                end,
                close = function(self)
                    local e = _close_fn(id)
                    _handles[id] = nil
                    if e then return nil, e end
                    return true
                end,
                seek = function(self, whence, offset)
                    local pos = _seek(id, whence or 'cur', offset or 0)
                    if pos == nil then return nil, _err() end
                    return pos
                end,
                lines = function(self)
                    return function()
                        local line = _read(id, '*l')
                        if line == nil then self:close() return nil end
                        return _unarmor(line)
                    end
                end,
                flush = function(self) return self end,
            },
            __tostring = function() return 'file (0x' .. string.format('%x', id) .. ')' end,
        }
        local f = {}
        setmetatable(f, mt)
        _handles[id] = f
        return f
    end

    local _default_output, _default_input

    local function _is_handle(obj)
        if type(obj) ~= 'table' then return false end
        for _, h in pairs(_handles) do
            if h == obj then return true end
        end
        return false
    end

    io = {
        open = function(filename, mode)
            local id = _open(tostring(filename), mode or 'r')
            if not id then return nil, _err() end
            return _make_handle(id)
        end,

        close = function(file)
            if file then return file:close() end
        end,

        lines = function(filename, fmt)
            if not filename then
                error('io.lines without filename not supported', 2)
            end
            local f, e = io.open(filename, 'r')
            if not f then error(e, 2) end
            fmt = fmt or '*l'
            return function()
                local v = f:read(fmt)
                if v == nil then f:close() end
                return v
            end
        end,

        output = function(file)
            if file == nil then return _default_output end
            if type(file) == 'string' then
                local f, e = io.open(file, 'w')
                if not f then error(e, 2) end
                _default_output = f
            elseif _is_handle(file) then
                _default_output = file
            else
                error('bad argument to io.output (file expected)', 2)
            end
            return _default_output
        end,

        input = function(file)
            if file == nil then return _default_input end
            if type(file) == 'string' then
                local f, e = io.open(file, 'r')
                if not f then error(e, 2) end
                _default_input = f
            elseif _is_handle(file) then
                _default_input = file
            else
                error('bad argument to io.input (file expected)', 2)
            end
            return _default_input
        end,

        read = function(...)
            if _default_input then return _default_input:read(...) end
            error('io.read (stdin) not supported; set io.input(file) first', 2)
        end,

        write = function(...)
            if _default_output then return _default_output:write(...) end
            error('io.write (stdout) not supported; use echo() or set io.output(file) first', 2)
        end,

        type = function(obj)
            if not _is_handle(obj) then
                if type(obj) == 'table' then return 'closed file' end
                return nil
            end
            return 'file'
        end,
    }

    lfs = {
        currentdir = function()
            return _currentdir()
        end,

        chdir = function(path)
            local ok = _chdir(tostring(path))
            if not ok then return nil, _err() end
            return true
        end,

        mkdir = function(path)
            local ok = _mkdir(tostring(path))
            if not ok then return nil, _err() end
            return true
        end,

        rmdir = function(path)
            local ok = _rmdir(tostring(path))
            if not ok then return nil, _err() end
            return true
        end,

        -- returns iterator: each call yields the next entry name, nil when done
        dir = function(path)
            local entries = _dir_list(tostring(path))
            if entries == nil then return nil, _err() end
            -- entries is a 0-indexed JS array
            local i = -1
            return function()
                i = i + 1
                return entries[i]
            end
        end,

        -- attrib: optional string key to return a single attribute value
        attributes = function(path, attrib)
            local s = _stat(tostring(path))
            if not s then return nil end
            local t = {
                mode         = s.type == 'dir' and 'directory' or 'file',
                size         = s.size,
                modification = s.modification,
                access       = s.access,
            }
            if attrib then return t[attrib] end
            return t
        end,

        touch = function(path)
            if not _exists(tostring(path)) then
                local f, e = io.open(path, 'w')
                if not f then return nil, e end
                f:close()
            end
            return true
        end,

        isfile = function(path)
            local s = _stat(tostring(path))
            return s ~= nil and s.type == 'file'
        end,

        isdir = function(path)
            local s = _stat(tostring(path))
            return s ~= nil and s.type == 'dir'
        end,
    }

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
            return nil, _err()
        end
        return true
    end

    os.rename = function(old, new)
        if not _os_rename(tostring(old), tostring(new)) then
            return nil, _err()
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
        }
    end
end
