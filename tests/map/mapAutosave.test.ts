// @vitest-environment node
//
// Map edits reach storage without an explicit saveMap(), as on desktop, where
// an unsaved map is autosaved (Host::autoSaveMap) and saved again on close
// (TMainConsole::closeEvent → saveMapFile). mudlet-web#187 found every room a
// script added lost on reopen, because only a MapPanel zoom change ever
// triggered a write.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const saved: ArrayBuffer[] = [];
vi.mock('../../src/storage/mapStorage', () => ({
    saveMap: async (_conn: string, bytes: ArrayBuffer) => { saved.push(bytes); },
    loadMap: async () => null,
}));
vi.mock('../../src/map/mapParserClient', () => ({
    streamMapInWorker: async () => {},
    serializeMapInWorker: async () => new ArrayBuffer(4),
    parseMapInWorker: async () => ({}),
}));

const { WindowManager } = await import('../../src/ui/windows/WindowManager');

/** Let the store's microtask-coalesced notify reach the subscriber. */
const settle = () => Promise.resolve();

describe('WindowManager — map autosave', () => {
    let wm: InstanceType<typeof WindowManager>;

    beforeEach(async () => {
        vi.useFakeTimers();
        saved.length = 0;
        wm = new WindowManager();
        wm.setConnectionId('conn');
        await wm.bootstrapMap();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not treat a freshly loaded map as unsaved', async () => {
        await settle();
        expect(wm.hasUnsavedMap()).toBe(false);
        await vi.advanceTimersByTimeAsync(WindowManager.MAP_AUTOSAVE_DELAY_MS * 2);
        expect(saved).toHaveLength(0);
    });

    it('autosaves rooms a script adds', async () => {
        wm.mapStore.addRoom(1);
        wm.mapStore.setRoomName(1, 'vRoomX');
        await settle();
        expect(wm.hasUnsavedMap()).toBe(true);
        await vi.advanceTimersByTimeAsync(WindowManager.MAP_AUTOSAVE_DELAY_MS);
        expect(saved).toHaveLength(1);
        expect(wm.hasUnsavedMap()).toBe(false);
    });

    it('is not starved by a steady stream of edits', async () => {
        for (let id = 1; id <= 30; id++) {
            wm.mapStore.addRoom(id);
            await settle();
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(saved.length).toBeGreaterThanOrEqual(2);
    });

    it('saves synchronously on page unload', async () => {
        wm.mapStore.addRoom(1);
        await settle();
        wm.flushMapSaveSync();
        // saveMap() serialised on this thread and handed the bytes over already.
        expect(saved).toHaveLength(1);
        expect(saved[0].byteLength).toBeGreaterThan(4);
        expect(wm.hasUnsavedMap()).toBe(false);
        await vi.advanceTimersByTimeAsync(WindowManager.MAP_AUTOSAVE_DELAY_MS * 2);
        expect(saved).toHaveLength(1);
    });

    it('saves on session close', async () => {
        wm.mapStore.addRoom(1);
        await settle();
        wm.flushMapSave();
        await vi.advanceTimersByTimeAsync(0);
        expect(saved).toHaveLength(1);
    });

    it('has nothing to save on unload after an explicit saveMap()', async () => {
        wm.mapStore.addRoom(1);
        await settle();
        wm.saveMap();
        expect(saved).toHaveLength(1);
        wm.flushMapSaveSync();
        expect(saved).toHaveLength(1);
    });
});
