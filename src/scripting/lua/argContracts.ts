/**
 * Mudlet's argument-type contracts for the C API, as data.
 *
 * Desktop Mudlet validates the arguments of its C functions up front
 * (`getVerifiedString/Int/Bool/Double`, `checkStringArg`, the `WINDOW_NAME` and
 * `CMDLINE_NAME` macros in `TLuaInterpreter*.cpp`) and RAISES
 * `"<fn>: bad argument #N type (<name> as <type> expected, got <type>!)"` on a
 * mismatch. Mudlet Web's bindings mostly coerced or answered false/nil instead,
 * so a script bug that fails loudly on desktop went unnoticed here and a
 * `pcall` guard never fired (issue #277).
 *
 * Rather than hand-edit a check into every binding, each contract below is
 * compiled once — by {@link buildArgContractLua} — into a small Lua wrapper that
 * is installed over the global right after Bridge.lua, before the bundled
 * mudlet-lua tree runs (so Geyser & co. capture the checked versions, as they
 * do on desktop). The wrapper only VALIDATES: arguments are forwarded to the
 * original binding untouched, so its existing coercion and its soft
 * `(nil, msg)` answers for missing windows/rooms stay as they were.
 *
 * Validation follows Lua 5.1's `lua_is*`, exactly like desktop:
 *   - `s` (lua_isstring)  — a string OR a number passes;
 *   - `n` / `i` (lua_isnumber) — a number OR a numeric string passes; `i`
 *     adds getVerifiedInt's 32-bit range check;
 *   - `b` (lua_isboolean) — strictly true/false.
 * Where desktop picks an optional leading window name by ARGUMENT COUNT
 * (`if (lua_gettop(L) > K)`), `win: K` does the same; desktop functions that
 * dispatch on the TYPE of an argument are written out as `custom` checkers.
 *
 * Messages are desktop's, character for character, including the C++ function
 * name where it differs from the Lua one (`clearWindow` reports as
 * `clearUserWindow`). The error is raised at the caller's line (level 2 from
 * the wrapper), as Bridge.lua's own checks are.
 *
 * Only functions where desktop really raises belong here; see the PR for #277
 * for what was left out and why.
 */

type Kind =
    | 's'   // lua_isstring
    | 'n'   // lua_isnumber (double)
    | 'i'   // lua_isnumber + int range (getVerifiedInt)
    | 'b'   // lua_isboolean
    | 'w'   // WINDOW_NAME: nil/absent ok, else lua_isstring
    | 'c'   // CMDLINE_NAME: lua_isstring
    | 'si'  // checkStringOrIntegerArg: lua_type string or number (strict)
    | 'sf'  // checkCommandOrFunctionArg: lua_isstring or a function
    | 'x';  // not checked (keeps later positions aligned)

interface Arg {
    k: Kind;
    name?: string;
    /** Desktop passes isOptional=true: the message reads "is optional". */
    opt?: boolean;
    /** Checked only when the argument is present (desktop gates on lua_gettop). */
    present?: boolean;
    /** Checked only when present and not nil (desktop gates on lua_isnoneornil). */
    nonnil?: boolean;
    /** A hand-written desktop message: `%d` is the position, `%s` the type name. */
    msg?: string;
}

interface Contract {
    args?: Arg[];
    /** When more than this many arguments are passed, #1 is a window name. */
    win?: number;
    /** How that leading name is checked; WINDOW_NAME semantics when omitted. */
    winArg?: Arg;
    /** The C++ function name desktop's messages carry, when it differs. */
    cname?: string;
    /**
     * A Lua function `(n, ...) -> errMsg|nil` for desktop functions whose
     * argument layout depends on the type of an argument. It may use the
     * helpers defined in PRELUDE (M, MW, MF, MO, isS, isN).
     */
    custom?: string;
}

const s = (name: string, o: Partial<Arg> = {}): Arg => ({ k: 's', name, ...o });
const n = (name: string, o: Partial<Arg> = {}): Arg => ({ k: 'n', name, ...o });
const i = (name: string, o: Partial<Arg> = {}): Arg => ({ k: 'i', name, ...o });
const b = (name: string, o: Partial<Arg> = {}): Arg => ({ k: 'b', name, ...o });
const si = (name: string): Arg => ({ k: 'si', name });
const w = (o: Partial<Arg> = {}): Arg => ({ k: 'w', ...o });
const c = (o: Partial<Arg> = {}): Arg => ({ k: 'c', ...o });
const x: Arg = { k: 'x' };

const OPT = { opt: true };
const OPT_PRESENT = { opt: true, present: true };
const PRESENT = { present: true };

const WINDOW_ONLY: Contract = { args: [w()] };
const ROOM: Contract = { args: [i('roomID')] };
const AREA: Contract = { args: [i('areaID')] };
const LINE_BUFFER = 'mini console, user window or buffer name {may be omitted for the "main" console}';

// The colour setters that take an optional leading window name: desktop decides
// it is a name when #1 is a STRING by lua_type (setBackgroundColor and the two
// command-line colour setters), and reports a bad #1 under setBackgroundColor's
// name for all three — a copy-paste in desktop, kept so the text matches.
const backgroundColorFamily = (fn: string) => `function(n, a1, a2, a3, a4, a5)
  local o = 0
  if type(a1) == 'string' then
    if not isN(a2) then return M('${fn}', 2, 'red value 0-255', 'number', a2, n) end
    o = 1
  elseif not isN(a1) then
    return MF('setBackgroundColor: bad argument #%d type (window name as string, or red value 0-255 as number expected, got %s!)', 1, a1, n)
  end
  local g, bl, al
  if o == 1 then g, bl, al = a3, a4, a5 else g, bl, al = a2, a3, a4 end
  if not isN(g) then return M('${fn}', 2 + o, 'green value 0-255', 'number', g, n) end
  if not isN(bl) then return M('${fn}', 3 + o, 'blue value 0-255', 'number', bl, n) end
  if n > 3 + o and not isN(al) then return M('${fn}', 4 + o, 'alpha value 0-255', 'number', al, n, true) end
end`;

// echoPopup/insertPopup([window,] text, {commands}, {hints} [, useCurrentFormat]).
// Desktop: a window name is present when there are more than four arguments, or
// exactly four and the fourth is not a boolean. The table items themselves are
// left to the binding.
const popup = (fn: string) => `function(n, ...)
  local hasWin = n > 4 or (n == 4 and type((select(4, ...))) ~= 'boolean')
  local hasFmt = n > 4 or (n == 4 and type((select(4, ...))) == 'boolean')
  local o = 0
  if hasWin then
    local v = (...)
    if not isS(v) then return M('${fn}', 1, 'window name', 'string', v, n) end
    o = 1
  end
  local text, cmds, hints, fmt = select(o + 1, ...)
  if not isS(text) then return M('${fn}', 1 + o, 'text', 'string', text, n) end
  if type(cmds) ~= 'table' then return M('${fn}', 2 + o, 'commands/functions', 'table', cmds, n) end
  if type(hints) ~= 'table' then return M('${fn}', 3 + o, 'hints', 'table', hints, n) end
  if hasFmt and type(fmt) ~= 'boolean' then return M('${fn}', 4 + o, 'useCurrentFormat', 'boolean', fmt, n) end
end`;

const labelCallback = (fn: string): Contract => ({
    custom: `function(n, a1, a2)
  if not isS(a1) then return M('${fn}', 1, 'label name', 'string', a1, n) end
  if (n < 2 or a2 ~= nil) and type(a2) ~= 'function' then
    return MF('${fn}: bad argument #2 type (function or nil expected, got %s!)', 2, a2, n)
  end
end`,
});

const attribute = (what: string): Contract => ({ win: 1, args: [b(`enable ${what} attribute`)] });

export const ARG_CONTRACTS: Record<string, Contract> = {
    // ── Text, cursor and selection ────────────────────────────────────────
    selectString: { win: 2, args: [s('text to select'), i('match count {1 for first}')] },
    selectSection: { win: 2, args: [i('from position'), i('length')] },
    selectCurrentLine: WINDOW_ONLY,
    selectCaptureGroup: {
        args: [s('', { msg: 'selectCaptureGroup: bad argument #%d type (capture group as number or capture group name as string expected, got %s!)' })],
    },
    deselect: WINDOW_ONLY,
    getSelection: WINDOW_ONLY,
    replace: { win: 1, args: [s('with')] },
    insertText: { win: 1, args: [s('text')] },
    moveCursor: { win: 2, args: [i('x'), i('y')] },
    moveCursorEnd: WINDOW_ONLY,
    deleteLine: WINDOW_ONLY,
    getLines: { win: 2, winArg: s(LINE_BUFFER, OPT), args: [i('start line'), i('end line')] },
    getLineNumber: WINDOW_ONLY,
    getLineCount: WINDOW_ONLY,
    getLastLineNumber: WINDOW_ONLY,
    getColumnNumber: WINDOW_ONLY,
    getCurrentLine: WINDOW_ONLY,
    getTimestamp: { win: 1, winArg: s(LINE_BUFFER), args: [i('line number')] },
    copy: WINDOW_ONLY,
    paste: WINDOW_ONLY,
    appendBuffer: WINDOW_ONLY,
    createBuffer: { args: [s('name')] },
    getTextFormat: { args: [s('window name', OPT_PRESENT)] },

    // ── Formatting ────────────────────────────────────────────────────────
    setFgColor: { win: 3, args: [i('red component value'), i('green component value'), i('blue component value')] },
    setBgColor: {
        custom: `function(n, a1, a2, a3, a4, a5)
  local o = 0
  if isS(a1) and not isN(a1) then
    if not isN(a2) then return MF('setBgColor: bad argument #%d type (red value 0-255 as number expected, got %s!)', 2, a2, n) end
    o = 1
  elseif not isN(a1) then
    return MF('setBgColor: bad argument #%d type (window name as string, or red value 0-255 as number expected, got %s!)', 1, a1, n)
  end
  local g, bl, al
  if o == 1 then g, bl, al = a3, a4, a5 else g, bl, al = a2, a3, a4 end
  if not isN(g) then return M('setBgColor', 2 + o, 'green value 0-255', 'number', g, n) end
  if not isN(bl) then return M('setBgColor', 3 + o, 'blue value 0-255', 'number', bl, n) end
  if n > 3 + o and not isN(al) then return M('setBgColor', 4 + o, 'alpha value 0-255', 'number', al, n, true) end
end`,
    },
    setBold: attribute('bold'),
    setItalics: attribute('italic'),
    setOverline: attribute('overline'),
    setReverse: attribute('reverse'),
    setStrikeOut: attribute('strikeout'),
    setUnderline: attribute('underline'),
    resetFormat: WINDOW_ONLY,
    setLink: {
        win: 2,
        args: [{ k: 'sf', msg: 'setLink: bad argument #%d type (command as string or function expected, got %s!)' }, s('tooltip')],
    },
    echoPopup: { custom: popup('echoPopup') },
    insertPopup: { custom: popup('insertPopup') },

    // ── Windows ───────────────────────────────────────────────────────────
    clearUserWindow: { args: [s('window name', OPT_PRESENT)] },
    clearWindow: { cname: 'clearUserWindow', args: [s('window name', OPT_PRESENT)] },
    setFont: { win: 1, args: [s('name')] },
    getFont: WINDOW_ONLY,
    setFontSize: { win: 1, args: [i('size')] },
    setWindowWrap: { win: 1, args: [i('wrapAt')] },
    setMiniConsoleFontSize: { cname: 'setFontSize', win: 1, args: [i('size')] },
    getFontSize: WINDOW_ONLY,
    getWindowWrap: WINDOW_ONLY,
    setWindowWrapIndent: { args: [w(), i('wrapTo')] },
    setWindowWrapHangingIndent: { args: [w(), i('wrapTo')] },
    raiseWindow: WINDOW_ONLY,
    lowerWindow: WINDOW_ONLY,
    getUserWindowSize: WINDOW_ONLY,
    getWindowGeometry: { args: [s('window name')] },
    windowVisible: { args: [s('window name')] },
    windowType: { args: [s('window name')] },
    getFgColor: { args: [s('window name', OPT_PRESENT)] },
    getBgColor: { args: [s('window name', OPT_PRESENT)] },
    getBackgroundColor: { args: [s('window name', PRESENT)] },
    getConsoleBufferSize: WINDOW_ONLY,
    enableScrollBar: WINDOW_ONLY,
    disableScrollBar: WINDOW_ONLY,
    getScrollBarVisible: WINDOW_ONLY,
    enableHorizontalScrollBar: WINDOW_ONLY,
    disableHorizontalScrollBar: WINDOW_ONLY,
    enableScrolling: WINDOW_ONLY,
    disableScrolling: WINDOW_ONLY,
    scrollingActive: WINDOW_ONLY,
    enableClickthrough: WINDOW_ONLY,
    disableClickthrough: WINDOW_ONLY,
    enableTimeStamps: WINDOW_ONLY,
    disableTimeStamps: WINDOW_ONLY,
    timeStampsEnabled: WINDOW_ONLY,
    getColumnCount: WINDOW_ONLY,
    getRowCount: WINDOW_ONLY,
    setBorderColor: { args: [i('red'), i('green'), i('blue')] },
    setBorderSizes: {
        custom: `function(n, a1, a2, a3, a4)
  local names
  if n == 0 then return
  elseif n == 1 then names = { 'new size' }
  elseif n == 2 then names = { 'new height', 'new width' }
  elseif n == 3 then names = { 'new top size', 'new width', 'new bottom size' }
  else names = { 'new top size', 'new right size', 'new bottom size', 'new left size' } end
  local v = { a1, a2, a3, a4 }
  for p = 1, #names do
    if not isN(v[p]) then return M('setBorderSizes', p, names[p], 'number', v[p], n) end
  end
end`,
    },
    calcFontSize: {
        custom: `function(n, a1, a2)
  if n == 2 then
    if not isN(a1) then return M('calcFontSize', 1, 'font size', 'number', a1, n) end
    if not isS(a2) then return M('calcFontSize', 2, 'font name', 'string', a2, n) end
  elseif not (n == 1 and isN(a1)) and n >= 1 and a1 ~= nil and not isS(a1) then
    return MW('calcFontSize', 1, 'window', a1, n)
  end
end`,
    },
    scrollTo: {
        custom: `function(n, a1, a2)
  if n == 2 then
    if not isS(a1) then return M('scrollTo', 1, 'window name', 'string', a1, n, true) end
    if not isN(a2) then return M('scrollTo', 2, 'line to scroll to', 'number', a2, n) end
  elseif n == 1 and not isN(a1) and not isS(a1) then
    return M('scrollTo', 1, 'window name', 'string', a1, n, true)
  end
end`,
    },
    getScroll: {
        custom: `function(n, a1)
  if n == 1 and not isS(a1) then return M('getScroll', 1, 'window name', 'string', a1, n, true) end
end`,
    },
    setBackgroundColor: { custom: backgroundColorFamily('setBackgroundColor') },
    setCommandBackgroundColor: { custom: backgroundColorFamily('setCommandBackgroundColor') },
    setCommandForegroundColor: { custom: backgroundColorFamily('setCommandForegroundColor') },
    setBackgroundImage: {
        custom: `function(n, a1, a2, a3, a4, a5)
  local hasName = n > 1 and type(a2) == 'string'
  local v = { a1, a2, a3, a4, a5 }
  local p = 1
  if hasName then
    if not isS(a1) then return M('setBackgroundImage', 1, 'console or label name', 'string', a1, n) end
    p = 2
  end
  if not isS(v[p]) then return M('setBackgroundImage', p, 'image path', 'string', v[p], n) end
  p = p + 1
  if p <= n then
    if not isN(v[p]) then return M('setBackgroundImage', p, 'mode', 'number', v[p], n) end
    p = p + 1
  end
  if p <= n and type(v[p]) ~= 'boolean' then return M('setBackgroundImage', p, 'fullWindow', 'boolean', v[p], n) end
end`,
    },
    resetBackgroundImage: {
        custom: `function(n, a1, a2)
  local p, v = 1, a1
  if n > 0 and type(a1) == 'string' then p, v = 2, a2 end
  if p <= n and type(v) ~= 'boolean' then return M('resetBackgroundImage', p, 'fullWindow', 'boolean', v, n) end
end`,
    },

    // ── Labels, miniconsoles, text edits, command lines ───────────────────
    deleteLabel: { args: [s('label name')] },
    deleteMiniConsole: { args: [s('miniconsole name')] },
    deleteCommandLine: { args: [s('command line name')] },
    deleteTextEdit: { args: [s('text edit name')] },
    deleteScrollBox: { args: [s('scrollbox name')] },
    getTextEditText: { args: [s('text edit name')] },
    setTextEditText: { args: [s('text edit name'), s('text')] },
    clearTextEdit: { args: [s('text edit name')] },
    setTextEditReadOnly: { args: [s('text edit name'), b('read only state')] },
    setTextEditPlaceholder: { args: [s('text edit name'), s('placeholder text')] },
    setTextEditStyleSheet: { args: [s('text edit name'), s('stylesheet')] },
    setTextEditFont: { args: [s('text edit name'), s('font name')] },
    setTextEditFontSize: { args: [s('text edit name'), i('font size')] },
    setTextEditTabMovesFocus: { args: [s('text edit name'), b('tab moves focus state')] },
    setLabelToolTip: { args: [s('label name'), s('text'), n('duration', PRESENT)] },
    setLabelStyleSheet: { args: [s('label name'), s('stylesheet')] },
    getLabelStyleSheet: { args: [s('label')] },
    getLabelSizeHint: { args: [s('label name')] },
    getLabelText: { args: [s('label name')] },
    setLabelClickCallback: labelCallback('setLabelClickCallback'),
    setLabelDoubleClickCallback: labelCallback('setLabelDoubleClickCallback'),
    setLabelReleaseCallback: labelCallback('setLabelReleaseCallback'),
    setLabelMoveCallback: labelCallback('setLabelMoveCallback'),
    setLabelWheelCallback: labelCallback('setLabelWheelCallback'),
    setLabelOnEnter: labelCallback('setLabelOnEnter'),
    setLabelOnLeave: labelCallback('setLabelOnLeave'),
    setLinkStyle: { args: [s('label name'), s('link color', OPT), s('link visited color', OPT), b('underline', OPT_PRESENT)] },
    resetLinkStyle: { args: [s('label name')] },
    clearVisitedLinks: { args: [s('label name')] },
    getImageSize: { args: [s('image location')] },
    getCmdLineStyleSheet: { args: [s('command line name', { nonnil: true })] },
    enableCommandLine: { args: [c()] },
    disableCommandLine: { args: [c()] },
    clearCmdLine: { args: [c(PRESENT)] },
    getCmdLine: { args: [c(PRESENT)] },
    clearCmdLineBlacklist: { args: [c(PRESENT)] },
    getSaveCommandHistory: { args: [c(PRESENT)] },
    addCommandLineMenuEvent: { win: 2, winArg: s('command line name'), args: [s('menu label'), s('event name')] },
    removeCommandLineMenuEvent: { win: 1, winArg: s('command line name'), args: [s('menu label')] },
    tempButtonToolbar: { args: [s('name'), i('location'), i('orientation')] },
    tempButton: { args: [s('toolbar name'), s('button text'), i('orientation')] },
    addMouseEvent: { args: [s('uniquename'), s('event name')] },
    removeMouseEvent: { args: [s('event name')] },
    openMapWidget: {
        custom: `function(n, a1, a2, a3, a4)
  if n == 1 then
    if type(a1) ~= 'string' then return MF('openMapWidget: bad argument #%d type (area as string expected, got %s!)', 1, a1, n) end
    return
  end
  if n > 1 then
    if not isN(a1) then return M('openMapWidget', 1, 'x-coordinate', 'number', a1, n) end
    if not isN(a2) then return M('openMapWidget', 2, 'y-coordinate', 'number', a2, n) end
  end
  if n > 2 then
    if not isN(a3) then return M('openMapWidget', 3, 'width', 'number', a3, n) end
    if not isN(a4) then return M('openMapWidget', 4, 'height', 'number', a4, n) end
  end
end`,
    },

    // ── Triggers, aliases, keys and other items ───────────────────────────
    enableTrigger: { args: [s('name')] },
    disableTrigger: { args: [s('name')] },
    killTrigger: { args: [s('ID')] },
    enableAlias: { args: [s('name')] },
    disableAlias: { args: [s('name')] },
    killAlias: { args: [s('name')] },
    enableKey: { args: [s('key name')] },
    disableKey: { args: [s('key name')] },
    killKey: { args: [s('key name')] },
    exists: { args: [si('itemID or item name'), s('item type')] },
    isActive: { args: [si('item name or ID'), s('item type'), b('also check ancestors', OPT_PRESENT)] },

    // ── Profile, config, commands, misc ───────────────────────────────────
    setConfig: { args: [s('key')] },
    getConfig: { args: [s('key')] },
    getMudletVersion: {
        custom: `function(n, a1)
  if n == 1 and not isS(a1) then return M('getMudletVersion', 1, 'style', 'string', a1, n, true) end
end`,
    },
    ttsGetQueue: { args: [i('index', PRESENT)] },
    removeCommand: { args: [i('commandId')] },
    enableCommand: { args: [i('commandId')] },
    disableCommand: { args: [i('commandId')] },
    setCommandChecked: { args: [i('commandId'), b('checked')] },
    setCommandPinned: { args: [i('commandId'), b('pinned')] },
    setCommandIcon: { args: [i('commandId'), s('icon')] },
    setCommandTooltip: { args: [i('commandId'), s('tooltip')] },
    setCommandPulse: {
        args: [i('commandId'), b('enabled'), s('color1', { nonnil: true }), s('color2', { nonnil: true }), i('interval', { nonnil: true })],
    },
    setIrcChannels: {
        custom: `function(n, a1)
  if type(a1) ~= 'table' then return MF('setIrcChannels: bad argument #%d type (channels as table expected, got %s!)', 1, a1, n) end
end`,
    },

    // ── Mapper ────────────────────────────────────────────────────────────
    addRoom: ROOM,
    deleteRoom: ROOM,
    createRoomID: { args: [i('minimum room Id', OPT_PRESENT)] },
    roomExists: ROOM,
    roomLocked: ROOM,
    getRoomName: ROOM,
    setRoomName: { args: [i('roomID'), s('room name', OPT)] },
    getRoomArea: ROOM,
    setRoomArea: {
        custom: `function(n, a1)
  if not isN(a1) and type(a1) ~= 'table' then
    return MF('setRoomArea: bad argument #%d type (roomID as number or table of roomIDs\\nexpected, got %s!)', 1, a1, n)
  end
end`,
    },
    resetRoomArea: ROOM,
    getRoomCoordinates: ROOM,
    setRoomCoordinates: { args: [i('roomID'), i('x'), i('y'), i('z')] },
    getRoomExits: ROOM,
    getRoomEnv: ROOM,
    setRoomEnv: { args: [i('roomID'), i('environmentID')] },
    getRoomWeight: { args: [i('roomID', PRESENT)] },
    setRoomWeight: { args: [i('roomID'), i('weight')] },
    getRoomHidden: { args: [i('roomID', PRESENT)] },
    setRoomHidden: { args: [i('roomID'), b('hidden')] },
    lockRoom: { args: [i('roomID'), b('lockIfTrue')] },
    getRoomChar: ROOM,
    setRoomChar: { args: [i('roomID'), s('room symbol')] },
    getRoomCharColor: ROOM,
    unsetRoomCharColor: ROOM,
    setRoomCharColor: { args: [i('roomID'), i('red component'), i('green component'), i('blue component')] },
    getRoomBorderColor: ROOM,
    clearRoomBorderColor: ROOM,
    setRoomBorderColor: { args: [i('roomID'), i('red component'), i('green component'), i('blue component'), i('alpha component', PRESENT)] },
    getRoomBorderThickness: ROOM,
    clearRoomBorderThickness: ROOM,
    setRoomBorderThickness: { args: [i('roomID'), i('thickness')] },
    getRoomHashByID: ROOM,
    getRoomIDbyHash: { args: [s('hash')] },
    setRoomIDbyHash: { args: [i('roomID'), s('hash')] },
    getRoomUserData: { args: [i('roomID'), s('key'), b('enableFullErrorReporting {default = false}', OPT_PRESENT)] },
    setRoomUserData: { args: [i('roomID'), s('key'), s('value')] },
    clearRoomUserData: ROOM,
    clearRoomUserDataItem: { args: [i('roomID'), s('key')] },
    getRoomUserDataKeys: ROOM,
    getAllRoomUserData: ROOM,
    searchRoomUserData: { args: [s('key', OPT_PRESENT), s('value', OPT_PRESENT)] },
    getAllRoomEntrances: ROOM,
    gotoRoom: { args: [i('target roomID')] },
    centerview: { args: [i('roomID'), i('view id', OPT_PRESENT)] },
    highlightRoom: {
        // Desktop also requires both alpha values; the bundled mapper always
        // passes them, but Mudlet Web documented them as optional, so an
        // absent pair is still left to the binding.
        args: [
            i('roomID'), i('color1Red'), i('color1Green'), i('color1Blue'),
            i('color2Red'), i('color2Green'), i('color2Blue'), n('highlightRadius'),
            i('color1Alpha', PRESENT), i('color2Alpha', PRESENT),
        ],
    },
    unHighlightRoom: ROOM,
    // Desktop checks #2 (and #3) only once the room is known to exist, so only
    // the room ID is a raise-on-type here; the binding answers for the rest.
    addSpecialExit: { args: [i('exit roomID')] },
    removeSpecialExit: { args: [i('exit roomID')] },
    getSpecialExits: { args: [i('exit roomID')] },
    getSpecialExitsSwap: {
        args: [n('', { msg: 'getSpecialExitsSwap: bad argument #%d type (exit roomID as number expected, got %s!)' })],
    },
    clearSpecialExits: ROOM,
    lockExit: {
        args: [
            i('roomID'),
            s('', { msg: 'lockExit: bad argument #%d type (direction as number or string expected, got %s!)' }),
            b('lockIfTrue'),
        ],
    },
    setExitStub: {
        args: [
            i('roomID'),
            s('', { msg: 'setExitStub: bad argument #%d type (direction as number or string expected, got %s!)' }),
            b('set/unset'),
        ],
    },
    lockSpecialExit: { args: [i('exit roomID'), x, s('special exit name/command'), b('special exit lock state')] },
    hasSpecialExitLock: { args: [i('exit roomID'), x, s('special exit name/command')] },
    getExitStubs: ROOM,
    getExitStubs1: ROOM,
    getExitStubsNames: ROOM,
    setExitWeight: ROOM,
    getExitWeights: ROOM,
    setDoor: ROOM,
    getDoors: ROOM,
    removeCustomLine: ROOM,
    getCustomLines: { args: [i('room id')] },
    getCustomLines1: { args: [i('room id')] },
    getAreaRooms: AREA,
    getAreaRooms1: AREA,
    getAreaExits: { args: [i('areaID'), b('full data wanted', OPT_PRESENT)] },
    getRoomsByPosition: { args: [i('areaID'), i('x'), i('y'), i('z')] },
    getRoomsByPosition1: { args: [i('areaID'), i('x'), i('y'), i('z')] },
    getGridMode: AREA,
    setGridMode: { args: [i('areaID'), b('true/false')] },
    addAreaName: { args: [s('area name')] },
    deleteArea: {
        args: [s('', { msg: 'deleteArea: bad argument #%d type (area Id as number or area name as string\nexpected, got %s!)' })],
    },
    getCollisionLocationsInArea: AREA,
    getAreaUserData: { args: [i('areaID'), s('key')] },
    setAreaUserData: { args: [i('areaID'), s('key'), s('value')] },
    getAllAreaUserData: AREA,
    clearAreaUserData: AREA,
    clearAreaUserDataItem: { args: [i('areaID'), s('key')] },
    searchAreaUserData: { args: [s('key', OPT_PRESENT), s('value', OPT_PRESENT)] },
    getMapUserData: { args: [s('key')] },
    setMapUserData: { args: [s('key'), s('value')] },
    clearMapUserDataItem: { args: [s('key')] },
    setCustomEnvColor: {
        args: [i('environmentID'), i('red color component'), i('green color component'), i('blue color component'), i('alpha color component', OPT_PRESENT)],
    },
    getMapLabels: AREA,
    deleteMapLabel: { args: [i('areaID'), i('labelID')] },
    createMapImageLabel: {
        args: [
            i('areaID'), s('imagePathFileName'), n('posX'), n('posY'), n('posZ'),
            n('width'), n('height'), n('zoom'), b('showOnTop'),
            // Desktop's message calls the tenth argument showOnTop too, though
            // it is the temporary flag.
            b('showOnTop', OPT_PRESENT),
        ],
    },
    setMapZoom: { args: [n('zoom'), i('area id', OPT_PRESENT), i('view id', OPT_PRESENT)] },
    getMapZoom: { args: [i('area id', OPT_PRESENT), i('view id', OPT_PRESENT)] },
    createMapView: { args: [i('area id', OPT_PRESENT)] },
    closeMapView: { args: [i('view id')] },
    getMapViewInfo: { args: [i('view id')] },
    addMapEvent: { args: [s('uniquename'), s('event name')] },
    removeMapEvent: { args: [s('event name')] },
    addMapMenu: { args: [s('uniquename')] },
    removeMapMenu: { args: [s('Menu name')] },
    getMapMenus: { args: [b('key by unique name', { opt: true, nonnil: true })] },
    killMapInfo: { args: [s('label')] },
    enableMapInfo: { args: [s('label')] },
    disableMapInfo: { args: [s('label')] },
    setMapWindowTitle: { args: [s('title', OPT_PRESENT)] },
    exportAreaImage: {
        custom: `function(n, a1, a2, a3)
  if n >= 1 and a1 ~= nil and not isN(a1) then return M('exportAreaImage', 1, 'areaID', 'number', a1, n) end
  if not isS(a2) then return M('exportAreaImage', 2, 'file path', 'string', a2, n) end
  if n > 2 and type(a3) ~= 'boolean' and not isN(a3) then return M('exportAreaImage', 3, 'z level', 'number', a3, n, true) end
end`,
    },
};

const TYPE_NAME: Partial<Record<Kind, string>> = { s: 'string', n: 'number', i: 'number', b: 'boolean', si: 'string or integer' };

// Helpers shared by every generated wrapper. Each builds a message — the
// wrapper raises it, at level 2, so the error points at the caller's line.
// luaL_typename reports an argument past the top of the stack as "no value",
// which is what `p > n` stands for here.
const PRELUDE = `local type, tonumber, tostring, select, error, rawget = type, tonumber, tostring, select, error, rawget
local function tn(v, p, n) if p > n then return 'no value' end return type(v) end
local function M(fn, p, what, tname, v, n, opt)
  return fn .. ': bad argument #' .. p .. ' type (' .. what .. ' as ' .. tname
    .. (opt and ' is optional, got ' or ' expected, got ') .. tn(v, p, n) .. '!)'
end
local function MW(fn, p, kind, v, n)
  return fn .. ': bad argument #' .. p .. ' type (' .. kind .. ' name as string expected, got ' .. tn(v, p, n) .. ')!'
end
local function MF(fmt, p, v, n)
  local t = tn(v, p, n)
  return (fmt:gsub('%%([ds])', function(k) if k == 'd' then return tostring(p) end return t end))
end
local function MO(fn, p, what, v)
  return fn .. ': integer over/under-flow in argument #' .. p .. ' (' .. what
    .. ' as an integer, provided value ' .. tostring(v) .. ' is outside of valid range -2147483648 to 2147483647!)'
end
local function isS(v) local t = type(v) return t == 'string' or t == 'number' end
local function isN(v) return tonumber(v) ~= nil end
`;

const luaStr = (str: string) => JSON.stringify(str);

/**
 * Lua statements that raise when `v` (at position expression `p`) breaks `arg`.
 * The argument count is read only on the failure path (and for a `present`
 * check), so a passing call does not pay for `select('#', ...)`.
 */
function checkLua(fn: string, arg: Arg, v: string, p: string): string {
    const N = "select('#', ...)";
    const what = luaStr(arg.name ?? '');
    const tname = luaStr(TYPE_NAME[arg.k] ?? '');
    const opt = arg.opt ? 'true' : 'false';
    const fail = arg.msg
        ? `error(MF(${luaStr(arg.msg)}, ${p}, ${v}, ${N}), 2)`
        : `error(M(${luaStr(fn)}, ${p}, ${what}, ${tname}, ${v}, ${N}, ${opt}), 2)`;
    let body: string;
    switch (arg.k) {
        case 'x':
            return '';
        case 's':
        case 'si': {
            body = `do local t = type(${v}) if t ~= 'string' and t ~= 'number' then ${fail} end end`;
            break;
        }
        case 'sf':
            body = `do local t = type(${v}) if t ~= 'string' and t ~= 'number' and t ~= 'function' then ${fail} end end`;
            break;
        case 'n':
            body = `if type(${v}) ~= 'number' and not isN(${v}) then ${fail} end`;
            break;
        case 'i':
            body = `do local x = ${v} if type(x) ~= 'number' then if not isN(x) then ${fail} end x = tonumber(x) end`
                + ` if x >= 2147483648 or x <= -2147483649 then error(MO(${luaStr(fn)}, ${p}, ${what}, ${v}), 2) end end`;
            break;
        case 'b':
            body = `if type(${v}) ~= 'boolean' then ${fail} end`;
            break;
        case 'w':
            body = `if ${v} ~= nil then local t = type(${v}) if t ~= 'string' and t ~= 'number' then error(MW(${luaStr(fn)}, ${p}, 'window', ${v}, ${N}), 2) end end`;
            break;
        case 'c':
            body = `do local t = type(${v}) if t ~= 'string' and t ~= 'number' then error(MW(${luaStr(fn)}, ${p}, 'command line', ${v}, ${N}), 2) end end`;
            break;
    }
    if (arg.nonnil) return `if ${v} ~= nil then ${body} end`;
    if (arg.present) return `if ${N} >= ${p} then ${body} end`;
    return body;
}

function wrapperLua(name: string, contract: Contract): string {
    const fn = contract.cname ?? name;
    const lines: string[] = [];
    if (contract.custom) {
        lines.push(`local chk = ${contract.custom}`);
        lines.push(`_G[${luaStr(name)}] = function(...)`);
        lines.push(`  local err = chk(select('#', ...), ...)`);
        lines.push(`  if err then error(err, 2) end`);
        lines.push(`  return f(...)`);
        lines.push(`end`);
        return lines.join('\n');
    }
    const args = contract.args ?? [];
    const m = args.length;
    const as = args.map((_, k) => `a${k + 1}`);
    lines.push(`_G[${luaStr(name)}] = function(...)`);
    if (contract.win === undefined) {
        if (m) lines.push(`  local ${as.join(', ')} = ...`);
        args.forEach((arg, k) => {
            const code = checkLua(fn, arg, as[k], String(k + 1));
            if (code) lines.push(`  ${code}`);
        });
    } else {
        const xs = Array.from({ length: m + 1 }, (_, k) => `x${k}`);
        const winArg = contract.winArg ?? w();
        lines.push(`  local ${xs.join(', ')} = ...`);
        lines.push(`  local n = select('#', ...)`);
        lines.push(`  local o${m ? ', ' + as.join(', ') : ''}`);
        lines.push(`  if n > ${contract.win} then`);
        lines.push(`    ${checkLua(fn, winArg, 'x0', '1')}`);
        lines.push(`    o = 1${m ? `; ${as.join(', ')} = ${xs.slice(1).join(', ')}` : ''}`);
        lines.push(`  else`);
        lines.push(`    o = 0${m ? `; ${as.join(', ')} = ${xs.slice(0, m).join(', ')}` : ''}`);
        lines.push(`  end`);
        args.forEach((arg, k) => {
            const code = checkLua(fn, arg, as[k], `(${k + 1} + o)`);
            if (code) lines.push(`  ${code}`);
        });
    }
    lines.push(`  return f(...)`);
    lines.push(`end`);
    return lines.join('\n');
}

/**
 * One Lua chunk that wraps every global named in {@link ARG_CONTRACTS} that
 * exists when it runs. A missing global is skipped, not created.
 */
export function buildArgContractLua(): string {
    const parts = [`do\n${PRELUDE}`];
    for (const [name, contract] of Object.entries(ARG_CONTRACTS)) {
        parts.push(`do local f = rawget(_G, ${luaStr(name)}) if type(f) == 'function' then\n${wrapperLua(name, contract)}\nend end`);
    }
    parts.push('end');
    return parts.join('\n');
}
