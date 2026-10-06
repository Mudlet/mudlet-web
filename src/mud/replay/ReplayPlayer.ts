import { replayBytesToLatin1, type ReplayChunk } from './replayFormat';

export interface ReplayPlayerCallbacks {
    /** Current playback speed divisor (1 = real time). Read at each chunk's
     *  schedule time, so mid-replay speed changes affect subsequent chunks —
     *  matching Mudlet's `offset / mReplaySpeed` singleShot scheduling. */
    speed: () => number;
    /** Deliver one chunk's bytes (as a Latin-1 byte-string) to the inbound
     *  telnet pipeline. */
    feed: (data: string) => void;
    /** Fired once, after the last chunk has been delivered. Not fired on abort. */
    onDone: () => void;
    /**
     * Reads a chunk again as it comes up, from the file as it is now. Mudlet
     * reads its replay file a chunk at a time while it plays
     * (cTelnet::loadReplayChunk), so the chunks parsed at load time are only
     * what the file held THEN. Returning null says the chunk can no longer be
     * read — a header turned negative or too long — and the replay ends there
     * through {@link onCorrupt}. Left out, the parsed chunks are played as they
     * are (a replay with no file behind it).
     */
    reread?: (chunk: ReplayChunk, index: number) => ReplayChunk | null;
    /** Fired once, instead of onDone, when {@link reread} found a chunk that
     *  will not read. Nothing after it is played. */
    onCorrupt?: () => void;
}

/**
 * Plays parsed replay chunks back on their recorded timeline: each chunk is
 * scheduled `offsetMs / speed` after the previous one and fed into the telnet
 * parsing pipeline, so triggers, GMCP handlers, and rendering all behave as
 * they did live.
 */
export class ReplayPlayer {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private index = 0;
    private finished = false;

    /** Our own copy: {@link ReplayPlayerCallbacks.reread} replaces entries as
     *  they come up, and the caller's array is not ours to write. */
    private readonly chunks: ReplayChunk[];

    constructor(
        chunks: ReplayChunk[],
        private readonly callbacks: ReplayPlayerCallbacks,
    ) {
        this.chunks = chunks.slice();
    }

    start(): void {
        this.scheduleNext();
    }

    /** Stop playback and drop any pending chunk. Idempotent; onDone is not
     *  fired for an aborted replay. */
    abort(): void {
        this.finished = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Deliver every chunk that has come due, without waiting for its setTimeout.
     *
     * The counterpart of TimerEngine.pumpDue, and there for the same caller: a
     * script blocked in waitForEvent/pumpEvents is not running the event loop,
     * so the pending timeout below can never land and a replay started from such
     * a script would sit at chunk zero forever. Mudlet has no equivalent problem
     * — its nested QEventLoop keeps driving the replay timer along with
     * everything else — so this is what standing in for that loop costs.
     *
     * Returns the number of chunks delivered.
     */
    pumpDue(now = Date.now()): number {
        let fired = 0;
        // A loop, not a single step: pumping is called at intervals far longer
        // than the gap between recorded chunks, so several are typically due.
        while (!this.finished && this.dueAt !== null && now >= this.dueAt) {
            if (this.timer !== null) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            this.deliverPending();
            fired++;
        }
        return fired;
    }

    /** When the pending chunk is due, in epoch ms; null when none is scheduled. */
    private dueAt: number | null = null;

    /** Feed the chunk at `index` and schedule the one after it. */
    private deliverPending(): void {
        const chunk = this.chunks[this.index];
        this.dueAt = null;
        if (!chunk) return;
        this.index++;
        // A parsing hiccup on one chunk shouldn't kill the rest of the
        // replay — the live socket path has the same isolation.
        try {
            if (chunk.data.length > 0) this.callbacks.feed(replayBytesToLatin1(chunk.data));
        } catch (error) {
            console.error('Error processing replay chunk:', error);
        }
        this.scheduleNext();
    }

    private scheduleNext(): void {
        if (this.finished) return;
        if (this.index >= this.chunks.length) {
            this.finished = true;
            this.dueAt = null;
            this.callbacks.onDone();
            return;
        }
        // The chunk's header is read here, as it comes up and before its delay
        // is waited out — where Mudlet's loadReplayChunk reads it, straight
        // after the chunk before it was processed.
        let chunk = this.chunks[this.index];
        if (this.callbacks.reread) {
            const fresh = this.callbacks.reread(chunk, this.index);
            if (!fresh) {
                this.finished = true;
                this.dueAt = null;
                this.callbacks.onCorrupt?.();
                return;
            }
            chunk = this.chunks[this.index] = fresh;
        }
        const speed = Math.max(1, this.callbacks.speed());
        const delay = chunk.offsetMs / speed;
        this.dueAt = Date.now() + delay;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.deliverPending();
        }, delay);
    }
}
