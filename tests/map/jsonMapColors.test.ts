import { describe, it, expect } from 'vitest';
import { MapStore } from '../../src/map/MapStore';

// Mudlet's saveJsonMap writes every colour through TMap::writeJsonColor —
// `{color24RGB: [r, g, b]}`, or `{color32RGBA: [r, g, b, a]}` when translucent —
// and a room's border as `border: {color…, thickness}`. Mudlet Web used to write
// and read `{r, g, b, a}` and a flat borderColor24RGB/borderWidth, so a map
// exchanged either way lost label colours, borders, env-colour alpha, label
// images and grid mode (issue #235).

const DESKTOP_JSON = JSON.stringify({
    formatVersion: 1,
    customEnvColors: [
        { id: 300, color32RGBA: [10, 20, 30, 128] },
        { id: 301, color24RGB: [40, 50, 60] },
    ],
    areas: [{
        id: 1,
        name: 'A',
        gridMode: true,
        labels: [{
            id: 0,
            coordinates: [1, 2, 0],
            size: [3, 4],
            text: 'Hi',
            colors: [{ color24RGB: [255, 0, 0] }, { color32RGBA: [0, 0, 255, 50] }],
            image: ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dw', 'HwAFAAH/q842iQAAAABJRU5ErkJggg=='],
            showOnTop: true,
            scaledels: true,
        }],
        rooms: [{
            id: 1,
            coordinates: [0, 0, 0],
            border: { color32RGBA: [1, 2, 3, 200], thickness: 4 },
            symbol: { text: 'X', color24RGB: [9, 8, 7] },
        }],
    }],
});

const load = (json: string): MapStore => {
    const store = new MapStore();
    expect(store.loadFromJsonString(json)).toBe(true);
    return store;
};

describe('loadJsonMap reads desktop colour objects', () => {
    it('reads label colours from color24RGB / color32RGBA', () => {
        const label = load(DESKTOP_JSON).getMapLabel(1, 0);
        expect(label.ok && 'single' in label && label.single.FgColor).toEqual({ r: 255, g: 0, b: 0 });
        expect(label.ok && 'single' in label && label.single.BgColor).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('joins a label image written as an array of lines', () => {
        const label = load(DESKTOP_JSON).getMapLabel(1, 0);
        expect(label.ok && 'single' in label && label.single.Pixmap)
            .toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');
    });

    it('keeps the alpha of a custom env colour', () => {
        const colors = load(DESKTOP_JSON).getCustomEnvColorTable();
        expect(colors[300]).toEqual({ r: 10, g: 20, b: 30, a: 128 });
        expect(colors[301]).toEqual({ r: 40, g: 50, b: 60, a: 255 });
    });

    it('reads the room border object', () => {
        const store = load(DESKTOP_JSON);
        expect(store.getRoomBorderColor(1)).toEqual({ r: 1, g: 2, b: 3, a: 200 });
        expect(store.getRoomBorderThickness(1)).toBe(4);
        expect(store.getRoomCharColor(1)).toEqual({ r: 9, g: 8, b: 7, a: 255 });
    });

    it('reads grid mode', () => {
        expect(load(DESKTOP_JSON).getGridMode(1)).toBe(true);
    });
});

describe('saveJsonMap writes desktop colour objects', () => {
    const saved = () => JSON.parse(load(DESKTOP_JSON).toMudletJsonString());

    it('writes label colours with writeJsonColor keys', () => {
        const label = saved().areas.find((a: { id: number }) => a.id === 1).labels[0];
        expect(label.colors).toEqual([{ color24RGB: [255, 0, 0] }, { color32RGBA: [0, 0, 255, 50] }]);
    });

    it('writes the label image as 64-character lines', () => {
        const label = saved().areas.find((a: { id: number }) => a.id === 1).labels[0];
        expect(Array.isArray(label.image)).toBe(true);
        expect(label.image[0]).toHaveLength(64);
        expect(label.image.join('')).toBe(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');
    });

    it('writes custom env colours with their alpha', () => {
        const ours = saved().customEnvColors.filter((c: { id: number }) => c.id >= 300);
        expect(ours).toEqual([
            { id: 300, color32RGBA: [10, 20, 30, 128] },
            { id: 301, color24RGB: [40, 50, 60] },
        ]);
    });

    it('writes the room border as one object, and grid mode', () => {
        const area = saved().areas.find((a: { id: number }) => a.id === 1);
        expect(area.gridMode).toBe(true);
        expect(area.rooms[0].border).toEqual({ color32RGBA: [1, 2, 3, 200], thickness: 4 });
        expect(area.rooms[0].borderColor24RGB).toBeUndefined();
        expect(area.rooms[0].symbol).toEqual({ text: 'X', color24RGB: [9, 8, 7] });
    });

    it('leaves gridMode out for an area not in grid mode', () => {
        const store = load(DESKTOP_JSON);
        store.setGridMode(1, false);
        const area = JSON.parse(store.toMudletJsonString()).areas.find((a: { id: number }) => a.id === 1);
        expect(area.gridMode).toBeUndefined();
    });

    it('round-trips through its own output', () => {
        const store = load(load(DESKTOP_JSON).toMudletJsonString());
        expect(store.getRoomBorderColor(1)).toEqual({ r: 1, g: 2, b: 3, a: 200 });
        expect(store.getCustomEnvColorTable()[300]).toEqual({ r: 10, g: 20, b: 30, a: 128 });
        expect(store.getGridMode(1)).toBe(true);
    });
});

describe('older Mudlet Web exports still open', () => {
    it('reads {r,g,b,a} label colours, a string image and the flat border fields', () => {
        const store = load(JSON.stringify({
            formatVersion: 1,
            areas: [{
                id: 1, name: 'A',
                labels: [{
                    id: 0, coordinates: [0, 0, 0], size: [1, 1], image: 'QUJD',
                    colors: [{ r: 1, g: 2, b: 3, a: 255 }, { r: 4, g: 5, b: 6, a: 7 }],
                }],
                rooms: [{ id: 1, coordinates: [0, 0, 0], borderColor24RGB: [7, 8, 9], borderWidth: 2 }],
            }],
        }));
        const label = store.getMapLabel(1, 0);
        expect(label.ok && 'single' in label && label.single.FgColor).toEqual({ r: 1, g: 2, b: 3 });
        expect(label.ok && 'single' in label && label.single.Pixmap).toBe('QUJD');
        expect(store.getRoomBorderColor(1)).toEqual({ r: 7, g: 8, b: 9, a: 255 });
        expect(store.getRoomBorderThickness(1)).toBe(2);
    });
});
