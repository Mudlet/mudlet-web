import { describe, expect, it } from 'vitest';
import { MapStore } from '../../src/map/MapStore';
import { AREA_GRAPH_LAYOUT_KEY } from '../../src/map/areaGraph';
import { guessEnvironmentKit, storeEnvironmentKit, storedEnvironmentKits } from '../../src/map/environmentKit';

function build(store: MapStore): Record<string, number> {
    const ids: Record<string, number> = {};
    for (const name of ['A', 'B', 'C', 'D']) ids[name] = store.addAreaName(name) as number;
    const room = (area: string, x: number, y: number) => {
        const id = store.createRoomID();
        store.addRoom(id);
        store.setRoomArea(id, ids[area]);
        store.setRoomCoordinates(id, x, y, 0);
        return id;
    };
    ids.a1 = room('A', 0, 0); ids.a2 = room('A', 5, 3);
    ids.b1 = room('B', 0, 0); ids.b2 = room('B', 1, 0);
    ids.c1 = room('C', 0, 0); ids.d1 = room('D', 0, 0);
    store.setExit(ids.a1, ids.b1, 'e');
    store.setExit(ids.b1, ids.a1, 'w');
    store.addSpecialExit(ids.b2, ids.c1, 'climb rope');
    return ids;
}

describe('area graph (TAreaGraph)', () => {
    it('links areas by their exits and lays the same map out the same way', () => {
        const store = new MapStore();
        const ids = build(store);
        const first = store.getAreaGraph();
        expect(first.links).toEqual([
            { fromArea: ids.A, toArea: ids.B, exitCount: 2 },
            { fromArea: ids.B, toArea: ids.C, exitCount: 1 },
        ]);
        expect(store.getMapUserData(AREA_GRAPH_LAYOUT_KEY)).toMatch(/^\{"areas":\{/);
        store.deleteMap();
        build(store);
        expect(store.getAreaGraph()).toEqual(first);
    });

    it('pins a moved area and keeps the others clear of it', () => {
        const store = new MapStore();
        const ids = build(store);
        const a = store.getAreaGraph().areas.find(n => n.areaId === ids.A)!;
        expect(store.setAreaGraphPosition(ids.D, a.position[0], a.position[1])).toBe(true);
        const areas = store.getAreaGraph().areas;
        for (let i = 0; i < areas.length; i++) {
            for (let j = i + 1; j < areas.length; j++) {
                const d = Math.hypot(areas[i].position[0] - areas[j].position[0], areas[i].position[1] - areas[j].position[1]);
                expect(d).toBeGreaterThanOrEqual(areas[i].radius + areas[j].radius);
            }
        }
        expect(store.setAreaGraphPosition(ids.D, NaN, 0)).toBe(false);
    });
});

describe('environment kits (EnvironmentKit)', () => {
    it('guesses from the colour as desktop does', () => {
        expect(guessEnvironmentKit([60, 120, 200])).toBe('water');
        expect(guessEnvironmentKit([90, 160, 70])).toBe('forest');
        expect(guessEnvironmentKit([230, 130, 20])).toBe('building');
        expect(guessEnvironmentKit([100, 60, 30])).toBe('road');
        expect(guessEnvironmentKit([245, 245, 250])).toBe('building');
    });

    it('keeps entries it cannot read, and refuses to overwrite what is not JSON', () => {
        const saved = storeEnvironmentKit('{"12":"water","x":"road"}', 14, 'road');
        expect(saved?.value).toBe('{"12":"water","14":"road","x":"road"}');
        expect([...storedEnvironmentKits(saved?.value)]).toEqual([[12, 'water'], [14, 'road']]);
        expect(storeEnvironmentKit('not json', 1, 'road')).toBeNull();
    });
});
