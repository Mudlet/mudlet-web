import pako from 'pako';

const IAC = 0xFF, DONT = 0xFE, DO = 0xFD;
const OPT_COMPRESS = 0x55;  // MCCP v1
const OPT_COMPRESS2 = 0x56; // MCCP v2

const MCCP_WILL = "\xFF\xFB\x56";         // IAC WILL COMPRESS2
const MCCP_WONT = "\xFF\xFC\x56";         // IAC WONT COMPRESS2
const MCCP_START = "\xFF\xFA\x56\xFF\xF0"; // IAC SB COMPRESS2 IAC SE

// MCCP v1 (COMPRESS, option 85). Its start sequence is the malformed
// `IAC SB COMPRESS WILL SE` — no IAC before the SE — which Mudlet still
// recognises (cTelnet::processSocketData) once it has agreed to v1.
const MCCP1_WILL = "\xFF\xFB\x55";        // IAC WILL COMPRESS
const MCCP1_WONT = "\xFF\xFC\x55";        // IAC WONT COMPRESS
const MCCP1_START = "\xFF\xFA\x55\xFB\xF0"; // IAC SB COMPRESS WILL SE

/** cTelnet's `BUFFER_SIZE` × `scmMaxDecompressionRecursion`: the most one read
 *  from the game may inflate to. Past it desktop drops the rest of the read
 *  and refuses the stream — the guard against a decompression bomb. */
export const MCCP_MAX_INFLATED_PER_READ = 8 * 100_000;

/** cTelnet's `scmMaxUninflatedInput`: how many bytes a stream that has not
 *  produced any output yet is remembered for, so they can be handed back as
 *  text if it turns out never to have been compressed at all. */
const MAX_UNINFLATED_INPUT = 32;

/** zlib's `zError()` texts for the codes a broken stream reports. */
const Z_ERROR_TEXT: Record<number, string> = {
    [2]: 'need dictionary',
    [-2]: 'stream error',
    [-3]: 'data error',
    [-4]: 'insufficient memory',
};
const Z_NEED_DICT = 2;
const Z_DATA_ERROR = -3;

/** A desktop `postMessage()` the handler asks its owner to show, in desktop's
 *  words. `text` may hold a `\n`: the lines after it are the notice's
 *  indented continuation. */
export interface MccpNotice {
    notice: string;
}

/** One piece of a read, in stream order: text for the telnet pipeline, or a
 *  notice to post where it falls between the texts. */
export type MccpPiece = string | MccpNotice;

interface InflateInternal extends pako.Inflate {
    strm: { output: Uint8Array; next_in: number; next_out: number; avail_out: number };
    options: { chunkSize: number };
    ended: boolean;
}

/** Thrown out of pako's onData to stop a read that inflates past the cap. */
class InflateCapReached extends Error {}

const enum Phase { Header, DictId, Body, Trailer }

export class MccpHandler {
    private compressing = false;
    /** We answered the server's `WILL COMPRESS` with DO — Mudlet's
     *  `mMCCP_version_1`. Only then is a v1 start sequence honoured. */
    private v1Accepted = false;
    /** We answered `WILL COMPRESS2` with DO — Mudlet's `mMCCP_version_2`. Only
     *  then is a v2 start sequence honoured, and after it Mudlet turns a v1
     *  offer down, as the MCCP spec asks. */
    private v2Accepted = false;
    /** The option of the stream in progress — Mudlet's `mCompressionOption`. */
    private streamOption = OPT_COMPRESS2;
    private inflator: pako.Inflate | null = null;
    private phase = Phase.Header;
    /** The zlib header (CMF, FLG and an optional DICTID) read so far. */
    private header: number[] = [];
    /** The Adler-32 trailer read so far. */
    private trailer: number[] = [];
    /** Running Adler-32 of the inflated output, checked against the trailer. */
    private adlerA = 1;
    private adlerB = 0;
    /** Bytes the stream has inflated to — zlib's `total_out`. */
    private totalOut = 0;
    /** cTelnet's `mUninflatedInput` / `mUninflatedInputComplete`: every byte
     *  the stream took while it had produced nothing, from earlier reads. */
    private uninflated: number[] = [];
    private uninflatedComplete = true;
    /** What is still allowed to come out of the read being processed. */
    private readBudget = MCCP_MAX_INFLATED_PER_READ;
    private readonly sendRaw: (data: string) => void;
    private readonly onStreamEnd: () => void;
    private _enabled = true;

    /** `onStreamEnd` runs when a stream finishes (Z_STREAM_END), where desktop
     *  resets `hisOptionState` for both compression options. */
    constructor(sendRaw: (data: string) => void, onStreamEnd: () => void = () => {}) {
        this.sendRaw = sendRaw;
        this.onStreamEnd = onStreamEnd;
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
        return this.processChunks(data).join('');
    }

    /**
     * {@link processData}, but cut where compression starts and where it ends:
     * the plain text before an MCCP start, the inflated text, and the plain
     * text after the end of the stream come back as separate pieces, in order.
     * Desktop processes each of them as a unit of its own (cTelnet calls
     * gotRest on the plain part before it inflates the rest), so a caller that
     * runs the pieces through the pipeline one at a time keeps a trigger on the
     * last line of one part from seeing out-of-band data from the next. Never
     * empty: a frame that yields no bytes still comes back as one empty piece.
     * Notices are left out; {@link processPieces} keeps them.
     */
    processChunks(data: string): string[] {
        const chunks = this.processPieces(data).filter((p): p is string => typeof p === 'string');
        return chunks.length > 0 ? chunks : [''];
    }

    /** {@link processChunks} with desktop's MCCP warnings in their place
     *  among the texts. Empty pieces are dropped, so this can be empty. */
    processPieces(data: string): MccpPiece[] {
        this.readBudget = MCCP_MAX_INFLATED_PER_READ;
        return this.pieces(data).filter(p => typeof p !== 'string' || p.length > 0);
    }

    private pieces(data: string): MccpPiece[] {
        if (this.compressing) {
            return this.decompress(data);
        }

        if (!this._enabled) {
            return [data];
        }

        const start = this.negotiate(data);
        if (start === -1) {
            return [data];
        }

        // Both start sequences are five bytes long.
        const before = data.substring(0, start);
        const after = data.substring(start + MCCP_START.length);

        this.startCompression(data.charCodeAt(start + 2));

        return after.length > 0 ? [before, ...this.decompress(after)] : [before];
    }

    /** Forget the connection: the stream and what was agreed for it. */
    reset(): void {
        this.endStream();
        this.v1Accepted = false;
        this.v2Accepted = false;
    }

    /** Act on the compression offers in `data`, in stream order, up to the
     *  first start sequence of a version that is agreed to; return where that
     *  starts, or -1.
     *
     *  Mudlet's answer to `WILL COMPRESS2` is DO; to `WILL COMPRESS` it is DO
     *  too, unless v2 was taken up first (then DONT), and nothing for a repeat
     *  of a v1 offer already accepted. `WONT` withdraws either. The negotiator
     *  answers both for a profile with compression forced off; this never runs
     *  then. */
    private negotiate(data: string): number {
        const marks: Array<[number, string]> = [];
        for (const seq of [MCCP_WILL, MCCP_WONT, MCCP1_WILL, MCCP1_WONT, MCCP_START, MCCP1_START]) {
            for (let i = data.indexOf(seq); i !== -1; i = data.indexOf(seq, i + 3)) marks.push([i, seq]);
        }
        marks.sort((a, b) => a[0] - b[0]);
        for (const [at, seq] of marks) {
            switch (seq) {
                case MCCP_WILL:
                    this.sendRaw(String.fromCharCode(IAC, DO, OPT_COMPRESS2));
                    this.v2Accepted = true;
                    break;
                case MCCP_WONT:
                    this.v2Accepted = false;
                    break;
                case MCCP1_WILL:
                    if (this.v2Accepted) {
                        this.sendRaw(String.fromCharCode(IAC, DONT, OPT_COMPRESS));
                    } else if (!this.v1Accepted) {
                        this.sendRaw(String.fromCharCode(IAC, DO, OPT_COMPRESS));
                        this.v1Accepted = true;
                    }
                    break;
                case MCCP1_WONT:
                    this.v1Accepted = false;
                    break;
                case MCCP_START:
                    if (this.v2Accepted) return at;
                    break;
                case MCCP1_START:
                    if (this.v1Accepted) return at;
                    break;
            }
        }
        return -1;
    }

    private endStream(): void {
        this.compressing = false;
        this.inflator = null;
        this.uninflated = [];
        this.uninflatedComplete = true;
    }

    private startCompression(option: number): void {
        this.compressing = true;
        this.streamOption = option;
        // Inflate raw deflate data and handle the zlib wrapper here: pako's
        // zlib mode treats bytes after the end of a stream as the start of
        // another concatenated stream, which loses where the compressed stream
        // stopped — and after it the server is back to plain telnet.
        this.inflator = new pako.Inflate({ raw: true });
        this.phase = Phase.Header;
        this.header = [];
        this.trailer = [];
        this.adlerA = 1;
        this.adlerB = 0;
        this.totalOut = 0;
        this.uninflated = [];
        this.uninflatedComplete = true;
    }

    /** cTelnet::refuseCompressedStream: tell the game DONT for the version the
     *  stream was using and stop taking its start sequence as one until it
     *  offers that version again. */
    private refuseStream(): void {
        this.sendRaw(String.fromCharCode(IAC, DONT, this.streamOption));
        if (this.streamOption === OPT_COMPRESS) this.v1Accepted = false;
        else this.v2Accepted = false;
        this.endStream();
    }

    /** cTelnet::decompressBuffer over one read, followed through to the plain
     *  text after the end of the stream (or after a broken one). */
    private decompress(data: string): MccpPiece[] {
        if (!this.inflator) {
            return [data];
        }

        const bytes = stringToBytes(data);
        const output: Uint8Array[] = [];
        let pos = 0;
        let zerr = 0;
        let ended = false;

        try {
            // The zlib header: CMF and FLG, checked as zlib's inflate() does,
            // then the DICTID a header asking for a preset dictionary carries
            // — which MCCP never uses, so that is where zlib gives up.
            while (pos < bytes.length && (this.phase === Phase.Header || this.phase === Phase.DictId)) {
                this.header.push(bytes[pos++]);
                if (this.phase === Phase.Header && this.header.length === 2) {
                    const [cmf, flg] = this.header;
                    if (((cmf << 8) | flg) % 31 !== 0 || (cmf & 0x0F) !== 8 || (cmf >> 4) + 8 > 15) {
                        zerr = Z_DATA_ERROR;
                        break;
                    }
                    this.phase = (flg & 0x20) ? Phase.DictId : Phase.Body;
                } else if (this.phase === Phase.DictId && this.header.length === 6) {
                    zerr = Z_NEED_DICT;
                    break;
                }
            }

            if (!zerr && this.phase === Phase.Body && pos < bytes.length) {
                const consumed = this.inflateBody(bytes.subarray(pos), output);
                zerr = consumed.err;
                pos += consumed.used;
                if (!zerr && consumed.ended) this.phase = Phase.Trailer;
            }

            if (!zerr && this.phase === Phase.Trailer) {
                while (pos < bytes.length && this.trailer.length < 4) this.trailer.push(bytes[pos++]);
                if (this.trailer.length === 4) {
                    const [t0, t1, t2, t3] = this.trailer;
                    const sent = ((t0 << 24) | (t1 << 16) | (t2 << 8) | t3) >>> 0;
                    const adler = ((this.adlerB << 16) | this.adlerA) >>> 0;
                    if (sent !== adler) zerr = Z_DATA_ERROR;
                    else ended = true;
                }
            }
        } catch (e) {
            if (!(e instanceof InflateCapReached)) throw e;
            // More than desktop processes from one read: the rest of it is
            // dropped, and zlib cannot pick a stream up again past a gap, so
            // the stream is refused for the game to fall back to plain text.
            this.refuseStream();
            return [
                bytesToString(output),
                { notice: '[ WARN  ]  - Too much compressed data to process at once, some was lost - compression disabled.\n'
                    + 'If the display looks garbled, please reconnect to the game.' },
            ];
        }

        // Nothing has come out of the stream yet and every byte it took is
        // still at hand — this read's, plus the few earlier ones kept for this.
        const allInputAtHand = this.totalOut === 0 && this.uninflatedComplete;

        if (zerr) {
            // The stream is broken — most often a game announcing compression
            // and then not using it. Warn, refuse the version it was using,
            // and hand back what follows as plain text; when it never produced
            // anything, that includes the bytes taken for its header.
            const notice: MccpNotice = {
                notice: `[ WARN  ]  - MCCP decompression error (${Z_ERROR_TEXT[zerr] ?? 'unknown error'}), compression disabled.\n`
                    + 'If the display looks garbled, please reconnect to the game.',
            };
            let text: string;
            let rest: string;
            if (allInputAtHand) {
                text = bytesToString([Uint8Array.from(this.uninflated)]);
                rest = data;
            } else {
                text = bytesToString(output);
                rest = data.substring(pos);
            }
            this.refuseStream();
            return [notice, text, ...(rest.length > 0 ? this.pieces(rest) : [])];
        }

        if (allInputAtHand && !ended && this.uninflated.length + pos <= MAX_UNINFLATED_INPUT) {
            for (let i = 0; i < pos; i++) this.uninflated.push(bytes[i]);
        } else {
            this.uninflated = [];
            this.uninflatedComplete = false;
        }

        const text = bytesToString(output);
        if (!ended) {
            return [text];
        }

        // The compressed stream has ended (Z_STREAM_END): everything after it
        // is plain telnet again — which may itself start a fresh stream.
        this.endStream();
        this.onStreamEnd();
        const rest = data.substring(pos);
        const inflated = this.skipNestedStarts(text);
        return rest.length > 0 ? [inflated, ...this.pieces(rest)] : [inflated];
    }

    /** cTelnet::processSocketData scans the output of a stream that ended in
     *  this read (out_buffer, with mNeedDecompression already cleared) and
     *  skips any start sequence it finds there whole rather than inflating
     *  out_buffer back into itself (#10662): a server has no reason to nest a
     *  stream in its own output. It has to go here, not to the telnet parser
     *  downstream — MCCP1's start has no IAC before its SE, and would leave
     *  that parser inside a subnegotiation swallowing the text after it. Only
     *  the versions agreed to are recognised, as desktop's look-ahead is. */
    private skipNestedStarts(text: string): string {
        if (this.v1Accepted) text = text.split(MCCP1_START).join('');
        if (this.v2Accepted) text = text.split(MCCP_START).join('');
        return text;
    }

    /** Feed deflate data to the inflater; report how much of it was used, and
     *  whether the deflate stream ended or broke. Output goes to `output`. */
    private inflateBody(input: Uint8Array, output: Uint8Array[]): { used: number; ended: boolean; err: number } {
        const inflator = this.inflator!;
        const inf = inflator as unknown as InflateInternal;
        const take = (chunk: Uint8Array): void => {
            if (chunk.length === 0) return;
            const allowed = Math.min(chunk.length, this.readBudget);
            const kept = chunk.slice(0, allowed);
            this.readBudget -= allowed;
            this.totalOut += kept.length;
            this.updateAdler(kept);
            output.push(kept);
            if (allowed < chunk.length) throw new InflateCapReached();
        };

        const origOnData = inflator.onData;
        inflator.onData = (chunk: Uint8Array) => take(chunk);
        try {
            inflator.push(input, false);

            // Pako only calls onData when its internal buffer is full (default
            // 64KB) or the stream ends, so for small MUD messages the buffered
            // data has to be taken out by hand — including what a stream that
            // breaks produced before the break, as zlib hands it back.
            if (!(inf.ended && !inflator.err) && inf.strm.next_out > 0) {
                const pending = inf.strm.output.subarray(0, inf.strm.next_out);
                inf.strm.next_out = 0;
                inf.strm.avail_out = inf.options.chunkSize;
                take(pending);
            }
        } finally {
            inflator.onData = origOnData;
        }

        if (inflator.err) {
            return { used: inf.strm.next_in, ended: false, err: inflator.err };
        }
        return { used: inf.ended ? inf.strm.next_in : input.length, ended: inf.ended, err: 0 };
    }

    private updateAdler(chunk: Uint8Array): void {
        let a = this.adlerA, b = this.adlerB;
        for (let i = 0; i < chunk.length; i++) {
            a += chunk[i];
            if (a >= 65521) a -= 65521;
            b += a;
            if (b >= 65521) b -= 65521;
        }
        this.adlerA = a;
        this.adlerB = b;
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
        // In slices: fromCharCode takes its bytes as arguments, and a read
        // can inflate to far more than a call may be passed.
        for (let i = 0; i < arr.length; i += 8192) {
            result += String.fromCharCode.apply(null, arr.subarray(i, i + 8192) as unknown as number[]);
        }
    }
    return result;
}
