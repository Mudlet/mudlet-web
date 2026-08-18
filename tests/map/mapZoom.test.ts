// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import type { MapRenderer } from 'mudlet-map-renderer';
import { readMapFromBuffer, writeMapToBuffer } from 'mudlet-map-binary-reader';
import { MapStore } from '../../src/map/MapStore';
import {
    MUDLET_DEFAULT_MAP_ZOOM, MUDLET_MIN_MAP_ZOOM, ZOOM_OUT_HEADROOM,
    applyAreaZoom, toMudletZoom, toRendererZoom,
} from '../../src/map/mapZoom';

// The renderer's own constant: camera.getScale() === BASE_SCALE * rendererZoom.
const BASE_SCALE = 75;

const AREA_ZOOM_KEY = 'system.fallback_map2DZoom';

/**
 * Enough of MapRenderer + its camera to exercise the zoom policy: the camera's
 * scale/floor arithmetic and a fitArea() that reproduces the library's
 * `fitToMapBounds` — fit the extent (plus its 4-unit padding) to the viewport
 * and pin minZoom to that fit. Everything the policy touches is arithmetic on
 * these fields, so the fake is exact rather than approximate.
 */
function fakeRenderer(opts: { width: number; height: number; spanX: number; spanY: number }) {
    const camera = {
        width: opts.width,
        height: opts.height,
        zoom: 1,
        minZoom: 0.05,
        getScale() { return BASE_SCALE * this.zoom; },
    };
    return {
        camera,
        get minZoom() { return camera.minZoom; },
        set minZoom(v: number) { camera.minZoom = v; },
        getZoom() { return camera.zoom; },
        setZoom(z: number) { camera.zoom = Math.max(camera.minZoom, z); },
        fitArea() {
            const fit = Math.min(
                Math.max(1, camera.width) / ((opts.spanX + 4) * BASE_SCALE),
                Math.max(1, camera.height) / ((opts.spanY + 4) * BASE_SCALE),
            );
            camera.zoom = fit;
            camera.minZoom = fit;
        },
    } as unknown as MapRenderer;
}

/** How many map units the shorter viewport edge spans — the thing the user
 *  actually perceives as "how zoomed in is it". */
const unitsAcross = (r: MapRenderer) => toMudletZoom(r)!;

describe('map view zoom units', () => {
    it('round-trips a Mudlet zoom through the renderer scale', () => {
        const r = fakeRenderer({ width: 800, height: 600, spanX: 10, spanY: 10 });
        r.setZoom(toRendererZoom(r, 25)!);
        expect(unitsAcross(r)).toBeCloseTo(25, 9);
    });

    it('is independent of the panel size, so a resized panel restores the same view', () => {
        const wide = fakeRenderer({ width: 1600, height: 900, spanX: 10, spanY: 10 });
        const narrow = fakeRenderer({ width: 400, height: 300, spanX: 10, spanY: 10 });
        wide.setZoom(toRendererZoom(wide, 20)!);
        narrow.setZoom(toRendererZoom(narrow, 20)!);
        // Same extent of map visible across the shorter edge in both, even
        // though the pixels-per-unit differ threefold.
        expect(unitsAcross(wide)).toBeCloseTo(20, 9);
        expect(unitsAcross(narrow)).toBeCloseTo(20, 9);
        expect(wide.camera.getScale()).not.toBeCloseTo(narrow.camera.getScale(), 3);
    });

    it('reports nothing for a panel that has not been laid out', () => {
        const unsized = fakeRenderer({ width: 0, height: 0, spanX: 10, spanY: 10 });
        expect(toMudletZoom(unsized)).toBeNull();
        expect(toRendererZoom(unsized, 20)).toBeNull();
    });
});

describe('applyAreaZoom', () => {
    // The reported bug, half one: a brand-new map of four adjacent rooms spans
    // 1x1 units, and fitting that to the panel puts a single room across the
    // whole window — past the zoom-in limit the wheel itself enforces.
    it('opens a tiny new area at the default zoom, not fitted to one room', () => {
        const r = fakeRenderer({ width: 800, height: 600, spanX: 1, spanY: 1 });
        r.fitArea();
        expect(unitsAcross(r)).toBeLessThan(MUDLET_MIN_MAP_ZOOM * 2); // what fitting alone gave

        applyAreaZoom(r, undefined);
        expect(unitsAcross(r)).toBeCloseTo(MUDLET_DEFAULT_MAP_ZOOM, 9);
    });

    // The reported bug, half two: a large area fitted to the panel draws each
    // room a fraction of a pixel wide.
    it('opens a huge area at the default zoom, not fitted to the whole continent', () => {
        const r = fakeRenderer({ width: 800, height: 600, spanX: 2000, spanY: 2000 });
        r.fitArea();
        expect(unitsAcross(r)).toBeGreaterThan(1000); // what fitting alone gave

        applyAreaZoom(r, undefined);
        expect(unitsAcross(r)).toBeCloseTo(MUDLET_DEFAULT_MAP_ZOOM, 9);
    });

    it('restores a saved zoom instead of the default', () => {
        const r = fakeRenderer({ width: 800, height: 600, spanX: 40, spanY: 40 });
        applyAreaZoom(r, 60);
        expect(unitsAcross(r)).toBeCloseTo(60, 9);
    });

    it("never opens closer than Mudlet's zoom-in limit", () => {
        const r = fakeRenderer({ width: 800, height: 600, spanX: 40, spanY: 40 });
        applyAreaZoom(r, 0.5);
        expect(unitsAcross(r)).toBeCloseTo(MUDLET_MIN_MAP_ZOOM, 9);
    });

    it('leaves room to zoom out past a large area', () => {
        const r = fakeRenderer({ width: 800, height: 600, spanX: 200, spanY: 200 });
        applyAreaZoom(r, undefined);
        // The floor derives from the area's real extent (so the whole map can be
        // framed) with headroom beyond it, rather than the camera's size-blind
        // 0.05 default. setZoom clamps to that floor.
        r.setZoom(0);
        expect(unitsAcross(r)).toBeGreaterThan(200 * ZOOM_OUT_HEADROOM / 2);
    });

    it('leaves room to zoom out of a small area, whose fit is closer than the opening view', () => {
        const r = fakeRenderer({ width: 800, height: 600, spanX: 1, spanY: 1 });
        applyAreaZoom(r, undefined);
        // A four-room area fits in ~5 units — well inside the 20 we open at — so
        // a floor taken from the fit alone would land on top of the opening zoom
        // and the wheel would not move at all.
        r.setZoom(0);
        expect(unitsAcross(r)).toBeCloseTo(MUDLET_DEFAULT_MAP_ZOOM * ZOOM_OUT_HEADROOM, 9);
    });

    it('leaves the view alone when the panel has no size yet', () => {
        const r = fakeRenderer({ width: 0, height: 0, spanX: 10, spanY: 10 });
        // Must not throw, and must not invent a zoom from a 0x0 viewport — the
        // panel re-applies once the ResizeObserver reports real dimensions.
        expect(() => applyAreaZoom(r, undefined)).not.toThrow();
        expect(toMudletZoom(r)).toBeNull();
    });
});

describe('MapStore area zoom persistence', () => {
    const seed = () => {
        const store = new MapStore();
        const areaId = store.addAreaName('Town') as number;
        store.addRoom(1);
        store.setRoomArea(1, areaId);
        return { store, areaId };
    };

    it("defaults to Mudlet's default zoom for an area that has never been viewed", () => {
        const { store, areaId } = seed();
        expect(store.getAreaZoom(areaId)).toBeUndefined();
        expect(MapStore.DEFAULT_MAP_ZOOM).toBe(MUDLET_DEFAULT_MAP_ZOOM);
    });

    it("round-trips through the binary map file under Mudlet's own key", () => {
        const { store, areaId } = seed();
        store.setAreaZoom(areaId, 42);
        // v20 has no field for TArea::mLast2DMapZoom; Mudlet carries it in area
        // userData under this key, so the value survives a trip through Mudlet.
        expect(store.getAreaUserData(areaId, AREA_ZOOM_KEY)).toBe('42');

        const parsed = readMapFromBuffer(Buffer.from(writeMapToBuffer(store.toMudletMapForSave())));
        const reloaded = new MapStore();
        reloaded.loadFromBinary(parsed);
        expect(reloaded.getAreaZoom(areaId)).toBe(42);
    });

    it('refuses to store a zoom below the limit, and ignores one already stored', () => {
        const { store, areaId } = seed();
        store.setAreaZoom(areaId, 30);
        // A view measured against a not-yet-laid-out panel used to land here and
        // then get restored on every future open.
        expect(store.setAreaZoom(areaId, 0.0004)).toBe(false);
        expect(store.getAreaZoom(areaId)).toBe(30);

        store.setAreaUserData(areaId, AREA_ZOOM_KEY, '0.0004');
        expect(store.getAreaZoom(areaId)).toBeUndefined();
    });
});
