import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type * as net from 'net';
import { WebSocket, type RawData } from 'ws';

// Chosen memory ceilings, not traffic-rate estimates. There is no expiry timer.
const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024 * 1024;
const configuredMax = Number.parseInt(process.env.SESSION_RESUME_MAX ?? '', 10);
const MAX_RESUMABLE_SESSIONS = configuredMax > 0 ? configuredMax : 32;

// Reserve at offer time; an unaccepted offer still occupies a slot.
const reserved = new Set<RelaySession>();

type Control = Record<string, unknown>;

/** Sessions that opted in, by id. Memory only: a relay restart ends them all. */
const sessions = new Map<string, RelaySession>();

// WebSocket close.reason is capped at 123 bytes by the spec; trim defensively.
function clipReason(text: string): string {
    return text.length > 120 ? text.slice(0, 120) : text;
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === WebSocket.OPEN) {
        try { ws.close(code, clipReason(reason)); } catch { /* ignore */ }
    }
}

/** Out-of-band control message to the client. Sent as a **text** frame; MUD
 *  bytes always travel as binary frames, so the client can route the two apart
 *  without an envelope. Proxies predating TLS support simply never send these,
 *  which is what lets the client detect an out-of-date proxy. */
function sendControl(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

const toBuffer = (data: RawData): Buffer =>
    Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

const isControl = (value: unknown): value is Control =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseControl(bytes: Buffer): Control | null {
    try {
        const msg: unknown = JSON.parse(bytes.toString());
        return isControl(msg) ? msg : null;
    } catch {
        return null;
    }
}

/** Offsets travel as decimal strings so JSON never rounds them. */
const offsetOf = (value: unknown): bigint | null =>
    typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null;

/** One game-stream range: an unsigned 64-bit big-endian starting offset, then the bytes. */
function frame(offset: bigint, bytes: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(offset);
    return Buffer.concat([head, bytes]);
}

/** After opt-in, the relay owns the game link; losing the frontend only detaches.
 *  Replacements authenticate before taking over and replay unacknowledged bytes. */
export class RelaySession {
    tcp: net.Socket | null = null;
    private readonly id = randomUUID();
    private readonly secret = randomBytes(32);
    private readonly offerId: string | null;
    private enabled = false;
    private connected = false;
    private input = 0n;
    private output = 0n;
    private released = 0n;
    private retained: { end: bigint; framed: Buffer }[] = [];
    private retainedBytes = 0;
    /** Replay the TLS verdict before any retained game output. */
    private tlsEstablished: Control | null = null;

    constructor(private ws: WebSocket | null, private readonly origin: string | null, offer: boolean) {
        if (offer && reserved.size >= MAX_RESUMABLE_SESSIONS) offer = false;   // full: the plain proxy, as ever
        if (offer) reserved.add(this);
        this.offerId = offer ? randomUUID() : null;
        if (this.offerId !== null) this.control({ type: 'session.offer', offerId: this.offerId });
    }

    control(payload: Control): void {
        if (payload.type === 'tls.established') this.tlsEstablished = payload;
        if (this.ws) sendControl(this.ws, payload);
    }

    gameConnected(): void {
        this.connected = true;
        this.control({ type: 'game.connected' });
    }

    fromGame(chunk: Buffer): void {
        const offset = this.output;
        this.output += BigInt(chunk.length);
        if (!this.enabled) {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk, { binary: true });
            return;
        }
        const framed = frame(offset, chunk);
        this.retained.push({ end: this.output, framed });
        this.retainedBytes += framed.length;
        if (this.retainedBytes > MAX_RETAINED_OUTPUT_BYTES) this.close(1011, 'Retained output buffer exhausted', true);
        else this.send(framed);
    }

    fromClient(ws: WebSocket, data: RawData, isBinary: boolean): void {
        if (ws !== this.ws) return;                       // a replaced attachment can no longer write
        const bytes = toBuffer(data);
        if (!isBinary && this.handleControl(ws, bytes)) return;
        if (!this.enabled) {                              // the plain proxy: every frame is game input
            this.input += BigInt(bytes.length);
            this.write(bytes);
            return;
        }
        if (!isBinary) return;
        if (bytes.length < 8) { this.close(1002, 'Malformed input envelope', true); return; }
        const start = bytes.readBigUInt64BE(0);
        const end = start + BigInt(bytes.length - 8);
        if (start > this.input) { this.close(1002, 'Input range skipped bytes', true); return; }
        if (end > this.input) {                           // below the cursor was accepted already
            this.write(bytes.subarray(8 + Number(this.input - start)));
            this.input = end;
        }
        this.control({ type: 'session.ack', input: this.input.toString() });
    }

    frontClosed(ws: WebSocket): void {
        if (ws !== this.ws) return;
        this.ws = null;
        if (!this.enabled) {
            this.tcp?.destroy();
            reserved.delete(this);
        }
    }

    authorized(msg: Control, origin: string | null): boolean {
        if (origin !== this.origin || typeof msg.secret !== 'string') return false;
        const given = Buffer.from(msg.secret, 'base64');
        return given.length === this.secret.length && timingSafeEqual(given, this.secret);
    }

    /** Validate all cursors before displacing the current frontend. */
    resume(ws: WebSocket, msg: Control): boolean {
        const read = offsetOf(msg.output);
        const acked = offsetOf(msg.inputAcked);
        const submitted = offsetOf(msg.inputEnd);
        if (read === null || acked === null || submitted === null
            || read < this.released || read > this.output || acked > this.input || this.input > submitted) return false;
        this.release(read);
        this.ws?.terminate();
        this.ws = ws;
        this.control({ type: 'session.resumed', input: this.input.toString(), backendConnected: this.connected });
        if (this.tlsEstablished) this.control(this.tlsEstablished);
        for (const { framed } of this.retained) this.send(framed);
        return true;
    }

    end(requester: WebSocket): void {
        if (requester !== this.ws) {
            sendControl(requester, { type: 'session.ended' });
            safeClose(requester, 1000, 'Session ended');
        }
        this.close(1000, 'Session ended');
    }

    private handleControl(ws: WebSocket, bytes: Buffer): boolean {
        const msg = parseControl(bytes);
        if (msg === null) return false;
        if (msg.type === 'session.cancel' && this.offerId !== null && msg.offerId === this.offerId) {
            // Accept may have arrived before the client received its marker.
            this.close(1000, 'Session cancelled before it was taken over');
            return true;
        }
        if (!this.enabled) {
            if (msg.type !== 'session.accept' || this.offerId === null || msg.offerId !== this.offerId) return false;
            this.enabled = true;
            this.released = this.output;                  // the raw prefix was delivered unretained
            sessions.set(this.id, this);
            this.control({
                type: 'session.enabled', sessionId: this.id, secret: this.secret.toString('base64'),
                input: this.input.toString(), output: this.output.toString(),
            });
        } else if (msg.type === 'session.ack') {
            const acked = offsetOf(msg.output);
            if (acked !== null && acked <= this.output) this.release(acked);
        } else if (msg.type === 'session.end' && this.authorized(msg, this.origin)) {
            this.end(ws);
        }
        return true;
    }

    private release(upTo: bigint): void {
        if (upTo <= this.released) return;
        this.released = upTo;
        let done = 0;
        while (done < this.retained.length && this.retained[done].end <= upTo) this.retainedBytes -= this.retained[done++].framed.length;
        this.retained.splice(0, done);
    }

    private send(framed: Buffer): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(framed, { binary: true });
    }

    private write(bytes: Buffer): void {
        if (!this.tcp?.writable) return;
        try {
            this.tcp.write(bytes);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[proxy] Failed to forward message:', message);
            this.close(1011, `Proxy: TCP write error: ${message}`);
        }
    }

    /** A failed stream must not trigger auto-reconnect and a fresh login. */
    close(code: number, reason: string, failed = false): void {
        sessions.delete(this.id);
        reserved.delete(this);
        const ws = this.ws;
        this.ws = null;
        this.retained = [];
        this.retainedBytes = 0;
        if (ws) {
            if (this.enabled) sendControl(ws, { type: 'session.ended', failed });
            safeClose(ws, code, reason);
        }
        this.tcp?.destroy();
    }
}

/** This endpoint never dials a backend; authenticate its first message. */
export function acceptResume(ws: WebSocket, origin: string | null): void {
    let owner: RelaySession | null = null;
    const refuse = (reason: string): void => {
        sendControl(ws, { type: 'session.unavailable', reason });
        safeClose(ws, 1008, 'Resume request refused');
    };
    ws.on('close', () => owner?.frontClosed(ws));
    ws.on('error', () => owner?.frontClosed(ws));
    ws.once('message', (data, isBinary) => {
        const msg = isBinary ? null : parseControl(toBuffer(data));
        const session = typeof msg?.sessionId === 'string' ? sessions.get(msg.sessionId) : undefined;
        if (!msg || !session || !session.authorized(msg, origin)) { refuse('unavailable'); return; }
        if (msg.type === 'session.end') { session.end(ws); return; }
        if (msg.type !== 'session.resume' || !session.resume(ws, msg)) { refuse('cursor'); return; }
        owner = session;
        ws.on('message', (frameData, binary) => session.fromClient(ws, frameData, binary));
    });
}
