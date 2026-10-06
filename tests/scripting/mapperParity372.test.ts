// @vitest-environment node
// Mapper API behaviour pinned against desktop Mudlet (issue #372).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

let env: TestRuntime;
beforeEach(async () => { env = await createTestRuntime(); });
afterEach(() => env.dispose());

describe('getRoomsByPosition order', () => {
    // TArea::getRoomsByPosition sorts the ids; the order rooms joined the area
    // does not show through.
    const build = (area: string) => {
        for (const id of [17, 13, 19, 11, 15]) {
            env.run(`addRoom(${id}); setRoomArea(${id}, ${area}); setRoomCoordinates(${id}, 50, 50, 0)`);
        }
    };

    it('returns ids ascending, 0-indexed', () => {
        env.run('a = addAreaName("pos372")');
        build('a');
        expect(env.run('local t = getRoomsByPosition(a, 50, 50, 0) return t[0] .. "," .. table.concat(t, ",")'))
            .toBe('11,13,15,17,19');
    });

    it('returns ids ascending from getRoomsByPosition1', () => {
        env.run('a = addAreaName("pos372")');
        build('a');
        expect(env.run('return table.concat(getRoomsByPosition1(a, 50, 50, 0), ",")')).toBe('11,13,15,17,19');
    });

    it('stays ascending after setRoomArea moves rooms into another area', () => {
        env.run('a = addAreaName("from372"); b = addAreaName("to372")');
        build('a');
        for (const id of [19, 13, 17]) env.run(`setRoomArea(${id}, b)`);
        env.run('addRoom(12); setRoomArea(12, b); setRoomCoordinates(12, 50, 50, 0)');
        expect(env.run('return table.concat(getRoomsByPosition1(b, 50, 50, 0), ",")')).toBe('12,13,17,19');
        expect(env.run('return table.concat(getRoomsByPosition1(a, 50, 50, 0), ",")')).toBe('11,15');
    });
});

describe('getAllRoomEntrances with an exit back into the room', () => {
    it('lists the room itself for a stock self-loop', () => {
        env.run('addRoom(6); addRoom(7); setExit(6, 6, "up"); setExit(7, 6, "e")');
        expect(env.run('return table.concat(getAllRoomEntrances(6), ",")')).toBe('6,7');
    });

    it('lists the room itself for a special-exit self-loop', () => {
        env.run('addRoom(8); addRoom(9); addSpecialExit(8, 8, "spin"); setExit(9, 8, "w")');
        expect(env.run('return table.concat(getAllRoomEntrances(8), ",")')).toBe('8,9');
    });
});

describe('fractional direction numbers truncate like lua_tointeger', () => {
    it('setExit(1, 2, 4.5) sets east', () => {
        env.run('addRoom(1); addRoom(2)');
        expect(env.run('return setExit(1, 2, 4.5)')).toBe(true);
        expect(env.run('return getRoomExits(1).east')).toBe(2);
    });

    it('lockExit(3, 4.5, true) locks east', () => {
        env.run('addRoom(3); addRoom(4); setExit(3, 4, "e")');
        env.run('lockExit(3, 4.5, true)');
        expect(env.run('return hasExitLock(3, "e")')).toBe(true);
    });

    it('setExitWeight(3, 4.5, 7) weights east', () => {
        env.run('addRoom(3); addRoom(4); setExit(3, 4, "e")');
        expect(env.run('return setExitWeight(3, 4.5, 7)')).toBe(true);
        expect(env.run('return getExitWeights(3).e')).toBe(7);
    });

    it('setExitStub(5, 1.7, true) sets a north stub', () => {
        env.run('addRoom(5)');
        env.run('setExitStub(5, 1.7, true)');
        expect(env.run('local t = getExitStubs(5) return t[0] .. "|" .. tostring(t[1])')).toBe('1|nil');
    });

    it('connectExitStub(6, 7, 1.5) connects the north stub', () => {
        env.run('addRoom(6); addRoom(7); setRoomCoordinates(7, 0, 1, 0)');
        env.run('setExitStub(6, "n", true); setExitStub(7, "s", true)');
        expect(env.run('return connectExitStub(6, 7, 1.5)')).toBe(true);
        expect(env.run('return getRoomExits(6).north')).toBe(7);
        expect(env.run('return getRoomExits(7).south')).toBe(6);
    });

    it('removeCustomLine(10, 5.5) removes the west line', () => {
        env.run('addRoom(10); addRoom(11); setExit(10, 11, "w")');
        env.run('addCustomLine(10, {{-1, 0, 0}}, "w", "solid line", {255, 0, 0}, false)');
        expect(env.run('return getCustomLines(10).w ~= nil')).toBe(true);
        expect(env.run('return removeCustomLine(10, 5.5)')).toBe(true);
        expect(env.run('return getCustomLines(10).w')).toBe(null);
    });
});
