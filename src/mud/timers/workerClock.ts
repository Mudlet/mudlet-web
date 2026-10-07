/**
 * A setTimeout/clearTimeout pair whose clock runs in a dedicated Worker.
 *
 * Chrome throttles main-thread timer chains in a hidden tab — to one wake-up a
 * second at once, and after five minutes hidden to one a *minute* (intensive
 * throttling). Every Lua timer is such a chain (a repeat re-arms itself from
 * its own callback, see TimerEngine.addTemp), so a background tab ran a 1s
 * repeat once a minute while desktop Mudlet keeps exact time (mudlet-web#441).
 * Dedicated-worker timers are exempt from both, so the worker keeps the time
 * and posts each due id back; the callback itself still runs on the main
 * thread, where Lua lives. Message delivery to a hidden page isn't throttled.
 *
 * Ordering is the same as plain setTimeout: the worker receives sets in the
 * order they were made, and its timers fire — and post — in due order.
 *
 * The worker is an inline Blob, not a `new URL('./x.worker.ts', import.meta.url)`
 * chunk: a dozen lines need no bundling, and a Blob works the same in the app
 * build, the library build and a consumer's bundler. Where there is no Worker
 * (tests, happy-dom, node) or one can't be started (a CSP without `worker-src
 * blob:`), the clock falls back to the global setTimeout — looked up at each
 * call, so vitest's fake timers still drive it.
 */

export type ClockHandle = number;

export interface Clock {
    setTimeout(fn: () => void, ms: number): ClockHandle;
    clearTimeout(handle: ClockHandle | null | undefined): void;
}

/** The minimal Worker surface the clock uses — what tests fake. */
export interface ClockWorker {
    postMessage(msg: ClockWorkerRequest): void;
    addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
    addEventListener(type: 'error', fn: () => void): void;
    terminate(): void;
}

export type ClockWorkerRequest = { op: 'set'; id: number; ms: number } | { op: 'clear'; id: number };

const WORKER_SOURCE = `
const timers = new Map();
onmessage = (e) => {
    const m = e.data;
    if (m.op === 'set') {
        timers.set(m.id, setTimeout(() => { timers.delete(m.id); postMessage(m.id); }, m.ms));
    } else {
        clearTimeout(timers.get(m.id));
        timers.delete(m.id);
    }
};
`;

/** Start the inline clock worker, or null where workers aren't available. */
export function createBlobClockWorker(): ClockWorker | null {
    if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
        return null;
    }
    try {
        // Never revoked: one small blob per page, and revoking while the
        // worker may still be fetching it races the load in some browsers.
        const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        return new Worker(url) as unknown as ClockWorker;
    } catch {
        return null;
    }
}

interface Pending {
    fn: () => void;
    /** Epoch ms it comes due — where a fallback re-arms it from. */
    due: number;
    /** Set once this timeout is running on the main-thread setTimeout. */
    native?: ReturnType<typeof setTimeout>;
}

export class WorkerClock implements Clock {
    /** undefined until first use; null once it is known there is none. */
    private worker: ClockWorker | null | undefined;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();

    constructor(private readonly createWorker: () => ClockWorker | null = createBlobClockWorker) {}

    setTimeout(fn: () => void, ms: number): ClockHandle {
        const id = this.nextId++;
        const delay = Math.max(0, Number(ms) || 0);
        const entry: Pending = { fn, due: Date.now() + delay };
        this.pending.set(id, entry);
        const worker = this.ensureWorker();
        if (worker) worker.postMessage({ op: 'set', id, ms: delay });
        else this.armNative(id, entry, delay);
        return id;
    }

    clearTimeout(handle: ClockHandle | null | undefined): void {
        if (handle == null) return;
        const entry = this.pending.get(handle);
        if (!entry) return;
        // Dropping the entry is what cancels it: a tick the worker already
        // posted finds nothing and is ignored.
        this.pending.delete(handle);
        if (entry.native !== undefined) clearTimeout(entry.native);
        else this.worker?.postMessage({ op: 'clear', id: handle });
    }

    /** Whether the clock is running on a worker (false before first use). */
    get usingWorker(): boolean {
        return !!this.worker;
    }

    private ensureWorker(): ClockWorker | null {
        if (this.worker !== undefined) return this.worker;
        const worker = this.createWorker();
        this.worker = worker;
        if (worker) {
            worker.addEventListener('message', (e) => this.onTick(e.data as number));
            worker.addEventListener('error', () => this.fallBack());
        }
        return worker;
    }

    private onTick(id: number): void {
        const entry = this.pending.get(id);
        if (!entry || entry.native !== undefined) return;
        this.pending.delete(id);
        entry.fn();
    }

    /** The worker failed to start (a CSP blocking blob: workers reports it this
     *  way): move every timeout it held onto the main thread, keeping its due
     *  time, and use the main thread from now on. */
    private fallBack(): void {
        const worker = this.worker;
        this.worker = null;
        try { worker?.terminate(); } catch { /* already gone */ }
        const now = Date.now();
        for (const [id, entry] of this.pending) {
            if (entry.native === undefined) this.armNative(id, entry, Math.max(0, entry.due - now));
        }
    }

    private armNative(id: number, entry: Pending, delay: number): void {
        entry.native = setTimeout(() => {
            if (this.pending.get(id) !== entry) return;
            this.pending.delete(id);
            entry.fn();
        }, delay);
    }
}

/** The clock every Lua timer and the line assembler's idle flushes share. */
export const workerClock: Clock = new WorkerClock();
