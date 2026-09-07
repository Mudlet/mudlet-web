// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isViewportDataSource, isHashLookupCapable } from 'mudlet-map-renderer';
import { MapStore } from '../../src/map/MapStore';
import { MudletMapReader } from '../../src/map/MudletMapReader';

/**
 * MudletMapReader wraps a viewport-virtualized `SkeletonMapReader`, which is
 * what keeps a large map's scene builds proportional to what's on screen
 * rather than to the whole level. That only works if the wrapper preserves the
 * two things the renderer looks for — the `ViewportDataSource` capability
 * (detected by duck-typing, so a plain facade silently opts out) and the
 * viewport itself across the rebuilds that every store mutation triggers.
 */

/** A grid of `side`×`side` rooms in area 1, one room per unit of map space. */
function gridStore(side: number): MapStore {
    const store = new MapStore();
    const areaId = store.addAreaName('Grid') as number;
    let id = 0;
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            id++;
            store.addRoom(id, areaId);
            store.setRoomCoordinates(id, x, y, 0);
        }
    }
    return store;
}

describe('MudletMapReader', () => {
    it('advertises the capabilities the renderer duck-types for', () => {
        const reader = new MudletMapReader(gridStore(4));
        // Without these the interactive backend treats it as an ordinary
        // reader: no viewport push, no rebuild-on-pan, whole-plane builds.
        expect(isViewportDataSource(reader)).toBe(true);
        expect(isHashLookupCapable(reader)).toBe(true);
    });

    it('materialises only the viewport for a plane, but resolves any room by id', () => {
        const store = gridStore(10);
        const reader = new MudletMapReader(store);
        const areaId = reader.getAreas()[0].getAreaId();

        reader.setViewport({ minX: -0.5, maxX: 2.5, minY: -2.5, maxY: 0.5 });
        const visible = reader.getArea(areaId).getPlane(0).getRooms();
        expect(visible.length).toBeGreaterThan(0);
        expect(visible.length).toBeLessThan(100);

        // Overlays (highlights, selection) look rooms up by id regardless of
        // where the camera is, so this must not be viewport-scoped.
        const far = reader.getRoom(100);
        expect(far.id).toBe(100);
    });

    it('keeps the viewport across the rebuild a store mutation forces', () => {
        const store = gridStore(10);
        const reader = new MudletMapReader(store);
        const areaId = reader.getAreas()[0].getAreaId();
        const window = { minX: -0.5, maxX: 2.5, minY: -2.5, maxY: 0.5 };
        reader.setViewport(window);
        const before = reader.getArea(areaId).getPlane(0).getRooms().length;

        // Any mutation bumps the store version and rebuilds the inner reader.
        // A fresh one defaults to unbounded, so without re-applying, the next
        // scene build would quietly materialise the entire plane.
        store.setRoomEnv(5, 3);
        const after = reader.getArea(areaId).getPlane(0).getRooms().length;

        expect(after).toBe(before);
        expect(reader.getViewport()).toEqual(window);
    });

    it('starts unbounded, and clearViewport returns it to unbounded', () => {
        const store = gridStore(10);
        // The export path builds its own reader and never narrows it — an
        // exporter driven by a viewport-scoped reader would crop the image to
        // whatever happened to be on screen.
        const fresh = new MudletMapReader(store);
        const areaId = fresh.getAreas()[0].getAreaId();
        const all = fresh.getArea(areaId).getPlane(0).getRooms().length;
        expect(all).toBe(100);

        fresh.setViewport({ minX: -0.5, maxX: 2.5, minY: -2.5, maxY: 0.5 });
        expect(fresh.getArea(areaId).getPlane(0).getRooms().length).toBeLessThan(all);

        fresh.clearViewport();
        expect(fresh.getArea(areaId).getPlane(0).getRooms().length).toBe(all);
    });

    it('resolves a room hash without scanning (getRooms is empty here)', () => {
        const store = gridStore(4);
        store.setRoomIDbyHash(7, 'deadbeefdeadbeefdeadbeefdeadbeef');
        const reader = new MudletMapReader(store);

        expect(reader.getRoomIdByHash('deadbeefdeadbeefdeadbeefdeadbeef')).toBe(7);
        expect(reader.getRoomIdByHash('nope')).toBeUndefined();
    });

    it('keeps rooms that carry visual detail materialised in full', () => {
        const store = gridStore(4);
        store.setRoomChar(3, '#');
        const reader = new MudletMapReader(store);

        // Skeleton-synthesised rooms come back with an empty roomChar; a room
        // with a symbol has to be promoted to a full detail room or it would
        // render blank.
        expect(reader.getRoom(3).roomChar).toBe('#');
    });

    it('reports no data for an empty store without throwing', () => {
        const reader = new MudletMapReader(new MapStore());
        expect(reader.hasData()).toBe(false);
        expect(reader.getAreas()).toEqual([]);
    });
});
