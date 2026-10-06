// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { writeMapToBuffer } from 'mudlet-map-binary-reader';
import { MapStore } from '../../src/map/MapStore';
import { WindowManager } from '../../src/ui/windows/WindowManager';

// The GMCP Client.Map / sysMapDownloadEvent flow: ScriptingEngine records the
// game's MMP map URL on the WindowManager (Mudlet TMap::setMmpMapLocation) and
// the map panel's download action feeds the fetched bytes to loadMap. These
// tests pin the WindowManager half — location change notification (which
// drives the panel's "Download map from game" affordance) and bytes→ingest→
// sysMapLoadEvent, the parse step sysMapDownloadEvent fires after.
describe('WindowManager MMP map location', () => {
    it('records the url and notifies the listener only on change', () => {
        const wm = new WindowManager();
        expect(wm.mmpMapLocation).toBe('');

        const listener = vi.fn();
        wm.onMmpMapLocationChanged = listener;

        wm.setMmpMapLocation('https://example.com/map.dat');
        expect(wm.mmpMapLocation).toBe('https://example.com/map.dat');
        expect(listener).toHaveBeenCalledWith('https://example.com/map.dat');

        // Re-announcing the same location (every login) must not re-notify.
        wm.setMmpMapLocation('https://example.com/map.dat');
        expect(listener).toHaveBeenCalledTimes(1);

        wm.setMmpMapLocation('https://example.com/v2/map.dat');
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('loadMap ingests downloaded map bytes without raising an event desktop lacks', () => {
        // Serialise a real map the same way a game-published .dat would arrive.
        const src = new MapStore();
        src.addRoom(1);
        src.addRoom(2);
        const written = writeMapToBuffer(src.toMudletMapForSave());
        const buf = new ArrayBuffer(written.byteLength);
        new Uint8Array(buf).set(written);

        const wm = new WindowManager();
        // loadMap only ingests once a connection is attached; the IndexedDB
        // persistence it also kicks off is fire-and-forget and merely warns
        // in this node environment (no indexedDB) — silence it.
        wm.setConnectionId('test-connection');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const events: string[] = [];
            wm.onRaiseEvent = (event) => events.push(event);

            expect(wm.loadMap(buf)).toBe(true);
            // Desktop has no sysMapLoadEvent (issue #334): a script written
            // here to wait on it would never run there.
            expect(events).not.toContain('sysMapLoadEvent');
            expect(wm.mapStore.roomExists(1)).toBe(true);
            expect(wm.mapStore.roomExists(2)).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });

    it('loadMap returns false when the bytes cannot be parsed', () => {
        const wm = new WindowManager();
        wm.setConnectionId('test-connection');
        const events: string[] = [];
        wm.onRaiseEvent = (event) => events.push(event);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(wm.loadMap(new ArrayBuffer(0))).toBe(false);
            expect(events).not.toContain('sysMapLoadEvent');
        } finally {
            warn.mockRestore();
        }
    });
});
