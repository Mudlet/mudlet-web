import { ItemIdSequence } from '../ItemIdSequence';
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
    /** Killed, but not yet reaped. Mudlet frees a killed timer in the deferred
     *  cleanup its unit runs at the end of a line, not at the kill itself, so
     *  until then the timer is still *findable* while no longer running:
     *  `exists` says 1, `isActive` says 0, `remainingTime` reports it inactive
     *  rather than unknown, and a second `killTimer` has a corpse to find and
     *  so answers false. See {@link reapKilled}. */
    dead?: boolean;
    /** Switched off by `disableTimer(id)`. The pending timeout is cleared; the
     *  timer stays findable and `enableTimer(id)` re-arms it. */
    disabled?: boolean;
    /** Re-arms the timer for a full interval from now — what enableTimer does. */
    arm?: () => void;
}

/** A permanent timer list indexed the ways the engine walks it. */
interface PermTree {
    timers: TimerNode[];
    byId: Map<string, TimerNode>;
    children: Map<string, TimerNode[]>;
    /** Ids switched on along with every ancestor (canBeUnlocked). */
    enabledIds: Set<string>;
    /** A timer nested under another *timer* rather than a folder (TTimer.h). */
    isOffset: (t: TimerNode) => boolean;
}

function permTree(timers: TimerNode[]): PermTree {
    const byId = new Map(timers.map(t => [t.id, t]));
    const children = new Map<string, TimerNode[]>();
    for (const t of timers) {
        if (!t.parentId || !byId.has(t.parentId)) continue;
        const list = children.get(t.parentId) ?? [];
        list.push(t);
        children.set(t.parentId, list);
    }
    const isOffset = (t: TimerNode): boolean => {
        if (t.isGroup || !t.parentId) return false;
        const parent = byId.get(t.parentId);
        return !!parent && !parent.isGroup;
    };
    return { timers, byId, children, enabledIds: buildEffectivelyEnabledIds(timers), isOffset };
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
    /** Shared with every other engine in the profile — see ItemIdSequence. */
    private idSeq = new ItemIdSequence();
    setIdSequence(seq: ItemIdSequence): void { this.idSeq = seq; }

    /** Number of live session-scoped temp timers (Mudlet `getProfileStats` temp
     *  count). Killed-but-unreaped timers are not live and don't count. */
    get tempCount(): number {
        let n = 0;
        for (const entry of this.temp.values()) if (!entry.dead) n++;
        return n;
    }

    addTemp(seconds: number, fn: TempFn, repeat = false): number {
        const id = this.idSeq.next();
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
            this.temp.set(id, { handle, repeat, start: Date.now(), intervalMs, fire, arm });
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
            if (entry.dead || entry.disabled || now < entry.start + entry.intervalMs) continue;
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
     * Whether a temporary timer with this id is still present.
     *
     * Backs `exists(id, "timer")`. Temp timers aren't in the store and — unlike
     * temp triggers and aliases — aren't tracked in LuaRuntime's tempIds either,
     * so this map is the only thing that knows.
     *
     * Present is not running: a killed timer stays here until the reap, and a
     * disabled one until it is killed — see {@link tempIsActive}.
     */
    hasTemp(id: number): boolean {
        return this.temp.has(id);
    }

    /** Whether a temporary timer is present *and* still running — `isActive(id,
     *  "timer")`. False for one killed since the last reap. */
    tempIsActive(id: number): boolean {
        const entry = this.temp.get(id);
        return !!entry && !entry.dead && !entry.disabled;
    }

    /**
     * Mudlet `enableTimer(id)` / `disableTimer(id)` on a temporary timer. Mudlet
     * names a temp timer by the id tempTimer returned, so its name-based toggles
     * reach temp timers too. Disabling stops the pending tick; enabling re-arms
     * it for a full interval, as Mudlet restarts the QTimer. Returns false for
     * an unknown or killed timer.
     */
    setTempEnabled(id: number, enabled: boolean): boolean {
        const entry = this.temp.get(id);
        if (!entry || entry.dead) return false;
        if (!enabled) {
            if (!entry.disabled) clearTimeout(entry.handle);
            entry.disabled = true;
        } else if (entry.disabled) {
            // arm() replaces the entry, which drops the disabled flag.
            entry.arm?.();
        }
        return true;
    }

    killTimer(id: number): boolean {
        const entry = this.temp.get(id);
        // Nothing there, or a corpse waiting to be reaped: either way this call
        // achieved nothing and has to say so.
        if (!entry || entry.dead) return false;
        // Every temp timer is a setTimeout now, repeating ones included.
        clearTimeout(entry.handle);
        // Marked rather than dropped — see TimerEntry.dead. reapKilled() frees it.
        entry.dead = true;
        return true;
    }

    /** Free every timer killed since the last call. Runs once per processed line
     *  batch, mirroring the deferred cleanup Mudlet's TTimerUnit does. */
    reapKilled(): void {
        for (const [id, entry] of this.temp) if (entry.dead) this.temp.delete(id);
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

    /**
     * Offset timers keyed by the id of the timer they hang off. In Mudlet a
     * timer nested under another *timer* (not a folder) is an offset timer
     * purely by where it sits (TTimer.h:75-84): it never runs on its own clock
     * and is skipped by the normal start walk (TTimer.cpp:314, :329). Each time
     * its parent fires it is started once, due its own interval later
     * (TTimer.cpp:255-265). Rebuilt on every {@link loadPerm}; only holds
     * children that are effectively enabled.
     */
    private readonly offsetChildren = new Map<string, TimerNode[]>();

    /**
     * Permanent timers whose *runtime* active flag is up — TTimer's `mActive`
     * (Tree.h), kept apart from the user's switch (`enabled`, Mudlet's
     * `mUserActiveState`). The two disagree in exactly the cases `isActive`
     * can see: a timer imported enabled under a disabled folder is left
     * inactive, while an explicit `enableTimer()` on it raises the flag even
     * though a disabled ancestor keeps it from running. Only non-offset timers
     * are tracked; Mudlet reports an offset timer by its switch alone.
     * See {@link applyPermSwitch} for the transitions and {@link loadPerm} for
     * how the flag is seeded.
     */
    private readonly activePerm = new Set<string>();
    /** Each permanent timer's switch and parent as of the last
     *  {@link loadPerm}, so the next one can tell a switch flipped behind the
     *  engine's back (the editor) from one that never moved. */
    private readonly seenPerm = new Map<string, { enabled: boolean; parentId: string | null }>();

    loadPerm(timers: TimerNode[], executeFn: ExecuteFn): void {
        const tree = permTree(timers);
        const { enabledIds, isOffset } = tree;
        this.reconcileActive(tree);
        this.knownPermNames.clear();
        for (const t of timers) if (!t.isGroup) this.knownPermNames.add(t.name);
        this.offsetChildren.clear();
        for (const t of timers) {
            if (!isOffset(t) || !enabledIds.has(t.id)) continue;
            const list = this.offsetChildren.get(t.parentId!) ?? [];
            list.push(t);
            this.offsetChildren.set(t.parentId!, list);
        }
        const nextIds = new Set<string>();
        const nextDesc = new Map<string, string>();
        const nextNames = new Map<string, string>();

        for (const timer of timers) {
            const desc = this.descOf(timer);
            const prevDesc = this.prevDesc.get(timer.id);
            const isLive = this.perm.has(timer.id);

            if (isOffset(timer)) {
                // Never started from here — only its parent's firing arms it.
                // One already armed by that survives a reload unchanged, as
                // long as it is still enabled and still the same timer.
                if (isLive && enabledIds.has(timer.id) && prevDesc === desc) {
                    nextIds.add(timer.id);
                    nextDesc.set(timer.id, desc);
                    if (!nextNames.has(timer.name)) nextNames.set(timer.name, timer.id);
                } else if (isLive) {
                    this.killPermHandle(timer.id);
                }
                continue;
            }

            const wantRun = enabledIds.has(timer.id) && !(timer.isGroup && !timer.code);
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
                this.startPerm(timer, executeFn, timer.repeat);
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

    /**
     * Bring the runtime active flags in line with a new node list.
     *
     * - A timer seen for the first time is set as Mudlet's loader leaves it:
     *   XMLimport::readTimer only activates a root that is switched on, and
     *   TTimer::enableTimer(int) carries that down through folders to each
     *   child whose whole ancestry is switched on (canBeUnlocked). So it is
     *   active exactly when effectively enabled. A flag an explicit
     *   {@link applyPermSwitch} raised before this first sight is kept, as
     *   long as the timer is still switched on.
     * - A timer that moved to another parent is re-seeded the same way,
     *   strictly: TimerUnit::reParentTimer disables it and re-enables it by id,
     *   which only activates it if it can be unlocked where it now sits.
     * - A timer whose switch flipped without going through enable/disableTimer
     *   (the editor's checkbox) gets the same transition those would apply.
     */
    private reconcileActive(tree: PermTree): void {
        const { timers, enabledIds, children } = tree;
        const ids = new Set(timers.map(t => t.id));
        for (const id of [...this.activePerm]) if (!ids.has(id)) this.activePerm.delete(id);
        for (const id of [...this.seenPerm.keys()]) if (!ids.has(id)) this.seenPerm.delete(id);

        const reseat = new Set<string>();
        const flipped: TimerNode[] = [];
        for (const t of timers) {
            const prev = this.seenPerm.get(t.id);
            if (!prev) {
                if (enabledIds.has(t.id)) this.activePerm.add(t.id);
                else if (!t.enabled) this.activePerm.delete(t.id);
            } else if (prev.parentId !== t.parentId) {
                reseat.add(t.id);
            } else if (prev.enabled !== t.enabled) {
                flipped.push(t);
            }
        }
        // A moved timer takes its subtree with it; re-seed all of it.
        const stack = [...reseat];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (enabledIds.has(id)) this.activePerm.add(id);
            else this.activePerm.delete(id);
            for (const c of children.get(id) ?? []) if (!reseat.has(c.id)) { reseat.add(c.id); stack.push(c.id); }
        }
        for (const t of flipped) this.switchOne(t, t.enabled, tree);

        this.seenPerm.clear();
        for (const t of timers) this.seenPerm.set(t.id, { enabled: t.enabled, parentId: t.parentId });
    }

    /**
     * Mudlet `enableTimer(name)` / `disableTimer(name)` on permanent timers, as
     * far as the runtime active flag goes (TimerUnit::enableTimer/disableTimer).
     * `timers` is the node list *after* the switches were written. Applied even
     * when a switch did not move: enabling an already switched-on timer under a
     * disabled folder still raises its flag, and disabling an already
     * switched-off folder still lowers the flags beneath it.
     */
    applyPermSwitch(ids: readonly string[], on: boolean, timers: TimerNode[]): void {
        const tree = permTree(timers);
        for (const id of ids) {
            const t = tree.byId.get(id);
            if (t) this.switchOne(t, on, tree);
        }
        // Record the switches as seen, so the reload the same write triggers
        // does not apply the transition a second time.
        for (const t of timers) this.seenPerm.set(t.id, { enabled: t.enabled, parentId: t.parentId });
    }

    private switchOne(t: TimerNode, on: boolean, tree: PermTree): void {
        const { enabledIds, children, isOffset } = tree;
        if (!on) {
            // setIsActive(false), then TTimer::disableTimer() deactivates every
            // descendant without touching their own switches.
            this.activePerm.delete(t.id);
            const stack = [...(children.get(t.id) ?? [])];
            while (stack.length > 0) {
                const c = stack.pop()!;
                this.activePerm.delete(c.id);
                stack.push(...(children.get(c.id) ?? []));
            }
            return;
        }
        // An offset timer is reported by its switch, and its own flag belongs
        // to its parent's firing (TTimer::execute).
        if (isOffset(t)) return;
        // setIsActive(true) raises the flag whatever the ancestors say...
        if (t.enabled) this.activePerm.add(t.id);
        // ...and a folder then walks its non-offset descendants with
        // TTimer::enableTimer(), which activates each one only if it and every
        // ancestor are switched on (canBeUnlocked).
        if (!t.isGroup) return;
        const stack = (children.get(t.id) ?? []).filter(c => !isOffset(c));
        while (stack.length > 0) {
            const c = stack.pop()!;
            if (enabledIds.has(c.id)) this.activePerm.add(c.id);
            stack.push(...(children.get(c.id) ?? []).filter(g => !isOffset(g)));
        }
    }

    /**
     * What Mudlet's `isActive(name, "timer" [, checkAncestors])` reports for a
     * permanent timer: an offset timer by its switch (shouldBeActive), any
     * other by its runtime flag (TTimer::isActive). With `checkAncestors`, every
     * ancestor has to report active by the same rule (shouldAncestorsBeActive).
     */
    permReportsActive(node: TimerNode, timers: TimerNode[], checkAncestors = false): boolean {
        const tree = permTree(timers);
        if (!this.reportsActive(node, tree)) return false;
        return !checkAncestors || this.permAncestorsActive(node, timers, tree);
    }

    /** Mudlet `isAncestorsActive(id, "timer")`: every ancestor reports active,
     *  by the rule {@link permReportsActive} uses. */
    permAncestorsActive(node: TimerNode, timers: TimerNode[], tree = permTree(timers)): boolean {
        const seen = new Set<string>([node.id]);
        let p = node.parentId ? tree.byId.get(node.parentId) : undefined;
        while (p && !seen.has(p.id)) {
            if (!this.reportsActive(p, tree)) return false;
            seen.add(p.id);
            p = p.parentId ? tree.byId.get(p.parentId) : undefined;
        }
        return true;
    }

    /** How many non-folder permanent timers report active — the timer half of
     *  getProfileStats' active count, by the rule {@link permReportsActive} uses. */
    countPermActive(timers: TimerNode[]): number {
        const tree = permTree(timers);
        let n = 0;
        for (const t of timers) if (!t.isGroup && this.reportsActive(t, tree)) n++;
        return n;
    }

    private reportsActive(node: TimerNode, tree: PermTree): boolean {
        if (!node.enabled) return false;
        return tree.isOffset(node) || this.activePerm.has(node.id);
    }

    /** (Re)start every enabled offset timer hanging off `parentId`, each due
     *  its own interval from now. A child still pending from the previous
     *  parent tick is restarted, as QTimer::start does on a running timer. */
    private armOffsetChildren(parentId: string, executeFn: ExecuteFn): void {
        for (const child of this.offsetChildren.get(parentId) ?? []) {
            this.killPermHandle(child.id);
            this.startPerm(child, executeFn, false);
            this.prevDesc.set(child.id, this.descOf(child));
            if (!this.permNameToId.has(child.name)) this.permNameToId.set(child.name, child.id);
        }
    }

    private startPerm(timer: TimerNode, executeFn: ExecuteFn, repeat: boolean): void {
        // Children are armed before the body runs, so a script that disables
        // one of them in the same tick (and so reloads the engine) cancels it.
        const fire = () => { this.armOffsetChildren(timer.id, executeFn); executeFn(timer); };
        const intervalMs = timer.seconds * 1000;
        const start = Date.now();
        if (repeat) {
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
        // A killed timer is still present until the reap, but it is stopped — so
        // it reports as inactive, not as an unknown id. That distinction is what
        // tells a caller the timer it just killed is really the one it found.
        if (entry.dead || entry.disabled) return -1;
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
        this.offsetChildren.clear();
        this.activePerm.clear();
        this.seenPerm.clear();
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
