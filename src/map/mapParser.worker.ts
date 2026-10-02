import { Buffer } from 'buffer';
import { readMapFromBuffer, streamRooms, writeMapToBuffer, type MudletLabel, type MudletMap, type MudletMapHeader, type MudletRoom } from 'mudlet-map-binary-reader';
import { withLabelPixmapBytes } from './labelPixmap';

/** Rooms per streamed batch. Clone cost is per-room either way, so batch size
 *  only trades message count against granularity: smaller batches give the
 *  progress bar more steps and hand the main thread shorter chunks of ingest
 *  work between paints. 2k keeps the message count in the low hundreds even for
 *  a million-room map. */
const STREAM_BATCH = 2000;

type Req =
    | { id: number; kind: 'parse'; buf: ArrayBuffer }
    | { id: number; kind: 'parseStream'; buf: ArrayBuffer }
    | { id: number; kind: 'serialize'; map: MudletMap };
type Res =
    | { id: number; ok: true; kind: 'parse'; map: MudletMap }
    | { id: number; ok: true; kind: 'header'; header: MudletMapHeader; totalRooms: number }
    | { id: number; ok: true; kind: 'rooms'; rooms: [number, MudletRoom][] }
    | { id: number; ok: true; kind: 'done' }
    | { id: number; ok: true; kind: 'serialize'; bytes: ArrayBuffer }
    | { id: number; ok: false; error: string };

/** Label pixmaps arrive as raw QByteArray Buffers. Converting them to base64
 *  before they cross the worker boundary keeps the main thread's later
 *  lodash.cloneDeep (inside readerExport, on every renderer refresh) from
 *  walking each one via cloneArrayBuffer — ~350ms each on label-heavy maps.
 *  Strings are structurally cheap to clone. */
function normalizePixmaps(labels: Record<number, MudletLabel[]> | undefined): void {
    for (const arr of Object.values(labels ?? {})) {
        for (const label of arr) {
            const pm = label.pixMap as unknown;
            if (pm && typeof pm !== 'string') {
                try { label.pixMap = Buffer.from(pm as Uint8Array).toString('base64'); }
                catch { label.pixMap = ''; }
            }
        }
    }
}

// `WebWorker` isn't in this project's tsconfig lib (it conflicts with DOM
// types); cast self to a minimal post-message shape rather than pull it in.
const ctx = self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void };

self.addEventListener('message', (event: MessageEvent<Req>) => {
    const req = event.data;
    try {
        if (req.kind === 'serialize') {
            // Inverse of the parse-side conversion below: label pixMaps live in
            // the store as base64 strings (cheap to structured-clone and JSON),
            // but writeMapToBuffer needs the raw QByteArray bytes. Without this,
            // qtdatastream's Buffer.concat throws "list argument must be an Array
            // of Buffers" and the ENTIRE map save fails (zoom, edits, hidden
            // rooms — everything that round-trips through saveMap).
            // Serialise the map binary off the main thread. writeMapToBuffer
            // returns a Buffer backed by the polyfill's pool, so copy into a
            // standalone ArrayBuffer we can transfer back without dragging the
            // whole pool along.
            const buf = writeMapToBuffer(withLabelPixmapBytes(req.map));
            const out = new ArrayBuffer(buf.byteLength);
            new Uint8Array(out).set(buf);
            const res: Res = { id: req.id, ok: true, kind: 'serialize', bytes: out };
            ctx.postMessage(res, [out]);
            return;
        }
        if (req.kind === 'parseStream') {
            // Room-by-room walk: the worker holds the header plus one batch,
            // never the whole room graph, and each batch is handed to the main
            // thread (and dropped here) as it's produced. Peak memory is
            // therefore `buffer + batch` on this side instead of a full object
            // graph that then gets structured-cloned — i.e. two copies live at
            // once — the way the eager 'parse' path works.
            let batch: [number, MudletRoom][] = [];
            streamRooms(
                Buffer.from(req.buf),
                (id, room) => {
                    batch.push([id, room]);
                    if (batch.length >= STREAM_BATCH) {
                        ctx.postMessage({ id: req.id, ok: true, kind: 'rooms', rooms: batch } satisfies Res);
                        batch = [];
                    }
                },
                (header) => {
                    normalizePixmaps(header.labels);
                    // The rooms section is unframed, but every area lists its
                    // room ids — sum them for a progress denominator.
                    let totalRooms = 0;
                    for (const area of Object.values(header.areas ?? {})) totalRooms += area.rooms?.length ?? 0;
                    ctx.postMessage({ id: req.id, ok: true, kind: 'header', header, totalRooms } satisfies Res);
                },
            );
            if (batch.length > 0) {
                ctx.postMessage({ id: req.id, ok: true, kind: 'rooms', rooms: batch } satisfies Res);
            }
            ctx.postMessage({ id: req.id, ok: true, kind: 'done' } satisfies Res);
            return;
        }
        const map = readMapFromBuffer(Buffer.from(req.buf));
        normalizePixmaps(map.labels);
        const res: Res = { id: req.id, ok: true, kind: 'parse', map };
        ctx.postMessage(res);
    } catch (err) {
        const res: Res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
        ctx.postMessage(res);
    }
});
