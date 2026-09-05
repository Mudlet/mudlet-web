// @vitest-environment node
//
// Issue #128 item 3: desktop's "report map issues on screen" — the map's
// sanity-check report, which Mudlet posts on the main console when the option
// is on and files away otherwise. mudix already repaired three of these classes
// silently on a JSON import; the audit now says what it found, and can also run
// without touching the map, which is what a `.dat` load needs.
//
// Every case here is built as a map *document* rather than through the mapper
// API, because the API refuses all of it: `setExit` will not point at a room
// that is not there, and `addSpecialExit` will not take an empty command. A
// file is the only way a map arrives in these states, which is why the audit
// exists at all.
import { describe, it, expect } from 'vitest';
import type { MudletArea, MudletMap, MudletRoom } from 'mudlet-map-binary-reader';
import { MapStore, makeRoom, DEFAULT_FONT } from '../../src/map/MapStore';

function makeArea(rooms: number[]): MudletArea {
    return {
        rooms, zLevels: [0], mAreaExits: {}, gridMode: false,
        max_x: 0, max_y: 0, max_z: 0, min_x: 0, min_y: 0, min_z: 0,
        span: [0, 0, 0], xmaxForZ: {}, ymaxForZ: {}, xminForZ: {}, yminForZ: {},
        pos: [0, 0, 0], isZone: false, zoneAreaRef: 0, userData: {},
    };
}

/** A map of `ids` rooms in area 1, each ready to be bent into one bad shape. */
function mapOf(ids: number[], patch: (rooms: Record<number, MudletRoom>) => void = () => {}): MudletMap {
    const rooms: Record<number, MudletRoom> = {};
    for (const id of ids) rooms[id] = makeRoom(1);
    patch(rooms);
    return {
        version: 20, envColors: {}, areaNames: { 1: 'Test area' }, mCustomEnvColors: {},
        mpRoomDbHashToRoomId: {}, mUserData: {}, mapSymbolFont: DEFAULT_FONT,
        mapFontFudgeFactor: 1, useOnlyMapFont: false,
        areas: { 1: makeArea(ids) }, mRoomIdHash: {}, labels: {}, rooms,
    };
}

function storeOf(ids: number[], patch?: (rooms: Record<number, MudletRoom>) => void): MapStore {
    const store = new MapStore();
    store.loadFromBinary(mapOf(ids, patch));
    return store;
}

const messages = (store: MapStore, repair = false) =>
    store.auditExits(repair).map(i => `${i.severity}: ${i.message}`);

describe('auditExits — exits', () => {
    it('finds nothing wrong with a sound map', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].north = 2; rooms[2].south = 1; });
        expect(store.auditExits()).toEqual([]);
    });

    it('reports a stock exit to a room that does not exist', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].north = 99; });
        const issues = store.auditExits();
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ severity: 'warn', roomId: 1 });
        expect(issues[0].message).toContain('has an exit "north" to: 99 but that room does not exist');
    });

    it('reports a special exit to a room that does not exist', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].mSpecialExits = { 'climb tree': 99 }; });
        const issues = store.auditExits();
        expect(issues).toHaveLength(1);
        expect(issues[0].message).toContain('has a special exit "climb tree" to: 99');
    });

    it('reports a special exit with no name at all', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].mSpecialExits = { '': 2 }; });
        expect(messages(store)).toEqual([
            'warn: In room ID: 1 there is an invalid (special) exit to 2 (with no name!).',
        ]);
    });

    it('reports a stub standing in a direction that already has an exit', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].north = 2; rooms[1].stubs = [1]; });
        const issues = store.auditExits();
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ severity: 'info', roomId: 1 });
        expect(issues[0].message).toContain('surplus exit stubs');
        expect(issues[0].message).toContain('north');
    });
});

describe('auditExits — surplus door, weight and lock items', () => {
    it('reports a door on a direction with no way out', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].doors = { up: 2 }; });
        expect(messages(store)).toEqual([
            'info: In room with ID: 1 found one or more surplus door items on directions with no exit: up.',
        ]);
    });

    it('reports a weight on a direction with no way out', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].exitWeights = { up: 5 }; });
        expect(messages(store)[0]).toContain('surplus weight items');
    });

    // A stub is a way out that goes nowhere yet, and Mudlet lets it carry a
    // door and a lock — so neither is surplus just because there is no
    // destination on the other end.
    it('accepts a door on a stub', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].stubs = [9]; rooms[1].doors = { up: 2 }; });
        expect(store.auditExits()).toEqual([]);
    });

    it('accepts a weight keyed to a special exit command', () => {
        const store = storeOf([1, 2], rooms => {
            rooms[1].mSpecialExits = { 'climb tree': 2 };
            rooms[1].exitWeights = { 'climb tree': 5 };
        });
        expect(store.auditExits()).toEqual([]);
    });

    it('reports a lock on a direction with no way out', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].exitLocks = [9]; });
        expect(messages(store)[0]).toContain('surplus exit lock items');
    });
});

describe('auditExits — areas', () => {
    it('reports a room filed under an area that does not exist', () => {
        const store = storeOf([1, 2], rooms => { rooms[2].area = 77; });
        const issues = store.auditExits();
        expect(issues).toHaveLength(1);
        expect(issues[0].message).toContain('is in area 77, but that area does not exist');
    });

    it('reports an area listing a room that does not exist', () => {
        const store = new MapStore();
        const map = mapOf([1, 2]);
        map.areas[1].rooms.push(404);
        store.loadFromBinary(map);
        const issues = store.auditExits();
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ severity: 'warn', areaId: 1 });
        expect(issues[0].message).toContain('404');
    });
});

describe('auditExits — repair', () => {
    // The default is report-only: a `.dat` came from a client that already had
    // its chance to repair it, and rewriting a player's map to make a report
    // tidier is not a trade worth making.
    it('leaves the map alone unless asked to repair', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].north = 99; });
        store.auditExits();
        expect(store.getRoomExits(1)).toMatchObject({ north: 99 });
    });

    it('turns a dangling stock exit into a stub and records where it went', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].north = 99; });
        const issues = store.auditExits(true);
        expect(store.getRoomExits(1)?.north).toBeUndefined();
        expect(store.getExitStubs(1)).toEqual([1]);
        expect(store.getRoomUserData(1, 'audit.made_stub_of_valid_but_missing_exit.1')).toBe('99');
        expect(issues[0].message).toContain('turned into a stub');
    });

    it('removes a dangling special exit and records where it went', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].mSpecialExits = { 'climb tree': 99 }; });
        store.auditExits(true);
        expect(store.getSpecialExitsSwap(1)).toEqual({});
        expect(store.getRoomUserData(1, 'audit.removed_valid_but_missing_special_exit.climb tree')).toBe('99');
    });

    it('drops a stub from a direction that already has an exit', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].north = 2; rooms[1].stubs = [1]; });
        store.auditExits(true);
        expect(store.getExitStubs(1)).toEqual([]);
    });

    // The order matters: an exit that loses its destination BECOMES a stub, and
    // the stub-versus-exit check has to run after that or it would drop the stub
    // that was just created.
    it('keeps the stub it just made out of a dangling exit', () => {
        const store = storeOf([1, 2], rooms => { rooms[1].north = 99; });
        store.auditExits(true);
        expect(store.getExitStubs(1)).toEqual([1]);
    });
});

describe('loadFromJsonString', () => {
    it('audits, repairs, and leaves the report for the loader to take', () => {
        const source = storeOf([1, 2], rooms => { rooms[1].north = 99; });
        const loaded = new MapStore();
        expect(loaded.loadFromJsonString(source.toJsonString())).toBe(true);

        const issues = loaded.takeAuditIssues();
        expect(issues).toHaveLength(1);
        expect(issues[0].message).toContain('has an exit "north" to: 99');
        // Taken once: the report is owed to the load that caused it and to no
        // later one.
        expect(loaded.takeAuditIssues()).toEqual([]);
    });

    it('leaves nothing to report for a sound map', () => {
        const source = storeOf([1, 2], rooms => { rooms[1].north = 2; rooms[2].south = 1; });
        const loaded = new MapStore();
        expect(loaded.loadFromJsonString(source.toJsonString())).toBe(true);
        expect(loaded.takeAuditIssues()).toEqual([]);
    });
});

// Issue #128 item 4: desktop's "Show symbol usage…" report.
describe('roomSymbolUsage', () => {
    it('is empty for a map with no symbols', () => {
        expect(storeOf([1, 2]).roomSymbolUsage()).toEqual([]);
    });

    it('groups rooms by symbol, commonest first', () => {
        const store = storeOf([1, 2, 3, 4]);
        store.setRoomChar(1, '@');
        store.setRoomChar(2, '#');
        store.setRoomChar(3, '@');
        store.setRoomChar(4, '@');
        expect(store.roomSymbolUsage()).toEqual([
            { symbol: '@', rooms: [1, 3, 4] },
            { symbol: '#', rooms: [2] },
        ]);
    });

    it('breaks a tie on the symbol, so two runs agree', () => {
        const store = storeOf([1, 2]);
        store.setRoomChar(1, 'b');
        store.setRoomChar(2, 'a');
        expect(store.roomSymbolUsage().map(u => u.symbol)).toEqual(['a', 'b']);
    });

    it('keeps a multi-code-point symbol whole', () => {
        const store = storeOf([1]);
        store.setRoomChar(1, '\u{1F332}');
        expect(store.roomSymbolUsage()).toEqual([{ symbol: '\u{1F332}', rooms: [1] }]);
    });
});
