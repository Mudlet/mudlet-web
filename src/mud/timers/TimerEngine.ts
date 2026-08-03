import type { TimerNode } from '../../storage/schema';
import { buildEffectivelyEnabledIds } from '../../storage/schema';

export type { TimerNode };

type TempFn = () => void;
type ExecuteFn = (timer: TimerNode) => void;

interface TimerEntry {
    handle: ReturnType<typeof setTimeout>;
    repeat: boolean;
    /** Epoch ms when the timer was scheduled — start point for remainingTime. */
    start: number;
    /** Delay/interval in ms (Mudlet stores seconds; we store the resolved ms). */
    intervalMs: number;
    /** What the timer runs when it comes due. Held so {@link pumpDue} can fire a
     *  timer without going through the (blocked) event loop. */
    fire: () => void;
}

export class TimerEngine {
    private readonly temp = new Map<number, TimerEntry>();
    /** Permanent timers keyed by stored TimerNode id (uuid). Two timers can
     *  share a name; we keep id as the canonical handle and build a separate
     *  name → id index for Mudlet's name-based lookups. */
    private readonly perm = new Map<string, TimerEntry>();
    /** Name → first matching id, used by remainingTime / kill-by-name. Only
     *  holds *armed* timers, since that is what loadPerm builds handles for. */
    private readonly permNameToId = new Map<string, string>();
    /** Every stored permanent timer name, armed or not. remainingTime needs it
     *  to tell "exists but inactive" (-1) from "no such timer" (-2): a disabled
     *  timer has no handle, so its absence from `perm` proves nothing. */
    private readonly knownPermNames = new Set<string>();
    private nextId = 1;

    /** Number of live session-scoped temp timers (Mudlet `getProfileStats` temp count). */
    get tempCount(): number {
        return this.temp.size;
    }

    addTemp(seconds: number, fn: TempFn, repeat = false): number {
        const id = this.nextId++;
        const intervalMs = seconds * 1000;
        // A repeating timer is a self-rescheduling setTimeout chain, not a
        // setInterval. pumpDue has to be able to fire a tick early and leave the
        // timer correctly armed for the next one, which setInterval cannot
        // express: its own pending tick would still land and double-fire.
        // Re-arm BEFORE running the body. A repeating timer that kills itself
        // from inside its own callback has to stay dead, and killTimer can only
        // clear a handle that already exists — re-arming afterwards would
        // resurrect it.
        const fire = (): void => {
            if (repeat) arm();
            else this.temp.delete(id);
            fn();
        };
        const arm = (): void => {
            const handle = setTimeout(fire, intervalMs);
            this.temp.set(id, { handle, repeat, start: Date.now(), intervalMs, fire });
        };
        arm();
        return id;
    }

    /**
     * Fire every timer that has come due, without waiting for the event loop to
     * deliver its setTimeout.
     *
     * This exists for `waitForEvent`, the busted-only helper Mudlet implements
     * by spinning a nested QEventLoop. A browser can't re-enter its event loop,
     * so a synchronous wait would block the very setTimeout it is waiting on and
     * deadlock; pumping the due timers by hand is the equivalent of Qt draining
     * its timer queue inside that nested loop.
     *
     * Repeating timers are pumped too — Mudlet's own specs wait on a repeat
     * tick, so skipping them made every such wait time out. That works because
     * a repeat is a self-rescheduling setTimeout (see addTemp): the pending
     * tick is cancelled and re-armed rather than left to land a second time.
     *
     * Returns the number of timers fired.
     */
    pumpDue(now = Date.now()): number {
        let fired = 0;
        // Snapshot first: a callback can add or kill timers, and mutating the
        // map underneath a live iteration would skip or revisit entries.
        const due: Array<() => void> = [];
        for (const [, entry] of this.temp) {
            if (now < entry.start + entry.intervalMs) continue;
            // Cancel the pending timeout and let `fire` do the bookkeeping — it
            // retires a one-shot and re-arms a repeat, so a repeating timer ends
            // up correctly scheduled for its next tick instead of double-firing.
            clearTimeout(entry.handle);
            due.push(entry.fire);
        }
        for (const [id, entry] of this.perm) {
            if (entry.repeat || now < entry.start + entry.intervalMs) continue;
            clearTimeout(entry.handle);
            // entry.fire retires the perm bookkeeping itself.
            due.push(entry.fire);
            void id;
        }
        for (const fire of due) { fire(); fired++; }
        return fired;
    }

    /**
     * Whether a temporary timer with this id is still live.
     *
     * Backs `exists(id, "timer")` / `isActive(id, "timer")`. Temp timers aren't
     * in the store and — unlike temp triggers and aliases — aren't tracked in
     * LuaRuntime's tempIds either, so this map is the only thing that knows.
     * There is no enable/disable for a temporary timer: it is live until it
     * fires or is killed, so existence and activity are the same question.
     */
    hasTemp(id: number): boolean {
        return this.temp.has(id);
    }

    killTimer(id: number): boolean {
        const entry = this.temp.get(id);
        if (!entry) return false;
        // Every temp timer is a setTimeout now, repeating ones included.
        clearTimeout(entry.handle);
        this.temp.delete(id);
        return true;
    }

    /**
     * Cached previous load. `nodes` is the TimerNode keyed by id, `desc` is the
     * shape that determines whether the running setTimeout/setInterval is still
     * correct (seconds, repeat, isGroup, code presence, name) — if `desc` is
     * unchanged AND the timer is still enabled, the live handle is left alone.
     * This makes a name-toggle that disables one timer cost one clearTimeout
     * instead of "clear all + recreate all".
     */
    private readonly prevDesc = new Map<string, string>();

    private descOf(t: TimerNode): string {
        return `${t.seconds}|${t.repeat ? 1 : 0}|${t.isGroup ? 1 : 0}|${t.code ? 1 : 0}|${t.command ?? ''}|${t.language ?? ''}|${t.name}`;
    }

    loadPerm(timers: TimerNode[], executeFn: ExecuteFn): void {
        const enabledIds = buildEffectivelyEnabledIds(timers);
        this.knownPermNames.clear();
        for (const t of timers) if (!t.isGroup) this.knownPermNames.add(t.name);
        const nextIds = new Set<string>();
        const nextDesc = new Map<string, string>();
        const nextNames = new Map<string, string>();

        for (const timer of timers) {
            const wantRun = enabledIds.has(timer.id) && !(timer.isGroup && !timer.code);
            const desc = this.descOf(timer);
            const prevDesc = this.prevDesc.get(timer.id);
            const isLive = this.perm.has(timer.id);

            if (!wantRun) {
                // Drop any live handle for an item that is no longer enabled.
                if (isLive) this.killPermHandle(timer.id);
                continue;
            }

            nextIds.add(timer.id);
            nextDesc.set(timer.id, desc);

            if (isLive && prevDesc === desc) {
                // Same shape, still enabled — leave the running handle alone so
                // remainingTime keeps reporting against the original schedule.
            } else {
                if (isLive) this.killPermHandle(timer.id);
                this.startPerm(timer, executeFn);
            }
            if (!nextNames.has(timer.name)) nextNames.set(timer.name, timer.id);
        }

        // Drop handles for items that disappeared from the list entirely.
        for (const id of [...this.perm.keys()]) {
            if (!nextIds.has(id)) this.killPermHandle(id);
        }

        this.prevDesc.clear();
        for (const [k, v] of nextDesc) this.prevDesc.set(k, v);
        this.permNameToId.clear();
        for (const [k, v] of nextNames) this.permNameToId.set(k, v);
    }

    private startPerm(timer: TimerNode, executeFn: ExecuteFn): void {
        const fire = () => executeFn(timer);
        const intervalMs = timer.seconds * 1000;
        const start = Date.now();
        if (timer.repeat) {
            const handle = setInterval(fire, intervalMs) as unknown as ReturnType<typeof setTimeout>;
            this.perm.set(timer.id, { handle, repeat: true, start, intervalMs, fire });
        } else {
            const retire = () => {
                this.perm.delete(timer.id);
                this.prevDesc.delete(timer.id);
                if (this.permNameToId.get(timer.name) === timer.id) {
                    this.permNameToId.delete(timer.name);
                }
            };
            const handle = setTimeout(() => { retire(); fire(); }, intervalMs);
            this.perm.set(timer.id, {
                handle, repeat: false, start, intervalMs,
                fire: () => { retire(); fire(); },
            });
        }
    }

    private killPermHandle(id: string): void {
        const entry = this.perm.get(id);
        if (!entry) return;
        if (entry.repeat) clearInterval(entry.handle as unknown as number);
        else clearTimeout(entry.handle);
        this.perm.delete(id);
        this.prevDesc.delete(id);
    }

    /**
     * Mudlet `remainingTime(idOrName)` — seconds until the next fire. For
     * non-repeating timers, returns the time left before the one and only
     * fire. For repeating timers, returns the time until the next tick.
     * Mirrors Mudlet's two miss sentinels, which the Lua wrapper turns into
     * different messages: **-1** the timer exists but isn't running (a perm
     * timer starts inactive), **-2** nothing of that id or name exists at all.
     *   - Numeric arg: looks up tempTimer ids only.
     *   - String arg: permanent timer names (or a raw uuid), then temp ids —
     *     a temporary timer's "name" is the number tempTimer handed back, so
     *     remainingTime(tostring(id)) has to resolve the same timer as
     *     remainingTime(id).
     */
    remainingTime(idOrName: number | string): number {
        let entry: TimerEntry | undefined;
        let known = false;
        if (typeof idOrName === 'number') {
            entry = this.temp.get(idOrName);
        } else {
            // String arg: try uuid first, then name → uuid via the index.
            entry = this.perm.get(idOrName);
            if (!entry) {
                const id = this.permNameToId.get(idOrName);
                entry = id ? this.perm.get(id) : undefined;
            }
            if (!entry && /^\d+$/.test(idOrName)) entry = this.temp.get(Number(idOrName));
            // A disabled perm timer has no live handle (loadPerm only arms
            // enabled ones), so "no entry" alone can't tell missing from
            // inactive — the stored node list is what knows the name exists.
            if (!entry) known = this.permNameToId.has(idOrName) || this.knownPermNames.has(idOrName);
        }
        if (!entry) return known ? -1 : -2;
        const elapsed = Date.now() - entry.start;
        const ms = entry.repeat
            ? entry.intervalMs - (elapsed % entry.intervalMs)
            : Math.max(0, entry.intervalMs - elapsed);
        return ms / 1000;
    }

    private stopPerm(): void {
        for (const { handle, repeat } of this.perm.values()) {
            if (repeat) clearInterval(handle as unknown as number);
            else clearTimeout(handle);
        }
        this.perm.clear();
        this.permNameToId.clear();
        this.knownPermNames.clear();
        this.prevDesc.clear();
    }

    destroy(): void {
        for (const { handle, repeat } of this.temp.values()) {
            if (repeat) clearInterval(handle as unknown as number);
            else clearTimeout(handle);
        }
        this.temp.clear();
        this.stopPerm();
    }
}
