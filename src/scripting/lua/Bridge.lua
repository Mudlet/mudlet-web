matches = {}; multimatches = {}

-- Mudlet's getPath populates these globals (cleared on every call). Predeclare
-- them as empty tables so user code reading them before any getPath call
-- doesn't crash on nil-indexing — Mudlet's C++ side leaves them undefined
-- until first call but most scripts assume they exist.
speedWalkPath, speedWalkDir, speedWalkWeight = {}, {}, {}

-- Mudlet getPath(from, to) — A* over the map graph. Always clears the three
-- speedWalk* globals; on success repopulates them 1-indexed and returns
-- (true, totalWeight). On argument-validation failure returns (nil, errMsg);
-- on no-path returns (false, -1, errMsg) — matching Mudlet's multi-return.
function getPath(from, to)
    speedWalkPath, speedWalkDir, speedWalkWeight = {}, {}, {}
    local res = __getPath(from, to)
    if type(res) == 'string' then
        return nil, res
    end
    if type(res) ~= 'table' then
        return false, -1,
            "getPath: no path found from the roomID " .. tostring(from)
            .. " to roomID " .. tostring(to) .. "!"
    end
    -- JS hands the three step lists over as 0-indexed arrays (wasmoon convention).
    -- Room ids and step weights are stringified to match Mudlet, which fills
    -- these tables from QStringLists built with QString::number (Host.cpp);
    -- speedWalkDir is already made of direction/command strings.
    local p, d, w = res.path, res.dirs, res.weights
    if type(p) == 'table' then
        local i = 0
        while p[i] ~= nil do
            speedWalkPath[i + 1]   = tostring(p[i])
            speedWalkDir[i + 1]    = d[i]
            speedWalkWeight[i + 1] = tostring(w[i])
            i = i + 1
        end
    end
    return true, res.totalWeight or 0
end

-- Mudlet centerview(roomID) — center the map on a room and set it as the
-- player's current room (getPlayerRoom). On an unknown room id Mudlet does not
-- move the view or touch the player room; it returns (nil, errMsg). The JS side
-- returns false in that case, so translate it here.
function centerview(roomID)
    if __centerview(roomID) then
        return true
    end
    return nil, "centerview: number " .. tostring(roomID) .. " is not a valid room id."
end

-- Mudlet Host::startSpeedWalk — hand an assembled path over to the mapper.
-- Mudlet never walks a path itself: gotoRoom and the 2D map's double-click
-- gesture both fill speedWalkPath/Dir/Weight and then call the global
-- doSpeedWalk, which a mapper package defines (mudlet-mapper.xml,
-- generic_mapper.xml) and which owns the pacing, balance/lag checks, off-path
-- recovery and the arrival message. Mudlet's mLuaInterpreter.call swallows an
-- error raised in there (it lands in the error console) and the caller still
-- returns its own result, so pcall + printError here.
function __mudix_do_speedwalk()
    if type(doSpeedWalk) ~= 'function' then
        -- No mapper package installed, so nothing owns the walk. Mudlet errors
        -- with "attempt to call a nil value" and the player simply doesn't
        -- move; mudix instead sends the directions in order — what gotoRoom did
        -- before it delegated — so mapper-less profiles keep working.
        for i = 1, #speedWalkDir do
            send(speedWalkDir[i])
        end
        return
    end
    local ok, err = pcall(doSpeedWalk)
    if not ok then
        printError("doSpeedWalk: " .. tostring(err))
    end
end

-- Mudlet gotoRoom(targetRoomID) — pathfind from the player's current room to
-- the target and hand the path to the mapper (TLuaInterpreter::gotoRoom →
-- Host::startSpeedWalk). Returns true once the walk is handed over, (nil,
-- errMsg) for an invalid target or an unknown current room, or (false, errMsg)
-- when no path exists.
--
-- Deviation from Mudlet: an unknown current room is reported as such. Mudlet
-- pathfinds from room 0 and reports the generic "no path found"; naming the
-- real cause saves a debugging session, and the value stays falsy either way.
function gotoRoom(targetRoomID)
    local from = getPlayerRoom()
    if not from then
        return nil, "gotoRoom: the current room is unknown (use centerview to set it first)"
    end
    if not roomExists(targetRoomID) then
        return nil, "gotoRoom: number " .. tostring(targetRoomID) .. " is not a valid target roomID"
    end
    local ok = getPath(from, targetRoomID)
    if not ok then
        speedWalkPath, speedWalkDir, speedWalkWeight = {}, {}, {}
        return false, "gotoRoom: no path found from current room to room with id " .. tostring(targetRoomID)
    end
    __mudix_do_speedwalk()
    return true
end

-- The map's double-click-to-walk gesture (Mudlet T2DMap::initiateSpeedWalk).
-- MapPanel resolves the double-clicked room and the player's room, and
-- WindowManager.startSpeedWalk calls in here through LuaRuntime.
--
-- `mudlet.custom_speedwalk` lets a mapper do its own pathfinding: it gets the
-- endpoints in speedWalkFrom/speedWalkTo and no path is computed for it (Mudlet
-- checks for a real boolean, so `== true`). Otherwise the path is computed here
-- and a failure prints Mudlet's mapper message. `from` is -1 when the player
-- room is unknown, which simply finds no path — as in Mudlet, where the missing
-- profile entry pathfinds from room 0.
function __mudix_start_speedwalk(from, to)
    if mudlet and mudlet.custom_speedwalk == true then
        speedWalkFrom, speedWalkTo = from, to
        __mudix_do_speedwalk()
        return true
    end
    if not getPath(from, to) then
        -- Mudlet prints this through printSystemMessage, which mudix has no
        -- equivalent of; the mapper packages echo their own notices the same way.
        cecho("<red>Mapper: Cannot find a path from " .. tostring(from)
            .. " to " .. tostring(to) .. " using known exits.\n")
        return false
    end
    __mudix_do_speedwalk()
    return true
end

-- wasmoon pushes JS arrays 0-indexed in Lua (Object.keys → numeric keys
-- 0..n-1), so unpack as t[0], t[1], ... not t[1], t[2], ...
-- An unknown room yields three nils (Mudlet pushes nothing at all), not false —
-- callers destructure `local x, y, z = getRoomCoordinates(id)`.
function getRoomCoordinates(id)
    local t = __getRoomCoordinates(id)
    if t then return t[0], t[1], t[2] end
    return nil, nil, nil
end

-- Mudlet getBorderColor() → r, g, b. __getBorderColor returns a JS array
-- (0-indexed in Lua, as above) that always has three channels.
function getBorderColor()
    local t = __getBorderColor()
    return t[0], t[1], t[2]
end

-- Mudlet getSubsystemMemoryStats() → table. The JS primitive supplies heap
-- figures and subsystem counts; collectgarbage("count") (Kb of live Lua data)
-- is only observable from Lua, so we fold it in here.
function getSubsystemMemoryStats()
    local t = __getSubsystemMemoryStats()
    t.luaMemoryKb = collectgarbage("count")
    return t
end

-- Cached so Geyser's reposition cascade — which resolves every percentage
-- constraint against the root window via getMainWindowSize() — reads a Lua local
-- instead of crossing into JS (and forcing a getBoundingClientRect) once per
-- widget. A full pane-tree reposition calls this hundreds of times while the
-- window size is constant. The cache (__mws_w/__mws_h globals) is refreshed from
-- JS on the authoritative size-change signal: LuaRuntime.emitEvent pushes the
-- fresh size right before raising sysWindowResizeEvent, so Geyser's reposition
-- handler — which runs on that same event — always reads current values. Lazily
-- primed on first use for any read before the first resize tick.
function getMainWindowSize()
    if __mws_w == nil then
        local t = __getMainWindowSize()
        __mws_w, __mws_h = t[0], t[1]
    end
    return __mws_w, __mws_h
end

-- Skip the Lua->JS crossing for moveWindow/resizeWindow when the geometry is
-- unchanged. Measured: with getMainWindowSize cached, these two calls are ~54%
-- of a reposition's cost (~2.4us of wasmoon marshalling each, ~2 per widget). A
-- Geyser reflow — closing a pane runs organize()+reposition()+_notifyAllReposition
-- over the whole tree — re-issues move/resize for every widget, but most land on
-- coordinates the widget already holds (the unaffected panes don't actually move).
-- Caching last-applied geometry per window name and dropping no-ops removes that
-- half on reflow-heavy ops. Safe because the Lua moveWindow/resizeWindow globals
-- are the SOLE writers of widget geometry (verified: LabelManager.move/resize have
-- no other JS callers), and Geyser creates every widget at its computed position,
-- so a cache hit always means the widget is already there. Invalidated on
-- deleteLabel so a recycled name can never match a stale entry.
__mwGeo = {}

-- Drop a name's cached geometry. Every call that creates or destroys a widget
-- has to do this, because both write geometry straight to JS without going
-- through the cached setters above — leave a stale entry behind and the next
-- moveWindow/resizeWindow to the widget's *previous* coordinates looks like a
-- no-op and is skipped, stranding it at whatever size it was created with. That
-- is not only a delete-then-recreate problem: createMiniConsole on an existing
-- name repositions it too.
function __mudix_forget_geometry(name)
    if type(name) == 'string' then __mwGeo[name] = nil end
end

do
    local geo = __mwGeo
    local _moveWindow, _resizeWindow = moveWindow, resizeWindow
    function moveWindow(name, x, y)
        local g = geo[name]
        if g and g.x == x and g.y == y then return end
        if g then g.x = x; g.y = y else geo[name] = { x = x, y = y } end
        return _moveWindow(name, x, y)
    end
    function resizeWindow(name, w, h)
        local g = geo[name]
        if g and g.w == w and g.h == h then return end
        if g then g.w = w; g.h = h else geo[name] = { w = w, h = h } end
        return _resizeWindow(name, w, h)
    end
end

-- Mudlet addCustomLine(roomID, id_to, direction, style, color, arrow). The
-- id_to (target room id OR list of {x,y,z} points) and color ({r,g,b}) tables
-- are flattened here — wasmoon's LuaTable proxy doesn't iterate reliably from
-- JS. Encodes id_to as "R:<id>" (number) or "P:x,y,z;..." (point list).
-- The JS side reports a refusal as a reason string and success as nil, which
-- this reshapes into Mudlet's true / (nil, errMsg). Coordinate validation stays
-- here because flattening would turn a malformed point into "0,0,0" and hide it
-- (Mudlet's #5272 crash guard rejects `{{}}`).
function addCustomLine(roomID, id_to, direction, style, color, arrow)
    if type(id_to) ~= 'table' then
        local roomTo = __mudix_int(id_to)
        if roomTo == nil then
            error("addCustomLine: bad argument #2 type (target roomID as number or coordinate"
                .. " list as table expected, got " .. type(id_to) .. "!)", 2)
        end
        id_to = roomTo
    end
    local r, g, b = 255, 0, 0
    if type(color) == 'table' then
        r = color[1] or color.r or r
        g = color[2] or color.g or g
        b = color[3] or color.b or b
    end
    local target
    if type(id_to) == 'table' then
        local pts = {}
        for _, p in ipairs(id_to) do
            if type(p) ~= 'table' or tonumber(p[1]) == nil or tonumber(p[2]) == nil then
                return nil, "addCustomLine: every coordinate must be a {x, y, z} triple of numbers"
            end
            pts[#pts + 1] = tostring(p[1]) .. ',' .. tostring(p[2]) .. ',' .. tostring(p[3] or 0)
        end
        if #pts == 0 then
            return nil, "addCustomLine: the coordinate list is empty, at least one {x, y, z} point is needed"
        end
        target = 'P:' .. table.concat(pts, ';')
    else
        target = 'R:' .. tostring(id_to)
    end
    local reason = __mudix_addCustomLine(roomID, target, tostring(direction), tostring(style),
        r, g, b, arrow and true or false)
    if reason then return nil, "addCustomLine: " .. tostring(reason) end
    return true
end

-- Mudlet getImageSize(imageLocation) → width, height (or nil when the file is
-- missing/unreadable or an unrecognised format). JS returns a 0-indexed [w, h]
-- array, or false on the miss case.
function getImageSize(path)
    if path == "" then
        return nil, "image location cannot be an empty string"
    end
    local t = __getImageSize(path)
    if type(t) == 'table' then return t[0], t[1] end
    return nil, "couldn't retrieve image size, is the location '" .. tostring(path) .. "' correct?"
end

-- Mudlet getConsoleBufferSize([consoleName]) → linesLimit, sizeOfBatchDeletion.
-- JS returns a 0-indexed [limit, batch] array (wasmoon convention), or nil when
-- the named console doesn't exist.
function getConsoleBufferSize(name)
    local t = __getConsoleBufferSize(name)
    if t then return t[0], t[1] end
    return nil, 'window "' .. tostring(name) .. '" not found'
end

-- Mudlet setConsoleBufferSize([consoleName,] linesLimit, sizeOfBatchDeletion
-- [, useMaximum]). The optional leading name shifts every other argument
-- along, which is why the four-argument form only lines up when a name was
-- actually given — without one the useMaximum flag would land where the batch
-- size goes, and be silently used as a number.
--
-- The numeric arguments go through __mudix_int rather than a bare type() test:
-- Mudlet vets them with getVerifiedInt, which is lua_isnumber + lua_tointeger,
-- so a numeric string counts as a number there and is truncated to an integer.
-- Geyser.MiniConsole:setBufferSize forwards whatever the caller handed it, and
-- packages that pass "1000" work in Mudlet — a strict type() check broke them.
function setConsoleBufferSize(...)
    local n = select('#', ...)
    local a, b, c, d = ...
    local name, lines, batch, useMaximum
    if type(a) == 'string' and tonumber(a) == nil then
        name, lines, batch, useMaximum = a, b, c, d
    else
        lines, batch, useMaximum = a, b, c
        if n > 2 then
            -- three arguments with no name: the third is where the batch
            -- deletion size lives, and a boolean is not one.
            error("setConsoleBufferSize: bad argument #3 type (size of batch deletion as number"
                .. " expected, got " .. type(c) .. "!)", 2)
        end
    end
    local argOffset = name and 1 or 0
    local linesNum = __mudix_int(lines)
    if linesNum == nil then
        error("setConsoleBufferSize: bad argument #" .. (1 + argOffset) .. " type (lines limit as"
            .. " number expected, got " .. type(lines) .. "!)", 2)
    end
    local batchNum
    if batch ~= nil then
        batchNum = __mudix_int(batch)
        if batchNum == nil then
            error("setConsoleBufferSize: bad argument #" .. (2 + argOffset) .. " type (size of batch"
                .. " deletion as number expected, got " .. type(batch) .. "!)", 2)
        end
    end
    lines, batch = linesNum, batchNum
    if useMaximum ~= nil and type(useMaximum) ~= 'boolean' then
        error("setConsoleBufferSize: bad argument #" .. (3 + argOffset) .. " type (use maximum as"
            .. " boolean is optional, got " .. type(useMaximum) .. "!)", 2)
    end
    if useMaximum and name ~= 'main' then
        return nil, "useMaximum parameter is only supported for the main console"
    end
    if name ~= nil and name ~= 'main' and __windowType(name) == nil then
        return nil, 'window "' .. tostring(name) .. '" not found'
    end
    if __setConsoleBufferSize(name, lines, batch, useMaximum) then return true end
    return nil, 'window "' .. tostring(name) .. '" not found'
end

-- Mudlet getConnectionInfo() → host (string), port (number), connected (bool).
-- JS returns a 0-indexed [host, port, connected] array (wasmoon convention).
function getConnectionInfo()
    local t = __getConnectionInfo()
    return t[0], t[1], t[2]
end

-- Mudlet getOS() → osName, osVersion, [osType (Linux only)], processor. JS
-- returns a 0-indexed array (wasmoon convention) whose length varies (3, or 4 on
-- Linux); unpack it preserving the multi-return arity.
function getOS()
    local t = __getOS()
    local out, i = {}, 0
    while t[i] ~= nil do
        out[#out + 1] = t[i]
        i = i + 1
    end
    return unpack(out)
end

-- Mudlet getKeyCode(idOrName) → keyCode, modifiers — or (nil, errorMessage) when
-- no binding matches. JS returns a 0-indexed [keyCode|nil, modifiers|errMsg]
-- array (and raises on a non-number/non-string argument, which propagates here).
function getKeyCode(idOrName)
    local t = __getKeyCode(idOrName)
    return t[0], t[1]
end

-- Mudlet exportAreaImage(areaID, filePath [, zLevel]) → true on success, or
-- (false, errMsg). JS returns a 0-indexed [ok, pathOrErr] array; unpack it into
-- the documented multi-return (and surface the written path as the 2nd value on
-- success, which mudix adds for convenience).
function exportAreaImage(areaID, filePath, zLevel)
    local t = __mudix_exportAreaImage(areaID, filePath, zLevel)
    if t and t[0] then return true, t[1] end
    return nil, (t and t[1]) or "exportAreaImage failed"
end

-- Mudlet getTimestamp([console_name], lineNumber) → "hh:mm:ss.zzz" string, or
-- (nil, errMsg) for an out-of-range line / missing window. JS returns false on
-- the miss case.
function getTimestamp(a, b)
    local v = __getTimestamp(a, b)
    if not v then
        -- Miscallaneous_spec pins the wording: an out-of-range line is reported
        -- as being beyond the last one, not merely "invalid".
        return nil, "getTimestamp: line number " .. tostring(b or a)
            .. " is beyond the last line of the buffer"
    end
    return v
end

-- Mudlet reloadModule(name) answers with nothing whatsoever, installed or not.
-- The bare call is what drops wasmoon's nil: `return __reloadModule(name)` would
-- forward it as a value.
function reloadModule(name)
    __reloadModule(name)
end

-- Mudlet getModulePath(name) / getModulePriority(name) → the value, or
-- (nil, "module doesn't exist") — a value failure, not a raise (the setters
-- do raise). The __ bindings hand back nil for the miss.
function getModulePath(name)
    local v = __getModulePath(name)
    if v == nil then return nil, "getModulePath: module doesn't exist" end
    return v
end

function getModulePriority(name)
    local v = __getModulePriority(name)
    if v == nil then return nil, "getModulePriority: module doesn't exist" end
    return v
end

-- Module sync + priority. Each JS binding hands back the refusal as a string, or
-- nil when it went through, because a JS function cannot itself return Lua's
-- (nil, msg) pair — the shaping has to happen on this side.
--
-- The two wordings are Mudlet's own and are not interchangeable: the sync
-- functions route through Host::changeModuleSync ("module name '<x>' not
-- found"), while the priority setter reports the same miss the way its getter
-- does ("module doesn't exist"). Scripts match on these.
function enableModuleSync(name)
    local err = __enableModuleSync(name)
    if err then return nil, "enableModuleSync: " .. err end
    return true
end

function disableModuleSync(name)
    local err = __disableModuleSync(name)
    if err then return nil, "disableModuleSync: " .. err end
    return true
end

function getModuleSync(name)
    local err = __getModuleSyncDenial(name)
    if err then return nil, "getModuleSync: " .. err end
    return __getModuleSyncValue(name) and true or false
end

-- Answers nothing at all when it works: Mudlet pushes no value, and a spec
-- counts the returns. Only the refusal has anything to say.
function setModulePriority(name, priority)
    local err = __setModulePriority(name, priority)
    if err then return nil, "setModulePriority: module doesn't exist" end
end

-- Mudlet getLabelSizeHint(name) → width, height, or (nil, errMsg) when the
-- label doesn't exist. JS returns a 0-indexed [w, h] array or false.
function getLabelSizeHint(name)
    -- An empty name is a different mistake from a name that matched nothing,
    -- and Mudlet says so — UI_spec asserts both wordings.
    if name == "" then
        return nil, "label name cannot be an empty string"
    end
    local t = __getLabelSizeHint(name)
    if not t then
        return nil, "label '" .. tostring(name) .. "' does not exist"
    end
    return t[0], t[1]
end

function getMousePosition()
    local t = __getMousePosition()
    return t[0], t[1]
end

-- Mudlet getUserWindowSize(name) → width, height. Always two numbers: a name
-- with no user window of its own reports the MAIN window's size, which is what
-- the dock-registry lookup in TMainConsole::getUserWindowSize falls back to.
function getUserWindowSize(name)
    local t = __getUserWindowSize(name)
    return t[0], t[1]
end

-- Mudlet getRoomChar(id) → symbol string on success (may be empty when no
-- symbol is set), or (nil, errMsg) when the room id doesn't resolve.
function getRoomChar(id)
    local v = __getRoomChar(id)
    if v == nil then return nil, "no such room id" end
    return v
end

-- Mudlet setFontSize / getFontSize / setFont / getFont. The raw primitives
-- return false / nil for the "named window doesn't exist" miss case; here we
-- re-shape those into Mudlet's (nil, errMsg) multi-return.
-- An out-of-range size is checked before the window is even resolved, and gets
-- its own message (TLuaInterpreterUI.cpp).
function setFontSize(a, b)
    local size = (b ~= nil) and b or a
    if (tonumber(size) or 0) <= 0 then
        return nil, "size cannot be 0 or negative"
    end
    if __setFontSize(a, b) then return true end
    local name = (type(a) == 'string') and a or 'main'
    return nil, "window \"" .. tostring(name) .. "\" not found"
end

function getFontSize(a)
    local v = __getFontSize(a)
    if v == nil then
        return nil, "window \"" .. tostring(a) .. "\" not found"
    end
    return v
end

function setFont(a, b)
    -- setFont([window,] font) — the font is the last argument either way.
    local font = (b ~= nil) and b or a
    local name = (b ~= nil) and a or 'main'
    -- The font is checked against the database before the window is, because a
    -- name the renderer can't resolve would otherwise be accepted and silently
    -- fall back to whatever the browser picks.
    if font == "" then
        return nil, "font must not be empty"
    end
    if type(font) == 'string' and not getAvailableFonts()[font] then
        return nil, "font '" .. font .. "' is not available"
    end
    if __setFont(a, b) then return true end
    return nil, "window \"" .. tostring(name) .. "\" not found"
end

-- Mudlet setMiniConsoleFontSize(name, size). Mudlet returns (nil, "setting
-- font size of '<name>' failed") when the miniconsole is missing or the size
-- is invalid; the raw primitive returns false for both, so we re-shape here.
function setMiniConsoleFontSize(name, size)
    if (tonumber(size) or 0) <= 0 then
        return nil, "size cannot be 0 or negative"
    end
    if __setMiniConsoleFontSize(name, size) then return true end
    return nil, "setting font size of '" .. tostring(name) .. "' failed"
end

function getFont(a)
    local v = __getFont(a)
    if v == nil then
        return nil, "window \"" .. tostring(a) .. "\" not found"
    end
    return v
end

-- Mudlet calcFontSize(size [, family]) | calcFontSize(windowName) → width,
-- height (pixels) of an average character cell. JS returns a 2-element array
-- (0-indexed under wasmoon) or nil for the miss case; re-shape into Mudlet's
-- multi-return on success and (nil, errMsg) on failure.
function calcFontSize(a, b)
    local t = __calcFontSize(a, b)
    if t == nil then
        if type(a) == 'string' then
            return nil, "calcFontSize: window \"" .. a .. "\" not found"
        end
        return nil, "calcFontSize: bad argument #1 (number or window name expected)"
    end
    return t[0], t[1]
end

-- A handful of setters that took whatever they were given. Mudlet reads each
-- through getVerifiedNumber/getVerifiedString and raises, so a typo fails at the
-- call instead of quietly writing a NaN border or the string "table".
do
    local function requireNumber(fn, who)
        return function(v, ...)
            local num = __mudix_num(v)
            if num == nil then
                error(who .. ": bad argument #1 type (number expected, got "
                    .. type(v) .. "!)", 2)
            end
            return fn(num, ...)
        end
    end
    setBorderTop    = requireNumber(setBorderTop,    "setBorderTop")
    setBorderBottom = requireNumber(setBorderBottom, "setBorderBottom")
    setBorderLeft   = requireNumber(setBorderLeft,   "setBorderLeft")
    setBorderRight  = requireNumber(setBorderRight,  "setBorderRight")

    -- Numbers are accepted the way Mudlet's lua_isstring accepts them (Lua
    -- coerces), and nil keeps clearing the clipboard — mudix chose that so a
    -- script never blows up on a browser without a clipboard API. Anything else
    -- is a genuine type mistake.
    local _rawSetClipboardText = setClipboardText
    function setClipboardText(text)
        local t = type(text)
        if t ~= 'string' and t ~= 'number' and t ~= 'nil' then
            error("setClipboardText: bad argument #1 type (string expected, got "
                .. t .. "!)", 2)
        end
        return _rawSetClipboardText(text)
    end

    -- getColumnCount / getRowCount answer 0 for a console that isn't there,
    -- which a caller can't tell from a genuinely empty one.
    local function countGuard(fn)
        return function(win, ...)
            if win ~= nil and win ~= 'main' and __windowType(win) == nil then
                return nil, 'window "' .. tostring(win) .. '" not found'
            end
            return fn(win, ...)
        end
    end
    getColumnCount = countGuard(getColumnCount)
    getRowCount    = countGuard(getRowCount)
end

-- Mudlet timeStampsEnabled(window) / enableTimeStamps(window) /
-- disableTimeStamps(window). Both setters refuse a no-op: asking for a state the
-- console is already in reports back rather than silently succeeding, so a
-- script can tell whether it was the one that changed it.
do
    function timeStampsEnabled(windowName)
        local v = __timeStampsEnabled(windowName)
        if v == nil then
            return nil, 'window "' .. tostring(windowName) .. '" not found'
        end
        return v
    end

    local function timeStampSetter(want, who, already)
        return function(windowName)
            local current = __timeStampsEnabled(windowName)
            if current == nil then
                return nil, 'window "' .. tostring(windowName) .. '" not found'
            end
            if current == want then
                return nil, who .. ": timestamps were " .. already .. " for '"
                    .. tostring(windowName) .. "'"
            end
            __setTimeStamps(windowName, want)
            return true
        end
    end
    -- The enable-path wording is Mudlet's own and reads backwards ("were not
    -- enabled" when they in fact already are); its spec asserts only the shape,
    -- with a note that the wording should change, so it is mirrored as-is.
    enableTimeStamps  = timeStampSetter(true,  "enableTimeStamps",  "not enabled")
    disableTimeStamps = timeStampSetter(false, "disableTimeStamps", "not disabled")
end

-- Mudlet echoUserWindow(windowName, text) — the older name for echo(name, text),
-- kept because packages written against it are still in circulation. It targets
-- labels and miniconsoles alike, which is exactly what echo already does.
function echoUserWindow(windowName, text)
    return echo(windowName, text)
end

-- addMouseEvent / removeMouseEvent, setWindow, and the user-window title and
-- stylesheet setters all report their misses as (nil, message) rather than a
-- bare false. Each wording is Mudlet's own — note "user window name" for the
-- title but "userwindow name" for the stylesheet, which UI_spec pins verbatim.
do
    local _rawAddMouseEvent = addMouseEvent
    function addMouseEvent(uniqueName, ...)
        if getMouseEvents()[uniqueName] ~= nil then
            return nil, "mouse event '" .. tostring(uniqueName) .. "' already exists"
        end
        _rawAddMouseEvent(uniqueName, ...)
        return true
    end

    local _rawRemoveMouseEvent = removeMouseEvent
    function removeMouseEvent(uniqueName)
        if getMouseEvents()[uniqueName] == nil then
            return nil, "mouse event '" .. tostring(uniqueName) .. "' does not exist"
        end
        _rawRemoveMouseEvent(uniqueName)
        return true
    end

    -- setWindow(parentWindow, element, x, y, show) — the parent is checked
    -- first, matching the order Mudlet resolves them in. Only the "no such
    -- name" cases become (nil, message); the raw result is passed straight
    -- through otherwise, because it still says false for moves that exist but
    -- are illegal (reparenting a userwindow, or making a cycle).
    local _rawSetWindow = setWindow
    function setWindow(parent, element, ...)
        if parent ~= 'main' and __windowType(parent) == nil then
            return nil, "window '" .. tostring(parent) .. "' not found"
        end
        if __windowType(element) == nil then
            return nil, "element '" .. tostring(element) .. "' not found"
        end
        return _rawSetWindow(parent, element, ...)
    end

    local function userWindowGuard(fn, message)
        return function(name, ...)
            if __windowType(name) ~= 'userwindow' then
                return nil, (message:gsub("%%s", tostring(name)))
            end
            fn(name, ...)
            return true
        end
    end
    setUserWindowTitle      = userWindowGuard(setUserWindowTitle,      "user window name '%s' not found")
    setUserWindowStyleSheet = userWindowGuard(setUserWindowStyleSheet, "userwindow name '%s' not found")

    -- The read-back half of the pair. Each refuses exactly as its setter does,
    -- so a script that got past the setter can always get past the getter —
    -- including the empty-name case, which the two word differently.
    local function userWindowGetter(fn, who, emptyMessage, message)
        return function(rawName)
            local name = __mudix_str(rawName)
            if name == nil then
                error(who .. ": bad argument #1 type (window name as string expected, got "
                    .. type(rawName) .. "!)", 2)
            end
            if name == '' then return nil, emptyMessage end
            if __windowType(name) ~= 'userwindow' then
                -- A miniconsole of that name exists but is not a user window;
                -- saying "not found" would tell a script the name is free.
                if __windowType(name) ~= nil then
                    return nil, '"' .. name .. '" is not a user window'
                end
                return nil, (message:gsub("%%s", name))
            end
            return fn(name)
        end
    end
    getUserWindowTitle = userWindowGetter(__getUserWindowTitle, "getUserWindowTitle",
        "a user window cannot have an empty string as its name", "user window name '%s' not found")
    getUserWindowStyleSheet = userWindowGetter(__getUserWindowStyleSheet, "getUserWindowStyleSheet",
        "a userwindow cannot have an empty string as its name", "userwindow name '%s' not found")

    -- resetUserWindowTitle(name) — back to the generated "<profile> - <name>".
    function resetUserWindowTitle(name)
        return setUserWindowTitle(name, nil)
    end
end

-- setCommandForegroundColor / setCommandBackgroundColor([window,] r, g, b [, a]).
-- Mudlet names the offending channel in the range error, and reports a window it
-- can't resolve the same way setBackgroundColor does.
do
    local CHANNEL_NAMES = { "red", "green", "blue", "alpha" }
    local function cmdColorGuard(fn)
        return function(...)
            local args = { ... }
            local hasWindow = type(args[1]) == 'string'
            if hasWindow and args[1] ~= 'main' and __windowType(args[1]) == nil then
                return nil, "window/label '" .. args[1] .. "' not found"
            end
            local first = hasWindow and 2 or 1
            for i = 1, 4 do
                local v = args[first + i - 1]
                if v ~= nil then
                    local n = tonumber(v)
                    if n == nil or n < 0 or n > 255 then
                        return nil, CHANNEL_NAMES[i] .. " value " .. tostring(v)
                            .. " needs to be between 0-255"
                    end
                end
            end
            return fn(...)
        end
    end
    setCommandForegroundColor = cmdColorGuard(setCommandForegroundColor)
    setCommandBackgroundColor = cmdColorGuard(setCommandBackgroundColor)
end

-- These four all require a window name — a missing or non-string one is an
-- error, while a name that resolves to no widget is silently ignored.
--
-- They differ in what they hand back: showWindow reports a boolean, but
-- moveWindow, resizeWindow and hideWindow return *nothing at all* — not even
-- nil, which `select("#", ...)` can tell apart and UI_spec checks.
do
    local function named(fn, who, void)
        return function(rawName, ...)
            local name = __mudix_str(rawName)
            if name == nil then
                error(who .. ": bad argument #1 type (window name as string expected, got "
                    .. type(rawName) .. "!)", 2)
            end
            if void then
                fn(name, ...)
                return
            end
            return fn(name, ...)
        end
    end
    moveWindow   = named(moveWindow,   "moveWindow",   true)
    resizeWindow = named(resizeWindow, "resizeWindow", true)
    hideWindow   = named(hideWindow,   "hideWindow",   true)
    showWindow   = named(showWindow,   "showWindow")
end

-- Mudlet pasteWindow(windowName) — paste the last copy() into a *named*
-- console. Same operation as paste(name); it exists separately in Mudlet
-- because the window name is required rather than optional, so a missing or
-- mistyped one is a hard error instead of silently hitting the main window.
function pasteWindow(windowName)
    local name = __mudix_str(windowName)
    if name == nil then
        error("pasteWindow: bad argument #1 type (window name as string expected, got "
            .. type(windowName) .. "!)", 2)
    end
    windowName = name
    return paste(windowName)
end

-- Mudlet removeCommandLineMenuEvent([cmdLineName,] uniqueName) → true on
-- success, (false, errMsg) when no entry exists with that uniqueName.
function removeCommandLineMenuEvent(a, b)
    if __removeCommandLineMenuEvent(a, b) then return true end
    local name = (b ~= nil) and b or a
    return false, "removeCommandLineMenuEvent: cannot remove '" .. tostring(name)
        .. "', menu item does not exist"
end

-- enable/disableCommandLine and the 3-argument addCommandLineMenuEvent all name
-- a command line, and all three answer a name that isn't one with (nil,
-- message). The main command bar is a separate refusal: Mudlet won't let a
-- script hide the thing the player types into.
do
    local MAIN = "this function is not permitted on the main command line"
    -- A command line is either one made with createCommandLine, or the one a
    -- console/user window carries once enableCommandLine has given it one — the
    -- latter is addressed by the console's own name. Accepting only the first
    -- made enableCommandLine() refuse the very windows it exists to enable.
    local function missingCmdLine(name)
        local t = __windowType(name)
        if t == 'commandline' or t == 'miniconsole' or t == 'userwindow' then return nil end
        return 'command line "' .. tostring(name) .. '" not found'
    end

    local function visibilityGuard(fn)
        return function(name, ...)
            if name == nil or name == 'main' then return nil, MAIN end
            local err = missingCmdLine(name)
            if err then return nil, err end
            fn(name, ...)
            return true
        end
    end
    enableCommandLine  = visibilityGuard(enableCommandLine)
    disableCommandLine = visibilityGuard(disableCommandLine)

    local _rawAddMenuEvent = addCommandLineMenuEvent
    function addCommandLineMenuEvent(a, b, c)
        -- Only the three-argument form names a command line; the two-argument
        -- one targets the main bar and has no name to check.
        if c ~= nil then
            local err = missingCmdLine(a)
            if err then return nil, err end
        end
        if _rawAddMenuEvent(a, b, c) then return true end
        return false, "addCommandLineMenuEvent: could not add the menu item"
    end
end

-- Mudlet getBackgroundColor([windowName]) → r, g, b, a on success;
-- (nil, errMsg) when the named window doesn't exist. JS hands back a
-- 0-indexed [r, g, b, a] array or `nil` for the miss case.
function getBackgroundColor(windowName)
    local t = __getBackgroundColor(windowName)
    if t == nil then
        -- Mudlet's wording here differs from the generic not-found message used
        -- by the console family (single quotes, "does not exist"); UI_spec
        -- asserts it verbatim.
        return nil, "window '" .. tostring(windowName) .. "' does not exist"
    end
    return t[0], t[1], t[2], t[3]
end

-- Mudlet windowType(name) → "main"/"label"/"miniconsole"/"userwindow", or
-- (nil, errMsg) when the named window doesn't resolve.
function windowType(name)
    local k = __windowType(name)
    if k == nil then
        return nil, "window/label \"" .. tostring(name) .. "\" not found"
    end
    return k
end

-- Mudlet getScript(name [, pos]) → code, id. Returns the source of the pos-th
-- (1-indexed) script named `name` and that script's own numeric id. A miss —
-- unknown name, or a position outside 1..count — answers (-1, message), which
-- is what makes appendScript fail loudly on a name that doesn't exist instead
-- of concatenating onto nothing.
-- Mudlet enableScript(name) / disableScript(name) → true, or (nil, message)
-- when nothing of that name exists. Both act on EVERY script sharing the name,
-- not just the first.
do
    local function toggle(raw, who)
        return function(rawName)
            local name = __mudix_str(rawName)
            if name == nil then
                error(who .. ": bad argument #1 type (script name as string expected, got "
                    .. type(rawName) .. "!)", 2)
            end
            if not raw(name) then
                return nil, who .. ': no script named "' .. name .. '" found'
            end
            return true
        end
    end
    enableScript = toggle(__enableScript, "enableScript")
    disableScript = toggle(__disableScript, "disableScript")
end

-- Mudlet setScript(name, luaCode [, pos]) → the id of the script it replaced.
-- Everything is checked before the store is touched, and the new body is run as
-- it is installed; if running it raises, the previous source goes back so a bad
-- edit can't leave a script half-replaced.
do
    local _raw = setScript
    function setScript(name, code, pos)
        local newName = __mudix_str(name)
        if newName == nil or newName == '' then
            error("setScript: bad argument #1 type (script name as string expected, got "
                .. (newName == '' and 'empty string' or type(name)) .. "!)", 2)
        end
        name = newName
        -- Mudlet checks the body at #2 — before the position at #3 — and the
        -- check is reportInvalidLuaCodeParam, so it both types and compiles.
        code = __mudix_check_lua_code(code, "setScript", 2)
        if pos ~= nil then
            local newPos = __mudix_int(pos)
            if newPos == nil then
                error("setScript: bad argument #3 type (script position as number expected, got "
                    .. type(pos) .. "!)", 2)
            end
            pos = newPos
        end
        pos = pos or 1
        local compiled = loadstring(code)
        -- Read the old body first: it is both the existence check (a miss
        -- answers -1) and the rollback copy.
        local previous = __getScript(name, pos)
        if previous == nil then
            error('setScript: script "' .. name .. '" at position ' .. pos .. ' not found', 2)
        end
        local id = _raw(name, code, pos)
        local ok, rerr = pcall(compiled)
        if not ok then
            _raw(name, previous.code, pos)
            error("setScript: the new script body raised when it was run: " .. tostring(rerr), 2)
        end
        return id
    end
end

function getScript(name, pos)
    local newName = __mudix_str(name)
    if newName == nil then
        error("getScript: bad argument #1 type (script name as string expected, got "
            .. type(name) .. "!)", 2)
    end
    name = newName
    if pos ~= nil then
        local newPos = __mudix_int(pos)
        if newPos == nil then
            error("getScript: bad argument #2 type (script position as number expected, got "
                .. type(pos) .. "!)", 2)
        end
        pos = newPos
    end
    pos = pos or 1
    local r = __getScript(name, pos)
    if r == nil then
        return -1, 'script "' .. name .. '" at position ' .. pos .. ' not found'
    end
    return r.code, r.id
end

-- Mudlet getCurrentLine([window]) → line text, or (nil, errMsg) when the named
-- window doesn't exist. JS returns `nil` only for that miss case (the main
-- window always resolves, may simply have an empty current line).
-- The miss case answers with a STRING, not nil — Mudlet kept that shape for bug
-- compatibility and its own spec pins it ("the next line should be pushnil;
-- compatibility with old bugs and all that").
function getCurrentLine(windowName)
    local v = __getCurrentLine(windowName)
    if v == nil then
        return "ERROR: mini console does not exist",
            "window \"" .. tostring(windowName) .. "\" not found"
    end
    return v
end

-- Mudlet getCustomEnvColor(envID). JS returns nil for unknown IDs (matches
-- Mudlet) and a 0-indexed [r,g,b,a] array otherwise.
function getCustomEnvColor(envId)
    local t = __getCustomEnvColor(envId)
    if t == nil then return nil end
    return t[0], t[1], t[2], t[3]
end

-- Mudlet getRoomCharColor(roomID). Returns r, g, b, a when the room has a
-- per-room char colour set; nil otherwise. JS returns a 0-indexed array.
function getRoomCharColor(roomId)
    local t = __getRoomCharColor(roomId)
    if t == nil then return nil end
    return t[0], t[1], t[2], t[3]
end

-- Mudlet getRoomHidden(roomID) → bool, or (false, errMsg) when the room
-- doesn't exist. JS returns nil for the miss (false is a valid not-hidden
-- value).
function getRoomHidden(roomId)
    local h = __getRoomHidden(roomId)
    if h == nil then return nil, "room with given id not found" end
    return h
end

-- Mudlet getHiddenRooms(areaID) → 1-indexed sequential table of room ids,
-- or (false, errMsg) when the area is missing. JS hands back an array
-- (wasmoon 0-indexed in Lua) or nil; rebuild as a 1-based table (same
-- pattern as getRoomUserDataKeys).
function getHiddenRooms(areaId)
    local raw = __getHiddenRooms(areaId)
    if raw == nil then return nil, "no area with given id found" end
    local out = {}
    if type(raw) == 'table' then
        local i = 0
        while raw[i] ~= nil do
            out[#out + 1] = raw[i]
            i = i + 1
        end
        if #out == 0 then
            for _, v in ipairs(raw) do out[#out + 1] = v end
        end
    end
    return out
end

-- Mudlet getSelection([windowName]) → text, start, length. With no active
-- selection Mudlet returns ("", 0, 0) (not nil) — GUIUtils.lua's replace() and
-- other callers test for exactly that tuple. JS hands back a 0-indexed array or
-- nil for the no-selection case.
function getSelection(windowName)
    local t = __getSelection(windowName)
    if t == nil then return "", 0, 0 end
    return t[0], t[1], t[2]
end

-- Mudlet getFgColor([windowName]) / getBgColor([windowName]) → r, g, b of the
-- character at the current selection's start position. Returns no values when
-- there is no selection (so `r, g, b = getFgColor()` yields three nils, the
-- same shape Mudlet produces for out-of-bounds cursors).
function getFgColor(windowName)
    local t = __getFgColor(windowName)
    if t == nil then return end
    return t[0], t[1], t[2]
end

function getBgColor(windowName)
    local t = __getBgColor(windowName)
    if t == nil then return end
    return t[0], t[1], t[2]
end

-- Mudlet getTextFormat([windowName]) → table describing the display attributes
-- of the character at the current selection's start, or (nil, errMsg) when
-- there is no usable selection. JS returns a flat 0-indexed array of primitives
-- (see __getTextFormat); rebuild the documented table here, with 1-indexed
-- {r, g, b} foreground/background triples.
function getTextFormat(windowName)
    local t = __getTextFormat(windowName)
    if t == nil then return nil, "no character under cursor or selection" end
    return {
        bold = t[0],
        italic = t[1],
        underline = t[2],
        strikeout = t[3],
        reverse = t[4],
        overline = t[5],
        concealed = t[6],
        alternateFont = t[7],
        blinking = t[8],
        foreground = { t[9], t[10], t[11] },
        background = { t[12], t[13], t[14] },
        -- What is actually drawn under the character: "none", "solid", "wavy",
        -- "dotted" or "dashed". Appended after the colours rather than beside
        -- `underline` so the flat array's existing indices do not shift.
        underlineStyle = t[15],
    }
end

-- Mudlet getMapUserData(key). Returns the stored value on success or
-- (false, errMsg) when the key isn't set.
function getMapUserData(key)
    local v = __getMapUserData(key)
    if v == nil then return nil, "no such map user data key" end
    return v
end

-- Mudlet getRoomUserDataKeys(id) → sequential Lua table of the user-data keys
-- stored on the room, or nil when the room does not exist. JS hands back a
-- 0-indexed array (wasmoon convention) or nil; rebuild as a 1-indexed table.
function getRoomUserDataKeys(id)
    local raw = __getRoomUserDataKeys(id)
    if raw == nil then return nil end
    local out = {}
    if type(raw) == 'table' then
        local i = 0
        while raw[i] ~= nil do
            out[#out + 1] = raw[i]
            i = i + 1
        end
        if #out == 0 then
            for _, v in ipairs(raw) do out[#out + 1] = v end
        end
    end
    return out
end

-- Mudlet getExitStubs1(id) → 1-indexed variant of getExitStubs. The base
-- `getExitStubs` binding hands back a wasmoon array (0-indexed in Lua); walk
-- it and rebuild as a 1-indexed sequence.
function getExitStubs1(id)
    local raw, err = getExitStubs(id)
    if raw == nil then return nil, err end
    local out = {}
    local i = 0
    while raw[i] ~= nil do
        out[i + 1] = raw[i]
        i = i + 1
    end
    return out
end

-- Walk a wasmoon 0-indexed array proxy (Object.keys → 0..n-1) into a 1-indexed
-- Lua sequence. Shared by the 1-indexed mapper wrappers below.
local function reindex1(raw)
    if raw == nil then return nil end
    local out, i = {}, 0
    while raw[i] ~= nil do out[i + 1] = raw[i]; i = i + 1 end
    return out
end

-- Mudlet getAreaRooms1(areaID) → 1-indexed variant of getAreaRooms (which is
-- 0-indexed for legacy reasons).
function getAreaRooms1(areaID)
    return reindex1(getAreaRooms(areaID))
end

-- Mudlet getRoomsByPosition1(areaID, x, y, z) → 1-indexed getRoomsByPosition.
function getRoomsByPosition1(areaID, x, y, z)
    return reindex1(getRoomsByPosition(areaID, x, y, z))
end

-- Mudlet getExitStubsNames(roomID) → 1-indexed direction-name list. The __
-- binding hands back a 0-indexed array, or nil when the room is missing.
function getExitStubsNames(id)
    local raw = __getExitStubsNames(id)
    if raw == nil then
        return nil, "getExitStubsNames: room with id " .. tostring(id) .. " does not exist"
    end
    return reindex1(raw)
end

-- Mudlet getAllRoomEntrances(roomID) → 1-indexed list of rooms with an exit into
-- this one. nil (room missing) → (false, errMsg).
function getAllRoomEntrances(id)
    local raw = __getAllRoomEntrances(id)
    if raw == nil then
        return nil, "getAllRoomEntrances: room with id " .. tostring(id) .. " does not exist"
    end
    return reindex1(raw)
end

-- Mudlet getAreaExits(areaID[, fullData]). Without full data → 1-indexed id
-- array; with → { [fromRoomID] = { [exit] = toRoomID } }, re-keyed to integer
-- room ids (wasmoon stringifies object keys). nil (area missing) →
-- (false, errMsg).
function getAreaExits(areaID, fullData)
    local raw = __getAreaExits(areaID, fullData and true or false)
    if raw == nil then
        return nil, "getAreaExits: area with id " .. tostring(areaID) .. " does not exist"
    end
    if fullData then
        local out = {}
        for k, inner in pairs(raw) do
            local exits = {}
            for cmd, toId in pairs(inner) do exits[cmd] = toId end
            out[tonumber(k) or k] = exits
        end
        return out
    end
    return reindex1(raw)
end

-- Mudlet getCustomLines1(roomID) → getCustomLines with 1-indexed point arrays.
-- Rebuilt entirely off the wasmoon proxy so callers hold a plain Lua table.
function getCustomLines1(id)
    local raw = getCustomLines(id)
    if raw == nil then
        return nil, "getCustomLines1: room " .. tostring(id) .. " doesn't exist"
    end
    local out = {}
    for dir, line in pairs(raw) do
        local pts, i = {}, 0
        local src = line.points or {}
        while src[i] ~= nil do
            local p = src[i]
            pts[i + 1] = { x = p.x, y = p.y, z = p.z }
            i = i + 1
        end
        local a = line.attributes or {}
        local c = a.color or {}
        out[dir] = {
            attributes = { color = { r = c.r, g = c.g, b = c.b }, style = a.style, arrow = a.arrow },
            points = pts,
        }
    end
    return out
end

-- Mudlet searchRoom(roomID|name[, caseSensitive[, exactMatch]]). By id → name
-- string (false on miss). By name → { [roomID] = name } with integer ids
-- (wasmoon stringifies the keys).
function searchRoom(arg, caseSensitive, exactMatch)
    local raw = __searchRoom(arg, caseSensitive and true or false, exactMatch and true or false)
    if type(raw) == 'table' then
        local out = {}
        for k, v in pairs(raw) do out[tonumber(k) or k] = v end
        return out
    end
    return raw
end

-- Mudlet searchRoomUserData / searchAreaUserData ([key[, value]]) → 1-indexed
-- list: all keys (no value arg & no key), all values for a key, or matching ids.
function searchRoomUserData(key, value)
    return reindex1(__searchRoomUserData(key, value))
end
function searchAreaUserData(key, value)
    return reindex1(__searchAreaUserData(key, value))
end

-- Mudlet lockSpecialExit(fromID, toID, command, lockIfTrue) and
-- hasSpecialExitLock(fromID, toID, command). The toID argument is accepted for
-- signature compatibility and ignored — locks are resolved via the command.
function lockSpecialExit(fromID, _toID, command, lockIfTrue)
    local r = __lockSpecialExit(fromID, command, lockIfTrue and true or false)
    if r == true then return true end
    return nil, r
end
function hasSpecialExitLock(fromID, _toID, command)
    local r = __hasSpecialExitLock(fromID, command)
    if type(r) == 'boolean' then return r end
    return nil, r
end

-- Mudlet connectExitStub(fromID, direction) | (fromID, toID[, direction]) →
-- true, or (false, errMsg) on any failure.
function connectExitStub(fromID, a2, a3)
    local r = __connectExitStub(fromID, a2, a3)
    if r == true then return true end
    return nil, r
end

-- Mudlet getRoomUserData(id, key [, fullErr]). Default form returns "" when
-- either the room or the key is missing (so scripts can safely concatenate
-- the result). With `fullErr=true` the two miss cases are distinguishable:
--   room missing → (false, "room with given id not found")
--   key missing  → (false, "no such room user data key")
function getRoomUserData(id, key, fullErr)
    local r = __getRoomUserData(id, key)
    if type(r) == 'table' then
        if r.value ~= nil then return r.value end
        if fullErr then
            if r.miss == 'room' then
                return nil, "room with given id ('" .. tostring(r.id or id) .. "') not found"
            end
            return nil, "no such room user data key ('" .. tostring(r.key or key) .. "')"
        end
        return ""
    end
    return r or ""
end

-- Mudlet getAllRoomUserData(id) → { key = value } table, or (false, errMsg)
-- when the room is missing. JS hands the dict over with its string keys intact
-- (and `nil` for the miss), so we only shape the miss case.
function getAllRoomUserData(id)
    local raw = __getAllRoomUserData(id)
    if raw == nil then return nil, "room with given id not found" end
    return raw
end

-- Mudlet clearRoomUserData(id) → true when data was cleared, false when the
-- room had none, (false, errMsg) when the room is missing (JS hands back nil).
function clearRoomUserData(id)
    local r = __clearRoomUserData(id)
    if r == nil then return nil, "room with given id not found" end
    return r
end

-- Mudlet clearRoomUserDataItem(id, key) → true when the key existed, false
-- when it didn't, (false, errMsg) when the room is missing.
function clearRoomUserDataItem(id, key)
    local r = __clearRoomUserDataItem(id, key)
    if r == nil then return nil, "room with given id not found" end
    return r
end

-- Mudlet resetRoomArea(id) → true on success, (false, errMsg) when the room is
-- missing. Moves the room to the void area (-1).
function resetRoomArea(id)
    local r = __resetRoomArea(id)
    if r == nil then return nil, "room with given id not found" end
    return r
end

-- Mudlet getAreaTableSwap() → { [areaID] = name }. JS hands the record over
-- with numeric ids stringified (wasmoon convention); re-key via tonumber so
-- scripts can index by integer area id.
function getAreaTableSwap()
    local raw = __getAreaTableSwap()
    local out = {}
    if type(raw) == 'table' then
        for k, v in pairs(raw) do
            local id = tonumber(k)
            if id then out[id] = v end
        end
    end
    return out
end

-- Mudlet getAreaUserData(areaID, key) → the stored value, or (false, errMsg)
-- distinguishing a missing area from a missing key (mirrors getRoomUserData's
-- fullErr branch — area data has no short-circuit "" default in Mudlet).
function getAreaUserData(areaId, key)
    local r = __getAreaUserData(areaId, key)
    if type(r) == 'table' then
        if r.value ~= nil then return r.value end
        if r.miss == 'area' then
            return nil, "no area with id " .. tostring(r.id or areaId) .. " found"
        end
        return nil, "no user data with key '" .. tostring(r.key or key) .. "' in area"
    end
    return nil, "no area user data"
end

-- Mudlet getAllAreaUserData(areaID) → { key = value }, or (false, errMsg) when
-- the area is missing.
function getAllAreaUserData(areaId)
    local raw = __getAllAreaUserData(areaId)
    if raw == nil then return nil, "no area with given id found" end
    return raw
end

-- Mudlet clearAreaUserData(areaID) → true/false, or (false, errMsg) when the
-- area is missing. clearAreaUserDataItem(areaID, key) mirrors it for one key.
function clearAreaUserData(areaId)
    local r = __clearAreaUserData(areaId)
    if r == nil then return nil, "no area with given id found" end
    return r
end

function clearAreaUserDataItem(areaId, key)
    local r = __clearAreaUserDataItem(areaId, key)
    if r == nil then return nil, "no area with given id found" end
    return r
end

-- Mudlet getGridMode(areaID) → bool, or (false, errMsg) when the area is
-- missing (JS hands back nil for the miss; false is a valid grid-mode value).
function getGridMode(areaId)
    local r = __getGridMode(areaId)
    if r == nil then return nil, "no area with given id found" end
    return r
end

-- Mudlet getRoomName(id) → name string on success, (false, errMsg) on miss.
function getRoomName(id)
    local n = __getRoomName(id)
    if n == nil then return nil, "room with given id not found" end
    return n
end

-- Mudlet getRoomHashByID(id) → hash string on success, (false, errMsg) when
-- the room is missing or has no hash assigned.
function getRoomHashByID(id)
    local h = __getRoomHashByID(id)
    if h == nil then return nil, "no hash for given room id" end
    return h
end

-- Mudlet deleteLabel(name) → true on success, (false, errMsg) when the label
-- doesn't exist.
function deleteLabel(name)
    __mudix_forget_geometry(name)
    if __deleteLabel(name) then return true end
    return false, "label name '" .. tostring(name) .. "' not found"
end

-- deleteMiniConsole/deleteCommandLine/deleteScrollBox mirror deleteLabel: true on
-- success, (false, errMsg) when the target doesn't exist. The main command line
-- is protected (Mudlet refuses to delete it).
function deleteMiniConsole(name)
    __mudix_forget_geometry(name)
    if __deleteMiniConsole(name) then return true end
    return false, "miniconsole \"" .. tostring(name) .. "\" does not exist"
end

function deleteCommandLine(name)
    __mudix_forget_geometry(name)
    if name == "main" then
        return false, "the main command line cannot be deleted"
    end
    if __deleteCommandLine(name) then return true end
    return false, "command line \"" .. tostring(name) .. "\" does not exist"
end

function deleteScrollBox(name)
    __mudix_forget_geometry(name)
    if __deleteScrollBox(name) then return true end
    return false, "scroll box \"" .. tostring(name) .. "\" does not exist"
end

-- Mudlet setLabelStyleSheet(name, css) → true on success, (nil, errMsg) for an
-- empty name or a label that doesn't exist.
function setLabelStyleSheet(name, css)
    if name == "" then
        return nil, "a label name cannot have an empty string as the name"
    end
    if __setLabelStyleSheet(name, css) then return true end
    return nil, "label name '" .. tostring(name) .. "' not found"
end

-- The label functions all report a miss as (nil, message), but Mudlet's wordings
-- genuinely differ between them — "label '%s' does not exist" for the readback
-- pair, "label name '%s' not found" for the setters, "label '%s' not found" for
-- the link-style trio. UI_spec asserts each verbatim, so they are grouped by
-- wording here rather than funnelled through one message.
-- Name collisions across the widget namespace. Labels, miniconsoles, user
-- windows, scroll boxes and command lines all share one set of names in Mudlet,
-- and each creator reports a clash its own way: createLabel refuses outright and
-- leaves the existing label untouched, while createMiniConsole/createScrollBox
-- move and resize what is already there and say so. UI_spec asserts each
-- wording, and that a refused createLabel really did not move anything.
do
    local _rawCreateLabel = createLabel
    function createLabel(...)
        local argc = select('#', ...)
        local a = { ... }
        -- Two leading strings mean the parented form, which shifts every
        -- coordinate one place right — hence the two argument-number bases.
        local parented = type(a[1]) == 'string' and type(a[2]) == 'string'
        local name = parented and a[2] or a[1]
        local base = parented and 3 or 2
        local labels = { "x-coordinate", "y-coordinate", "width", "height" }
        for i = 1, 4 do
            local v = __mudix_int(a[base + i - 1])
            if v == nil then
                error("createLabel: bad argument #" .. (base + i - 1) .. " type (label "
                    .. labels[i] .. " as number expected, got "
                    .. type(a[base + i - 1]) .. "!)", 2)
            end
            a[base + i - 1] = v
        end
        -- The parent has to be a window that can hold a label: a user window or
        -- a scroll box. Naming anything else used to put the label in the MAIN
        -- window instead, which is nowhere the caller asked for and left them
        -- hunting for a label that was on screen all along (Host::createLabel).
        if parented then
            local parent = a[1]
            local parentKind = __windowType(parent)
            if parent ~= '' and parent ~= 'main'
                and parentKind ~= 'userwindow' and parentKind ~= 'scrollbox' then
                return false, "window '" .. tostring(parent) .. "' not found"
            end
        end
        local kind = __windowType(name)
        if kind == 'label' then
            return false, "label '" .. tostring(name) .. "' already exists"
        end
        if kind == 'miniconsole' or kind == 'userwindow' then
            return false, "a miniconsole/userwindow with the name '" .. tostring(name)
                .. "' already exists"
        end
        __mudix_forget_geometry(name)
        return _rawCreateLabel(unpack(a, 1, argc))
    end

    -- These two are not refusals: the existing widget IS moved and resized, and
    -- the false is only how Mudlet says "I reused what was there".
    local function reuseReporter(raw, kind, noun)
        return function(...)
            local a = { ... }
            local parented = type(a[1]) == 'string' and type(a[2]) == 'string'
            local name = parented and a[2] or a[1]
            local existed = __windowType(name) == kind
            __mudix_forget_geometry(name)
            local r = raw(...)
            if existed then
                return false, noun .. " '" .. tostring(name) .. "' already exists, moving/resizing '"
                    .. tostring(name) .. "'"
            end
            return r
        end
    end
    createMiniConsole = reuseReporter(createMiniConsole, 'miniconsole', 'miniconsole')
    createScrollBox   = reuseReporter(createScrollBox,   'scrollbox',   'scrollBox')

    local _rawOpenUserWindow = openUserWindow
    function openUserWindow(name, ...)
        if __windowType(name) == 'label' then
            return nil, "label with the name '" .. tostring(name) .. "' already exists"
        end
        __mudix_forget_geometry(name)
        return _rawOpenUserWindow(name, ...)
    end

    -- Both take the widget name as argument #1 and have nothing sensible to do
    -- without it.
    local function requireName(raw, who)
        return function(rawName, ...)
            local name = __mudix_str(rawName)
            if name == nil then
                error(who .. ": bad argument #1 type (name as string expected, got "
                    .. type(rawName) .. "!)", 2)
            end
            __mudix_forget_geometry(name)
            return raw(name, ...)
        end
    end
    createTextEdit    = requireName(createTextEdit,    "createTextEdit")
    createCommandLine = requireName(createCommandLine, "createCommandLine")
end

-- Mudlet setTextFormat(window, r1,g1,b1, r2,g2,b2, bold, underline, italics
-- [, strikeout [, overline [, reverse [, blinkMode]]]]).
--
-- Everything is validated before the console is touched. Mudlet #9576 was
-- exactly this function building its objects first and validating after, so a
-- rejected call leaked them; UI_spec asserts both the messages and that nothing
-- was left behind. Note the odd one out: an unknown window reports **false**
-- here, not the nil the rest of the UI API uses.
do
    local _raw = setTextFormat
    -- Each checker returns the converted value; the coerced list is what gets
    -- forwarded, so the JS binding never sees the raw "255".
    local function checkNumber(v, argN)
        local num = __mudix_num(v)
        if num == nil then
            error("setTextFormat: bad argument #" .. argN .. " type (number expected, got "
                .. type(v) .. "!)", 3)
        end
        return num
    end
    -- Mudlet takes a boolean OR a number for the format flags (non-zero
    -- enables), and lua_isnumber counts a numeric string among the numbers.
    local function checkFlag(v, argN)
        if type(v) == 'boolean' then return v end
        local num = __mudix_num(v)
        if num == nil then
            error("setTextFormat: bad argument #" .. argN .. " type (boolean expected, got "
                .. type(v) .. "!)", 3)
        end
        return num
    end
    function setTextFormat(win, ...)
        local n = select('#', ...)
        local a = { ... }
        -- #2..#7 are the two colour triples, #8..#10 the required attributes.
        for i = 1, 6 do a[i] = checkNumber(a[i], i + 1) end
        for i = 7, 9 do a[i] = checkFlag(a[i], i + 1) end
        -- #11..#13 are optional attributes, #14 the optional blink mode.
        for i = 10, 12 do
            if a[i] ~= nil then a[i] = checkFlag(a[i], i + 1) end
        end
        if a[13] ~= nil then
            -- lua_isstring, so a number reaches the value check below and is
            -- rejected there as a bad blink mode rather than as a bad type.
            local blink = __mudix_str(a[13])
            if blink == nil then
                error("setTextFormat: bad argument #14 type (string expected, got "
                    .. type(a[13]) .. "!)", 2)
            end
            a[13] = blink
            if blink ~= 'none' and blink ~= 'slow' and blink ~= 'fast' then
                return nil, 'blink mode must be "none", "slow", or "fast", got "' .. blink .. '"'
            end
        end
        if win ~= nil and win ~= 'main' and __windowType(win) == nil then
            return false, "window '" .. tostring(win) .. "' does not exist"
        end
        return _raw(win, unpack(a, 1, n))
    end
end

-- Existence is checked with __windowType rather than by trusting each binding's
-- return value: several of these answer nothing at all on success (JS `void`
-- arrives as nil), so "falsy" cannot distinguish "worked" from "no such label".
__mudix_label_missing = function(name, message)
    if name == "" then return "label name cannot be an empty string" end
    if __windowType(name) == 'label' then return nil end
    return (message:gsub("%%s", tostring(name)))
end

do
    local function labelGuard(fn, message)
        return function(name, ...)
            name = __mudix_str(name) or name
            local err = __mudix_label_missing(name, message)
            if err then return nil, err end
            fn(name, ...)
            return true
        end
    end
    setLabelToolTip   = labelGuard(setLabelToolTip,   "label name '%s' not found")
    -- The shape must be a number by the time it gets here: GUIUtils.lua's
    -- wrapper translates a name through mudlet.cursor, and a name that isn't in
    -- there arrives as nil. Refusing it is the point — silently leaving the
    -- cursor alone would hide the typo.
    do
        local guarded = labelGuard(setLabelCursor, "label name '%s' not found")
        setLabelCursor = function(name, shape)
            local num = __mudix_int(shape)
            if num == nil then
                error("setLabelCursor: bad argument #2 type (cursor shape as number expected, got "
                    .. type(shape) .. "!)", 2)
            end
            return guarded(name, num)
        end
    end
    setLinkStyle      = labelGuard(setLinkStyle,      "label '%s' not found")
    resetLinkStyle    = labelGuard(resetLinkStyle,    "label '%s' not found")
    clearVisitedLinks = labelGuard(clearVisitedLinks, "label '%s' not found")

    -- getLabelToolTip: same lookup as the setter, so a label the setter accepts
    -- always reads back.
    function getLabelToolTip(name)
        local labelName = __mudix_str(name)
        if labelName == nil then
            error("getLabelToolTip: bad argument #1 type (label name as string expected, got "
                .. type(name) .. "!)", 2)
        end
        name = labelName
        local err = __mudix_label_missing(name, "label name '%s' not found")
        if err then
            -- the setter's wording for the empty case, which is not the
            -- "cannot be an empty string" phrasing the shared helper uses
            if name == '' then return nil, "a label cannot have an empty string as its name" end
            return nil, err
        end
        return __getLabelToolTip(name)
    end

    -- getLabelStyleSheet answers "" for a label that exists but has no CSS, so
    -- the miss has to be told apart by asking whether the label is there.
    local _rawGetLabelStyleSheet = getLabelStyleSheet
    function getLabelStyleSheet(name)
        local err = __mudix_label_missing(name, "label '%s' does not exist")
        if err then return nil, err end
        return _rawGetLabelStyleSheet(name)
    end
end

-- ── Text edit widgets (Mudlet createTextEdit) ─────────────────────────────
-- deleteTextEdit → true, or (false, errMsg). getTextEditText → text, or
-- (nil, errMsg). The set/property functions → true, or (nil, errMsg) when the
-- named text edit doesn't exist. The __* primitives return value-or-false.
function deleteTextEdit(name)
    __mudix_forget_geometry(name)
    if __deleteTextEdit(name) then return true end
    return false, "text edit name '" .. tostring(name) .. "' not found"
end

function getTextEditText(name)
    local t = __getTextEditText(name)
    if t == false then
        return nil, "getTextEditText: text edit '" .. tostring(name) .. "' does not exist"
    end
    return t
end

do
    local function teSetter(raw, fname)
        return function(name, ...)
            if raw(name, ...) then return true end
            return nil, fname .. ": text edit '" .. tostring(name) .. "' does not exist"
        end
    end
    setTextEditText          = teSetter(__setTextEditText, "setTextEditText")
    clearTextEdit            = teSetter(__clearTextEdit, "clearTextEdit")
    setTextEditReadOnly      = teSetter(__setTextEditReadOnly, "setTextEditReadOnly")
    setTextEditPlaceholder   = teSetter(__setTextEditPlaceholder, "setTextEditPlaceholder")
    setTextEditStyleSheet    = teSetter(__setTextEditStyleSheet, "setTextEditStyleSheet")
    setTextEditFont          = teSetter(__setTextEditFont, "setTextEditFont")
    setTextEditFontSize      = teSetter(__setTextEditFontSize, "setTextEditFontSize")
    setTextEditTabMovesFocus = teSetter(__setTextEditTabMovesFocus, "setTextEditTabMovesFocus")
end

-- Mudlet HTTP APIs: every call dispatches a fire-and-forget background
-- request and immediately returns (true, url). Completion/failure is
-- reported via sysXxxHttp* events. The wrappers below add the (true, url)
-- tuple over the `__`-prefixed JS primitives.
-- Mudlet's C++ bindings validate every argument up front (getVerifiedString and
-- validateHttpHeaders in TLuaInterpreterNetworking.cpp) and raise before any
-- request is built; only then is the url checked for validity, which is a
-- (nil, errMsg) return rather than a raise. mudix's JS primitives coerce
-- instead, so the checks live here. Level 3 puts the error on the caller's line,
-- past this helper and the wrapper that called it.
-- Both checkers COERCE, and both return the converted value — assign it back
-- (`x = __mudix_check_string(x, ...)`) rather than calling them for effect.
-- Mudlet's checkStringArg is lua_isstring and its checkIntArg/checkNumberArg are
-- lua_isnumber, and in Lua 5.1 those follow the language's own string<->number
-- coercion: a number is a valid string argument and a numeric string is a valid
-- number one. Scripts rely on it — trigger captures are always strings, so
-- `tempLineTrigger(matches[2], matches[3], code)` is ordinary Mudlet code — and a
-- strict type() test here rejected calls that work in Mudlet.
function __mudix_check_string(value, funcName, index, what)
    local str = __mudix_str(value)
    if str == nil then
        error(funcName .. ": bad argument #" .. index .. " type (" .. what
            .. " as string expected, got " .. type(value) .. "!)", 3)
    end
    return str
end

-- Mudlet's reportInvalidLuaCodeParam (TLuaInterpreter.cpp): the body of a perm*
-- object is read with lua_isstring — so a number is an acceptable *argument* —
-- and is then COMPILED before anything is created. That second half is what
-- rejects permAlias(name, "", "^x$", 999): not the type, but the fact that "999"
-- is not a chunk. Checking only the type accepts it and files a dead body under
-- an alias that can never run, which is precisely the state Mudlet refuses to
-- leave the tree in. Wording is Mudlet's ("bad argument #N (...)", no `type`
-- word, and the raw loadstring message after "invalid Lua code: ").
function __mudix_check_lua_code(value, funcName, index)
    local str = __mudix_str(value)
    if str == nil then
        error(funcName .. ": bad argument #" .. index
            .. " (lua script as string expected, got " .. type(value) .. "!)", 3)
    end
    local compiled, cerr = loadstring(str)
    if not compiled then
        error(funcName .. ": bad argument #" .. index
            .. " (invalid Lua code: " .. tostring(cerr) .. ")", 3)
    end
    return str
end

function __mudix_check_number(value, funcName, index, what)
    local num = tonumber(value)
    if num == nil then
        error(funcName .. ": bad argument #" .. index .. " type (" .. what
            .. " as number expected, got " .. type(value) .. "!)", 3)
    end
    return num
end

-- getVerifiedInt in full: the type check above, then the range check Mudlet has
-- to make because lua_tointeger hands back a 64-bit value where the C++ side
-- wants an int. Returns the truncated integer.
function __mudix_check_int(value, funcName, index, what)
    __mudix_check_number(value, funcName, index, what)
    local num = __mudix_int(value)
    if num < -2147483648 or num > 2147483647 then
        error(funcName .. ": integer over/under-flow in argument #" .. index .. " (" .. what
            .. " as an integer, provided value " .. tostring(value)
            .. " is outside of valid range -2147483648 to 2147483647!)", 3)
    end
    return num
end

-- lua_isnumber + lua_tointeger, the pair behind Mudlet's getVerifiedInt: a
-- numeric string passes the check and is converted, and the result is truncated
-- toward zero rather than rounded. Returns nil when the value is not a number
-- at all, so callers can raise their own Mudlet-worded error.
function __mudix_int(value)
    local num = tonumber(value)
    if num == nil then return nil end
    if num >= 0 then return math.floor(num) end
    return -math.floor(-num)
end

-- lua_isnumber + lua_tonumber, behind getVerifiedDouble/getVerifiedFloat. Same
-- acceptance as __mudix_int without the truncation.
function __mudix_num(value)
    return tonumber(value)
end

-- lua_isstring + lua_tostring, behind getVerifiedString/checkStringArg. A number
-- is a string argument; nothing else is. Lua's tostring uses the same "%.14g"
-- as lua_tostring, so the rendering matches Mudlet's.
function __mudix_str(value)
    local t = type(value)
    if t == 'string' then return value end
    if t == 'number' then return tostring(value) end
    return nil
end

-- Optional headers table: absent/nil is fine, anything else must be a table of
-- string→string. Wording is Mudlet's verbatim — Networking_spec asserts the
-- whole message for customHTTP, including the "as a table" article.
-- Flatten a validated headers table to "k\1v\1k\1v" for the JS side.
--
-- The bindings used to receive the Lua table itself and read it with wasmoon's
-- `$detach`, which traps the whole runtime ("memory access out of bounds") on
-- some call shapes — notably postHTTP with the optional upload-file argument
-- present. Handing over a flat string keeps table traversal on the Lua side,
-- where it is just `pairs`, and matches how the rest of this bridge moves
-- structured values across the boundary. Nil headers stay nil.
function __mudix_headers_to_string(headers)
    if headers == nil then return nil end
    local parts = {}
    for k, v in pairs(headers) do
        parts[#parts + 1] = k
        parts[#parts + 1] = v
    end
    if #parts == 0 then return nil end
    return table.concat(parts, "\1")
end

function __mudix_check_headers(headers, funcName, index)
    if headers == nil then return end
    if type(headers) ~= 'table' then
        error(funcName .. ": bad argument #" .. index .. " type (headers as a table expected, got "
            .. type(headers) .. "!)", 3)
    end
    for k, v in pairs(headers) do
        if type(k) ~= 'string' or type(v) ~= 'string' then
            error(funcName .. ": bad argument #" .. index
                .. " type (custom headers must be strings, got header: " .. type(k)
                .. " (should be string) and value: " .. type(v) .. " (should be string))", 3)
        end
    end
end

-- Returns (nil, errMsg) when the url can't be used, else nil so the caller
-- proceeds. Runs after the type/header checks, matching Mudlet's order.
function __mudix_http_url_error(url, funcName)
    local reason = __mudix_url_invalid_reason(url)
    if reason then
        return funcName .. ": url is invalid, reason: " .. tostring(reason)
    end
    return nil
end

-- Mudlet waitForEvent(eventName [, timeoutMs]) — block until the named event is
-- raised, returning (eventName, ...eventArgs), or (nil, errMsg) on timeout.
--
-- Test-only, as in Mudlet (which gates it on MUDLET_TEST_MODE): __mudix_pump is
-- registered by the busted bridge alone, so a production build takes the early
-- return below instead. Mudlet blocks in a nested QEventLoop; a browser can't
-- re-enter its event loop, so we drive mudix's timer queue by hand — see
-- __mudix_pump in LuaRuntime.ts and TimerEngine.pumpDue.
--
-- Caveat worth knowing: this cannot observe an event raised from *inside* an
-- event dispatch already in progress, because LuaRuntime.emitEvent queues those
-- until the outer dispatch drains. Calling waitForEvent from an event handler
-- will therefore time out. The specs call it from it() bodies.
function waitForEvent(eventName, timeoutMs)
    if type(__mudix_pump) ~= 'function' then
        return nil, "waitForEvent: only available in test mode"
    end
    eventName = __mudix_check_string(eventName, "waitForEvent", 1, "event name")
    if eventName == '' then
        return nil, "waitForEvent: event name cannot be empty"
    end
    local timeout = 3000
    if timeoutMs ~= nil then
        if type(timeoutMs) ~= 'number' then
            error("waitForEvent: bad argument #2 type (timeout in milliseconds as number"
                .. " is optional, got " .. type(timeoutMs) .. "!)", 2)
        end
        timeout = timeoutMs
    end
    -- Same clamp as Mudlet: never negative, never long enough to outlive the
    -- per-spec timeout and take the whole suite down with it.
    if timeout < 0 then timeout = 0 elseif timeout > 30000 then timeout = 30000 end

    -- select('#') rather than a plain table: the payload may contain embedded
    -- or trailing nils, whose positions the caller can inspect.
    local slot = { captured = false, n = 0, args = {} }
    local id = registerAnonymousEventHandler(eventName, function(_, ...)
        if not slot.captured then
            slot.captured = true
            slot.n = select('#', ...)
            slot.args = { ... }
        end
    end)

    local deadline = __mudix_now() + timeout
    while not slot.captured do
        if __mudix_pump(deadline) then break end
    end
    killAnonymousEventHandler(id)

    if not slot.captured then
        return nil, "waitForEvent: timed out after " .. tostring(timeout)
            .. "ms waiting for event '" .. eventName .. "'"
    end
    return eventName, unpack(slot.args, 1, slot.n)
end

-- Mudlet pumpEvents([durationMs]) — waitForEvent's sibling for when there is no
-- named event to wait on: keep delivering queued work for a while. Test-only for
-- the same reason, and driven the same way (__mudix_pump fires the timers that
-- have come due, since a browser cannot re-enter its own event loop).
function pumpEvents(durationMs)
    if type(__mudix_pump) ~= 'function' then
        return nil, "pumpEvents: only available in test mode"
    end
    local timeout = 50
    if durationMs ~= nil then
        if type(durationMs) ~= 'number' then
            error("pumpEvents: bad argument #1 type (duration in milliseconds as number"
                .. " is optional, got " .. type(durationMs) .. "!)", 2)
        end
        timeout = durationMs
    end
    if timeout < 0 then timeout = 0 elseif timeout > 30000 then timeout = 30000 end

    local deadline = __mudix_now() + timeout
    repeat until __mudix_pump(deadline)
    return true
end

-- Mudlet wait(msec) — TLuaInterpreter::Wait, an internal blocking sleep. It
-- blocks the whole interpreter there (msleep), and does here too: the loop burns
-- real time without giving the browser its thread back, which is the semantics
-- the callers rely on. Nothing in mudix's own code calls it; it exists because
-- Mudlet packages do.
function wait(...)
    if select('#', ...) ~= 1 then
        error("Wait: wrong number of arguments", 0)
    end
    local raw = ...
    local msec = __mudix_int(raw)
    if msec == nil then
        error("Wait: bad argument #1 type (sleep time in msec as number expected, got "
            .. type(raw) .. "!)", 2)
    end
    local deadline = __mudix_uptime_ms() + math.max(0, msec)
    while __mudix_uptime_ms() < deadline do end
end

-- Mudlet receiveMSP(text) — feed an MSP payload as if the server had sent it.
-- Refused unless MSP was actually negotiated on this connection (Mudlet checks
-- ctelnet::isMSPEnabled, which is the negotiated latch and not the profile's
-- enableMSP config). Mudlet tests the gate before the argument type, so a call
-- on a non-MSP connection reports that rather than complaining about arguments.
function receiveMSP(text)
    if not __mudix_is_msp_enabled() then
        return nil, "receiveMSP: MSP is not currently enabled"
    end
    text = __mudix_check_string(text, "receiveMSP", 1, "message")
    return __mudix_receiveMSP(text)
end

-- Mudlet connectToServer(host [, port [, save]]). The port is range-checked and
-- reported as (nil, errMsg) rather than raising, since it's a value problem
-- rather than a type one (TLuaInterpreterNetworking.cpp).
function connectToServer(host, port, save)
    host = __mudix_check_string(host, "connectToServer", 1, "url")
    if port ~= nil then
        local num = __mudix_int(port)
        if num == nil then
            error("connectToServer: bad argument #2 type (port number as number is optional, got "
                .. type(port) .. "!)", 2)
        end
        port = num
        if port < 1 or port > 65535 then
            return nil, "connectToServer: invalid port number " .. tostring(port)
                .. " given, if supplied it must be in range 1 to 65535,"
                .. " {defaults to 23 if not provided}"
        end
    end
    return __mudix_connectToServer(host, port, save)
end

-- ── Discord Rich Presence ──────────────────────────────────────────────────
-- Discord's rich presence rides a local IPC socket (a named pipe on Windows, a
-- unix socket elsewhere) to the Discord desktop app. A browser tab cannot open
-- one, so the API is permanently unavailable here — which is a state Mudlet
-- already has a contract for: when discord-rpc will not load,
-- TLuaInterpreter::discordApiEnabled denies every gated call with
-- (nil, "Discord API is not available").
--
-- Answering that rather than a bare nil is the whole point. A script calling
-- getDiscordState() and getting nil cannot tell "no state has been set" from
-- "there is no Discord here"; Mudlet's own contract distinguishes them, and
-- every script that feature-tests Discord reads the second return to do it.
do
    local DENIAL = "Discord API is not available"
    -- Exactly Mudlet's gated set (TLuaInterpreterDiscord.cpp): every function
    -- that routes through discordApiEnabled(). setDiscordGameUrl is deliberately
    -- absent — Mudlet does not gate it, and it writes ordinary profile data.
    for _, name in ipairs({
        "usingMudletsDiscordID", "getDiscordDetail", "getDiscordLargeIcon",
        "getDiscordLargeIconText", "getDiscordParty", "getDiscordSmallIcon",
        "getDiscordSmallIconText", "getDiscordState", "getDiscordTimeStamps",
        "resetDiscordData", "setDiscordApplicationID", "setDiscordDetail",
        "setDiscordElapsedStartTime", "setDiscordGame", "setDiscordLargeIcon",
        "setDiscordLargeIconText", "setDiscordParty", "setDiscordRemainingEndTime",
        "setDiscordSmallIcon", "setDiscordSmallIconText", "setDiscordState",
    }) do
        _G[name] = function() return nil, DENIAL end
    end
end

-- setDiscordGameUrl sets the profile's invite-button url. mudix has no Discord
-- integration so the action itself is a no-op stub, but the argument contract is
-- still observable, and scripts feature-test with it.
do
    local _raw = setDiscordGameUrl
    function setDiscordGameUrl(url)
        url = __mudix_check_string(url, "setDiscordGameUrl", 1, "url")
        return _raw(url)
    end
end

-- Mudlet openUrl(url) — the url must be a string; anything else is a raise.
do
    local _raw = openUrl
    function openUrl(url)
        url = __mudix_check_string(url, "openUrl", 1, "url")
        return _raw(url)
    end
end

function downloadFile(saveTo, url)
    saveTo = __mudix_check_string(saveTo, "downloadFile", 1, "local filename")
    url = __mudix_check_string(url, "downloadFile", 2, "remote url")
    local err = __mudix_http_url_error(url, "downloadFile")
    if err then return nil, err end
    __downloadFile(saveTo, url)
    return true, url
end

function getHTTP(url, headers)
    url = __mudix_check_string(url, "getHTTP", 1, "remote url")
    __mudix_check_headers(headers, "getHTTP", 2)
    local err = __mudix_http_url_error(url, "getHTTP")
    if err then return nil, err end
    __getHTTP(url, __mudix_headers_to_string(headers))
    return true, url
end

-- Mudlet opens the upload file before issuing the request and reports
-- (nil, "<fn>: couldn't open ...") when it can't — no request, no error event.
local function __mudix_upload_error(file, who)
    if file == nil then return nil end
    local reason = __mudix_upload_file_error(file)
    if reason then return who .. ": " .. reason end
    return nil
end

-- The data argument may be nil when a file is being uploaded instead: the file's
-- contents ARE the body then, and demanding a string as well would mean passing
-- one that is thrown away. Mudlet allows it, and a caller uploading a file has
-- nothing sensible to put there.
function __mudix_check_upload_data(data, who, what, file)
    if data == nil and type(file) == 'string' and file ~= '' then return end
    data = __mudix_check_string(data, who, 1, what)
end

function postHTTP(data, url, headers, file)
    __mudix_check_upload_data(data, "postHTTP", "post data", file)
    url = __mudix_check_string(url, "postHTTP", 2, "remote url")
    __mudix_check_headers(headers, "postHTTP", 3)
    local err = __mudix_http_url_error(url, "postHTTP")
    if err then return nil, err end
    local ferr = __mudix_upload_error(file, "postHTTP")
    if ferr then return nil, ferr end
    __postHTTP(data, url, __mudix_headers_to_string(headers), file)
    return true, url
end

function putHTTP(data, url, headers, file)
    __mudix_check_upload_data(data, "putHTTP", "put data", file)
    url = __mudix_check_string(url, "putHTTP", 2, "remote url")
    __mudix_check_headers(headers, "putHTTP", 3)
    local err = __mudix_http_url_error(url, "putHTTP")
    if err then return nil, err end
    local ferr = __mudix_upload_error(file, "putHTTP")
    if ferr then return nil, ferr end
    __putHTTP(data, url, __mudix_headers_to_string(headers), file)
    return true, url
end

function deleteHTTP(url, headers)
    url = __mudix_check_string(url, "deleteHTTP", 1, "remote url")
    __mudix_check_headers(headers, "deleteHTTP", 2)
    local err = __mudix_http_url_error(url, "deleteHTTP")
    if err then return nil, err end
    __deleteHTTP(url, __mudix_headers_to_string(headers))
    return true, url
end

function customHTTP(method, data, url, headers, file)
    method = __mudix_check_string(method, "customHTTP", 1, "custom method")
    data = __mudix_check_string(data, "customHTTP", 2, "post data")
    url = __mudix_check_string(url, "customHTTP", 3, "remote url")
    __mudix_check_headers(headers, "customHTTP", 4)
    -- publicType here is "string location", not plain "string", so the message
    -- is built inline rather than through __mudix_check_string.
    if file ~= nil then
        local path = __mudix_str(file)
        if path == nil then
            error("customHTTP: bad argument #5 type (file to send as string location expected, got "
                .. type(file) .. "!)", 2)
        end
        file = path
    end
    local err = __mudix_http_url_error(url, "customHTTP")
    if err then return nil, err end
    local ferr = __mudix_upload_error(file, "customHTTP")
    if ferr then return nil, ferr end
    __customHTTP(method, data, url, __mudix_headers_to_string(headers), file)
    return true, url
end

-- Mudlet getCustomEnvColorTable() → { [envID] = { r, g, b, a } } with the
-- inner table 1-indexed. JS hands the inner over as { r=, g=, b=, a= }; rebuild
-- as a 4-element 1-indexed array. envID keys cross the wasmoon bridge as
-- numeric strings — coerce back to number so script code that does t[i] works.
function getCustomEnvColorTable()
    local raw = __getCustomEnvColorTable()
    local out = {}
    if type(raw) == 'table' then
        for k, c in pairs(raw) do
            local id = tonumber(k)
            if id and type(c) == 'table' then
                out[id] = { c.r, c.g, c.b, c.a }
            end
        end
    end
    return out
end

-- Mudlet getMapEvents() → { [uniqueName] = { ["event name"]=..., ["parent"]=...,
-- ["display name"]=..., ["arguments"]={...} } }. JS hands back an array of
-- entries (0-indexed); rebuild into Mudlet's exact key/shape so scripts can
-- index by literal string keys.
function getMapEvents()
    local raw = __getMapEvents()
    local out = {}
    if type(raw) == 'table' then
        local i = 0
        while raw[i] ~= nil do
            local e = raw[i]
            local args = {}
            local rawArgs = e.args
            if type(rawArgs) == 'table' then
                local j = 0
                while rawArgs[j] ~= nil do
                    args[#args + 1] = rawArgs[j]
                    j = j + 1
                end
                if #args == 0 then
                    for _, v in ipairs(rawArgs) do args[#args + 1] = v end
                end
            end
            out[e.uniqueName] = {
                ["event name"]   = e.eventName,
                ["parent"]       = e.parent or "",
                ["display name"] = e.displayName,
                ["arguments"]    = args,
            }
            i = i + 1
        end
    end
    return out
end

-- Mudlet getMapMenus() → { [menuName] = parentName }, where a top-level menu's
-- value is the string "top-level". JS hands back an array of entries
-- (0-indexed); rebuild into that keyed shape so scripts can index by menu name.
-- With keyByUniqueName the entries are keyed by their registration name and the
-- value becomes { ["display name"] = ..., parent = ... } instead — that's the
-- form whose keys line up with the `parent` getMapEvents reports, since a menu's
-- display name is what the default form keys by.
function getMapMenus(keyByUniqueName)
    local raw = __getMapMenus()
    local out = {}
    if type(raw) == 'table' then
        local i = 0
        while raw[i] ~= nil do
            local m = raw[i]
            local parent = (m.parent and m.parent ~= "") and m.parent or "top-level"
            if keyByUniqueName then
                out[m.name] = { ["display name"] = m.displayName, parent = parent }
            else
                out[m.displayName] = parent
            end
            i = i + 1
        end
    end
    return out
end

-- Mudlet setRoomBorderColor(id, r, g, b [, a]) / setRoomBorderThickness(id, t) →
-- true, or (nil, errMsg) for a bad value or a missing room. The __* binding
-- returns true on success or an error string.
function setRoomBorderColor(id, r, g, b, a)
    local res = __setRoomBorderColor(id, r, g, b, a)
    if res == true then return true end
    return nil, res
end

-- getRoomBorderColor(id) → r, g, b, a (or nil when no custom colour is set). JS
-- hands back a 0-indexed array or nil.
function getRoomBorderColor(id)
    local t = __getRoomBorderColor(id)
    if t == nil then return nil end
    return t[0], t[1], t[2], t[3]
end

function setRoomBorderThickness(id, t)
    local res = __setRoomBorderThickness(id, t)
    if res == true then return true end
    return nil, res
end

-- Mudlet getMapInfo() → { [label] = enabledBool }. JS hands back the contributor
-- array ({ label, enabled, ... } entries, 0-indexed); rebuild the keyed table.
function getMapInfo()
    local raw = __getMapInfo()
    local out = {}
    if type(raw) == 'table' then
        local i = 0
        while raw[i] ~= nil do
            out[raw[i].label] = raw[i].enabled
            i = i + 1
        end
    end
    return out
end

-- Mudlet getStopWatches() → { [watchID] = { name, isRunning, isPersistent,
-- elapsedTime = {...} } }. JS hands ids over as stringified keys (wasmoon
-- convention); re-key via tonumber to integer ids and rebuild each record off
-- the proxy so callers never touch the wasmoon table directly.
function getStopWatches()
    local raw = __getStopWatches()
    local out = {}
    if type(raw) == 'table' then
        for k, v in pairs(raw) do
            local id = tonumber(k) or k
            local e = v.elapsedTime or {}
            out[id] = {
                name = v.name,
                isRunning = v.isRunning,
                isPersistent = v.isPersistent,
                elapsedTime = {
                    negative = e.negative,
                    days = e.days,
                    hours = e.hours,
                    minutes = e.minutes,
                    seconds = e.seconds,
                    milliSeconds = e.milliSeconds,
                    decimalSeconds = e.decimalSeconds,
                },
            }
        end
    end
    return out
end

-- Mudlet getStopWatchBrokenDownTime(watchID|name) → a day/hour/minute/second/
-- millisecond table. The __ binding returns the record (or nil for an unknown
-- watch); rebuild it off the wasmoon proxy, mapping the miss to false.
function getStopWatchBrokenDownTime(arg)
    local e = __getStopWatchBrokenDownTime(arg)
    if type(e) ~= 'table' then return false end
    return {
        negative = e.negative,
        days = e.days,
        hours = e.hours,
        minutes = e.minutes,
        seconds = e.seconds,
        milliSeconds = e.milliSeconds,
        decimalSeconds = e.decimalSeconds,
    }
end

-- Mudlet getSpecialExits(roomID [, listAllExits]) → { [exitRoomID] =
-- { [command] = "0"|"1" } }. JS hands the outer table over with stringified
-- numeric room-id keys (wasmoon convention); re-key via tonumber so callers can
-- index by integer destination room id. The inner command→lockState table is
-- rebuilt off the proxy so callers never touch the wasmoon table directly.
function getSpecialExits(roomId, listAllExits)
    local raw = __getSpecialExits(roomId, listAllExits)
    local out = {}
    if type(raw) == 'table' then
        for k, v in pairs(raw) do
            local id = tonumber(k) or k
            local inner = {}
            if type(v) == 'table' then
                for cmd, lock in pairs(v) do inner[cmd] = lock end
            end
            out[id] = inner
        end
    end
    return out
end

-- Mudlet getMapLabels(areaID) → { [labelID] = labelText }. JS hands the
-- per-area label record over with stringified numeric keys (wasmoon
-- convention); re-key via tonumber so scripts can index by integer label id
-- and pass that same id straight back into deleteMapLabel.
function getMapLabels(areaId)
    local raw = __getMapLabels(areaId)
    local out = {}
    if type(raw) == 'table' then
        for k, v in pairs(raw) do
            local id = tonumber(k)
            if id then out[id] = v end
        end
    end
    return out
end

-- Build a fresh Lua table from a JS-side label info proxy so the caller never
-- touches the wasmoon proxy directly (some proxy operations are flaky once the
-- bridge has moved on). Mirrors Mudlet's pushMapLabelPropertiesToLua key set.
local function _buildMapLabelInfo(p)
    if type(p) ~= 'table' then return nil end
    local fg = p.FgColor or {}
    local bg = p.BgColor or {}
    return {
        X = p.X, Y = p.Y, Z = p.Z,
        Width = p.Width, Height = p.Height,
        Text = p.Text,
        Pixmap = p.Pixmap,
        OnTop = p.OnTop,
        Scaling = p.Scaling,
        Temporary = p.Temporary,
        FgColor = { r = fg.r, g = fg.g, b = fg.b },
        BgColor = { r = bg.r, g = bg.g, b = bg.b },
    }
end

-- Mudlet getMapLabel(areaID, labelID|labelText). By-ID returns a flat
-- properties table; by-text returns { [labelID] = properties, ... } for every
-- matching label. Missing area or missing labelID → (false, errMsg) — matching
-- Mudlet's warnArgumentValue convention. An area with no labels at all returns
-- an empty table regardless of the lookup form.
function getMapLabel(areaId, key)
    local kt = type(key)
    if kt ~= 'number' and kt ~= 'string' then
        error('getMapLabel: bad argument #2 type (labelID as number or labelText as string expected, got ' .. kt .. '!)', 2)
    end
    if kt == 'number' and key < 0 then
        return nil, 'getMapLabel: labelID ' .. tostring(key) .. ' is invalid, it must be zero or greater'
    end
    local r = __getMapLabel(areaId, key)
    if type(r) ~= 'table' then return nil, 'getMapLabel: unexpected result' end
    if r.ok == false then
        if r.err == 'noarea' then
            return nil, 'getMapLabel: areaID ' .. tostring(areaId) .. ' does not exist'
        end
        if r.err == 'noid' then
            return nil, 'getMapLabel: labelID ' .. tostring(key) .. ' does not exist in area with areaID ' .. tostring(areaId)
        end
        return nil, tostring(r.err or 'getMapLabel: failed')
    end
    if r.single then return _buildMapLabelInfo(r.single) end
    if r.multi then
        local out = {}
        if type(r.multi) == 'table' then
            for k, v in pairs(r.multi) do
                local id = tonumber(k)
                if id then out[id] = _buildMapLabelInfo(v) end
            end
        end
        return out
    end
    return {}
end

-- Mudlet getProfiles() — a table keyed by profile name, one entry per configured
-- connection: { host, port, loaded, connected, description }. `loaded` means the
-- profile is open (in some browser tab — each profile lives in its own tab) and
-- `connected` means it's connected to its game. JS builds the record (Web Locks
-- for `loaded`, cross-tab presence for `connected`); rebuild it into a clean Lua
-- table since wasmoon hands JS objects over as proxies.
function getProfiles()
    local raw = __getProfiles and __getProfiles() or nil
    local out = {}
    if type(raw) == 'table' then
        for name, info in pairs(raw) do
            local loaded = info.loaded and true or false
            out[name] = {
                host        = info.host or '',
                port        = tostring(info.port or ''),
                loaded      = loaded,
                description = info.description or '',
            }
            -- Set only for a profile that is open: an unloaded one has no
            -- connection to report on, and a flat false would claim it is open
            -- and idle. Written as a statement because `loaded and false or nil`
            -- collapses a legitimate false to nil.
            if loaded then
                out[name].connected = info.connected and true or false
            end
        end
    end
    return out
end

-- Mudlet auditAreas() — repair area/room membership consistency. mudix returns
-- a summary report: { checkedAreas, checkedRooms, fixedAreas, orphanRooms={...},
-- danglingRefs={...} }. JS hands the id arrays over 0-indexed; rebuild them as
-- 1-indexed Lua arrays.
function auditAreas()
    local r = __auditAreas()
    local function reindex(a)
        local out = {}
        if type(a) == 'table' then
            local i = 0
            while a[i] ~= nil do out[#out + 1] = a[i]; i = i + 1 end
            if #out == 0 then for _, v in ipairs(a) do out[#out + 1] = v end end
        end
        return out
    end
    if type(r) ~= 'table' then return {} end
    return {
        checkedAreas = r.checkedAreas or 0,
        checkedRooms = r.checkedRooms or 0,
        fixedAreas   = r.fixedAreas or 0,
        orphanRooms  = reindex(r.orphanRooms),
        danglingRefs = reindex(r.danglingRefs),
    }
end

-- Mudlet createMapLabel(areaID, text, posx, posy, posz, fgRed, fgGreen, fgBlue,
-- bgRed, bgGreen, bgBlue, zoom, fontSize, showOnTop, noScaling). The label is
-- stored, queryable via getMapLabel, and painted by the renderer; the (display)
-- `zoom` arg is dropped while `fontSize` sizes the label box. → new labelID, or
-- -1 if the area is missing.
function createMapLabel(areaID, text, posx, posy, posz, fgR, fgG, fgB, bgR, bgG, bgB, _zoom, fontSize, showOnTop, noScaling)
    return __createMapLabel(areaID, tostring(text or ''), posx, posy, posz, fgR, fgG, fgB, bgR, bgG, bgB, fontSize, showOnTop, noScaling)
end

-- Mudlet createMapImageLabel(areaID, imagePathFileName, posx, posy, posz, width,
-- height, zoom, showOnTop, scaling). `scaling` (Mudlet) is the inverse of the
-- stored noScaling flag; default scaling=true. → new labelID, or -1 if missing.
function createMapImageLabel(areaID, imagePath, posx, posy, posz, width, height, _zoom, showOnTop, scaling)
    local noScaling = (scaling == false)
    return __createMapImageLabel(areaID, tostring(imagePath or ''), posx, posy, posz, width, height, showOnTop, noScaling)
end

-- Mudlet addAreaName(name) → areaID on success, or (false, errMsg) on
-- duplicate / empty name. JS hands back either a number or a table
-- { ok=false, err=... } (wasmoon flattens it to numeric keys 0/1 across the
-- bridge — we tolerate both shapes).
function addAreaName(name)
    local r = __addAreaName(name)
    if type(r) == 'number' then return r end
    if type(r) == 'table' then
        local err = r.err or r[1] or r[0] or 'addAreaName: failed'
        return nil, err
    end
    return nil, 'addAreaName: failed'
end

-- Mudlet setAreaName(areaID|areaName, newName) → true on success, or
-- (false, errMsg) on duplicate/missing/empty.
function setAreaName(idOrName, newName)
    local r = __setAreaName(idOrName, newName)
    if r == true then return true end
    if type(r) == 'table' then
        local err = r.err or r[1] or r[0] or 'setAreaName: failed'
        return nil, err
    end
    return nil, 'setAreaName: failed'
end

-- Mudlet getPackages() → 1-indexed Lua array of installed package names. JS
-- arrays come in 0-indexed via wasmoon; rebuild as ipairs-friendly.
local function rebuildJsArray(t)
    local out = {}
    if type(t) == 'table' then
        local i = 0
        while t[i] ~= nil do
            out[#out + 1] = t[i]
            i = i + 1
        end
        if #out == 0 then for _, v in ipairs(t) do out[#out + 1] = v end end
    end
    return out
end

function getPackages()
    return rebuildJsArray(__getPackages())
end

-- Mudlet installPackage(path)/installModule(path) → (true) on success,
-- (false, errorMessage) on failure. The JS bridge can only push one Lua value,
-- so it hands back a { ok, error } table; reshape into the documented
-- multi-return so callers like Other.lua's verbosePackageInstall (which does
-- `local ok, err = installPackage(...)`) get the error string instead of nil.
local function installOutcome(r)
    if type(r) == 'table' then
        if r.ok then return true end
        -- nil, not false: Mudlet refuses through warnArgumentValue, which pushes
        -- nil + the message. Both are falsy so an `if installPackage(p) then`
        -- caller could not tell, but the documented contract is nil and scripts
        -- do test for it — Package_spec probes `installPackage("") == nil` to
        -- find out whether a profile save is in flight, and read `false` as
        -- "still saving" forever.
        return nil, r.error
    end
    -- Defensive: an unexpected scalar still resolves to the same shape.
    if r then return true end
    return nil
end

function installPackage(path)
    return installOutcome(__installPackage(path))
end

function installModule(path)
    return installOutcome(__installModule(path))
end

-- Mudlet getModules() — same shape as getPackages(), but lists modules only.
function getModules()
    return rebuildJsArray(__getModules())
end

-- Mudlet getLines([window,] from, to) → 1-indexed table of line strings.
-- JS hands back a 0-indexed array via wasmoon; rebuild as ipairs-friendly.
function getLines(a, b, c)
    return rebuildJsArray(__getLines(a, b, c))
end

-- Mudlet syncModule(name). The JS side runs the actual write asynchronously;
-- this wrapper kicks it off and returns immediately. sysSyncOnModule fires
-- on completion.
function syncModule(name)
    __mudix_syncModule(name)
end

-- Mudlet getModuleInfo(name [, key]) — returns the manifest as a table when
-- called with one argument, or a single string when called with a key.
-- Mudlet exposes a fixed set of keys (author, title, description, version,
-- created, package); we forward whatever the manifest carries.
-- A module nobody installed is an empty table, not nil, and a field it does not
-- carry is the empty string — the same shape getPackageInfo answers with, and
-- what a caller indexing the result straight away needs so that a typo'd name
-- reads as "nothing set" rather than crashing on a nil index.
function getModuleInfo(name, key)
    local info = __getModuleInfo(name) or {}
    if key == nil then return info end
    local v = info[key]
    if v == nil then return "" end
    return v
end

-- Mudlet getPackageInfo(name [, key]) — returns the merged info table (manifest
-- fields overlaid with anything set via setPackageInfo) when called with one
-- argument, or a single string when called with a key (empty string when the
-- key is absent, matching Mudlet).
function getPackageInfo(name, key)
    local info = __getPackageInfo(name) or {}
    if key == nil then return info end
    return info[key] or ""
end

-- Mudlet getTime([asString, format]) → table or string.
--   getTime()                    → { year, month, day, hour, min, sec, msec }
--   getTime(true)                → string formatted with "hh:mm:ss.zzz"
--   getTime(true, fmt)           → string formatted with QDateTime tokens:
--     yyyy/yy, MMMM/MMM/MM/M, dddd/ddd/dd/d, HH/H (24h), hh/h (12h if AP present
--     in format, otherwise 24h), mm/m, ss/s, zzz/z (ms), AP/A (uppercase) and
--     ap/a (lowercase) for AM/PM. Unrecognized characters pass through literally.
do
    local DAYS_SHORT   = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"}
    local DAYS_LONG    = {"Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"}
    local MONTHS_SHORT = {"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"}
    local MONTHS_LONG  = {"January","February","March","April","May","June","July","August","September","October","November","December"}
    -- Tokens scanned longest-first so "yyyy" beats "yy", "MMMM" beats "MM", etc.
    local TOKENS = {
        "yyyy","yy",
        "MMMM","MMM","MM","M",
        "dddd","ddd","dd","d",
        "HH","H","hh","h",
        "mm","m",
        "ss","s",
        "zzz","z",
        "AP","ap","A","a",
    }

    local function formatTime(t, fmt)
        local wdayIdx = (t.wday or 0) + 1
        local isPM = t.hour >= 12
        local h12 = t.hour % 12; if h12 == 0 then h12 = 12 end
        -- h/hh switch to 12-hour when an AM/PM token is present in the format
        -- (Qt QDateTime semantics). H/HH are always 24-hour regardless.
        local hasAP = fmt:find("AP") or fmt:find("ap") or fmt:find("A") or fmt:find("a")
        local R = {
            yyyy = string.format("%04d", t.year),
            yy   = string.format("%02d", t.year % 100),
            MMMM = MONTHS_LONG[t.month] or "",
            MMM  = MONTHS_SHORT[t.month] or "",
            MM   = string.format("%02d", t.month),
            M    = tostring(t.month),
            dddd = DAYS_LONG[wdayIdx] or "",
            ddd  = DAYS_SHORT[wdayIdx] or "",
            dd   = string.format("%02d", t.day),
            d    = tostring(t.day),
            HH   = string.format("%02d", t.hour),
            H    = tostring(t.hour),
            hh   = string.format("%02d", hasAP and h12 or t.hour),
            h    = tostring(hasAP and h12 or t.hour),
            mm   = string.format("%02d", t.min),
            m    = tostring(t.min),
            ss   = string.format("%02d", t.sec),
            s    = tostring(t.sec),
            zzz  = string.format("%03d", t.msec),
            z    = tostring(t.msec),
            AP   = isPM and "PM" or "AM",
            A    = isPM and "PM" or "AM",
            ap   = isPM and "pm" or "am",
            a    = isPM and "pm" or "am",
        }
        local out, i, n = {}, 1, #fmt
        while i <= n do
            local matched = false
            for _, tok in ipairs(TOKENS) do
                local len = #tok
                if fmt:sub(i, i + len - 1) == tok then
                    out[#out+1] = R[tok]
                    i = i + len
                    matched = true
                    break
                end
            end
            if not matched then
                out[#out+1] = fmt:sub(i, i)
                i = i + 1
            end
        end
        return table.concat(out)
    end

    function getTime(asString, format)
        -- Both arguments are optional, but a wrong type is not the same as an
        -- absent one: passing a string where the boolean goes used to be read
        -- as "truthy, so give me a string", quietly ignoring the mistake.
        if asString ~= nil and type(asString) ~= 'boolean' then
            error("getTime: bad argument #1 type (return as string as boolean is optional, got "
                .. type(asString) .. "!)", 2)
        end
        if format ~= nil then
            local pattern = __mudix_str(format)
            if pattern == nil then
                error("getTime: bad argument #2 type (format as string is optional, got "
                    .. type(format) .. "!)", 2)
            end
            format = pattern
        end
        local t = __getTime()
        if not asString then
            return {
                year = t.year, month = t.month, day = t.day,
                hour = t.hour, min   = t.min,   sec = t.sec,
                msec = t.msec,
            }
        end
        -- Mudlet's documented default is the full stamp, not just the clock.
        return formatTime(t, format or "yyyy.MM.dd hh:mm:ss.zzz")
    end
end

-- Mudlet-compatible getMudletVersion. Behaviour:
--   no arg / nil      → table { major, minor, revision, build }
--   "string"          → "major.minor.revision[-build]"
--   "major" / "minor" / "revision" / "build" → field value
--   "table"           → major, minor, revision as 3 separate return values
--                       (mudlet-lua's mudletOlderThan relies on this)
do
    local MAJOR, MINOR, REVISION, BUILD = 4, 21, 0, ""
    function getMudletVersion(mode)
        if mode == nil then
            return { major = MAJOR, minor = MINOR, revision = REVISION, build = BUILD }
        elseif mode == "string" then
            if BUILD ~= "" then
                return string.format("%d.%d.%d-%s", MAJOR, MINOR, REVISION, BUILD)
            end
            return string.format("%d.%d.%d", MAJOR, MINOR, REVISION)
        elseif mode == "major"    then return MAJOR
        elseif mode == "minor"    then return MINOR
        elseif mode == "revision" then return REVISION
        elseif mode == "build"    then return BUILD
        elseif mode == "table"    then return MAJOR, MINOR, REVISION, BUILD
        else
            error('getMudletVersion: bad argument (expected nil/"string"/"major"/"minor"/"revision"/"build"/"table", got "' .. tostring(mode) .. '")', 2)
        end
    end
end

-- Mudlet saveProfile([location]). zustand state is already auto-saved on every
-- mutation; this call additionally forces pending VFS writes (and any debounced
-- SQL snapshots) through to IndexedDB / the linked folder. Synchronous failure
-- (no VFS available) returns (nil, errMsg). Async flush errors raise the
-- `sysSaveProfileError` event so callers can subscribe for the failure.
function saveProfile(location)
    local r = __mudix_saveProfile(location)
    if type(r) == 'table' then
        local ok = r[0]; if ok == nil then ok = r[1] end
        local val = r[1]; if r[0] == nil then val = r[2] end
        if ok == false then return nil, val end
        return true, val
    end
    -- Fallback for older runtime shape.
    return true, r or ''
end

-- Mudlet loadReplay(fileName) → true on success, (nil, errMsg) on failure.
-- Plays back a Mudlet binary replay (.dat) from the profile filesystem: the
-- recorded telnet stream is fed through the normal parsing pipeline on its
-- original timeline, so triggers/GMCP/rendering behave as they did live.
function loadReplay(fileName)
    local r = __mudix_loadReplay(fileName)
    if type(r) == 'table' then
        local ok = r[0]; if ok == nil then ok = r[1] end
        local val = r[1]; if r[0] == nil then val = r[2] end
        if ok == false then return nil, val end
        return true
    end
    if r then return true end
    return nil, 'unable to start replay'
end
-- Mudlet registers loadReplay under this legacy name too.
loadRawFile = loadReplay

-- Mudlet setProfileIcon(path) → (true, path) on success, (nil, errorMessage)
-- on failure. The JS bridge reads the VFS image and inlines it, returning a
-- { ok, path } / { ok=false, error } table (it can only push one Lua value);
-- reshape into the documented multi-return.
function setProfileIcon(path)
    local r = __setProfileIcon(path)
    if type(r) == 'table' then
        if r.ok then return true, r.path end
        return nil, r.error
    end
    if r then return true end
    return nil, "setProfileIcon: could not set the icon"
end

-- Callback registry: stores Lua functions handed to tempTimer/Alias/Trigger/Key
-- so JS only ever sees a numeric ID. JS invokes __mudix_dispatch_cb(id) via
-- doStringSync, sidestepping wasmoon's broken Lua-function-from-JS proxy.
__mudix_cb = {}
__mudix_cb_next = 0
function __mudix_register_cb(fn)
    __mudix_cb_next = __mudix_cb_next + 1
    __mudix_cb[__mudix_cb_next] = fn
    return __mudix_cb_next
end
function __mudix_unregister_cb(id) __mudix_cb[id] = nil end
function __mudix_dispatch_cb(id)
    local fn = __mudix_cb[id]
    if fn then return fn() end
end
-- Variant for callbacks that receive a single argument (label mouse events
-- carry a {button, x, y, ...} table). JS sets __mudix_cb_arg before invoking.
function __mudix_dispatch_cb_arg(id)
    local fn = __mudix_cb[id]
    if fn then return fn(__mudix_cb_arg) end
end

-- Yield-transparent pcall. Runs `fn` on a private coroutine so a runtime
-- error is caught like pcall, but a coroutine.yield inside `fn` (that is:
-- invokeFileDialog) is forwarded outward to the JS resume boundary instead of
-- erroring — in Lua 5.1 pcall is a C frame and yielding across it raises
-- "attempt to yield across metamethod/C-call boundary". Values fed back by
-- the next outer resume are passed straight into the inner coroutine, so `fn`
-- observes a plain yield/resume round trip. Used by __exec (Exec.lua) and the
-- event-dispatch loops below wherever plain pcall would sit between the JS
-- entry point and user code.
function __mudix_pcall_co(fn, ...)
    -- coroutine.create rejects C functions (JS-bound API globals). Those can't
    -- yield across the C boundary anyway, so plain pcall is equivalent.
    local okc, co = pcall(coroutine.create, fn)
    if not okc then return pcall(fn, ...) end
    local function step(ok, ...)
        if not ok then return false, ... end
        if coroutine.status(co) == 'suspended' then
            return step(coroutine.resume(co, coroutine.yield(...)))
        end
        return true, ...
    end
    return step(coroutine.resume(co, ...))
end

-- Mudlet invokeFileDialog(fileOrFolder, dialogTitle[, dialogLocation]).
-- fileOrFolder = true → pick a file, false → pick a folder (Mudlet's arg
-- shape: QFileDialog::getOpenFileName vs getExistingDirectory). The picker
-- browses the profile VFS — Mudlet's default dialog location is the profile
-- home dir, which is exactly getMudletHomeDir() here, and a native OS path
-- would be useless to the VFS-backed io.*/lfs anyway. Returns the picked
-- absolute VFS path, or '' when cancelled (Mudlet returns '' too).
--
-- Mudlet blocks inside QFileDialog; a browser can't block, but every JS→Lua
-- entry runs on its own coroutine (execInner/runChunk in LuaRuntime.ts), so
-- we yield a sentinel plus the request args to the JS resume boundary. JS
-- parks this thread, shows the picker, and resumes it with the chosen path —
-- from the calling script's perspective the function simply returns it.
-- matches/multimatches/namedCaptures are globals shared with any trigger that
-- fires while the picker is open, so snapshot and restore them around the
-- suspension.
do
    local SENTINEL = '\1__mudix_file_dialog'
    function invokeFileDialog(fileOrFolder, dialogTitle, dialogLocation)
        -- Checked before the yield: suspending first would open a picker for a
        -- call that was never going to be valid, and the error would surface at
        -- the resume boundary rather than at the caller.
        if type(fileOrFolder) ~= 'boolean' then
            error("invokeFileDialog: bad argument #1 type (file or folder as boolean expected, got "
                .. type(fileOrFolder) .. "!)", 2)
        end
        local title = __mudix_str(dialogTitle)
        if title == nil then
            error("invokeFileDialog: bad argument #2 type (dialog title as string expected, got "
                .. type(dialogTitle) .. "!)", 2)
        end
        dialogTitle = title
        local m, mm, nc = matches, multimatches, namedCaptures
        local path = coroutine.yield(SENTINEL,
            fileOrFolder and true or false,
            dialogTitle == nil and '' or tostring(dialogTitle),
            dialogLocation == nil and '' or tostring(dialogLocation))
        matches, multimatches, namedCaptures = m, mm, nc
        return type(path) == 'string' and path or ''
    end
end

-- Mirrors Mudlet's TLuaInterpreter::parseJSON gmcp-table walk: descend
-- gmcp.<part1>.<part2>... creating intermediate tables on demand and
-- replace only the leaf, so siblings under the same parent survive.
-- Mudlet setMergeTables(...): collects GMCP keys (dotted, e.g. "Char.Status")
-- whose incoming payloads should be merged into the existing gmcp sub-table on
-- update instead of wholesale-replaced. Mirrors Host::mGMCP_merge_table_keys —
-- pure Lua, no host call. The accumulated list is visible as mudlet.mergeTables.
mudlet = mudlet or {}
mudlet.mergeTables = mudlet.mergeTables or {}
function setMergeTables(...)
    -- Re-assert at call time: bundled Lua (LuaGlobal/Other) may reinitialise the
    -- `mudlet` table after this file loads, so don't rely on the load-time init.
    mudlet = mudlet or {}
    mudlet.mergeTables = mudlet.mergeTables or {}
    for _, name in ipairs({...}) do
        name = tostring(name)
        local dup = false
        for _, existing in ipairs(mudlet.mergeTables) do
            if existing == name then dup = true; break end
        end
        if not dup then mudlet.mergeTables[#mudlet.mergeTables + 1] = name end
    end
end

function __mudix_set_gmcp(key, value)
    if type(gmcp) ~= 'table' then gmcp = {} end
    local parts = {}
    for part in string.gmatch(key, '[^.]+') do parts[#parts + 1] = part end
    if #parts == 0 then return end
    local node = gmcp
    for i = 1, #parts - 1 do
        local k = parts[i]
        if type(node[k]) ~= 'table' then node[k] = {} end
        node = node[k]
    end
    local leaf = parts[#parts]
    -- Honour setMergeTables: merge the incoming keys into the existing sub-table
    -- rather than replacing it, when this exact dotted key was registered.
    local merge = false
    if type(mudlet) == 'table' and type(mudlet.mergeTables) == 'table' then
        for _, name in ipairs(mudlet.mergeTables) do
            if name == key then merge = true; break end
        end
    end
    if merge and type(node[leaf]) == 'table' and type(value) == 'table' then
        for k, v in pairs(value) do node[leaf][k] = v end
    else
        node[leaf] = value
    end
end

-- MSDP equivalent of __mudix_set_gmcp. MSDP variable names are flat (any
-- nesting lives inside the value), so we replace the single top-level key.
function __mudix_set_msdp(key, value)
    if type(msdp) ~= 'table' then msdp = {} end
    msdp[key] = value
end

-- MSSP equivalent: flat scalar status fields keyed by variable name, mirroring
-- Mudlet's `mssp` global (mssp.PLAYERS, mssp.UPTIME, ...).
function __mudix_set_mssp(key, value)
    if type(mssp) ~= 'table' then mssp = {} end
    mssp[key] = value
end

-- Mudlet's `mxp` global: each use of a server-defined custom element replaces
-- mxp.<element> wholesale (signalMXPEvent builds a fresh table), with the tag's
-- attributes as lowercased keys plus `text` and an `actions` list. JS flattens
-- the attribute map to "key\2value\1key\2value" because the keys are arbitrary
-- server text and wasmoon's table proxy can't be walked reliably.
function __mudix_set_mxp(element, flatAttrs)
    if type(mxp) ~= 'table' then mxp = {} end
    local t = { text = "", actions = {} }
    for entry in tostring(flatAttrs or ""):gmatch("[^\1]+") do
        local k, v = entry:match("^([^\2]*)\2(.*)$")
        if k and k ~= "" then t[k] = v end
    end
    mxp[element] = t
end

-- Mirrors Mudlet's C++ TLuaInterpreter::registerAnonymousEventHandler: stores
-- (event name → list of Lua function names) keyed registrations made by scripts
-- loaded before Other.lua's Lua-side override takes effect (notably
-- GeyserReposition). __mudix_dispatch_event reads from here and from
-- dispatchEventToFunctions, just like Mudlet's C++ raiseEvent dispatches both
-- C-side anonymous handlers and the wildcard ("*") Lua dispatcher.
__mudix_native_handlers = __mudix_native_handlers or {}
function registerAnonymousEventHandler(event, func)
    event, func = __mudix_str(event), __mudix_str(func)
    if event == nil or func == nil then return 0 end
    local list = __mudix_native_handlers[event]
    if not list then list = {}; __mudix_native_handlers[event] = list end
    for _, existing in ipairs(list) do if existing == func then return 0 end end
    list[#list + 1] = func
    return 0
end

-- JS event bridge. emitEvent() sets __mudix_evt_name + __mudix_evt_args
-- (a JS array, so its keys are 0-indexed) and runs this dispatcher.
function __mudix_dispatch_event()
    local event = __mudix_evt_name
    local raw = __mudix_evt_args
    -- JS arrays push as Lua tables keyed 0..n-1; rebuild as a 1-indexed sequence.
    -- Driven by the count JS reports rather than by walking until a nil, so a
    -- payload containing nil or false keeps every argument in its own position
    -- (raiseEvent("x", nil, false, "y") must reach handlers as four values, not
    -- stop dead at the leading nil).
    local args, argc = {}, tonumber(__mudix_evt_argc) or 0
    if type(raw) == 'table' then
        if argc > 0 then
            for i = 1, argc do args[i] = raw[i - 1] end
        else
            -- Fall back to ipairs in case wasmoon ever pushes 1-indexed.
            for _, v in ipairs(raw) do args[#args + 1] = v end
            argc = #args
        end
    end
    -- __mudix_pcall_co, not pcall: handlers may suspend via invokeFileDialog,
    -- which needs a pure-Lua path down to the JS resume boundary.
    -- Lua functions only: event names can collide with JS-bound API globals
    -- (event "disconnect" vs the disconnect() API) and those must not be
    -- treated as handlers.
    local handler = _G[event]
    if type(handler) == 'function' and debug.getinfo(handler, 'S').what ~= 'C' then
        local ok, err = __mudix_pcall_co(handler, unpack(args, 1, argc))
        if not ok and type(showHandlerError) == 'function' then showHandlerError(event, err) end
    end
    -- Native handlers registered before Other.lua overrode registerAnonymousEventHandler.
    -- Mudlet's C++ raiseEvent passes `event` as the first argument followed by event args.
    local nativeList = __mudix_native_handlers[event]
    if nativeList then
        for _, funcName in ipairs(nativeList) do
            local f = _G[funcName]
            if type(f) == 'function' then
                local ok, err = __mudix_pcall_co(f, event, unpack(args, 1, argc))
                if not ok and type(showHandlerError) == 'function' then showHandlerError(event, err) end
            end
        end
    end
    if type(dispatchEventToFunctions) == 'function' then
        dispatchEventToFunctions(event, unpack(args, 1, argc))
    end
end

-- Per-script event-handler registry. wrapScript (in ScriptingEngine.ts) emits
-- code that calls __mudix_kill_script_handlers before re-registering, so
-- saving a script doesn't accumulate duplicate handlers. JS calls the same
-- helper on disable/remove via LuaRuntime.killScriptHandlers.
__mudix_script_handlers = __mudix_script_handlers or {}

-- Resolve a script's event-handler function from its name.
--
-- Mudlet evaluates the script name as a Lua expression to find the function
-- (TLuaInterpreter::callEventHandler runs `return <name>`), so a script named
-- `mmp.centerRoominfo` resolves through the `mmp` table. A flat `_G[name]`
-- lookup misses those and the handler silently never fires — which is exactly
-- how mudlet-mapper's `gmcp.Room` follow handler went dead, leaving the map
-- not tracking movement.
--
-- Walk the dotted path instead of loadstring()ing the name: same result for the
-- names packages actually use, without letting a script name execute code.
-- Returns nil unless the whole path resolves to a function.
function __mudix_resolve_handler(name)
    local target = _G
    for part in string.gmatch(name, '[^.]+') do
        if type(target) ~= 'table' then return nil end
        target = target[part]
    end
    if type(target) == 'function' then return target end
    return nil
end

function __mudix_kill_script_handlers(sid)
    local ids = __mudix_script_handlers[sid]
    if not ids then return end
    for i = 1, #ids do
        if type(killAnonymousEventHandler) == 'function' then
            pcall(killAnonymousEventHandler, ids[i])
        end
    end
    __mudix_script_handlers[sid] = nil
end

-- Mudlet REGEX_LUA_CODE pattern evaluator: run the body as a Lua chunk on
-- every line. Side effects (raiseEvent, etc.) always execute; the trigger
-- "matches" only when the body's return value is truthy.
function __mudix_eval_pattern(code)
    __mudix_pat_result = false
    local fn = loadstring(code)
    if not fn then return end
    local ok, res = pcall(fn)
    if not ok then return end
    __mudix_pat_result = (res and true) or false
end

-- Mudlet accepts either a function or a Lua code string for temp* callbacks;
-- compile strings to functions so handlers run in a fresh chunk.
function __mudix_to_fn(v, who, argN)
    if type(v) == 'function' then return v end
    if type(v) == 'string' then
        local fn, err = loadstring(v)
        if not fn then
            error(who .. ": failed to compile code string: " .. tostring(err))
        end
        return fn
    end
    -- Mudlet's bad-argument format is "<fn>: bad argument #N type (... got X!)";
    -- the "type" token matters — IDManager's extractUpstreamError and scripts that
    -- match on it expect it.
    error(who .. ": bad argument #" .. argN .. " type (function or string expected, got " .. type(v) .. "!)")
end

-- Mudlet's timerDelayFits (TLuaInterpreterMudletObjects.cpp): a timer delay has
-- to survive the trip through the 24 hour clock. A negative delay would silently
-- give a timer firing almost a day later, and a whole-day one no interval at all
-- — firing every event loop turn, were it repeating. It is the *rounded*
-- milliseconds that are bounded, not the delay: 86399.9995s is under the day yet
-- rounds up onto it. Written so a NaN delay is rejected too (every comparison
-- against NaN is false, so `msec >= 0` fails).
local function timerDelayFits(time)
    local msec = math.floor(time * 1000.0 + 0.5)
    return msec >= 0 and msec < 86400000
end

do
    local _raw = __mudix_tempTimer
    function tempTimer(seconds, fn, repeating)
        -- Validate the delay (arg #1) before the callback (arg #2) so the
        -- reported argument number matches Mudlet — IDManager.registerNamedTimer
        -- relies on this ordering to surface the right "#N" in its own error.
        local delaySeconds = __mudix_num(seconds)
        if delaySeconds == nil then
            error("tempTimer: bad argument #1 type (number expected, got " .. type(seconds) .. "!)")
        end
        seconds = delaySeconds
        if not timerDelayFits(seconds) then
            error("tempTimer: bad argument #1 value (time in seconds must be at least 0 and less"
                .. " than 86400, got " .. string.format("%f", seconds) .. ")")
        end
        if repeating ~= nil and type(repeating) ~= 'boolean' then
            error("tempTimer: bad argument #3 type (boolean expected, got "
                .. type(repeating) .. "!)")
        end
        -- A code string that doesn't compile is a *reported* failure here, not a
        -- raised one: Mudlet hands back (-1, message) so a script can react to a
        -- bad body it built at runtime. Every other bad argument still raises.
        local body = fn
        if type(fn) == 'string' then
            local compiled, err = loadstring(fn)
            if not compiled then
                return -1, "tempTimer: failed to compile the code string: " .. tostring(err)
            end
            body = compiled
        end
        return _raw(seconds, __mudix_register_cb(__mudix_to_fn(body, "tempTimer", 2)),
            repeating or false)
    end
end

-- killTimer / enableTimer / disableTimer are plain JS globals that coerce
-- whatever they are handed. Mudlet reads each argument with getVerifiedString
-- and raises when it is missing or the wrong type, so a typo'd call fails loudly
-- instead of silently reporting "no such timer".
do
    local _rawKill = killTimer
    local _rawEnable = enableTimer
    local _rawDisable = disableTimer
    function killTimer(idOrName)
        if type(idOrName) ~= 'number' and type(idOrName) ~= 'string' then
            error("killTimer: bad argument #1 type (timerID as number or timer name as"
                .. " string expected, got " .. type(idOrName) .. "!)", 2)
        end
        return _rawKill(idOrName)
    end
    local function named(raw, who)
        return function(rawName)
            local name = __mudix_str(rawName)
            if name == nil then
                error(who .. ": bad argument #1 type (timer name as string expected, got "
                    .. type(rawName) .. "!)", 2)
            end
            return raw(name)
        end
    end
    enableTimer = named(_rawEnable, "enableTimer")
    disableTimer = named(_rawDisable, "disableTimer")
end

do
    local _raw = __mudix_tempAlias
    function tempAlias(pattern, fn)
        return _raw(pattern, __mudix_register_cb(__mudix_to_fn(fn, "tempAlias", 2)))
    end
end

do
    -- Mudlet:
    --   tempTrigger(substring, fn[, expirationCount])             — literal substring match
    --   tempRegexTrigger(regex, fn[, expirationCount])            — PCRE match
    --   tempExactMatchTrigger(exact, fn[, expirationCount])       — full-line equality
    --   tempBeginOfLineTrigger(prefix, fn[, expirationCount])     — literal prefix (startsWith, not regex ^)
    -- expirationCount: positive N fires N times then auto-kills; -1/0/omitted = unlimited.
    -- The pattern is checked before the callback is registered: a bad one used
    -- to reach the engine as `tostring(table)` and install a trigger nobody
    -- could ever match, instead of telling the caller (IDManager pcalls these
    -- and reports the failure rather than raising).
    local _sub = __mudix_tempTrigger
    function tempTrigger(pattern, fn, expirationCount)
        pattern = __mudix_check_string(pattern, "tempTrigger", 1, "pattern")
        return _sub(pattern, __mudix_register_cb(__mudix_to_fn(fn, "tempTrigger", 2)), expirationCount)
    end
    local _re = __mudix_tempRegexTrigger
    function tempRegexTrigger(pattern, fn, expirationCount)
        pattern = __mudix_check_string(pattern, "tempRegexTrigger", 1, "pattern")
        return _re(pattern, __mudix_register_cb(__mudix_to_fn(fn, "tempRegexTrigger", 2)), expirationCount)
    end
    local _ex = __mudix_tempExactMatchTrigger
    function tempExactMatchTrigger(pattern, fn, expirationCount)
        pattern = __mudix_check_string(pattern, "tempExactMatchTrigger", 1, "pattern")
        return _ex(pattern, __mudix_register_cb(__mudix_to_fn(fn, "tempExactMatchTrigger", 2)), expirationCount)
    end
    local _bol = __mudix_tempBeginOfLineTrigger
    function tempBeginOfLineTrigger(pattern, fn, expirationCount)
        pattern = __mudix_check_string(pattern, "tempBeginOfLineTrigger", 1, "pattern")
        return _bol(pattern, __mudix_register_cb(__mudix_to_fn(fn, "tempBeginOfLineTrigger", 2)), expirationCount)
    end
    -- tempPromptTrigger(fn[, expirationCount]) — fires whenever the server sends
    -- a prompt (no pattern). The callback is arg #1, so __mudix_to_fn looks there.
    local _prompt = __mudix_tempPromptTrigger
    function tempPromptTrigger(fn, expirationCount)
        return _prompt(__mudix_register_cb(__mudix_to_fn(fn, "tempPromptTrigger", 1)), expirationCount)
    end
    -- tempLineTrigger(from, howMany, code|fn) — position-based, no pattern. Fires
    -- on `howMany` lines starting `from` lines ahead (from=1 = next line), then
    -- self-expires. The code/function to run is arg #3.
    local _line = __mudix_tempLineTrigger
    function tempLineTrigger(from, howMany, fn)
        return _line(from, howMany, __mudix_register_cb(__mudix_to_fn(fn, "tempLineTrigger", 3)))
    end
end

do
    local _raw = __mudix_tempKey
    -- Mudlet tempKey([modifier,] keyCode, fn). The 2-arg form omits the
    -- modifier (no Ctrl/Shift/Alt/Meta required); we substitute 0 to keep
    -- the JS binding signature uniform.
    -- Source of the caller (script name + line), so a browser-reserved-key
    -- warning can point at what registered the binding. debug.getinfo(2) is the
    -- function that called tempKey; short_src is the chunk name mudix loads the
    -- script under (see LuaRuntime.exec → loadString('@'..name)).
    local function _callerSource()
        local info = debug.getinfo(3, "Sl")
        if not info then return nil end
        local src = info.short_src or "?"
        if info.currentline and info.currentline > 0 then
            return src .. ":" .. info.currentline
        end
        return src
    end
    function tempKey(a, b, c)
        local src = _callerSource()
        if c == nil then
            return _raw(0, a, __mudix_register_cb(__mudix_to_fn(b, "tempKey", 2)), src)
        end
        return _raw(a, b, __mudix_register_cb(__mudix_to_fn(c, "tempKey", 3)), src)
    end
end

-- Mudlet's perm* bindings raise a Lua error when creation fails — almost always
-- a parent group that doesn't exist — instead of returning the -1 the JS layer
-- reports (TLuaInterpreterMudletObjects.cpp). mudlet-lua's permGroup depends on
-- that: it pcalls each perm* and turns a raise into a `false` return, so without
-- the raise permGroup would claim success for a group it never created. Level 3
-- puts the error on the user's call site, past this helper and the wrapper.
function __mudix_perm_result(id, funcName, what, parent)
    if id == -1 then
        -- Mudlet spells the reason out — "permTimer: cannot create timer
        -- (parent 'X' not found)" — and permGroup surfaces that text to the
        -- caller, so the missing parent has to be named here too.
        local why = (parent ~= nil and parent ~= "")
            and ("parent '" .. tostring(parent) .. "' not found")
            or "parent not found"
        error(funcName .. ": cannot create " .. what .. " (" .. why .. ")", 3)
    end
    return id
end

-- Mudlet permScript(name, parent, luaCode). mudlet-lua's permGroup invokes this
-- with a 4th positional arg ("" type filler); Lua naturally drops it.
do
    local _raw = __mudix_permScript
    function permScript(name, parent, code)
        -- A script's body runs as it is compiled into the tree, so both a body
        -- that won't parse AND one that raises on the way in fail creation
        -- outright — nothing is added in either case.
        code = __mudix_check_lua_code(code, "permScript", 3)
        local compiled = loadstring(code)
        local id = __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), code),
            "permScript", "script", parent)
        local ok, rerr = pcall(compiled)
        if not ok then
            __mudix_removeScriptById(id)
            -- `error({...})` leaves a non-string on the stack, and tostring()ing
            -- it yields "table: 0x…", naming an address instead of the problem.
            -- Mudlet describes the object instead (TLuaInterpreter.cpp), and
            -- treats a number as a message because lua_isstring coerces one.
            local reason = rerr
            if type(reason) ~= 'string' and type(reason) ~= 'number' then
                reason = "error object is a " .. type(reason) .. " value"
            end
            error("permScript: cannot create script (the body raised when it was run: "
                .. tostring(reason) .. ")", 2)
        end
        return id
    end
end

-- Mudlet permRegexTrigger(name, parent, regexes, luaCode). The 3rd arg is a
-- Lua array of regex pattern strings; flatten to \1-delimited so JS can split
-- it back (LuaTable numeric iteration over wasmoon's JS proxy is unreliable).
-- An empty/missing regex table is the documented way to create a trigger
-- folder, and is what `permGroup("name", "trigger")` ends up calling.
do
    local _raw = __mudix_permRegexTrigger
    local SEP = '\1'
    function permRegexTrigger(name, parent, regexes, code)
        local rs = {}
        if type(regexes) == 'table' then
            for _, r in ipairs(regexes) do rs[#rs + 1] = tostring(r) end
        end
        return __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), table.concat(rs, SEP), tostring(code or "")),
            "permRegexTrigger", "trigger", parent)
    end
end

-- Mudlet permSubstringTrigger(name, parent, patterns, luaCode). Same
-- flatten convention as permRegexTrigger; each pattern matches by
-- substring (literal `string.find`-style). An empty patterns table makes
-- a trigger group.
do
    local _raw = __mudix_permSubstringTrigger
    local SEP = '\1'
    function permSubstringTrigger(name, parent, patterns, code)
        local ps = {}
        if type(patterns) == 'table' then
            for _, p in ipairs(patterns) do ps[#ps + 1] = tostring(p) end
        end
        return __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), table.concat(ps, SEP), tostring(code or "")),
            "permSubstringTrigger", "trigger", parent)
    end
end

-- Mudlet permBeginOfLineStringTrigger(name, parent, patterns, luaCode). Same
-- flatten convention as permSubstringTrigger; each pattern matches only when it
-- appears at the start of the line. An empty patterns table makes a trigger
-- group.
do
    local _raw = __mudix_permBeginOfLineStringTrigger
    local SEP = '\1'
    function permBeginOfLineStringTrigger(name, parent, patterns, code)
        local ps = {}
        if type(patterns) == 'table' then
            for _, p in ipairs(patterns) do ps[#ps + 1] = tostring(p) end
        end
        return __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), table.concat(ps, SEP), tostring(code or "")),
            "permBeginOfLineStringTrigger", "trigger", parent)
    end
end

-- Mudlet permExactMatchTrigger(name, parent, patterns, luaCode). Same flatten
-- convention as permSubstringTrigger; each pattern matches only on full-line
-- equality. An empty patterns table makes a trigger group.
do
    local _raw = __mudix_permExactMatchTrigger
    local SEP = '\1'
    function permExactMatchTrigger(name, parent, patterns, code)
        local ps = {}
        if type(patterns) == 'table' then
            for _, p in ipairs(patterns) do ps[#ps + 1] = tostring(p) end
        end
        return __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), table.concat(ps, SEP), tostring(code or "")),
            "permExactMatchTrigger", "trigger", parent)
    end
end

-- Mudlet permPromptTrigger(name, parent, luaCode). Persistent trigger that
-- fires on every server prompt line (GA/EOR); no text pattern.
function permPromptTrigger(name, parent, code)
    return __mudix_perm_result(
        __mudix_permPromptTrigger(tostring(name or ""), tostring(parent or ""), tostring(code or "")),
        "permPromptTrigger", "trigger", parent)
end

-- Mudlet permAlias(name, parent, regex, luaCode). Persistent alias with a
-- single regex pattern. Returns the new id or -1 if the parent group is
-- missing.
do
    local _raw = __mudix_permAlias
    function permAlias(name, parent, regex, code)
        -- The pattern is read with getVerifiedString and the body goes through
        -- reportInvalidLuaCodeParam, so a missing or wrongly-typed pattern — and
        -- a body that will not compile — raises instead of being tostring()-ed
        -- into an alias that could never match (or a body of "999").
        regex = __mudix_check_string(regex, "permAlias", 3, "regex")
        code = __mudix_check_lua_code(code, "permAlias", 4)
        return __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), regex, code),
            "permAlias", "alias", parent)
    end
end

-- Mudlet permTimer(name, parent, seconds, luaCode). Creates a persistent
-- one-shot timer. Returns the new id or -1 if the parent group is missing.
do
    local _raw = __mudix_permTimer
    function permTimer(name, parent, delay, code)
        -- Mudlet reads the interval with getVerifiedDouble and runs the body
        -- through reportInvalidLuaCodeParam before creating anything, so a
        -- missing interval or a body that won't compile raises rather than
        -- leaving a dead timer in the tree.
        local delaySeconds = __mudix_num(delay)
        if delaySeconds == nil then
            error("permTimer: bad argument #3 type (time in seconds as number expected, got "
                .. type(delay) .. "!)", 2)
        end
        delay = delaySeconds
        if not timerDelayFits(delay) then
            error("permTimer: bad argument #3 value (time in seconds must be at least 0 and less"
                .. " than 86400, got " .. string.format("%f", delay) .. ")", 2)
        end
        code = __mudix_check_lua_code(code, "permTimer", 4)
        return __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), delay, code),
            "permTimer", "timer", parent)
    end
end

-- Mudlet permKey(name, parent [, modifier], key, luaCode). Creates a saved
-- keybinding. `modifier` is the Qt::KeyboardModifier int and is OPTIONAL — with
-- four arguments the third is the key code and no modifier applies (Mudlet
-- decides by argument count, `lua_gettop(L) > 4`). permGroup("name", "key")
-- reaches the five-argument form with -1 to make a key folder. `key` is either a
-- Qt::Key int or a string keycode (KeyboardEvent.code). Returns the new id, and
-- raises when the parent key group is missing.
do
    local _raw = __mudix_permKey
    function permKey(name, parent, a3, a4, a5)
        local modifier, key, code
        if a5 == nil then
            modifier, key, code = -1, a3, a4
        else
            modifier, key, code = tonumber(a3) or -1, a4, a5
        end
        -- Mudlet validates the body at ++argIndex — 4 in the four-argument form,
        -- 5 once a modifier has consumed argument 3 — and compiles it there, so
        -- a non-chunk body is refused before the key is created.
        code = __mudix_check_lua_code(code, "permKey", a5 == nil and 4 or 5)
        return __mudix_perm_result(
            _raw(tostring(name or ""), tostring(parent or ""), modifier, key, code),
            "permKey", "key", parent)
    end
end

-- Mudlet tempButton(toolbar, name, luaCode [, orientation]). Returns the new
-- id or -1 if no toolbar of that name exists.
do
    local _raw = __mudix_tempButton
    function tempButton(toolbar, name, code, orientation)
        return _raw(tostring(toolbar or ""), tostring(name or ""), tostring(code or ""), tonumber(orientation) or 0)
    end
end

-- Mudlet tempButtonToolbar(name [, orientation [, location]]). Creates a
-- transient toolbar group. Returns the new id, or -1 if the name is taken.
do
    local _raw = __mudix_tempButtonToolbar
    function tempButtonToolbar(name, orientation, location)
        return _raw(tostring(name or ""), tonumber(orientation) or 0, tonumber(location) or 0)
    end
end

-- Mudlet tempColorTrigger(fg, bg, code [, expirationCount]). fg/bg are ANSI
-- palette indices (0..255), or -1 to match any colour. The callback is
-- invoked when any segment of the current rendered line carries the
-- matching foreground/background.
do
    local _raw = __mudix_tempColorTrigger
    function tempColorTrigger(fg, bg, fn, expirationCount)
        return _raw(tonumber(fg) or -1, tonumber(bg) or -1,
            __mudix_register_cb(__mudix_to_fn(fn, "tempColorTrigger", 3)),
            expirationCount)
    end
    -- Mudlet tempAnsiColorTrigger(ansiFg, ansiBg, code [, expirationCount]).
    -- ANSI 256-colour indices (0..255), plus the two sentinels TTrigger declares:
    -- -1 (scmIgnored) leaves that channel out of the match, and -2 (scmDefault)
    -- asks for the console's own default colour, which is a colour to match and
    -- not an "any". mudix already matches tempColorTrigger against ANSI palette
    -- indices, and the snapshot a colour trigger reads marks a segment left on
    -- the default with the same -2, so both go straight through; anything else
    -- negative is not a sentinel Mudlet defines and reads as ignore.
    function tempAnsiColorTrigger(fg, bg, fn, expirationCount)
        local nf = tonumber(fg)
        local nb = tonumber(bg)
        if not nf or (nf < 0 and nf ~= -2) then nf = -1 end
        if not nb or (nb < 0 and nb ~= -2) then nb = -1 end
        return _raw(nf, nb,
            __mudix_register_cb(__mudix_to_fn(fn, "tempAnsiColorTrigger", 3)),
            expirationCount)
    end
end

-- Mudlet tempComplexRegexTrigger(name, regex, code, multiline, fgColor,
-- bgColor, filter, matchAll, hlFgColor, hlBgColor, soundFile, fireLength,
-- lineDelta, expireAfter). Mudlet's trigger editor emits this whenever a
-- trigger is built with highlight / sound / fire-length / match-all options,
-- so imported scripts and packages rely on it.
--
-- mudix backs it with the temp regex-trigger primitive plus the existing
-- highlight (selectString + setFgColor/setBgColor) and sound (playSoundFile)
-- globals. The features that map cleanly onto a single-pattern temp trigger
-- are honoured:
--   • regex pattern + Lua code/function callback
--   • highlight foreground/background colour on the matched text — all
--     occurrences when matchAll is set, else just the first
--   • sound file played on each fire
--   • expireAfter (fires N times, then self-removes)
--   • named triggers — re-calling with an existing name replaces it, and
--     killTrigger(name) removes it
-- Features that need the full chain/AND machinery of a *permanent* trigger
-- (multiline-AND across lines, filter chaining, fireLength stay-open,
-- lineDelta, and colour-pattern matching via the fgColor/bgColor args) are
-- not applied to a temp trigger; permRegexTrigger plus the trigger editor
-- cover those. A one-time warning is emitted when such a flag is actually
-- requested, so the gap is visible rather than silent.
do
    local warned = {}     -- de-dupe per-feature unsupported warnings

    local function warnOnce(feature)
        if warned[feature] then return end
        warned[feature] = true
        printDebug("tempComplexRegexTrigger: '" .. feature .. "' is not supported "
            .. "on a temp trigger in mudix — use permRegexTrigger / the trigger "
            .. "editor for chain, filter, multiline-AND or colour-pattern triggers.")
    end

    -- Resolve a Mudlet highlight colour spec to r, g, b. Accepts a color_table
    -- name ("red"), "#rrggbb"/"rrggbb", or "r,g,b". Returns nil when nothing
    -- recognisable was passed.
    local function resolveColor(spec)
        if type(spec) ~= 'string' or spec == '' then return nil end
        if color_table and color_table[spec] then
            local c = color_table[spec]
            return c[1], c[2], c[3]
        end
        local hex = spec:match('^#?(%x%x%x%x%x%x)$')
        if hex then
            return tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16)
        end
        local r, g, b = spec:match('^(%d+)%s*,%s*(%d+)%s*,%s*(%d+)$')
        if r then return tonumber(r), tonumber(g), tonumber(b) end
        return nil
    end

    -- Colorize the matched text on the current line. `matches[1]` is the full
    -- match (set by the temp-trigger dispatch before the callback runs).
    local function highlight(hlFg, hlBg, matchAll)
        local text = matches and matches[1]
        if not text or text == '' then return end
        local fr, fg_, fb = resolveColor(hlFg)
        local br, bg_, bb = resolveColor(hlBg)
        if not (fr or br) then return end
        local n = 1
        while true do
            local idx = selectString(text, n)
            if not idx or idx < 0 then break end
            if fr then setFgColor(fr, fg_, fb) end
            if br then setBgColor(br, bg_, bb) end
            if not matchAll then break end
            n = n + 1
        end
        deselect()
    end

    function tempComplexRegexTrigger(name, regex, code, multiline, fgColor, bgColor,
                                     filter, matchAll, hlFgColor, hlBgColor, soundFile,
                                     fireLength, lineDelta, expireAfter)
        local userFn = __mudix_to_fn(code, "tempComplexRegexTrigger", 3)
        local matchAllOn = tonumber(matchAll) == 1

        -- A colour pattern is the one thing here that has no home on the node:
        -- Mudlet's fgColor/bgColor name colours, and the node's colour patterns
        -- are ANSI indices. Still the honest thing to say out loud.
        if type(fgColor) == 'string' or type(bgColor) == 'string' then warnOnce('colour pattern (fgColor/bgColor)') end

        local hasHighlight = type(hlFgColor) == 'string' or type(hlBgColor) == 'string'
        local hasSound = type(soundFile) == 'string' and soundFile ~= ''
        local fires, max, id = 0, tonumber(expireAfter)
        local wrapper = function()
            if hasHighlight then highlight(hlFgColor, hlBgColor, matchAllOn) end
            if hasSound then playSoundFile(soundFile) end
            fires = fires + 1
            -- Spent BEFORE the body runs, so a trigger that re-arms itself from
            -- its own script does not have the fresh one killed by the count the
            -- old one ran out of.
            if max and max > 0 and fires >= max and id then killTrigger(id) end
            return userFn()
        end

        local patterns = ''
        if type(regex) == 'string' and regex ~= '' then
            patterns = 'regex\2' .. regex
        end
        -- The body is a node's Lua source, so the callback is reached through
        -- the registry the same way a temp trigger's is. `matches` and
        -- `multimatches` are globals by then, which is where a Mudlet trigger
        -- script reads its captures from anyway.
        local cbId = __mudix_register_cb(wrapper)
        id = __mudix_tempComplexTrigger(
            type(name) == 'string' and name or '',
            patterns,
            'return __mudix_dispatch_cb(' .. cbId .. ')',
            tonumber(multiline) == 1,
            tonumber(filter) == 1,
            matchAllOn,
            tonumber(fireLength) or 0,
            tonumber(lineDelta) or 0,
            hlFgColor, hlBgColor)
        return id
    end
end

-- Mudlet's label-event setters all share a shape: name + (function | code |
-- nil) + optional trailing args that get baked into the closure. The JS side
-- (LuaRuntime.setLabelCb) tracks the prior cb id per slot and frees it on
-- rebind so handlers don't leak in __mudix_cb. cb id 0 means "clear".
do
    local function bind(name, who, fn, raw, ...)
        if fn == nil then return raw(name, 0) end
        local f = __mudix_to_fn(fn, who, 2)
        if select('#', ...) > 0 then
            local trailing = {...}
            local inner = f
            f = function(event) return inner(event, unpack(trailing)) end
        end
        return raw(name, __mudix_register_cb(f))
    end

    local _click = __mudix_setLabelClickCallback
    function setLabelClickCallback(name, fn, ...)
        return bind(name, "setLabelClickCallback", fn, _click, ...)
    end

    local _dblclick = __mudix_setLabelDoubleClickCallback
    function setLabelDoubleClickCallback(name, fn, ...)
        return bind(name, "setLabelDoubleClickCallback", fn, _dblclick, ...)
    end

    local _release = __mudix_setLabelReleaseCallback
    function setLabelReleaseCallback(name, fn, ...)
        return bind(name, "setLabelReleaseCallback", fn, _release, ...)
    end

    local _move = __mudix_setLabelMoveCallback
    function setLabelMoveCallback(name, fn, ...)
        return bind(name, "setLabelMoveCallback", fn, _move, ...)
    end

    local _enter = __mudix_setLabelOnEnter
    function setLabelOnEnter(name, fn, ...)
        return bind(name, "setLabelOnEnter", fn, _enter, ...)
    end

    local _leave = __mudix_setLabelOnLeave
    function setLabelOnLeave(name, fn, ...)
        return bind(name, "setLabelOnLeave", fn, _leave, ...)
    end

    local _wheel = __mudix_setLabelWheelCallback
    function setLabelWheelCallback(name, fn, ...)
        return bind(name, "setLabelWheelCallback", fn, _wheel, ...)
    end
end

-- The same (nil, message) contract the other label functions get, applied here
-- rather than beside them because these are defined further down the file — the
-- guard has to wrap a function that already exists. `bind` raises on a badly
-- typed callback before this is reached, so the type errors keep their wording.
do
    for _, setter in ipairs({
        "setLabelClickCallback", "setLabelDoubleClickCallback", "setLabelReleaseCallback",
        "setLabelMoveCallback", "setLabelWheelCallback", "setLabelOnEnter", "setLabelOnLeave",
    }) do
        local raw = _G[setter]
        _G[setter] = function(name, ...)
            local err = __mudix_label_missing(name, "label name '%s' not found")
            if err then return nil, err end
            raw(name, ...)
            return true
        end
    end
end

-- Mudlet setCmdLineAction([cmdLineName,] fn, [args...]). With a cmdLineName
-- the binding targets a userwindow's per-window command line (enabled via
-- enableCommandLine); without one (or "main") it targets the main command
-- bar. The action receives the typed text plus any trailing varargs.
--
-- Mudlet strictly requires a function value, but a long-standing community
-- pattern (visible in older Arkadia / Polish-MUD scripts) is to pass the
-- string name of a global function: `setCmdLineAction("win", "myHandler")`.
-- We treat such a string — a bare Lua identifier whose global resolves to a
-- function — as that function, so those scripts run without modification.
-- A non-identifier string falls through to __mudix_to_fn's loadstring path.
do
    local _set = __mudix_setCmdLineAction
    local _reset = __mudix_resetCmdLineAction
    local function resolveFnArg(v, who, argN)
        if type(v) == 'string' and v:match('^[%w_][%w_%.]*$') then
            local g = _G[v]
            if type(g) == 'function' then return g end
        end
        return __mudix_to_fn(v, who, argN)
    end
    function setCmdLineAction(...)
        local n = select('#', ...)
        if n == 0 then
            error("setCmdLineAction: missing function argument", 2)
        end
        local first = select(1, ...)
        local windowName, fn, extras
        -- Disambiguate (name, fn, ...) from (fn, ...) by argument count and
        -- second-arg shape: when arg 1 is a string AND arg 2 is also present
        -- and is a function / string, treat arg 1 as the cmdLineName.
        if type(first) == 'string' and n >= 2 then
            windowName = first
            fn = select(2, ...)
            extras = { select(3, ...) }
        else
            fn = first
            extras = { select(2, ...) }
        end
        if fn == nil then
            return _set(0, windowName)
        end
        local f = resolveFnArg(fn, "setCmdLineAction", windowName and 2 or 1)
        if #extras > 0 then
            local trailing = extras
            local inner = f
            f = function(text) return inner(text, unpack(trailing)) end
        end
        return _set(__mudix_register_cb(f), windowName)
    end
    function resetCmdLineAction(cmdLineName)
        return _reset(cmdLineName)
    end
end

-- ── Command-line mandatory-argument contracts ──────────────────────────────
-- These five take an optional leading command-line name and a mandatory string
-- after it, which Mudlet used to locate at lua_gettop(L). With no arguments at
-- all that index is 0, which Lua 5.1 resolves to the first free stack slot
-- rather than rejecting — so the type check ran against whatever the previous
-- call had left there, and a leftover string made the call quietly succeed on
-- it (upstream #9683). mudix reached the same place from the other direction:
-- `String(undefined)` put the literal text "undefined" on the command line.
do
    local function requireTail(fn, who, what)
        return function(...)
            local n = select('#', ...)
            if n < 1 then
                error(who .. ": bad argument #1 type (" .. what
                    .. " as string expected, got no value!)", 2)
            end
            local tail = select(n, ...)
            if type(tail) ~= 'string' and type(tail) ~= 'number' then
                error(who .. ": bad argument #" .. n .. " type (" .. what
                    .. " as string expected, got " .. type(tail) .. "!)", 2)
            end
            return fn(...)
        end
    end
    addCmdLineSuggestion    = requireTail(addCmdLineSuggestion,    "addCmdLineSuggestion",    "suggestion text")
    removeCmdLineSuggestion = requireTail(removeCmdLineSuggestion, "removeCmdLineSuggestion", "suggestion text")
    appendCmdLine           = requireTail(appendCmdLine,           "appendCmdLine",           "text")
    printCmdLine            = requireTail(printCmdLine,            "printCmdLine",            "text")
    setCmdLineStyleSheet    = requireTail(setCmdLineStyleSheet,    "setCmdLineStyleSheet",    "style sheet")
end

-- ── Command-line name contracts ────────────────────────────────────────────
-- Only a command line made with createCommandLine can carry an action, so the
-- main bar is refused in the same words as a name that doesn't exist: from a
-- script's point of view there is no command line by that name to act on. Each
-- of these used to answer a bare false, which a caller cannot tell from "the
-- action was already unset".
do
    local function namedCmdLine(who, name)
        if __mudix_str(name) == nil then
            error(who .. ": bad argument #1 type (command line name as string expected, got "
                .. type(name) .. "!)", 3)
        end
        if name == '' then return "command line name cannot be an empty string" end
        -- Same reach as missingCmdLine above: a console's own command line is
        -- named for the console, not registered as a command line of its own.
        local t = __windowType(name)
        if t ~= 'commandline' and t ~= 'miniconsole' and t ~= 'userwindow' then
            return "command line name '" .. name .. "' not found"
        end
        return nil
    end

    local _rawSetCmdLineAction = setCmdLineAction
    function setCmdLineAction(...)
        local n = select('#', ...)
        local first = select(1, ...)
        -- Only the two-argument form names a command line; the one-argument
        -- form is an action for the main bar and has no name to check.
        if n >= 2 or type(first) == 'string' then
            local err = namedCmdLine("setCmdLineAction", first)
            if err then return nil, err end
        end
        return _rawSetCmdLineAction(...)
    end

    local _rawResetCmdLineAction = resetCmdLineAction
    function resetCmdLineAction(cmdLineName)
        local err = namedCmdLine("resetCmdLineAction", cmdLineName)
        if err then return nil, err end
        return _rawResetCmdLineAction(cmdLineName)
    end

    -- clearCmdLineSuggestions reports nothing at all on success (there is no
    -- getter for a command line's suggestions), so a missing name is the only
    -- thing it ever has to say.
    local _rawClearCmdLineSuggestions = clearCmdLineSuggestions
    function clearCmdLineSuggestions(cmdLineName)
        if cmdLineName ~= nil and cmdLineName ~= 'main' then
            -- Double quotes here, single in setCmdLineAction: the two are
            -- worded differently upstream and the specs assert both verbatim.
            local err = namedCmdLine("clearCmdLineSuggestions", cmdLineName)
            if err then
                return nil, (err:gsub("^command line name '(.*)' not found$",
                    'command line "%1" not found'))
            end
        elseif cmdLineName ~= nil and __mudix_str(cmdLineName) == nil then
            error("clearCmdLineSuggestions: bad argument #1 type (command line name as string"
                .. " expected, got " .. type(cmdLineName) .. "!)", 2)
        end
        _rawClearCmdLineSuggestions(cmdLineName)
    end

    -- Mudlet selectCmdLineText([cmdLineName]) — select everything typed so the
    -- next keystroke overtypes it.
    local _rawSelectCmdLineText = selectCmdLineText
    function selectCmdLineText(cmdLineName)
        if cmdLineName ~= nil and cmdLineName ~= 'main' then
            local err = namedCmdLine("selectCmdLineText", cmdLineName)
            if err then return nil, err end
        end
        _rawSelectCmdLineText(cmdLineName)
        return true
    end
end

-- echoLink / insertLink / setLink: convert Lua function cmd → stored ref + string command.
do
    local _fns = {}
    local _id  = 0
    function __mudix_call_link(id) _fns[id]() end

    -- For echoLink / insertLink: cmd is at slot 3 when arg 4 is a string (window form),
    -- otherwise at slot 2 (no-window form, with optional useCurrentFormat at slot 4).
    local function wrapLink(rawFn)
        return function(...)
            local args = {...}
            local n = #args
            local ci = (n >= 4 and type(args[4]) == 'string') and 3 or 2
            if type(args[ci]) == 'function' then
                _id = _id + 1
                local id = _id
                _fns[id] = args[ci]
                args[ci] = '__mudix_call_link(' .. id .. ')'
            end
            return rawFn(unpack(args))
        end
    end
    echoLink = wrapLink(echoLink)
    insertLink = wrapLink(insertLink)

    -- setLink: cmd is arg 2 with a window prefix (3 args), arg 1 without (2 args).
    local _rawSetLink = setLink
    setLink = function(...)
        local args = {...}
        local n = #args
        local ci = (n >= 3) and 2 or 1
        if type(args[ci]) == 'function' then
            _id = _id + 1
            local id = _id
            _fns[id] = args[ci]
            args[ci] = '__mudix_call_link(' .. id .. ')'
        end
        return _rawSetLink(unpack(args))
    end
end

-- Mudlet requires the command and hint tables to line up: equal sizes, or one
-- extra hint (the trailing hint is used as the menu title). A mismatch is a
-- (nil, errMsg) return rather than a raise, and no popup is created.
function __mudix_popup_size_error(cmds, hints, funcName)
    local nc, nh = #cmds, #hints
    if nh == nc or nh == nc + 1 then return nil end
    return funcName .. ": command table and hint table sizes do not match up ("
        .. nc .. " and " .. nh .. ", either they must be the same or there should"
        .. " be one extra hint) - cannot create popup"
end

-- echoPopup: xEcho passes cmds/hints as Lua tables.  wasmoon's JS proxy
-- for LuaTable doesn't support reliable numeric-key iteration from JS, so
-- flatten the tables to \x01-delimited strings here in Lua (where ipairs
-- is trivial) and let the JS binding split them.
--
-- Mudlet supports both with-window and no-window forms, disambiguated by
-- argc and arg types:
--   echoPopup(text, cmds, hints)               -- 3 args, no window
--   echoPopup(text, cmds, hints, useFmt)       -- 4 args, no window (cmds is table at slot 2)
--   echoPopup(window, text, cmds, hints)       -- 4 args, with window (text is string at slot 2)
--   echoPopup(window, text, cmds, hints, fmt)  -- 5 args, full form
do
    local _raw = echoPopup
    local SEP = '\1'
    echoPopup = function(...)
        local n = select('#', ...)
        local a1, a2, a3, a4, a5 = ...
        local win, text, cmds, hints, fmt
        if n <= 2 then
            return
        elseif n == 3 then
            win, text, cmds, hints, fmt = "main", a1, a2, a3, nil
        elseif n == 4 then
            if type(a2) == 'table' then
                -- (text, cmds, hints, useFmt)
                win, text, cmds, hints, fmt = "main", a1, a2, a3, a4
            else
                -- (window, text, cmds, hints)
                win, text, cmds, hints, fmt = a1, a2, a3, a4, nil
            end
        else
            win, text, cmds, hints, fmt = a1, a2, a3, a4, a5
        end
        if not text or text == '' then return end
        local cs, hs = {}, {}
        if type(cmds) == 'table' then
            for _, c in ipairs(cmds) do cs[#cs+1] = tostring(c) end
        end
        if type(hints) == 'table' then
            for _, h in ipairs(hints) do hs[#hs+1] = tostring(h) end
        end
        local sizeErr = __mudix_popup_size_error(cs, hs, "echoPopup")
        if sizeErr then return nil, sizeErr end
        return _raw(win, text, table.concat(cs, SEP), table.concat(hs, SEP), fmt)
    end
end

-- insertPopup: identical overload handling + table flatten to echoPopup, but
-- inserts the popup span at the cursor instead of appending. cinsertPopup /
-- dinsertPopup / hinsertPopup (GUIUtils.lua) route here via xEcho with the
-- commands/hints as Lua tables.
--   insertPopup(text, {cmds}, {hints})               -- 3 args, no window
--   insertPopup(text, {cmds}, {hints}, useFmt)        -- 4 args, no window
--   insertPopup(window, text, {cmds}, {hints})        -- 4 args, with window
--   insertPopup(window, text, {cmds}, {hints}, fmt)   -- 5 args, full form
do
    local _raw = insertPopup
    local SEP = '\1'
    insertPopup = function(...)
        local n = select('#', ...)
        local a1, a2, a3, a4, a5 = ...
        local win, text, cmds, hints, fmt
        if n <= 2 then
            return
        elseif n == 3 then
            win, text, cmds, hints, fmt = "main", a1, a2, a3, nil
        elseif n == 4 then
            if type(a2) == 'table' then
                win, text, cmds, hints, fmt = "main", a1, a2, a3, a4
            else
                win, text, cmds, hints, fmt = a1, a2, a3, a4, nil
            end
        else
            win, text, cmds, hints, fmt = a1, a2, a3, a4, a5
        end
        if not text or text == '' then return end
        local cs, hs = {}, {}
        if type(cmds) == 'table' then
            for _, c in ipairs(cmds) do cs[#cs+1] = tostring(c) end
        end
        if type(hints) == 'table' then
            for _, h in ipairs(hints) do hs[#hs+1] = tostring(h) end
        end
        local sizeErr = __mudix_popup_size_error(cs, hs, "insertPopup")
        if sizeErr then return nil, sizeErr end
        return _raw(win, text, table.concat(cs, SEP), table.concat(hs, SEP), fmt)
    end
end

-- setPopup([window,] {commands}, {hints}): attach a right-click popup to the
-- current selection. Flatten the command/hint tables to \x01 strings.
--   setPopup({cmds}, {hints})           -- no window
--   setPopup(window, {cmds}, {hints})   -- with window (string first arg)
do
    local _raw = setPopup
    local SEP = '\1'
    setPopup = function(a, b, c)
        local win, cmds, hints
        if type(a) == 'string' then
            win, cmds, hints = a, b, c
        else
            win, cmds, hints = "main", a, b
        end
        -- Both tables are required and their sizes have to line up, give or
        -- take one extra hint for the popup's own title. Getting either wrong
        -- used to build a popup with silently dropped entries.
        if type(cmds) ~= 'table' then
            error("setPopup: bad argument #" .. (type(a) == 'string' and 2 or 1)
                .. " type (command table as table expected, got " .. type(cmds) .. "!)", 2)
        end
        if type(hints) ~= 'table' then
            error("setPopup: bad argument #" .. (type(a) == 'string' and 3 or 2)
                .. " type (hint table as table expected, got " .. type(hints) .. "!)", 2)
        end
        if win ~= 'main' and __windowType(win) == nil then
            return nil, 'window "' .. tostring(win) .. '" not found'
        end
        if #hints ~= #cmds and #hints ~= #cmds + 1 then
            return nil, "setPopup: command table and hint table sizes do not match up"
        end
        local cs, hs = {}, {}
        for _, x in ipairs(cmds) do cs[#cs+1] = tostring(x) end
        for _, x in ipairs(hints) do hs[#hs+1] = tostring(x) end
        if _raw(win, table.concat(cs, SEP), table.concat(hs, SEP)) == false then return false end
        return true
    end
end

-- sendMSDP(variable [, value, ...]): pack the variadic values into a \x01
-- string so the JS binding gets a stable shape regardless of wasmoon's
-- vararg handling. An empty value list concats to "" → no MSDP_VAL groups.
do
    local _raw = __mudix_sendMSDP
    function sendMSDP(variable, ...)
        variable = __mudix_check_string(variable, "sendMSDP", 1, "variable")
        local vals = {...}
        local parts = {}
        for i = 1, select('#', ...) do
            -- Mudlet validates every variadic value up front rather than
            -- tostring()-ing whatever arrives.
            vals[i] = __mudix_check_string(vals[i], "sendMSDP", i + 1, "value")
            parts[i] = vals[i]
        end
        if not __mudix_is_connected() then
            return nil, "sendMSDP: not connected to game server - connect first before sending MSDP"
        end
        return _raw(variable, table.concat(parts, '\1'))
    end
end

-- Mudlet sendATCP(message [, what]) / sendTelnetChannel102(msg) / sendSocket(data).
-- Each validates its arguments (raising, as Mudlet's C++ bindings do) and then
-- reports a refusal as (nil, errMsg) rather than a bare false. Messages are
-- Mudlet's verbatim — Networking_spec asserts several of them in full.
function sendATCP(message, what)
    message = __mudix_check_string(message, "sendATCP", 1, "message")
    if what ~= nil then
        local payload = __mudix_str(what)
        if payload == nil then
            error("sendATCP: bad argument #2 type (what as string is optional, got " .. type(what) .. "!)", 2)
        end
        what = payload
    end
    if not __mudix_is_connected() then
        return nil, "sendATCP: not connected to game server - connect first before sending ATCP"
    end
    if not __mudix_sendATCP(message, what) then
        return nil, "sendATCP: ATCP is not currently enabled"
    end
    return true
end

function sendTelnetChannel102(msg)
    msg = __mudix_check_string(msg, "sendTelnetChannel102", 1, "message")
    if #msg ~= 2 then
        return nil, "sendTelnetChannel102: invalid message of length " .. #msg
            .. " supplied, it should be two bytes (may use lua \\### for each byte"
            .. " where ### is a number between 1 and 254)"
    end
    if not __mudix_sendTelnetChannel102(msg) then
        return nil, "sendTelnetChannel102: unable to send message as the 102 subchannel"
            .. " support has not been enabled by the game server"
    end
    return true
end

function sendSocket(data)
    data = __mudix_check_string(data, "sendSocket", 1, "data")
    if not __mudix_sendSocket(data) then
        return nil, "sendSocket: unable to send any/all of the data, is the Server connected?"
    end
    return true
end

-- Shared validator for the media table-argument forms (playSoundFile,
-- playMusicFile, playVideoFile, stopSounds, getPlayingSounds, ...). Mudlet
-- validates each recognised field's type and raises
--   "<fn>: bad argument #1 type (value for <field> as <type> expected, got <T>!)"
-- (TLuaInterpreter::errorArgumentType). The "value for " prefix is part of the
-- field's public name, so it must not be doubled with the type constraint —
-- Networking_spec pins several of these messages in full (upstream #9547).
__mudix_media_field_types = {
    name = 'string', url = 'string', key = 'string', tag = 'string', caption = 'string',
    volume = 'number', fadein = 'number', fadeout = 'number', start = 'number',
    loops = 'number', priority = 'number',
    ['continue'] = 'boolean', stream = 'boolean', close = 'boolean', fadeaway = 'boolean',
}
-- Fields that are durations/counts and cannot be negative.
__mudix_media_nonnegative = { fadein = true, fadeout = true, start = true }

function __mudix_check_media_table(t, funcName)
    for field, expected in pairs(__mudix_media_field_types) do
        local v = t[field]
        if v ~= nil and type(v) ~= expected then
            error(funcName .. ": bad argument #1 type (value for " .. field .. " as " .. expected
                .. " expected, got " .. type(v) .. "!)", 3)
        end
        if v ~= nil and __mudix_media_nonnegative[field] and v < 0 then
            error(funcName .. ": bad argument #1 value (value for " .. field
                .. " must not be negative, got " .. tostring(v) .. "!)", 3)
        end
    end
end

-- The table form must name something to act on; Mudlet raises rather than
-- silently playing nothing.
function __mudix_check_media_name(t, funcName)
    local n = __mudix_str(t.name or t.url)
    if n == nil or n == '' then
        error(funcName .. ": bad argument #1 type (value for name as string expected, got "
            .. type(t.name) .. "!)", 3)
    end
    -- Write the rendered value back so everything downstream sees a string.
    if t.name ~= nil then t.name = __mudix_str(t.name) end
    if t.url ~= nil then t.url = __mudix_str(t.url) end
end

-- loadSoundFile / loadMusicFile / loadVideoFile are one preload request behind
-- three names: they share these parsers, each call stamping its own name on
-- whatever it complains about, so a script is told which load it got wrong.
-- The table form's `name`/`url` are the only fields a load reads.
function __mudix_check_media_load_table(t, funcName)
    for _, field in ipairs({ 'name', 'url' }) do
        local v = t[field]
        if v ~= nil then
            local str = __mudix_str(v)
            if str == nil then
                error(funcName .. ": bad argument #1 type (value for " .. field
                    .. " as string expected, got " .. type(v) .. "!)", 3)
            end
            t[field] = str
        end
    end
    local n = t.name or t.url
    if type(n) ~= 'string' or n == '' then
        error(funcName .. ": missing name", 3)
    end
end

-- ── Media urls ─────────────────────────────────────────────────────────────
-- A media request may carry a `url` alongside its name: fetch it into the
-- profile's media directory, then act on it from there. That is how a server
-- ships a sound the player doesn't already have, and it is why a load or a play
-- with a url answers true straight away — the work finishes when the download
-- does. A url that isn't http(s) is refused by the download itself, as a
-- sysDownloadError naming the file.
do
    local pending = {}
    local handler
    -- Registered on first use, not at load: registerAnonymousEventHandler comes
    -- from the bundled Lua, which loads after this file.
    local function ensureHandler()
        if handler then return end
        handler = registerAnonymousEventHandler("sysDownloadDone", function(_, path)
            local job = pending[path]
            if not job then return end
            pending[path] = nil
            job.act(job.opts)
        end, true)
    end

    -- Returns true when the caller should stop here and let the download
    -- finish the job.
    function __mudix_media_deferred(opts, act)
        if type(opts) ~= 'table' or type(opts.url) ~= 'string' or opts.url == '' then
            return false
        end
        local saveTo = __mudix_media_fetch(opts.name or opts.url, opts.url)
        if saveTo == nil then return false end
        ensureHandler()
        -- The replay drops the url: the file is local by then, and keeping it
        -- would send the request round the same fetch again.
        local replay = {}
        for k, v in pairs(opts) do replay[k] = v end
        replay.url = nil
        pending[saveTo] = { act = act, opts = replay }
        return true
    end
end

-- The ordered play form, in Mudlet's argument order:
--   name [, volume [, fadein [, fadeout [, start [, loops [, key [, tag
--        [, continue [, url [, finish ]]]]]]]]]]
-- Every position is checked by the name it carries — a complaint that names
-- "volume" is far more use than one naming argument #2 — and the four time
-- fields are refused when negative. Each caller passes its own name through, so
-- the message names the call that was made and not the parser (upstream #9785,
-- where every music range error said playSoundFile).
function __mudix_ordered_play_args(funcName, name, volume, fadein, fadeout, start, loops,
                                   key, tag, continueFlag, url, finish)
    local function want(v, field, expected)
        if v ~= nil and type(v) ~= expected then
            error(funcName .. ": bad argument type (" .. field .. " as " .. expected
                .. " expected, got " .. type(v) .. "!)", 3)
        end
    end
    local function range(v, field)
        if v ~= nil and v < 0 then
            error(funcName .. ": bad argument range for " .. field
                .. ", got " .. tostring(v) .. "!", 3)
        end
    end
    want(volume, "volume", 'number')
    want(fadein, "fadein", 'number')
    want(fadeout, "fadeout", 'number')
    want(start, "start", 'number')
    want(loops, "loops", 'number')
    want(key, "key", 'string')
    want(tag, "tag", 'string')
    want(continueFlag, "continue", 'boolean')
    want(url, "url", 'string')
    want(finish, "finish", 'number')
    range(fadein, "fadein")
    range(fadeout, "fadeout")
    range(start, "start")
    range(finish, "finish")
    return {
        name = name, volume = volume, fadein = fadein, fadeout = fadeout,
        start = start, loops = loops, key = key, tag = tag,
        ["continue"] = continueFlag, url = url, finish = finish,
    }
end

-- Arity matters, as it does for the play family: no arguments at all is a
-- raise, while an explicit nil (or empty) file name is the softer
-- (nil, "missing argument 1") return.
function __mudix_media_load_args(funcName, ...)
    if select('#', ...) == 0 then
        error(funcName .. ": need at least one argument", 3)
    end
    local a, b = ...
    if type(a) == 'table' then
        __mudix_check_media_load_table(a, funcName)
        return tostring(a.name or a.url or ''), nil
    end
    if b ~= nil and __mudix_str(b) == nil then
        error(funcName .. ": bad argument #2 type (url as string expected, got "
            .. type(b) .. "!)", 3)
    end
    local name = __mudix_str(a)
    if name == nil or name == '' then
        return nil, funcName .. ": missing argument 1 (file to load)"
    end
    return name, nil
end

-- Mudlet `playSoundFile`. Accepts either:
--   playSoundFile(filename [, volume])     -- positional
--   playSoundFile({name=..., volume=..., fadein=..., fadeout=..., start=...,
--                  loops=..., key=..., tag=...})
-- Volume is 0..100. Filename resolves against the profile VFS (e.g.
-- "media/hit.wav") or may be an absolute http(s):// URL.
-- Arity matters: no arguments at all is a raise, while an explicit nil filename
-- is the softer (nil, "missing argument 1") return. select('#') tells them apart.
function playSoundFile(...)
    -- Count the caller's real arity: naming the parameters and passing them to
    -- select('#') would count those names, never yielding 0.
    if select('#', ...) == 0 then
        error("playSoundFile: need at least one argument", 2)
    end
    local a = ...
    if type(a) == 'table' then
        __mudix_check_media_table(a, "playSoundFile")
        __mudix_check_media_name(a, "playSoundFile")
        if __mudix_media_deferred(a, __playSoundFile) then return true end
        return __playSoundFile(a)
    end
    local name = __mudix_str(a)
    if name == nil or name == '' then
        return nil, "playSoundFile: missing argument 1 (file to play)"
    end
    local n = select('#', ...)
    local args = { ... }
    args[1] = name
    return __playSoundFile(__mudix_ordered_play_args("playSoundFile", unpack(args, 1, n)))
end

-- Mudlet `playVideoFile`. Accepts either:
--   playVideoFile(filename [, volume [, loops]])  -- positional
--   playVideoFile({name=..., volume=..., loops=..., width=..., height=...})
-- The file resolves against the profile VFS or may be an http(s):// URL.
function playVideoFile(a, b, c)
    if type(a) == 'table' then
        __mudix_check_media_table(a, "playVideoFile")
        __mudix_check_media_name(a, "playVideoFile")
        if __mudix_media_deferred(a, __playVideoFile) then return true end
        return __playVideoFile(a)
    end
    return __playVideoFile({ name = tostring(a or ''), volume = b, loops = c })
end

-- Mudlet `loadVideoFile`. Preloads/caches a video so the first playVideoFile
-- has no fetch latency. Accepts:
--   loadVideoFile(name)            -- positional
--   loadVideoFile({name=...})      -- table
-- name resolves against the profile VFS or may be an http(s):// URL.
function loadVideoFile(...)
    if select('#', ...) == 0 then
        error("loadVideoFile: need at least one argument", 2)
    end
    local a = ...
    -- The video calls take the table form only; a bare filename is the sound
    -- and music shape, and accepting it here would quietly preload nothing.
    if type(a) ~= 'table' then
        error("loadVideoFile: needs to be a table", 2)
    end
    __mudix_check_media_load_table(a, "loadVideoFile")
    if __mudix_media_deferred(a, __loadVideoFile) then return true end
    return __loadVideoFile({ name = tostring(a.name or a.url or '') })
end

-- Mudlet `playMusicFile`. Table-arg only:
--   playMusicFile({name=..., volume=..., fadein=..., fadeout=..., start=...,
--                  loops=..., key=..., tag=..., ["continue"]=true|false})
-- When `continue=true` and a track with the same key (or name when no key) is
-- already playing, the call is a no-op. Otherwise the previous matching track
-- is stopped and the new one starts.
function playMusicFile(...)
    if select('#', ...) == 0 then
        error("playMusicFile: need at least one argument", 2)
    end
    local opts = ...
    if type(opts) == 'table' then
        __mudix_check_media_table(opts, "playMusicFile")
        __mudix_check_media_name(opts, "playMusicFile")
        if __mudix_media_deferred(opts, __playMusicFile) then return true end
        return __playMusicFile(opts)
    end
    local name = __mudix_str(opts)
    if name == nil or name == '' then
        return nil, "playMusicFile: missing argument 1 (file to play)"
    end
    local n = select('#', ...)
    local args = { ... }
    args[1] = name
    return __playMusicFile(__mudix_ordered_play_args("playMusicFile", unpack(args, 1, n)))
end

-- Mudlet `loadSoundFile`. Preloads a sound so the first playSoundFile has no
-- decode latency. Accepts:
--   loadSoundFile(name [, url])            -- positional
--   loadSoundFile({name=..., url=...})     -- table
-- mudix resolves `name` against the profile VFS (or treats it as a URL); the
-- optional `url` is accepted for Mudlet compatibility and used only when no
-- name is supplied.
function loadSoundFile(...)
    local name, err = __mudix_media_load_args("loadSoundFile", ...)
    if err then return nil, err end
    local a = ...
    if type(a) == 'table' and __mudix_media_deferred(a, __loadSoundFile) then return true end
    return __loadSoundFile({ name = name })
end

-- Mudlet `loadMusicFile`. Preloads a music track (same decode/cache path as
-- loadSoundFile — the cache is keyed by path, not by sound/music kind). Accepts:
--   loadMusicFile(name [, url])            -- positional
--   loadMusicFile({name=..., url=...})     -- table
function loadMusicFile(...)
    local name, err = __mudix_media_load_args("loadMusicFile", ...)
    if err then return nil, err end
    local a = ...
    if type(a) == 'table' and __mudix_media_deferred(a, __loadMusicFile) then return true end
    return __loadMusicFile({ name = name })
end

-- Mudlet `getPlayingSounds([filter])`. Returns a 1-indexed array of currently
-- playing sound effects: { {name=, key=, tag=, volume=}, ... }. Accepts an
-- optional filter as either positional (name[,key][,tag]) or a table. JS hands
-- back a 0-indexed array (wasmoon convention); re-index to 1-based here.
-- stopSounds / stopVideos are plain JS globals taking no arguments; Mudlet
-- accepts an optional filter table and validates its fields. Capture the
-- primitives before shadowing them (Bridge.lua runs after the bindings are
-- installed, so these definitions win) and return Mudlet's `true`.
do
    local _rawStopSounds = stopSounds
    local _rawStopVideos = stopVideos
    -- Either form: a filter table, or the ordered
    -- (name, key, tag [, priority [, fadeaway]]).
    function stopSounds(opts, key, tag, priority, fadeaway)
        if opts ~= nil and type(opts) ~= 'table' then
            __mudix_check_media_filter_args("stopSounds", opts, key, tag, priority, fadeaway)
        elseif opts ~= nil then
            __mudix_check_media_table(opts, "stopSounds")
        end
        _rawStopSounds()
        return true
    end
    -- Table form only, like the rest of the video family.
    function stopVideos(opts)
        __mudix_check_media_filter_table(opts, "stopVideos")
        _rawStopVideos()
        return true
    end
    local _rawPauseVideos = pauseVideos
    function pauseVideos(opts)
        __mudix_check_media_filter_table(opts, "pauseVideos")
        _rawPauseVideos()
        return true
    end
end

-- pauseSounds / pauseMusic take no arguments or a filter *table* in Mudlet
-- (TLuaInterpreterMedia.cpp), and reject anything else with this exact wording.
-- The JS primitives underneath take an optional channel string instead, so the
-- table's `tag` — Mudlet's channel field — is what gets handed down.
do
    local _rawPauseSounds = pauseSounds
    local _rawPauseMusic = pauseMusic
    local function pause(raw, who, opts)
        if opts == nil then
            raw()
            return true
        end
        if type(opts) ~= 'table' then
            error(who .. ": needs to be a table", 2)
        end
        __mudix_check_media_table(opts, who)
        raw(opts.tag)
        return true
    end
    function pauseSounds(opts) return pause(_rawPauseSounds, "pauseSounds", opts) end
    function pauseMusic(opts) return pause(_rawPauseMusic, "pauseMusic", opts) end
end

-- The query, pause and stop family all take a media filter, and the ones below
-- take it in the *table* form only — Mudlet refuses anything else with this
-- exact wording, so a script handed a number gets told rather than quietly
-- matching everything.
function __mudix_check_media_filter_table(v, funcName)
    if v == nil then return end
    if type(v) ~= 'table' then
        error(funcName .. ": needs to be a table", 3)
    end
    __mudix_check_media_table(v, funcName)
end

-- The ordered filter form: (name, key, tag [, priority [, fadeaway]]). Each
-- position is type-checked by the name it carries, so the complaint names the
-- argument rather than its index.
function __mudix_check_media_filter_args(funcName, name, key, tag, priority, fadeaway)
    local function want(v, field, expected)
        if v ~= nil and type(v) ~= expected then
            error(funcName .. ": bad argument type (" .. field .. " as " .. expected
                .. " expected, got " .. type(v) .. "!)", 3)
        end
    end
    want(name, "name", 'string')
    want(key, "key", 'string')
    want(tag, "tag", 'string')
    want(priority, "priority", 'number')
    want(fadeaway, "fadeaway", 'boolean')
end

function getPlayingSounds(a, b, c, d)
    local filter
    if type(a) == 'table' then
        __mudix_check_media_table(a, "getPlayingSounds")
        filter = { name = a.name, key = a.key, tag = a.tag }
    else
        __mudix_check_media_filter_args("getPlayingSounds", a, b, c, d)
        filter = { name = a, key = b, tag = c }
    end
    local raw = __getPlayingSounds(filter)
    local out = {}
    if type(raw) == 'table' then
        for _, v in pairs(raw) do
            out[#out + 1] = { name = v.name, key = v.key, tag = v.tag, volume = v.volume }
        end
    end
    return out
end

-- Mudlet `getPlayingMusic([filter])`. Same filter/shape as getPlayingSounds
-- but for the music channel.
function getPlayingMusic(a, b, c, d)
    local filter
    if type(a) == 'table' then
        __mudix_check_media_table(a, "getPlayingMusic")
        filter = { name = a.name, key = a.key, tag = a.tag }
    else
        __mudix_check_media_filter_args("getPlayingMusic", a, b, c, d)
        filter = { name = a, key = b, tag = c }
    end
    local raw = __getPlayingMusic(filter)
    local out = {}
    if type(raw) == 'table' then
        for _, v in pairs(raw) do
            out[#out + 1] = { name = v.name, key = v.key, tag = v.tag, volume = v.volume }
        end
    end
    return out
end

-- Mudlet `getPausedSounds([filter])` / `getPausedMusic([filter])`. mudix's Web
-- Audio backend stops rather than pauses sources, so these always return an
-- empty list (kept for ported-script parity). The filter is accepted and
-- ignored.
function getPausedSounds(filter)
    __mudix_check_media_filter_table(filter, "getPausedSounds")
    return {}
end
function getPausedMusic(filter)
    __mudix_check_media_filter_table(filter, "getPausedMusic")
    return {}
end

-- Mudlet `getPlayingVideos([filter])` / `getPausedVideos([filter])`. Returns a
-- 1-indexed array of { name=, path=, volume= } for the videos currently in the
-- requested play state, optionally filtered by name. JS hands back a 0-indexed
-- array; re-index to 1-based here.
local function reindexVideos(raw)
    local out = {}
    if type(raw) == 'table' then
        for _, v in pairs(raw) do
            out[#out + 1] = { name = v.name, path = v.path, volume = v.volume }
        end
    end
    return out
end
function getPlayingVideos(a)
    __mudix_check_media_filter_table(a, "getPlayingVideos")
    return reindexVideos(__getPlayingVideos({ name = a and a.name or nil }))
end
function getPausedVideos(a)
    __mudix_check_media_filter_table(a, "getPausedVideos")
    return reindexVideos(__getPausedVideos({ name = a and a.name or nil }))
end

-- Mudlet `ancestors(id, type)`. Re-index the JS 0-indexed array of
-- {id, name, node, isActive} (immediate parent → root) to a 1-based Lua
-- sequence. (false, errMsg) when no item of that type carries the id.
function ancestors(id, itemType)
    local raw = __ancestors(id, itemType)
    if not raw then
        return false, "ancestors: " .. tostring(itemType) .. " item ID " .. tostring(id) .. " does not exist"
    end
    local out = {}
    local i = 0
    while raw[i] ~= nil do
        local v = raw[i]
        out[#out + 1] = { id = v.id, name = v.name, node = v.node, isActive = v.isActive }
        i = i + 1
    end
    return out
end

-- Mudlet `findItems(name, type [, exact [, caseSensitive]])`. Both flags default
-- to true (matching Mudlet). Returns a 1-based array of numeric item ids, or
-- (nil, errMsg) for an item type there is no such family for — which is a
-- caller mistake, and would otherwise be indistinguishable from "nothing
-- matched".
function findItems(name, itemType, exact, caseSensitive)
    name = __mudix_check_string(name, "findItems", 1, "item name")
    itemType = __mudix_check_string(itemType, "findItems", 2, "item type")
    if exact == nil then exact = true end
    if caseSensitive == nil then caseSensitive = true end
    local raw = __findItems(name, itemType, exact, caseSensitive)
    if raw == nil then
        return nil, "findItems: invalid item type '" .. tostring(itemType)
            .. "' given, it should be one (case insensitive) of: 'alias', 'button',"
            .. " 'script', 'keybind', 'timer' or 'trigger'"
    end
    local out = {}
    local i = 0
    while raw[i] ~= nil do
        out[#out + 1] = raw[i]
        i = i + 1
    end
    return out
end

-- Mudlet `isAncestorsActive(id, type)`. True when every ancestor group of the
-- item is enabled. The three ways of getting it wrong are told apart, because a
-- bare false would read as "an ancestor is disabled" — the one answer that IS a
-- legitimate false:
--   * an id that is not a positive integer,
--   * a type there is no such family for,
--   * a well-formed id no item of that type carries.
function isAncestorsActive(id, itemType)
    id = __mudix_check_number(id, "isAncestorsActive", 1, "item ID")
    itemType = __mudix_check_string(itemType, "isAncestorsActive", 2, "item type")
    if id < 1 or id ~= math.floor(id) then
        return nil, "isAncestorsActive: item ID as " .. tostring(id)
            .. " does not seem to be parseable as a positive integer"
    end
    if not __isKnownItemType(itemType) then
        return nil, "isAncestorsActive: invalid item type '" .. tostring(itemType)
            .. "' given, it should be one (case insensitive) of: 'alias', 'button',"
            .. " 'script', 'keybind', 'timer' or 'trigger'"
    end
    local raw = __isAncestorsActive(id, itemType)
    if raw == nil then
        return nil, "isAncestorsActive: " .. tostring(itemType) .. " item ID " .. tostring(id) .. " does not exist"
    end
    return raw
end

-- Mudlet `getProfileStats()`. Rebuild the nested counts table off the JS object
-- so the Lua side always sees a clean, fully-populated structure.
function getProfileStats()
    local r = __getProfileStats() or {}
    local function fam(t)
        t = t or {}
        return { total = t.total or 0, temp = t.temp or 0, active = t.active or 0 }
    end
    local triggers = fam(r.triggers)
    local pat = (r.triggers and r.triggers.patterns) or {}
    triggers.patterns = { total = pat.total or 0, active = pat.active or 0 }
    local gifs = r.gifs or {}
    return {
        triggers = triggers,
        aliases = fam(r.aliases),
        timers = fam(r.timers),
        keys = fam(r.keys),
        scripts = fam(r.scripts),
        gifs = { total = gifs.total or 0, active = gifs.active or 0 },
    }
end

-- Mudlet registerMapInfo(label, function). The callback runs every time the
-- map widget repaints; its multi-return (text, isBold, isItalic, r, g, b)
-- becomes the rendered line. New contributors land disabled — caller must
-- enableMapInfo() to show them. Re-registering the same label replaces the
-- callback (JS frees the prior __mudix_cb slot).
do
    local _raw = __mudix_registerMapInfo
    function registerMapInfo(label, fn)
        local name = __mudix_str(label)
        if name == nil or name == '' then
            error("registerMapInfo: bad argument #1 type (non-empty string expected, got " .. type(label) .. ")", 2)
        end
        label = name
        if type(fn) ~= 'function' then
            error("registerMapInfo: bad argument #2 type (function expected, got " .. type(fn) .. ")", 2)
        end
        return _raw(label, __mudix_register_cb(fn))
    end
end

-- Mudlet getMapSelection() → { rooms = {roomIDs}, center = roomID }. JS hands
-- the rooms array over 0-indexed (wasmoon convention); rebuild as a 1-indexed
-- Lua sequence so ipairs() / # work the way scripts expect. `center` is null
-- in JS when nothing is selected — surface that as nil on the Lua side.
function getMapSelection()
    local raw = __getMapSelection()
    local rooms = {}
    if type(raw) == 'table' and type(raw.rooms) == 'table' then
        local src = raw.rooms
        local i = 0
        while src[i] ~= nil do
            rooms[#rooms + 1] = src[i]
            i = i + 1
        end
        if #rooms == 0 then
            for _, v in ipairs(src) do rooms[#rooms + 1] = v end
        end
    end
    local center = nil
    if type(raw) == 'table' and raw.center ~= nil then center = raw.center end
    return { rooms = rooms, center = center }
end

-- Mudlet killMapInfo / enableMapInfo / disableMapInfo. Each returns true on
-- success or (false, errMsg) when the label isn't registered.
function killMapInfo(label)
    if __killMapInfo(label) then return true end
    return nil, "killMapInfo: could not find map info called '" .. tostring(label) .. "'"
end
function enableMapInfo(label)
    if __enableMapInfo(label) then return true end
    return nil, "enableMapInfo: could not find map info called '" .. tostring(label) .. "'"
end
function disableMapInfo(label)
    if __disableMapInfo(label) then return true end
    return nil, "disableMapInfo: could not find map info called '" .. tostring(label) .. "'"
end

-- JS-readable result slots for a single registerMapInfo callback invocation.
-- The MapPanel re-evaluator drives one dispatch per enabled contributor and
-- reads these globals immediately after each call — Lua coroutines share
-- globals, so the chunk run inside runChunk writes to the same _G we read.
__mudix_mapinfo_text = nil
__mudix_mapinfo_bold = false
__mudix_mapinfo_italic = false
__mudix_mapinfo_r = nil
__mudix_mapinfo_g = nil
__mudix_mapinfo_b = nil
function __mudix_dispatch_mapinfo(id, roomId, selectionSize, areaId, displayedAreaId)
    __mudix_mapinfo_text = nil
    __mudix_mapinfo_bold = false
    __mudix_mapinfo_italic = false
    __mudix_mapinfo_r = nil
    __mudix_mapinfo_g = nil
    __mudix_mapinfo_b = nil
    local fn = __mudix_cb[id]
    if type(fn) ~= 'function' then return end
    local ok, text, isBold, isItalic, r, g, b = pcall(fn, roomId, selectionSize, areaId, displayedAreaId)
    if not ok then
        if type(showHandlerError) == 'function' then
            showHandlerError("registerMapInfo callback", tostring(text))
        end
        return
    end
    if text == nil or text == '' then return end
    __mudix_mapinfo_text = tostring(text)
    __mudix_mapinfo_bold = isBold == true
    __mudix_mapinfo_italic = isItalic == true
    if type(r) == 'number' then __mudix_mapinfo_r = r end
    if type(g) == 'number' then __mudix_mapinfo_g = g end
    if type(b) == 'number' then __mudix_mapinfo_b = b end
end

-- ── Window state getters ───────────────────────────────────────────────────
-- All three mirror Mudlet: a missing name argument is a hard error (so a typo
-- surfaces immediately rather than silently reporting "not found"), while a
-- name that simply doesn't resolve returns the (nil, errMsg) pair. "main" is
-- excluded for geometry/visibility exactly as moveWindow/resizeWindow exclude
-- it — there is no dock widget behind it to measure.

-- The main window answers to two names: "main" and the empty string, which is
-- what Mudlet's own window-name argument resolves to when a script leaves it
-- out of a call that still passes something. Neither is a window in the
-- registry, so both getters below have to recognise them before the lookup.
local function __mudix_is_main_window(name)
    return name == 'main' or name == ''
end

-- Mudlet getWindowGeometry(name) → x, y, width, height.
function getWindowGeometry(name)
    if name == nil then
        error('getWindowGeometry: bad argument #1 type (window name as string expected, got nil!)', 2)
    end
    if __mudix_is_main_window(name) then
        local w, h = getMainWindowSize()
        return 0, 0, w, h
    end
    local g = __getWindowGeometry(name)
    if g == nil then
        return nil, 'getWindowGeometry: window "' .. tostring(name) .. '" not found'
    end
    return g.x, g.y, g.width, g.height
end

-- Mudlet windowVisible(name) → bool. Effective visibility: false when the
-- window itself is hidden OR any ancestor is.
function windowVisible(name)
    if name == nil then
        error('windowVisible: bad argument #1 type (window name as string expected, got nil!)', 2)
    end
    -- The main window is always visible: there is no way to hide it, and it is
    -- the one every other window's visibility is measured against.
    if __mudix_is_main_window(name) then return true end
    local v = __windowVisible(name)
    if v == nil then
        return nil, 'windowVisible: window "' .. tostring(name) .. '" not found'
    end
    return v.visible
end

-- Mudlet getLabelText(name) → text set via echo()/setLabelText. A name that is
-- not a label (a miniconsole, say) is an error case, not an empty string.
function getLabelText(name)
    if name == nil then
        error('getLabelText: bad argument #1 type (label name as string expected, got nil!)', 2)
    end
    local t = __getLabelText(name)
    if t == nil then
        return nil, 'getLabelText: label "' .. tostring(name) .. '" not found'
    end
    return t
end

-- Mudlet getCollisionLocationsInArea(areaID) — coordinates in the area shared
-- by more than one room, as a 1-indexed list of {x, y, z}. JS hands both levels
-- over 0-indexed (wasmoon convention) and nil for an unknown area.
function getCollisionLocationsInArea(areaID)
    local res = __getCollisionLocationsInArea(areaID)
    if res == nil then
        return nil, "getCollisionLocationsInArea: areaID " .. tostring(areaID) .. " not found"
    end
    local out, i = {}, 0
    while res[i] ~= nil do
        local c = res[i]
        out[i + 1] = { c[0], c[1], c[2] }
        i = i + 1
    end
    return out
end

-- JS-readable result slots for one setExitWeightFilter callback invocation.
-- findPath dispatches once per candidate exit and reads these immediately.
-- Return-value handling mirrors Mudlet's applyExitWeightFilter: boolean false
-- or the string "block" (case-insensitive) blocks the exit, a number is a
-- weight override clamped to [1, 2^31-1], and nil / true / anything else is
-- ignored. A callback that errors is treated as "no opinion" so a broken
-- filter degrades to plain pathfinding instead of breaking every route.
__mudix_ewf_blocked = false
__mudix_ewf_weight = nil
__mudix_ewf_cmd = nil
function __mudix_dispatch_exit_weight_filter(id, roomId, exitCommand)
    __mudix_ewf_blocked = false
    __mudix_ewf_weight = nil
    local fn = __mudix_cb[id]
    if type(fn) ~= 'function' then return end
    local ok, verdict = pcall(fn, roomId, exitCommand)
    if not ok then
        if type(showHandlerError) == 'function' then
            showHandlerError("setExitWeightFilter callback", tostring(verdict))
        end
        return
    end
    if verdict == false then
        __mudix_ewf_blocked = true
    elseif type(verdict) == 'number' then
        local w = verdict
        if w < 1 then w = 1 elseif w > 2147483647 then w = 2147483647 end
        __mudix_ewf_weight = math.floor(w + 0.5)
    elseif type(verdict) == 'string' and verdict:lower() == 'block' then
        __mudix_ewf_blocked = true
    end
end

-- Mudlet `setExitWeightFilter(fn)` / `setExitWeightFilter(nil)`. Stores the
-- callback in the shared registry and hands JS only its id (wasmoon function
-- proxies must never be held on the JS side). Passing nil clears the filter.
function setExitWeightFilter(fn)
    if fn == nil then
        __setExitWeightFilter(0)
        return true
    end
    if type(fn) ~= 'function' then
        error('setExitWeightFilter: bad argument #1 type (callback as function expected, got '
            .. type(fn) .. '!)', 2)
    end
    __setExitWeightFilter(__mudix_register_cb(fn))
    return true
end

-- Mudlet `stopMusic([{name=..., key=..., tag=..., fadeout=...}])`.
-- With no filters, stops every music track. fadeout (ms) overrides the
-- per-track fadeout for this stop call.
-- Either form, as with stopSounds — but the music stop's ordered tail is
-- (name, key, tag [, fadeaway [, fadeout]]), with no priority: a music track
-- has no priority to match on.
function stopMusic(opts, key, tag, fadeaway, fadeout)
    if opts ~= nil and type(opts) ~= 'table' then
        __mudix_check_media_filter_args("stopMusic", opts, key, tag, nil, fadeaway)
        if fadeout ~= nil then
            local ms = __mudix_num(fadeout)
            if ms == nil then
                error("stopMusic: bad argument type (fadeout as number expected, got "
                    .. type(fadeout) .. "!)", 2)
            end
            if fadeout < 0 then
                error("stopMusic: bad argument range for fadeout, got " .. tostring(fadeout) .. "!", 2)
            end
        end
        __stopMusic({ name = opts, key = key, tag = tag, fadeout = fadeout })
        return true
    end
    if opts ~= nil then __mudix_check_media_table(opts, "stopMusic") end
    __stopMusic(opts)
    return true
end

-- ── Text-to-speech array / nil-returning wrappers ──────────────────────────
-- The simple tts* functions (ttsSpeak, ttsQueue, ttsSetRate, ...) are plain JS
-- globals. The three below need re-shaping: wasmoon pushes JS arrays 0-indexed,
-- so the list returns are walked into a 1-based Lua table, and ttsGetCurrentLine
-- maps its `false` (not speaking) sentinel to Mudlet's (nil, reason) tuple.

local function __tts_to_list(raw)
    local out = {}
    if type(raw) == 'table' then
        local i = 0
        while raw[i] ~= nil do
            out[#out + 1] = raw[i]
            i = i + 1
        end
        if #out == 0 then
            for _, v in ipairs(raw) do out[#out + 1] = v end
        end
    end
    return out
end

-- Mudlet ttsGetVoices() → 1-based table of available voice names.
function ttsGetVoices()
    return __tts_to_list(__ttsGetVoices())
end

-- Mudlet ttsGetQueue([index]) → with an index, the queued text at that 1-based
-- position (or false when out of bounds); without one, the whole queue as a
-- 1-based table.
function ttsGetQueue(index)
    if index ~= nil then
        return __ttsGetQueue(index)
    end
    return __tts_to_list(__ttsGetQueue())
end

-- Mudlet validates the TTS arguments itself and distinguishes two failure kinds:
-- a wrongly *typed* argument is a script bug and raises, while text that is
-- merely empty is a no-op that reports back as (nil, reason). Keeping both here
-- rather than in the JS bindings means the messages read the same as the rest of
-- the Lua API surface.
local function __tts_check(who, argN, value, expected)
    if type(value) ~= expected then
        error(who .. ": bad argument #" .. argN .. " type ("
            .. expected .. " expected, got " .. type(value) .. "!)")
    end
end

-- Mudlet ttsSpeak(text) / ttsQueue(text[, index]) → speak now / append to the
-- queue. Whitespace-only text is skipped rather than spoken: an empty utterance
-- would still occupy the engine and delay everything queued behind it.
local function __tts_say(who, raw, text, index)
    __tts_check(who, 1, text, "string")
    if text:match("^%s*$") then
        return nil, who .. ": skipped empty text to speak (TTS)"
    end
    if index ~= nil then
        __tts_check(who, 2, index, "number")
        return raw(text, index)
    end
    return raw(text)
end

function ttsSpeak(text) return __tts_say("ttsSpeak", __ttsSpeak, text) end
function ttsQueue(text, index) return __tts_say("ttsQueue", __ttsQueue, text, index) end

-- Mudlet ttsClearQueue([index]) → drop one queued line, or the whole queue. An
-- out-of-range index removes nothing and says so, rather than silently doing
-- what "clear everything" would have done.
function ttsClearQueue(index)
    if index == nil then return __ttsClearQueue() end
    __tts_check("ttsClearQueue", 1, index, "number")
    if __ttsClearQueue(index) == false then
        return nil, "index " .. index .. " out of bounds for queue size "
            .. #__tts_to_list(__ttsGetQueue())
    end
    return true
end

function ttsSetVoiceByName(name)
    __tts_check("ttsSetVoiceByName", 1, name, "string")
    return __ttsSetVoiceByName(name)
end

function ttsSetVoiceByIndex(index)
    __tts_check("ttsSetVoiceByIndex", 1, index, "number")
    return __ttsSetVoiceByIndex(index)
end

function ttsSetRate(rate)
    __tts_check("ttsSetRate", 1, rate, "number")
    return __ttsSetRate(rate)
end

function ttsSetPitch(pitch)
    __tts_check("ttsSetPitch", 1, pitch, "number")
    return __ttsSetPitch(pitch)
end

function ttsSetVolume(volume)
    __tts_check("ttsSetVolume", 1, volume, "number")
    return __ttsSetVolume(volume)
end

-- Mudlet ttsGetCurrentLine() → the text being spoken, or (nil, reason) when the
-- engine is idle or errored.
function ttsGetCurrentLine()
    local line = __ttsGetCurrentLine()
    if line == false then
        return nil, "not speaking any text"
    end
    return line
end

-- Mudlet's `mapInfoColor` config key is the map-info widget *background* colour
-- (an {r, g, b[, a]} table, alpha defaulting to 255). wasmoon can't reliably
-- hand a Lua table proxy to JS, so marshal it across the boundary as a plain
-- "r,g,b,a" string: flatten the table on the way in, rebuild it on the way out.
-- These wrappers run before Other.lua re-wraps setConfig/getConfig (Bridge loads
-- first), so its table-form / no-arg-dump paths funnel single keys through here.
--
-- The same block carries getConfig/setConfig's argument contract. Mudlet reads
-- the key with getVerifiedString and each value with the getVerified* helper for
-- its type, so a missing/empty key and a value of the WRONG TYPE raise, while an
-- unknown key or an out-of-range value are (nil, errMsg) returns. mudix's JS
-- primitives coerce and answer with a bare boolean, so the shaping lives here;
-- __mudix_config_kind reports the option's value type (or nil when the key names
-- no option) so the two cases can be told apart before calling through.
do
    local _setConfig = setConfig
    local _getConfig = getConfig

    local function checkKey(key, funcName)
        if __mudix_str(key) == nil then
            error(funcName .. ": bad argument #1 type (key as string expected, got "
                .. type(key) .. "!)", 3)
        end
        if key == '' then return funcName .. ": you must provide a key" end
        return nil
    end

    function setConfig(key, value)
        local keyErr = checkKey(key, "setConfig")
        if keyErr then return nil, keyErr end
        local kind = __mudix_config_kind(key)
        if kind == nil then
            return nil, "setConfig: '" .. key .. "' isn't a valid configuration option"
        end
        if kind == 'readonly' then
            return nil, "setConfig: '" .. key .. "' is a read-only configuration option"
        end
        if kind == 'bool' and type(value) ~= 'boolean' then
            error("setConfig: bad argument #2 type (value as boolean expected, got "
                .. type(value) .. "!)", 2)
        end
        if kind == 'num' and tonumber(value) == nil then
            error("setConfig: bad argument #2 type (value as number expected, got "
                .. type(value) .. "!)", 2)
        end
        -- Mudlet reads every string option with getVerifiedString, which raises
        -- on a non-string; an out-of-range *string* is the (nil, errMsg) case
        -- below. Keys taking more than one type report kind 'any' and vet
        -- themselves.
        if kind == 'str' and __mudix_str(value) == nil then
            error("setConfig: bad argument #2 type (value as string expected, got "
                .. type(value) .. "!)", 2)
        end
        if key == "mapInfoColor" then
            if type(value) ~= "table" then
                error("setConfig: bad argument #2 type (value as table expected, got "
                    .. type(value) .. "!)", 2)
            end
            local r = tonumber(value[1]) or 0
            local g = tonumber(value[2]) or 0
            local b = tonumber(value[3]) or 0
            local a = tonumber(value[4]) or 255
            value = string.format("%d,%d,%d,%d", r, g, b, a)
        end
        local ok = _setConfig(key, value)
        if ok == false then
            return nil, "setConfig: '" .. tostring(value) .. "' is not a valid value for '" .. key .. "'"
        end
        return ok
    end

    function getConfig(key, useStringFormat)
        local keyErr = checkKey(key, "getConfig")
        if keyErr then return nil, keyErr end
        local v = _getConfig(key, useStringFormat and true or false)
        if v == nil then
            return nil, "getConfig: '" .. key .. "' isn't a valid configuration option"
        end
        if key == "mapInfoColor" and type(v) == "string" then
            local r, g, b, a = v:match("^(%d+),(%d+),(%d+),(%d+)$")
            if r then
                return { tonumber(r), tonumber(g), tonumber(b), tonumber(a) }
            end
        end
        return v
    end
end

-- ── MMCP (MudMaster Chat Protocol) ─────────────────────────────────────────
-- MMCP is peer-to-peer chat over direct TCP between clients: a client both
-- listens on a port and dials other clients (mmcp.startServer / mmcp.call). A
-- browser tab can't open raw or listening TCP sockets, nor do peer-to-peer
-- networking, so MMCP has no implementation here — same constraint as the IRC
-- client. The mmcp.* table is still bound as warning-emitting no-op stubs so an
-- imported Mudlet package that references it on load doesn't crash with
-- "attempt to index a nil value". Each entry warns once and returns the
-- documented-shape default (false for actions, "" / {} for value getters).
-- mudlet.supports.mmcp is set false (in Other.lua) so feature-detecting scripts
-- skip MMCP gracefully.
-- Because no peer can ever connect here, "no connected clients" / "no client by
-- that name or id" are simply the true state of this client's (empty) peer list
-- — the same answers Mudlet gives before anyone has connected. So rather than
-- silently returning false, each entry reports that state in Mudlet's shape
-- (MMCPServer.cpp), which is what scripts branch on. Argument validation still
-- runs first, so a caller's own mistakes surface identically to Mudlet.
do
    local NO_CLIENTS = "no connected clients"
    local NO_SUCH = "no client by that name or id"
    local warned = false
    local function warnOnce(name)
        if not warned then
            warned = true
            print("[mudix] mmcp." .. name ..
                " is not available in this client (no peer-to-peer TCP in the browser);"
                .. " MMCP calls report an empty peer list.")
        end
    end
    -- Every peer-directed call needs at least a target/message argument; Mudlet
    -- raises on a missing one before consulting the (empty) client list.
    local function requireArgs(name, count, ...)
        for i = 1, count do
            local v = select(i, ...)
            if __mudix_str(v) == nil then
                error("mmcp." .. name .. ": bad argument #" .. i
                    .. " type (string expected, got " .. type(v) .. "!)", 3)
            end
        end
    end
    -- Reports the empty-peer-list state: `reason` is NO_CLIENTS for the
    -- broadcast calls and NO_SUCH for the ones that name a specific peer.
    local function noPeers(name, argc, reason)
        return function(...)
            warnOnce(name)
            requireArgs(name, argc, ...)
            return nil, reason
        end
    end
    mmcp = {
        -- Broadcast / list-wide: there is nobody to send to.
        chatAll           = noPeers("chatAll", 1, NO_CLIENTS),
        emoteAll          = noPeers("emoteAll", 1, NO_CLIENTS),
        chatGroup         = noPeers("chatGroup", 2, NO_CLIENTS),
        getClientFlags    = noPeers("getClientFlags", 1, NO_CLIENTS),
        sendSideChannel   = noPeers("sendSideChannel", 2, NO_CLIENTS),
        -- Peer-directed: no client answers to any name or id.
        chatTo            = noPeers("chatTo", 2, NO_SUCH),
        ping              = noPeers("ping", 1, NO_SUCH),
        setPrivate        = noPeers("setPrivate", 1, NO_SUCH),
        serve             = noPeers("serve", 1, NO_SUCH),
        snoop             = noPeers("snoop", 1, NO_SUCH),
        allowSnoop        = noPeers("allowSnoop", 1, NO_SUCH),
        setGroup          = noPeers("setGroup", 2, NO_SUCH),
        disconnect        = noPeers("disconnect", 1, NO_SUCH),
        ignore            = noPeers("ignore", 1, NO_SUCH),
        -- accept / deny / setDoNotDisturb / startServer / stopServer / request
        -- / peek are deliberately absent: their registration is commented out in
        -- Mudlet's TLuaInterpreter.cpp ("Tagging for possible 4.21.1 inclusion"),
        -- so mmcp.accept is nil there too. Stubbing them would be worse than
        -- leaving the gap — a package that feature-detects mmcp.accept would
        -- take a branch real Mudlet never offers it.
        -- An empty peer list is reported as nil, not an empty table.
        getClientList     = function() warnOnce("getClientList") return nil end,
        displayClientList = function() warnOnce("displayClientList") return nil end,
        -- Dialling out: validate the host/port exactly as Mudlet does, then
        -- report that the connection didn't happen.
        call = function(host, port)
            warnOnce("call")
            requireArgs("call", 1, host)
            if port ~= nil then
                local num = __mudix_int(port)
                if num == nil then
                    error("mmcp.call: bad argument #2 type (port number as number is optional, got "
                        .. type(port) .. "!)", 2)
                end
                port = num
                if port < 1 or port > 65535 then
                    return nil, "mmcp.call: invalid port number " .. tostring(port)
                        .. " given, if supplied it must be in range 1 to 65535"
                end
            end
            return nil, "mmcp.call: unable to connect, MMCP is not available in this client"
        end,
        -- The local chat name is real local state, so it round-trips; only the
        -- character restrictions are enforced.
        chatName = function(name)
            if name == nil then return __mudix_mmcp_chat_name end
            requireArgs("chatName", 1, name)
            if name:find("~", 1, true) or name:find(",", 1, true) then
                return nil, "mmcp.chatName: invalid chat name: tilde (~) and comma (,) are not allowed"
            end
            __mudix_mmcp_chat_name = name
            return true
        end,
    }
end
-- Local chat name backing mmcp.chatName; defaults to the profile name the way
-- Mudlet seeds it from the player's profile.
__mudix_mmcp_chat_name = ""

-- ── Unknown-window contracts ───────────────────────────────────────────────
-- Mudlet answers a console-targeting call made against a window that doesn't
-- exist with (nil, 'window "X" not found') instead of silently no-opping, so a
-- script can tell a typo from an empty buffer. UI_spec asserts the message
-- verbatim (no function-name prefix), so it is built here rather than through
-- the prefixed helpers used elsewhere.
--
-- `winArity` is the argument count at or above which the FIRST argument is a
-- window name rather than the call's own first parameter: insertText("hi")
-- writes to main while insertText("win", "hi") targets a window, and only the
-- arity tells them apart. nil means argument 1 is always a window — true of the
-- readback getters, which take nothing else.
--
-- Applied at the very end of this file so it wraps each function's FINAL
-- definition, including the ones Bridge.lua re-wraps above (setLink).
do
    local function guard(fn, winArity)
        return function(...)
            local first = ...
            if type(first) == 'string' and first ~= 'main'
                and (winArity == nil or select('#', ...) >= winArity)
                and __windowType(first) == nil
            then
                return nil, 'window "' .. first .. '" not found'
            end
            return fn(...)
        end
    end

    getLineCount    = guard(getLineCount)
    getLineNumber   = guard(getLineNumber)
    getColumnNumber = guard(getColumnNumber)
    getWindowWrap   = guard(getWindowWrap)
    moveCursorEnd   = guard(moveCursorEnd)
    deleteLine      = guard(deleteLine)
    copy            = guard(copy)
    appendBuffer    = guard(appendBuffer)
    resetFormat     = guard(resetFormat)
    -- Overloaded: the window form carries one extra leading argument.
    moveCursor      = guard(moveCursor, 3)     -- (win, x, y) vs (x, y)
    insertText      = guard(insertText, 2)     -- (win, text) vs (text)
    setWindowWrap   = guard(setWindowWrap, 2)  -- (win, n)    vs (n)
    -- A window zero columns wide can show nothing, and used to hang Mudlet as
    -- soon as the next line was displayed in it (upstream #9622). Refused
    -- outright, leaving the width that was there.
    do
        local _rawSetWindowWrap = setWindowWrap
        function setWindowWrap(...)
            local n = select('#', ...)
            local width = select(n, ...)
            if type(width) == 'number' and width < 1 then
                return nil, "setWindowWrap: wrap width must be greater than zero"
            end
            return _rawSetWindowWrap(...)
        end
    end
    setBold         = guard(setBold, 2)        -- (win, bool) vs (bool)
    setLink         = guard(setLink, 3)        -- (win, code, tip) vs (code, tip)
end

-- ── Value-error contracts ──────────────────────────────────────────────────
-- Mudlet reports these as (nil, errMsg) rather than a bare false, so a script
-- can surface the reason. UI_spec asserts every message verbatim, and the
-- wordings genuinely differ between functions (quoting and phrasing included),
-- so they are spelled out here rather than funnelled through a shared helper.
do
    -- isAnsiFgColor / isAnsiBgColor accept Mudlet's 0-16 ANSI range.
    local function ansiGuard(fn, name)
        return function(code, ...)
            local n = tonumber(code)
            if n == nil or n < 0 or n > 16 then
                return nil, "ANSI color " .. tostring(code) .. " out of range (0 to 16)"
            end
            return fn(code, ...)
        end
    end
    isAnsiFgColor = ansiGuard(isAnsiFgColor, "isAnsiFgColor")
    isAnsiBgColor = ansiGuard(isAnsiBgColor, "isAnsiBgColor")

    -- Every scroll API answers an unknown window the same way: (nil, message).
    -- Naming a console that isn't there is a script bug, and returning a bare
    -- false (or worse, silently succeeding) hides it — UI_spec asserts the
    -- message verbatim for all nine of them.
    -- "Window" here means a console: these all reach into a text buffer, and
    -- the widgets that have none — a scroll box, a label, a command line — are
    -- as absent to them as a name nobody has used. A scroll box does scroll,
    -- but with Qt's own bars over whatever it contains, not a console's.
    local CONSOLE_KINDS = { main = true, miniconsole = true, userwindow = true, buffer = true }
    local function missingWindow(win)
        if win == nil or win == 'main' then return nil end
        if CONSOLE_KINDS[__windowType(win)] then return nil end
        return 'window "' .. tostring(win) .. '" not found'
    end
    local function knownWindowGuard(fn, discardResult)
        return function(win, ...)
            local err = missingWindow(win)
            if err then return nil, err end
            if discardResult then
                fn(win, ...)
                -- The scrollbar toggles report nothing at all on success, so
                -- select('#', ...) has to be 0 — returning the binding's own
                -- nil would make it 1.
                return
            end
            return fn(win, ...)
        end
    end
    scrollingActive            = knownWindowGuard(scrollingActive)
    getScroll                  = knownWindowGuard(getScroll)
    scrollTo                   = knownWindowGuard(scrollTo)
    disableScrollBar           = knownWindowGuard(disableScrollBar, true)
    enableScrollBar            = knownWindowGuard(enableScrollBar, true)
    disableHorizontalScrollBar = knownWindowGuard(disableHorizontalScrollBar, true)
    enableHorizontalScrollBar  = knownWindowGuard(enableHorizontalScrollBar, true)

    -- The main console's scrollbar is not script-controllable in Mudlet either,
    -- so enable/disableScrolling keep that extra rejection on top of the
    -- unknown-window check.
    local function scrollGuard(fn)
        return function(win, ...)
            local err = missingWindow(win)
            if err then return nil, err end
            if win == nil or win == 'main' then
                return nil, "scrolling cannot be enabled/disabled for the 'main' window"
            end
            return fn(win, ...)
        end
    end
    enableScrolling  = scrollGuard(enableScrolling)
    disableScrolling = scrollGuard(disableScrolling)

    -- setBackgroundColor([win,] r, g, b [, a]) — each component is 0-255 and the
    -- message names the offending one. Without a leading window name the call
    -- targets the main console, which always exists.
    local _rawSetBackgroundColor = setBackgroundColor
    local CHANNELS = { "red", "green", "blue", "alpha" }
    setBackgroundColor = function(...)
        local args = { ... }
        local n = select('#', ...)
        local hasWindow = type(args[1]) == 'string'
        if hasWindow and args[1] ~= 'main' and __windowType(args[1]) == nil then
            return nil, "window/label '" .. args[1] .. "' not found"
        end
        local first = hasWindow and 2 or 1
        for i = first, n do
            local v = tonumber(args[i])
            local channel = CHANNELS[i - first + 1]
            if channel and v ~= nil and (v < 0 or v > 255) then
                return nil, channel .. " value " .. tostring(args[i]) .. " needs to be between 0-255"
            end
        end
        return _rawSetBackgroundColor(...)
    end
end

-- ── Trigger/automation argument contracts ──────────────────────────────────
-- Mudlet validates these before creating anything and reports the failure the
-- way Trigger_spec asserts: a wrong TYPE raises, while a wrong VALUE (an expiry
-- count below one, an item type that names no collection) is a (nil, errMsg)
-- return. mudix's JS bindings coerce instead, so the checks live here.
do
    local ITEM_TYPES = {
        alias = true, trigger = true, timer = true,
        key = true, keybind = true, button = true, script = true,
    }

    -- isActive/exists: the item type must name a real collection, and a numeric
    -- id must be positive. Both report a bad argument as (nil, errMsg).
    local function itemLookupGuard(fn, funcName)
        return function(nameOrId, itemType, ...)
            if type(itemType) ~= 'string' or not ITEM_TYPES[itemType] then
                return nil, funcName .. ": invalid item type '" .. tostring(itemType) .. "'"
            end
            if type(nameOrId) == 'number' and nameOrId < 1 then
                return nil, funcName .. ": item id " .. tostring(nameOrId) .. " is not a valid id"
            end
            return fn(nameOrId, itemType, ...)
        end
    end
    isActive = itemLookupGuard(isActive, "isActive")
    exists   = itemLookupGuard(exists, "exists")

    -- Expiry counts: nil means "never expires"; anything non-numeric is a type
    -- error, and a count below one could never fire so it is refused outright.
    -- `pos` is the argument position the expiry occupies for that function.
    -- Returns (errMsg, coercedValue): the caller substitutes the converted
    -- count back into the argument list so a "3" reaches the engine as 3.
    function __mudix_check_expiry(value, funcName, pos)
        if value == nil then return nil, nil end
        local count = __mudix_int(value)
        if count == nil then
            error(funcName .. ": bad argument #" .. pos .. " type (expiration count as number"
                .. " is optional, got " .. type(value) .. "!)", 3)
        end
        if count < 1 then
            return funcName .. ": expiration count must be greater than zero, got " .. tostring(value)
        end
        return nil, count
    end

    local function expiryGuard(fn, funcName, pos)
        return function(...)
            local n = select('#', ...)
            local args = {...}
            local err, count = __mudix_check_expiry(args[pos], funcName, pos)
            if err then return nil, err end
            if count ~= nil then args[pos] = count end
            return fn(unpack(args, 1, n))
        end
    end
    -- (pattern, code, expiry)
    tempTrigger             = expiryGuard(tempTrigger, "tempTrigger", 3)
    tempBeginOfLineTrigger  = expiryGuard(tempBeginOfLineTrigger, "tempBeginOfLineTrigger", 3)
    tempExactMatchTrigger   = expiryGuard(tempExactMatchTrigger, "tempExactMatchTrigger", 3)
    tempRegexTrigger        = expiryGuard(tempRegexTrigger, "tempRegexTrigger", 3)
    -- (code, expiry)
    tempPromptTrigger       = expiryGuard(tempPromptTrigger, "tempPromptTrigger", 2)

    -- setTriggerStayOpen(name, lines) — the line count is required and numeric.
    local _rawSetTriggerStayOpen = setTriggerStayOpen
    setTriggerStayOpen = function(name, lines, ...)
        local count = __mudix_num(lines)
        if count == nil then
            error("setTriggerStayOpen: bad argument #2 type (number of lines as number expected, got "
                .. type(lines) .. "!)", 2)
        end
        return _rawSetTriggerStayOpen(name, count, ...)
    end

    -- feedTelnet(data) injects raw server bytes; anything but a string is a
    -- type error rather than a silent tostring().
    -- Injecting into a socket that is anything but unconnected would interleave
    -- with the live stream, so it is refused with (nil, errMsg).
    feedTelnet = function(data, ...)
        data = __mudix_check_string(data, "feedTelnet", 1, "data")
        local err = __feedTelnet(data, ...)
        if err ~= nil then return nil, err end
        return true
    end

    -- The perm* trigger constructors take a TABLE of patterns; an empty table is
    -- the documented way to make a group, but a bare string is a type error.
    -- The body then goes through reportInvalidLuaCodeParam at #4, in that order
    -- (TLuaInterpreterMudletObjects.cpp) — so a trigger whose body is not a
    -- chunk is refused rather than filed under a pattern it can never answer.
    -- `what` is Mudlet's own noun for the list, and it is NOT uniform: three of
    -- these say "sub-strings list" and permExactMatchTrigger says "exact match
    -- patterns list" (TLuaInterpreterMudletObjects.cpp:1199-1331). Carried
    -- through verbatim rather than tidied into one phrase, since the message is
    -- what a script author matches on.
    local function permPatternGuard(fn, funcName, what)
        return function(name, parent, patterns, code)
            if type(patterns) ~= 'table' then
                error(funcName .. ": bad argument #3 type (" .. what .. " as table expected, got "
                    .. type(patterns) .. "!)", 2)
            end
            return fn(name, parent, patterns, __mudix_check_lua_code(code, funcName, 4))
        end
    end
    permRegexTrigger             = permPatternGuard(permRegexTrigger, "permRegexTrigger", "sub-strings list")
    permSubstringTrigger         = permPatternGuard(permSubstringTrigger, "permSubstringTrigger", "sub-strings list")
    permBeginOfLineStringTrigger = permPatternGuard(permBeginOfLineStringTrigger, "permBeginOfLineStringTrigger", "sub-strings list")
    permExactMatchTrigger        = permPatternGuard(permExactMatchTrigger, "permExactMatchTrigger", "exact match patterns list")

    -- Same check one argument earlier: permPromptTrigger has no pattern list, so
    -- Mudlet validates its body at #3.
    do
        local _raw = permPromptTrigger
        permPromptTrigger = function(name, parent, code)
            return _raw(name, parent, __mudix_check_lua_code(code, "permPromptTrigger", 3))
        end
    end
end

do
    -- tempLineTrigger(from, howMany, code) — the window bounds are line numbers.
    local _rawTempLineTrigger = tempLineTrigger
    tempLineTrigger = function(from, howMany, ...)
        local first = __mudix_int(from)
        if first == nil then
            error("tempLineTrigger: bad argument #1 type (line number as number expected, got "
                .. type(from) .. "!)", 2)
        end
        local count = __mudix_int(howMany)
        if count == nil then
            error("tempLineTrigger: bad argument #2 type (line count as number expected, got "
                .. type(howMany) .. "!)", 2)
        end
        return _rawTempLineTrigger(first, count, ...)
    end

    -- tempComplexRegexTrigger(name, pattern, code, multiline, fg, bg, filter,
    -- matchAll, highlightFg, highlightBg, playSound, fireLength, lineDelta,
    -- expireAfter) — the flags are numbers, and a value of the wrong type is a
    -- type error rather than a silent 0. Omitted ones stay optional.
    --
    -- NOT every argument from #4 on, though, which is what this used to demand:
    -- the two colour patterns, the two highlight colours and the sound file are
    -- all strings when they are anything at all (a number there means "not
    -- set", which is how Mudlet tells them apart). Refusing those made the
    -- highlight and sound arguments unreachable — the code that reads them
    -- tests for a string, and no call carrying one ever got this far.
    local COMPLEX_TRIGGER_FLAGS = {[4] = true, [7] = true, [8] = true, [12] = true, [13] = true, [14] = true}
    local _rawTempComplexRegexTrigger = tempComplexRegexTrigger
    tempComplexRegexTrigger = function(...)
        local n = select('#', ...)
        local args = {...}
        for i = 4, n do
            local v = args[i]
            if v ~= nil and COMPLEX_TRIGGER_FLAGS[i] then
                local num = __mudix_num(v)
                if num == nil then
                    error("tempComplexRegexTrigger: bad argument #" .. i .. " type (flag as number"
                        .. " expected, got " .. type(v) .. "!)", 2)
                end
                args[i] = num
            end
        end
        return _rawTempComplexRegexTrigger(unpack(args, 1, n))
    end

    -- Colour triggers use -1 to mean "ignore this channel". Ignoring both would
    -- match every line, so Mudlet refuses instead of creating a catch-all.
    -- tempColorTrigger predates Mudlet using ANSI numbering, and its colour
    -- arguments are a legacy 1-16 scale that has to be remapped (the comment in
    -- TLuaInterpreterMudletObjects.cpp: "fixing that would break existing
    -- scripts so it has to be tweaked here"). 0 means the default colour, -1
    -- ignores the channel, and anything above 16 is already an ANSI-256 index.
    local LEGACY_COLOR = {
        [0] = -2,   -- default colour: no explicit palette index on the segment
        [1]  =  8, [2]  =  0, [3]  =  9, [4]  =  1,
        [5]  = 10, [6]  =  2, [7]  = 11, [8]  =  3,
        [9]  = 12, [10] =  4, [11] = 13, [12] =  5,
        [13] = 14, [14] =  6, [15] = 15, [16] =  7,
    }
    local function remapLegacyColor(v)
        local n = tonumber(v)
        if n == nil then return v end
        local mapped = LEGACY_COLOR[n]
        return mapped ~= nil and mapped or n
    end

    local _rawTempColorTrigger = tempColorTrigger
    tempColorTrigger = function(fg, bg, ...)
        -- -1 ("ignore this channel") on both would match every line, so Mudlet
        -- refuses rather than creating a catch-all.
        if (tonumber(fg) or -1) < 0 and (tonumber(bg) or -1) < 0 then
            return nil, "tempColorTrigger: only one of foreground and background may be ignored"
        end
        return _rawTempColorTrigger(remapLegacyColor(fg), remapLegacyColor(bg), ...)
    end

    -- tempAnsiColorTrigger(fg [, bg], code [, expiry]). Omitting the background
    -- is equivalent to ignoring it, so an ignored foreground with no background
    -- is the same catch-all case and is refused the same way. Only -1 counts as
    -- ignored here: -2 asks for the default colour, so (-2, -1) and (-1, -2) are
    -- ordinary one-channel colour triggers and must not be refused.
    local _rawTempAnsiColorTrigger = tempAnsiColorTrigger
    tempAnsiColorTrigger = function(fg, a2, ...)
        local bgOmitted = (type(a2) == 'function' or type(a2) == 'string')
        local bg = bgOmitted and -1 or a2
        local function ignored(v)
            local n = tonumber(v)
            return n == nil or (n < 0 and n ~= -2)
        end
        if ignored(fg) and ignored(bg) then
            return nil, "tempAnsiColorTrigger: cannot ignore both foreground and background"
        end
        return _rawTempAnsiColorTrigger(fg, a2, ...)
    end
end

-- ── Mapper argument contracts ──────────────────────────────────────────────
-- Mudlet's mapper API reports a bad *value* — a roomID or areaID that doesn't
-- exist, an empty name, a component outside 0-255 — as `(nil, errMsg)` through
-- warnArgumentValue, and a bad *type* by raising. mudix's JS bindings mostly
-- answered with a bare boolean, so the shaping lives here: a binding hands back
-- either the refusal message or its normal value, and these wrappers turn the
-- former into Mudlet's pair. Appended at the end of the file so every wrapper
-- closes over the final definition of the function it guards.
do
    -- Wraps a binding that returns the refusal message (or nil on success).
    local function shaped(raw)
        return function(...)
            local err = raw(...)
            if err == nil then return true end
            return nil, err
        end
    end

    -- Guards for the bindings that only needed an existence check.
    local function roomGuard(fn, funcName)
        return function(id, ...)
            if not roomExists(id) then
                return nil, funcName .. ": number " .. tostring(id) .. " is not a valid roomID"
            end
            return fn(id, ...)
        end
    end
    local function areaGuard(fn, funcName, pos)
        return function(...)
            local areaId = select(pos or 1, ...)
            if not __areaExists(areaId) then
                return nil, funcName .. ": number " .. tostring(areaId) .. " is not a valid areaID"
            end
            return fn(...)
        end
    end

    -- addRoom keeps its boolean "was it created" answer; only the created-but-
    -- misplaced case is a (nil, errMsg) pair.
    function addRoom(id, areaID)
        local r = __addRoom(id, areaID)
        if type(r) == 'string' then return nil, r end
        return r
    end

    deleteArea        = shaped(__deleteArea)
    setDoor           = shaped(__setDoor)
    setExitWeight     = shaped(__setExitWeight)
    addSpecialExit    = shaped(__addSpecialExit)
    removeSpecialExit = shaped(__removeSpecialExit)
    setCustomEnvColor = shaped(__setCustomEnvColor)
    setMapZoom        = shaped(__setMapZoom)

    setRoomEnv         = roomGuard(setRoomEnv, "setRoomEnv")
    setRoomWeight      = roomGuard(setRoomWeight, "setRoomWeight")
    setRoomHidden      = roomGuard(setRoomHidden, "setRoomHidden")
    setRoomUserData    = roomGuard(setRoomUserData, "setRoomUserData")
    unsetRoomCharColor = roomGuard(unsetRoomCharColor, "unsetRoomCharColor")
    hasExitLock        = roomGuard(hasExitLock, "hasExitLock")
    setAreaUserData    = areaGuard(setAreaUserData, "setAreaUserData")

    -- setAreaUserData/setMapUserData additionally refuse an empty key.
    local function keyGuard(fn, funcName, pos)
        return function(...)
            local n = select('#', ...)
            local args = { ... }
            local key = __mudix_str(args[pos])
            if key == nil or key == '' then
                return nil, funcName .. ": the key cannot be an empty string"
            end
            args[pos] = key
            return fn(unpack(args, 1, n))
        end
    end
    setAreaUserData = keyGuard(setAreaUserData, "setAreaUserData", 2)
    setMapUserData  = keyGuard(setMapUserData, "setMapUserData", 1)

    -- Mudlet setRoomArea(roomID|{roomIDs}, areaID|areaName). wasmoon's table
    -- proxy can't be walked from JS, so the id list is flattened here.
    function setRoomArea(rooms, area)
        local ids
        if type(rooms) == 'table' then
            local parts = {}
            for _, id in ipairs(rooms) do parts[#parts + 1] = tostring(id) end
            ids = table.concat(parts, ',')
        else
            ids = tostring(rooms)
        end
        local err = __setRoomArea(ids, area)
        if err == nil then return true end
        return nil, err
    end

    -- Mudlet getMapZoom([areaID]) → the area's zoom, or (nil, errMsg) for an
    -- areaID that doesn't exist.
    function getMapZoom(areaID)
        local z = __getMapZoom(areaID)
        if z == nil then
            return nil, "getMapZoom: number " .. tostring(areaID) .. " is not a valid areaID"
        end
        return z
    end

    -- Getters whose miss is a bare nil from JS but a documented (nil, errMsg)
    -- pair in Mudlet.
    function getExitStubs(id)
        local raw = __getExitStubs(id)
        if raw == nil then
            return nil, "getExitStubs: number " .. tostring(id) .. " is not a valid roomID"
        end
        return raw
    end

    function getDoors(id)
        local raw = __getDoors(id)
        if raw == nil then
            return nil, "getDoors: number " .. tostring(id) .. " is not a valid roomID"
        end
        return raw
    end

    -- getRoomsByPosition/getAreaRooms report an unknown area as a bare nil in
    -- Mudlet (no message), so this only forwards to the renamed binding.
    function getRoomsByPosition(areaID, x, y, z)
        return __getRoomsByPosition(areaID, x, y, z)
    end

    -- getSpecialExits keeps its re-keying wrapper but now reports the miss.
    local _rawGetSpecialExits = getSpecialExits
    function getSpecialExits(roomId, listAllExits)
        if not roomExists(roomId) then
            return nil, "getSpecialExits: number " .. tostring(roomId) .. " is not a valid roomID"
        end
        return _rawGetSpecialExits(roomId, listAllExits)
    end

    -- searchRoom(roomID) → the room name, or (nil, errMsg) when no room has
    -- that id. The name-search form still returns a (possibly empty) table.
    local _rawSearchRoom = searchRoom
    function searchRoom(arg, caseSensitive, exactMatch)
        local r = _rawSearchRoom(arg, caseSensitive, exactMatch)
        if r == nil or r == false then
            return nil, "searchRoom: number " .. tostring(arg) .. " is not a valid roomID"
        end
        return r
    end

    -- getRoomAreaName(areaID|areaName) resolves either way and reports a miss
    -- as (-1, errMsg) — not nil — while a non-number, non-string argument is a
    -- type error.
    local _rawGetRoomAreaName = getRoomAreaName
    function getRoomAreaName(idOrName)
        local t = type(idOrName)
        if t ~= 'number' and t ~= 'string' then
            error("getRoomAreaName: bad argument #1 type (area id as number or area name as string"
                .. " expected, got " .. t .. "!)", 2)
        end
        local r = _rawGetRoomAreaName(idOrName)
        if r == nil or r == false then
            if t == 'string' then
                return -1, "getRoomAreaName: string '" .. idOrName .. "' is not a valid area name"
            end
            return -1, "getRoomAreaName: number " .. tostring(idOrName) .. " is not a valid area id"
        end
        return r
    end

    -- Type errors: Mudlet raises on an unparseable direction or an out-of-range
    -- colour component rather than reporting a value failure.
    local DIRS = {
        n = true, north = true, ne = true, northeast = true, nw = true, northwest = true,
        e = true, east = true, w = true, west = true, s = true, south = true,
        se = true, southeast = true, sw = true, southwest = true,
        u = true, up = true, d = true, down = true,
        i = true, ['in'] = true, o = true, out = true,
    }
    local function checkDirection(dir, funcName, pos)
        local n = tonumber(dir)
        if n ~= nil then
            if n >= 1 and n <= 12 then return end
        elseif type(dir) == 'string' and DIRS[dir:lower()] then
            return
        end
        error(funcName .. ": bad argument #" .. pos .. " type (direction as string or number"
            .. " {between 1 and 12 inclusive} expected, got " .. tostring(dir) .. "!)", 3)
    end

    local _rawSetExit = setExit
    function setExit(from, to, dir)
        checkDirection(dir, "setExit", 3)
        return _rawSetExit(from, to, dir)
    end

    -- setExitStub raises for both an unknown room and an unparseable direction.
    local _rawSetExitStub = setExitStub
    function setExitStub(id, dir, set)
        if not roomExists(id) then
            error("setExitStub: number " .. tostring(id) .. " is not a valid roomID", 2)
        end
        checkDirection(dir, "setExitStub", 2)
        return _rawSetExitStub(id, dir, set)
    end

    -- connectExitStub(fromID, direction) | (fromID, toID[, direction]) — the
    -- second argument is required.
    local _rawConnectExitStub = connectExitStub
    function connectExitStub(fromID, a2, a3)
        if a2 == nil then
            error("connectExitStub: bad argument #2 type (toID as number or direction as string"
                .. " expected, got nil!)", 2)
        end
        return _rawConnectExitStub(fromID, a2, a3)
    end

    -- setRoomCharColor(roomID, r, g, b [, a]) — components are 0-255.
    local _rawSetRoomCharColor = setRoomCharColor
    local CHANNEL_NAMES = { "red", "green", "blue", "alpha" }
    function setRoomCharColor(roomId, ...)
        local n = select('#', ...)
        for i = 1, n do
            local raw = (select(i, ...))
            local v = tonumber(raw)
            if v == nil or v < 0 or v > 255 then
                error("setRoomCharColor: bad argument #" .. (i + 1) .. " value ("
                    .. (CHANNEL_NAMES[i] or "colour") .. " component " .. tostring(raw)
                    .. " out of range {0 to 255})", 2)
            end
        end
        return _rawSetRoomCharColor(roomId, ...)
    end

    -- createMapper([windowName,] x, y, width, height) — every coordinate is
    -- required; Mudlet raises rather than defaulting them to zero.
    local _rawCreateMapper = createMapper
    function createMapper(...)
        local n = select('#', ...)
        local first = type((select(1, ...))) == 'string' and 1 or 0
        if n < first + 4 then
            error("createMapper: bad argument #" .. (n + 1) .. " type (mapper"
                .. " coordinates/dimensions as numbers expected, got nil!)", 2)
        end
        return _rawCreateMapper(...)
    end
end

-- ── Stopwatch argument contracts ───────────────────────────────────────────
-- Every stopwatch function takes its subject as `stopwatchID as number or name
-- as string`, raises when given anything else, and reports a subject it cannot
-- resolve as (nil, errMsg) — Mudlet's messages are "stopwatch with ID %1 not
-- found" / "stopwatch with name '%1' not found", with the empty name spelled
-- "no unnamed stopwatches found". mudix's JS bindings coerce and answer with a
-- bare false, so the shaping lives here.
do
    local function checkSubject(v, funcName, what)
        if type(v) ~= 'number' and type(v) ~= 'string' then
            error(funcName .. ": bad argument #1 type (" .. what
                .. ", got " .. type(v) .. "!)", 3)
        end
    end

    local function notFound(funcName, subject)
        if type(subject) == 'number' then
            return funcName .. ": stopwatch with ID " .. tostring(subject) .. " not found"
        end
        if subject == '' then return funcName .. ": no unnamed stopwatches found" end
        return funcName .. ": stopwatch with name '" .. tostring(subject) .. "' not found"
    end

    -- None of these has `false` as a legitimate success value — the setters
    -- answer true and the readers a number — so false is unambiguously the miss.
    -- A string return is a refusal the binding could phrase better than we can
    -- here (setStopWatchName naming the watch that already holds the name).
    local function watchGuard(fn, funcName, what)
        return function(subject, ...)
            checkSubject(subject, funcName, what)
            local r = fn(subject, ...)
            if r == false then return nil, notFound(funcName, subject) end
            if type(r) == 'string' then return nil, funcName .. ": " .. r end
            return r
        end
    end

    local ID_OR_NAME = "stopwatchID as number or name as string expected"
    getStopWatchTime           = watchGuard(getStopWatchTime, "getStopWatchTime", ID_OR_NAME)
    startStopWatch             = watchGuard(startStopWatch, "startStopWatch", ID_OR_NAME)
    stopStopWatch              = watchGuard(stopStopWatch, "stopStopWatch", ID_OR_NAME)
    resetStopWatch             = watchGuard(resetStopWatch, "resetStopWatch", ID_OR_NAME)
    adjustStopWatch            = watchGuard(adjustStopWatch, "adjustStopWatch", ID_OR_NAME)
    setStopWatchPersistence    = watchGuard(setStopWatchPersistence, "setStopWatchPersistence", ID_OR_NAME)
    getStopWatchBrokenDownTime = watchGuard(getStopWatchBrokenDownTime, "getStopWatchBrokenDownTime", ID_OR_NAME)
    deleteStopWatch            = watchGuard(deleteStopWatch, "deleteStopWatch",
        "stopwatchID as number or stopwatch name as string expected")
    setStopWatchName           = watchGuard(setStopWatchName, "setStopWatchName",
        "stopwatchID as number or current name as string expected")

    -- createStopWatch([name] | [autostart] [, autostart]) — the first argument is
    -- optional, but anything other than a name, an autostart flag or nil is a
    -- type error. A name already in use is refused with (nil, errMsg).
    local _rawCreateStopWatch = createStopWatch
    function createStopWatch(...)
        local n = select('#', ...)
        local first = ...
        if n > 0 and first ~= nil and type(first) ~= 'string' and type(first) ~= 'boolean' then
            error("createStopWatch: bad argument #1 type (name as string or autostart as"
                .. " boolean are optional, got " .. type(first) .. "!)", 2)
        end
        local id = _rawCreateStopWatch(...)
        if id == false then
            return nil, "createStopWatch: a stopwatch called '" .. tostring(first) .. "' already exists"
        end
        return id
    end
end

-- ── Command-line staging contract ──────────────────────────────────────────
-- Mudlet sendCmdLine(text) reads the command with getVerifiedString (so a
-- missing or non-string argument raises) and always answers true.
do
    local _rawSendCmdLine = sendCmdLine
    function sendCmdLine(a, b)
        -- mudix accepts Mudlet's newer ([cmdLineName,] text) shape too; the name
        -- is ignored (there is a single command bar), but both parts still have
        -- to be strings.
        if b ~= nil then
            a = __mudix_check_string(a, "sendCmdLine", 1, "command line name")
            b = __mudix_check_string(b, "sendCmdLine", 2, "command")
        else
            a = __mudix_check_string(a, "sendCmdLine", 1, "command")
        end
        _rawSendCmdLine(a, b)
        return true
    end
end

-- ── Window primitive argument contracts ────────────────────────────────────
-- Mudlet reads each of these with getVerifiedString/getVerifiedInt, so a
-- missing or wrongly-typed name or coordinate raises rather than defaulting.
-- mudix's JS bindings coerce (an absent name became ""), so the checks live
-- here. Both the five-argument (name, x, y, w, h) and six-argument
-- (parent, name, x, y, w, h) shapes are accepted, as in Mudlet.
do
    local function windowCtorGuard(fn, funcName)
        return function(...)
            local n = select('#', ...)
            local args = {...}
            local nameIndex = (n >= 6) and 2 or 1
            if n >= 6 then
                args[1] = __mudix_check_string(args[1], funcName, 1, "window name")
            end
            args[nameIndex] = __mudix_check_string(args[nameIndex], funcName, nameIndex,
                funcName:sub(7):lower() .. " name")
            for i = nameIndex + 1, nameIndex + 4 do
                local v = __mudix_num(args[i])
                if v == nil then
                    error(funcName .. ": bad argument #" .. i .. " type (coordinate/dimension as"
                        .. " number expected, got " .. type(args[i]) .. "!)", 2)
                end
                args[i] = v
            end
            -- Forward the *coerced* values, not the originals: a name given as a
            -- number reaches the JS binding as a string, a coordinate given as
            -- "0" reaches it as 0. unpack's explicit range keeps trailing nils.
            return fn(unpack(args, 1, n))
        end
    end
    createMiniConsole = windowCtorGuard(createMiniConsole, "createMiniConsole")
    createScrollBox   = windowCtorGuard(createScrollBox, "createScrollBox")
    createCommandLine = windowCtorGuard(createCommandLine, "createCommandLine")
end

-- feedTriggers(text) injects imitation server output. Mudlet reads it with
-- lua_isstring, so a table (or anything else non-coercible) raises rather than
-- being tostring()-ed into the buffer.
do
    local _rawFeedTriggers = feedTriggers
    function feedTriggers(data, ...)
        if type(data) ~= 'string' and type(data) ~= 'number' then
            error("feedTriggers: bad argument #1 type (imitation game server text as string"
                .. " expected, got " .. type(data) .. "!)", 2)
        end
        return _rawFeedTriggers(data, ...)
    end
end

-- Mudlet sendGMCP(message [, what]) — same shape as sendATCP above: both
-- arguments are read with getVerifiedString (so a wrong type raises), and a
-- send with no live socket is a (nil, errMsg) refusal rather than a silent
-- no-op. GMCP_spec asserts these messages in full.
do
    local _raw = sendGMCP
    function sendGMCP(message, what)
        message = __mudix_check_string(message, "sendGMCP", 1, "message")
        if what ~= nil and __mudix_str(what) == nil then
            error("sendGMCP: bad argument #2 type (what as string is optional, got "
                .. type(what) .. "!)", 2)
        end
        if not __mudix_is_connected() then
            return nil, "sendGMCP: not connected to game server - connect first before sending GMCP"
        end
        _raw(message, what)
        return true
    end
end

-- Mudlet remainingTime(timerID|name) → seconds left, or (nil, errMsg): a live
-- timer that has been stopped reports "timer is inactive or expired", one that
-- never existed names the id/name it was asked for. mudix's engine answers -1
-- for every miss, which a script could not tell from a real remaining time.
do
    local _raw = remainingTime
    function remainingTime(idOrName)
        if type(idOrName) ~= 'number' and type(idOrName) ~= 'string' then
            error("remainingTime: bad argument #1 (timerID as number or timer name as"
                .. " string expected, got " .. type(idOrName) .. "!", 2)
        end
        local v = _raw(idOrName)
        -- Mudlet's two sentinels, kept apart because the messages differ and
        -- scripts match on them: -1 means the timer is there but not running,
        -- -2 means nothing of that id/name exists.
        if v == -1 then
            return nil, "remainingTime: timer is inactive or expired"
        end
        if v == nil or v == -2 then
            if type(idOrName) == 'number' then
                return nil, "remainingTime: number " .. idOrName .. " is not a valid timerID"
            end
            return nil, "remainingTime: timer named '" .. idOrName .. "' not found"
        end
        return v
    end
end

-- ── Secondary map views ────────────────────────────────────────────────────
-- Mudlet createMapView([areaID]) / closeMapView(viewID) / closeAllMapViews() /
-- getMapViewIds() / getMapViewInfo(viewID). Extra map windows so several areas
-- can be watched while the primary mapper follows the player.
do
    function createMapView(areaId)
        local r = __createMapView(areaId)
        if type(r) == 'string' then return nil, "createMapView: " .. r end
        return r
    end

    local _rawCloseMapView = closeMapView
    function closeMapView(viewId)
        if _rawCloseMapView(viewId) then return true end
        return nil, "closeMapView: view " .. tostring(viewId) .. " not found"
    end

    -- JS hands the id list over 0-indexed (wasmoon convention).
    function getMapViewIds()
        local raw = __getMapViewIds()
        local out, i = {}, 0
        if type(raw) == 'table' then
            while raw[i] ~= nil do out[i + 1] = raw[i]; i = i + 1 end
        end
        return out
    end

    function getMapViewInfo(viewId)
        local info = __getMapViewInfo(viewId)
        if info == nil then
            return nil, "getMapViewInfo: view " .. tostring(viewId) .. " not found"
        end
        -- Rebuilt off the wasmoon proxy so callers hold a plain Lua table.
        return {
            areaId = info.areaId,
            centeredRoomId = info.centeredRoomId,
            zoom = info.zoom,
            zLevel = info.zLevel,
        }
    end
end

-- ── Stylesheet and main-window argument contracts ──────────────────────────
do
    local _rawSetAppStyleSheet = setAppStyleSheet
    function setAppStyleSheet(css, tag)
        css = __mudix_check_string(css, "setAppStyleSheet", 1, "style sheet")
        if tag ~= nil and __mudix_str(tag) == nil then
            error("setAppStyleSheet: bad argument #2 type (tag as string is optional, got "
                .. type(tag) .. "!)", 2)
        end
        return _rawSetAppStyleSheet(css, tag)
    end

    local _rawSetProfileStyleSheet = setProfileStyleSheet
    function setProfileStyleSheet(css)
        css = __mudix_check_string(css, "setProfileStyleSheet", 1, "style sheet")
        return _rawSetProfileStyleSheet(css)
    end

    local _rawSetMainWindowSize = setMainWindowSize
    function setMainWindowSize(width, height)
        width = __mudix_check_number(width, "setMainWindowSize", 1, "width")
        height = __mudix_check_number(height, "setMainWindowSize", 2, "height")
        return _rawSetMainWindowSize(width, height)
    end
end

-- ── saveMap / loadMap ──────────────────────────────────────────────────────
-- Both take an optional path. Lua coerces a number to a string, so saveMap(42)
-- writes a map named "42" — but a table is a mistake and raises, and so does a
-- format version that is not a number. A save that simply could not be written
-- answers false rather than raising: it reports success, not an error flag.
do
    local function mapPath(who, location, argno)
        if location == nil then return nil end
        local t = type(location)
        if t ~= 'string' and t ~= 'number' then
            error(who .. ": bad argument #" .. argno .. " type (location as string expected, got "
                .. t .. "!)", 3)
        end
        return tostring(location)
    end

    function saveMap(location, formatVersion)
        local path = mapPath("saveMap", location, 1)
        local version = formatVersion ~= nil and __mudix_int(formatVersion) or nil
        if formatVersion ~= nil and version == nil then
            error("saveMap: bad argument #2 type (format version as number expected, got "
                .. type(formatVersion) .. "!)", 2)
        end
        return __saveMap(path, formatVersion) and true or false
    end

    -- The XML importer says why it failed; the binary reader only says whether
    -- it worked, which is the distinction Mudlet draws too.
    function loadMap(location)
        local path = mapPath("loadMap", location, 1)
        -- The XML text is read here rather than on the JS side: an XML map may
        -- live outside the profile filesystem (the busted corpus keeps its
        -- fixture in the read-only /lua/ namespace), and io.open sees both.
        local xml
        if path and path:lower():sub(-4) == ".xml" then
            local f = io.open(path, "r")
            if not f then
                return nil, 'loadMap: the file "' .. path .. '" was not found'
            end
            xml = f:read("*a")
            f:close()
        end
        local r = __loadMap(path, xml)
        if type(r) == 'string' then return nil, r end
        return r and true or false
    end
end

-- ── IRC configuration ──────────────────────────────────────────────────────
-- get/setIrcNick, get/setIrcServer, get/setIrcChannels. mudix has no IRC
-- client — that is a separate service a browser tab cannot reach — but the
-- settings are ordinary profile data, and Mudlet stores them whether or not
-- its client has ever been opened. So these round-trip for real, through the
-- same config bag getConfig("ircPassword") reads. A script that configures IRC
-- and reads it back gets its answers; only connecting is unavailable.
do
    local function channelList()
        local out = {}
        for name in tostring(getConfig("ircChannels") or ""):gmatch("%S+") do
            out[#out + 1] = name
        end
        return out
    end

    -- The one genuinely unavailable half: there is no client, so nothing is
    -- connected and nothing can be restarted or sent. Each says so the way
    -- Mudlet does when its own client isn't up.
    function getIrcConnectedHost()
        return false, "no client active"
    end

    local _rawRestartIrc = restartIrc
    function restartIrc()
        _rawRestartIrc()
        return false
    end

    local _rawSendIrc = sendIrc
    function sendIrc(target, message)
        target = __mudix_check_string(target, "sendIrc", 1, "target")
        message = __mudix_check_string(message, "sendIrc", 2, "message")
        _rawSendIrc(target, message)
        return false, "no client active"
    end

    function getIrcNick()
        return getConfig("ircNick")
    end

    function getIrcServer()
        return getConfig("ircHost"), getConfig("ircPort"), getConfig("ircSecure") and true or false
    end

    function getIrcChannels()
        return channelList()
    end

    function setIrcNick(nick)
        nick = __mudix_check_string(nick, "setIrcNick", 1, "nick")
        if nick == "" then return nil, "nick must not be empty" end
        setConfig("ircNick", nick)
        return true
    end

    function setIrcServer(...)
        local n = select('#', ...)
        local hostName, port, secure, password = ...
        hostName = __mudix_check_string(hostName, "setIrcServer", 1, "hostname")
        if hostName == "" then return nil, "hostname must not be empty" end
        if port ~= nil then
            local num = __mudix_int(port)
            if num == nil then
                error("setIrcServer: bad argument #2 type (port number {default = 6667} as number"
                    .. " is optional, got " .. type(port) .. "!)", 2)
            end
            port = num
            if port < 1 or port > 65535 then
                return nil, "invalid port number " .. tostring(port)
                    .. " given, if supplied it must be in range 1 to 65535"
            end
        else
            port = 6667
        end
        if secure ~= nil and type(secure) ~= 'boolean' then
            error("setIrcServer: bad argument #3 type (secure {default = false} as boolean is"
                .. " optional, got " .. type(secure) .. "!)", 2)
        end
        -- An omitted password — and a nil one, which every optional argument
        -- here treats the same way — leaves the stored password alone: a call
        -- that only changes the host or the port must not drop a credential it
        -- was never given. Clearing one is asking for it, with "".
        local passwordGiven = n > 3 and password ~= nil
        if passwordGiven then
            local secret = __mudix_str(password)
            if secret == nil then
                error("setIrcServer: bad argument #4 type (server password as string is optional, got "
                    .. type(password) .. "!)", 2)
            end
            password = secret
        end
        setConfig("ircHost", hostName)
        setConfig("ircPort", port)
        setConfig("ircSecure", secure and true or false)
        if passwordGiven then setConfig("ircPassword", password) end
        return true
    end

    -- A channel name starts with #, & or +, and can hold neither a space nor a
    -- comma: the stored list is space-joined and the JOIN command comma-joined,
    -- so a name carrying either came back as two channels (upstream #9789).
    -- Anything unusable is dropped, and a list with nothing left is refused.
    function setIrcChannels(channels)
        if type(channels) ~= 'table' then
            error("setIrcChannels: bad argument #1 type (channels as table expected, got "
                .. (channels == nil and 'no value' or type(channels)) .. "!)", 2)
        end
        local kept = {}
        for _, name in pairs(channels) do
            if type(name) == 'string' and name ~= ''
                and (name:sub(1, 1) == '#' or name:sub(1, 1) == '&' or name:sub(1, 1) == '+')
                and not name:find("[%s,]") then
                kept[#kept + 1] = name
            end
        end
        if #kept == 0 then return nil, "no (valid) channel names provided" end
        setConfig("ircChannels", table.concat(kept, " "))
        return true
    end
end

-- Mudlet closeUserWindow(name) — hide a user window without deleting it, so
-- reopening it brings the same dock back. Reports nothing; a name that is not a
-- user window is simply nothing to close.
function closeUserWindow(name)
    name = __mudix_check_string(name, "closeUserWindow", 1, "name")
    if __windowType(name) == 'userwindow' then hideWindow(name) end
end

-- Mudlet setBackgroundImage([window,] path [, mode [, fullWindow]]). GUIUtils'
-- wrapper translates a mode NAME through mudlet.BgImageMode and passes anything
-- it doesn't recognise straight through, so a bad name arrives here as a string
-- and has to be refused. `cover` (mode 5) is a full-window mode: a console is
-- told so rather than left with a background it did not ask for.
do
    local _rawSetBackgroundImage = setBackgroundImage
    function setBackgroundImage(...)
        local n = select('#', ...)
        local args = { ... }
        local modePos = n
        if type(args[n]) == 'boolean' then modePos = n - 1 end
        local mode = args[modePos]
        -- Only the (window, path, mode[, fullWindow]) form definitely carries a
        -- mode. Two arguments are ambiguous — (path, mode) and (window, path)
        -- look alike — and a label's setBackgroundImage(name, path) must not
        -- have its path read as a mode name.
        if modePos >= 3 and mode ~= nil then
            local modeNum = __mudix_int(mode)
            if modeNum == nil then
                error("setBackgroundImage: bad argument #" .. modePos
                    .. " type (mode as number expected, got " .. type(mode) .. "!)", 2)
            end
            mode = modeNum
            args[modePos] = modeNum
            local fullWindow = (modePos < n) and args[n] or false
            local target = (modePos > 2) and args[1] or 'main'
            if mode == 5 and not fullWindow and target ~= 'main' then
                return nil, "setBackgroundImage: mode 'cover' is only available for the main window"
            end
        end
        return _rawSetBackgroundImage(...)
    end
end

-- ── Widget state getters ───────────────────────────────────────────────────
-- The read-back half of setCmdLineStyleSheet / enableScrollBar /
-- setMapWindowTitle / resizeMapWidget: a script that wants to put a widget back
-- the way it found it has to be able to find out how it was.
do
    function getCmdLineStyleSheet(cmdLineName)
        if cmdLineName ~= nil and cmdLineName ~= 'main' then
            if __windowType(cmdLineName) ~= 'commandline' then
                return nil, "command-line name '" .. tostring(cmdLineName) .. "' not found"
            end
        end
        return __getCmdLineStyleSheet(cmdLineName)
    end

    function getScrollBarVisible(windowName)
        if windowName ~= nil and windowName ~= 'main' and __windowType(windowName) == nil then
            return nil, 'window "' .. tostring(windowName) .. '" not found'
        end
        return __getScrollBarVisible(windowName)
    end

    -- The map widget is a single window, so these take no name; both refuse
    -- when it isn't open rather than answering for a widget that isn't there.
    function getMapWindowTitle()
        local title = __getMapWindowTitle()
        if title == nil then return nil, "no floating/dockable type map window found" end
        return title
    end

    -- Mudlet takes the dock position as one of "f" (floating) or "l"/"r"/"t"/
    -- "b", and refuses anything else rather than quietly picking a side —
    -- Geyser.Mapper:setDockPosition passes whatever it was handed straight
    -- through, so this is where a typo has to be caught.
    local DOCK_POSITIONS = { f = true, l = true, r = true, t = true, b = true }
    local _rawOpenMapWidget = openMapWidget
    function openMapWidget(...)
        local n = select('#', ...)
        local a = ...
        if n == 1 and type(a) == 'string' then
            if not DOCK_POSITIONS[a:lower()] then
                return nil, "openMapWidget: docking position '" .. a
                    .. "' is not available, it must be one of 'f', 'l', 'r', 't' or 'b'"
            end
        end
        return _rawOpenMapWidget(...)
    end

    -- Both refuse a widget that isn't open, in the same words as the getters:
    -- retitling a map window that was closed used to report success on a
    -- change nobody could see.
    local _rawSetMapWindowTitle = setMapWindowTitle
    function setMapWindowTitle(title)
        if __getMapWindowTitle() == nil then
            return nil, "no floating/dockable type map window found"
        end
        return _rawSetMapWindowTitle(title) and true or false
    end

    function resetMapWindowTitle()
        return setMapWindowTitle("")
    end

    -- Closing a widget that is already closed is a distinct answer from
    -- closing one that was open: a script that toggles the map needs to be
    -- able to tell "I closed it" from "there was nothing to close".
    local _rawCloseMapWidget = closeMapWidget
    function closeMapWidget()
        if _rawCloseMapWidget() then return true end
        return nil, "map widget already closed"
    end

    function getMapWidgetGeometry()
        local g = __getMapWidgetGeometry()
        if g == nil then return nil, "no floating/dockable type map window found" end
        return g[0], g[1], g[2], g[3]
    end
end

-- ── Label movies ───────────────────────────────────────────────────────────
-- Mudlet's QMovie family: setMovie / startMovie / pauseMovie / scaleMovie /
-- setMovieSpeed / setMovieFrame. All six name a label first and refuse the
-- same three ways, and every refusal used to come back as a bare false — which
-- a caller cannot tell from "the frame you asked for isn't there", the one
-- legitimate false (setMovieFrame's). setMovie words its own label lookup
-- differently from the other five, and upstream's spec pins both.
do
    local function checkLabel(who, name)
        if __mudix_str(name) == nil then
            error(who .. ": bad argument #1 type (label name as string expected, got "
                .. type(name) .. "!)", 3)
        end
        if name == '' then
            return "label name cannot be an empty string"
        end
        return nil
    end

    local _rawSetMovie = setMovie
    function setMovie(labelName, path)
        local err = checkLabel("setMovie", labelName)
        if err then return nil, err end
        labelName = __mudix_str(labelName)
        local moviePath = __mudix_str(path)
        if moviePath == nil then
            error("setMovie: bad argument #2 type (movie path as string expected, got "
                .. type(path) .. "!)", 2)
        end
        path = moviePath
        if __windowType(labelName) ~= 'label' then
            return nil, "label '" .. tostring(labelName) .. "' does not exist"
        end
        if _rawSetMovie(labelName, path) then return true end
        return nil, "no valid movie found at '" .. path .. "'"
    end

    -- The other five share a label lookup, so they share its wording too, and
    -- each reports "there is no movie here" separately from "there is no label".
    local function movieGuard(fn, who, checkArg)
        return function(labelName, ...)
            local err = checkLabel(who, labelName)
            if err then return nil, err end
            labelName = __mudix_str(labelName)
            local n = select('#', ...)
            local args = { ... }
            if __windowType(labelName) ~= 'label' then
                return nil, 'label "' .. tostring(labelName) .. '" not found'
            end
            if checkArg then
                -- The checker hands back the converted value, and the coerced
                -- list is what the binding is called with.
                local bad, coerced = checkArg(who, args[1])
                if bad then error(bad, 2) end
                if coerced ~= nil then args[1] = coerced end
            end
            if not __hasMovie(labelName) then
                return nil, "no movie found at label '" .. tostring(labelName) .. "'"
            end
            local r = fn(labelName, unpack(args, 1, n))
            -- setMovieFrame's false is a real answer (no such frame); the rest
            -- only fail for reasons already ruled out above.
            if r == false then return false end
            return true
        end
    end

    local function numberArg(what)
        return function(who, v)
            local num = __mudix_int(v)
            if num == nil then
                return who .. ": bad argument #2 type (" .. what .. " as number expected, got "
                    .. type(v) .. "!)"
            end
            return nil, num
        end
    end

    startMovie    = movieGuard(startMovie, "startMovie")
    pauseMovie    = movieGuard(pauseMovie, "pauseMovie")
    setMovieSpeed = movieGuard(setMovieSpeed, "setMovieSpeed", numberArg("speed percentage"))
    setMovieFrame = movieGuard(setMovieFrame, "setMovieFrame", numberArg("frame number"))
    scaleMovie    = movieGuard(scaleMovie, "scaleMovie", function(who, v)
        if v ~= nil and type(v) ~= 'boolean' then
            return who .. ": bad argument #2 type (autoscale as boolean is optional, got "
                .. type(v) .. "!)"
        end
    end)
end

-- Mudlet getMudletInfo() prints its diagnostic block and returns nothing at
-- all; the binding's own `nil` would make select('#', getMudletInfo()) == 1.
do
    local _rawGetMudletInfo = getMudletInfo
    function getMudletInfo()
        _rawGetMudletInfo()
    end
end

-- Mudlet insertHTML(text) — a thin alias for insertText(). The name (and the
-- wiki) promise the markup is rendered, but upstream hands the text straight
-- through, so it lands as literal characters; upstream's own spec marks that
-- pending rather than pinning it as the contract, and mudix matches the
-- behaviour rather than the name.
function insertHTML(text)
    text = __mudix_check_string(text, "insertHTML", 1, "text")
    insertText(text)
end

-- Mudlet getProcessID() — the OS process id, used by scripts that shell out or
-- name a temp file after the running client. A browser tab has no pid, so this
-- answers a stable per-tab number instead: unique among the tabs this browser
-- has open, constant for the life of this one, and positive, which is every
-- property a script can actually rely on.
do
    local id = __mudix_processId()
    function getProcessID()
        return id
    end
end

-- ── send / raiseGlobalEvent argument contracts ─────────────────────────────
do
    -- Mudlet registers send() from its C++ sendRaw(), which is the name its
    -- own complaints use — so a script grepping for the message finds the same
    -- text it would on the desktop.
    local _rawSend = send
    function send(...)
        local n = select('#', ...)
        local text, echo = ...
        if type(text) ~= 'string' and type(text) ~= 'number' then
            error("sendRaw: bad argument #1 type (command as string expected, got "
                .. (n < 1 and 'no value' or type(text)) .. "!)", 2)
        end
        if n > 1 and echo ~= nil and type(echo) ~= 'boolean' then
            error("sendRaw: bad argument #2 type (show on screen as boolean is optional, got "
                .. type(echo) .. "!)", 2)
        end
        return _rawSend(...)
    end

    -- Consumed by the next send; reports nothing, so a caller cannot mistake a
    -- return value for confirmation that something was actually blocked.
    local _rawDeny = denyCurrentSend
    function denyCurrentSend()
        _rawDeny()
    end

    -- The event name is checked before anything is packed, so a refusal cannot
    -- strand a half-built event.
    local _rawRaiseGlobalEvent = raiseGlobalEvent
    function raiseGlobalEvent(...)
        if select('#', ...) < 1 then
            error("raiseGlobalEvent: missing argument #1 (eventName as string expected!)", 2)
        end
        local n = select('#', ...)
        local args = { ... }
        for i = 1, n do
            local v = args[i]
            local t = type(v)
            if t ~= 'string' and t ~= 'number' and t ~= 'boolean' and t ~= 'nil' then
                error("raiseGlobalEvent: bad argument type #" .. i
                    .. " (boolean, number, string or nil expected, got " .. t .. "!)", 2)
            end
            if i == 1 then
                if t == 'number' then
                    args[1] = string.format('%.17g', v)
                elseif t == 'boolean' then
                    args[1] = v and '1' or '0'
                end
            end
        end
        return _rawRaiseGlobalEvent(unpack(args, 1, n))
    end
end

-- ── Button state ───────────────────────────────────────────────────────────
-- setButtonState/getButtonState take a button by name OR by item ID, and Mudlet
-- has a different answer for each way of getting it wrong. They are all here
-- rather than in JS because the wordings are the contract — a script branches on
-- "is not a push-down button" quite differently from "no button ... found" — and
-- because only Lua can return the (nil, msg) pair they use to say so.
--
-- An item ID never resolves here: mudix identifies stored items by uuid, so a
-- number can only ever be a miss. The refusal it earns is still Mudlet's, since
-- a script that kept an ID from somewhere deserves to be told what happened to
-- it rather than to be handed a nil.
do
    local function buttonTarget(who, ref, argIndex)
        local t = type(ref)
        if t == 'number' then
            if ref < 0 then
                return nil, "item ID as number must be equal or greater than zero, got " .. tostring(ref)
            end
            return nil, "no button item with ID " .. string.format("%d", ref) .. " found"
        end
        if t ~= 'string' then
            error(who .. ": bad argument #" .. argIndex .. " type (button name as string or item ID as"
                .. " number expected, got " .. t .. "!)", 3)
        end
        if ref == '' then
            return nil, "item name must not be an empty string"
        end
        local kind = __mudix_button_kind(ref)
        if kind == 'missing' then
            return nil, "no button item with name '" .. ref .. "' found"
        end
        if kind ~= 'pushdown' then
            return nil, "item with name '" .. ref .. "' is not a push-down button"
        end
        return ref
    end

    function getButtonState(...)
        -- With no argument at all this is a different question: Mudlet answers
        -- the console's own mButtonState, which is 1 or 2 rather than a boolean
        -- and which only a real click writes. Nothing here can click, so it
        -- stays at the "not pressed" end.
        if select('#', ...) == 0 then return 1 end
        local name, err = buttonTarget("getButtonState", ..., 1)
        if not name then return nil, err end
        return __getButtonState(name) and true or false
    end

    function setButtonState(ref, state, ...)
        if select('#', ...) > 0 or (state ~= nil and type(state) ~= 'boolean') then
            error("setButtonState: bad argument #2 type (state as boolean expected, got "
                .. type(state) .. "!)", 2)
        end
        local name, err = buttonTarget("setButtonState", ref, 1)
        if not name then return nil, err end
        -- false means "it was already like that", not "that did not work" — the
        -- caller has already been told the name is good by getting this far.
        return __setButtonState(name, state and true or false)
    end
end

-- ── Button style sheet and toolbar visibility ──────────────────────────────
-- Same split as the button state above: the type is a raise, the miss is a
-- reported value, and the wording is the contract.
do
    local _rawSetButtonStyleSheet = setButtonStyleSheet
    function setButtonStyleSheet(name, css)
        name = __mudix_check_string(name, "setButtonStyleSheet", 1, "button name")
        css = __mudix_check_string(css, "setButtonStyleSheet", 2, "style sheet")
        if _rawSetButtonStyleSheet(name, css) then return true end
        return nil, "no button named '" .. name .. "' found"
    end

    -- Both answer `true` when they moved a toolbar and (nil, errMsg) when they
    -- did not: a name that is no toolbar, or one that names a floating toolbar,
    -- which these do not move. (They used to answer nothing at all, so a typo
    -- was silent — see ActionUnit::setToolBarActive.)
    local _rawShowToolBar, _rawHideToolBar = showToolBar, hideToolBar
    function showToolBar(name)
        name = __mudix_check_string(name, "showToolBar", 1, "toolbar name")
        local err = _rawShowToolBar(name)
        if err ~= nil then return nil, err end
        return true
    end

    function hideToolBar(name)
        name = __mudix_check_string(name, "hideToolBar", 1, "toolbar name")
        local err = _rawHideToolBar(name)
        if err ~= nil then return nil, err end
        return true
    end
end

-- ── Package/module argument contracts ──────────────────────────────────────
-- Every one of these takes a name or a path, and each used to answer a wrong
-- type the same way it answers a name that simply is not installed — so a script
-- that passed a table by mistake was told "no such module" and went looking for
-- the module. Mudlet raises on the type and reports the miss separately, which
-- is the difference between a typo in your code and a typo in your data.
--
-- Applied here, at the end, so each wraps the function's final definition
-- whatever else in this file has already re-wrapped it.
do
    local function guardName(fn, who, what)
        return function(name, ...)
            name = __mudix_check_string(name, who, 1, what)
            return fn(name, ...)
        end
    end
    -- name plus an optional field: the field is only checked when given, since
    -- calling with just the name asks for the whole table.
    local function guardNameAndKey(fn, who, what)
        return function(name, key, ...)
            name = __mudix_check_string(name, who, 1, what)
            if key ~= nil then key = __mudix_check_string(key, who, 2, "field name") end
            return fn(name, key, ...)
        end
    end
    local function guardNameKeyValue(fn, who, what)
        return function(name, key, value, ...)
            name = __mudix_check_string(name, who, 1, what)
            key = __mudix_check_string(key, who, 2, "field name")
            value = __mudix_check_string(value, who, 3, "value")
            return fn(name, key, value, ...)
        end
    end

    uninstallPackage  = guardName(uninstallPackage,  "uninstallPackage",  "package name")
    installModule     = guardName(installModule,     "installModule",     "module location")
    uninstallModule   = guardName(uninstallModule,   "uninstallModule",   "module name")
    reloadModule      = guardName(reloadModule,      "reloadModule",      "module name")
    enableModuleSync  = guardName(enableModuleSync,  "enableModuleSync",  "module name")
    disableModuleSync = guardName(disableModuleSync, "disableModuleSync", "module name")
    getModuleSync     = guardName(getModuleSync,     "getModuleSync",     "module name")
    getModulePath     = guardName(getModulePath,     "getModulePath",     "module name")
    getModulePriority = guardName(getModulePriority, "getModulePriority", "module name")

    getPackageInfo = guardNameAndKey(getPackageInfo, "getPackageInfo", "package name")
    getModuleInfo  = guardNameAndKey(getModuleInfo,  "getModuleInfo",  "module name")

    setPackageInfo = guardNameKeyValue(setPackageInfo, "setPackageInfo", "package name")
    setModuleInfo  = guardNameKeyValue(setModuleInfo,  "setModuleInfo",  "module name")

    do
        local _raw = setModulePriority
        function setModulePriority(name, priority, ...)
            name = __mudix_check_string(name, "setModulePriority", 1, "module name")
            priority = __mudix_check_number(priority, "setModulePriority", 2, "priority")
            return _raw(name, priority, ...)
        end
    end
end

-- ── Filesystem-facing argument contracts ───────────────────────────────────
-- Each of these takes a path and used to shrug a wrong one off as a plain
-- false, which reads as "the file wasn't there" rather than "you passed a
-- table". Mudlet raises on the type and reports the miss separately, so a
-- script can tell the two apart.
do
    local _rawAddFileWatch = addFileWatch
    function addFileWatch(path)
        path = __mudix_check_string(path, "addFileWatch", 1, "path")
        if _rawAddFileWatch(path) then return true end
        return nil, 'path "' .. tostring(path) .. '" does not exist'
    end

    -- Plain false for a path nobody is watching: unlike addFileWatch there is
    -- nothing to explain, and "it wasn't watched" is the answer, not an error.
    local _rawRemoveFileWatch = removeFileWatch
    function removeFileWatch(path)
        path = __mudix_check_string(path, "removeFileWatch", 1, "path")
        return _rawRemoveFileWatch(path) and true or false
    end

    local _rawUnzipAsync = unzipAsync
    function unzipAsync(zipPath, destination)
        zipPath = __mudix_check_string(zipPath, "unzipAsync", 1, "zip file path")
        destination = __mudix_check_string(destination, "unzipAsync", 2, "extraction path")
        return _rawUnzipAsync(zipPath, destination)
    end

    local _rawLoadReplay = loadReplay
    function loadReplay(fileName)
        fileName = __mudix_check_string(fileName, "loadReplay", 1, "replay file name")
        if fileName == "" then
            return nil, "a blank string is not a valid replay file name"
        end
        return _rawLoadReplay(fileName)
    end
    loadRawFile = loadReplay

    local _rawSetProfileIcon = setProfileIcon
    function setProfileIcon(path)
        path = __mudix_check_string(path, "setProfileIcon", 1, "icon file path")
        if path == "" then
            return nil, "a blank string is not a valid icon file path"
        end
        return _rawSetProfileIcon(path)
    end
end

-- Mudlet setMergeTables(...) takes any number of GMCP module names, and names
-- each bad one by the position it was passed in.
do
    local _rawSetMergeTables = setMergeTables
    function setMergeTables(...)
        local n = select('#', ...)
        local args = { ... }
        for i = 1, n do
            local v = __mudix_str(args[i])
            if v == nil then
                error("setMergeTables: bad argument #" .. i .. " type (module name as string expected, got "
                    .. type(args[i]) .. "!)", 2)
            end
            args[i] = v
        end
        return _rawSetMergeTables(unpack(args, 1, n))
    end
end

-- ── Session logging ────────────────────────────────────────────────────────
-- Mudlet startLogging(on) → (ok, message, path, state) / appendLog(text).
-- The state code is what tells a change from a no-op — 1 started, 0 stopped,
-- -1 already on, -2 already off — and the two "already" cases answer nil, so a
-- caller can tell "I turned it on" from "it was already on".
function startLogging(state)
    if type(state) ~= 'boolean' then
        error("startLogging: bad argument #1 type (turn logging on/off as boolean expected, got "
            .. type(state) .. "!)", 2)
    end
    local r = __startLogging(state)
    return (r.ok and true or nil), r.message, r.path, r.state
end

-- Returns nothing at all, as Mudlet does: whether the text reached a log is not
-- something the caller is told, only whether logging was on when it asked.
function appendLog(text)
    text = __mudix_check_string(text, "appendLog", 1, "text")
    __appendLog(text)
end

-- ── Desktop-facing argument contracts ──────────────────────────────────────
-- These reach a browser tab, a notification, the physical keyboard or the error
-- console, so what they do can't be asserted from a script — but what they
-- refuse can, and Mudlet checks its arguments before it reaches any of them.
-- A silent no-op on a mistyped argument is the failure mode worth closing here:
-- it looks like the desktop simply ignored the call.
do
    local function typeGuard(fn, who, argno, want, describe)
        return function(...)
            local v = select(argno, ...)
            local t = type(v)
            -- Lua coerces both ways: a number is accepted wherever Mudlet uses
            -- luaL_checkstring/lua_isstring, and a numeric string wherever it
            -- uses lua_isnumber.
            local ok = (t == want)
                or (want == 'string' and t == 'number')
                or (want == 'number' and t == 'string' and tonumber(v) ~= nil)
            if not ok then
                error(who .. ": bad argument #" .. argno .. " type (" .. describe
                    .. " expected, got " .. (select('#', ...) < argno and 'no value' or t) .. "!)", 2)
            end
            return fn(...)
        end
    end

    openWebPage = typeGuard(openWebPage, "openWebPage", 1, 'string', 'url as string')
    showNotification = typeGuard(showNotification, "showNotification", 1, 'string', 'title as string')
    holdingModifiers = typeGuard(holdingModifiers, "holdingModifiers", 1, 'number', 'modifier as number')
    -- Innermost guard checks last, so the later argument is wrapped first and a
    -- call with nothing at all is told about #1 rather than #2.
    showHandlerError = typeGuard(showHandlerError, "showHandlerError", 2, 'string', 'error message as string')
    showHandlerError = typeGuard(showHandlerError, "showHandlerError", 1, 'string', 'event name as string')

    -- showNotification's third argument is optional, so it is only type-checked
    -- when it was actually passed.
    local _rawShowNotification = showNotification
    function showNotification(...)
        local n = select('#', ...)
        local args = { ... }
        if n > 2 then
            local expiry = __mudix_num(args[3])
            if expiry == nil then
                error("showNotification: bad argument #3 type (expiry time as number expected, got "
                    .. type(args[3]) .. "!)", 2)
            end
            args[3] = expiry
        end
        return _rawShowNotification(unpack(args, 1, n))
    end
end

-- ── Command-line tab-completion blacklist ──────────────────────────────────
-- Mudlet addCmdLineBlacklist([cmdLineName,] word) / removeCmdLineBlacklist(...) /
-- clearCmdLineBlacklist([cmdLineName]). The optional leading name works the way
-- the rest of the command-line family's does; naming one that isn't there is a
-- refusal, not a silent write to the main bar.
--
-- The mandatory word is located at the END of the argument list, which is why
-- the zero-argument call needs its own check: Mudlet used to read it at
-- lua_gettop(L), and with no arguments that index is the first free stack slot,
-- so the type check ran against whatever the previous call had left behind and a
-- leftover string blacklisted itself (upstream #9683, covered by UI_spec).
do
    local function cmdLineMissing(name)
        if name == nil or name == 'main' then return nil end
        if __windowType(name) == 'commandline' then return nil end
        return 'command line "' .. tostring(name) .. '" not found'
    end

    local function blacklistWord(who, n, a, b)
        if n < 1 then
            error(who .. ": bad argument #1 type (suggestion text as string expected, got no value!)", 3)
        end
        local word = (n > 1) and b or a
        local t = type(word)
        if t ~= 'string' and t ~= 'number' then
            error(who .. ": bad argument #" .. n .. " type (suggestion text as string expected, got "
                .. t .. "!)", 3)
        end
        return tostring(word), (n > 1) and a or nil
    end

    function addCmdLineBlacklist(...)
        local n = select('#', ...)
        local a, b = ...
        local word, name = blacklistWord("addCmdLineBlacklist", n, a, b)
        local err = cmdLineMissing(name)
        if err then return nil, err end
        __addCmdLineBlacklist(name, word)
    end

    function removeCmdLineBlacklist(...)
        local n = select('#', ...)
        local a, b = ...
        local word, name = blacklistWord("removeCmdLineBlacklist", n, a, b)
        local err = cmdLineMissing(name)
        if err then return nil, err end
        __removeCmdLineBlacklist(name, word)
    end

    function clearCmdLineBlacklist(cmdLineName)
        local err = cmdLineMissing(cmdLineName)
        if err then return nil, err end
        __clearCmdLineBlacklist(cmdLineName)
    end

    -- Mudlet get/setSaveCommandHistory([cmdLineName][, save]) — whether THIS
    -- command line's history is written out. The profile-wide
    -- `commandLineHistorySaveSize` is checked first and short-circuits both:
    -- at zero nothing is saved anywhere, so the per-line switch is neither read
    -- nor writable, and both say so in the same words.
    local GLOBAL_OFF = "disabled by profile global preference"

    local function historyLines()
        local n = getConfig("commandLineHistorySaveSize")
        return type(n) == 'number' and n or 0
    end

    function getSaveCommandHistory(cmdLineName)
        if historyLines() == 0 then return false, GLOBAL_OFF end
        local err = cmdLineMissing(cmdLineName)
        if err then return nil, err end
        local saving = __getSaveCommandHistory(cmdLineName) and true or false
        if not saving then return false, "disabled" end
        return true, "enabled (" .. tostring(historyLines()) .. " lines will be saved)"
    end

    -- Both defaults sit outside the argument handling: setSaveCommandHistory()
    -- and setSaveCommandHistory(name) each turn saving ON, so neither belongs
    -- inside a branch on how many arguments there were.
    function setSaveCommandHistory(...)
        if historyLines() == 0 then return nil, GLOBAL_OFF end
        local n = select('#', ...)
        local a, b = ...
        local name, save = nil, true
        if n > 0 then
            if type(a) == 'string' then
                name = a
                if n > 1 then
                    if type(b) ~= 'boolean' then
                        error("setSaveCommandHistory: bad argument #2 type (save command history as"
                            .. " boolean is optional, got " .. type(b) .. "!)", 2)
                    end
                    save = b
                end
            elseif type(a) == 'boolean' then
                save = a
            else
                error("setSaveCommandHistory: bad argument #1 type (command line name as string or"
                    .. " save history as boolean is optional, got " .. type(a) .. "!)", 2)
            end
        end
        local err = cmdLineMissing(name)
        if err then return nil, err end
        __setSaveCommandHistory(name, save)
        return true
    end
end

-- Mudlet showUnzipProgress() — an internal hook the package installer used to
-- call. Upstream emptied it out and kept the name bound so an old package that
-- still calls it gets told, rather than dying on a nil global.
function showUnzipProgress()
    return nil, "removed command, this function is now inactive and does nothing"
end

-- ── Profile description accessors ──────────────────────────────────────────
-- Mudlet getProfileInformation([profileName]) / setProfileInformation([profileName,]
-- text) / clearProfileInformation([profileName]). Each names a profile, defaulting
-- to this one. The JS side answers nil/false for a name no profile has; the
-- refusal matters as much as the write, because in Mudlet the setter's write path
-- creates whatever folder it is handed and a stray folder there reads as a
-- profile in the connection dialog.
do
    local function checkName(who, name, argno)
        local t = type(name)
        if t ~= 'nil' and __mudix_str(name) == nil then
            error(who .. ": bad argument #" .. argno .. " type (profile name as string expected, got "
                .. t .. "!)", 3)
        end
        if name == "" then
            return nil, who .. ": profile name cannot be empty"
        end
        return name, nil
    end

    local function missing(name)
        return "profile '" .. tostring(name) .. "' does not exist"
    end

    function getProfileInformation(profileName)
        local name, err = checkName("getProfileInformation", profileName, 1)
        if err then return nil, err end
        local info = __getProfileInformation(name)
        if info == nil then return nil, missing(profileName) end
        return info
    end

    -- One argument is the text for this profile; two name the profile first.
    -- Mudlet checks the text with getVerifiedString either way, so which
    -- argument number the complaint cites depends on the form used.
    function setProfileInformation(...)
        local n = select('#', ...)
        local a, b = ...
        if n < 2 then
            if type(a) ~= 'string' and type(a) ~= 'number' then
                error("setProfileInformation: bad argument #1 type (text as string expected, got "
                    .. type(a) .. "!)", 2)
            end
            if __setProfileInformation(tostring(a)) then return true end
            return nil, missing(getProfileName())
        end
        local name, err = checkName("setProfileInformation", a, 1)
        if err then return nil, err end
        if type(b) ~= 'string' and type(b) ~= 'number' then
            error("setProfileInformation: bad argument #2 type (text as string expected, got "
                .. type(b) .. "!)", 2)
        end
        if __setProfileInformation(tostring(b), name) then return true end
        return nil, missing(a)
    end

    function clearProfileInformation(profileName)
        local name, err = checkName("clearProfileInformation", profileName, 1)
        if err then return nil, err end
        if __clearProfileInformation(name) then return true end
        return nil, missing(profileName)
    end
end

-- ── User spell-check dictionary ────────────────────────────────────────────
-- Mudlet keeps two dictionaries: a *system* one (Hunspell plus the downloaded
-- language files) and a per-profile *user* one the player adds words to. There
-- is no Hunspell in a browser tab, so the system half stays unavailable and says
-- so in Mudlet's own words — every caller already has to handle that, since a
-- desktop Mudlet with no language files installed answers the same way.
--
-- The user half is just a word list, so it is real here: stored in the profile
-- at `profile.dic` in Hunspell's own format (a count line, then one word per
-- line, sorted) — the same path and format desktop Mudlet uses, so a linked
-- profile folder round-trips between the two.
do
    local SYSTEM_UNAVAILABLE_CHECK = "no main dictionaries found: Mudlet has not been able to find"
        .. " any dictionary files to use so is unable to check your word"
    local SYSTEM_UNAVAILABLE_SUGGEST = "no main dictionaries found: Mudlet has not been able to find"
        .. " any dictionary files to use so is unable to make suggestions for your word"

    local function dictPath()
        return getMudletHomeDir() .. "/profile.dic"
    end

    -- → sorted array of words, plus a set for membership. A missing file is an
    -- empty dictionary, not an error: Mudlet creates it on first use too.
    local function readDict()
        local words, set = {}, {}
        local f = io.open(dictPath(), "r")
        if not f then return words, set end
        local first = true
        for line in f:lines() do
            -- Hunspell's leading count line is metadata, not a word.
            if first then
                first = false
            else
                local word = line:gsub("%s+$", "")
                if word ~= "" and not set[word] then
                    set[word] = true
                    words[#words + 1] = word
                end
            end
        end
        f:close()
        table.sort(words)
        return words, set
    end

    local function writeDict(words)
        local f = io.open(dictPath(), "w")
        if not f then return false end
        f:write(tostring(#words))
        if #words > 0 then
            f:write("\n", table.concat(words, "\n"))
        end
        f:close()
        return true
    end

    -- Mudlet raises on a missing/!string word and on a non-boolean dictionary
    -- choice, before it looks at either dictionary.
    local function checkWord(who, word)
        local t = type(word)
        if t ~= 'string' and t ~= 'number' then
            error(who .. ": bad argument #1 type (word as string expected, got " .. t .. "!)", 3)
        end
        return tostring(word)
    end

    local function checkUseUser(who, given, v)
        if given < 2 then return false end
        if type(v) ~= 'boolean' then
            error(who .. ": bad argument #2 type (check profile dictionary as boolean expected, got "
                .. type(v) .. "!)", 3)
        end
        return v
    end

    function addWordToDictionary(word)
        local w = checkWord("addWordToDictionary", word)
        local words, set = readDict()
        if set[w] then
            return nil, 'the word "' .. w .. '" already seems to be in the user dictionary'
        end
        words[#words + 1] = w
        table.sort(words)
        writeDict(words)
        return true
    end

    function removeWordFromDictionary(word)
        local w = checkWord("removeWordFromDictionary", word)
        local words, set = readDict()
        if not set[w] then
            return nil, 'the word "' .. w .. '" does not seem to be in the user dictionary'
        end
        local kept = {}
        for _, entry in ipairs(words) do
            if entry ~= w then kept[#kept + 1] = entry end
        end
        writeDict(kept)
        return true
    end

    function getDictionaryWordList()
        return (readDict())
    end

    -- Varargs, not named parameters: Mudlet only type-checks argument #2 when it
    -- was actually passed (`lua_gettop(L) > 1`), so an explicit nil has to read
    -- as "given" while omitting it reads as "system dictionary".
    function spellCheckWord(...)
        local word, useUserDictionary = ...
        local w = checkWord("spellCheckWord", word)
        local useUser = checkUseUser("spellCheckWord", select('#', ...), useUserDictionary)
        if not useUser then
            return nil, SYSTEM_UNAVAILABLE_CHECK
        end
        local _, set = readDict()
        return set[w] == true
    end

    -- Hunspell ranks its suggestions by how far they are from the word given;
    -- over a word list this small, plain Levenshtein does the same job. Anything
    -- more than two edits away is a different word, not a typo.
    local function distance(a, b)
        local la, lb = #a, #b
        if math.abs(la - lb) > 2 then return 3 end
        local prev, cur = {}, {}
        for j = 0, lb do prev[j] = j end
        for i = 1, la do
            cur[0] = i
            local ai = a:sub(i, i)
            for j = 1, lb do
                local cost = (ai == b:sub(j, j)) and 0 or 1
                local min = prev[j] + 1
                if cur[j - 1] + 1 < min then min = cur[j - 1] + 1 end
                if prev[j - 1] + cost < min then min = prev[j - 1] + cost end
                cur[j] = min
            end
            prev, cur = cur, prev
        end
        return prev[lb]
    end

    function spellSuggestWord(...)
        local word, useUserDictionary = ...
        local w = checkWord("spellSuggestWord", word)
        local useUser = checkUseUser("spellSuggestWord", select('#', ...), useUserDictionary)
        if not useUser then
            return nil, SYSTEM_UNAVAILABLE_SUGGEST
        end
        local words = readDict()
        local scored = {}
        for _, entry in ipairs(words) do
            local d = distance(w:lower(), entry:lower())
            if d > 0 and d <= 2 then scored[#scored + 1] = { word = entry, d = d } end
        end
        table.sort(scored, function(x, y)
            if x.d ~= y.d then return x.d < y.d end
            return x.word < y.word
        end)
        local out = {}
        for i = 1, math.min(#scored, 10) do out[i] = scored[i].word end
        return out
    end
end

-- Mudlet spawn(readFunction, processName [, arguments...]) — TForkedProcess.cpp's
-- startProcess. A browser tab has no subprocesses, so the start step always
-- fails; the argument checking ahead of it is real and mirrors Mudlet's order
-- exactly, so the failure a script sees is the one it would see for any binary
-- that won't launch. This used to be a silent no-op stub returning false, which
-- told a caller its process had started when nothing had.
function spawn(...)
    local n = select('#', ...)
    local argv = {...}
    if n < 2 then
        error("Need read function and process name as parameters.", 0)
    end
    if type(argv[1]) ~= 'function' then
        error("Need read function as first parameter.", 0)
    end
    -- luaL_checkstring on every argument from the program name onwards, which is
    -- why a number is accepted here: Lua coerces it, so Mudlet does too.
    for i = 2, n do
        local t = type(argv[i])
        if t ~= 'string' and t ~= 'number' then
            error("bad argument #" .. i .. " to 'spawn' (string expected, got " .. t .. ")", 0)
        end
    end
    local cwd = (type(getMudletHomeDir) == 'function' and getMudletHomeDir()) or "/"
    error("Failed to start process '" .. tostring(argv[2]) .. "': the web client cannot start"
        .. " processes. Working directory: '" .. tostring(cwd) .. "'. PATH: ''", 0)
end

-- Mudlet addSupportedTelnetOption(option) reads its argument with
-- getVerifiedInt and returns nothing at all. The binding underneath answers a
-- boolean ("newly registered"), which is mudix's own and not part of the
-- contract, so it is swallowed here — a script that saw `true` would be reading
-- something desktop Mudlet never tells it.
do
    local _raw = addSupportedTelnetOption
    function addSupportedTelnetOption(option, ...)
        __mudix_check_int(option, "addSupportedTelnetOption", 1, "option")
        _raw(option, ...)
    end
end

-- ── Map colour accessors ───────────────────────────────────────────────────
-- Mudlet reads every component with getVerifiedInt (so a wrong type raises and
-- one too large for an int over/under-flows), then refuses a value outside
-- 0-255 with warnArgumentValue's (nil, errMsg) pair. The JS binding does the
-- range check and hands back the message; the type and int-range checks live
-- here, ahead of it, in Mudlet's order.
do
    local CHANNELS = { "red", "green", "blue", "alpha" }
    local function components(funcName, count, ...)
        local out = {}
        for i = 1, count do
            out[i] = __mudix_check_int((select(i, ...)), funcName, i, CHANNELS[i])
        end
        return out
    end

    local _rawSetMapBackgroundColor = setMapBackgroundColor
    function setMapBackgroundColor(r, g, b, a)
        local n = a == nil and 3 or 4
        local c = components("setMapBackgroundColor", n, r, g, b, a)
        local err = _rawSetMapBackgroundColor(c[1], c[2], c[3], c[4])
        if err then return nil, err end
        return true
    end

    function getMapBackgroundColor()
        local t = __getMapBackgroundColor()
        return t[0], t[1], t[2], t[3]
    end

    local _rawSetMapRoomExitsColor = setMapRoomExitsColor
    function setMapRoomExitsColor(r, g, b)
        local c = components("setMapRoomExitsColor", 3, r, g, b)
        local err = _rawSetMapRoomExitsColor(c[1], c[2], c[3])
        if err then return nil, err end
        return true
    end

    function getMapRoomExitsColor()
        local t = __getMapRoomExitsColor()
        return t[0], t[1], t[2]
    end

    -- setDefaultAreaVisible(visible) takes a bool and nothing else: Mudlet reads
    -- it with getVerifiedBool, which raises for a missing or non-boolean value.
    local _rawSetDefaultAreaVisible = setDefaultAreaVisible
    function setDefaultAreaVisible(visible)
        if type(visible) ~= 'boolean' then
            error("setDefaultAreaVisible: bad argument #1 type (default area visibility as boolean"
                .. " expected, got " .. type(visible) .. "!)", 2)
        end
        return _rawSetDefaultAreaVisible(visible)
    end
end
