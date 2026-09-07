-- User-code sandbox. Compile the chunk and run it protected so a runtime
-- error returns as (errmsg, nil) instead of unwinding through wasmoon's
-- bridge. Returns (err, result).
--
-- __mudlet_pcall_co (Bridge.lua) instead of pcall: pcall is a C frame, and a
-- handler suspending itself via invokeFileDialog must be able to yield from
-- here to the JS resume boundary (Lua 5.1 can't yield across C frames).
function __exec(code, name)
    local fn, compile_err = loadstring(code, "@" .. name)
    if not fn then
        return compile_err, nil
    end
    local ok, result = __mudlet_pcall_co(fn)
    if not ok then
        return tostring(result), nil
    end
    return nil, result
end
