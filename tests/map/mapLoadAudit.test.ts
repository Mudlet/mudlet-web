// @vitest-environment node
//
// The audit every map load runs — Mudlet's TMap::audit, i.e. TRoomDB::auditRooms
// followed by TRoom::audit for every room — and the repairs it makes. The busted
// corpus drives the same repairs through damaged binary files
// (MapFileAudit_spec.lua); these build the damaged map directly, which is the
// only way to reach most of these states: the mapper API refuses all of them.
import { describe, it, expect } from 'vitest';
import type { MudletArea, MudletMap, MudletRoom } from 'mudlet-map-binary-reader';
import { MapStore, makeRoom, makeArea, DEFAULT_FONT } from '../../src/map/MapStore';

function area(rooms: number[]): MudletArea {
    return { ...makeArea(), rooms, zLevels: [0] };
}

function load(map: Partial<MudletMap>): MapStore {
    const store = new MapStore();
    store.loadFromBinary({
        version: 20, envColors: {}, areaNames: {}, mCustomEnvColors: {},
        mpRoomDbHashToRoomId: {}, mUserData: {}, mapSymbolFont: DEFAULT_FONT,
        mapFontFudgeFactor: 1, useOnlyMapFont: false,
        areas: {}, mRoomIdHash: {}, labels: {}, rooms: {},
        ...map,
    });
    return store;
}

function room(areaId: number, patch: Partial<MudletRoom> = {}): MudletRoom {
    return { ...makeRoom(areaId), ...patch };
}

describe('the load audit — room ids', () => {
    it('renumbers a room below one, and its exits, area and hash follow it', () => {
        const store = load({
            areaNames: { 1: 'A' },
            areas: { 1: area([1, -7]) },
            rooms: {
                1: room(1, { east: -7 }),
                [-7]: room(1, { west: 1, name: 'bad' }),
            },
            mpRoomDbHashToRoomId: { 'bad-hash': -7 },
        });
        const renumbered = Number(Object.entries(store.getRooms()).find(([, n]) => n === 'bad')![0]);
        expect(renumbered).toBe(2);
        expect(store.getRoomUserData(renumbered, 'audit.remapped_id')).toBe('-7');
        expect(store.getRoomExits(1)?.east).toBe(renumbered);
        expect(store.getRoomUserData(1, 'audit.remapped_exit.4')).toBe('-7');
        expect(store.getRoomExits(renumbered)?.west).toBe(1);
        expect(store.getAreaRooms(1)).toEqual([1, 2]);
        expect(store.getRoomIDbyHash('bad-hash')).toBe(renumbered);
        expect(store.takeAuditIssues().some(i => i.message.includes('renumbered to: 2'))).toBe(true);
    });

    // -1 is also "no exit", so only special exits follow a room numbered -1.
    it('renumbers a room numbered -1 without giving it every absent exit on the map', () => {
        const store = load({
            areaNames: { 1: 'A' },
            areas: { 1: area([1, -1]) },
            rooms: {
                1: room(1, { mSpecialExits: { 'climb': -1 } }),
                [-1]: room(1, { west: 1 }),
            },
        });
        expect(store.getRoomExits(1)).toEqual({});
        expect(store.getSpecialExitsSwap(1)).toEqual({ climb: 2 });
        expect(store.getRoomExits(2)).toEqual({ west: 1 });
    });

    // The reader takes an area's room list, special exit destinations and the
    // hash index as unsigned, so a negative id arrives 2^32 too big.
    it('reads the unsigned forms the binary reader hands over as the ids the file meant', () => {
        const store = load({
            areaNames: { 1: 'A' },
            areas: { 1: area([1, 2 ** 32 - 7]) },
            rooms: {
                1: room(1, { mSpecialExits: { zqc: 2 ** 32 - 4 } }),
                [-7]: room(1, { name: 'bad' }),
            },
        });
        expect(store.getSpecialExitsSwap(1)).toEqual({});
        expect(store.getRoomUserData(1, 'audit.removed_invalid_special_exit.zqc')).toBe('-4');
        expect(store.getAreaRooms(1)).toEqual([1, 2]);
    });
});

describe('the load audit — areas', () => {
    it('renumbers an area below one, moving its name and its rooms', () => {
        const store = load({
            areaNames: { [-5]: 'Bad' },
            areas: { [-5]: area([1]) },
            rooms: { 1: room(-5) },
        });
        const id = store.getAreaTable().Bad;
        expect(id).toBeGreaterThanOrEqual(1);
        expect(store.getAreaRooms(id)).toEqual([1]);
        expect(store.getAreaRooms(-5)).toBeUndefined();
        expect(store.getAreaUserData(id, 'audit.remapped_id')).toBe('-5');
        expect(store.getRoomUserData(1, 'audit.remapped_area')).toBe('-5');
    });

    it('gives each room back to the area it names, whatever the areas listed', () => {
        const store = load({
            areaNames: { 1: 'Home', 2: 'Away' },
            areas: { 1: area([2]), 2: area([2, 404]) },
            rooms: { 1: room(1), 2: room(2) },
        });
        expect(store.getAreaRooms(1)).toEqual([1]);
        expect(store.getAreaRooms(2)).toEqual([2]);
    });

    it('creates the area a room is filed under when the file lacks it', () => {
        const store = load({ areaNames: {}, areas: {}, rooms: { 1: room(9) } });
        expect(store.getAreaRooms(9)).toEqual([1]);
        expect(store.getAreaTableSwap()[9]).toBe('Unnamed Area');
    });

    it('auditAreas() instantiates an area that has only a name', () => {
        const store = new MapStore();
        store.newEmptyMap();
        expect(store.setAreaName(77, 'Orphan')).toBe(true);
        expect(store.getAreaRooms(77)).toBeUndefined();
        store.auditAreas();
        expect(store.getAreaRooms(77)).toEqual([]);
        expect(store.getAreaTable().Orphan).toBe(77);
    });
});

describe('the load audit — exits', () => {
    it('turns an exit to an impossible id into a stub that keeps its door and notes its weight', () => {
        const store = load({
            areaNames: { 1: 'A' },
            areas: { 1: area([1]) },
            rooms: {
                1: room(1, {
                    east: -3, exitWeights: { e: 5 }, doors: { e: 2 },
                    customLines: { e: [[0.5, 0.5]] }, customLinesColor: { e: { spec: 1, alpha: 255, r: 1, g: 2, b: 3 } },
                    customLinesStyle: { e: 3 }, customLinesArrow: { e: false },
                }),
            },
        });
        expect(store.getRoomExits(1)).toEqual({});
        expect(store.getExitStubs(1)).toEqual([4]);
        expect(store.getRoomUserData(1, 'audit.made_stub_of_invalid_exit.4')).toBe('-3');
        expect(store.getExitWeights(1)).toEqual({});
        expect(store.getRoomUserData(1, 'audit.invalid_exit.4.weight')).toBe('5');
        expect(store.getCustomLines(1)).toEqual({});
        expect(store.getDoors(1)).toEqual({ e: 2 });
    });

    it('removes a special exit with no command, and one to an impossible id with all it carried', () => {
        const store = load({
            areaNames: { 1: 'A' },
            areas: { 1: area([1, 2]) },
            rooms: {
                1: room(1, {
                    mSpecialExits: { '': 2, zqc: -4, zqk: 2 },
                    doors: { zqc: 3 }, exitWeights: { zqc: 4 },
                }),
                2: room(1),
            },
        });
        expect(store.getSpecialExitsSwap(1)).toEqual({ zqk: 2 });
        expect(store.getRoomUserData(1, 'audit.removed_invalid_special_exit.zqc')).toBe('-4');
        expect(store.getDoors(1)).toEqual({});
        expect(store.getExitWeights(1)).toEqual({});
    });

    it('drops the door, weight and custom line of a command the room does not have', () => {
        const store = load({
            areaNames: { 1: 'A' },
            areas: { 1: area([1, 2]) },
            rooms: {
                1: room(1, {
                    mSpecialExits: { zqb: 2 },
                    doors: { zqa: 1 }, exitWeights: { zqa: 3 },
                    customLines: { zqa: [[0.5, 0.5]] }, customLinesColor: { zqa: { spec: 1, alpha: 255, r: 4, g: 5, b: 6 } },
                    customLinesStyle: { zqa: 2 }, customLinesArrow: { zqa: true },
                }),
                2: room(1),
            },
        });
        expect(store.getSpecialExitsSwap(1)).toEqual({ zqb: 2 });
        expect(store.getDoors(1)).toEqual({});
        expect(store.getExitWeights(1)).toEqual({});
        expect(store.getCustomLines(1)).toEqual({});
    });
});

describe('special exit bookkeeping', () => {
    // A special exit named like a normal one shares that exit's weight
    // (TRoom::hasExitOrSpecialExit), so removing it must leave the weight.
    it('clearSpecialExits leaves the weight of a normal exit a special exit is named after', () => {
        const store = new MapStore();
        store.newEmptyMap();
        store.addRoom(1); store.addRoom(2);
        store.setExit(1, 2, 'n');
        expect(store.setExitWeight(1, 'n', 7)).toBeNull();
        expect(store.addSpecialExit(1, 2, 'n')).toBeNull();
        store.clearSpecialExits(1);
        expect(store.getExitWeights(1)).toEqual({ n: 7 });
    });

    it('deleting the room a special exit leads to leaves that weight too', () => {
        const store = new MapStore();
        store.newEmptyMap();
        store.addRoom(1); store.addRoom(2); store.addRoom(3);
        store.setExit(1, 2, 'n');
        store.setExitWeight(1, 'n', 7);
        store.addSpecialExit(1, 3, 'n');
        store.deleteRoom(3);
        expect(store.getSpecialExitsSwap(1)).toEqual({});
        expect(store.getExitWeights(1)).toEqual({ n: 7 });
    });
});

describe('loadFromJsonString', () => {
    function jsonMap(exits: Record<string, unknown>[]): string {
        return JSON.stringify({
            formatVersion: 1,
            areas: [{
                id: 1, name: 'A',
                rooms: [
                    { id: 1, coordinates: [0, 0, 0], exits },
                    { id: 2, coordinates: [1, 0, 0], exits: [] },
                ],
            }],
            playersRoomId: { me: 2 },
        });
    }

    it('drops the lock of a special exit the audit removes, keeping the others', () => {
        const store = new MapStore();
        expect(store.loadFromJsonString(jsonMap([
            { name: 'squeeze through', exitId: 99, locked: true },
            { name: 'crawl under', exitId: 2, locked: true },
        ]))).toBe(true);
        expect(store.getSpecialExitsSwap(1)).toEqual({ 'crawl under': 2 });
        expect(store.hasSpecialExitLock(1, 'crawl under')).toBe(true);
        // a new exit reusing the command starts out unlocked, even though it
        // leads to the room a locked exit does
        expect(store.addSpecialExit(1, 2, 'squeeze through')).toBeNull();
        expect(store.hasSpecialExitLock(1, 'squeeze through')).toBe(false);
    });

    it('stores a custom line with no style or arrow as a plain solid line', () => {
        const store = new MapStore();
        store.loadFromJsonString(jsonMap([
            { name: 'east', exitId: 2, customLine: { coordinates: [[1.5, 2.5]], color24RGB: [7, 8, 9] } },
        ]));
        const saved = store.toMudletMap().rooms[1];
        expect(saved.customLinesStyle.e).toBe(1);
        expect(saved.customLinesArrow.e).toBe(false);
    });

    it('writes the player room as playersRoomId and puts it back on load', () => {
        const store = new MapStore();
        store.profileName = 'me';
        store.loadFromJsonString(jsonMap([]));
        expect(store.getPlayerRoom()).toBe(2);
        const saved = JSON.parse(store.toMudletJsonString()) as { playersRoomId: Record<string, number> };
        expect(saved.playersRoomId).toEqual({ me: 2 });
    });
});
