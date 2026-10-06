// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Buffer } from 'buffer';
import { configure, InMemory, mkdirSync, writeFileSync, readFileSync } from '@zenfs/core';
import { readMapFromBuffer, writeMapToBuffer } from 'mudlet-map-binary-reader';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { MapStore } from '../../src/map/MapStore';
import { withLabelPixmapBytes } from '../../src/map/labelPixmap';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import { unzlibSync } from 'fflate';

/** Size and unfiltered RGBA pixels of an 8-bit RGBA PNG whose rows all use
 *  filter 0 — the PNGs the label pixmap encoder writes. */
function decodePng(base64: string): { width: number; height: number; pixels: Uint8Array } {
    const bytes = Buffer.from(base64, 'base64');
    expect([...bytes.subarray(1, 4)].map(c => String.fromCharCode(c)).join('')).toBe('PNG');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const idat: Buffer[] = [];
    for (let off = 8; off < bytes.length;) {
        const len = bytes.readUInt32BE(off);
        if (bytes.toString('latin1', off + 4, off + 8) === 'IDAT') idat.push(bytes.subarray(off + 8, off + 8 + len));
        off += 12 + len;
    }
    const raw = unzlibSync(Buffer.concat(idat));
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        expect(raw[y * (width * 4 + 1)]).toBe(0);
        pixels.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
    }
    return { width, height, pixels };
}

// Issue #334: the map files Mudlet Web writes, read against what desktop
// writes for the same map — image labels carrying their image, saveJsonMap's
// top-level fields, and no sysMapLoadEvent.

const PROFILE = '/profiles/map-parity';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('map files match desktop (issue #334)', () => {
    let t: TestRuntime;

    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        writeFileSync(`${PROFILE}/img.png`, Buffer.from(PNG_1X1, 'base64'));
        writeFileSync(`${PROFILE}/not-an-image.png`, 'hello');
        // The constructor is private: mount() insists on IndexedDB or a linked
        // folder, neither of which exists under node.
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        t = await createTestRuntime({ vfs: new Ctor('map-parity', {}, 'idb') });
        t.run(`H = getMudletHomeDir()`);
    });

    afterAll(() => t.dispose());

    describe('createMapImageLabel', () => {
        it('stores the image, not its path, with desktop\'s black foreground', () => {
            const a = t.run('return (addAreaName("Images"))') as number;
            expect(t.run(`return (createMapImageLabel(${a}, H .. "/img.png", 1, 2, 0, 3, 3, 20, true))`)).toBe(0);
            expect(t.run(`return (getMapLabel(${a}, 0)).Pixmap`)).toBe(PNG_1X1);
            expect(t.run(`local c = getMapLabel(${a}, 0).FgColor; return c.r .. "," .. c.g .. "," .. c.b`))
                .toBe('0,0,0');
        });

        // TLuaInterpreter::createMapImageLabel: the tenth argument is
        // `temporary`, and TMap::createMapImageLabel hard-codes noScaling off.
        it('takes desktop\'s temporary argument and always scales', () => {
            const a = t.run('return (addAreaName("Flags"))') as number;
            t.run(`createMapImageLabel(${a}, H .. "/img.png", 0, 0, 0, 1, 1, 1, false)`);
            t.run(`createMapImageLabel(${a}, H .. "/img.png", 0, 0, 0, 1, 1, 1, true, true)`);
            const label = (id: number, k: string) => t.run(`return (getMapLabel(${a}, ${id})).${k}`);
            expect([label(0, 'OnTop'), label(0, 'Scaling'), label(0, 'Temporary')]).toEqual([false, true, false]);
            expect([label(1, 'OnTop'), label(1, 'Scaling'), label(1, 'Temporary')]).toEqual([true, true, true]);
            expect(t.run(`local c = getMapLabel(${a}, 0).BgColor; return c.r .. "," .. c.g .. "," .. c.b`))
                .toBe('0,0,0');
            // A temporary label is left out of the saved map.
            expect(t.run(`return (saveJsonMap(H .. "/flags.json"))`)).toBe(true);
            const doc = JSON.parse(String(readFileSync(`${PROFILE}/flags.json`, 'utf8')));
            const labels = doc.areas.find((x: { id: number }) => x.id === a).labels;
            expect(labels.map((l: { id: number }) => l.id)).toEqual([0]);
            // TMapLabel's colours: opaque black, both of them.
            expect(labels[0].colors).toEqual([{ color24RGB: [0, 0, 0] }, { color24RGB: [0, 0, 0] }]);
        });

        it('keeps the image through a saved .dat and through saveJsonMap', () => {
            const a = t.run('return (addAreaName("Kept"))') as number;
            t.run(`createMapImageLabel(${a}, H .. "/img.png", 0, 0, 0, 2, 2, 10, true)`);

            // The binary file, as WindowManager.saveMap writes it.
            const bytes = Buffer.from(writeMapToBuffer(withLabelPixmapBytes(t.api.map.toMudletMapForSave())));
            const reloaded = new MapStore();
            reloaded.loadFromBinary(readMapFromBuffer(bytes));
            expect(reloaded.toMudletMap().labels[a][0].pixMap).toBe(PNG_1X1);

            expect(t.run(`return (saveJsonMap(H .. "/labels.json"))`)).toBe(true);
            const doc = JSON.parse(String(readFileSync(`${PROFILE}/labels.json`, 'utf8')));
            const area = doc.areas.find((x: { id: number }) => x.id === a);
            expect(area.labels[0].image.join('')).toBe(PNG_1X1);
        });

        // TMap::createMapImageLabel paints the image onto a transparent
        // width*zoom x height*zoom pixmap; a file Qt cannot read leaves it
        // transparent — still a picture, not nothing.
        it('makes a missing or unreadable file a transparent pixmap of desktop\'s size', () => {
            const a = t.run('return (addAreaName("Missing"))') as number;
            t.run(`createMapImageLabel(${a}, H .. "/nope.png", 0, 0, 0, 4, 5, 10, true)`);
            t.run(`createMapImageLabel(${a}, H .. "/not-an-image.png", 0, 0, 0, 1, 1, 3, true)`);
            const blank = decodePng(String(t.run(`return (getMapLabel(${a}, 0)).Pixmap`)));
            expect([blank.width, blank.height]).toEqual([40, 50]);
            expect(blank.pixels.every(v => v === 0)).toBe(true);
            const junk = decodePng(String(t.run(`return (getMapLabel(${a}, 1)).Pixmap`)));
            expect([junk.width, junk.height]).toEqual([3, 3]);
        });

        // Upstream's Mapper_spec writes its label image as XPM, so a script can
        // make one with io.write; desktop reads it like any other picture.
        it('reads an XPM image and scales it to the label', () => {
            t.run(`
                local f = io.open(H .. "/two.xpm", "w")
                f:write('/* XPM */\\nstatic char * x[] = {\\n"2 1 2 1",\\n"a c #ff0000",\\n"b c None",\\n"ab"};\\n')
                f:close()`);
            const a = t.run('return (addAreaName("Xpm"))') as number;
            t.run(`createMapImageLabel(${a}, H .. "/two.xpm", 0, 0, 0, 2, 1, 2, true)`);
            const png = decodePng(String(t.run(`return (getMapLabel(${a}, 0)).Pixmap`)));
            expect([png.width, png.height]).toEqual([4, 2]);
            const px = (x: number, y: number) => [...png.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
            expect(px(0, 0)).toEqual([255, 0, 0, 255]);
            expect(px(1, 1)).toEqual([255, 0, 0, 255]);
            expect(px(2, 0)).toEqual([0, 0, 0, 0]);
            expect(px(3, 1)).toEqual([0, 0, 0, 0]);
        });
    });

    describe('saveJsonMap', () => {
        const save = (): Record<string, unknown> => {
            expect(t.run(`return (saveJsonMap(H .. "/map.json"))`)).toBe(true);
            return JSON.parse(String(readFileSync(`${PROFILE}/map.json`, 'utf8')));
        };

        it('writes desktop\'s top-level fields', () => {
            const a = t.run('return (addAreaName("Counted"))') as number;
            t.run(`addRoom(9001); setRoomArea(9001, ${a}); addRoom(9002); setRoomArea(9002, ${a})`);
            t.run(`createMapLabel(${a}, "Note", 0, 0, 0, 255, 255, 255, 0, 0, 0)`);
            const doc = save();
            const areas = doc.areas as { id: number; roomCount: number; rooms: unknown[]; labels: unknown[] }[];

            expect(doc.areaCount).toBe(areas.length);
            expect(doc.roomCount).toBe(areas.reduce((n, x) => n + x.rooms.length, 0));
            expect(doc.labelCount).toBe(areas.reduce((n, x) => n + x.labels.length, 0));
            expect(areas.find(x => x.id === a)!.roomCount).toBe(2);
            for (const area of areas) expect(area.roomCount).toBe(area.rooms.length);

            expect(doc.defaultAreaName).toBe('Default Area');
            expect(doc.anonymousAreaName).toBe('Unnamed Area');
            expect(doc.playerRoomStyle).toBe(0);
            expect(doc.playerRoomOuterDiameterPercentage).toBe(120);
            expect(doc.playerRoomInnerDiameterPercentage).toBe(70);
            expect(doc.playerRoomColors).toEqual([{ color24RGB: [255, 0, 0] }, { color24RGB: [255, 255, 255] }]);
            // QFont::toString(), not the bare family: desktop reads the size
            // out of the second field.
            expect(String(doc.mapSymbolFontDetails).split(',').slice(1, 2)).toEqual(['12']);
        });

        it('writes and reads envToColorMapping as desktop does', () => {
            const doc = save();
            const imported = { ...doc, envToColorMapping: { '300': 4 } };
            writeFileSync(`${PROFILE}/env.json`, JSON.stringify(imported));
            expect(t.run(`return (loadJsonMap(H .. "/env.json"))`)).toBe(true);
            expect(save().envToColorMapping).toEqual({ '300': 4 });
        });

        it('carries an imported file\'s player-room settings and font family back out', () => {
            const imported = JSON.parse(JSON.stringify(save()));
            imported.playerRoomStyle = 2;
            imported.playerRoomOuterDiameterPercentage = 150;
            imported.playerRoomInnerDiameterPercentage = 40;
            imported.playerRoomColors = [{ color32RGBA: [1, 2, 3, 100] }, { color24RGB: [4, 5, 6] }];
            const family = String(imported.mapSymbolFontDetails).split(',')[0];
            imported.mapSymbolFontDetails = `${family},14,-1,5,50,0,0,0,0,0`;
            writeFileSync(`${PROFILE}/imported.json`, JSON.stringify(imported));
            expect(t.run(`return (loadJsonMap(H .. "/imported.json"))`)).toBe(true);
            // The family alone, not the whole QFont string, is the setting.
            expect(t.run(`return (getConfig("mapSymbolFont"))`)).toBe(family);

            const doc = save();
            expect(doc.playerRoomStyle).toBe(2);
            expect(doc.playerRoomOuterDiameterPercentage).toBe(150);
            expect(doc.playerRoomInnerDiameterPercentage).toBe(40);
            expect(doc.playerRoomColors).toEqual([{ color32RGBA: [1, 2, 3, 100] }, { color24RGB: [4, 5, 6] }]);
        });
    });
});

describe('loadJsonMap raises no sysMapLoadEvent (issue #334)', () => {
    it('loads the map without an event desktop never raises', () => {
        const src = new MapStore();
        src.addRoom(1);
        const wm = new WindowManager();
        const events: string[] = [];
        wm.onRaiseEvent = (event) => events.push(event);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(wm.loadJsonMap(src.toMudletJsonString())).toBe(true);
        } finally {
            warn.mockRestore();
        }
        expect(wm.mapStore.roomExists(1)).toBe(true);
        expect(events).not.toContain('sysMapLoadEvent');
    });
});
