import pako from 'pako';

const MCCP_WILL = "\xFF\xFB\x56";         // IAC WILL COMPRESS2
const MCCP_START = "\xFF\xFA\x56\xFF\xF0"; // IAC SB COMPRESS2 IAC SE
const MCCP_DO = "\xFF\xFD\x56";           // IAC DO COMPRESS2

interface InflateInternal extends pako.Inflate {
    strm: { output: Uint8Array; next_in: number; next_out: number; avail_out: number };
    options: { chunkSize: number };
    ended: boolean;
}

/** zlib wrapper around the raw deflate data: a 2-byte header (CMF, FLG) and
 *  a 4-byte Adler-32 trailer. MCCP2 never uses a preset dictionary, so there
 *  is no optional DICTID in the header. */
const ZLIB_HEADER_LEN = 2;
const ZLIB_TRAILER_LEN = 4;

export class MccpHandler {
    private compressing = false;
    private inflator: pako.Inflate | null = null;
    /** zlib header bytes still to skip before the deflate data starts. */
    private headerLeft = 0;
    /** Adler-32 trailer bytes still to skip once the deflate data has ended. */
    private trailerLeft = 0;
    private readonly sendRaw: (data: string) => void;
    private _enabled = true;

    constructor(sendRaw: (data: string) => void) {
        this.sendRaw = sendRaw;
    }

    isActive(): boolean {
        return this.compressing;
    }

    get enabled(): boolean {
        return this._enabled;
    }

    set enabled(value: boolean) {
        this._enabled = value;
    }

    /**
     * Process incoming data, handling MCCP negotiation and decompression.
     * Must be called BEFORE stripTelnetSequences.
     */
    processData(data: string): string {
        if (this.compressing) {
            return this.decompress(data);
        }

        if (!this._enabled) {
            return data;
        }

        if (data.indexOf(MCCP_WILL) !== -1) {
            this.sendRaw(MCCP_DO);
        }

        const startIdx = data.indexOf(MCCP_START);
        if (startIdx === -1) {
            return data;
        }

        const before = data.substring(0, startIdx);
        const after = data.substring(startIdx + MCCP_START.length);

        this.startCompression();

        if (after.length > 0) {
            const decompressed = this.decompress(after);
            return before + decompressed;
        }

        return before;
    }

    reset(): void {
        this.compressing = false;
        this.inflator = null;
        this.headerLeft = 0;
        this.trailerLeft = 0;
    }

    private startCompression(): void {
        this.compressing = true;
        // Inflate raw deflate data and handle the zlib wrapper here: pako's
        // zlib mode treats bytes after the end of a stream as the start of
        // another concatenated stream, which loses where the compressed stream
        // stopped — and after it the server is back to plain telnet.
        this.inflator = new pako.Inflate({ raw: true });
        this.headerLeft = ZLIB_HEADER_LEN;
        this.trailerLeft = ZLIB_TRAILER_LEN;
    }

    private decompress(data: string): string {
        if (!this.inflator) {
            return data;
        }

        const bytes = stringToBytes(data);
        let pos = 0;

        const skipHeader = Math.min(this.headerLeft, bytes.length);
        this.headerLeft -= skipHeader;
        pos += skipHeader;

        const inf = this.inflator as unknown as InflateInternal;
        const output: Uint8Array[] = [];

        if (pos < bytes.length && !inf.ended) {
            const origOnData = this.inflator.onData;
            this.inflator.onData = (chunk: Uint8Array) => {
                output.push(new Uint8Array(chunk));
            };

            const input = bytes.subarray(pos);
            this.inflator.push(input, false);

            // Pako only calls onData when its internal buffer is full (default 64KB)
            // or the stream ends, so for small MUD messages we must extract
            // buffered data manually.
            if (!inf.ended && inf.strm.next_out > 0) {
                output.push(new Uint8Array(inf.strm.output.subarray(0, inf.strm.next_out)));
                inf.strm.next_out = 0;
                inf.strm.avail_out = inf.options.chunkSize;
            }

            this.inflator.onData = origOnData;

            if (this.inflator.err) {
                // Whatever follows is undecodable; showing it as text would
                // only print raw zlib bytes.
                console.error('MCCP decompression error:', this.inflator.msg);
                this.reset();
                return bytesToString(output);
            }

            pos += inf.ended ? inf.strm.next_in : input.length;
        }

        const text = bytesToString(output);

        if (!inf.ended) {
            return text;
        }

        // The compressed stream has ended (Z_STREAM_END): skip its trailer,
        // then everything after it is plain telnet again — which may itself
        // start a fresh compressed stream.
        const skipTrailer = Math.min(this.trailerLeft, bytes.length - pos);
        this.trailerLeft -= skipTrailer;
        pos += skipTrailer;
        if (this.trailerLeft > 0) {
            return text;
        }

        this.reset();
        const rest = bytesToString([bytes.subarray(pos)]);
        return rest.length > 0 ? text + this.processData(rest) : text;
    }
}

function stringToBytes(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
    }
    return bytes;
}

function bytesToString(arrays: Uint8Array[]): string {
    let result = '';
    for (const arr of arrays) {
        for (let i = 0; i < arr.length; i++) {
            result += String.fromCharCode(arr[i]);
        }
    }
    return result;
}
