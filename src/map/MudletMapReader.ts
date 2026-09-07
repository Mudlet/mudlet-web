// MapReader is referenced for its types only — the concrete reader is no
// longer constructed here — so importing it as a type keeps the renderer's
// Konva-dependent entry point out of this module's runtime graph.
import type {MapReader, IArea, IMapReader, ViewportBounds, ViewportDataSource, HashLookupCapable} from 'mudlet-map-renderer';
import {buildSkeleton, SkeletonMapReader} from 'mudlet-map-renderer/bigmap';
import {readerExport} from 'mudlet-map-binary-reader';
import type {MudletLabel, MudletMap} from 'mudlet-map-binary-reader';
import {Buffer} from 'buffer';
import type {MapStore} from './MapStore';

// The renderer's `MapData.Room` / `MapData.Map` types live in a global
// namespace inside the package and aren't re-exported by name; derive the
// concrete shapes from `MapReader`'s public surface so Mudlet Web's tsc resolves
// them without needing the namespace.
type RoomShape = ReturnType<MapReader['getRoom']>;
type MapShape = ConstructorParameters<typeof MapReader>[0];

/** No viewport applied: every room materialises. What a fresh reader starts
 *  with, and what the export path wants (an export narrowed to the on-screen
 *  viewport would silently crop the image). */
const UNBOUNDED: ViewportBounds = {
    minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity,
};

/**
 * Live {@link IMapReader} backed by Mudlet's {@link MapStore}.
 *
 * The renderer is constructed once on panel mount and held for the lifetime of
 * the panel. Whenever the store mutates (script-built rooms, binary load,
 * setRoomCoordinates, …) the panel calls {@link refresh}; this rebuilds the
 * inner reader from the store's current snapshot. The renderer's `MapState`
 * notices the new `IArea` instance via reference inequality and rebuilds the
 * scene — no Konva stage / event listener teardown.
 *
 * The inner reader is a {@link SkeletonMapReader}: rooms live in compact
 * typed-array columns and are materialised per viewport, instead of the
 * concrete `MapReader`'s full object graph. Nothing is dropped — the skeleton
 * is built from the complete map and keeps every room, with rooms carrying
 * visual detail (symbols, custom lines, special exits, doors, stubs, exit
 * locks) materialised in full — it only changes how the *renderer* holds them.
 * That matters because the concrete reader's costs scale with the whole plane
 * rather than what's on screen: on a 250k-room map, constructing it took ~7s
 * and the first scene build ~9s, all synchronous on the main thread.
 *
 * Being a {@link ViewportDataSource} is what unlocks that: the interactive
 * backend pushes padded camera bounds before every scene build and only
 * rebuilds when the camera leaves the padding. The capability is detected by
 * duck-typing (`viewportAware === true`), so this wrapper has to re-declare it
 * and forward — a plain `IMapReader` facade would silently opt out of the
 * virtualization and fall back to materialising everything.
 *
 * The renderer's wire format (`{mapData, colors}`) is produced via
 * `readerExport(store.toMudletMap())` — the same transformation Mudlet's own
 * binary-reader pipeline applies. Doing it inside the reader (instead of in
 * the panel) keeps `MapPanel` pure-view: it never sees the wire format.
 */
export class MudletMapReader implements IMapReader, ViewportDataSource, HashLookupCapable {
    readonly viewportAware = true as const;
    readonly hashLookupCapable = true as const;
    private inner: SkeletonMapReader;
    private snapshotVersion = -1;
    /** Last viewport the renderer pushed. Held here because a store-driven
     *  rebuild replaces the inner reader, and a fresh one defaults to
     *  unbounded — re-applying keeps the next scene build scoped to where the
     *  camera actually is instead of materialising the whole plane once. */
    private viewport: ViewportBounds = UNBOUNDED;

    constructor(private readonly store: MapStore) {
        this.inner = this.buildInner();
    }

    /** Rebuild the inner reader from MapStore's current snapshot. Safe to
     *  call from a store-change subscriber — cheap when the store is empty
     *  and idempotent when no mutation has happened since the last refresh. */
    refresh(): void {
        const storeVersion = this.store.getVersion();
        if (storeVersion === this.snapshotVersion) return;
        this.inner = this.buildInner();
        this.snapshotVersion = storeVersion;
    }

    /**
     * Stale-check before every public read. The renderer can ask for a room
     * synchronously after a script mutation (e.g. addRoom → centerview),
     * before MapStore's microtask-delayed notify fires. Running the version
     * check on every call is O(1); a real rebuild only happens when the
     * store has actually mutated since the last snapshot.
     */
    private ensureFresh(): void {
        if (this.store.getVersion() !== this.snapshotVersion) {
            this.refresh();
        }
    }

    /** True once the store has at least one room; the panel's empty-state
     *  overlay stays up until this flips. */
    hasData(): boolean {
        return !this.store.isEmpty();
    }

    private buildInner(): SkeletonMapReader {
        const mudletMap = this.store.toMudletMap();
        if (Object.keys(mudletMap.rooms).length === 0) {
            return new SkeletonMapReader(buildSkeleton([], []));
        }
        // MapStore holds label pixmaps as base64 strings (the worker normalizes
        // them on the way in, so they stay cheap to structured-clone and JSON).
        // readerExport's convertLabel assumes raw bytes and runs them through a
        // byte-wise base64 encoder, which on a string reads characters as byte
        // values and emits garbage. Hand it an empty buffer per label instead,
        // then patch the renderer-format output back with the strings we
        // already have.
        const emptyBuf = Buffer.alloc(0);
        const pixmapByArea = new Map<string, string[]>();
        const strippedLabels: Record<number, MudletLabel[]> = {};
        for (const [areaIdStr, labels] of Object.entries(mudletMap.labels ?? {})) {
            const cached: string[] = [];
            strippedLabels[Number(areaIdStr)] = labels.map(l => {
                cached.push(typeof l.pixMap === 'string' ? l.pixMap : '');
                return {...l, pixMap: emptyBuf};
            });
            pixmapByArea.set(areaIdStr, cached);
        }
        const stripped: MudletMap = {...mudletMap, labels: strippedLabels};
        const {mapData, colors} = readerExport(stripped);
        // mapData[].areaId is the same string key we indexed by; patch each
        // label's renderer-shape pixMap back to its real base64 payload.
        for (const area of mapData) {
            const cached = pixmapByArea.get(String(area.areaId));
            if (!cached) continue;
            for (let i = 0; i < area.labels.length; i++) {
                (area.labels[i] as {pixMap: string}).pixMap = cached[i] ?? '';
            }
        }
        // RendererRoom (binary-reader output) is structurally a MapData.Room
        // with `areaId` missing — the renderer reads room.area, not
        // room.areaId, so the gap is harmless. Cast through unknown to bridge.
        //
        // `gridAreas` is deliberately not passed: it would suppress cardinal
        // exit lines on grid-mode areas (which is what Mudlet does), and that
        // is a rendering change, not part of moving to a skeleton. The concrete
        // reader never had the information, so leaving it out keeps output
        // identical to before.
        const reader = new SkeletonMapReader(buildSkeleton(mapData as unknown as MapShape, colors));
        // A fresh reader is unbounded; hand it the camera's last known window
        // so the first build after a store mutation isn't a whole-plane one.
        if (this.viewport !== UNBOUNDED) reader.setViewport(this.viewport);
        return reader;
    }

    // --- IMapReader forwarding ------------------------------------------------

    getArea(areaId: number): IArea {
        this.ensureFresh();
        return this.inner.getArea(areaId);
    }

    getAreas(): IArea[] {
        this.ensureFresh();
        return this.inner.getAreas();
    }

    /** Note: a viewport-virtualized reader deliberately returns an empty list
     *  here rather than materialising every room — callers that want rooms go
     *  through a plane (which is viewport-scoped) or {@link getRoom} by id. */
    getRooms(): RoomShape[] {
        this.ensureFresh();
        return this.inner.getRooms();
    }

    getRoom(roomId: number): RoomShape {
        this.ensureFresh();
        return this.inner.getRoom(roomId);
    }

    getColorValue(envId: number): string {
        this.ensureFresh();
        return this.inner.getColorValue(envId);
    }

    getSymbolColor(envId: number, opacity?: number): string {
        this.ensureFresh();
        return this.inner.getSymbolColor(envId, opacity);
    }

    // --- ViewportDataSource ---------------------------------------------------
    // Pushed by the interactive backend before every scene build; everything
    // below must survive a store-driven rebuild of the inner reader, hence the
    // locally-held `viewport`.

    setViewport(bounds: ViewportBounds): void {
        this.viewport = bounds;
        this.ensureFresh();
        this.inner.setViewport(bounds);
    }

    getViewport(): ViewportBounds {
        this.ensureFresh();
        return this.inner.getViewport();
    }

    getPlaneRoomCount(areaId: number, z: number): number {
        this.ensureFresh();
        return this.inner.getPlaneRoomCount(areaId, z);
    }

    estimateVisibleCount(areaId: number, z: number, bounds: ViewportBounds): number {
        this.ensureFresh();
        return this.inner.estimateVisibleCount(areaId, z, bounds);
    }

    forEachInBounds(
        areaId: number,
        z: number,
        bounds: ViewportBounds,
        fn: (x: number, y: number, envId: number) => void,
    ): void {
        this.ensureFresh();
        this.inner.forEachInBounds(areaId, z, bounds, fn);
    }

    // --- HashLookupCapable ----------------------------------------------------

    /** O(1) hash → id. Needed because `getRooms()` is empty on a virtualized
     *  reader, so the scan-based fallback the renderer would otherwise use can
     *  never resolve anything. */
    getRoomIdByHash(hash: string): number | undefined {
        this.ensureFresh();
        return this.inner.getRoomIdByHash(hash);
    }

    /**
     * Drop any viewport narrowing, so subsequent reads materialise the whole
     * map again. The export path needs this: an exporter driven by a reader
     * still scoped to the on-screen camera would silently render only the
     * rooms that happen to be visible.
     */
    clearViewport(): void {
        this.viewport = UNBOUNDED;
        this.ensureFresh();
        this.inner.setViewport(UNBOUNDED);
    }
}
