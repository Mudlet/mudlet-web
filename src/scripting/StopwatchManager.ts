// Mudlet-compatible stopwatch API backing createStopWatch/startStopWatch/etc.
//
// Mudlet stopwatches are millisecond-resolution wall-clock timers identified by
// a monotonic numeric id and an optional unique name. We measure elapsed time
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
    return `mudix_stopwatches_${connectionId}`;
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

/** Broken-down elapsed time, mirroring Mudlet's generateElapsedTimeTable. */
export interface BrokenDownTime {
    negative: boolean;
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
    milliSeconds: number;
    /** Signed total seconds (matches Mudlet's elapsedMilliSeconds / 1000). */
    decimalSeconds: number;
}

/** Per-watch record returned by getStopWatches (keyed by stringified id). */
export interface StopwatchSummary {
    name: string;
    isRunning: boolean;
    isPersistent: boolean;
    elapsedTime: BrokenDownTime;
}

interface Stopwatch {
    id: number;
    name: string;          // '' = unnamed
    running: boolean;
    accumulatedMs: number; // frozen elapsed from prior runs
    startEpochMs: number;  // Date.now() at the current run's start (absolute; only meaningful while running)
    persistent: boolean;
}

/** Serialized shape written to the StopwatchStore. */
interface PersistedStopwatch {
    id: number;
    name: string;
    running: boolean;
    accumulatedMs: number;
    startEpochMs: number;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MIN = 60_000;
const MS_PER_SEC = 1000;

/** Decompose signed milliseconds into Mudlet's day/hour/minute/second table. */
function breakDown(ms: number): BrokenDownTime {
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
    private nextId = 1;

    constructor(private readonly storage?: StopwatchStore) {
        this.restore();
    }

    private now(): number {
        return Date.now();
    }

    private elapsedMs(w: Stopwatch): number {
        return w.accumulatedMs + (w.running ? this.now() - w.startEpochMs : 0);
    }

    /**
     * Resolve a watchID-or-name argument. Numbers (and numeric strings, which
     * Mudlet's lua_isnumber treats as ids) look up by id; other strings look up
     * by name. An empty string returns the first unnamed watch — Mudlet's
     * findStopWatchId("") behaviour.
     */
    private resolve(arg: number | string): Stopwatch | undefined {
        if (typeof arg === 'number') return this.watches.get(arg);
        if (arg === '') {
            for (const w of this.watches.values()) if (w.name === '') return w;
            return undefined;
        }
        for (const w of this.watches.values()) if (w.name === arg) return w;
        return undefined;
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
        let maxId = 0;
        for (const r of parsed as PersistedStopwatch[]) {
            if (!r || typeof r.id !== 'number') continue;
            this.watches.set(r.id, {
                id: r.id,
                name: typeof r.name === 'string' ? r.name : '',
                running: !!r.running,
                accumulatedMs: Number(r.accumulatedMs) || 0,
                startEpochMs: Number(r.startEpochMs) || 0,
                persistent: true,
            });
            if (r.id > maxId) maxId = r.id;
        }
        this.nextId = maxId + 1;
    }

    /** Write the current set of persistent watches to the backing store. */
    private persist(): void {
        if (!this.storage) return;
        const records: PersistedStopwatch[] = [];
        for (const w of this.watches.values()) {
            if (!w.persistent) continue;
            records.push({
                id: w.id, name: w.name, running: w.running,
                accumulatedMs: w.accumulatedMs, startEpochMs: w.startEpochMs,
            });
        }
        // Quota / availability failures are non-fatal — persistence degrades to
        // memory-only rather than breaking the timer.
        try { this.storage.save(JSON.stringify(records)); } catch { /* ignore */ }
    }

    /**
     * Mudlet createStopWatch([name], [autostart]). Returns the new id, or null
     * when `name` is given and already in use (Mudlet rejects duplicate names).
     */
    create(name: string, autoStart: boolean): number | null {
        if (name) {
            for (const w of this.watches.values()) if (w.name === name) return null;
        }
        const id = this.nextId++;
        const w: Stopwatch = {
            id, name: name || '', running: false, accumulatedMs: 0, startEpochMs: 0, persistent: false,
        };
        this.watches.set(id, w);
        if (autoStart) { w.running = true; w.startEpochMs = this.now(); }
        return id;
    }

    /**
     * Mudlet startStopWatch. `resetAndRestart` replicates the legacy behaviour
     * for a numeric id called bare: reset to zero and run from there. Otherwise
     * a stopped watch resumes and a running one is left untouched. Returns false
     * for an unknown watch.
     */
    start(arg: number | string, resetAndRestart: boolean): boolean {
        const w = this.resolve(arg);
        if (!w) return false;
        if (resetAndRestart) {
            w.accumulatedMs = 0;
            w.startEpochMs = this.now();
            w.running = true;
        } else if (!w.running) {
            w.startEpochMs = this.now();
            w.running = true;
        }
        if (w.persistent) this.persist();
        return true;
    }

    /**
     * Mudlet stopStopWatch. Pauses the watch and returns the elapsed seconds
     * once (legacy behaviour preserved by Mudlet). null for an unknown watch.
     */
    stop(arg: number | string): number | null {
        const w = this.resolve(arg);
        if (!w) return null;
        if (w.running) {
            w.accumulatedMs += this.now() - w.startEpochMs;
            w.running = false;
            if (w.persistent) this.persist();
        }
        return this.elapsedMs(w) / 1000;
    }

    /** Mudlet getStopWatchTime — elapsed seconds without stopping. */
    getTime(arg: number | string): number | null {
        const w = this.resolve(arg);
        if (!w) return null;
        return this.elapsedMs(w) / 1000;
    }

    /** Mudlet getStopWatchBrokenDownTime — elapsed time as a day/hour/minute/
     *  second/millisecond table. null for an unknown watch. */
    getBrokenDownTime(arg: number | string): BrokenDownTime | null {
        const w = this.resolve(arg);
        if (!w) return null;
        return breakDown(this.elapsedMs(w));
    }

    /**
     * Mudlet setStopWatchName(watchID|currentName, newName). Assigns or renames
     * a watch. Returns false for an unknown watch, an empty new name, or when
     * another watch already uses the new name (Mudlet rejects duplicate names).
     */
    /**
     * Mudlet `setStopWatchName(id|name, newName)`. Refuses a name another
     * stopwatch already carries, naming that one — the reason has to reach the
     * caller, so this returns the message (null on success) rather than a bare
     * boolean the binding would have to guess a reason for.
     */
    setName(arg: number | string, newName: string): boolean | string {
        const w = this.resolve(arg);
        // false is reserved for "no such stopwatch" so the Lua guard can phrase
        // that miss the way it phrases every other one (by id or by name).
        if (!w) return false;
        for (const [otherId, other] of this.watches) {
            if (other !== w && other.name === newName && newName.length > 0) {
                return `the name '${newName}' is already in use for another stopwatch (id:${otherId})`;
            }
        }
        if (typeof newName !== 'string' || newName.length === 0) {
            return 'the stopwatch name cannot be empty';
        }
        w.name = newName;
        if (w.persistent) this.persist();
        return true;
    }

    /** Mudlet resetStopWatch — zero the elapsed time; a running watch keeps running. */
    reset(arg: number | string): boolean {
        const w = this.resolve(arg);
        if (!w) return false;
        w.accumulatedMs = 0;
        if (w.running) w.startEpochMs = this.now();
        if (w.persistent) this.persist();
        return true;
    }

    /** Mudlet adjustStopWatch — add `seconds` (may be negative) to the elapsed time. */
    adjust(arg: number | string, seconds: number): boolean {
        const w = this.resolve(arg);
        if (!w || !Number.isFinite(seconds)) return false;
        w.accumulatedMs += Math.round(seconds * 1000);
        if (w.persistent) this.persist();
        return true;
    }

    /** Mudlet deleteStopWatch. */
    delete(arg: number | string): boolean {
        const w = this.resolve(arg);
        if (!w) return false;
        const wasPersistent = w.persistent;
        const removed = this.watches.delete(w.id);
        if (wasPersistent) this.persist();
        return removed;
    }

    /**
     * Mudlet setStopWatchPersistence(id|name, state). Marks whether the watch is
     * saved to (and restored from) the backing store across reloads. Returns
     * false for an unknown watch.
     */
    setPersistence(arg: number | string, state: boolean): boolean {
        const w = this.resolve(arg);
        if (!w) return false;
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
