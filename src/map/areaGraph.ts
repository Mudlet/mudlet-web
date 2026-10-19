/**
 * Desktop's area graph (TAreaGraph.cpp): the areas of a map as a graph — a
 * node per area, a link per pair of areas joined by at least one normal or
 * special exit — and a 2D world position per area from a deterministic
 * force-directed layout. Areas have no shared coordinates of their own, so
 * this is what places them relative to each other in a world view.
 *
 * A position is where the centre of the area's room bounding box goes, in
 * room units. Positions are kept in the map user data under
 * {@link AREA_GRAPH_LAYOUT_KEY}, so they travel with the map file. Areas that
 * already have one keep it when others are added, moving only to make way for
 * an area that grew into them; setPosition() pins an area so it never moves.
 *
 * A port, step for step: the layout is part of the map file, so the same map
 * has to come out the same way here as there. The randomness is desktop's own
 * splitmix64 over the area ids (in BigInt, as it is 64-bit arithmetic), and
 * every loop walks in the order desktop's does, since the order the pushes are
 * applied in decides where areas end up.
 */

/** TAreaGraph::cLayoutUserDataKey. */
export const AREA_GRAPH_LAYOUT_KEY = 'system.areaGraphLayout';
/** TAreaGraph::cMaxCoordinate: positions further out are refused, which keeps
 *  the layout's grid cell arithmetic in range; computed ones are clamped. */
export const AREA_GRAPH_MAX_COORDINATE = 1.0e15;

// Room units between the bounding circles of two areas.
const GAP = 4.0;
const MIN_RADIUS = 2.0;
const ITERATIONS = 300;
const OVERLAP_PASSES = 50;
const SEED = 0x6d75646c65744147n;
const MASK64 = 0xffffffffffffffffn;

const MOBILITY_PINNED = 0;
const MOBILITY_SETTLED = 1;
const MOBILITY_NEW = 2;

/** splitmix64, which desktop uses rather than a <random> distribution whose
 *  output differs between standard libraries. */
function splitMix(input: bigint): bigint {
    let value = (input + 0x9e3779b97f4a7c15n) & MASK64;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return value ^ (value >> 31n);
}

const u32 = (n: number): bigint => BigInt(n >>> 0);

function unitHash(a: number, b = 0): number {
    const value = SEED ^ (u32(a) << 32n) ^ u32(b);
    return Number(splitMix(value) >> 11n) / 2 ** 53;
}

function hashedDirection(a: number, b = 0): [number, number] {
    const angle = unitHash(a, b) * 2.0 * Math.PI;
    return [Math.cos(angle), Math.sin(angle)];
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Every pair i < j whose reach boxes (centre ± reach) overlap, which includes
 * every pair closer than reach[i] + reach[j]. Cells are sized by the median
 * reach so that one huge area does not put all the others in one cell; an
 * area too big for the grid is checked against every other one instead.
 */
function collectNearbyPairs(x: number[], y: number[], reach: number[]): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    const count = x.length;
    if (count < 2) return pairs;
    const sortedReach = [...reach].sort((p, q) => p - q);
    const cellSize = 2.0 * sortedReach[Math.floor(count / 2)];
    const MAX_CELLS_ACROSS = 8;
    const cellOf = (v: number) => Math.floor(v / cellSize);
    const boxesOverlap = (i: number, j: number) =>
        Math.abs(x[i] - x[j]) <= reach[i] + reach[j] && Math.abs(y[i] - y[j]) <= reach[i] + reach[j];

    const lowX: number[] = [], lowY: number[] = [], highX: number[] = [], highY: number[] = [];
    const large: boolean[] = [];
    const largeIds: number[] = [];
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; ++i) {
        lowX[i] = cellOf(x[i] - reach[i]);
        lowY[i] = cellOf(y[i] - reach[i]);
        highX[i] = cellOf(x[i] + reach[i]);
        highY[i] = cellOf(y[i] + reach[i]);
        large[i] = false;
        if (highX[i] - lowX[i] >= MAX_CELLS_ACROSS || highY[i] - lowY[i] >= MAX_CELLS_ACROSS) {
            large[i] = true;
            largeIds.push(i);
            continue;
        }
        for (let cx = lowX[i]; cx <= highX[i]; ++cx) {
            for (let cy = lowY[i]; cy <= highY[i]; ++cy) {
                const key = `${cx},${cy}`;
                const cell = grid.get(key);
                if (cell) cell.push(i);
                else grid.set(key, [i]);
            }
        }
    }
    for (let i = 0; i < count; ++i) {
        if (large[i]) continue;
        for (let cx = lowX[i]; cx <= highX[i]; ++cx) {
            for (let cy = lowY[i]; cy <= highY[i]; ++cy) {
                const cell = grid.get(`${cx},${cy}`);
                if (!cell) continue;
                for (const j of cell) {
                    // Two boxes share several cells; the pair is taken only in the lowest of them.
                    if (j > i && cx === Math.max(lowX[i], lowX[j]) && cy === Math.max(lowY[i], lowY[j]) && boxesOverlap(i, j)) {
                        pairs.push([i, j]);
                    }
                }
            }
        }
    }
    for (const i of largeIds) {
        for (let j = 0; j < count; ++j) {
            if (j !== i && !(large[j] && j < i) && boxesOverlap(i, j)) {
                pairs.push([Math.min(i, j), Math.max(i, j)]);
            }
        }
    }
    return pairs;
}

class Bounds {
    minX = Number.MAX_VALUE;
    maxX = -Number.MAX_VALUE;
    minY = Number.MAX_VALUE;
    maxY = -Number.MAX_VALUE;
    add([cx, cy]: Point, radius: number): void {
        this.minX = Math.min(this.minX, cx - radius);
        this.maxX = Math.max(this.maxX, cx + radius);
        this.minY = Math.min(this.minY, cy - radius);
        this.maxY = Math.max(this.maxY, cy + radius);
    }
    width(): number { return this.maxX - this.minX; }
    height(): number { return this.maxY - this.minY; }
}

type Point = [number, number];

interface StoredPosition { position: Point; pinned: boolean }

export interface AreaGraphNode {
    areaId: number;
    name: string;
    roomCount: number;
    /** Half the diagonal of the room bounding box, at least 2: how much room the area needs. */
    radius: number;
    position: Point;
    pinned: boolean;
}

export interface AreaGraphLink {
    /** fromArea < toArea; an exit counts once in whichever direction it runs. */
    fromArea: number;
    toArea: number;
    exitCount: number;
}

/** A room as the graph reads it: where it is, and where its exits lead. */
export interface AreaGraphRoom {
    area: number;
    x: number;
    y: number;
    /** The twelve normal exits' targets, then the special exits' — ≤ 0 is none. */
    exits(): Iterable<number>;
}

/** What the graph reads from the map it belongs to. */
export interface AreaGraphSource {
    /** Every area with a name, by id (setAreaName makes one with only a name). */
    areaNames(): ReadonlyMap<number, string>;
    /** Every area that exists as an area, with its rooms. */
    areaRooms(): ReadonlyMap<number, readonly number[]>;
    room(id: number): AreaGraphRoom | undefined;
    rooms(): Iterable<AreaGraphRoom>;
    getUserData(key: string): string | undefined;
    /** Undefined removes the key. */
    setUserData(key: string, value: string | undefined): void;
}

/** QString::toInt: a whole 32-bit number, surrounding spaces allowed. */
function areaIdOf(key: string): number | null {
    if (!/^\s*[+-]?\d+\s*$/.test(key)) return null;
    const n = Number(key);
    return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** QJsonObject writes its keys sorted; JSON.stringify would put integer-like
 *  ones first in numeric order. */
function sortedJsonObject(entries: Array<[string, string]>): string {
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;
}

export class AreaGraph {
    private nodes = new Map<number, AreaGraphNode>();
    private links: AreaGraphLink[] = [];
    private stored = new Map<number, StoredPosition>();
    /** What the user data held when this last read or wrote it, to notice a
     *  load or a script changing it. */
    private storedLayoutText = '';
    private storedDirty = true;
    private storedLayoutRead = false;
    private built = false;

    constructor(private readonly source: AreaGraphSource) {}

    /** TAreaGraph::radiusOf — in double, as the span of int room coordinates can overflow an int. */
    static radiusOf(minX: number, maxX: number, minY: number, maxY: number): number {
        const width = maxX - minX + 1.0;
        const height = maxY - minY + 1.0;
        return Math.max(MIN_RADIUS, 0.5 * Math.hypot(width, height));
    }

    /** The nodes in area id order, each with its position. Call {@link refresh} first. */
    getNodes(): AreaGraphNode[] {
        return [...this.nodes.values()];
    }

    /** Sorted by (fromArea, toArea). */
    getLinks(): AreaGraphLink[] {
        return this.links;
    }

    /**
     * TAreaGraph::refresh. Desktop skips the rebuild when the map's revision
     * has not moved; Mudlet Web keeps no such counter, so the graph is rebuilt
     * every time and laid out again only when, as there, an area came, went or
     * changed size, or the stored layout changed under it.
     */
    refresh(): void {
        const layoutChanged = !this.storedLayoutRead
            || (this.source.getUserData(AREA_GRAPH_LAYOUT_KEY) ?? '') !== this.storedLayoutText;
        if (layoutChanged) this.readStoredLayout();
        const graphChanged = this.rebuildGraph();
        if (!this.built || graphChanged || layoutChanged) this.layoutAreas();
        this.built = true;
        this.writeStoredLayout();
    }

    /** Pins the area there. False if there is no such area or a coordinate
     *  is not finite or beyond the limit. */
    setPosition(areaId: number, position: Point): boolean {
        this.refresh();
        if (!this.nodes.has(areaId)
            || !(Math.abs(position[0]) <= AREA_GRAPH_MAX_COORDINATE)
            || !(Math.abs(position[1]) <= AREA_GRAPH_MAX_COORDINATE)) {
            return false;
        }
        this.stored.set(areaId, { position: [position[0], position[1]], pinned: true });
        this.storedDirty = true;
        // Unpinned areas under the new spot make way now, not on some later unrelated edit.
        this.layoutAreas();
        this.writeStoredLayout();
        return true;
    }

    /** Discards the stored positions (but the pinned ones, if asked) and lays everything out again. */
    resetLayout(keepPinned: boolean): void {
        this.refresh();
        for (const [id, entry] of [...this.stored]) {
            if (!(keepPinned && entry.pinned)) this.stored.delete(id);
        }
        this.storedDirty = true;
        this.layoutAreas();
        this.writeStoredLayout();
    }

    /** Drops a deleted area's stored position, which a later area given the
     *  same id would otherwise take. */
    forgetArea(areaId: number): void {
        this.stored.delete(areaId);
        const text = this.source.getUserData(AREA_GRAPH_LAYOUT_KEY);
        if (!text) return;
        let root: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(text);
            root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
            root = {};
        }
        const rawAreas = root.areas;
        const areas = rawAreas && typeof rawAreas === 'object' && !Array.isArray(rawAreas)
            ? { ...rawAreas as Record<string, unknown> } : {};
        const key = String(areaId);
        if (!Object.prototype.hasOwnProperty.call(areas, key)) return;
        delete areas[key];
        root.areas = areas;
        this.source.setUserData(AREA_GRAPH_LAYOUT_KEY, sortedJsonObject(
            Object.entries(root).map(([k, v]) => [k, k === 'areas'
                ? sortedJsonObject(Object.entries(areas).map(([a, e]) => [a, JSON.stringify(e)]))
                : JSON.stringify(v)])));
    }

    /** True if an area was added or removed or changed size. */
    private rebuildGraph(): boolean {
        const names = this.source.areaNames();
        const areas = this.source.areaRooms();
        const ids = new Set<number>([...names.keys(), ...areas.keys()]);
        const nodes = new Map<number, AreaGraphNode>();
        for (const id of [...ids].sort((a, b) => a - b)) {
            const rooms = areas.get(id);
            // The default area exists in every map; only show it once something is in it.
            if (id === -1 && (!rooms || rooms.length === 0)) continue;
            const node: AreaGraphNode = {
                areaId: id, name: names.get(id) ?? '', roomCount: rooms?.length ?? 0,
                radius: MIN_RADIUS, position: [0, 0], pinned: false,
            };
            if (rooms && rooms.length > 0) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const roomId of rooms) {
                    const room = this.source.room(roomId);
                    if (!room) continue;
                    minX = Math.min(minX, room.x); maxX = Math.max(maxX, room.x);
                    minY = Math.min(minY, room.y); maxY = Math.max(maxY, room.y);
                }
                if (minX !== Infinity) node.radius = AreaGraph.radiusOf(minX, maxX, minY, maxY);
            }
            nodes.set(id, node);
        }
        let changed = nodes.size !== this.nodes.size;
        if (!changed) {
            const before = [...this.nodes.values()];
            let k = 0;
            for (const node of nodes.values()) {
                const old = before[k++];
                if (node.areaId !== old.areaId || node.radius !== old.radius) { changed = true; break; }
            }
        }
        this.nodes = nodes;
        this.rebuildLinks();
        return changed;
    }

    private rebuildLinks(): void {
        const links = new Map<string, AreaGraphLink & { key: [number, number] }>();
        for (const room of this.source.rooms()) {
            const areaId = room.area;
            if (!this.nodes.has(areaId)) continue;
            for (const toId of room.exits()) {
                if (!(toId > 0)) continue;
                const to = this.source.room(toId);
                if (!to) continue;
                const toArea = to.area;
                if (toArea === areaId || !this.nodes.has(toArea)) continue;
                const from = Math.min(areaId, toArea), toA = Math.max(areaId, toArea);
                const key = `${from},${toA}`;
                const link = links.get(key);
                if (link) link.exitCount++;
                else links.set(key, { fromArea: from, toArea: toA, exitCount: 1, key: [from, toA] });
            }
        }
        this.links = [...links.values()]
            .sort((a, b) => a.fromArea - b.fromArea || a.toArea - b.toArea)
            .map(({ fromArea, toArea, exitCount }) => ({ fromArea, toArea, exitCount }));
    }

    private readStoredLayout(): void {
        this.stored.clear();
        this.storedLayoutText = this.source.getUserData(AREA_GRAPH_LAYOUT_KEY) ?? '';
        this.storedLayoutRead = true;
        this.storedDirty = false;
        if (this.storedLayoutText === '') return;
        let areas: Record<string, unknown> = {};
        try {
            const root: unknown = JSON.parse(this.storedLayoutText);
            const raw = root && typeof root === 'object' && !Array.isArray(root)
                ? (root as Record<string, unknown>).areas : undefined;
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) areas = raw as Record<string, unknown>;
        } catch { /* QJsonDocument::fromJson of bad text is an empty document */ }
        for (const [key, value] of Object.entries(areas)) {
            const areaId = areaIdOf(key);
            const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
            const x = typeof entry.x === 'number' ? entry.x : NaN;
            const y = typeof entry.y === 'number' ? entry.y : NaN;
            if (areaId === null || !(Math.abs(x) <= AREA_GRAPH_MAX_COORDINATE) || !(Math.abs(y) <= AREA_GRAPH_MAX_COORDINATE)) continue;
            this.stored.set(areaId, { position: [x, y], pinned: entry.pinned === true });
        }
    }

    private writeStoredLayout(): void {
        // Only deleted areas are dropped, so a recycled id is laid out afresh;
        // an area that is only empty for now, the default one included, keeps
        // its place and pin for when rooms come back.
        const names = this.source.areaNames();
        const areas = this.source.areaRooms();
        for (const id of [...this.stored.keys()]) {
            if (!names.has(id) && !areas.has(id)) {
                this.stored.delete(id);
                this.storedDirty = true;
            }
        }
        for (const node of this.nodes.values()) {
            const stored = this.stored.get(node.areaId);
            node.position = stored ? [stored.position[0], stored.position[1]] : [0, 0];
            node.pinned = stored?.pinned ?? false;
        }
        if (!this.storedDirty) return;
        this.storedDirty = false;
        if (this.stored.size === 0) {
            this.source.setUserData(AREA_GRAPH_LAYOUT_KEY, undefined);
            this.storedLayoutText = '';
            return;
        }
        const entries: Array<[string, string]> = [];
        for (const [id, entry] of this.stored) {
            const fields: Array<[string, string]> = [['x', JSON.stringify(entry.position[0])], ['y', JSON.stringify(entry.position[1])]];
            if (entry.pinned) fields.push(['pinned', 'true']);
            entries.push([String(id), sortedJsonObject(fields)]);
        }
        this.storedLayoutText = sortedJsonObject([['version', '1'], ['areas', sortedJsonObject(entries)]]);
        this.source.setUserData(AREA_GRAPH_LAYOUT_KEY, this.storedLayoutText);
    }

    private radiusOfArea(areaId: number): number {
        return this.nodes.get(areaId)?.radius ?? MIN_RADIUS;
    }

    private nodeIds(): number[] {
        return [...this.nodes.keys()];
    }

    /** Places areas with no position, then pushes apart any that overlap. */
    private layoutAreas(): void {
        const fixed = new Set(this.stored.keys());
        const anyUnplaced = this.nodeIds().some(id => !this.stored.has(id));
        if (anyUnplaced) this.placeNewAreas(fixed);

        // Areas grown from placed ones, packed rows, and areas that grew since
        // they were placed can all overlap others. New areas make way first,
        // then areas placed earlier; pinned ones never move.
        const mobility = new Map<number, number>();
        for (const [id, entry] of this.stored) {
            if (entry.pinned) mobility.set(id, MOBILITY_PINNED);
            else if (fixed.has(id)) mobility.set(id, MOBILITY_SETTLED);
        }
        if (this.removeOverlaps(this.nodeIds(), mobility) || anyUnplaced) this.storedDirty = true;
    }

    private placeNewAreas(fixed: ReadonlySet<number>): void {
        const adjacency = new Map<number, number[]>();
        const adjacent = (id: number) => adjacency.get(id) ?? [];
        for (const link of this.links) {
            if (!adjacency.has(link.fromArea)) adjacency.set(link.fromArea, []);
            if (!adjacency.has(link.toArea)) adjacency.set(link.toArea, []);
            adjacency.get(link.fromArea)!.push(link.toArea);
            adjacency.get(link.toArea)!.push(link.fromArea);
        }

        // Connected components in ascending order of their lowest area id, each in BFS order.
        const components: number[][] = [];
        const visited = new Set<number>();
        for (const start of this.nodeIds()) {
            if (visited.has(start)) continue;
            const component = [start];
            visited.add(start);
            for (let i = 0; i < component.length; ++i) {
                const neighbours = [...adjacent(component[i])].sort((a, b) => a - b);
                for (const neighbour of neighbours) {
                    if (!visited.has(neighbour)) {
                        visited.add(neighbour);
                        component.push(neighbour);
                    }
                }
            }
            components.push(component);
        }

        const freshComponents: number[][] = [];
        for (const component of components) {
            const hasFixed = component.some(id => fixed.has(id));
            const hasUnplaced = component.some(id => !this.stored.has(id));
            if (!hasUnplaced) continue;
            if (hasFixed) {
                // Grow outward from what is already placed, so the existing world does not move.
                let pending = component.filter(id => !this.stored.has(id));
                while (pending.length > 0) {
                    const deferred: number[] = [];
                    for (const id of pending) {
                        let sumX = 0, sumY = 0, placedNeighbours = 0, neighbourRadius = 0;
                        for (const neighbour of adjacent(id)) {
                            const at = this.stored.get(neighbour);
                            if (at) {
                                sumX += at.position[0];
                                sumY += at.position[1];
                                neighbourRadius = Math.max(neighbourRadius, this.radiusOfArea(neighbour));
                                ++placedNeighbours;
                            }
                        }
                        if (!placedNeighbours) {
                            deferred.push(id);
                            continue;
                        }
                        const [dx, dy] = hashedDirection(id);
                        const reach = this.radiusOfArea(id) + neighbourRadius + GAP;
                        this.stored.set(id, {
                            position: [sumX / placedNeighbours + dx * reach, sumY / placedNeighbours + dy * reach],
                            pinned: false,
                        });
                    }
                    // A component is connected, so each round places at least one area.
                    pending = deferred;
                }
                this.simulate(component, fixed, adjacent);
            } else {
                let spread = 0;
                for (const id of component) spread += (2.0 * this.radiusOfArea(id) + GAP) ** 2;
                spread = Math.sqrt(spread);
                for (const id of component) {
                    const distance = Math.sqrt(unitHash(id, 1)) * spread * 0.5;
                    const [dx, dy] = hashedDirection(id);
                    this.stored.set(id, { position: [dx * distance, dy * distance], pinned: false });
                }
                this.simulate(component, fixed, adjacent);
                freshComponents.push(component);
            }
        }
        if (freshComponents.length > 0) this.packComponents(freshComponents);
    }

    /** Shelf-packs components laid out on their own into rows below what is already placed. */
    private packComponents(freshComponents: number[][]): void {
        const fresh = new Set<number>(freshComponents.flat());
        let anyPlaced = false;
        const placedBounds = new Bounds();
        for (const id of this.nodeIds()) {
            const at = this.stored.get(id);
            if (!fresh.has(id) && at) {
                anyPlaced = true;
                placedBounds.add(at.position, this.radiusOfArea(id));
            }
        }

        // Shelf-pack the new components in rows, below whatever was already placed.
        // Array.prototype.sort is stable, as std::stable_sort is.
        const ordered = [...freshComponents].sort((a, b) => b.length - a.length);
        const bounds: Bounds[] = [];
        let totalArea = 0, totalHeight = 0, widest = 0;
        for (const component of ordered) {
            const b = new Bounds();
            for (const id of component) b.add(this.stored.get(id)!.position, this.radiusOfArea(id));
            bounds.push(b);
            totalArea += (b.width() + GAP) * (b.height() + GAP);
            totalHeight += b.height() + GAP;
            widest = Math.max(widest, b.width());
        }
        const rowLimit = Math.max(widest, Math.sqrt(totalArea) * 1.5, anyPlaced ? placedBounds.width() : 0.0);
        // Rows that would run past the coordinate limit go the other way
        // instead: clamped, they would pile up in a corner.
        const leftward = anyPlaced && placedBounds.minX + rowLimit > AREA_GRAPH_MAX_COORDINATE;
        const upward = anyPlaced && placedBounds.minY - 2.0 * GAP - totalHeight < -AREA_GRAPH_MAX_COORDINATE;
        const stepX = leftward ? -1.0 : 1.0;
        const stepY = upward ? 1.0 : -1.0;
        const startX = anyPlaced ? (leftward ? placedBounds.maxX : placedBounds.minX) : 0.0;
        let cursorX = startX;
        let cursorY = anyPlaced ? (upward ? placedBounds.maxY : placedBounds.minY) + stepY * 2.0 * GAP : 0.0;
        let rowHeight = 0.0;
        for (let i = 0; i < ordered.length; ++i) {
            const b = bounds[i];
            if (cursorX !== startX && Math.abs(cursorX - startX) + b.width() > rowLimit) {
                cursorX = startX;
                cursorY += stepY * (rowHeight + GAP);
                rowHeight = 0.0;
            }
            const shiftX = cursorX - (leftward ? b.maxX : b.minX);
            const shiftY = cursorY - (upward ? b.minY : b.maxY);
            for (const id of ordered[i]) {
                const at = this.stored.get(id)!;
                at.position = [at.position[0] + shiftX, at.position[1] + shiftY];
            }
            cursorX += stepX * (b.width() + GAP);
            rowHeight = Math.max(rowHeight, b.height());
        }
    }

    /**
     * Fruchterman-Reingold in its grid form — areas repel only within twice
     * their ideal distance, which keeps a step near linear in the number of
     * areas — with each pair's ideal distance set by the two areas' sizes.
     * Only areas not in `fixed` move.
     */
    private simulate(component: number[], fixed: ReadonlySet<number>, adjacent: (id: number) => number[]): void {
        const count = component.length;
        const x: number[] = [], y: number[] = [], radius: number[] = [], movable: boolean[] = [];
        const indexOf = new Map<number, number>();
        let anyMovable = false;
        for (let i = 0; i < count; ++i) {
            const id = component[i];
            indexOf.set(id, i);
            const position = this.stored.get(id)?.position ?? [0, 0];
            x[i] = position[0];
            y[i] = position[1];
            radius[i] = this.radiusOfArea(id);
            movable[i] = !fixed.has(id);
            anyMovable = anyMovable || movable[i];
        }
        if (!anyMovable || count < 2) return;

        const edges: Array<[number, number]> = [];
        for (let i = 0; i < count; ++i) {
            for (const neighbour of adjacent(component[i])) {
                const j = indexOf.get(neighbour) ?? -1;
                if (j > i) edges.push([i, j]);
            }
        }

        let spread = 0;
        for (const r of radius) spread += (2.0 * r + GAP) ** 2;
        const startTemperature = Math.max(GAP, Math.sqrt(spread) * 0.25);
        // Far enough to find every pair closer than twice its ideal distance, or overlapping.
        const reach = radius.map(r => 2.0 * r + GAP);

        const moveX = new Array<number>(count).fill(0);
        const moveY = new Array<number>(count).fill(0);
        for (let iteration = 0; iteration < ITERATIONS; ++iteration) {
            moveX.fill(0);
            moveY.fill(0);
            for (const [i, j] of collectNearbyPairs(x, y, reach)) {
                let dx = x[j] - x[i];
                let dy = y[j] - y[i];
                let distance = Math.hypot(dx, dy);
                if (distance < 1e-3) {
                    const [hx, hy] = hashedDirection(component[i], component[j]);
                    dx = hx * 1e-3;
                    dy = hy * 1e-3;
                    distance = 1e-3;
                }
                const ideal = radius[i] + radius[j] + GAP;
                if (distance >= 2.0 * ideal) continue;
                const force = ideal * ideal / (distance * distance);
                moveX[i] -= dx * force;
                moveY[i] -= dy * force;
                moveX[j] += dx * force;
                moveY[j] += dy * force;
            }
            for (const [i, j] of edges) {
                const dx = x[j] - x[i];
                const dy = y[j] - y[i];
                const distance = Math.hypot(dx, dy);
                const force = distance / (radius[i] + radius[j] + GAP);
                moveX[i] += dx * force;
                moveY[i] += dy * force;
                moveX[j] -= dx * force;
                moveY[j] -= dy * force;
            }
            const temperature = startTemperature * (1.0 - iteration / ITERATIONS) + 0.1;
            for (let i = 0; i < count; ++i) {
                const magnitude = Math.hypot(moveX[i], moveY[i]);
                if (movable[i] && magnitude > 0.0) {
                    const step = Math.min(magnitude, temperature) / magnitude;
                    x[i] += moveX[i] * step;
                    y[i] += moveY[i] * step;
                }
            }
        }

        for (let i = 0; i < count; ++i) {
            if (movable[i]) {
                const at = this.stored.get(component[i]);
                if (at) at.position = [x[i], y[i]];
                else this.stored.set(component[i], { position: [x[i], y[i]], pinned: false });
            }
        }
        const mobility = new Map<number, number>();
        for (const id of component) {
            if (fixed.has(id)) mobility.set(id, MOBILITY_PINNED);
        }
        this.removeOverlaps(component, mobility);
    }

    /**
     * Pushes apart overlapping areas. Of a pair, the one with the higher
     * mobility moves, both move if equal, and neither if both are pinned; an
     * area missing from `mobilityOf` is new.
     */
    private removeOverlaps(ids: number[], mobilityOf: ReadonlyMap<number, number>): boolean {
        const count = ids.length;
        const x: number[] = [], y: number[] = [], radius: number[] = [], mobility: number[] = [];
        for (let i = 0; i < count; ++i) {
            const position = this.stored.get(ids[i])?.position ?? [0, 0];
            x[i] = position[0];
            y[i] = position[1];
            radius[i] = this.radiusOfArea(ids[i]);
            mobility[i] = mobilityOf.get(ids[i]) ?? MOBILITY_NEW;
        }
        const max = AREA_GRAPH_MAX_COORDINATE;
        // Growing from, packing beside, or making way for an area pinned near
        // the limit can pass it; kept within it here, the overlap passes then
        // slide areas along the limit instead of stacking them.
        const keepInBounds = (i: number) => {
            if (mobility[i] === MOBILITY_PINNED) return;
            x[i] = clamp(x[i], -max, max);
            y[i] = clamp(y[i], -max, max);
        };
        for (let i = 0; i < count; ++i) keepInBounds(i);
        const reach = radius.map(r => 2.0 * r + GAP);

        for (let pass = 0; pass < OVERLAP_PASSES; ++pass) {
            let moved = false;
            for (const [i, j] of collectNearbyPairs(x, y, reach)) {
                if (mobility[i] === MOBILITY_PINNED && mobility[j] === MOBILITY_PINNED) continue;
                let dx = x[j] - x[i];
                let dy = y[j] - y[i];
                const distance = Math.hypot(dx, dy);
                const wanted = radius[i] + radius[j] + GAP * 0.5;
                if (distance >= wanted) continue;
                if (distance < 1e-3) {
                    [dx, dy] = hashedDirection(ids[i], ids[j]);
                } else {
                    dx /= distance;
                    dy /= distance;
                }
                const overlap = wanted - distance;
                const shareI = mobility[i] > mobility[j] ? 1.0 : (mobility[i] < mobility[j] ? 0.0 : 0.5);
                const shareJ = 1.0 - shareI;
                // A push out past the limit would be clamped straight back,
                // leaving the pair stacked in a corner, so the area that moves
                // is sent back inside instead.
                const mover = shareJ > 0.0 ? j : i;
                const outward = mover === j ? 1.0 : -1.0;
                if ((x[mover] >= max && dx * outward > 0.0) || (x[mover] <= -max && dx * outward < 0.0)) dx = -dx;
                if ((y[mover] >= max && dy * outward > 0.0) || (y[mover] <= -max && dy * outward < 0.0)) dy = -dy;
                x[i] -= dx * overlap * shareI;
                y[i] -= dy * overlap * shareI;
                x[j] += dx * overlap * shareJ;
                y[j] += dy * overlap * shareJ;
                keepInBounds(i);
                keepInBounds(j);
                moved = true;
            }
            if (!moved) break;
        }

        // Compared rather than tracked: a push that a pin or the limit undoes is no move.
        let anyMoved = false;
        for (let i = 0; i < count; ++i) {
            if (mobility[i] === MOBILITY_PINNED) continue;
            const at = this.stored.get(ids[i]);
            if (!at) {
                this.stored.set(ids[i], { position: [x[i], y[i]], pinned: false });
                anyMoved = true;
            } else if (at.position[0] !== x[i] || at.position[1] !== y[i]) {
                at.position = [x[i], y[i]];
                anyMoved = true;
            }
        }
        return anyMoved;
    }
}
