// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MudletMapHeader, MudletRoom } from 'mudlet-map-binary-reader';
import { MapStore } from '../../src/map/MapStore';
import type { MapStreamSink } from '../../src/map/mapParserClient';

// The worker client is the seam: a real streamMapInWorker spins up a Worker,
// which doesn't exist in the node test environment. Mock it so the tests can
// drive the sink batch-by-batch and observe exactly what WindowManager
// publishes on its progress channel in between.
type Streamer = (buf: ArrayBuffer, sink: MapStreamSink) => Promise<void>;
let streamImpl: Streamer = async () => {};
vi.mock('../../src/map/mapParserClient', () => ({
    // A plain function, not vi.fn(): the mock wrapper does not forward the sink
    // argument to a two-parameter implementation under this vitest version, and
    // these tests are entirely about what the sink is fed.
    streamMapInWorker: (buf: ArrayBuffer, sink: MapStreamSink) => streamImpl(buf, sink),
    serializeMapInWorker: async () => new ArrayBuffer(0),
    parseMapInWorker: async () => ({}),
}));

/** Install the stream behaviour for one test. */
const onStream = (impl: Streamer) => { streamImpl = impl; };

const { WindowManager } = await import('../../src/ui/windows/WindowManager');

/** A stand-in for the bytes handed to the loader. The stream itself is mocked,
 *  but WindowManager reads the leading format-version int off the buffer before
 *  it parts with it (src/map/mapVersion.ts), so the stub must carry a readable
 *  one — an all-zero buffer is now refused as "not a Mudlet Map file". */
function stubMapBytes(): ArrayBuffer {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setInt32(0, 20, false);
    return buf;
}

/** Header + rooms for a small map, in the shape the worker emits. */
function fixture(roomCount: number) {
    const src = new MapStore();
    for (let id = 1; id <= roomCount; id++) src.addRoom(id);
    const map = src.toMudletMapForSave();
    const { rooms, ...header } = map;
    return {
        header: header as MudletMapHeader,
        rooms: Object.entries(rooms).map(([k, r]) => [Number(k), r] as [number, MudletRoom]),
    };
}

/** Feed a sink the way the worker does: header, then rooms in batches. */
function drive(sink: MapStreamSink, roomCount: number, batchSize: number): void {
    const { header, rooms } = fixture(roomCount);
    sink.onHeader(header, rooms.length);
    sink.onProgress?.(0, rooms.length);
    let loaded = 0;
    for (let i = 0; i < rooms.length; i += batchSize) {
        const batch = rooms.slice(i, i + batchSize);
        sink.onRooms(batch);
        loaded += batch.length;
        sink.onProgress?.(loaded, rooms.length);
    }
}

describe('WindowManager map load progress', () => {
    beforeEach(() => { streamImpl = async () => {}; });

    it('publishes a batch-by-batch trail and clears when the load finishes', async () => {
        onStream(async (_buf, sink) => drive(sink, 10, 4));
        const wm = new WindowManager();
        const seen: Array<{ loaded: number; total: number } | null> = [];
        wm.subscribeMapLoadProgress(p => seen.push(p ? { ...p } : null));

        await wm.ingestMapBufferAsync(stubMapBytes());

        // Subscribe fires immediately with the idle value, then: the pre-header
        // indeterminate tick (total 0), the header's 0/10, one per batch, the
        // renderer's build phase, null.
        expect(seen[0]).toBeNull();
        expect(seen[1]).toEqual({ loaded: 0, total: 0, phase: 'rooms' });
        expect(seen.slice(2, -1)).toEqual([
            { loaded: 0, total: 10, phase: 'rooms' },
            { loaded: 4, total: 10, phase: 'rooms' },
            { loaded: 8, total: 10, phase: 'rooms' },
            { loaded: 10, total: 10, phase: 'rooms' },
            // Rooms are all in; the wait from here is the renderer's, and on a
            // big map it is the longest part of the load.
            { loaded: 10, total: 10, phase: 'building' },
        ]);
        expect(seen.at(-1)).toBeNull();
        // Cleared, so a panel mounting later doesn't show a stale full bar.
        expect(wm.getMapLoadProgress()).toBeNull();
        expect(wm.mapStore.roomExists(10)).toBe(true);
    });

    it('reports the current value to a subscriber that arrives mid-load', async () => {
        let midLoad: { loaded: number; total: number } | null | undefined;
        onStream(async (_buf, sink) => {
            const { header, rooms } = fixture(6);
            sink.onHeader(header, rooms.length);
            sink.onProgress?.(0, rooms.length);
            sink.onRooms(rooms.slice(0, 3));
            sink.onProgress?.(3, rooms.length);
            // A MapPanel mounting here must be able to render the bar straight
            // away rather than wait for the next batch.
            wm.subscribeMapLoadProgress(p => { midLoad ??= p ? { ...p } : null; });
            sink.onRooms(rooms.slice(3));
            sink.onProgress?.(6, rooms.length);
        });
        const wm = new WindowManager();

        await wm.ingestMapBufferAsync(stubMapBytes());

        expect(midLoad).toEqual({ loaded: 3, total: 6, phase: 'rooms' });
    });

    it('clears progress and empties the store when the stream fails', async () => {
        onStream(async (_buf, sink) => {
            const { header, rooms } = fixture(6);
            sink.onHeader(header, rooms.length);
            sink.onRooms(rooms.slice(0, 3));
            sink.onProgress?.(3, rooms.length);
            throw new Error('worker died');
        });
        const wm = new WindowManager();
        const seen: Array<unknown> = [];
        wm.subscribeMapLoadProgress(p => seen.push(p));

        await expect(wm.ingestMapBufferAsync(stubMapBytes())).rejects.toThrow('worker died');

        // A stuck bar would outlive the failure and there'd be no way to clear
        // it — the load never reaches its normal completion path.
        expect(seen.at(-1)).toBeNull();
        expect(wm.getMapLoadProgress()).toBeNull();
        // Half-ingested rooms are discarded, not left queryable by scripts.
        expect(wm.mapStore.roomExists(1)).toBe(false);
    });

    it('loadMapAsync ingests, notifies the panel, and raises sysMapLoadEvent', async () => {
        onStream(async (_buf, sink) => drive(sink, 5, 2));
        const wm = new WindowManager();
        wm.setConnectionId('test-connection');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const events: string[] = [];
            wm.onRaiseEvent = (event) => events.push(event);
            const rerendered = vi.fn(() => true);
            wm.registerMapLoadCallback(rerendered);

            await expect(wm.loadMapAsync(stubMapBytes())).resolves.toBe(true);

            expect(wm.mapStore.roomExists(5)).toBe(true);
            expect(events).toContain('sysMapLoadEvent');
            expect(rerendered).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('loadMapAsync returns false and stays silent when the parse fails', async () => {
        onStream(async () => { throw new Error('bad map'); });
        const wm = new WindowManager();
        wm.setConnectionId('test-connection');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const events: string[] = [];
            wm.onRaiseEvent = (event) => events.push(event);

            await expect(wm.loadMapAsync(stubMapBytes())).resolves.toBe(false);

            expect(events).not.toContain('sysMapLoadEvent');
        } finally {
            warn.mockRestore();
        }
    });
});
