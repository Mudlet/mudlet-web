// @vitest-environment node
// Mapper API behaviour pinned against desktop Mudlet (issue #235): each block is
// one place where Mudlet Web answered differently from a side-by-side desktop run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

let env: TestRuntime;
beforeEach(async () => { env = await createTestRuntime(); });
afterEach(() => env.dispose());

describe('numeric-string room and area ids', () => {
    // Desktop's getVerifiedInt takes "9201"; ids from GMCP or a regex capture
    // usually arrive as strings.
    beforeEach(() => {
        env.run('local a = addAreaName("VA"); addRoom(9201); setRoomArea(9201, a); setRoomName(9201, "Start")');
    });

    it('roomExists and getRoomName find the room', () => {
        expect(env.run('return roomExists("9201")')).toBe(true);
        expect(env.run('return (getRoomName("9201"))')).toBe('Start');
    });

    it('setRoomName, setRoomEnv/getRoomEnv and setRoomWeight act on the room', () => {
        expect(env.run('return (setRoomName("9201", "Renamed"))')).toBe(true);
        expect(env.run('return (getRoomName(9201))')).toBe('Renamed');
        expect(env.run('return (setRoomEnv("9201", 5))')).toBe(true);
        expect(env.run('return getRoomEnv("9201")')).toBe(5);
        expect(env.run('return (setRoomWeight("9201", 7))')).toBe(true);
        expect(env.run('return getRoomWeight(9201)')).toBe(7);
    });

    it('getSpecialExits answers for the room rather than reporting it missing', () => {
        env.run('addRoom(9202); addSpecialExit(9201, 9202, "pull lever")');
        expect(env.run('return getSpecialExits("9201")[9202]["pull lever"]')).toBe('0');
    });

    it('getRoomHashByID and setRoomIDbyHash take the string form', () => {
        env.run('setRoomIDbyHash("9201", "h1")');
        expect(env.run('return (getRoomHashByID("9201"))')).toBe('h1');
    });

    it('deleteRoom removes the room', () => {
        expect(env.run('return deleteRoom("9201")')).toBe(true);
        expect(env.run('return roomExists(9201)')).toBe(false);
    });

    it('getRoomAreaName treats a numeric string as an area id, not a name', () => {
        const a = env.run('return getRoomArea(9201)') as number;
        expect(env.run(`return (getRoomAreaName("${a}"))`)).toBe('VA');
        expect(env.run('return select(2, getRoomAreaName("98765"))'))
            .toBe('getRoomAreaName: number 98765 is not a valid area id');
        // A name still resolves as one.
        expect(env.run('return (getRoomAreaName("VA"))')).toBe(a);
    });

    it('setAreaName and deleteArea take the string form of an area id', () => {
        const a = env.run('return getRoomArea(9201)') as number;
        expect(env.run(`return (setAreaName("${a}", "VB"))`)).toBe(true);
        expect(env.run(`return (getRoomAreaName(${a}))`)).toBe('VB');
        expect(env.run(`return (deleteArea("${a}"))`)).toBe(true);
        expect(env.run('return roomExists(9201)')).toBe(false);
    });
});

describe('setRoomIDbyHash moves the hash', () => {
    it('takes it off the room that had it', () => {
        env.run('addRoom(9502); addRoom(9501); setRoomIDbyHash(9502, "hh"); setRoomIDbyHash(9501, "hh")');
        expect(env.run('return getRoomIDbyHash("hh")')).toBe(9501);
        expect(env.run('return (getRoomHashByID(9501))')).toBe('hh');
        expect(env.run('return (getRoomHashByID(9502))')).toBe(null);
    });

    it('keeps the new owner through a save and reload', () => {
        env.run('addRoom(9502); addRoom(9501); setRoomIDbyHash(9502, "hh"); setRoomIDbyHash(9501, "hh")');
        const store = env.api.map;
        const json = store.toJsonString();
        expect(store.loadFromJsonString(json)).toBe(true);
        expect(store.getRoomIDbyHash('hh')).toBe(9501);
        expect(store.getRoomHashByID(9502)).toBeUndefined();
    });
});

describe('map labels', () => {
    const create = (a: number, text: string) =>
        env.run(`return createMapLabel(${a}, "${text}", 1, 1, 0, 1, 2, 3, 4, 5, 6)`) as number;

    it('hands out the lowest free label id, reusing deleted ones', () => {
        const a = env.run('return (addAreaName("L"))') as number;
        expect([create(a, 'a'), create(a, 'b'), create(a, 'c')]).toEqual([0, 1, 2]);
        env.run(`deleteMapLabel(${a}, 0); deleteMapLabel(${a}, 1)`);
        expect(create(a, 'd')).toBe(0);
        expect(create(a, 'e')).toBe(1);
        expect(create(a, 'f')).toBe(3);
    });

    it('deleteArea takes the area\'s labels with it', () => {
        const z = env.run('return (addAreaName("Z1"))') as number;
        create(z, 'Stale');
        expect(env.run(`return (deleteArea(${z}))`)).toBe(true);
        env.run(`setAreaName(${z}, "Z2")`);
        expect(env.run(`return table.size(getMapLabels(${z}))`)).toBe(0);
        expect(env.api.map.toMudletJsonString()).not.toContain('Stale');
    });
});

describe('getRoomCharColor', () => {
    beforeEach(() => { env.run('addRoom(1)'); });

    it('reads 0,0,0 for a room that never had a colour', () => {
        expect(env.run('local r, g, b = getRoomCharColor(1); return r + g + b')).toBe(0);
        expect(env.run('return select("#", getRoomCharColor(1))')).toBe(3);
    });

    it('reads a colour that was set, and 255,255,255 once it is unset', () => {
        env.run('setRoomCharColor(1, 10, 20, 30)');
        expect(env.run('local r, g, b = getRoomCharColor(1); return string.format("%d,%d,%d", r, g, b)'))
            .toBe('10,20,30');
        env.run('unsetRoomCharColor(1)');
        expect(env.run('local r, g, b = getRoomCharColor(1); return string.format("%d,%d,%d", r, g, b)'))
            .toBe('255,255,255');
        env.run('setRoomCharColor(1, 1, 2, 3)');
        expect(env.run('local r, g, b = getRoomCharColor(1); return string.format("%d,%d,%d", r, g, b)'))
            .toBe('1,2,3');
    });

    it('answers nil and a message for a missing room', () => {
        expect(env.run('local r, err = getRoomCharColor(404); return r == nil and type(err) == "string"'))
            .toBe(true);
    });
});

describe('getMapEvents arguments', () => {
    it('stores every argument as a string, as desktop\'s QStringList does', () => {
        env.run('addMapEvent("E", "ev", "", "Disp", 42, true, "s", 1.5)');
        expect(env.run('return type(getMapEvents()["E"].arguments[1])')).toBe('string');
        expect(env.run('return getMapEvents()["E"].arguments[1]')).toBe('42');
        expect(env.run('return getMapEvents()["E"].arguments[2]')).toBe('');
        expect(env.run('return getMapEvents()["E"].arguments[3]')).toBe('s');
        expect(env.run('return getMapEvents()["E"].arguments[4]')).toBe('1.5');
        expect(env.run('return #getMapEvents()["E"].arguments')).toBe(4);
    });
});

describe('return shapes', () => {
    it('getMapSelection is an empty table when nothing is selected', () => {
        // Desktop needs the mapper widget before it reports a selection at all.
        expect(env.run('local s, e = getMapSelection() return tostring(s) .. "|" .. e')).toBe('nil|no map present or loaded');
        env.run('openMapWidget()');
        expect(env.run('return next(getMapSelection())')).toBe(null);
        env.run('addRoom(1)');
        env.api.map.selectMapRoom(1);
        expect(env.run('return getMapSelection().rooms[1]')).toBe(1);
    });

    it('getCustomLines points are x and y only; getCustomLines1 carries the room\'s z', () => {
        env.run('addRoom(1); setRoomCoordinates(1, 0, 0, 4); addRoom(2); setExit(1, 2, "e")');
        env.run('addCustomLine(1, {{1, 2, 4}}, "e", "solid line", {255, 0, 0}, false)');
        expect(env.run('return getCustomLines(1).e.points[0].x')).toBe(1);
        expect(env.run('return getCustomLines(1).e.points[0].z')).toBe(null);
        expect(env.run('return getCustomLines1(1).e.points[1][3]')).toBe(4);
    });
});
