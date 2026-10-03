// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ARG_CONTRACTS } from '../../src/scripting/lua/argContracts';

/**
 * Issue #277: desktop Mudlet's C API raises "bad argument" on a wrongly typed
 * argument where Mudlet Web used to answer false/nil or act anyway. The
 * contracts in src/scripting/lua/argContracts.ts restore the raise; these pin
 * desktop's wording (TLuaInterpreter*.cpp) and the coercion it allows.
 */

/** pcall(chunk) → the error message, or null when it did not raise. */
function raised(t: TestRuntime, chunk: string): string | null {
    return t.run(`local ok, err = pcall(function() ${chunk} end)
        if ok then return nil end
        return tostring(err)`) as string | null;
}

/** Desktop names the C++ function, which is not always the Lua one. */
const MESSAGE_NAME: Record<string, string> = {
    clearWindow: 'clearUserWindow',
    setMiniConsoleFontSize: 'setFontSize',
    setCommandBackgroundColor: 'setBackgroundColor',
    setCommandForegroundColor: 'setBackgroundColor',
};

/** A table is a valid first argument for these — to the C function, or to the
 *  bundled mudlet-lua wrapper in front of it (GUIUtils' replace, Other.lua's
 *  setConfig/getConfig), on desktop just as here. */
const TABLE_OK = new Set(['setRoomArea', 'setIrcChannels', 'replace', 'setConfig', 'getConfig']);

describe('argument contracts (#277)', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t?.dispose());

    describe('every contracted function raises on a table where desktop does', () => {
        const names = Object.keys(ARG_CONTRACTS).filter(n => !TABLE_OK.has(n));
        it.each(names)('%s({})', (name) => {
            const err = raised(t, `${name}({})`);
            expect(err, `${name} did not raise`).not.toBeNull();
            expect(err).toContain(`${MESSAGE_NAME[name] ?? name}: bad argument #1`);
        });
    });

    it.each([
        ['getRoomName("abc")', 'getRoomName: bad argument #1 type (roomID as number expected, got string!)'],
        ['enableTrigger(nil)', 'enableTrigger: bad argument #1 type (name as string expected, got nil!)'],
        ['isActive({}, "trigger")', 'isActive: bad argument #1 type (item name or ID as string or integer expected, got table!)'],
        ['setFgColor("red")', 'setFgColor: bad argument #1 type (red component value as number expected, got string!)'],
        ['selectString("a", "b")', 'selectString: bad argument #2 type (match count {1 for first} as number expected, got string!)'],
        ['selectString("x")', 'selectString: bad argument #2 type (match count {1 for first} as number expected, got no value!)'],
        ['selectString(nil, 1)', 'selectString: bad argument #1 type (text to select as string expected, got nil!)'],
        ['getLines("a", "b")', 'getLines: bad argument #1 type (start line as number expected, got string!)'],
        ['getLines()', 'getLines: bad argument #1 type (start line as number expected, got no value!)'],
        ['getLines({}, 1, 2)', 'getLines: bad argument #1 type (mini console, user window or buffer name {may be omitted for the "main" console} as string is optional, got table!)'],
        ['setBold("x")', 'setBold: bad argument #1 type (enable bold attribute as boolean expected, got string!)'],
        ['setBold("main", "x")', 'setBold: bad argument #2 type (enable bold attribute as boolean expected, got string!)'],
        ['addRoom("x")', 'addRoom: bad argument #1 type (roomID as number expected, got string!)'],
        ['setWindowWrap("main", "x")', 'setWindowWrap: bad argument #2 type (wrapAt as number expected, got string!)'],
        ['setFontSize("main", "big")', 'setFontSize: bad argument #2 type (size as number expected, got string!)'],
        ['getLineCount({})', 'getLineCount: bad argument #1 type (window name as string expected, got table)!'],
        ['enableCommandLine({})', 'enableCommandLine: bad argument #1 type (command line name as string expected, got table)!'],
        ['clearWindow(true)', 'clearUserWindow: bad argument #1 type (window name as string is optional, got boolean!)'],
        ['moveCursor("main", 1, 2^40)', 'moveCursor: integer over/under-flow in argument #3 (y as an integer, provided value'],
        ['setBgColor({})', 'setBgColor: bad argument #1 type (window name as string, or red value 0-255 as number expected, got table!)'],
        ['setBgColor("main", "x", 1, 1)', 'setBgColor: bad argument #2 type (red value 0-255 as number expected, got string!)'],
        ['setBackgroundColor("main", 1, "g", 1)', 'setBackgroundColor: bad argument #3 type (green value 0-255 as number expected, got string!)'],
        ['echoPopup("text", "notATable", {})', 'echoPopup: bad argument #2 type (commands/functions as table expected, got string!)'],
        // GUIUtils.lua puts its own check in front, on desktop too.
        ['setLabelClickCallback("lbl", 5)', 'setLabelClickCallback: bad argument #2 type (function expected, got number!)'],
        ['setLink({}, "hint")', 'setLink: bad argument #1 type (command as string or function expected, got table!)'],
        ['setRoomArea("x", 1)', 'setRoomArea: bad argument #1 type (roomID as number or table of roomIDs\nexpected, got string!)'],
        ['deleteArea({})', 'deleteArea: bad argument #1 type (area Id as number or area name as string\nexpected, got table!)'],
        ['exportAreaImage("nope", "a.png")', 'exportAreaImage: bad argument #1 type (areaID as number expected, got string!)'],
        ['getMudletVersion({})', 'getMudletVersion: bad argument #1 type (style as string is optional, got table!)'],
    ])('%s raises with desktop\'s message', (call, message) => {
        expect(raised(t, call)).toContain(message);
    });

    it('raises a Lua error rather than leaking a JavaScript one', () => {
        const err = raised(t, 'selectString(nil, 1)');
        expect(err).not.toMatch(/Cannot read properties/);
    });

    it('points the error at the caller\'s line', () => {
        expect(raised(t, 'getRoomName("abc")')).toMatch(/^\[string .*\]:\d+: getRoomName:/);
    });

    describe('coerces the way lua_isstring / lua_isnumber do', () => {
        it('takes a numeric string for a number and a number for a string', () => {
            expect(raised(t, 'getRoomName("1")')).toBeNull();
            expect(raised(t, 'selectString(123, "1")')).toBeNull();
            expect(raised(t, 'enableTrigger(42)')).toBeNull();
            expect(raised(t, 'getLines("0", "1")')).toBeNull();
        });

        it('is strict about booleans', () => {
            expect(raised(t, 'setBold(1)')).toContain('setBold: bad argument #1');
            expect(raised(t, 'setBold(true)')).toBeNull();
        });

        it('counts arguments for the optional window name, as desktop does', () => {
            // Two arguments: (text, count) — never a window name.
            expect(raised(t, 'selectString("main", 1)')).toBeNull();
            // nil in the window slot means main.
            expect(raised(t, 'selectString(nil, "x", 1)')).toBeNull();
            expect(raised(t, 'setFgColor(nil, 1, 2, 3)')).toBeNull();
        });

        it('leaves optional arguments optional', () => {
            expect(raised(t, 'clearWindow()')).toBeNull();
            expect(raised(t, 'getFgColor()')).toBeNull();
            expect(raised(t, 'getTextFormat()')).toBeNull();
            expect(raised(t, 'centerview(1)')).toBeNull();
            expect(raised(t, 'getMapMenus(nil)')).toBeNull();
        });
    });
});

describe('the soft answers desktop gives (#277)', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t?.dispose());

    it('getFont / getFontSize treat a number as a window name', () => {
        expect(t.run('local f, e = getFont(1) return tostring(f) .. "|" .. tostring(e)')).toBe('nil|window "1" not found');
        expect(t.run('local f, e = getFontSize(1) return tostring(f) .. "|" .. tostring(e)')).toBe('nil|window "1" not found');
    });

    it('getTextFormat names the window it could not find, or the invalid selection', () => {
        expect(t.run('local f, e = getTextFormat("nope") return tostring(f) .. "|" .. e')).toBe("nil|window 'nope' not found");
        t.run('clearWindow()');
        expect(t.run('local f, e = getTextFormat() return tostring(f) .. "|" .. e')).toBe("nil|current selection invalid in window ''");
        expect(t.run('local f, e = getTextFormat("main") return tostring(f) .. "|" .. e')).toBe("nil|current selection invalid in window 'main'");
        t.run('echo("format me\\n")');
        expect(t.run('return type((getTextFormat()))')).toBe('table');
    });

    it('getMapZoom and getMapSelection refuse until a mapper exists', () => {
        expect(t.run('local z, e = getMapZoom() return tostring(z) .. "|" .. e')).toBe('nil|no active mapper');
        expect(t.run('local s, e = getMapSelection() return tostring(s) .. "|" .. e')).toBe('nil|no map present or loaded');
        t.run('openMapWidget()');
        expect(t.run('return type((getMapZoom()))')).toBe('number');
        expect(t.run('return type((getMapSelection()))')).toBe('table');
    });

    it('raiseEvent answers true for any call, as desktop does', () => {
        expect(t.run('return raiseEvent({})')).toBe(true);
        expect(t.run('return raiseEvent()')).toBe(true);
    });
});
