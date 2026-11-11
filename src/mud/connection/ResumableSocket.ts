/** Raw WebSocket until a relay offers retention. Retained frames carry an
 *  unsigned 64-bit big-endian byte offset, then game bytes. Credentials and
 *  cursors live only in memory; MudClient keeps its parser across reattachment. */

// A chosen memory ceiling, not a traffic-rate estimate.
const MAX_UNSETTLED_BYTES = 1024 * 1024;

type Control = Record<string, unknown>;
type MessageData = ArrayBuffer | string;

/** Sends wait while offered (marker pending) or away (transport lost). */
type Phase = 'plain' | 'offered' | 'live' | 'away' | 'ended';

const isControl = (value: unknown): value is Control =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseControl(text: string): Control | null {
    try {
        const msg: unknown = JSON.parse(text);
        return isControl(msg) ? msg : null;
    } catch {
        return null;
    }
}

/** Offsets travel as decimal strings so JSON never rounds them. */
const offsetOf = (value: unknown): bigint | null =>
    typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null;

function frame(offset: bigint, bytes: Uint8Array): Uint8Array {
    const framed = new Uint8Array(8 + bytes.length);
    new DataView(framed.buffer).setBigUint64(0, offset, false);
    framed.set(bytes, 8);
    return framed;
}

export class ResumableSocket {
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<MessageData>) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    ondetach: (() => void) | null = null;
    onresume: (() => void) | null = null;
    /** A resume/end attempt closed without an answer. */
    onunreachable: (() => void) | null = null;

    private ws: WebSocket | null = null;
    private dialing: WebSocket | null = null;
    private watching: (() => void) | null = null;
    private phase: Phase = 'plain';
    private session: { id: string; secret: string; url: string } | null = null;
    private offerId: string | null = null;
    private sent = 0n;
    private acked = 0n;
    private received = 0n;
    /** Submitted ranges retain their offsets when resent. */
    private unacked: { offset: bigint; bytes: Uint8Array }[] = [];
    private held: Uint8Array[] = [];
    private heldBytes = 0;
    private failure = false;

    constructor(private readonly baseUrl: string, protocols: string[] = []) {
        // Omit the empty subprotocol header, as on a plain connection.
        this.attach(protocols.length > 0 ? new WebSocket(baseUrl, protocols) : new WebSocket(baseUrl));
    }

    get protocol(): string { return this.ws?.protocol ?? ''; }
    get bufferedAmount(): number { return this.ws?.bufferedAmount ?? 0; }

    /** A retained session reads as open even between transports: sends are kept. */
    get readyState(): number {
        return this.phase === 'live' || this.phase === 'away' ? WebSocket.OPEN : (this.ws?.readyState ?? WebSocket.CLOSED);
    }

    get away(): boolean { return this.phase === 'away'; }

    /** The user ended the session while the relay could not be told. */
    get endPending(): boolean { return this.phase === 'ended' && this.session !== null; }

    /** Refused resume or broken stream, not an ordinary game/player disconnect. */
    get failed(): boolean { return this.failure; }

    send(data: Uint8Array): void {
        if (this.phase === 'plain') {
            this.sent += BigInt(data.length);
            this.acked = this.sent;                       // raw input is not retained for resending
            this.ws?.send(data);
        } else if (this.phase === 'live') {
            this.submit(data);
        } else if (this.phase !== 'ended') {
            this.held.push(data);
            this.heldBytes += data.length;
        }
        if (this.heldBytes + Number(this.sent - this.acked) > MAX_UNSETTLED_BYTES) {
            this.abort('Too much input is waiting on the game connection; the session cannot continue safely.');
        }
    }

    /** True even if already trying, so Connect never dials a second game. */
    resume(): boolean {
        if (this.phase !== 'away') return false;
        this.attempt();
        return true;
    }

    private attach(ws: WebSocket): void {
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = event => { if (this.ws === ws) this.onopen?.(event); };
        ws.onmessage = (event: MessageEvent<MessageData>) => { if (this.ws === ws) this.message(event); };
        ws.onclose = event => { if (this.ws === ws) this.closed(event); };
        ws.onerror = event => { if (this.ws === ws) this.onerror?.(event); };
    }

    private message(event: MessageEvent<MessageData>): void {
        const { data } = event;
        if (typeof data === 'string') {
            const msg = parseControl(data);
            if (msg === null || !this.control(msg)) this.onmessage?.(event);
        } else if (this.phase === 'plain' || this.phase === 'offered') {
            this.received += BigInt(data.byteLength);
            this.onmessage?.(event);
        } else if (this.phase !== 'ended') {
            this.range(data);
        }
    }

    /** Leave game.connected, tls.* and unoffered session controls to MudClient. */
    private control(msg: Control): boolean {
        if (this.phase === 'plain' && msg.type !== 'session.offer') return false;
        switch (msg.type) {
            case 'session.offer': this.offered(msg); return true;
            case 'session.enabled': this.enabled(msg); return true;
            case 'session.ack': {
                const accepted = offsetOf(msg.input);
                if (accepted !== null) this.release(accepted);
                return true;
            }
            case 'session.ended':
                if (msg.failed === true) this.failure = true;   // a limit or a broken stream, not the game quitting
                this.finish();
                return true;                                    // the close that follows is the ordinary one
            default: return false;
        }
    }

    private offered(msg: Control): void {
        if (this.phase !== 'plain' || typeof msg.offerId !== 'string') return;
        this.offerId = msg.offerId;
        this.phase = 'offered';
        this.ws?.send(JSON.stringify({ type: 'session.accept', offerId: msg.offerId }));
    }

    private enabled(msg: Control): void {
        if (this.phase !== 'offered') return;
        const { sessionId, secret } = msg;
        if (typeof sessionId === 'string' && typeof secret === 'string') {
            const url = new URL(this.baseUrl);
            url.pathname = `${url.pathname.replace(/\/$/, '')}/resume`;
            this.session = { id: sessionId, secret, url: url.toString() };
        }
        // Both ends number the same bytes only if the marker matches what we sent and received so far.
        if (this.session === null || offsetOf(msg.input) !== this.sent || offsetOf(msg.output) !== this.received) {
            this.abort('The proxy\'s session marker does not match this connection.');
            return;
        }
        this.flushHeld();
    }

    private flushHeld(): void {
        this.phase = 'live';
        const waiting = this.held;
        this.held = [];
        this.heldBytes = 0;
        for (const bytes of waiting) this.submit(bytes);
    }

    private submit(bytes: Uint8Array): void {
        this.unacked.push({ offset: this.sent, bytes });
        this.ws?.send(frame(this.sent, bytes));
        this.sent += BigInt(bytes.length);
    }

    private release(upTo: bigint): void {
        if (upTo <= this.acked) return;
        this.acked = upTo;
        let done = 0;
        while (done < this.unacked.length && this.unacked[done].offset + BigInt(this.unacked[done].bytes.length) <= upTo) done++;
        this.unacked.splice(0, done);
    }

    /** Discard duplicate prefixes, never skip a gap. */
    private range(data: ArrayBuffer): void {
        if (data.byteLength < 8) { this.abort('Malformed output envelope.'); return; }
        const start = new DataView(data).getBigUint64(0, false);
        const end = start + BigInt(data.byteLength - 8);
        if (start > this.received) { this.abort('The game stream skipped bytes; the session cannot continue safely.'); return; }
        if (end > this.received) {
            const skip = Number(this.received - start);
            this.received = end;                           // ours before any callback can run on it
            this.onmessage?.(new MessageEvent('message', { data: data.slice(8 + skip) }));
        }
        this.ws?.send(JSON.stringify({ type: 'session.ack', output: this.received.toString() }));
    }

    private closed(event: CloseEvent): void {
        this.ws = null;
        if (this.phase !== 'live' && this.phase !== 'away') {
            this.phase = 'ended';
            this.onclose?.(event);
            return;
        }
        const wasLive = this.phase === 'live';
        this.phase = 'away';
        if (wasLive) this.ondetach?.();
        this.watch();
    }

    /** One attempt per foreground visit, without a retry timer. */
    private watch(): void {
        if (typeof document === 'undefined') return;
        if (document.visibilityState === 'visible') this.attempt();
        if (this.watching !== null) return;
        this.watching = () => { if (document.visibilityState === 'visible') this.attempt(); };
        document.addEventListener('visibilitychange', this.watching);
    }

    private unwatch(): void {
        if (this.watching !== null) document.removeEventListener('visibilitychange', this.watching);
        this.watching = null;
    }

    private attempt(): void {
        const session = this.session;
        if (session === null || this.ws !== null || this.dialing !== null) return;
        const ws = new WebSocket(session.url);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            const { id: sessionId, secret } = session;
            ws.send(JSON.stringify(this.phase === 'ended'
                ? { type: 'session.end', sessionId, secret }
                : { type: 'session.resume', sessionId, secret, output: this.received.toString(), inputAcked: this.acked.toString(), inputEnd: this.sent.toString() }));
        };
        this.follow(ws);
    }

    private follow(ws: WebSocket): void {
        this.dialing = ws;
        ws.onmessage = (event: MessageEvent<MessageData>) => this.verdict(ws, event.data);
        ws.onclose = () => {
            if (this.dialing !== ws) return;
            this.dialing = null;
            this.onunreachable?.();
        };
    }

    private verdict(ws: WebSocket, data: MessageData): void {
        if (this.dialing !== ws || typeof data !== 'string') return;
        const msg = parseControl(data);
        const accepted = offsetOf(msg?.input);
        if (msg?.type === 'session.resumed' && accepted !== null) {
            this.dialing = null;
            this.attach(ws);
            this.release(accepted);
            for (const { offset, bytes } of this.unacked) ws.send(frame(offset, bytes));   // the original ranges, not new commands
            this.flushHeld();
            this.unwatch();
            // The game leg may have come up while we were away: say so as it would have been said.
            if (msg.backendConnected === true) this.onmessage?.(new MessageEvent('message', { data: '{"type":"game.connected"}' }));
            this.onresume?.();
        } else if (msg?.type === 'session.ended' || msg?.type === 'session.unavailable') {
            const ending = this.phase === 'ended';          // the end was delivered, or the session was gone already
            this.dialing = null;
            ws.close();
            this.finish();
            if (!ending) this.report('The game session could not be resumed.');
        }
    }

    /** Keep the secret until an end is confirmed; retry without flushing input.
     *  Before the marker, only the offered socket can cancel its session. */
    close(): void {
        const ws = this.ws;
        const session = this.session;
        this.ws = null;
        this.dialing?.close();
        this.dialing = null;
        this.phase = 'ended';
        this.held = [];
        this.heldBytes = 0;
        this.unacked = [];
        if (session === null && this.offerId !== null && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'session.cancel', offerId: this.offerId }));
        }
        if (session !== null && ws?.readyState === WebSocket.OPEN) {
            this.follow(ws);                               // left open: a socket already closing drops the answer
            ws.send(JSON.stringify({ type: 'session.end', sessionId: session.id, secret: session.secret }));
        } else {
            if (session !== null) this.attempt();
            ws?.close();
        }
        if (session !== null) this.watch();
    }

    private finish(): void {
        this.phase = 'ended';
        this.session = null;
        this.held = [];
        this.heldBytes = 0;
        this.unacked = [];
        this.unwatch();
    }

    private abort(reason: string): void {
        this.close();
        this.report(reason);
    }

    private report(reason: string): void {
        this.failure = true;
        this.onclose?.(new CloseEvent('close', { code: 1011, reason, wasClean: false }));
    }
}
