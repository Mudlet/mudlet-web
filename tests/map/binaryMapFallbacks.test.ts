// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { readMapFromBuffer, writeMapToBuffer } from 'mudlet-map-binary-reader';
import { MapStore, type MapLabel } from '../../src/map/MapStore';
import { withLabelPixmapBytes } from '../../src/map/labelPixmap';

// Issue #285: a v20 .dat file carries the TRoom/TArea/TMapLabel fields it has
// no slot for in `system.*` / `room.ui_*` user-data keys (TMap::serialize), and
// desktop lifts them back out on load (TRoom::restore / TMap::restore). These
// tests pin both halves against desktop's exact key names and value formats.

/** Save the store exactly as WindowManager.saveMap does. */
function saveBytes(store: MapStore): Buffer {
    return Buffer.from(writeMapToBuffer(withLabelPixmapBytes(store.toMudletMapForSave())));
}

function reload(bytes: Buffer): MapStore {
    const store = new MapStore();
    store.loadFromBinary(readMapFromBuffer(Buffer.from(bytes)));
    return store;
}

function seed() {
    const store = new MapStore();
    store.newEmptyMap();
    const a = store.addAreaName('Town') as number;
    const b = store.addAreaName('Empty') as number;
    for (const id of [101, 108]) {
        store.addRoom(id, a);
        store.setRoomCoordinates(id, id - 100, 0, 0);
    }
    return { store, a, b };
}

// A 1x1 transparent PNG — enough for the reader's PNG-boundary scan.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('room symbol colour in a v20 file (#285 item 1)', () => {
    it('is written as system.fallback_symbol_color and read back, web → web', () => {
        const { store } = seed();
        store.setRoomCharColor(101, 1, 2, 3);
        store.setRoomCharColor(108, 250, 0, 9);

        const saved = store.toMudletMapForSave();
        expect(saved.rooms[101].userData['system.fallback_symbol_color']).toBe('#010203');
        expect(saved.rooms[108].userData['system.fallback_symbol_color']).toBe('#fa0009');
        // Saving never leaks the key into the live store.
        expect(store.getAllRoomUserData(101))
            .not.toHaveProperty('system.fallback_symbol_color');

        const back = reload(saveBytes(store));
        expect(back.getRoomCharColor(101)).toEqual({ r: 1, g: 2, b: 3, a: 255 });
        expect(back.getRoomCharColor(108)).toEqual({ r: 250, g: 0, b: 9, a: 255 });
        expect(back.toMudletMap().rooms[101].userData).not.toHaveProperty('system.fallback_symbol_color');
    });

    it('is taken out of the user data of a desktop file', () => {
        const { store } = seed();
        const map = store.toMudletMapForSave();
        map.rooms[101].userData = { 'system.fallback_symbol_color': '#010203', mine: 'x' };
        const back = reload(Buffer.from(writeMapToBuffer(map)));
        expect(back.getRoomCharColor(101)).toEqual({ r: 1, g: 2, b: 3, a: 255 });
        expect(back.toMudletMap().rooms[101].userData).toEqual({ mine: 'x' });
    });
});

describe('room border in a v20 file (#285 item 2)', () => {
    it('is written as room.ui_borderColor (#aarrggbb) and room.ui_borderThickness', () => {
        const { store } = seed();
        store.setRoomBorderColor(101, 255, 0, 255, 255);
        store.setRoomBorderThickness(101, 3);
        store.setRoomBorderColor(108, 16, 32, 48, 128);

        const saved = store.toMudletMapForSave();
        expect(saved.rooms[101].userData['room.ui_borderColor']).toBe('#ffff00ff');
        expect(saved.rooms[101].userData['room.ui_borderThickness']).toBe('3');
        expect(saved.rooms[108].userData['room.ui_borderColor']).toBe('#80102030');

        const back = reload(saveBytes(store));
        expect(back.getRoomBorderColor(101)).toEqual({ r: 255, g: 0, b: 255, a: 255 });
        expect(back.getRoomBorderThickness(101)).toBe(3);
        expect(back.getRoomBorderColor(108)).toEqual({ r: 16, g: 32, b: 48, a: 128 });
    });

    it('reads a desktop file and leaves the keys visible, as TRoom::restore does', () => {
        const { store } = seed();
        const map = store.toMudletMapForSave();
        map.rooms[101].userData = { 'room.ui_borderColor': '#ffff00ff', 'room.ui_borderThickness': '11' };
        const back = reload(Buffer.from(writeMapToBuffer(map)));
        expect(back.getRoomBorderColor(101)).toEqual({ r: 255, g: 0, b: 255, a: 255 });
        // Out of 1..10: ignored.
        expect(back.getRoomBorderThickness(101)).toBeNull();
        expect(back.toMudletMap().rooms[101].userData['room.ui_borderColor']).toBe('#ffff00ff');
    });

    it('drops the keys on save once the border is cleared', () => {
        const { store } = seed();
        const map = store.toMudletMapForSave();
        map.rooms[101].userData = { 'room.ui_borderColor': '#ffff00ff', 'room.ui_borderThickness': '2' };
        const back = reload(Buffer.from(writeMapToBuffer(map)));
        back.clearRoomBorderColor(101);
        back.clearRoomBorderThickness(101);
        const resaved = back.toMudletMapForSave();
        expect(resaved.rooms[101].userData).not.toHaveProperty('room.ui_borderColor');
        expect(resaved.rooms[101].userData).not.toHaveProperty('room.ui_borderThickness');
    });

    it('does not survive into the next map', () => {
        const { store } = seed();
        store.setRoomBorderColor(101, 1, 2, 3, 4);
        store.newEmptyMap();
        store.addRoom(101);
        expect(store.getRoomBorderColor(101)).toBeNull();
    });
});

describe('area fallback keys in a v20 file (#285 item 3)', () => {
    it('takes system.fallback_map2DZoom and the label keys out of area user data', () => {
        const { store, a, b } = seed();
        store.setAreaUserData(a, 'ak', 'av');
        store.createMapLabel(a, 'Label A', 1, 1, 0, 255, 0, 0, 0, 0, 0, { zoom: 30, fontSize: 12 });
        const map = store.toMudletMapForSave();
        // What desktop writes for these areas.
        expect(map.areas[a].userData).toMatchObject({
            ak: 'av',
            'system.fallback_map2DZoom': '20',
            'system.labelOutlineColor_0': '255|0|0|255',
        });
        expect(map.areas[b].userData).toEqual({ 'system.fallback_map2DZoom': '20' });

        const back = reload(Buffer.from(writeMapToBuffer(map)));
        expect(back.getAllAreaUserData(a)).toEqual({ ak: 'av' });
        expect(back.getAllAreaUserData(b)).toEqual({});
    });

    it('keeps the zoom across a round trip without exposing it', () => {
        const { store, a } = seed();
        store.setAreaZoom(a, 23.456789);
        expect(store.getAllAreaUserData(a)).toEqual({});
        expect(store.toMudletMapForSave().areas[a].userData['system.fallback_map2DZoom']).toBe('23.4568');
        const back = reload(saveBytes(store));
        expect(back.getAreaZoom(a)).toBeCloseTo(23.4568, 6);
        expect(back.getAllAreaUserData(a)).toEqual({});
    });

    it('restores label font and outline colour from their keys', () => {
        const { store, a } = seed();
        store.createMapLabel(a, 'Fancy', 0, 0, 0, 10, 20, 30, 0, 0, 0,
            { fontName: 'DejaVu Sans', fontSize: 14, outline: { r: 1, g: 2, b: 3 } });
        const map = store.toMudletMapForSave();
        expect(map.areas[a].userData['system.labelFont_0']).toBe('DejaVu Sans|14|400|0');
        expect(map.areas[a].userData['system.labelOutlineColor_0']).toBe('1|2|3|255');

        const back = reload(Buffer.from(writeMapToBuffer(map)));
        const label = back.toMudletMap().labels[a][0] as MapLabel;
        expect(label.fontName).toBe('DejaVu Sans');
        expect(label.fontSize).toBe(14);
        expect(label.outlineColor).toMatchObject({ r: 1, g: 2, b: 3, alpha: 255 });
        expect(back.getAllAreaUserData(a)).toEqual({});
        // ...and writes them back unchanged.
        expect(back.toMudletMapForSave().areas[a].userData['system.labelFont_0']).toBe('DejaVu Sans|14|400|0');
    });

    it('leaves system.* keys alone in a Mudlet JSON map, whose reader does too', () => {
        const json = JSON.stringify({
            formatVersion: 1,
            areas: [{ id: 1, name: 'A', userData: { 'system.fallback_map2DZoom': '20' }, rooms: [
                { id: 1, coordinates: [0, 0, 0], userData: {} },
            ] }],
        });
        const store = new MapStore();
        expect(store.loadFromJsonString(json)).toBe(true);
        expect(store.getAllAreaUserData(1)).toEqual({ 'system.fallback_map2DZoom': '20' });
    });
});

describe('map labels in a v20 file (#285 item 4)', () => {
    it('leaves temporary labels out of the file', () => {
        const { store, a } = seed();
        store.createMapLabel(a, 'Keep', 0, 0, 0, 255, 255, 255, 0, 0, 0);
        store.createMapLabel(a, 'Drop', 0, 0, 0, 255, 255, 255, 0, 0, 0, { temporary: true });
        const back = reload(saveBytes(store));
        expect(back.toMudletMap().labels[a].map(l => l.text)).toEqual(['Keep']);
    });

    it('carries a label pixmap through the file', () => {
        const { store, a } = seed();
        store.createMapLabel(a, 'Img', 0, 0, 0, 255, 255, 255, 0, 0, 0);
        (store.toMudletMap().labels[a][0] as MapLabel).pixMap = PNG_1X1;
        const back = reload(saveBytes(store));
        expect(back.toMudletMap().labels[a][0].pixMap).toBe(PNG_1X1);
        // The store still holds the base64 string after the save.
        expect(store.toMudletMap().labels[a][0].pixMap).toBe(PNG_1X1);
    });

    it('writes a non-PNG pixmap (an image label path) as no image, not as junk', () => {
        const { store, a } = seed();
        store.createMapImageLabel(a, 'images/castle.png', 0, 0, 0, 2, 2);
        store.createMapLabel(a, 'After', 0, 0, 0, 255, 255, 255, 0, 0, 0);
        const back = reload(saveBytes(store));
        // Everything after the image label still reads back.
        expect(back.toMudletMap().labels[a].map(l => l.text)).toEqual(['', 'After']);
        expect(back.roomExists(101)).toBe(true);
    });
});

