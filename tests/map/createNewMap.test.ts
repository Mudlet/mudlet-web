// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { MapStore } from '../../src/map/MapStore';
import { MudixMapReader } from '../../src/map/MudixMapReader';

/**
 * Mudlet's mapper offers "Create new map" whenever the profile has no map at
 * all (T2DMap::slot_newMap, reachable from the no-map context menu): it seeds a
 * single room in the default area so there is something to build on. The map
 * panel's empty-state overlay exposes the same action, and this covers what it
 * has to produce — a room the renderer can actually see, and a player position
 * pointing at it.
 */
describe('MapStore.createNewMap', () => {
    it('seeds one room at the origin of the default area, as the player room', () => {
        const store = new MapStore();
        const id = store.createNewMap();

        expect(store.isEmpty()).toBe(false);
        expect(store.isInitialized()).toBe(true);
        expect(store.roomExists(id)).toBe(true);
        // Mudlet parks the seed room in the default ("void") area -1.
        expect(store.getRoomArea(id)).toBe(-1);
        expect(store.getRoomCoordinates(id)).toEqual([0, 0, 0]);
        // slot_newMap stamps mRoomIdHash[profile], i.e. the player position —
        // that is what the map view opens on and paints the marker at.
        expect(store.getPlayerRoom()).toBe(id);
    });

    it('produces a map the renderer can see', () => {
        const store = new MapStore();
        const id = store.createNewMap();
        const reader = new MudixMapReader(store);

        // The panel drops to its empty-state overlay when the reader reports no
        // areas, so a seed room filed only under `room.area` would leave the
        // user staring at the same "no map" screen they just clicked out of.
        const areas = reader.getAreas();
        expect(areas.map(a => a.getAreaId())).toEqual([-1]);
        expect(areas[0].getAreaName()).toBe('Default Area');
        expect(reader.getRoom(id)?.area).toBe(-1);
    });

    it('replaces whatever the store held', () => {
        const store = new MapStore();
        const areaId = store.addAreaName('Old') as number;
        store.addRoom(7, areaId);
        store.setRoomCoordinates(7, 5, 5, 0);

        const id = store.createNewMap();
        expect(store.roomExists(7)).toBe(false);
        expect(store.getAreaTable()).toEqual({ 'Default Area': -1 });
        expect(store.getPlayerRoom()).toBe(id);
    });
});

describe('MapStore.resetRoomArea', () => {
    it('files the room under the default area, not just on the room', () => {
        const store = new MapStore();
        store.newEmptyMap();
        const areaId = store.addAreaName('Somewhere') as number;
        store.addRoom(3, areaId);
        store.setRoomCoordinates(3, 2, 2, 0);

        expect(store.resetRoomArea(3)).toBe(true);
        expect(store.getRoomArea(3)).toBe(-1);
        // Mudlet's TRoom::setArea adds the room to the target TArea's room
        // list; the renderer reads that list, so skipping it hides the room.
        // (The skeleton reader materialises rooms per plane, not per area.)
        const plane = new MudixMapReader(store).getArea(-1).getPlane(0);
        expect(plane.getRooms().map(r => r.id)).toEqual([3]);
        // …and it leaves the old area behind.
        expect(store.getRoomsByPosition(areaId, 2, 2, 0)).toEqual([]);
    });
});
