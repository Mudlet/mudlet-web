import type {MudletRoom} from 'mudlet-map-binary-reader';

// Mudlet direction number → field name on MudletRoom
const DIR_FIELD: Record<number, string> = {
    1: 'north', 2: 'northeast', 3: 'northwest', 4: 'east', 5: 'west',
    6: 'south', 7: 'southeast', 8: 'southwest', 9: 'up', 10: 'down',
    11: 'in', 12: 'out',
};

// Short direction names emitted into speedWalkDir / used to key exitWeights.
const DIR_SHORT: Record<number, string> = {
    1: 'n', 2: 'ne', 3: 'nw', 4: 'e', 5: 'w',
    6: 's', 7: 'se', 8: 'sw', 9: 'up', 10: 'down',
    11: 'in', 12: 'out',
};

/**
 * The order desktop offers a room's stock exits to the graph (`TMap::initGraph`
 * calls addDirectionalRoute n, e, s, w, up, down, ne, se, sw, nw, in, out), as
 * [direction code, MudletRoom field, short name]. Desktop keeps one edge per
 * destination and replaces the kept one only with a STRICTLY cheaper exit, so
 * of two equal-cost exits into the same room the earlier one here is the one a
 * speedwalk takes. Relaxing in this order with a strict `<` reproduces that.
 */
const STOCK_EXIT_ORDER: ReadonlyArray<readonly [number, string, string]> =
    [1, 4, 6, 5, 9, 10, 2, 7, 8, 3, 11, 12].map(d => [d, DIR_FIELD[d], DIR_SHORT[d]] as const);

/**
 * Verdict from a `setExitWeightFilter` callback for one candidate exit.
 * `blocked` drops the edge from the graph entirely; `weightOverride` replaces
 * the edge cost that the exit weight / target room weight would have given.
 * Both unset means "leave this exit alone".
 */
export interface ExitWeightFilterResult {
    blocked?: boolean;
    weightOverride?: number;
}

/**
 * Called once per candidate exit while the graph is explored, with the room
 * being expanded and the exit's key — the short direction name ("e", "up") for
 * stock exits, or the verbatim command for special exits. Mirrors Mudlet's
 * `applyExitWeightFilter(source, exitKey)` (TMap.cpp).
 */
export type ExitWeightFilter = (roomId: number, exitCommand: string) => ExitWeightFilterResult;

export interface PathfindResult {
    /** Room ids visited in order, excluding the start room. Matches Mudlet's
     *  speedWalkPath, which prepends each step until reaching `from` but never
     *  prepends `from` itself. */
    path: number[];
    /** Direction taken at each step — short name ("n"/"ne"/"up"/"down"/"in"/"out")
     *  for stock exits or the verbatim command string for special exits. Same
     *  length as `path` / `weights`. */
    dirs: string[];
    /** Edge cost per step (target room weight, or per-exit weight override). */
    weights: number[];
    /** Sum of `weights` — Mudlet's getPath returns this alongside the bool. */
    totalWeight: number;
}

/**
 * Mudlet `findPath(from, to)` — A* shortest path. Heuristic mirrors Mudlet's
 * TAstar.h: 3D Euclidean distance when both rooms share an area, constant 1
 * (equivalent to Dijkstra) when they don't — Mudlet falls back because raw
 * coordinates aren't comparable across areas. Edge cost is the per-exit
 * override in `exitWeights[key]` if set, otherwise the target room's `weight`
 * (clamped to ≥1 to keep the heap monotonic).
 *
 * Skips locked rooms (`isLocked`), locked stock-direction exits (`exitLocks`
 * carries the 1-12 dir codes), and locked special exits. Special-exit locks are
 * per COMMAND in Mudlet; pass `isSpecialExitLocked` to resolve them that way.
 * Without it the room's `mSpecialExitLocks` is used, which the binary reader
 * keys by destination room id — that loses per-command resolution when several
 * commands share a destination, but it is the on-disk representation.
 *
 * Trivial `from == to` returns an empty path with totalWeight 0 (also
 * Mudlet's behavior). Returns null when either room is missing or no route
 * exists.
 */
export function findPath(
    rooms: ReadonlyMap<number, MudletRoom>,
    from: number,
    to: number,
    exitFilter?: ExitWeightFilter | null,
    isSpecialExitLocked?: (roomId: number, command: string) => boolean,
): PathfindResult | null {
    const startRoom = rooms.get(from);
    const goalRoom = rooms.get(to);
    if (!startRoom || !goalRoom) return null;
    if (from === to) return { path: [], dirs: [], weights: [], totalWeight: 0 };

    const goalArea = goalRoom.area;
    const gx = goalRoom.x, gy = goalRoom.y, gz = goalRoom.z;
    const heuristic = (id: number): number => {
        const r = rooms.get(id);
        if (!r || r.area !== goalArea) return 1;
        const dx = gx - r.x, dy = gy - r.y, dz = gz - r.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };

    // Binary min-heap of [fScore, id]. Stale entries (a room re-inserted with
    // a better g) are filtered by checking gScore on pop.
    const open: Array<[number, number]> = [];
    const heapPush = (item: [number, number]): void => {
        open.push(item);
        let i = open.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (open[p][0] <= open[i][0]) break;
            [open[p], open[i]] = [open[i], open[p]];
            i = p;
        }
    };
    const heapPop = (): [number, number] | undefined => {
        const top = open[0];
        const last = open.pop();
        if (open.length > 0 && last) {
            open[0] = last;
            let i = 0;
            const n = open.length;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let best = i;
                if (l < n && open[l][0] < open[best][0]) best = l;
                if (r < n && open[r][0] < open[best][0]) best = r;
                if (best === i) break;
                [open[best], open[i]] = [open[i], open[best]];
                i = best;
            }
        }
        return top;
    };

    const gScore = new Map<number, number>();
    const came = new Map<number, { from: number; dir: string; cost: number }>();
    gScore.set(from, 0);
    heapPush([heuristic(from), from]);

    while (open.length > 0) {
        const [f, current] = heapPop()!;
        if (current === to) {
            const path: number[] = [];
            const dirs: string[] = [];
            const weights: number[] = [];
            let total = 0;
            let cur = to;
            while (cur !== from) {
                const link = came.get(cur);
                if (!link) return null;
                path.unshift(cur);
                dirs.unshift(link.dir);
                weights.unshift(link.cost);
                total += link.cost;
                cur = link.from;
            }
            return { path, dirs, weights, totalWeight: total };
        }
        // Skip stale heap entries — a better path was already queued.
        const curG = gScore.get(current);
        if (curG === undefined || f - heuristic(current) > curG + 1e-9) continue;

        const room = rooms.get(current);
        if (!room) continue;
        // Without a filter a locked source room kills every exit, so bail early
        // as before. With one, a numeric weight override rescues individual
        // exits (Mudlet's `filterOverridesBlocks`), so the check moves per-exit.
        if (room.isLocked && !exitFilter) continue;

        const exitWeights = room.exitWeights ?? {};
        const lockedDirs = room.exitLocks ?? [];

        // Relax one candidate edge, consulting the exit weight filter exactly
        // where Mudlet does (TMap.cpp): "block" drops the edge outright, while
        // a numeric override both replaces the cost and bypasses every lock —
        // source room, exit, and target room alike.
        const relax = (target: number, exitKey: string, exitLocked: boolean): void => {
            if (!target || target <= 0 || target === current) return;
            let override: number | undefined;
            if (exitFilter) {
                const verdict = exitFilter(current, exitKey);
                if (verdict.blocked) return;
                override = verdict.weightOverride;
            }
            const bypassesLocks = override !== undefined;
            if (!bypassesLocks && (room.isLocked || exitLocked)) return;
            const targetRoom = rooms.get(target);
            if (!targetRoom) return;
            if (!bypassesLocks && targetRoom.isLocked) return;
            const rawCost = bypassesLocks ? override! : (exitWeights[exitKey] ?? targetRoom.weight ?? 1);
            const cost = rawCost > 0 ? rawCost : 1;
            const tentative = curG + cost;
            if (tentative < (gScore.get(target) ?? Infinity)) {
                gScore.set(target, tentative);
                came.set(target, { from: current, dir: exitKey, cost });
                heapPush([tentative + heuristic(target), target]);
            }
        };

        // Stock 12 directions, in desktop's order (see STOCK_EXIT_ORDER).
        const fields = room as unknown as Record<string, number>;
        for (const [di, field, short] of STOCK_EXIT_ORDER) {
            relax(fields[field], short, lockedDirs.includes(di));
        }

        // Special exits — keyed by command string; see the function docs for
        // how the lock is resolved. Desktop walks them as a QMap, i.e. sorted
        // by command (case-sensitive, UTF-16 code units — what a plain
        // `sort()` compares), so the alphabetically first of two equal-cost
        // commands into one room wins rather than the first one added.
        const lockedSpecialTargets = room.mSpecialExitLocks ?? [];
        const specials = room.mSpecialExits ?? {};
        const commands = Object.keys(specials);
        if (commands.length > 1) commands.sort();
        for (const cmd of commands) {
            const target = specials[cmd];
            const locked = isSpecialExitLocked
                ? isSpecialExitLocked(current, cmd)
                : lockedSpecialTargets.includes(target);
            relax(target, cmd, locked);
        }
    }
    return null;
}
