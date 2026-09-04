// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'buffer';
import { readMapFromBuffer, writeMapToBuffer } from 'mudlet-map-binary-reader';
import { MapStore } from '../../src/map/MapStore';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import {
    MAP_MAX_SUPPORTED_VERSION,
    MAP_MIN_SUPPORTED_VERSION,
    MapVersionError,
    assertReadableMapVersion,
    readMapFormatVersion,
} from '../../src/map/mapVersion';

// A map file whose format version this build cannot read used to end as a
// console.warn and a blank map window (issue #47). Desktop Mudlet refuses such
// a file before parsing and tells the player why, on the main console
// (TMap::readMap, src/TMap.cpp:1531-1573); these tests pin that the web client
// now does the same — and that the version window it claims is the one the
// bundled reader actually implements.

/** A real, current-format map serialised the way a `.dat` arrives. */
function mapBytes(): ArrayBuffer {
    const src = new MapStore();
    src.addRoom(1);
    src.addRoom(2);
    const written = writeMapToBuffer(src.toMudletMapForSave());
    const buf = new ArrayBuffer(written.byteLength);
    new Uint8Array(buf).set(written);
    return buf;
}

/** The same bytes with the leading format-version int overwritten — exactly the
 *  repro in the issue (a v20 map with its version patched out of range). */
function mapBytesWithVersion(version: number): ArrayBuffer {
    const buf = mapBytes();
    new DataView(buf).setInt32(0, version, false);
    return buf;
}

describe('map format version gate', () => {
    it('reads the leading big-endian int32 the reader dispatches on', () => {
        expect(readMapFormatVersion(mapBytes())).toBe(MAP_MAX_SUPPORTED_VERSION);
        expect(readMapFormatVersion(mapBytesWithVersion(17))).toBe(17);
        // Too short to hold a version at all — not a number, and not a map.
        expect(readMapFormatVersion(new ArrayBuffer(2))).toBeNaN();
    });

    // mudlet-map-binary-reader does not export its supported-version list, so
    // the constants are literals; this keeps them honest across a dependency
    // bump by checking them against what the library actually does.
    it('pins the supported range to what the bundled reader implements', () => {
        expect(() => readMapFromBuffer(Buffer.from(mapBytes()))).not.toThrow();
        expect(() => readMapFromBuffer(Buffer.from(mapBytesWithVersion(MAP_MAX_SUPPORTED_VERSION + 1))))
            .toThrow(/Unsupported Mudlet map version/);
        expect(() => readMapFromBuffer(Buffer.from(mapBytesWithVersion(MAP_MIN_SUPPORTED_VERSION - 1))))
            .toThrow(/Unsupported Mudlet map version/);
    });

    it('accepts every version in range without touching the buffer', () => {
        for (let v = MAP_MIN_SUPPORTED_VERSION; v <= MAP_MAX_SUPPORTED_VERSION; v++) {
            expect(assertReadableMapVersion(mapBytesWithVersion(v))).toBe(v);
        }
    });

    it('reports a too-new map in Mudlet\'s words (src/TMap.cpp:1547)', () => {
        const err = (() => {
            try { assertReadableMapVersion(mapBytesWithVersion(21), 'Mudlet.dat'); return null; }
            catch (e) { return e as MapVersionError; }
        })();
        expect(err).toBeInstanceOf(MapVersionError);
        expect(err!.fault).toBe('too-new');
        expect(err!.version).toBe(21);
        expect(err!.messages[0]).toContain('[ ALERT ] - Map file is too new.');
        expect(err!.messages[0]).toContain('Its format version "21" is higher than this version of');
        expect(err!.messages[0]).toContain('Mudlet Web can handle (20)!');
        // Mudlet names the file it refused; so must we.
        expect(err!.messages[0]).toContain('"Mudlet.dat"');
        expect(err!.messages[1]).toBe('[ INFO ]  - You will need to update your Mudlet Web to read the map file.');
    });

    it('reports a too-old map and points at the client that still reads it', () => {
        const err = (() => {
            try { assertReadableMapVersion(mapBytesWithVersion(15)); return null; }
            catch (e) { return e as MapVersionError; }
        })();
        expect(err!.fault).toBe('too-old');
        expect(err!.messages[0]).toContain('[ ALERT ] - Map file is really old.');
        expect(err!.messages[0]).toContain('Its format version "15" is so ancient that');
        expect(err!.messages[1]).toContain('Desktop Mudlet still reads this format');
        // No file name known here, so the "The file is:" clause is left off
        // rather than quoting an empty string.
        expect(err!.messages[0]).not.toContain('The file is:');
    });

    it('reports an implausible version as not-a-map (src/TMap.cpp:1532)', () => {
        for (const version of [0, -1, 128]) {
            const err = (() => {
                try { assertReadableMapVersion(mapBytesWithVersion(version)); return null; }
                catch (e) { return e as MapVersionError; }
            })();
            expect(err!.fault).toBe('not-a-map');
            expect(err!.messages[0]).toContain('[ ALERT ] - File does not seem to be a Mudlet Map file.');
            expect(err!.messages[0]).toContain(`its format version seems to be "${version}"`);
            expect(err!.messages[1]).toBe('[ INFO ]  - Ignoring this unlikely map file.');
        }
    });
});

describe('WindowManager map load messaging', () => {
    it('loadMap posts the explanation instead of failing silently', () => {
        const wm = new WindowManager();
        wm.setConnectionId('test-connection');
        const posted: string[] = [];
        wm.onSystemMessage = (text) => posted.push(text);
        const events: string[] = [];
        wm.onRaiseEvent = (event) => events.push(event);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(wm.loadMap(mapBytesWithVersion(21), 'Mudlet.dat')).toBe(false);
        } finally {
            warn.mockRestore();
        }

        // The player is told, on the main console, exactly what Mudlet tells them.
        expect(posted).toHaveLength(2);
        expect(posted[0]).toContain('[ ALERT ] - Map file is too new.');
        expect(posted[1]).toContain('[ INFO ]  - You will need to update your Mudlet Web');
        // …and the map panel's error slot gets the one-line form.
        expect(wm.lastMapLoadError).toContain('Map file is too new: format version 21');
        // Nothing was loaded, and no script is told a map arrived.
        expect(events).not.toContain('sysMapLoadEvent');
    });

    it('loadMapAsync refuses an unreadable version before it reaches the parser', async () => {
        const wm = new WindowManager();
        wm.setConnectionId('test-connection');
        const posted: string[] = [];
        wm.onSystemMessage = (text) => posted.push(text);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // No worker is mocked here: reaching the parse at all would throw a
            // "Worker is not defined" in this environment. The gate runs first —
            // which is also what keeps the bad bytes out of IndexedDB, so a
            // rejected import cannot overwrite the profile's good map.
            await expect(wm.loadMapAsync(mapBytesWithVersion(15), 'ancient.dat')).resolves.toBe(false);
        } finally {
            warn.mockRestore();
        }
        expect(posted[0]).toContain('[ ALERT ] - Map file is really old.');
        expect(posted[0]).toContain('"ancient.dat"');
        expect(wm.lastMapLoadError).toContain('Map file is really old: format version 15');
    });

    it('clears the recorded failure once a map loads', () => {
        const wm = new WindowManager();
        wm.setConnectionId('test-connection');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(wm.loadMap(mapBytesWithVersion(21))).toBe(false);
            expect(wm.lastMapLoadError).not.toBeNull();
            expect(wm.loadMap(mapBytes())).toBe(true);
            expect(wm.lastMapLoadError).toBeNull();
        } finally {
            warn.mockRestore();
        }
    });
});
