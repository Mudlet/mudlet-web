// @vitest-environment node
// Mapper behaviour pinned against desktop Mudlet PTB (issue #326).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

let env: TestRuntime;
beforeEach(async () => { env = await createTestRuntime(); });
afterEach(() => env.dispose());

describe('numeric room names and symbols are stored as strings', () => {
    beforeEach(() => {
        env.run(`
            local a = addAreaName("SR")
            for i = 1, 3 do addRoom(i) setRoomArea(i, a) setRoomCoordinates(i, i, 0, 0) end
            setRoomName(1, "Town Square") setRoomName(2, "Town Gate")
        `);
    });

    it('searchRoom still searches with a numeric-named room on the map', () => {
        env.run('setRoomName(3, 404)');
        expect(env.run(`
            local r = searchRoom("town")
            local ks = {}
            for k, v in pairs(r) do ks[#ks + 1] = k .. "=" .. v end
            table.sort(ks)
            return table.concat(ks, ",")
        `)).toBe('1=Town Square,2=Town Gate');
        expect(env.run('return searchRoom("Town Square", true, true)[1]')).toBe('Town Square');
    });

    it('getRoomName and getRooms return the string form', () => {
        env.run('setRoomName(1, 42)');
        expect(env.run('return type((getRoomName(1)))')).toBe('string');
        expect(env.run('return #getRoomName(1)')).toBe(2);
        expect(env.run('return getRoomName(1):upper()')).toBe('42');
        expect(env.run('return getRooms()[1]')).toBe('42');
        env.run('setRoomName(1, 1.5)');
        expect(env.run('return (getRoomName(1))')).toBe('1.5');
    });

    it('setRoomChar keeps a number as its Lua string form', () => {
        env.run('setRoomChar(2, 7) setRoomChar(3, 1.5)');
        expect(env.run('return (getRoomChar(2))')).toBe('7');
        expect(env.run('return (getRoomChar(3))')).toBe('1.5');
    });
});

describe('getRoomIDbyHash takes a number', () => {
    it('finds hashes filed as a string or a number', () => {
        env.run('addRoom(1) addRoom(2) setRoomIDbyHash(2, "777") setRoomIDbyHash(1, 888)');
        expect(env.run('return getRoomIDbyHash(777)')).toBe(2);
        expect(env.run('return getRoomIDbyHash("777")')).toBe(2);
        expect(env.run('return getRoomIDbyHash(888)')).toBe(1);
        expect(env.run('return getRoomIDbyHash(888.0)')).toBe(1);
        expect(env.run('return getRoomIDbyHash("888")')).toBe(1);
    });
});

describe('getSpecialExits among equal-weight commands to one room', () => {
    const dump = `
        local out = {}
        for dest, cmds in pairs(getSpecialExits(1)) do
            for cmd, lock in pairs(cmds) do out[#out + 1] = dest .. ":" .. cmd .. "=" .. lock end
        end
        table.sort(out)
        return table.concat(out, ",")
    `;

    beforeEach(() => {
        env.run('for i = 1, 4 do addRoom(i) end');
    });

    it('keeps the alphabetically last command', () => {
        env.run(`
            addSpecialExit(1, 2, "aaa")  addSpecialExit(1, 2, "zzz")
            addSpecialExit(1, 3, "zzz3") addSpecialExit(1, 3, "aaa3")
            addSpecialExit(1, 4, "mmm")  addSpecialExit(1, 4, "bbb") addSpecialExit(1, 4, "yyy")
        `);
        expect(env.run(dump)).toBe('2:zzz=0,3:zzz3=0,4:yyy=0');
        // A heavier command loses, whatever its name.
        env.run('setExitWeight(1, "zzz", 3)');
        expect(env.run(dump)).toBe('2:aaa=0,3:zzz3=0,4:yyy=0');
    });

    it('reports "push lever" over "pull lever"', () => {
        env.run('addSpecialExit(1, 2, "pull lever") addSpecialExit(1, 2, "push lever")');
        expect(env.run(dump)).toBe('2:push lever=0');
    });

    it('still lists every command with listAllExits', () => {
        env.run('addSpecialExit(1, 2, "aaa") addSpecialExit(1, 2, "zzz")');
        expect(env.run(`
            local t = getSpecialExits(1, true)[2]
            return tostring(t.aaa) .. "," .. tostring(t.zzz)
        `)).toBe('0,0');
    });
});

describe('sysMapAreaChanged after openMapWidget', () => {
    beforeEach(() => {
        env.session.windows.onRaiseEvent = (event, args) => env.rt.emitEvent(event, args);
        env.run(`
            evs = {}
            registerAnonymousEventHandler("sysMapAreaChanged", function(_, new, old)
                evs[#evs + 1] = step .. " " .. new .. "," .. old
            end)
        `);
    });

    const setup = `
        a, b = addAreaName("EVA"), addAreaName("EVB")
        for i = 1, 4 do addRoom(i) setRoomArea(i, i <= 2 and a or b) setRoomCoordinates(i, i, 0, 0) end
    `;

    it('is raised for the first centerview, not for a move within the area', () => {
        env.run(`openMapWidget() ${setup}`);
        env.run('step = "cv1" centerview(1)');
        env.run('step = "cv2" centerview(2)');
        env.run('step = "cv3" centerview(3)');
        expect(env.run('return table.concat(evs, ";")'))
            .toBe(`cv1 ${env.run('return a')},-2;cv3 ${env.run('return b')},${env.run('return a')}`);
    });

    it('is not raised without a map widget', () => {
        env.run(setup);
        env.run('step = "cv1" centerview(1)');
        env.run('step = "cv3" centerview(3)');
        expect(env.run('return #evs')).toBe(0);
    });
});
