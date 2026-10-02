// @vitest-environment node
// Mapper API behaviour pinned against desktop Mudlet (issue #295): a map built
// entirely from Lua answered differently on desktop and on Mudlet Web.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { findPath } from '../../src/map/pathfinding';
import type { MudletRoom } from 'mudlet-map-binary-reader';

let env: TestRuntime;
beforeEach(async () => { env = await createTestRuntime(); });
afterEach(() => env.dispose());

const dirs = (from: number, to: number): unknown =>
    env.run(`getPath(${from}, ${to}); return table.concat(speedWalkDir, ",")`);

describe('getPath between two equal-cost exits into the same room', () => {
    // TMap::initGraph offers stock exits n,e,s,w,up,down,ne,se,sw,nw,in,out and
    // keeps the first; only a strictly cheaper exit replaces it.
    it.each([
        ['e', 'ne', 'e'],
        ['nw', 'se', 'se'],
        ['w', 's', 's'],
        ['up', 'ne', 'up'],
        ['out', 'in', 'in'],
        ['sw', 'down', 'down'],
    ])('exits %s + %s pick %s', (a, b, expected) => {
        env.run(`addRoom(1); addRoom(2); setExit(1, 2, "${a}"); setExit(1, 2, "${b}")`);
        expect(dirs(1, 2)).toBe(expected);
    });

    it('a strictly cheaper later exit still wins', () => {
        env.run('addRoom(1); addRoom(2); setExit(1, 2, "n"); setExit(1, 2, "out")');
        env.run('setExitWeight(1, "n", 5)');
        expect(dirs(1, 2)).toBe('out');
    });

    it('two special exits of equal weight take the alphabetically first command', () => {
        env.run('addRoom(9); addRoom(10); addSpecialExit(9, 10, "zzz"); addSpecialExit(9, 10, "aaa")');
        expect(dirs(9, 10)).toBe('aaa');
        // Case-sensitive, as a QMap of QStrings orders them.
        env.run('addRoom(11); addRoom(12); addSpecialExit(11, 12, "climb"); addSpecialExit(11, 12, "Board")');
        expect(dirs(11, 12)).toBe('Board');
    });

    it('a stock exit beats a special exit of the same cost', () => {
        env.run('addRoom(13); addRoom(14); addSpecialExit(13, 14, "a"); setExit(13, 14, "out")');
        expect(dirs(13, 14)).toBe('out');
    });

    it('stays fast on a large grid', () => {
        // 250k rooms in a 500x500 grid, every room with all four stock exits.
        const side = 500;
        const rooms = new Map<number, MudletRoom>();
        const id = (x: number, y: number) => y * side + x + 1;
        for (let y = 0; y < side; y++) {
            for (let x = 0; x < side; x++) {
                rooms.set(id(x, y), {
                    area: 1, x, y, z: 0, weight: 1,
                    north: y > 0 ? id(x, y - 1) : -1, south: y < side - 1 ? id(x, y + 1) : -1,
                    east: x < side - 1 ? id(x + 1, y) : -1, west: x > 0 ? id(x - 1, y) : -1,
                    northeast: -1, northwest: -1, southeast: -1, southwest: -1,
                    up: -1, down: -1, in: -1, out: -1,
                    mSpecialExits: {}, exitWeights: {}, exitLocks: [], stubs: [], userData: {}, doors: {},
                } as unknown as MudletRoom);
            }
        }
        const started = performance.now();
        const r = findPath(rooms, id(0, 0), id(side - 1, side - 1));
        const took = performance.now() - started;
        expect(r?.path.length).toBe(2 * (side - 1));
        expect(took).toBeLessThan(5000);
    });
});

describe('setRoomIDbyHash before addRoom', () => {
    it('keeps the hash for the room that is created afterwards', () => {
        env.run('setRoomIDbyHash(60, "hash60")');
        expect(env.run('return getRoomIDbyHash("hash60")')).toBe(60);
        expect(env.run('return (getRoomHashByID(60))')).toBe('hash60');
        env.run('addRoom(60)');
        expect(env.run('return getRoomIDbyHash("hash60")')).toBe(60);
        expect(env.run('return (getRoomHashByID(60))')).toBe('hash60');
    });

    it('moving the hash to another id takes it off the pending one', () => {
        env.run('setRoomIDbyHash(61, "h"); addRoom(62); setRoomIDbyHash(62, "h"); addRoom(61)');
        expect(env.run('return getRoomIDbyHash("h")')).toBe(62);
        expect(env.run('return (getRoomHashByID(61))')).toBe(null);
        expect(env.run('return (getRoomHashByID(62))')).toBe('h');
    });

    it('re-hashing a pending id drops its old hash', () => {
        env.run('setRoomIDbyHash(63, "old"); setRoomIDbyHash(63, "new")');
        expect(env.run('return getRoomIDbyHash("old")')).toBe(-1);
        expect(env.run('return getRoomIDbyHash("new")')).toBe(63);
    });
});

describe('fractional numbers are truncated like getVerifiedInt', () => {
    beforeEach(() => {
        env.run('local a = addAreaName("Frac"); for i = 21, 26 do addRoom(i, a) end');
    });

    it('room coordinates', () => {
        env.run('setRoomCoordinates(21, 2.5, 3.9, -0.5)');
        expect(env.run('local x, y, z = getRoomCoordinates(21); return x .. "," .. y .. "," .. z')).toBe('2,3,0');
        expect(env.run('local r = getRoomsByPosition(getRoomArea(21), 2, 3, 0); return r[0]')).toBe(21);
        expect(env.run('local r = getRoomsByPosition(getRoomArea(21), 2.7, 3.2, 0.9); return r[0]')).toBe(21);
    });

    it('room weight and the path weight through it', () => {
        env.run('setRoomWeight(22, 2.5); setExit(21, 22, "e")');
        expect(env.run('return getRoomWeight(22)')).toBe(2);
        expect(env.run('local ok, w = getPath(21, 22); return w')).toBe(2);
        expect(env.run('getPath(21, 22); return speedWalkWeight[1]')).toBe('2');
    });

    it('exit weight', () => {
        env.run('setExit(24, 25, "e"); setExitWeight(24, "e", 1.5)');
        expect(env.run('return getExitWeights(24).e')).toBe(1);
    });

    it('room ids', () => {
        expect(env.run('return roomExists(25.5)')).toBe(true);
        expect(env.run('return (getRoomName(25.5))')).toBe('');
        env.run('setRoomName(26.9, "Six")');
        expect(env.run('return (getRoomName(26))')).toBe('Six');
        env.run('setExit(21.2, 22.8, "w")');
        expect(env.run('return getRoomExits(21).west')).toBe(22);
        expect(env.run('return (getPath(21.4, 22.6))')).toBe(true);
    });
});

describe('getRoomUserDataKeys', () => {
    it('returns the keys sorted, case-sensitively', () => {
        env.run('addRoom(20); setRoomUserData(20, "zz", "1"); setRoomUserData(20, "aa", "2"); setRoomUserData(20, "B", "3")');
        expect(env.run('return table.concat(getRoomUserDataKeys(20), ",")')).toBe('B,aa,zz');
    });
});

describe('setDoor', () => {
    beforeEach(() => {
        env.run('addRoom(27); addRoom(28); setExit(27, 28, "e")');
    });

    it('treats a long direction name as a special exit and leaves the stock door alone', () => {
        expect(env.run('return (setDoor(27, "e", 3))')).toBe(true);
        expect(env.run('local ok, err = setDoor(27, "east", 1); return tostring(ok) .. "|" .. err'))
            .toMatch(/^nil\|.*roomID 27 does not have a special exit in direction 'east'$/);
        expect(env.run('return getDoors(27).e')).toBe(3);
    });

    it('matches the short names case-sensitively and takes a number as its string', () => {
        expect(env.run('return select(2, setDoor(27, "E", 1))')).toMatch(/special exit in direction 'E'/);
        expect(env.run('return select(2, setDoor(27, 4, 1))')).toMatch(/special exit in direction '4'/);
        env.run('addSpecialExit(27, 28, "4")');
        expect(env.run('return (setDoor(27, 4, 2))')).toBe(true);
        expect(env.run('return getDoors(27)["4"]')).toBe(2);
        expect(env.run('return getDoors(27).e')).toBeNull();
    });

    it('answers false when the door already has that type', () => {
        expect(env.run('return (setDoor(27, "e", 2))')).toBe(true);
        expect(env.run('return (setDoor(27, "e", 2))')).toBe(false);
        expect(env.run('return (setDoor(27, "e", 0))')).toBe(true);
        expect(env.run('return (setDoor(27, "e", 0))')).toBe(false);
    });

    it('raises on a door command that is neither a string nor a number', () => {
        expect(() => env.run('setDoor(27, {}, 1)')).toThrow(/door command as string expected, got table/);
    });
});

describe('return values', () => {
    it('setExitStub and lockExit return nothing', () => {
        env.run('addRoom(30); addRoom(31); setExit(30, 31, "n")');
        expect(env.run('return select("#", setExitStub(30, "s", true))')).toBe(0);
        expect(env.run('return select("#", lockExit(30, "n", true))')).toBe(0);
        expect(env.run('return (hasExitLock(30, "n"))')).toBe(true);
        expect(env.run('return getExitStubs(30)[0]')).toBe(6);
    });
});
