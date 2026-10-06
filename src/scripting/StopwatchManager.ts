// Mudlet-compatible stopwatch API backing createStopWatch/startStopWatch/etc.
//
// Mudlet stopwatches are millisecond-resolution wall-clock timers identified by
// a numeric id and an optional unique name. A new watch takes the lowest id not
// in use, as Host::createStopWatch does, so a deleted watch's id is handed out
// again and a reload that drops the non-persistent watches frees theirs. We measure elapsed time
// with Date.now() — wall-clock, like Mudlet's QDateTime — rather than the
// monotonic performance.now(), because persistence requires an absolute time
// anchor that survives a page reload (performance.now() resets to zero on every
// load).
//
// Persistence mirrors Mudlet: a watch flagged persistent (setStopWatchPersistence)
// is written to localStorage, keyed per connection, and restored on the next
// load. A running persistent watch stores its absolute start, so on restore it
// keeps counting — including the time the app was closed — exactly as Mudlet
// does via effectiveStartDateTimeEpochMSecs. Non-persistent watches live only in
// memory and vanish on reload.

/** Backing store for persistent stopwatches (localStorage in the browser). */
export interface StopwatchStore {
    load(): string | null;
    save(data: string): void;
}

/** localStorage key holding one profile's stopwatches. Shared with the
 *  profile-deletion sweep (storage/profileStorage) so the two can't drift. */
export function stopwatchStorageKey(connectionId: string): string {
    return `mudlet_stopwatches_${connectionId}`;
}

/** Build a localStorage-backed store scoped to a connection, or undefined when
 *  localStorage is unavailable (tests / SSR) — in which case persistence is a
 *  no-op and watches behave as memory-only. */
export function localStorageStopwatchStore(connectionId: string): StopwatchStore | undefined {
    if (typeof localStorage === 'undefined') return undefined;
    const key = stopwatchStorageKey(connectionId);
    return {
        load: () => localStorage.getItem(key),
        save: (data: string) => localStorage.setItem(key, data),
    };
}

/** Broken-down elapsed time, mirroring Mudlet's generateElapsedTimeTable —
 *  what getStopWatchBrokenDownTime answers, which calls it with
 *  includeDecimalSeconds false. */
export interface BrokenDownTime {
    negative: boolean;
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
    milliSeconds: number;
}

/** The elapsedTime getStopWatches reports per watch: the same table with
 *  generateElapsedTimeTable's includeDecimalSeconds on. */
export interface ElapsedTime extends BrokenDownTime {
    /** Signed total seconds (matches Mudlet's elapsedMilliSeconds / 1000). */
    decimalSeconds: number;
}

/** Per-watch record returned by getStopWatches (keyed by stringified id). */
export interface StopwatchSummary {
    name: string;
    isRunning: boolean;
    isPersistent: boolean;
    elapsedTime: ElapsedTime;
}

interface Stopwatch {
    id: number;
    name: string;          // '' = unnamed
    /** Mudlet's mIsInitialised: false until the watch is first started or
     *  adjusted, and again after a stopped watch is reset. An uninitialised
     *  watch reads 0, cannot be stopped and is "already reset". */
    initialised: boolean;
    running: boolean;
    accumulatedMs: number; // frozen elapsed from prior runs
    startEpochMs: number;  // Date.now() at the current run's start (absolute; only meaningful while running)
    persistent: boolean;
}

/** Serialized shape written to the StopwatchStore. */
interface PersistedStopwatch {
    id: number;
    name: string;
    initialised?: boolean; // absent in records written before it was tracked
    running: boolean;
    accumulatedMs: number;
    startEpochMs: number;
}

/**
 * How a stopwatch was asked for: a number is an ID, a string is a name — only
 * a Lua number is an ID, so "5" names a stopwatch called 5 (Mudlet tests the
 * argument with `lua_type(L, 1) == LUA_TNUMBER`). The empty name stands for the
 * first (lowest ID) unnamed stopwatch.
 */
export type StopwatchSubject = number | string;

/**
 * A refusal, in the words Mudlet's `Host` and `TLuaInterpreter` use for it —
 * the binding hands it to Lua as the second value after nil.
 */
export type StopwatchRefusal = { refused: string };

const refuse = (message: string): StopwatchRefusal => ({ refused: message });

export const isRefusal = (v: unknown): v is StopwatchRefusal =>
    typeof v === 'object' && v !== null && typeof (v as StopwatchRefusal).refused === 'string';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MIN = 60_000;
const MS_PER_SEC = 1000;

/**
 * How much time a stopwatch can hold, in either direction — Mudlet's
 * `stopWatch::csmMaximumMilliSeconds`. A little under 31,700 years, which is
 * past any use a stopwatch has and well inside what a double counts exactly, so
 * no arithmetic on a stopwatch's time can run off the end of the range and land
 * on a time of the opposite sign. Time reaching the bound is clamped to it; an
 * adjustment asking for more than the whole range outright is refused instead
 * of quietly flattened (upstream #10793).
 */
const MAX_STOPWATCH_MS = 1_000_000_000_000_000;

const clampToRange = (ms: number): number =>
    Math.min(MAX_STOPWATCH_MS, Math.max(-MAX_STOPWATCH_MS, ms));

/** Decompose signed milliseconds into Mudlet's day/hour/minute/second table. */
function breakDown(ms: number): ElapsedTime {
    const decimalSeconds = ms / 1000;
    let abs = Math.abs(Math.round(ms));
    const days = Math.floor(abs / MS_PER_DAY); abs -= days * MS_PER_DAY;
    const hours = Math.floor(abs / MS_PER_HOUR); abs -= hours * MS_PER_HOUR;
    const minutes = Math.floor(abs / MS_PER_MIN); abs -= minutes * MS_PER_MIN;
    const seconds = Math.floor(abs / MS_PER_SEC); abs -= seconds * MS_PER_SEC;
    return { negative: ms < 0, days, hours, minutes, seconds, milliSeconds: abs, decimalSeconds };
}

export class StopwatchManager {
    private readonly watches = new Map<number, Stopwatch>();

    constructor(private readonly storage?: StopwatchStore) {
        this.restore();
    }

    private now(): number {
        return Date.now();
    }

    // Clamped, because a stopwatch adjusted close to the end of the range runs
    // out of it as time passes — so this is what a RUNNING one reports, not
    // only what an adjustment stores.
    private elapsedMs(w: Stopwatch): number {
        if (!w.initialised) return 0;
        return clampToRange(w.accumulatedMs + (w.running ? this.now() - w.startEpochMs : 0));
    }

    /** Watches in ascending ID order — Mudlet's std::map, which is what makes
     *  "the first unnamed stopwatch" the lowest-numbered one. */
    private ordered(): Stopwatch[] {
        return [...this.watches.values()].sort((a, b) => a.id - b.id);
    }

    /** Host::findStopWatchId — the first watch with this name, '' finding the
     *  first unnamed one. */
    private findByName(name: string): Stopwatch | undefined {
        return this.ordered().find(w => w.name === name);
    }

    /**
     * Look a subject up, or answer the refusal for one that is not there.
     * `idWord` is the one place the family disagrees with itself: the
     * functions that go through `TLuaInterpreter::csmInvalidStopWatchID` say
     * "ID", the ones whose message comes from `Host` say "id".
     */
    private lookup(subject: StopwatchSubject, idWord: 'ID' | 'id'): Stopwatch | StopwatchRefusal {
        if (typeof subject === 'number') {
            return this.watches.get(subject) ?? refuse(`stopwatch with ${idWord} ${subject} not found`);
        }
        return this.findByName(subject) ?? refuse(subject === ''
            ? 'no unnamed stopwatches found'
            : `stopwatch with name '${subject}' not found`);
    }

    /** The refusal looking `subject` up gives where TLuaInterpreter's own
     *  csmInvalidStopWatchID words it ("ID"), or null when the watch exists. */
    missing(subject: StopwatchSubject): StopwatchRefusal | null {
        const w = this.lookup(subject, 'ID');
        return isRefusal(w) ? w : null;
    }

    /** How Host names a watch in an "already" refusal: the way it was asked for. */
    private describe(subject: StopwatchSubject, w: Stopwatch): string {
        return typeof subject === 'number'
            ? `stopwatch with id ${w.id}`
            : `stopwatch with name '${subject}' (id:${w.id})`;
    }

    /** Rehydrate persistent watches from the backing store (called once on construction). */
    private restore(): void {
        if (!this.storage) return;
        let raw: string | null;
        try { raw = this.storage.load(); } catch { return; }
        if (!raw) return;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return; }
        if (!Array.isArray(parsed)) return;
        for (const r of parsed as PersistedStopwatch[]) {
            if (!r || typeof r.id !== 'number') continue;
            const running = !!r.running;
            const accumulatedMs = Number(r.accumulatedMs) || 0;
            this.watches.set(r.id, {
                id: r.id,
                name: typeof r.name === 'string' ? r.name : '',
                initialised: typeof r.initialised === 'boolean' ? r.initialised : (running || accumulatedMs !== 0),
                running,
                accumulatedMs,
                startEpochMs: Number(r.startEpochMs) || 0,
                persistent: true,
            });
        }
    }

    /** Write the current set of persistent watches to the backing store. */
    private persist(): void {
        if (!this.storage) return;
        const records: PersistedStopwatch[] = [];
        for (const w of this.watches.values()) {
            if (!w.persistent) continue;
            records.push({
                id: w.id, name: w.name, initialised: w.initialised, running: w.running,
                accumulatedMs: w.accumulatedMs, startEpochMs: w.startEpochMs,
            });
        }
        // Quota / availability failures are non-fatal — persistence degrades to
        // memory-only rather than breaking the timer.
        try { this.storage.save(JSON.stringify(records)); } catch { /* ignore */ }
    }

    private touched(w: Stopwatch): void {
        if (w.persistent) this.persist();
    }

    // ── stopWatch's own state machine (Host.cpp) ────────────────────────────

    private startWatch(w: Stopwatch): boolean {
        if (!w.initialised) {
            w.initialised = true;
            w.accumulatedMs = 0;
            w.startEpochMs = this.now();
            w.running = true;
            return true;
        }
        if (w.running) return false;
        w.startEpochMs = this.now();
        w.running = true;
        return true;
    }

    private stopWatch(w: Stopwatch): boolean {
        if (!w.initialised || !w.running) return false;
        // Read while it still counts as running, so the stored time is the
        // clamped one elapsedMs reports rather than an unbounded sum.
        w.accumulatedMs = this.elapsedMs(w);
        w.running = false;
        return true;
    }

    /** A stopped watch goes back to never-started; a running one restarts
     *  from zero and keeps running. One never started has nothing to reset. */
    private resetWatch(w: Stopwatch): boolean {
        if (!w.initialised) return false;
        w.accumulatedMs = 0;
        if (w.running) w.startEpochMs = this.now();
        else w.initialised = false;
        return true;
    }

    // ── the Lua-facing family ───────────────────────────────────────────────

    /**
     * Mudlet createStopWatch([name], [autostart]). Returns the new id, or the
     * refusal when `name` is already in use (Mudlet rejects duplicate names).
     */
    create(name: string, autoStart: boolean): number | StopwatchRefusal {
        if (name) {
            const holder = this.findByName(name);
            if (holder) return refuse(`stopwatch with id ${holder.id} called '${name}' already exists`);
        }
        // Host::createStopWatch: the lowest id not in use, counting from 1.
        let id = 1;
        while (this.watches.has(id)) id++;
        const w: Stopwatch = {
            id, name: name || '', initialised: false, running: false,
            accumulatedMs: 0, startEpochMs: 0, persistent: false,
        };
        this.watches.set(id, w);
        if (autoStart) this.startWatch(w);
        return id;
    }

    /**
     * Mudlet startStopWatch. `resetAndRestart` replicates the legacy behaviour
     * for a numeric id called bare: reset to zero and run from there, which
     * always succeeds. Asked to keep the elapsed time instead, starting one
     * that is already running is refused.
     */
    start(subject: StopwatchSubject, resetAndRestart: boolean): true | StopwatchRefusal {
        const w = this.lookup(subject, 'id');
        if (isRefusal(w)) return w;
        if (resetAndRestart) {
            this.stopWatch(w);
            this.resetWatch(w);
            this.startWatch(w);
        } else if (!this.startWatch(w)) {
            return refuse(`${this.describe(subject, w)} was already running`);
        }
        this.touched(w);
        return true;
    }

    /**
     * Mudlet stopStopWatch. Pauses the watch and returns the elapsed seconds
     * once (legacy behaviour preserved by Mudlet). Stopping one that is
     * already stopped — including one that was never started — is refused.
     */
    stop(subject: StopwatchSubject): number | StopwatchRefusal {
        const w = this.lookup(subject, 'id');
        if (isRefusal(w)) return w;
        if (!this.stopWatch(w)) return refuse(`${this.describe(subject, w)} was already stopped`);
        this.touched(w);
        return this.elapsedMs(w) / 1000;
    }

    /** Mudlet getStopWatchTime — elapsed seconds without stopping. */
    getTime(subject: StopwatchSubject): number | StopwatchRefusal {
        const w = this.lookup(subject, 'ID');
        if (isRefusal(w)) return w;
        return this.elapsedMs(w) / 1000;
    }

    /** Mudlet getStopWatchBrokenDownTime — elapsed time as a day/hour/minute/
     *  second/millisecond table. */
    getBrokenDownTime(subject: StopwatchSubject): BrokenDownTime | StopwatchRefusal {
        const w = this.lookup(subject, 'id');
        if (isRefusal(w)) return w;
        // generateElapsedTimeTable is called with includeDecimalSeconds false
        // here; only getStopWatches carries that field.
        const { negative, days, hours, minutes, seconds, milliSeconds } = breakDown(this.elapsedMs(w));
        return { negative, days, hours, minutes, seconds, milliSeconds };
    }

    /**
     * Mudlet `setStopWatchName(id|name, newName)` — Host::setStopWatchName.
     * Refuses a name another stopwatch already carries, naming that one; the
     * empty new name takes a watch's name away again.
     */
    setName(subject: StopwatchSubject, newName: string): true | StopwatchRefusal {
        if (typeof subject === 'number') {
            // By id the name is checked first, as Host does: a name that is
            // taken is the answer even when the id is not a stopwatch at all.
            if (newName) {
                const holder = this.findByName(newName);
                if (holder) {
                    return holder.id === subject
                        ? true
                        : refuse(`the name '${newName}' is already in use for another stopwatch (id:${holder.id})`);
                }
            }
        }
        const w = this.lookup(subject, 'id');
        if (isRefusal(w)) return w;
        if (newName) {
            const holder = this.ordered().find(o => o !== w && o.name === newName);
            if (holder) return refuse(`the name '${newName}' is already in use for another stopwatch (id:${holder.id})`);
        }
        if (w.name === newName) return true;
        w.name = newName;
        this.touched(w);
        return true;
    }

    /** Mudlet resetStopWatch — zero the elapsed time; a running watch keeps running. */
    reset(subject: StopwatchSubject): true | StopwatchRefusal {
        const w = this.lookup(subject, 'id');
        if (isRefusal(w)) return w;
        if (!this.resetWatch(w)) {
            return refuse(subject === ''
                ? `the first unnamed stopwatch (id:${w.id}) was already reset`
                : `${this.describe(subject, w)} was already reset`);
        }
        this.touched(w);
        return true;
    }

    /**
     * Mudlet `adjustStopWatch` — add `seconds` (may be negative) to the elapsed
     * time. Time that accumulates past the end of the range stops there; an
     * adjustment asking for more than the whole range is refused with the
     * reason, as every other out-of-range stopwatch argument is.
     *
     * It is the MILLISECONDS the adjustment rounds to that are bounded, since
     * that is what a stopwatch keeps its time in, and the comparison is written
     * so that a NaN or an infinity fails it too.
     */
    adjust(subject: StopwatchSubject, seconds: number): true | StopwatchRefusal {
        const w = this.lookup(subject, 'ID');
        if (isRefusal(w)) return w;
        const milliSeconds = Math.round(seconds * 1000);
        if (!(milliSeconds >= -MAX_STOPWATCH_MS && milliSeconds <= MAX_STOPWATCH_MS)) {
            const limit = MAX_STOPWATCH_MS / MS_PER_SEC;
            return refuse(`modification in seconds must be a finite number from ${-limit} to ${limit}, got ${seconds}`);
        }
        // Adjusting one never started starts its clock at the adjustment,
        // without setting it running.
        w.initialised = true;
        if (w.running) {
            // A running stopwatch measures from an effective start time, so the
            // shift goes through the total elapsed time: moving that start time
            // by the adjustment instead would carry it PAST the end of the
            // range rather than stopping at it.
            const now = this.now();
            w.accumulatedMs = clampToRange(this.elapsedMs(w) + milliSeconds);
            w.startEpochMs = now;
        } else {
            w.accumulatedMs = clampToRange(w.accumulatedMs + milliSeconds);
        }
        this.touched(w);
        return true;
    }

    /** Mudlet deleteStopWatch. */
    delete(subject: StopwatchSubject): true | StopwatchRefusal {
        const w = this.lookup(subject, 'ID');
        if (isRefusal(w)) return w;
        this.watches.delete(w.id);
        if (w.persistent) this.persist();
        return true;
    }

    /** Host::removeAllNonPersistentStopWatches, which resetProfile() runs:
     *  every watch not flagged persistent goes, freeing its ID. */
    removeNonPersistent(): void {
        for (const w of [...this.watches.values()]) {
            if (!w.persistent) this.watches.delete(w.id);
        }
    }

    /**
     * Mudlet setStopWatchPersistence(id|name, state). Marks whether the watch is
     * saved to (and restored from) the backing store across reloads.
     */
    setPersistence(subject: StopwatchSubject, state: boolean): true | StopwatchRefusal {
        const w = this.lookup(subject, 'ID');
        if (isRefusal(w)) return w;
        w.persistent = state;
        this.persist();
        return true;
    }

    /** Mudlet getStopWatches — record keyed by stringified id (Bridge.lua re-keys to ints). */
    getAll(): Record<string, StopwatchSummary> {
        const out: Record<string, StopwatchSummary> = {};
        for (const w of this.watches.values()) {
            out[String(w.id)] = {
                name: w.name,
                isRunning: w.running,
                isPersistent: w.persistent,
                elapsedTime: breakDown(this.elapsedMs(w)),
            };
        }
        return out;
    }
}
