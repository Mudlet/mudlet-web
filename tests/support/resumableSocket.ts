type Control = Record<string, unknown>;

/** A browser WebSocket stand-in: records what is sent and lets a test deliver
 *  frames, closes and drops on demand. */
export class BrowserMockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static all: BrowserMockWebSocket[] = [];
    readyState = BrowserMockWebSocket.OPEN;
    binaryType = '';
    bufferedAmount = 0;
    protocol = '';
    sent: (Uint8Array | string)[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(public readonly url: string) { BrowserMockWebSocket.all.push(this); }
    send(data: Uint8Array | string): void { this.sent.push(data); }
    close(): void { this.readyState = BrowserMockWebSocket.CLOSED; }

    text(msg: Control): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
    /** Raw game bytes, as a plain proxy sends them. */
    raw(text: string): void { this.onmessage?.({ data: bytes(text).buffer }); }
    /** One sequenced range of game output. */
    frame(offset: bigint, text: string): void { this.onmessage?.({ data: envelope(offset, text) }); }
    /** The transport dies with no close frame — the phone losing its network. */
    drop(): void { this.readyState = BrowserMockWebSocket.CLOSED; this.onclose?.({ code: 1006, reason: '', wasClean: false }); }

    controls(): Control[] { return this.sent.flatMap(s => (typeof s === 'string' ? [JSON.parse(s)] : [])); }
    /** Sent binary: raw bytes before the marker, `{ offset, text }` envelopes after. */
    sentText(): string[] { return this.sent.flatMap(s => (typeof s === 'string' ? [] : [new TextDecoder().decode(s)])); }
    envelopes(): { offset: bigint; text: string }[] {
        return this.sent.flatMap(s => (typeof s === 'string' ? [] : [{
            offset: new DataView(s.buffer, s.byteOffset).getBigUint64(0, false),
            text: new TextDecoder().decode(s.subarray(8)),
        }]));
    }
}

function bytes(text: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(text, c => c.charCodeAt(0));
}

/** Test-side wire encoder, deliberately independent of production framing. */
function envelope(offset: bigint, text: string): ArrayBuffer {
    const framed = new Uint8Array(8 + text.length);
    new DataView(framed.buffer).setBigUint64(0, offset, false);
    framed.set(bytes(text), 8);
    return framed.buffer;
}

export const OFFER = { type: 'session.offer', offerId: 'offer-1' } as const;
export const marker = (input = 0n, output = 0n): Control => ({
    type: 'session.enabled', sessionId: 'session-1', secret: 'c2VjcmV0',
    input: String(input), output: String(output),
});
export const sameSession = { sessionId: 'session-1', secret: 'c2VjcmV0' } as const;
/** What `connectionUrl` actually builds: no slash before the query. */
export const PROXY = 'wss://relay.test/relay?host=game.test&port=23';

export const visibility = (state: 'visible' | 'hidden'): void => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};
export const visit = (): void => {
    visibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
};
