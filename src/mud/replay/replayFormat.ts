/**
 * Mudlet binary replay (".dat") format — the files written by Mudlet's
 * "record replay" toolbar button and consumed by its `loadReplay()`.
 *
 * The on-disk layout is a bare sequence of chunk records with no header:
 *
 *     int32 BE  offsetMs   milliseconds elapsed since the previous chunk
 *     int32 BE  length     payload byte count (0..REPLAY_MAX_CHUNK)
 *     bytes     payload    the network data verbatim — post-MCCP-decompression,
 *                          pre-telnet-parsing, IAC sequences and all
 *
 * Qt's QDataStream defaults to big-endian, and Mudlet only ever streams
 * qint32s + raw bytes, so this is the complete format. One historical quirk:
 * Mudlet PR #4400 accidentally widened the offset to a qint64 for some
 * releases (the "modified format"); Mudlet's loader trial-parses the original
 * layout first and falls back, and parseReplay mirrors that so both vintages
 * load. We always *write* the original format — what current Mudlet records.
 */

export interface ReplayChunk {
    /** Milliseconds since the previous chunk (recording start for the first). */
    offsetMs: number;
    /** Raw telnet bytes as received post-MCCP. */
    data: Uint8Array;
}

/** Mudlet's replay read buffer size (cTelnet BUFFER_SIZE). A record whose
 *  length field exceeds this is treated as corrupt by Mudlet's loader, so the
 *  encoder splits bigger payloads into continuation records (offset 0). */
export const REPLAY_MAX_CHUNK = 100000;

const INT32_MAX = 0x7fffffff;

/** Latin-1 byte-string (charCode === byte) → bytes, the inverse of
 *  {@link replayBytesToLatin1}. The telnet pipeline traffics in these strings. */
export function replayLatin1ToBytes(data: string): Uint8Array {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    return bytes;
}

/** Bytes → Latin-1 byte-string, chunked to respect String.fromCharCode's
 *  argument limit on large payloads (same trick as MudClient's frame decode). */
export function replayBytesToLatin1(bytes: Uint8Array): string {
    let out = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return out;
}

/** Serialize chunks to the original (current-Mudlet) replay format. Payloads
 *  larger than {@link REPLAY_MAX_CHUNK} are split into continuation records
 *  with a 0ms offset so Mudlet itself can read the file back. Empty payloads
 *  are dropped — there is nothing in them to play. */
export function encodeReplay(chunks: ReplayChunk[]): Uint8Array {
    const records: ReplayChunk[] = [];
    for (const chunk of chunks) {
        if (chunk.data.length === 0) continue;
        const offsetMs = Math.min(Math.max(0, Math.round(chunk.offsetMs)), INT32_MAX);
        for (let start = 0; start < chunk.data.length; start += REPLAY_MAX_CHUNK) {
            records.push({
                offsetMs: start === 0 ? offsetMs : 0,
                data: chunk.data.subarray(start, start + REPLAY_MAX_CHUNK),
            });
        }
    }

    const total = records.reduce((sum, r) => sum + 8 + r.data.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let pos = 0;
    for (const record of records) {
        view.setInt32(pos, record.offsetMs, false);
        view.setInt32(pos + 4, record.data.length, false);
        out.set(record.data, pos + 8);
        pos += 8 + record.data.length;
    }
    return out;
}

/** Parse a replay file, auto-detecting the original (4-byte offset) vs the
 *  modified (8-byte offset, PR #4400 era) layout the way Mudlet's
 *  testReadReplayFile does: trial-parse original first, fall back to modified.
 *  Returns null when the data is readable as neither — "seems to be corrupt". */
export function parseReplay(bytes: Uint8Array): ReplayChunk[] | null {
    return tryParse(bytes, 4) ?? tryParse(bytes, 8);
}

function tryParse(bytes: Uint8Array, offsetSize: 4 | 8): ReplayChunk[] | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks: ReplayChunk[] = [];
    let pos = 0;
    while (pos < bytes.length) {
        if (pos + offsetSize + 4 > bytes.length) return null;
        let offsetMs: number;
        if (offsetSize === 4) {
            offsetMs = view.getInt32(pos, false);
        } else {
            // qint64 offset — reject anything a sane recording can't produce
            // (negative, or beyond int32 range), matching Mudlet's checks.
            const high = view.getInt32(pos, false);
            const low = view.getUint32(pos + 4, false);
            if (high !== 0 || low > INT32_MAX) return null;
            offsetMs = low;
        }
        const amount = view.getInt32(pos + offsetSize, false);
        // A length of zero is an empty chunk, not corruption: older Mudlets
        // recorded one whenever a compressed read inflated to nothing, and
        // Mudlet plays on past it, keeping its delay.
        if (offsetMs < 0 || amount < 0 || amount > REPLAY_MAX_CHUNK) return null;
        pos += offsetSize + 4;
        if (pos + amount > bytes.length) return null;
        chunks.push({ offsetMs, data: bytes.subarray(pos, pos + amount) });
        pos += amount;
    }
    // Chunks that are ALL empty are not a recording, they are a run of zero
    // bytes read as one: nothing would ever reach the console.
    if (chunks.length > 0 && chunks.every(c => c.data.length === 0)) return null;
    return chunks;
}

/** Total recorded duration in milliseconds (sum of chunk offsets). */
export function replayDurationMs(chunks: ReplayChunk[]): number {
    return chunks.reduce((sum, c) => sum + c.offsetMs, 0);
}

/** Mudlet-style replay file name for a recording finished at `date`:
 *  `yyyy-MM-dd#HH-mm-ss.dat`, e.g. `2026-07-08#14-03-59.dat`. */
export function replayFileName(date: Date): string {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
        `#${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}.dat`;
}
