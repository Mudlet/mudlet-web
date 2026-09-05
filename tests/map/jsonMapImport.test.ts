import { describe, it, expect } from 'vitest';
import { MapStore, mudletJsonMapToMudletMap } from '../../src/map/MapStore';

// Mudlet's saveJsonMap output, which is NOT the shape toJsonString() emits:
// areas are an ARRAY carrying their rooms nested, there is no top-level
// `rooms`, exits are {exitId, name} records, and a room's symbol is an OBJECT
// {color24RGB, text}. loadJsonMap used to reject all of that, so packages fell
// back to rebuilding the map through the Lua API — and handing that symbol
// object to setRoomChar is what painted rooms as "[LuaTable 0x… Alive]".
//
// Field shapes verified against Mudlet's src/TRoom.cpp writeJsonRoom, and
// against a real f2ce-tools map export.
const MUDLET_JSON_MAP = JSON.stringify({
    formatVersion: 1,
    areaCount: 2,
    roomCount: 3,
    labelCount: 0,
    anonymousAreaName: 'Unnamed Area',
    defaultAreaName: 'Default Area',
    mapSymbolFontDetails: 'Bitstream Vera Sans Mono,12,-1,5,50,0,0,0,0,0',
    mapSymbolFontFudgeFactor: 1,
    onlyMapSymbolFontToBeUsed: false,
    playersRoomId: { SomeProfile: 2 },
    customEnvColors: [
        { id: 257, color24RGB: [128, 0, 0] },
        { id: 258, color24RGB: [0, 128, 0] },
    ],
    areas: [
        { id: -1, name: 'Default Area', roomCount: 0, rooms: [], userData: {} },
        {
            id: 1,
            name: 'Earth',
            roomCount: 3,
            userData: { 'system.fallback_map2DZoom': '20' },
            rooms: [
                {
                    id: 1,
                    name: 'Meeting point',
                    hash: 'Sol.Earth.390',
                    environment: 272,
                    coordinates: [6, -6, 0],
                    // Stock direction plus a special exit keyed by its command,
                    // both carrying the optional per-exit attributes.
                    exits: [
                        {
                            exitId: 2, name: 'east', door: 'closed', weight: 5, locked: true,
                            customLine: {
                                color24RGB: [191, 191, 191],
                                coordinates: [[33, -8], [33, -7], [40, -7]],
                                endsInArrow: false,
                                style: 'dash line',
                            },
                        },
                        { exitId: 3, name: 'press button', weight: 7, locked: true },
                    ],
                    stubExits: [{ name: 'out', door: 'open', locked: true }],
                    userData: { fed2_num: '390' },
                },
                {
                    id: 2,
                    name: 'Launch pad',
                    hash: 'Sol.Earth.391',
                    environment: 257,
                    coordinates: [7, -6, 0],
                    // The whole point: symbol is an object, not a string.
                    symbol: { color24RGB: [255, 255, 255], text: 'S' },
                    exits: [{ exitId: 1, name: 'west' }],
                    stubExits: [],
                    locked: true,
                    userData: {},
                },
                {
                    id: 3,
                    name: 'Orbit',
                    environment: 258,
                    coordinates: [0, 0, 1],
                    symbol: { color24RGB: [255, 128, 0], text: 'O' },
                    exits: [],
                    stubExits: [{ name: 'down' }],
                    hidden: true,
                    userData: {},
                },
            ],
        },
    ],
});

const load = (): MapStore => {
    const store = new MapStore();
    expect(store.loadFromJsonString(MUDLET_JSON_MAP)).toBe(true);
    return store;
};

describe('loadJsonMap — Mudlet saveJsonMap format', () => {
    it('accepts the format at all (it used to return false)', () => {
        expect(new MapStore().loadFromJsonString(MUDLET_JSON_MAP)).toBe(true);
    });

    it('imports every room and area', () => {
        const store = load();
        expect(Object.keys(store.getRooms()).length).toBe(3);
        expect(store.getAreaTable()).toMatchObject({ Earth: 1, 'Default Area': -1 });
    });

    it('takes the room symbol TEXT, never the symbol object', () => {
        const store = load();
        expect(store.getRoomChar(2)).toBe('S');
        expect(store.getRoomChar(3)).toBe('O');
        expect(typeof store.getRoomChar(2)).toBe('string');
        // The regression this guards: the object stringifies to "[object
        // Object]" in JS and "[LuaTable …]" once it reaches Lua.
        expect(store.getRoomChar(2)).not.toContain('LuaTable');
        expect(store.getRoomChar(2)).not.toContain('object Object');
        // A room without a symbol stays empty rather than picking up junk.
        expect(store.getRoomChar(1)).toBe('');
    });

    it('applies the symbol colour from color24RGB', () => {
        const store = load();
        expect(store.getRoomCharColor(2)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
        expect(store.getRoomCharColor(3)).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    });

    it('routes stock exits to direction fields and special exits by command', () => {
        const rooms = load().toMudletMap().rooms;
        expect(rooms[1].east).toBe(2);
        expect(rooms[2].west).toBe(1);
        expect(rooms[1].mSpecialExits['press button']).toBe(3);
        // A special exit must not leak into a direction field.
        expect(rooms[1].north).toBe(-1);
    });

    it('converts stub exits to Mudlet direction numbers', () => {
        const rooms = load().toMudletMap().rooms;
        expect(rooms[1].stubs).toEqual([12]); // out
        expect(rooms[3].stubs).toEqual([10]); // down
        expect(rooms[2].stubs).toEqual([]);
    });

    it('keeps coordinates, environment, lock state, userData and hashes', () => {
        const store = load();
        const rooms = store.toMudletMap().rooms;
        expect([rooms[1].x, rooms[1].y, rooms[1].z]).toEqual([6, -6, 0]);
        expect(rooms[1].environment).toBe(272);
        expect(rooms[2].isLocked).toBe(true);
        expect(rooms[1].isLocked).toBe(false);
        expect(rooms[1].userData).toMatchObject({ fed2_num: '390' });
        expect(store.getRoomIDbyHash('Sol.Earth.390')).toBe(1);
        expect(rooms[1].area).toBe(1);
    });

    it('carries custom env colours and the per-profile player room', () => {
        const map = load().toMudletMap();
        expect(map.mCustomEnvColors[257]).toMatchObject({ r: 128, g: 0, b: 0, alpha: 255 });
        expect(map.mRoomIdHash).toMatchObject({ SomeProfile: 2 });
    });

    // These per-exit attributes were verified in bulk against a real 26,988-room
    // Mudlet export: every count (308 doors, 11,794 weights, 248 locks, 2,671
    // custom lines) matched the source file exactly.
    // Doors key off the SHORT exit name ("n"/"ne"/…/"up"/"down"/"in"/"out") —
    // the keys TRoom::auditExits writes and the only ones setDoor/getDoors
    // accept, so a door written here is readable through the Lua API.
    it('maps exit doors onto the short direction name', () => {
        const rooms = load().toMudletMap().rooms;
        expect(rooms[1].doors).toMatchObject({ e: 2 });      // closed
        expect(rooms[1].doors.out).toBe(1);                  // open, from a stub
    });

    it('keys exit weights short for stock exits and by command for special ones', () => {
        const rooms = load().toMudletMap().rooms;
        expect(rooms[1].exitWeights.e).toBe(5);
        expect(rooms[1].exitWeights['press button']).toBe(7);
        // The long name must NOT be used for a stock exit.
        expect(rooms[1].exitWeights.east).toBeUndefined();
    });

    it('records stock locks by direction number and special locks by destination', () => {
        const rooms = load().toMudletMap().rooms;
        expect(rooms[1].exitLocks).toContain(4);   // east
        expect(rooms[1].exitLocks).toContain(12);  // out, from the stub
        expect(rooms[1].mSpecialExitLocks).toContain(3);
    });

    it('reconstructs custom lines with points, colour, arrow and pen style', () => {
        const store = load();
        const room = store.toMudletMap().rooms[1];
        // Keyed by the SHORT direction name, which is what addCustomLine writes
        // and what Mudlet normalises to — the import used to key by the long
        // one, so a line it read back was unreachable through getCustomLines
        // while an identical line written by addCustomLine was not.
        expect(room.customLines.e).toEqual([[33, -8], [33, -7], [40, -7]]);
        expect(room.customLinesColor.e).toMatchObject({ r: 191, g: 191, b: 191 });
        expect(room.customLinesArrow.e).toBe(false);
        expect(room.customLinesStyle.e).toBe(2); // Qt::DashLine
        // And it reads back through the public accessor Mudlet scripts use.
        expect(store.getCustomLines(1)?.e.attributes.style).toBe('dash line');
    });

    it('lifts the hidden flag into the hidden-room side table', () => {
        const store = load();
        expect(store.getRoomHidden(3)).toBe(true);
        expect(store.getRoomHidden(1)).toBe(false);
        // The render path drops the v20 transport key (it's dead weight per
        // redraw) — but only because the SAVE path puts it back, below.
        expect(store.toMudletMap().rooms[3].userData['system.fallback_hidden']).toBeUndefined();
    });

    it('re-injects system.fallback_hidden when saving, so v20 readers keep it', () => {
        const store = load();
        const saved = store.toMudletMapForSave();
        expect(saved.rooms[3].userData['system.fallback_hidden']).toBe('true');
        expect(saved.rooms[1].userData['system.fallback_hidden']).toBeUndefined();

        // And it survives a full save → load cycle rather than just being present.
        const reloaded = new MapStore();
        expect(reloaded.loadFromJsonString(store.toJsonString())).toBe(true);
        expect(reloaded.getRoomHidden(3)).toBe(true);
        expect(reloaded.getRoomHidden(1)).toBe(false);
    });

    it('rejects payloads that are neither shape', () => {
        const store = new MapStore();
        expect(store.loadFromJsonString('not json')).toBe(false);
        expect(store.loadFromJsonString('{"nope":1}')).toBe(false);
        expect(mudletJsonMapToMudletMap({ areas: 'not-an-array' })).toBeNull();
        expect(mudletJsonMapToMudletMap(null)).toBeNull();
    });

    it('still loads the binary-model shape toJsonString emits', () => {
        // Round-trip guard: the new branch must not break the original path.
        const original = load();
        const restored = new MapStore();
        expect(restored.loadFromJsonString(original.toJsonString())).toBe(true);
        expect(Object.keys(restored.getRooms()).length).toBe(3);
        expect(restored.getRoomChar(2)).toBe('S');
    });
});
