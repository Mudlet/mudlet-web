-- User-code sandbox. Compile the chunk and run it protected so a runtime
-- error returns as (errmsg, nil) instead of unwinding through wasmoon's
-- bridge. Returns (err, result).
--
-- __mudlet_pcall_co (Bridge.lua) instead of pcall: pcall is a C frame, and a
-- handler suspending itself via invokeFileDialog must be able to yield from
-- here to the JS resume boundary (Lua 5.1 can't yield across C frames).
--
-- `chunkname`, when given, is used as is — Mudlet names a script's chunk
-- "Script: <name>", which Lua reports as [string "Script: <name>"]:LINE: —
-- and otherwise the name is treated as a file ("@name" reports as name:LINE:).
function __exec(code, name, chunkname)
    local fn, compile_err = loadstring(code, chunkname or ("@" .. name))
    if not fn then
        return compile_err, nil
    end
    local ok, result = __mudlet_pcall_co(fn)
    if not ok then
        return tostring(result), nil
    end
    return nil, result
end

-- Compile without running: the error Lua gives for code that will not load, or
-- nil when it does. What a trigger's body is checked with as it is installed,
-- since unlike a script's it does not run until its pattern matches.
function __mudlet_syntax_error(code, chunkname)
    local fn, err = loadstring(code, chunkname)
    if fn then return nil end
    return err
end
