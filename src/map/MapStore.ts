import type {MudletArea, MudletColor, MudletFont, MudletLabel, MudletMap, MudletMapHeader, MudletRoom} from 'mudlet-map-binary-reader';
import {readerExport} from 'mudlet-map-binary-reader';
import {findPath, type ExitWeightFilter, type PathfindResult} from './pathfinding';

export type {ExitWeightFilter, PathfindResult} from './pathfinding';

export type MapRendererData = ReturnType<typeof readerExport>;

// Mudlet direction number → field name on MudletRoom
const DIR_FIELD: Record<number, string> = {
    1: 'north', 2: 'northeast', 3: 'northwest', 4: 'east', 5: 'west',
    6: 'south', 7: 'southeast', 8: 'southwest', 9: 'up', 10: 'down',
    11: 'in', 12: 'out',
};

// Mudlet direction number → short name used to key per-exit weights. The binary
// reader stores stock-exit weights under these short names (see pathfinding.ts
// and mudlet-map-binary-reader's json-export), while special-exit weights are
// keyed by the verbatim command string.
const DIR_SHORT: Record<number, string> = {
    1: 'n', 2: 'ne', 3: 'nw', 4: 'e', 5: 'w',
    6: 's', 7: 'se', 8: 'sw', 9: 'up', 10: 'down',
    11: 'in', 12: 'out',
};

// Mudlet exit/door APIs accept either an integer 1-12 or a long/short
// direction name. Normalize either form to the canonical 1-12 index, or
// undefined when the value isn't a recognized direction.
const DIR_NAME_TO_INT: Record<string, number> = {
    n: 1, north: 1,
    ne: 2, northeast: 2,
    nw: 3, northwest: 3,
    e: 4, east: 4,
    w: 5, west: 5,
    s: 6, south: 6,
    se: 7, southeast: 7,
    sw: 8, southwest: 8,
    u: 9, up: 9,
    d: 10, down: 10,
    i: 11, in: 11,
    o: 12, out: 12,
};

// Complementary direction for each stock direction (Mudlet's scmReverseDirections):
// n↔s, ne↔sw, nw↔se, e↔w, up↔down, in↔out. Used when connecting exit stubs so
// the reverse stub on the target room is hooked up too.
const REVERSE_DIR: Record<number, number> = {
    1: 6, 2: 8, 3: 7, 4: 5, 5: 4, 6: 1, 7: 3, 8: 2, 9: 10, 10: 9, 11: 12, 12: 11,
};

// Unit displacement vector per stock direction (Mudlet's scmUnitVectors). in/out
// (11/12) are intentionally absent — they have no spatial component, so the
// direction-only connectExitStub form can't resolve them, matching Mudlet.
const UNIT_VECTORS: Record<number, [number, number, number]> = {
    1: [0, -1, 0], 2: [1, -1, 0], 3: [-1, -1, 0], 4: [1, 0, 0], 5: [-1, 0, 0],
    6: [0, 1, 0], 7: [1, 1, 0], 8: [-1, 1, 0], 9: [0, 0, 1], 10: [0, 0, -1],
};

/** True when both values share a sign (Mudlet's compSign). Only meaningful for
 *  non-zero inputs — callers gate the zero case separately. */
function sameSign(a: number, b: number): boolean {
    return (a < 0) === (b < 0);
}

export function parseDirection(dir: unknown): number | undefined {
    if (typeof dir === 'number') {
        return DIR_FIELD[dir] ? dir : undefined;
    }
    if (typeof dir === 'string') {
        return DIR_NAME_TO_INT[dir.toLowerCase()];
    }
    return undefined;
}

// Qt pen-style enum → Mudlet's getCustomLines style strings. Matches the
// mapping used by mudlet-map-binary-reader's reader-export (Qt::SolidLine=1
// through Qt::DashDotDotLine=5).
const PEN_STYLE_NAMES: Record<number, string> = {
    1: 'solid line',
    2: 'dash line',
    3: 'dot line',
    4: 'dash dot line',
    5: 'dash dot dot line',
};

// Round-trip key Mudlet uses to persist the hidden-room flag in pre-v21
// binary maps (TRoom.cpp:894-899). On load we lift it into the hiddenRooms
// side-table and drop the key; on save we write it back for rooms in the
// set so the file stays interoperable with Mudlet v20 readers.
const HIDDEN_FALLBACK_KEY = 'system.fallback_hidden';

// Per-area 2D-map zoom. Persisted inside the area's userData so the view zoom
// round-trips with the map file (mirroring Mudlet, where zoom is map data, not
// client config). It's an ordinary userData key — scripts can read it like any
// other area user-data entry; getAreaZoom/setAreaZoom are just typed accessors.
//
// This is Mudlet's OWN key for the same datum: TArea::mLast2DMapZoom only gets
// a field of its own in map format v21, so a v20 save carries it in area
// userData under `system.fallback_map2DZoom` (TMap::serialize) and a v17-v20
// load reads it straight back out (TMap::restore). We write v20, so using the
// same key means an area's zoom survives a round trip through real Mudlet
// instead of being a mudix-private annotation.
//
// The value is in MUDLET UNITS — how many map units the shorter viewport edge
// spans (larger = more map on screen = zoomed out) — never the renderer's
// pixels-per-unit multiplier. Anything crossing into the renderer converts at
// that boundary (see MapPanel's toRendererZoom).
const AREA_ZOOM_KEY = 'system.fallback_map2DZoom';

export const DEFAULT_FONT: MudletFont = {
    family: 'Bitstream Vera Sans Mono', style: 'Normal',
    pointSize: 8, pixelSize: -1, styleHint: 5, styleStrategy: 1,
    weight: 50, fontBits: 0, stretch: 100, extendedFontBits: 0,
    letterSpacing: 0, wordSpacing: 0, hintingPreference: 0, capital: 0,
    styleSetting: false, underline: false, overline: false, strikeOut: false,
    fixedPitch: false, kerning: true, styleOblique: false,
    ignorePitch: false, letterSpacingIsAbsolute: false,
};

export function makeRoom(areaId: number): MudletRoom {
    return {
        area: areaId, x: 0, y: 0, z: 0,
        north: -1, northeast: -1, northwest: -1, east: -1, west: -1,
        south: -1, southeast: -1, southwest: -1, up: -1, down: -1,
        in: -1, out: -1,
        environment: 0, weight: 1, name: '', isLocked: false,
        mSpecialExits: {}, mSpecialExitLocks: [],
        symbol: '', userData: {},
        customLines: {}, customLinesArrow: {}, customLinesColor: {}, customLinesStyle: {},
        exitLocks: [], stubs: [], exitWeights: {}, doors: {},
    };
}

/** Exit/stub direction name → Mudlet direction number (inverse of DIR_FIELD). */
const DIR_NUM_BY_NAME: Record<string, number> = Object.fromEntries(
    Object.entries(DIR_FIELD).map(([num, field]) => [field, Number(num)]),
);

/** Mudlet JSON door state → the numeric encoding setDoor stores. */
const DOOR_VALUE: Record<string, number> = { open: 1, closed: 2, locked: 3 };

/** Mudlet JSON pen-style name → Qt pen enum (inverse of PEN_STYLE_NAMES). */
const PEN_STYLE_NUM: Record<string, number> = Object.fromEntries(
    Object.entries(PEN_STYLE_NAMES).map(([num, name]) => [name, Number(num)]),
);

/** Qt QColor from Mudlet JSON's `color24RGB` triple. */
function colorFromRgb24(rgb: unknown, alpha = 255): MudletColor {
    const t = Array.isArray(rgb) ? rgb : [];
    return {
        spec: 1, alpha,
        r: Number(t[0]) || 0, g: Number(t[1]) || 0, b: Number(t[2]) || 0,
    };
}

/**
 * Convert Mudlet's own `saveJsonMap` export into the binary-reader model.
 *
 * This is a genuinely different shape from {@link toJsonString}'s output (which
 * mirrors the binary model): areas are an *array* carrying their rooms nested
 * inside, there is no top-level `rooms` map, exits are `{exitId, name}` records
 * rather than direction fields, and a room's symbol is an OBJECT
 * (`{color24RGB, text}`) rather than a string. Not handling it meant
 * `loadJsonMap` rejected every map Mudlet actually writes, so packages fell
 * back to rebuilding the map through the Lua API — and passing that symbol
 * object straight to setRoomChar is what rendered rooms as "[LuaTable …]".
 *
 * Returns null when the payload isn't this format, so the caller can fall
 * through to the binary-model path.
 *
 * Room `border` is the one documented field still unmapped — no map available
 * to verify it against, and it needs the same post-load side-table treatment as
 * symbol colours. Everything else in TRoom.cpp's writeJsonRoom is covered.
 * Symbol colours are applied separately by applyJsonSymbolColors.
 */
export function mudletJsonMapToMudletMap(src: unknown): MudletMap | null {
    if (!src || typeof src !== 'object') return null;
    const doc = src as Record<string, unknown>;
    if (!Array.isArray(doc.areas)) return null;

    const areas: Record<number, MudletArea> = {};
    const areaNames: Record<number, string> = {};
    const rooms: Record<number, MudletRoom> = {};
    const hashes: Record<string, number> = {};

    for (const rawArea of doc.areas as Record<string, unknown>[]) {
        if (!rawArea || typeof rawArea !== 'object') continue;
        const areaId = Number(rawArea.id);
        if (!Number.isFinite(areaId)) continue;

        const area = makeArea();
        area.userData = (rawArea.userData as Record<string, string>) ?? {};
        areas[areaId] = area;
        areaNames[areaId] = typeof rawArea.name === 'string' ? rawArea.name : '';

        const zLevels = new Set<number>();
        for (const rawRoom of (Array.isArray(rawArea.rooms) ? rawArea.rooms : []) as Record<string, unknown>[]) {
            if (!rawRoom || typeof rawRoom !== 'object') continue;
            const roomId = Number(rawRoom.id);
            if (!Number.isFinite(roomId)) continue;

            const room = makeRoom(areaId);
            room.name = typeof rawRoom.name === 'string' ? rawRoom.name : '';
            const coords = Array.isArray(rawRoom.coordinates) ? rawRoom.coordinates : [];
            room.x = Number(coords[0]) || 0;
            room.y = Number(coords[1]) || 0;
            room.z = Number(coords[2]) || 0;
            room.environment = Number(rawRoom.environment) || 0;
            room.weight = Number(rawRoom.weight) || 1;
            room.isLocked = !!rawRoom.locked;
            room.userData = (rawRoom.userData as Record<string, string>) ?? {};

            // The symbol object is the whole reason this converter exists —
            // take its text, and keep the colour via the store's side-table.
            const sym = rawRoom.symbol;
            if (typeof sym === 'string') room.symbol = sym;
            else if (sym && typeof sym === 'object') {
                const text = (sym as Record<string, unknown>).text;
                room.symbol = typeof text === 'string' ? text : '';
            }

            for (const rawExit of (Array.isArray(rawRoom.exits) ? rawRoom.exits : []) as Record<string, unknown>[]) {
                const name = String(rawExit?.name ?? '');
                const dest = Number(rawExit?.exitId);
                if (!name || !Number.isFinite(dest)) continue;
                const dirNum = DIR_NUM_BY_NAME[name];
                const isStock = dirNum !== undefined;
                if (isStock) {
                    (room as unknown as Record<string, number>)[name] = dest;
                } else {
                    // Anything not one of the twelve stock directions is a
                    // special exit keyed by its verbatim command string.
                    room.mSpecialExits[name] = dest;
                }

                // Doors key off the SHORT name for stock exits and off the
                // verbatim command for special ones — the exact keys Mudlet's
                // TRoom::auditExits writes ("n"/"ne"/…/"up"/"down"/"in"/"out")
                // and the only ones setDoor/getDoors accept.
                const door = DOOR_VALUE[String(rawExit.door ?? '')];
                if (door) room.doors[isStock ? DIR_SHORT[dirNum] : name] = door;

                // Weights key off the SHORT name for stock exits, and off the
                // verbatim command for special ones (setExitWeight's convention).
                const weight = Number(rawExit.weight);
                if (Number.isFinite(weight) && weight > 0) {
                    room.exitWeights[isStock ? DIR_SHORT[dirNum] : name] = weight;
                }

                // Stock locks are direction numbers; special-exit locks are
                // recorded by destination id (see getSpecialExits).
                if (rawExit.locked) {
                    if (isStock) room.exitLocks.push(dirNum);
                    else room.mSpecialExitLocks.push(dest);
                }

                applyCustomLine(room, name, rawExit.customLine);
            }

            for (const rawStub of (Array.isArray(rawRoom.stubExits) ? rawRoom.stubExits : []) as unknown[]) {
                const name = typeof rawStub === 'string'
                    ? rawStub
                    : String((rawStub as Record<string, unknown>)?.name ?? '');
                const dir = DIR_NUM_BY_NAME[name];
                if (!dir) continue;
                room.stubs.push(dir);
                // A stub can carry a door/lock too, on the same keys as a real
                // exit — it just has no destination.
                const stub = typeof rawStub === 'object' ? rawStub as Record<string, unknown> : {};
                const door = DOOR_VALUE[String(stub.door ?? '')];
                if (door) room.doors[DIR_SHORT[dir]] = door;
                if (stub.locked) room.exitLocks.push(dir);
            }

            // Mudlet smuggles the hidden flag through userData on v20 maps;
            // ingestBinaryRoom lifts this key into the hiddenRooms side-table.
            if (rawRoom.hidden) room.userData[HIDDEN_FALLBACK_KEY] = 'true';

            if (typeof rawRoom.hash === 'string' && rawRoom.hash) hashes[rawRoom.hash] = roomId;

            rooms[roomId] = room;
            area.rooms.push(roomId);
            zLevels.add(room.z);
        }
        area.zLevels = [...zLevels].sort((a, b) => a - b);
    }

    const mCustomEnvColors: Record<number, MudletColor> = {};
    for (const entry of (Array.isArray(doc.customEnvColors) ? doc.customEnvColors : []) as Record<string, unknown>[]) {
        const id = Number(entry?.id);
        if (Number.isFinite(id)) mCustomEnvColors[id] = colorFromRgb24(entry.color24RGB);
    }

    // `playersRoomId` is Mudlet's per-profile saved room map (mRoomIdHash).
    const mRoomIdHash: Record<string, number> = {};
    const players = doc.playersRoomId;
    if (players && typeof players === 'object' && !Array.isArray(players)) {
        for (const [profile, id] of Object.entries(players as Record<string, unknown>)) {
            const n = Number(id);
            if (Number.isFinite(n)) mRoomIdHash[profile] = n;
        }
    }

    return {
        version: 20,
        envColors: {}, areaNames, mCustomEnvColors,
        mpRoomDbHashToRoomId: hashes,
        mUserData: {},
        mapSymbolFont: DEFAULT_FONT,
        mapFontFudgeFactor: Number(doc.mapSymbolFontFudgeFactor) || 1,
        useOnlyMapFont: !!doc.onlyMapSymbolFontToBeUsed,
        areas, mRoomIdHash, labels: {}, rooms,
    };
}

/**
 * Attach one exit's `customLine` to the room's four parallel line records.
 * Keyed like setCustomLine: canonical long name for a stock direction, the
 * verbatim command for a special exit — which is exactly the JSON's `name`.
 */
function applyCustomLine(room: MudletRoom, key: string, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const line = raw as Record<string, unknown>;
    const coords = Array.isArray(line.coordinates) ? line.coordinates : [];
    const points = coords
        .filter((p): p is unknown[] => Array.isArray(p))
        .map(p => [Number(p[0]) || 0, Number(p[1]) || 0] as [number, number]);
    if (points.length === 0) return;
    room.customLines[key] = points;
    room.customLinesColor[key] = colorFromRgb24(line.color24RGB);
    room.customLinesArrow[key] = !!line.endsInArrow;
    // Mudlet omits `style` for the default solid line.
    room.customLinesStyle[key] = PEN_STYLE_NUM[String(line.style ?? 'solid line')] ?? 1;
}

/**
 * Apply `symbol.color24RGB` from a Mudlet JSON map onto the store's per-room
 * char-colour side table. Separate from the conversion above because
 * MudletRoom carries no charColor field, so this can only run once
 * loadFromBinary has created the rooms.
 */
function applyJsonSymbolColors(src: unknown, store: MapStore): void {
    const doc = src as Record<string, unknown> | null;
    if (!doc || !Array.isArray(doc.areas)) return;
    for (const area of doc.areas as Record<string, unknown>[]) {
        for (const room of (Array.isArray(area?.rooms) ? area.rooms : []) as Record<string, unknown>[]) {
            const sym = room?.symbol;
            if (!sym || typeof sym !== 'object') continue;
            const rgb = (sym as Record<string, unknown>).color24RGB;
            if (!Array.isArray(rgb)) continue;
            const id = Number(room.id);
            if (!Number.isFinite(id)) continue;
            store.setRoomCharColor(id, Number(rgb[0]) || 0, Number(rgb[1]) || 0, Number(rgb[2]) || 0);
        }
    }
}

export function makeArea(): MudletArea {
    return {
        rooms: [], zLevels: [], mAreaExits: {}, gridMode: false,
        max_x: 0, max_y: 0, max_z: 0, min_x: 0, min_y: 0, min_z: 0,
        span: [0, 0, 0], xmaxForZ: {}, ymaxForZ: {}, xminForZ: {}, yminForZ: {},
        pos: [0, 0, 0], isZone: false, zoneAreaRef: 0, userData: {},
    };
}

export interface MapLabelInfo {
    X: number; Y: number; Z: number;
    Width: number; Height: number;
    Text: string;
    Pixmap: string;
    OnTop: boolean;
    Scaling: boolean;
    Temporary: boolean;
    FgColor: { r: number; g: number; b: number };
    BgColor: { r: number; g: number; b: number };
}

export type MapLabelLookup =
    | { ok: false; err: 'noarea' | 'noid' }
    | { ok: true; single: MapLabelInfo }
    | { ok: true; multi: Record<number, MapLabelInfo> };

function labelToInfo(l: MudletLabel): MapLabelInfo {
    let pixmap = '';
    const pm = l.pixMap as unknown;
    if (typeof pm === 'string') pixmap = pm;
    else if (pm && typeof Buffer !== 'undefined') {
        try { pixmap = Buffer.from(pm as Uint8Array).toString('base64'); }
        catch { pixmap = ''; }
    }
    return {
        X: l.pos[0], Y: l.pos[1], Z: Math.round(l.pos[2]),
        Width: l.size[0], Height: l.size[1],
        Text: l.text,
        Pixmap: pixmap,
        OnTop: l.showOnTop,
        Scaling: !l.noScaling,
        Temporary: false,  // Mudlet runtime flag; binary maps never carry it
        FgColor: { r: l.fgColor.r, g: l.fgColor.g, b: l.fgColor.b },
        BgColor: { r: l.bgColor.r, g: l.bgColor.g, b: l.bgColor.b },
    };
}

/** Mudlet room highlight: two-color radial gradient with per-color alpha and
 *  a radius factor. Rendered by MudletHighlightOverlay. Despite the suffix
 *  naming, Mudlet's gradient puts color2 at the *centre* and color1 at the
 *  *outer* ring (T2DMap::drawRoom: setColorAt(0, color2), setColorAt(0.85,
 *  color1)). */
export interface RoomHighlight {
    r1: number; g1: number; b1: number;
    r2: number; g2: number; b2: number;
    a1: number; a2: number;
    radius: number;
}

/** Mudlet registerMapInfo callback result. Returned by the LuaRuntime
 *  evaluator after invoking a registered contributor; `null` when the
 *  callback returned an empty string / nothing, or when the evaluator
 *  itself failed (the Lua error is reported via showHandlerError, not here). */
export interface MapInfoResult {
    label: string;
    text: string;
    isBold: boolean;
    isItalic: boolean;
    color?: { r: number; g: number; b: number };
}

/** A registered Mudlet `registerMapInfo` contributor.
 *
 *  Two kinds exist. Script-registered ones carry a `callbackId` that indexes
 *  into the Lua-side `__mudix_cb` registry; the LuaRuntime evaluator dispatches
 *  to it, and they start disabled (Mudlet semantics — caller must
 *  `enableMapInfo(label)` to show it). Built-in ones (`builtin: true`,
 *  `callbackId: null`) mirror Mudlet's native "Short"/"Full" contributors —
 *  they're evaluated directly from MapStore data (see `builtinMapInfo`), don't
 *  depend on a live Lua runtime, and can't be removed via `killMapInfo`. */
export interface MapInfoContributor {
    label: string;
    callbackId: number | null;
    enabled: boolean;
    builtin?: boolean;
}

/** Native evaluator for a built-in contributor — same argument shape as the
 *  Lua-backed `mapInfoEvaluator`, but reads MapStore data directly instead of
 *  calling into Lua. */
type NativeMapInfoFn = (
    roomId: number | null,
    selectionSize: number,
    areaId: number,
    displayedAreaId: number,
) => Omit<MapInfoResult, 'label'> | null;

export interface MapEventEntry {
    /** Stable id used by removeMapEvent and as a parent reference. */
    uniqueName: string;
    /** Event name passed to raiseEvent on click. */
    eventName: string;
    /** uniqueName of a parent entry that this is nested under, or null for top-level. */
    parent: string | null;
    /** Label rendered in the context menu. Defaults to uniqueName when unspecified. */
    displayName: string;
    /** Extra arguments captured by addMapEvent. Mudlet's "selection" branch
     *  (the one mudix mirrors, since the right-clicked room is treated as the
     *  selection) discards these — kept for parity with the registration API. */
    args: unknown[];
}

export interface MapMenuEntry {
    /** Stable id used by removeMapMenu and as a parent reference from
     *  addMapEvent/addMapMenu entries. */
    name: string;
    /** name of a parent menu this is nested under, or null for top-level. */
    parent: string | null;
    /** Label rendered for the submenu. Defaults to name when unspecified. */
    displayName: string;
}

export class MapStore {
    private rooms = new Map<number, MudletRoom>();
    private areas = new Map<number, MudletArea>();
    private areaNames = new Map<number, string>();
    private hashToRoom = new Map<string, number>();
    private labels = new Map<number, MudletLabel[]>();
    private envColors = new Map<number, number>();
    private nextRoomId = 1;
    private nextAreaId = 1;
    /** Installed by `setExitWeightFilter`; consulted per exit in findPath. */
    private exitWeightFilter: ExitWeightFilter | null = null;
    // In-flight state for a three-phase binary load (beginBinaryLoad →
    // ingestBinaryRooms* → endBinaryLoad). Empty/false outside a load.
    private pendingBinaryHashIndex: Record<string, number> = {};
    private pendingBinaryHadSelection = false;
    private version = 0;
    private subscribers = new Set<() => void>();
    private notifyPending = false;
    // Highlights are a paint-only overlay — they don't affect room/area/exit
    // data, so they go through their own subscription channel. Routing them
    // through the general `notify()` would force MudixMapReader to rebuild
    // its entire snapshot (toMudletMap + readerExport cloneDeep) on every
    // highlightRoom/unHighlightRoom call, which during a speedwalk (where a
    // mapper script updates highlights per move) blocks the main thread for
    // hundreds of ms per step.
    private highlightSubscribers = new Set<() => void>();
    private highlightNotifyPending = false;
    // Map-room selection (Mudlet getMapSelection / clearMapSelection). Selection
    // is paint-only — it never touches room/area/exit data — so it rides its
    // own channel just like highlights to keep MudixMapReader / MapPanel's
    // syncFromStore out of the hot path on every click. `center` is the most
    // recently single-clicked room; Mudlet returns it in the selection table.
    private selectedRooms = new Set<number>();
    private selectionCenter: number | null = null;
    private selectionVersion = 0;
    private selectionSubscribers = new Set<() => void>();
    private selectionNotifyPending = false;
    private mapEvents = new Map<string, MapEventEntry>();
    private mapMenus = new Map<string, MapMenuEntry>();
    private customEnvColors = new Map<number, MudletColor>();
    /** roomID → the special-exit COMMANDS locked on it. See
     *  {@link lockedSpecialCommands}. */
    private specialExitLocks = new Map<number, Set<string>>();
    private roomHighlights = new Map<number, RoomHighlight>();
    private mapUserData: Record<string, string> = {};
    // Player's current room id, mirrors Mudlet's mRoomIdHash[host.getName()].
    // Updated by centerview (matching Mudlet's centerview-sets-player-room
    // behavior). Read by getPlayerRoom; returns null when unset or the room
    // has since been deleted.
    private playerRoomId: number | null = null;
    // Mudlet stores the per-profile player room inside the map file as
    // mRoomIdHash (profileName → roomId), so reopening a map restores the
    // position without any centerview. We keep the whole hash loaded so other
    // profiles' entries survive a save (Mudlet's "don't clobber shared maps"
    // behavior); our own entry is (re)derived from playerRoomId on export.
    private mRoomIdHash: Record<string, number> = {};
    /** Mudlet's mProfileName — the key into mRoomIdHash for this profile's saved
     *  player room. Set by ScriptingEngine to the connection name before the map
     *  loads. Empty string when unknown (then no position is restored/saved). */
    profileName = '';
    // Set by LuaRuntime so dispatchMapEvent can fire raiseEvent into the runtime.
    // Cleared on runtime teardown to avoid firing into a closed lua_State.
    private mapEventDispatcher: ((eventName: string, args: unknown[]) => void) | null = null;
    // Mudlet registerMapInfo contributors. Insertion-ordered so the panel renders
    // entries in registration order (Mudlet behaves the same). Seeded in the
    // constructor with the two built-in contributors ("Short", "Full").
    private mapInfoContributors: MapInfoContributor[] = [];
    // Labels that are switched *on* but have no contributor registered under them
    // right now. Mudlet models the enabled set as a plain QSet<QString> of names
    // (Host::mMapInfoContributors) kept entirely separate from the contributor
    // registry, so `setConfig("showMapInfo", label)` may name something that has
    // not been registered yet — and it takes effect the moment it is. mudix hangs
    // `enabled` off the contributor itself, so this set carries the other half of
    // Mudlet's model: names waiting for a contributor. It also survives Lua
    // teardown (see clearMapInfoContributors), matching the host-level lifetime
    // of Mudlet's set.
    private pendingMapInfoEnabled = new Set<string>();
    // Native evaluators for the built-in contributors, keyed by label. Read by
    // evaluateMapInfos when a contributor is `builtin` — they don't go through
    // the Lua evaluator, so they keep working with no scripts loaded.
    private builtinMapInfo = new Map<string, NativeMapInfoFn>();
    // Set by LuaRuntime so evaluateMapInfos can invoke each contributor's
    // Lua callback and capture its multi-return. Cleared on runtime teardown
    // alongside the contributor list — the cb ids are runtime-scoped.
    private mapInfoEvaluator:
        | ((callbackId: number, roomId: number | null, selectionSize: number, areaId: number, displayedAreaId: number) => Omit<MapInfoResult, 'label'> | null)
        | null = null;

    constructor() {
        this.seedBuiltinMapInfo();
        this.restore16ColorSet();
    }

    subscribe(cb: () => void): () => void {
        this.subscribers.add(cb);
        return () => this.subscribers.delete(cb);
    }

    /** Subscribe to highlight-set changes only (highlightRoom / unHighlightRoom
     *  and bulk clears via newEmptyMap / loadFromBinary). MudletHighlightOverlay
     *  uses this so it re-renders without forcing a full MudixMapReader rebuild. */
    subscribeHighlights(cb: () => void): () => void {
        this.highlightSubscribers.add(cb);
        return () => this.highlightSubscribers.delete(cb);
    }

    /** Subscribe to selection changes (selectMapRoom / toggleMapRoomSelection /
     *  clearMapSelection and the bulk clears in newEmptyMap / loadFromBinary).
     *  MapSelectionOverlay rides this so per-click repaints stay off the main
     *  store-notify channel. */
    subscribeSelection(cb: () => void): () => void {
        this.selectionSubscribers.add(cb);
        return () => this.selectionSubscribers.delete(cb);
    }

    private notify(): void {
        this.version++;
        if (this.notifyPending) return;
        this.notifyPending = true;
        queueMicrotask(() => {
            this.notifyPending = false;
            for (const cb of this.subscribers) cb();
        });
    }

    private notifyHighlights(): void {
        if (this.highlightNotifyPending) return;
        this.highlightNotifyPending = true;
        queueMicrotask(() => {
            this.highlightNotifyPending = false;
            for (const cb of this.highlightSubscribers) cb();
        });
    }

    private notifySelection(): void {
        this.selectionVersion++;
        if (this.selectionNotifyPending) return;
        this.selectionNotifyPending = true;
        queueMicrotask(() => {
            this.selectionNotifyPending = false;
            for (const cb of this.selectionSubscribers) cb();
        });
    }

    /** Monotonic counter incremented on every mutation. Live readers compare
     *  the snapshot they cached against this to decide whether to rebuild. */
    getVersion(): number { return this.version; }

    isEmpty(): boolean { return this.rooms.size === 0; }

    private initialized = false;

    /** True once newEmptyMap() has been called — the store is ready for scripting even with 0 rooms. */
    isInitialized(): boolean { return this.initialized; }

    /** Initialize with a single default area so scripts can start adding rooms immediately. */
    newEmptyMap(): void {
        this.rooms.clear();
        this.areas.clear();
        this.areaNames.clear();
        this.hashToRoom.clear();
        this.labels.clear();
        this.envColors.clear();
        this.customEnvColors.clear();
        this.restore16ColorSet();
        this.roomCharColors.clear();
        if (this.hiddenRooms.size > 0) { this.hiddenRooms.clear(); this.hiddenVersion++; }
        this.roomHighlights.clear();
        const hadSelection = this.selectedRooms.size > 0 || this.selectionCenter != null;
        this.selectedRooms.clear();
        this.selectionCenter = null;
        this.mapUserData = {};
        this.playerRoomId = null;
        this.mRoomIdHash = {};
        this.nextRoomId = 1;
        this.nextAreaId = 2;        // -1 is reserved below
        const defaultArea = makeArea();
        defaultArea.zLevels = [0];
        this.areas.set(-1, defaultArea);
        this.areaNames.set(-1, 'Default Area');
        this.initialized = true;
        this.notify();
        this.notifyHighlights();
        if (hadSelection) this.notifySelection();
    }

    /**
     * Replace the store's contents with a parsed Mudlet binary map. Loads
     * rooms, areas, area names, hashes, labels, custom env colors, env color
     * palette, and map-level user data. Bumps the id cursors past any binary
     * ids so subsequent {@link createRoomID} / {@link addAreaName} calls don't
     * collide. One notification fires at the end of the batch.
     */
    loadFromBinary(mudletMap: MudletMap): void {
        this.beginBinaryLoad(mudletMap);
        for (const [k, room] of Object.entries(mudletMap.rooms ?? {})) {
            this.ingestBinaryRoom(Number(k), room);
        }
        this.endBinaryLoad();
    }

    /**
     * Header phase of a streamed binary load — everything in a Mudlet map
     * except the rooms (see `MudletMapReader.streamRooms`). Wipes the store and
     * applies areas / names / labels / colours / user data, then leaves it open
     * for {@link ingestBinaryRooms} batches. Nothing is notified until
     * {@link endBinaryLoad}, so subscribers never observe a half-loaded map.
     *
     * {@link loadFromBinary} is this same three-phase sequence run eagerly over
     * an already-materialised map.
     */
    beginBinaryLoad(header: MudletMapHeader): void {
        this.rooms.clear();
        this.areas.clear();
        this.areaNames.clear();
        this.hashToRoom.clear();
        this.labels.clear();
        this.envColors.clear();
        this.customEnvColors.clear();
        this.restore16ColorSet();
        this.roomCharColors.clear();
        if (this.hiddenRooms.size > 0) { this.hiddenRooms.clear(); this.hiddenVersion++; }
        this.roomHighlights.clear();
        this.pendingBinaryHadSelection = this.selectedRooms.size > 0 || this.selectionCenter != null;
        this.selectedRooms.clear();
        this.selectionCenter = null;
        // Carry the whole profile→room hash so a later save preserves the
        // positions of profiles other than ours; our player room is restored
        // from it in endBinaryLoad once the rooms exist.
        this.mRoomIdHash = { ...(header.mRoomIdHash ?? {}) };
        this.playerRoomId = null;
        // Applied in endBinaryLoad — the hash→id table is authoritative over
        // whatever the rooms themselves claim, so it can only be folded in
        // after every room has landed.
        this.pendingBinaryHashIndex = header.mpRoomDbHashToRoomId ?? {};

        for (const [k, area] of Object.entries(header.areas ?? {})) {
            const id = Number(k);
            this.areas.set(id, area);
            if (id >= this.nextAreaId) this.nextAreaId = id + 1;
        }
        for (const [k, name] of Object.entries(header.areaNames ?? {})) {
            this.areaNames.set(Number(k), name);
        }
        for (const [k, labels] of Object.entries(header.labels ?? {})) {
            // Normalize pixmaps to base64 strings up-front. Heavy Buffer
            // payloads here would later get walked by lodash.cloneDeep inside
            // readerExport on every renderer refresh — see MudixMapReader for
            // the strip/patch dance that depends on this normalization.
            const normalized = labels.map(l => {
                const pm = l.pixMap as unknown;
                if (typeof pm === 'string') return l;
                if (!pm) return l;
                try { return { ...l, pixMap: Buffer.from(pm as Uint8Array).toString('base64') }; }
                catch { return { ...l, pixMap: '' }; }
            });
            this.labels.set(Number(k), normalized);
        }
        for (const [k, c] of Object.entries(header.mCustomEnvColors ?? {})) {
            this.customEnvColors.set(Number(k), c);
        }
        for (const [k, v] of Object.entries(header.envColors ?? {})) {
            this.envColors.set(Number(k), v);
        }
        this.mapUserData = { ...(header.mUserData ?? {}) };
    }

    /**
     * Room phase of a streamed binary load. Call any number of times between
     * {@link beginBinaryLoad} and {@link endBinaryLoad}; each batch is folded
     * into the store as it arrives, so the worker never has to hold (nor the
     * structured clone carry) the whole room graph at once.
     */
    ingestBinaryRooms(rooms: Iterable<readonly [number, MudletRoom]>): void {
        for (const [id, room] of rooms) this.ingestBinaryRoom(id, room);
    }

    private ingestBinaryRoom(id: number, room: MudletRoom): void {
        // v20 maps (and older) have no dedicated isHidden field on TRoom;
        // Mudlet smuggles it through userData["system.fallback_hidden"]
        // (TRoom.cpp:894-899). Take the key out and lift it to our
        // side-table so the rest of the codebase only deals with the
        // in-memory hiddenRooms set. The key is removed regardless of
        // value, matching Mudlet's QMap::take semantics.
        const fallback = room.userData?.[HIDDEN_FALLBACK_KEY];
        if (fallback !== undefined) {
            delete room.userData[HIDDEN_FALLBACK_KEY];
            if (fallback === 'true') this.hiddenRooms.add(id);
        }
        this.rooms.set(id, room);
        if (room.hash) this.hashToRoom.set(room.hash, id);
        if (id >= this.nextRoomId) this.nextRoomId = id + 1;
    }

    /**
     * Finalize a streamed binary load: fold in the authoritative hash index,
     * resolve the player room, and fire the single notification the whole load
     * is worth.
     */
    endBinaryLoad(): void {
        if (this.hiddenRooms.size > 0) this.hiddenVersion++;
        // Binary may carry hashes for rooms that haven't been parsed into
        // `rooms` (legacy maps with orphan hash entries). Trust the explicit
        // hash→id table as authoritative when it disagrees. Streamed rooms
        // arrive with no `hash` field at all (it lives only in this index), so
        // this is also where they get one — matching what readMapFromBuffer
        // does eagerly.
        for (const [hash, id] of Object.entries(this.pendingBinaryHashIndex)) {
            this.hashToRoom.set(hash, id);
            const room = this.rooms.get(id);
            if (room && !room.hash) room.hash = hash;
        }
        this.pendingBinaryHashIndex = {};
        // Mudlet restores the player room from mRoomIdHash[mProfileName] on load
        // (no fallback: a missing key means no position). Only accept an id that
        // actually resolves to a loaded room.
        const savedPlayer = this.profileName ? this.mRoomIdHash[this.profileName] : undefined;
        this.playerRoomId = savedPlayer != null && this.rooms.has(savedPlayer) ? savedPlayer : null;
        this.initialized = true;
        this.notify();
        this.notifyHighlights();
        if (this.pendingBinaryHadSelection) this.notifySelection();
        this.pendingBinaryHadSelection = false;
    }

    /**
     * Mudlet `deleteMap()` — wipe every room, area, label and associated datum,
     * leaving a fresh empty map with a single default area (so scripts can keep
     * adding rooms). Returns true.
     */
    deleteMap(): boolean {
        this.newEmptyMap();
        return true;
    }

    /**
     * Mudlet `T2DMap::slot_newMap` — the mapper's "Create new map" action,
     * offered when the profile has no map at all. Wipes to a fresh empty map
     * and seeds it with a single room at the origin of the default area (-1),
     * marked as the player's position so the marker and the opening view both
     * land on it. Returns the new room's id.
     */
    createNewMap(): number {
        this.newEmptyMap();
        const id = this.createRoomID();
        this.addRoom(id);
        // Mudlet parks the seed room in the default area. setRoomArea refuses
        // any areaID below 1, so resetRoomArea is the way there (it is the same
        // TRoom::setArea call Mudlet's `setRoomArea(roomID, -1, false)` makes).
        this.resetRoomArea(id);
        this.setRoomCoordinates(id, 0, 0, 0);
        this.setPlayerRoom(id);
        this.notify();
        return id;
    }

    toRendererData(): MapRendererData | null {
        if (this.rooms.size === 0) return null;
        try { return readerExport(this.toMudletMap()); } catch { return null; }
    }

    /**
     * Mudlet `saveJsonMap(path)` backbone — serialise the entire MapStore as a
     * JSON string with the same shape as the in-memory `MudletMap` (so a later
     * `loadJsonMap` can hand it straight to `loadFromBinary`). Pixmaps are
     * already normalised to base64 by `loadFromBinary`, so the result
     * round-trips cleanly through `JSON.stringify`.
     */
    toJsonString(): string { return JSON.stringify(this.toMudletMapForSave()); }

    /**
     * Save-side variant of {@link toMudletMap}: re-injects the v20-compatible
     * `system.fallback_hidden` userData key for rooms in the hidden side-table
     * so the serialised file round-trips back through `loadFromBinary` (and
     * stays loadable by Mudlet v20 readers). Render paths still call the plain
     * {@link toMudletMap} — the fallback key is dead weight for the renderer
     * and we don't want to pay the per-room object spread on every redraw.
     */
    toMudletMapForSave(): MudletMap {
        const m = this.toMudletMap();
        if (this.hiddenRooms.size === 0) return m;
        const patched: Record<number, MudletRoom> = {};
        for (const [k, r] of Object.entries(m.rooms)) {
            const id = Number(k);
            patched[id] = this.hiddenRooms.has(id)
                ? { ...r, userData: { ...r.userData, [HIDDEN_FALLBACK_KEY]: 'true' } }
                : r;
        }
        return { ...m, rooms: patched };
    }

    /**
     * Mudlet `loadJsonMap(path)` backbone — parse a JSON payload previously
     * produced by `toJsonString` and replace the store's contents. Returns
     * true on success, false when the JSON is malformed or doesn't carry the
     * expected MudletMap shape (no `rooms` / `areas` records).
     */
    loadFromJsonString(json: string): boolean {
        let parsed: unknown;
        try { parsed = JSON.parse(json); }
        catch { return false; }
        if (!parsed || typeof parsed !== 'object') return false;
        const map = parsed as Partial<MudletMap>;
        // Mudlet's own saveJsonMap output has no top-level `rooms` and keeps
        // them nested inside an `areas` array — convert that shape first, and
        // only then fall through to the binary-model shape toJsonString emits.
        const source = (!map.rooms || Array.isArray(map.areas))
            ? mudletJsonMapToMudletMap(parsed)
            : (map.areas ? map as MudletMap : null);
        if (!source) return false;
        try { this.loadFromBinary(source); }
        catch { return false; }
        // Symbol colours live in a side-table (MudletRoom has no charColor
        // field), so they can only be applied once the rooms exist.
        applyJsonSymbolColors(parsed, this);
        return true;
    }

    toMudletMap(): MudletMap {
        const areas: Record<number, MudletArea> = {};
        for (const [id, a] of this.areas) areas[id] = a;
        const rooms: Record<number, MudletRoom> = {};
        for (const [id, r] of this.rooms) rooms[id] = r;
        const areaNames: Record<number, string> = {};
        for (const [id, n] of this.areaNames) areaNames[id] = n;
        const hashes: Record<string, number> = {};
        for (const [h, id] of this.hashToRoom) hashes[h] = id;
        const mCustomEnvColors: Record<number, MudletColor> = {};
        for (const [id, c] of this.customEnvColors) mCustomEnvColors[id] = c;
        const envColors: Record<number, number> = {};
        for (const [id, v] of this.envColors) envColors[id] = v;
        const labels: Record<number, MudletLabel[]> = {};
        for (const [id, ls] of this.labels) labels[id] = ls;
        // Preserve other profiles' saved player rooms, and stamp our own from
        // the live playerRoomId so reopening the map restores the position
        // (Mudlet's mRoomIdHash[mProfileName] round-trip).
        const mRoomIdHash = { ...this.mRoomIdHash };
        if (this.profileName) {
            if (this.playerRoomId != null && this.rooms.has(this.playerRoomId)) {
                mRoomIdHash[this.profileName] = this.playerRoomId;
            } else {
                delete mRoomIdHash[this.profileName];
            }
        }
        return {
            // Mudlet binary map *format* version — the leading int that selects
            // the reader/writer model. Must be 20: it's the only version the
            // bundled mudlet-map-binary-reader registers a model for, and its
            // writer now rejects anything else (older versions silently ignored
            // this field, which is how `1` survived undetected).
            version: 20, envColors, areaNames, mCustomEnvColors,
            mpRoomDbHashToRoomId: hashes, mUserData: { ...this.mapUserData },
            mapSymbolFont: DEFAULT_FONT, mapFontFudgeFactor: 1, useOnlyMapFont: false,
            areas, mRoomIdHash, labels, rooms,
        };
    }

    // ── Room IDs ──────────────────────────────────────────────────────────────

    /**
     * Mudlet `createRoomID([minimum])` — returns the smallest unused room id
     * at or above `minimum` (or above the running cursor if not given). The
     * id isn't reserved; a follow-up `addRoom(id)` is what actually claims it.
     */
    createRoomID(minimum?: number): number {
        let id = minimum != null && Number.isFinite(minimum) && minimum > 0
            ? Math.trunc(minimum)
            : this.nextRoomId;
        while (this.rooms.has(id)) id++;
        if (id >= this.nextRoomId) this.nextRoomId = id + 1;
        return id;
    }

    // ── Room CRUD ─────────────────────────────────────────────────────────────

    /**
     * Mudlet `addRoom(roomID [, areaID])`. The room is always created; the
     * areaID is a placement *request*. An areaID naming an area that doesn't
     * exist is not created on demand (Mudlet's TLuaInterpreter::addRoom parks
     * the room in the default area -1 and reports the failed placement as
     * `(nil, errMsg)` instead), so this returns the message for the binding to
     * shape and leaves the room in -1.
     *
     * Returns false only when the roomID is already taken.
     */
    addRoom(id: number, areaId?: number): boolean | { err: string } {
        if (this.rooms.has(id)) return false;
        const requested = areaId != null && Number.isFinite(areaId) ? Number(areaId) : undefined;
        const known = requested !== undefined && this.areas.has(requested);
        this.rooms.set(id, makeRoom(known ? requested : (requested === undefined ? 0 : -1)));
        if (known) this.areas.get(requested)!.rooms.push(id);
        this.notify();
        if (requested !== undefined && !known) {
            return { err: `addRoom: created roomID ${id} but failed to place it in areaID ${requested},`
                + ' does that area actually exist? (Room has been placed in areaID -1 instead.)' };
        }
        return true;
    }

    deleteRoom(id: number): boolean {
        const room = this.rooms.get(id);
        if (!room) return false;
        const area = this.areas.get(room.area);
        if (area) {
            area.rooms = area.rooms.filter(r => r !== id);
            this.updateAreaBounds(room.area);
        }
        if (room.hash) this.hashToRoom.delete(room.hash);
        this.rooms.delete(id);
        // Selection is paint-only but it tracks room ids — drop the deleted
        // one so getMapSelection doesn't dangle.
        if (this.selectedRooms.delete(id)) {
            if (this.selectionCenter === id) {
                let next: number | null = null;
                for (const r of this.selectedRooms) {
                    if (next == null || r < next) next = r;
                }
                this.selectionCenter = next;
            }
            this.notifySelection();
        }
        this.notify();
        return true;
    }

    roomExists(id: number): boolean { return this.rooms.has(id); }

    // ── Player position ───────────────────────────────────────────────────────

    /** Mudlet `getPlayerRoom()` — id of the player's current room, or null
     *  when unset or the room no longer exists. Strict: no fallback room (Mudlet
     *  keeps the data-layer value empty until centerview/movement sets it). The
     *  view's "no known location" fallback lives in {@link getFallbackRoomId}. */
    getPlayerRoom(): number | null {
        if (this.playerRoomId == null) return null;
        return this.rooms.has(this.playerRoomId) ? this.playerRoomId : null;
    }

    /** Display-only fallback room for the map view when there is no real player
     *  position (getPlayerRoom() is null). Mudlet's T2DMap paints the marker on
     *  getRoomIDList().constFirst() — hash-arbitrary, hence its `randomRoom`
     *  name. We prefer room 1 (stable and what users expect), then the lowest
     *  existing id so the marker still lands somewhere on odd maps. null only
     *  when the map is empty. Never feeds getPlayerRoom — it's purely for
     *  centering + the marker. */
    getFallbackRoomId(): number | null {
        if (this.rooms.has(1)) return 1;
        let min: number | null = null;
        for (const id of this.rooms.keys()) if (min == null || id < min) min = id;
        return min;
    }

    /** Mirror of Mudlet's `mRoomIdHash[host.getName()] = roomId` from centerview.
     *  centerView validates the id exists before calling this (Mudlet rejects
     *  unknown ids), so the stored id is normally live; getPlayerRoom still does
     *  an existence check on read in case the room is deleted afterwards. */
    setPlayerRoom(id: number): void {
        this.playerRoomId = id;
    }

    // ── Room properties ───────────────────────────────────────────────────────

    getRoomName(id: number): string | undefined { return this.rooms.get(id)?.name; }

    setRoomName(id: number, name: string): boolean {
        const r = this.rooms.get(id);
        if (!r) return false;
        r.name = name;
        this.notify();
        return true;
    }

    /** Mudlet `getRoomArea(id)` — area id of the room, or -1 if the room is missing. */
    /** Mudlet `getRoomArea(roomID)` — the area the room belongs to (-1 is the
     *  default area), or undefined when the room itself doesn't exist. */
    getRoomArea(id: number): number | undefined { return this.rooms.get(id)?.area; }

    /**
     * Mudlet `setRoomArea(roomID|{ids}, areaID|areaName)`. Accepts either a
     * single room ID or an array of room IDs, and either a numeric area ID or
     * an area-name string.
     *
     * The area must already exist — Mudlet does not create one on demand, and
     * an areaID below 1 is refused outright (resetRoomArea is the documented
     * way to park a room in the default area -1). Every refusal is a
     * `(nil, errMsg)` return there, so the message is handed back here and null
     * means success (see {@link setDoor}).
     */
    setRoomArea(id: number | number[], areaIdOrName: number | string): string | null {
        const ids = Array.isArray(id) ? id.map(n => Number(n)) : [Number(id)];
        for (const rid of ids) {
            if (!Number.isFinite(rid) || !this.rooms.has(rid)) {
                return `setRoomArea: number ${rid} is not a valid roomID`;
            }
        }
        let aid: number;
        if (typeof areaIdOrName === 'string' && !/^-?\d+$/.test(areaIdOrName.trim())) {
            if (areaIdOrName.length === 0) return 'setRoomArea: area name cannot be empty';
            const resolved = this.resolveAreaId(areaIdOrName);
            if (resolved == null) return `setRoomArea: area name '${areaIdOrName}' does not exist`;
            aid = resolved;
        } else {
            aid = Number(areaIdOrName);
            if (!Number.isFinite(aid) || aid < 1) {
                return `setRoomArea: number ${areaIdOrName} is not a valid areaID greater than zero.`
                    + " To remove a room's area, use resetRoomArea(roomID)";
            }
            if (!this.areaNames.has(aid)) {
                return `setRoomArea: number ${aid} is not a valid areaID`;
            }
        }
        for (const rid of ids) {
            const room = this.rooms.get(rid)!;
            const oldArea = this.areas.get(room.area);
            if (oldArea) {
                oldArea.rooms = oldArea.rooms.filter(r => r !== rid);
                this.updateAreaBounds(room.area);
            }
            if (!this.areas.has(aid)) this.areas.set(aid, makeArea());
            this.areas.get(aid)!.rooms.push(rid);
            room.area = aid;
            this.updateAreaBounds(aid);
        }
        this.notify();
        return null;
    }

    /** Resolve area-id-or-name → numeric id, or undefined if unknown. */
    private resolveAreaId(idOrName: number | string): number | undefined {
        if (typeof idOrName === 'number') {
            return Number.isFinite(idOrName) ? idOrName : undefined;
        }
        if (typeof idOrName === 'string') {
            const n = Number(idOrName);
            if (Number.isFinite(n) && /^-?\d+$/.test(idOrName.trim())) return n;
            for (const [aid, name] of this.areaNames) if (name === idOrName) return aid;
            return undefined;
        }
        return undefined;
    }

    getRoomCoordinates(id: number): [number, number, number] | undefined {
        const r = this.rooms.get(id);
        return r ? [r.x, r.y, r.z] : undefined;
    }

    /**
     * Mudlet `searchRoom(roomID | roomName[, caseSensitive[, exactMatch]])` —
     * by id returns the room's name (or `undefined` for a miss); by name returns
     * `{ [roomID] = roomName }` for every room whose name matches. Matching is a
     * case-insensitive substring search by default; `caseSensitive`/`exactMatch`
     * tighten it. The binding re-keys the wasmoon-stringified ids back to ints.
     */
    searchRoom(arg: number | string, caseSensitive = false, exactMatch = false): string | undefined | Record<number, string> {
        if (typeof arg === 'number') {
            return this.rooms.get(arg)?.name;
        }
        const needle = caseSensitive ? arg : arg.toLowerCase();
        const out: Record<number, string> = {};
        for (const [id, r] of this.rooms) {
            const name = r.name ?? '';
            const hay = caseSensitive ? name : name.toLowerCase();
            const hit = exactMatch ? hay === needle : hay.includes(needle);
            if (hit) out[id] = name;
        }
        return out;
    }

    /**
     * Mudlet `searchRoomUserData([key[, value]])`:
     *   • no args → sorted list of every user-data key used by any room;
     *   • key only → sorted list of every distinct value stored under that key;
     *   • key + value → sorted list of room ids where that key equals value.
     */
    searchRoomUserData(key?: string, value?: string): string[] | number[] {
        if (key == null) {
            const keys = new Set<string>();
            for (const r of this.rooms.values()) for (const k of Object.keys(r.userData)) keys.add(k);
            return [...keys].sort();
        }
        if (value == null) {
            const values = new Set<string>();
            for (const r of this.rooms.values()) {
                if (Object.prototype.hasOwnProperty.call(r.userData, key)) values.add(r.userData[key]);
            }
            return [...values].sort();
        }
        const ids: number[] = [];
        for (const [id, r] of this.rooms) {
            if (r.userData[key] === value) ids.push(id);
        }
        return ids.sort((a, b) => a - b);
    }

    setRoomCoordinates(id: number, x: number, y: number, z: number): boolean {
        const room = this.rooms.get(id);
        if (!room) return false;
        room.x = x; room.y = y; room.z = z;
        this.updateAreaBounds(room.area);
        const area = this.areas.get(room.area);
        if (area && !area.zLevels.includes(z)) {
            area.zLevels.push(z);
            area.zLevels.sort((a, b) => a - b);
        }
        this.notify();
        return true;
    }

    /**
     * Mudlet `getRoomEnv(id)` — environment color id, or -1 if the room is
     * missing. (Rooms without an env override still report their stored value.)
     */
    getRoomEnv(id: number): number {
        return this.rooms.get(id)?.environment ?? -1;
    }

    setRoomEnv(id: number, env: number): boolean {
        const r = this.rooms.get(id);
        if (!r) return false;
        r.environment = env;
        this.notify();
        return true;
    }

    getRoomChar(id: number): string { return this.rooms.get(id)?.symbol ?? ''; }

    setRoomChar(id: number, char: string): boolean {
        const r = this.rooms.get(id);
        if (!r) return false;
        r.symbol = char;
        this.notify();
        return true;
    }

    /**
     * Mudlet `lockRoom(roomID, lockIfTrue)` — mark a room as locked so
     * pathfinding routes around it (see {@link findPath}). Returns true on
     * success, false when the room doesn't exist.
     */
    lockRoom(id: number, lock: boolean): boolean {
        const r = this.rooms.get(id);
        if (!r) return false;
        r.isLocked = lock;
        this.notify();
        return true;
    }

    /**
     * Mudlet `roomLocked(roomID)` — true when the room is locked, false when
     * unlocked or the room doesn't exist (Mudlet returns nil for a missing
     * room; the Lua binding re-shapes that case).
     */
    roomLocked(id: number): boolean {
        return this.rooms.get(id)?.isLocked ?? false;
    }

    /**
     * Mudlet `getRoomWeight(roomID)` — the room's pathfinding weight (cost to
     * enter). Returns `undefined` when the room doesn't exist; the Lua binding
     * turns that into Mudlet's "no return value" miss.
     */
    getRoomWeight(id: number): number | undefined {
        return this.rooms.get(id)?.weight;
    }

    /**
     * Mudlet `setRoomWeight(roomID, weight)` — set the room's pathfinding
     * weight. Mudlet rejects negative weights (0 is allowed). Returns true on
     * success, false when the room doesn't exist or the weight is invalid.
     */
    setRoomWeight(id: number, weight: number): boolean {
        const r = this.rooms.get(id);
        if (!r) return false;
        if (!Number.isFinite(weight) || weight < 0) return false;
        r.weight = weight;
        this.notify();
        return true;
    }

    // ── Coordinates / position ────────────────────────────────────────────────

    /** Mudlet `getRoomsByPosition(areaID, x, y, z)` — undefined for an unknown
     *  area, matching {@link getAreaRooms}. */
    getRoomsByPosition(areaId: number, x: number, y: number, z: number): number[] | undefined {
        const area = this.areas.get(areaId);
        if (!area) return undefined;
        return area.rooms.filter(id => {
            const r = this.rooms.get(id);
            return r && r.x === x && r.y === y && r.z === z;
        });
    }

    // ── Hash management ───────────────────────────────────────────────────────

    getRoomIDbyHash(hash: string): number | undefined { return this.hashToRoom.get(hash); }

    setRoomIDbyHash(id: number, hash: string): void {
        const room = this.rooms.get(id);
        if (!room) return;
        if (room.hash) this.hashToRoom.delete(room.hash);
        room.hash = hash;
        this.hashToRoom.set(hash, id);
        this.notify();
    }

    getRoomHashByID(id: number): string | undefined { return this.rooms.get(id)?.hash; }

    // ── Exits ─────────────────────────────────────────────────────────────────

    /** Mudlet `getRoomExits(roomID)` — `{ direction = toRoomID }`. Undefined
     *  for an unknown room (Mudlet pushes nothing at all in that case). */
    getRoomExits(id: number): Record<string, number> | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        const exits: Record<string, number> = {};
        for (const field of Object.values(DIR_FIELD)) {
            const val = (room as unknown as Record<string, number>)[field];
            if (val !== -1) exits[field] = val;
        }
        return exits;
    }

    /**
     * Mudlet `setExit(from, to, dir)` — `dir` is either a 1-12 integer or a
     * direction name ("north"/"n"/etc.). Returns true on success.
     */
    setExit(from: number, to: number, dir: number | string): boolean {
        const room = this.rooms.get(from);
        if (!room) return false;
        const dirInt = parseDirection(dir);
        if (dirInt == null) return false;
        const field = DIR_FIELD[dirInt];
        (room as unknown as Record<string, number>)[field] = to;
        if (to >= 0) room.stubs = room.stubs.filter(s => s !== dirInt);
        this.notify();
        return true;
    }

    /** Mudlet `getExitStubs(roomID)` — the room's stub direction codes, or
     *  undefined for an unknown room (reported as `(nil, errMsg)` in Lua). */
    getExitStubs(id: number): number[] | undefined {
        const room = this.rooms.get(id);
        return room ? [...room.stubs] : undefined;
    }

    /**
     * Mudlet `getExitStubsNames(roomID)` — the room's exit stubs as direction
     * names ("north"/"northeast"/…, or "other" for the special-exit code 13)
     * rather than the numeric codes `getExitStubs` returns. Returns `undefined`
     * when the room doesn't exist so the binding can hand back Mudlet's
     * `(false, errMsg)`.
     */
    getExitStubsNames(id: number): string[] | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        return room.stubs.map(n => DIR_FIELD[n] ?? 'other');
    }

    /** Mudlet `findPath(from, to)` — see {@link findPath} in `./pathfinding`
     *  for the algorithm (A* with Mudlet's Euclidean-or-1 heuristic). */
    findPath(from: number, to: number): PathfindResult | null {
        return findPath(this.rooms, from, to, this.exitWeightFilter,
            (roomId, command) => this.isSpecialExitLocked(roomId, command));
    }

    /** Mudlet `setExitWeightFilter(fn|nil)` — the callback consulted for every
     *  candidate exit during pathfinding, or null when none is installed. Set
     *  by the Lua binding; read only by {@link findPath}. */
    setExitWeightFilter(filter: ExitWeightFilter | null): void {
        this.exitWeightFilter = filter;
    }

    setExitStub(id: number, dir: number | string, set: boolean): boolean {
        const room = this.rooms.get(id);
        if (!room) return false;
        const dirInt = parseDirection(dir);
        if (dirInt == null) return false;
        if (set) { if (!room.stubs.includes(dirInt)) room.stubs.push(dirInt); }
        else room.stubs = room.stubs.filter(s => s !== dirInt);
        this.notify();
        return true;
    }

    /**
     * Mudlet `lockExit(roomID, direction, lockIfTrue)` — toggle a stock-direction
     * exit lock so pathfinding (see `pathfinding.ts`) routes around it. `dir`
     * accepts the 1-12 integer code or a direction name ("north"/"n"/etc.).
     * Returns true on success, false when the room is missing or `dir` doesn't
     * resolve.
     */
    lockExit(id: number, dir: number | string, lock: boolean): boolean {
        const room = this.rooms.get(id);
        if (!room) return false;
        const dirInt = parseDirection(dir);
        if (dirInt == null) return false;
        const locks = room.exitLocks ?? (room.exitLocks = []);
        if (lock) { if (!locks.includes(dirInt)) locks.push(dirInt); }
        else room.exitLocks = locks.filter(d => d !== dirInt);
        this.notify();
        return true;
    }

    /**
     * Mudlet `hasExitLock(roomID, direction)` — whether the stock-direction exit
     * is currently locked. Returns false for an unlocked exit or when the room
     * doesn't exist (Lua binding maps the latter to `(false, errMsg)`).
     */
    hasExitLock(id: number, dir: number | string): boolean {
        const room = this.rooms.get(id);
        if (!room) return false;
        const dirInt = parseDirection(dir);
        if (dirInt == null) return false;
        return (room.exitLocks ?? []).includes(dirInt);
    }

    /**
     * Mudlet `addSpecialExit(exitRoomID, entranceRoomID, command)`. Both rooms
     * must exist and the command must be non-empty; each failure is a
     * `(nil, errMsg)` return in Mudlet, so the message is handed back here and
     * null means success (same shape as {@link setDoor}).
     */
    addSpecialExit(from: number, to: number, cmd: string): string | null {
        const r = this.rooms.get(from);
        if (!r) return `addSpecialExit: number ${from} is not a valid exit roomID`;
        if (!this.rooms.has(to)) return `addSpecialExit: number ${to} is not a valid entrance roomID`;
        if (typeof cmd !== 'string' || cmd.length === 0) {
            return 'addSpecialExit: the special exit name/command cannot be empty';
        }
        r.mSpecialExits[cmd] = to;
        this.notify();
        return null;
    }

    /** Mudlet `removeSpecialExit(exitRoomID, command)` — see {@link addSpecialExit}
     *  for the message/null return shape. */
    removeSpecialExit(from: number, cmd: string): string | null {
        const r = this.rooms.get(from);
        if (!r) return `removeSpecialExit: number ${from} is not a valid exit roomID`;
        if (typeof cmd !== 'string' || cmd.length === 0) {
            return 'removeSpecialExit: the exit command cannot be empty';
        }
        if (!(cmd in r.mSpecialExits)) {
            return `removeSpecialExit: the special exit name/command '${cmd}' does not exist in exit roomID ${from}`;
        }
        delete r.mSpecialExits[cmd];
        this.notify();
        return null;
    }

    getSpecialExitsSwap(id: number): Record<string, number> {
        return { ...(this.rooms.get(id)?.mSpecialExits ?? {}) };
    }

    /**
     * Mudlet `getSpecialExits(roomID [, listAllExits])` — special exits keyed by
     * destination room id: `{ [exitRoomID] = { [command] = "0"|"1" } }`, where
     * "1" marks a locked exit. When several commands lead to the same room and
     * `listAllExits` is false (the default), only the lowest-weight command is
     * reported; pass `true` to list every command. Returns `{}` for a missing
     * room. The lock flag follows this client's data model (special-exit locks
     * are tracked by destination room id, see pathfinding.ts).
     */
    getSpecialExits(id: number, listAllExits = false): Record<number, Record<string, string>> | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        const weights = room.exitWeights ?? {};
        // Group the commands leading to each destination room.
        const byDest = new Map<number, string[]>();
        for (const [cmd, dest] of Object.entries(room.mSpecialExits ?? {})) {
            const list = byDest.get(dest);
            if (list) list.push(cmd);
            else byDest.set(dest, [cmd]);
        }
        const lockFlag = (cmd: string) => (this.isSpecialExitLocked(id, cmd) ? '1' : '0');
        const out: Record<number, Record<string, string>> = {};
        for (const [dest, cmds] of byDest) {
            const inner: Record<string, string> = {};
            if (listAllExits || cmds.length === 1) {
                for (const cmd of cmds) inner[cmd] = lockFlag(cmd);
            } else {
                // Mudlet's rule: the cheapest UNLOCKED command wins, and only if
                // every command to this room is locked does the cheapest locked
                // one get reported.
                let bestUnlocked: string | null = null, bestUnlockedWeight = Infinity;
                let bestLocked: string | null = null, bestLockedWeight = Infinity;
                for (const cmd of cmds) {
                    const w = weights[cmd] ?? 1;
                    if (this.isSpecialExitLocked(id, cmd)) {
                        if (w < bestLockedWeight) { bestLockedWeight = w; bestLocked = cmd; }
                    } else if (w < bestUnlockedWeight) {
                        bestUnlockedWeight = w; bestUnlocked = cmd;
                    }
                }
                const best = bestUnlocked ?? bestLocked;
                if (best != null) inner[best] = lockFlag(best);
            }
            out[dest] = inner;
        }
        return out;
    }

    /**
     * Mudlet `getExitWeights(roomID)` — per-exit weight overrides as
     * `{ [exit] = weight }`. Stock exits are keyed by their short direction name
     * ("n"/"ne"/"up"/…), special exits by the verbatim command. Returns `{}`
     * when the room has no overrides or doesn't exist.
     */
    getExitWeights(id: number): Record<string, number> {
        return { ...(this.rooms.get(id)?.exitWeights ?? {}) };
    }

    /**
     * Mudlet `setExitWeight(roomID, exitCommand, weight)` — override the weight
     * of a single exit. `exitCommand` is a stock direction (1-12 or a name) or a
     * special-exit command. A weight of 0 resets the override (pathfinding falls
     * back to the destination room's weight); negative weights are rejected.
     * Each refusal is a `(nil, errMsg)` return in Mudlet, so the message is
     * handed back here and null means success (see {@link setDoor}).
     */
    setExitWeight(id: number, exitCommand: number | string, weight: number): string | null {
        const room = this.rooms.get(id);
        if (!room) return `setExitWeight: number ${id} is not a valid roomID`;
        const dirInt = parseDirection(exitCommand);
        const key = dirInt != null ? DIR_SHORT[dirInt] : String(exitCommand ?? '');
        // Mudlet checks the exit before the weight, so a bad direction on a
        // negative weight reports the direction.
        if (!this.hasExitOrSpecialExit(room, dirInt, key)) {
            return `setExitWeight: roomID ${id} does not have an exit that can be identified from '${String(exitCommand)}'`;
        }
        if (!Number.isFinite(weight) || weight < 0) {
            return `setExitWeight: weight ${weight} is outside of the usable range of 0`
                + ' (which resets the weight back to that of the destination room) to 2147483647';
        }
        if (weight === 0) delete room.exitWeights[key];
        else room.exitWeights[key] = weight;
        this.notify();
        return null;
    }

    /**
     * Mudlet `clearSpecialExits(roomID)` — remove every special exit from the
     * room, along with the locks, doors and custom lines keyed by those
     * commands (Mudlet's TRoom::clearSpecialExits does the same cleanup).
     * Returns true on success, false when the room doesn't exist.
     */
    clearSpecialExits(id: number): boolean {
        const room = this.rooms.get(id);
        if (!room) return false;
        for (const cmd of Object.keys(room.mSpecialExits)) {
            delete room.doors[cmd];
            delete room.customLines[cmd];
            delete room.customLinesColor[cmd];
            delete room.customLinesStyle[cmd];
            delete room.customLinesArrow[cmd];
            delete room.exitWeights[cmd];
        }
        room.mSpecialExits = {};
        room.mSpecialExitLocks = [];
        this.specialExitLocks.delete(id);
        this.notify();
        return true;
    }

    /**
     * Mudlet `lockSpecialExit(fromRoomID, toRoomID, command, lockIfTrue)` — lock
     * or unlock a special exit so pathfinding skips it. Mudlet ignores the
     * `toRoomID` argument (kept for signature compatibility); the lock is keyed
     * by the COMMAND (TRoom::mSpecialExitLocks is a `QSet<QString>`), so two
     * commands leading to the same room lock independently. Returns true on
     * success or an error string (room missing / no such command) the binding
     * turns into `(nil, errMsg)`.
     */
    lockSpecialExit(fromId: number, command: string, lock: boolean): true | string {
        const room = this.rooms.get(fromId);
        if (!room) return `lockSpecialExit: roomID ${fromId} does not exist`;
        if (!Object.prototype.hasOwnProperty.call(room.mSpecialExits, command)) {
            return `lockSpecialExit: the special exit name/command '${command}' does not exist in roomID ${fromId}`;
        }
        const locked = this.lockedSpecialCommands(fromId);
        if (lock) locked.add(command);
        else locked.delete(command);
        // Keep the destination-keyed mirror in step: it is what the binary
        // writer repacks into the on-disk "1"+command form, and what
        // pathfinding's per-destination check reads.
        this.syncSpecialExitLockMirror(fromId);
        this.notify();
        return true;
    }

    /**
     * Per-command special-exit locks for a room, created on first use. Seeded
     * from the destination-keyed list a loaded map arrives with, since the
     * binary reader collapses Mudlet's per-command locks down to the rooms they
     * lead to (`MudletRoom.mSpecialExitLocks` is `number[]`) — so an imported
     * map starts out with every command to a locked destination locked, exactly
     * as it renders today, and diverges only as scripts lock individual
     * commands.
     */
    private lockedSpecialCommands(roomId: number): Set<string> {
        let set = this.specialExitLocks.get(roomId);
        if (!set) {
            set = new Set();
            const room = this.rooms.get(roomId);
            for (const [cmd, dest] of Object.entries(room?.mSpecialExits ?? {})) {
                if ((room?.mSpecialExitLocks ?? []).includes(dest)) set.add(cmd);
            }
            this.specialExitLocks.set(roomId, set);
        }
        return set;
    }

    /** Rebuild a room's destination-keyed `mSpecialExitLocks` from the
     *  authoritative per-command set. */
    private syncSpecialExitLockMirror(roomId: number): void {
        const room = this.rooms.get(roomId);
        if (!room) return;
        const dests = new Set<number>();
        for (const cmd of this.specialExitLocks.get(roomId) ?? []) {
            const dest = room.mSpecialExits[cmd];
            if (dest !== undefined) dests.add(dest);
        }
        room.mSpecialExitLocks = [...dests];
    }

    /**
     * Mudlet `hasSpecialExitLock(fromRoomID, toRoomID, command)` — whether the
     * special exit is locked. As with `lockSpecialExit`, the `toRoomID` argument
     * is ignored and the lock is resolved via the command's destination room.
     * Returns the boolean lock state, or an error string (room missing / no such
     * command) the binding turns into `(false, errMsg)`.
     */
    hasSpecialExitLock(fromId: number, command: string): boolean | string {
        const room = this.rooms.get(fromId);
        if (!room) return `hasSpecialExitLock: roomID ${fromId} does not exist`;
        if (!Object.prototype.hasOwnProperty.call(room.mSpecialExits, command)) {
            return `hasSpecialExitLock: the special exit name/command '${command}' does not exist in roomID ${fromId}`;
        }
        return this.isSpecialExitLocked(fromId, command);
    }

    /** Whether one special-exit COMMAND is locked. */
    isSpecialExitLocked(roomId: number, command: string): boolean {
        return this.lockedSpecialCommands(roomId).has(command);
    }

    /**
     * Mudlet `getAllRoomEntrances(roomID)` — every room that has an exit (stock
     * or special) leading into this room, as a sorted, de-duplicated id list.
     * Returns `undefined` when the room doesn't exist.
     */
    getAllRoomEntrances(id: number): number[] | undefined {
        if (!this.rooms.has(id)) return undefined;
        const entrances = new Set<number>();
        for (const [otherId, r] of this.rooms) {
            if (otherId === id) continue;
            let found = false;
            for (const field of Object.values(DIR_FIELD)) {
                if ((r as unknown as Record<string, number>)[field] === id) { found = true; break; }
            }
            if (!found) {
                for (const dest of Object.values(r.mSpecialExits)) {
                    if (dest === id) { found = true; break; }
                }
            }
            if (found) entrances.add(otherId);
        }
        return [...entrances].sort((a, b) => a - b);
    }

    /**
     * Mudlet `connectExitStub(fromID, direction)` / `(fromID, toID[, direction])`
     * — hook up an existing exit stub to another room, wiring the reverse stub
     * back too. Dispatches the three Mudlet call forms:
     *   • explicit `(fromID, toID, direction)` — connect the stub in `direction`.
     *   • direction only — find the nearest in-area room sitting in that
     *     direction that has a matching reverse stub.
     *   • toID only — connect when exactly one pair of reverse stubs exists.
     * A bare numeric second argument is resolved to a direction or a toID by
     * checking what actually exists (a stub in that direction vs. a room with
     * that id); genuinely ambiguous cases return an error asking for a string
     * direction. Returns true on success or an error string.
     */
    connectExitStub(fromId: number, arg2: number | string, arg3?: number | string): true | string {
        const from = this.rooms.get(fromId);
        if (!from) return `connectExitStub: fromID (${fromId}) does not exist`;

        if (arg3 !== undefined) {
            const dir = parseDirection(arg3);
            if (dir == null) return `connectExitStub: argument '${arg3}' cannot be parsed as a valid direction`;
            return this.connectStubByDirAndTo(fromId, dir, Number(arg2));
        }

        // A string second argument is always a direction name (the binding has
        // already coerced numeric-string captures to numbers).
        if (typeof arg2 === 'string') {
            const dir = parseDirection(arg2);
            if (dir == null) return `connectExitStub: argument '${arg2}' cannot be parsed as a valid direction`;
            return this.connectStubByDir(fromId, dir);
        }

        const value = Number(arg2);
        if (!Number.isFinite(value)) {
            return `connectExitStub: argument '${String(arg2)}' cannot be parsed as a toID or direction`;
        }
        // Mudlet treats a bare numeric 2..11 as a toID; only 1, 12, and out-of-range
        // values (which collide with the DIR_NORTH / DIR_OUT codes) are resolved
        // against what exists — a stub in that direction vs. a room with that id.
        if (value >= 2 && value <= 11) {
            return this.connectStubByTo(fromId, value);
        }
        const asDir = parseDirection(value);
        const isStubDir = asDir != null && from.stubs.includes(asDir);
        const isRoomId = this.rooms.has(value);
        if (isRoomId) {
            if (isStubDir) {
                return `connectExitStub: ${value} is ambiguous (both a stub direction and a roomID); pass the direction as a string`;
            }
            return this.connectStubByTo(fromId, value);
        }
        if (isStubDir) return this.connectStubByDir(fromId, asDir!);
        return `connectExitStub: ${value} is not valid as a toID nor a direction with a stub on roomID ${fromId}`;
    }

    /** connectExitStub direction-only form (Mudlet connectExitStubByDirection). */
    private connectStubByDir(fromId: number, dir: number): true | string {
        const from = this.rooms.get(fromId)!;
        const uv = UNIT_VECTORS[dir];
        if (!uv) return `connectExitStub: direction ${dir} has no spatial component (in/out can't be auto-resolved)`;
        if (!from.stubs.includes(dir)) return `connectExitStub: fromID (${fromId}) has no exit stub in the given direction`;
        const reverse = REVERSE_DIR[dir];
        const area = this.areas.get(from.area);
        if (!area) return `connectExitStub: fromID (${fromId}) room does not have an area`;
        const [ux, uy, uz] = uv;
        let minDistance = -1;
        let minRoom = 0;
        for (const toId of area.rooms) {
            if (toId === fromId) continue;
            const to = this.rooms.get(toId);
            if (!to || !to.stubs.includes(reverse)) continue;
            let dx = 0, dy = 0, dz = 0;
            if (uz) { dz = to.z - from.z; if (!sameSign(dz, uz) || dz === 0) continue; }
            else if (to.z !== from.z) continue;
            if (ux) { dx = to.x - from.x; if (!sameSign(dx, ux) || dx === 0) continue; }
            else if (to.x !== from.x) continue;
            // Y is screen-flipped relative to the unit vector, so the matching
            // room sits in the OPPOSITE y sign (Mudlet does the same).
            if (uy) { dy = to.y - from.y; if (sameSign(dy, uy) || dy === 0) continue; }
            else if (to.y !== from.y) continue;
            const msd = dx * dx + dy * dy + dz * dz;
            if (minDistance === -1 || msd < minDistance) { minRoom = toId; minDistance = msd; }
        }
        if (!minRoom) return `connectExitStub: fromID (${fromId}) has no room in that direction with a matching reverse stub in its area`;
        this.setExit(fromId, minRoom, dir);
        this.setExit(minRoom, fromId, reverse);
        return true;
    }

    /** connectExitStub toID-only form (Mudlet connectExitStubByToId). */
    private connectStubByTo(fromId: number, toId: number): true | string {
        const from = this.rooms.get(fromId)!;
        if (toId === fromId) return `connectExitStub: fromID and toID are the same (${fromId})`;
        const to = this.rooms.get(toId);
        if (!to) return `connectExitStub: toID (${toId}) does not exist`;
        if (from.stubs.length === 0) return `connectExitStub: fromID (${fromId}) has no stub exits`;
        if (to.stubs.length === 0) return `connectExitStub: toID (${toId}) has no stub exits`;
        const toReverse = new Set(to.stubs.map(d => REVERSE_DIR[d]).filter((d): d is number => d != null));
        const usable = [...new Set(from.stubs)].filter(d => toReverse.has(d));
        if (usable.length === 0) return `connectExitStub: no pairs of reverse stubs found between rooms ${fromId} and ${toId}`;
        if (usable.length > 1) return `connectExitStub: multiple pairs of reverse stubs between rooms ${fromId} and ${toId}; use the three-argument form with a direction`;
        const dir = usable[0];
        this.setExit(fromId, toId, dir);
        this.setExit(toId, fromId, REVERSE_DIR[dir]);
        return true;
    }

    /** connectExitStub explicit form (Mudlet connectExitStubByDirectionAndToId). */
    private connectStubByDirAndTo(fromId: number, dir: number, toId: number): true | string {
        const from = this.rooms.get(fromId)!;
        if (toId === fromId) return `connectExitStub: fromID and toID are the same (${fromId})`;
        if (!from.stubs.includes(dir)) return `connectExitStub: fromID (${fromId}) has no exit stub in the given direction`;
        const to = this.rooms.get(toId);
        if (!to) return `connectExitStub: toID (${toId}) does not exist`;
        const reverse = REVERSE_DIR[dir];
        if (!to.stubs.includes(reverse)) return `connectExitStub: toID (${toId}) has no exit stub in the reverse direction`;
        this.setExit(fromId, toId, dir);
        this.setExit(toId, fromId, reverse);
        return true;
    }

    // ── Custom exit lines ─────────────────────────────────────────────────────

    /**
     * Mudlet `getCustomLines(roomID)` — per-direction custom exit lines drawn
     * on the map. Returns `undefined` when the room doesn't exist so the Lua
     * wrapper can hand back `nil`; otherwise a `{ dir = { attributes, points } }`
     * table (empty when the room has no custom lines). Points carry the room's
     * Z because Mudlet stores only X/Y per point and uses the owning room's Z
     * for rendering.
     */
    getCustomLines(id: number): Record<string, {
        attributes: { color: { r: number; g: number; b: number }; style: string; arrow: boolean };
        points: Array<{ x: number; y: number; z: number }>;
    }> | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        const out: Record<string, {
            attributes: { color: { r: number; g: number; b: number }; style: string; arrow: boolean };
            points: Array<{ x: number; y: number; z: number }>;
        }> = {};
        for (const key of Object.keys(room.customLines ?? {})) {
            const color = room.customLinesColor?.[key];
            const styleNum = room.customLinesStyle?.[key] ?? 1;
            out[key] = {
                attributes: {
                    color: color ? { r: color.r, g: color.g, b: color.b } : { r: 255, g: 255, b: 255 },
                    style: PEN_STYLE_NAMES[styleNum] ?? 'solid line',
                    arrow: !!room.customLinesArrow?.[key],
                },
                points: (room.customLines[key] ?? []).map(([x, y]) => ({ x, y, z: room.z })),
            };
        }
        return out;
    }

    /**
     * Mudlet `removeCustomLine(roomID, direction)` — drop the custom exit line
     * for a direction (stock direction number/name or a special-exit command).
     * The key form stored varies by map source, so we try the raw command, the
     * canonical long name and the short name. Returns true when a line was
     * removed, false when the room or the line doesn't exist.
     */
    removeCustomLine(id: number, dir: number | string): boolean {
        const room = this.rooms.get(id);
        if (!room) return false;
        const candidates: string[] = [];
        if (typeof dir === 'string') candidates.push(dir);
        const dirInt = parseDirection(dir);
        if (dirInt != null) { candidates.push(DIR_FIELD[dirInt], DIR_SHORT[dirInt]); }
        const key = candidates.find(k => k != null && Object.prototype.hasOwnProperty.call(room.customLines, k));
        if (key == null) return false;
        delete room.customLines[key];
        delete room.customLinesColor[key];
        delete room.customLinesStyle[key];
        delete room.customLinesArrow[key];
        this.notify();
        return true;
    }

    /**
     * Mudlet `addCustomLine(roomID, id_to, direction, style, color, arrow)`.
     * `target` is either a destination room id (line drawn to that room's
     * position, which must be in the same area) or an explicit list of
     * `[x, y, z]` points. `style` is one of Mudlet's pen-style names
     * ("solid line", "dot line", "dash line", "dash dot line",
     * "dash dot dot line"). Returns false when the room/target is invalid, the
     * areas differ, no points are supplied, or the style name is unknown.
     */
    addCustomLine(
        id: number,
        target: number | Array<[number, number, number]>,
        direction: number | string,
        style: string,
        color: { r: number; g: number; b: number },
        arrow: boolean,
    ): string | null {
        const room = this.rooms.get(id);
        if (!room) return `number ${id} is not a valid roomID`;

        let points: Array<[number, number]>;
        if (typeof target === 'number') {
            const to = this.rooms.get(target);
            if (!to) return `number ${target} is not a valid target roomID`;
            if (to.area !== room.area) {
                return `target room is in area ID ${to.area}, which is not the one (ID: ${room.area})`
                    + ' in which this custom line is to be drawn';
            }
            points = [[to.x, to.y]];
        } else {
            if (!Array.isArray(target) || target.length === 0) {
                return 'the coordinate list is empty, at least one {x, y, z} point is needed';
            }
            // Mudlet's #5272 crash guard: an entry like `{}` carries no
            // coordinates and must be rejected rather than stored as NaN.
            if (target.some(p => !Number.isFinite(Number(p?.[0])) || !Number.isFinite(Number(p?.[1])))) {
                return 'every coordinate must be a {x, y, z} triple of numbers';
            }
            points = target.map(p => [Number(p[0]), Number(p[1])] as [number, number]);
        }

        for (const [channel, value] of [['red', color.r], ['green', color.g], ['blue', color.b]] as const) {
            if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 255) {
                return `${channel} value ${value} needs to be between 0-255`;
            }
        }

        const styleNum = Number(
            Object.keys(PEN_STYLE_NAMES).find(k => PEN_STYLE_NAMES[Number(k)] === style),
        );
        if (!styleNum) return `"${style}" is not a valid line style`;

        // Key by the SHORT direction name ("e", "up", …), which is what Mudlet
        // normalises to via dirToString and what its saved maps carry — keying
        // by the long name made getCustomLines unable to read back a line this
        // very function had just written. Anything unrecognised (a special-exit
        // command) is stored verbatim, as Mudlet does.
        const dirInt = parseDirection(direction);
        const key = dirInt != null ? DIR_SHORT[dirInt] : String(direction);
        if (!key) return `"${direction}" is not a direction this room has an exit for`;
        if (!this.hasExitOrSpecialExit(room, dirInt, key)) {
            return `roomID ${id} does not have an exit in a direction that can be identified from "${direction}"`;
        }

        room.customLines[key] = points;
        room.customLinesColor[key] = { spec: 1, alpha: 255, r: color.r, g: color.g, b: color.b };
        room.customLinesStyle[key] = styleNum;
        room.customLinesArrow[key] = arrow;
        this.notify();
        return null;
    }

    /**
     * Whether a room has a stock exit in `dirInt`, or a special exit whose
     * command is `key`. Mirrors Mudlet's TRoom::hasExitOrSpecialExit, which
     * addCustomLine consults before drawing — a custom line is a decoration for
     * an existing exit, not a way to invent one.
     */
    private hasExitOrSpecialExit(room: MudletRoom, dirInt: number | null | undefined, key: string): boolean {
        if (dirInt != null) {
            const field = DIR_FIELD[dirInt];
            const target = field ? (room as unknown as Record<string, number>)[field] : 0;
            if (target && target > 0) return true;
            // A stub counts as an exit for drawing purposes.
            if ((room.stubs ?? []).includes(dirInt)) return true;
            return false;
        }
        return Object.prototype.hasOwnProperty.call(room.mSpecialExits ?? {}, key);
    }

    // ── Doors ─────────────────────────────────────────────────────────────────

    /** Mudlet `getDoors(roomID)` — `{ exitCmd = doorType }`. Undefined for an
     *  unknown room, which the Lua binding reports as `(nil, errMsg)`. */
    getDoors(id: number): Record<string, number> | undefined {
        const room = this.rooms.get(id);
        return room ? { ...room.doors } : undefined;
    }

    /**
     * Mudlet `setDoor(roomID, exitCmd, status)`. exitCmd is either a stock
     * direction — spelled exactly as Mudlet keys its door map ("n"/"ne"/…/
     * "up"/"down"/"in"/"out"), which is also what a saved map carries — or an
     * arbitrary special-exit command string, used as-is.
     *
     * Mudlet refuses a direction the room has no exit *or stub* for, and a
     * status outside 0-3; both are `(nil, errMsg)` returns rather than a bare
     * false, so the failure is reported here as the message string and success
     * as null (same shape as {@link addCustomLine}).
     */
    setDoor(id: number, dir: number | string, val: number): string | null {
        const room = this.rooms.get(id);
        if (!room) return `setDoor: number ${id} is not a valid roomID`;
        const dirInt = parseDirection(dir);
        const key = dirInt != null ? DIR_SHORT[dirInt] : (typeof dir === 'string' ? dir : '');
        if (!key) return `setDoor: "${String(dir)}" is not a valid door command`;
        if (dirInt != null) {
            const target = (room as unknown as Record<string, number>)[DIR_FIELD[dirInt]];
            if (!(target > 0) && !(room.stubs ?? []).includes(dirInt)) {
                return `setDoor: roomID ${id} does not have a normal exit or a stub exit in direction '${key}'`;
            }
        } else if (!Object.prototype.hasOwnProperty.call(room.mSpecialExits ?? {}, key)) {
            return `setDoor: roomID ${id} does not have a special exit in direction '${key}'`;
        }
        if (!Number.isFinite(val) || val < 0 || val > 3) {
            return `setDoor: door type ${val} is not one of 0='none', 1='open', 2='closed' or 3='locked'`;
        }
        if (val <= 0) delete room.doors[key];
        else room.doors[key] = val;
        this.notify();
        return null;
    }

    // ── User data ─────────────────────────────────────────────────────────────

    /**
     * Mudlet `getRoomUserData(id, key)` — returns the stored value, or
     * `undefined` when either the room or the key is missing. The Lua binding
     * differentiates the two cases when the script asks for the full-error
     * shape (`fullErr=true`).
     */
    getRoomUserData(id: number, key: string): string | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        return Object.prototype.hasOwnProperty.call(room.userData, key)
            ? room.userData[key]
            : undefined;
    }

    setRoomUserData(id: number, key: string, value: string): boolean {
        const r = this.rooms.get(id);
        if (!r) return false;
        r.userData[key] = value;
        this.notify();
        return true;
    }

    /**
     * Mudlet `getRoomUserDataKeys(id)` — returns the user-data keys for the
     * room (possibly empty) or `undefined` when the room itself does not
     * exist. The Bridge.lua wrapper converts the JS array to a 1-indexed Lua
     * table and the `undefined` miss to `nil`.
     */
    getRoomUserDataKeys(id: number): string[] | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        return Object.keys(room.userData);
    }

    /**
     * Mudlet `getAllRoomUserData(roomID)` — every key/value pair stored on the
     * room as `{ key = value }`. Returns `undefined` when the room itself does
     * not exist (the Lua binding turns that into Mudlet's `(false, errMsg)`).
     */
    getAllRoomUserData(id: number): Record<string, string> | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        return { ...room.userData };
    }

    /**
     * Mudlet `clearRoomUserData(roomID)` — wipe every user-data entry on the
     * room. Returns `true` when something was cleared, `false` when it was
     * already empty, and `undefined` when the room doesn't exist.
     */
    clearRoomUserData(id: number): boolean | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        if (Object.keys(room.userData).length === 0) return false;
        room.userData = {};
        this.notify();
        return true;
    }

    /**
     * Mudlet `clearRoomUserDataItem(roomID, key)` — drop a single user-data
     * key. Returns `true` when the key existed, `false` when it didn't, and
     * `undefined` when the room doesn't exist.
     */
    clearRoomUserDataItem(id: number, key: string): boolean | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        if (!Object.prototype.hasOwnProperty.call(room.userData, key)) return false;
        delete room.userData[key];
        this.notify();
        return true;
    }

    /**
     * Mudlet `resetRoomArea(roomID)` — move the room back to the default "void"
     * area (-1). Returns `true` on success, `undefined` when the room doesn't
     * exist (Lua → `(nil, errMsg)`). Doesn't go through {@link setRoomArea},
     * which refuses an areaID below 1 — resetRoomArea is Mudlet's documented
     * way to reach the default area.
     */
    resetRoomArea(id: number): boolean | undefined {
        const room = this.rooms.get(id);
        if (!room) return undefined;
        const oldArea = this.areas.get(room.area);
        if (oldArea) {
            oldArea.rooms = oldArea.rooms.filter(r => r !== id);
            this.updateAreaBounds(room.area);
        }
        // Mudlet's TRoom::setArea(-1) also files the room under the default
        // area's own room list (creating the TArea when it is missing). That
        // list is what the renderer and every area-scoped query read, so a room
        // reachable only through `room.area` would vanish off the map.
        let target = this.areas.get(-1);
        if (!target) {
            target = makeArea();
            this.areas.set(-1, target);
            if (!this.areaNames.has(-1)) this.areaNames.set(-1, 'Default Area');
        }
        room.area = -1;
        if (!target.rooms.includes(id)) target.rooms.push(id);
        this.updateAreaBounds(-1);
        this.notify();
        return true;
    }

    // ── Map-level user data ───────────────────────────────────────────────────
    // Mudlet getMapUserData/setMapUserData/clearMapUserData operate on the
    // map's mUserData dict. Loaded binary maps populate this via
    // loadMapUserData(); scripts use it as free-form key/value storage that
    // survives serialization back to .dat.

    /**
     * Mudlet `getMapUserData(key)` — returns the stored value, or `undefined`
     * when the key has never been set. The Lua binding turns the missing case
     * into Mudlet's `(false, errMsg)` 2-tuple.
     */
    getMapUserData(key: string): string | undefined {
        return Object.prototype.hasOwnProperty.call(this.mapUserData, key)
            ? this.mapUserData[key]
            : undefined;
    }

    setMapUserData(key: string, value: string): void {
        this.mapUserData[key] = value;
        this.notify();
    }

    /**
     * Mudlet `clearMapUserData()` (no args) wipes the entire map-level user
     * data dict — used by scripts that want a clean slate when re-importing
     * data. The single-key form is exposed under `clearMapUserDataItem` to
     * match Mudlet's split.
     */
    clearMapUserData(): boolean {
        if (Object.keys(this.mapUserData).length === 0) return false;
        this.mapUserData = {};
        this.notify();
        return true;
    }

    clearMapUserDataItem(key: string): boolean {
        if (!(key in this.mapUserData)) return false;
        delete this.mapUserData[key];
        this.notify();
        return true;
    }

    getAllMapUserData(): Record<string, string> {
        return { ...this.mapUserData };
    }

    /** Replace the entire map-level user-data dict (e.g. after loading a .dat). */
    loadMapUserData(data: Record<string, string> | undefined | null): void {
        this.mapUserData = data ? { ...data } : {};
        this.notify();
    }

    // ── Areas ─────────────────────────────────────────────────────────────────

    /**
     * Mudlet `addAreaName(name)` returns a numeric area ID on success or
     * `(false, errMsg)` when the name is empty or already in use.
     */
    addAreaName(rawName: string): number | { ok: false; err: string } {
        // Mudlet trims the name before validating and stores the trimmed form.
        const name = typeof rawName === 'string' ? rawName.trim() : '';
        if (name.length === 0) {
            return { ok: false, err: 'addAreaName: area names may not be empty strings (and spaces are trimmed from the ends)' };
        }
        for (const [aid, n] of this.areaNames) {
            if (n === name) {
                return { ok: false, err: `addAreaName: area names may not be duplicated and areaID ${aid} already has the name '${name}'` };
            }
        }
        const id = this.nextAreaId++;
        this.areas.set(id, makeArea());
        this.areaNames.set(id, name);
        this.notify();
        return id;
    }

    /**
     * Mudlet `deleteArea(areaID|areaName)` — deletes the area record and the
     * rooms it contained. The default area cannot be deleted and an areaID
     * below 1 names it, so every refusal (unknown id/name, empty name, the
     * default area) is a `(nil, errMsg)` return there: the message is handed
     * back here and null means success (see {@link setDoor}).
     */
    deleteArea(idOrName: number | string): string | null {
        let id: number;
        if (typeof idOrName === 'string' && !/^-?\d+$/.test(idOrName.trim())) {
            if (idOrName.length === 0) return 'deleteArea: an empty string is not a valid area name';
            const resolved = this.resolveAreaId(idOrName);
            if (resolved == null) return `deleteArea: string '${idOrName}' is not a valid area name`;
            // Reached by name, the default area is still off limits.
            if (resolved < 1) return "deleteArea: you can't delete the default area";
            id = resolved;
        } else {
            id = Number(idOrName);
            if (!Number.isFinite(id) || id < 1) {
                // Area 0/-1 is the default area, which Mudlet refuses to delete.
                return `deleteArea: number ${idOrName} is not a valid areaID greater than zero`;
            }
            if (!this.areaNames.has(id)) return `deleteArea: number ${id} is not a valid areaID`;
        }
        const area = this.areas.get(id);
        if (!area) return `deleteArea: number ${id} is not a valid areaID`;
        for (const roomId of area.rooms) {
            const r = this.rooms.get(roomId);
            if (r?.hash) this.hashToRoom.delete(r.hash);
            this.rooms.delete(roomId);
        }
        this.areas.delete(id);
        this.areaNames.delete(id);
        this.notify();
        return null;
    }

    getAreaTable(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [id, name] of this.areaNames) out[name] = id;
        return out;
    }

    /**
     * Mudlet `getAreaTableSwap()` — the inverse of {@link getAreaTable}: every
     * area keyed by id → name (`{ [areaID] = name }`). The Lua wrapper re-keys
     * the wasmoon-stringified ids back to integers.
     */
    getAreaTableSwap(): Record<number, string> {
        const out: Record<number, string> = {};
        for (const [id, name] of this.areaNames) out[id] = name;
        return out;
    }

    /** True when an area with this id exists. */
    hasArea(id: number): boolean { return this.areas.has(id); }

    // Mudlet keeps the 2D zoom on the area itself (TArea::mLast2DMapZoom,
    // reached through TRoomDB::get2DMapZoom) rather than on the widget, so
    // getMapZoom/setMapZoom answer even with no mapper mounted and each area
    // remembers its own. mudix already stores it per area — see
    // {@link getAreaZoom} / {@link setAreaZoom} further down, which persist it
    // into the area's userData so it round-trips with the map file.
    /** Mudlet's T2DMap::csmDefaultXYZoom / csmMinXYZoom. */
    static readonly DEFAULT_MAP_ZOOM = 20;
    static readonly MIN_MAP_ZOOM = 3;

    // ── Area user data ────────────────────────────────────────────────────────
    // Mudlet getAreaUserData/setAreaUserData/getAllAreaUserData/clearAreaUserData
    // operate on the per-area userData dict (MudletArea.userData), which loaded
    // binary maps populate and which serializes back out via toMudletMap().

    /**
     * Mudlet `getAreaUserData(areaID, key)` — the stored value, or `undefined`
     * when the key is absent. Area existence is checked by the binding via
     * {@link hasArea} so it can distinguish the two miss cases.
     */
    getAreaUserData(id: number, key: string): string | undefined {
        const area = this.areas.get(id);
        if (!area) return undefined;
        return Object.prototype.hasOwnProperty.call(area.userData, key)
            ? area.userData[key]
            : undefined;
    }

    /**
     * Mudlet `setAreaUserData(areaID, key, value)` — store a string value on
     * the area. Returns `false` when the area doesn't exist.
     */
    setAreaUserData(id: number, key: string, value: string): boolean {
        const area = this.areas.get(id);
        if (!area) return false;
        area.userData[key] = value;
        this.notify();
        return true;
    }

    /**
     * Mudlet `getAllAreaUserData(areaID)` — every key/value pair on the area.
     * Returns `undefined` when the area doesn't exist.
     */
    getAllAreaUserData(id: number): Record<string, string> | undefined {
        const area = this.areas.get(id);
        if (!area) return undefined;
        return { ...area.userData };
    }

    /**
     * Mudlet `clearAreaUserData(areaID)` — wipe every entry. Returns `true`
     * when something was cleared, `false` when already empty, `undefined` when
     * the area doesn't exist.
     */
    clearAreaUserData(id: number): boolean | undefined {
        const area = this.areas.get(id);
        if (!area) return undefined;
        if (Object.keys(area.userData).length === 0) return false;
        area.userData = {};
        this.notify();
        return true;
    }

    /**
     * Mudlet `clearAreaUserDataItem(areaID, key)` — drop a single key. Returns
     * `true` when it existed, `false` when it didn't, `undefined` when the area
     * doesn't exist.
     */
    clearAreaUserDataItem(id: number, key: string): boolean | undefined {
        const area = this.areas.get(id);
        if (!area) return undefined;
        if (!Object.prototype.hasOwnProperty.call(area.userData, key)) return false;
        delete area.userData[key];
        this.notify();
        return true;
    }

    /**
     * Mudlet `searchAreaUserData([key[, value]])` — the area-level analogue of
     * {@link searchRoomUserData}: no args → all keys; key only → all distinct
     * values for that key; key + value → sorted area ids where key equals value.
     */
    searchAreaUserData(key?: string, value?: string): string[] | number[] {
        if (key == null) {
            const keys = new Set<string>();
            for (const a of this.areas.values()) for (const k of Object.keys(a.userData)) keys.add(k);
            return [...keys].sort();
        }
        if (value == null) {
            const values = new Set<string>();
            for (const a of this.areas.values()) {
                if (Object.prototype.hasOwnProperty.call(a.userData, key)) values.add(a.userData[key]);
            }
            return [...values].sort();
        }
        const ids: number[] = [];
        for (const [id, a] of this.areas) {
            if (a.userData[key] === value) ids.push(id);
        }
        return ids.sort((x, y) => x - y);
    }

    // ── Area view (zoom) ───────────────────────────────────────────────────────

    /**
     * Per-area 2D-map zoom stored in the map file (area userData under
     * {@link AREA_ZOOM_KEY}), in Mudlet units. Returns `undefined` when the area
     * is missing or has no usable saved zoom, in which case the caller opens at
     * {@link DEFAULT_MAP_ZOOM}. Mirrors Mudlet's treatment of zoom as map data
     * rather than client config.
     *
     * A value below {@link MIN_MAP_ZOOM} is treated as absent, exactly as
     * TMap::restore does with the same key — it can only come from a corrupt or
     * foreign write, and honouring it would open the area zoomed in past the
     * limit the wheel itself enforces.
     */
    getAreaZoom(id: number): number | undefined {
        const raw = this.areas.get(id)?.userData[AREA_ZOOM_KEY];
        if (raw == null) return undefined;
        const z = Number(raw);
        return Number.isFinite(z) && z >= MapStore.MIN_MAP_ZOOM ? z : undefined;
    }

    /**
     * Save the per-area zoom into the area's userData so it round-trips with the
     * map file. Deliberately does NOT call {@link notify} — zoom is a view-only
     * datum that no renderer reads from the store snapshot, and the camera-move
     * handler calls this on every wheel tick; notifying would rebuild the whole
     * scene on each one. The value persists to IndexedDB the next time the map is
     * serialised (saveMap → toMudletMapForSave). Returns false when the area is
     * missing or the zoom is below {@link MIN_MAP_ZOOM} — TArea::set2DMapZoom
     * silently ignores those too, and the floor is what stops a bad reading (a
     * fit computed against a not-yet-laid-out 0×0 panel, say) from being written
     * out and then restored on every subsequent open.
     */
    setAreaZoom(id: number, zoom: number): boolean {
        const area = this.areas.get(id);
        if (!area || !Number.isFinite(zoom) || zoom < MapStore.MIN_MAP_ZOOM) return false;
        area.userData[AREA_ZOOM_KEY] = String(zoom);
        return true;
    }

    // ── Grid mode ───────────────────────────────────────────────────────────--

    /**
     * Mudlet `getGridMode(areaID)` — whether the area is drawn on a fixed grid
     * (rooms snapped to integer coordinates, no custom exit lines). Returns
     * `undefined` when the area doesn't exist.
     */
    getGridMode(id: number): boolean | undefined {
        const area = this.areas.get(id);
        if (!area) return undefined;
        return area.gridMode;
    }

    /**
     * Mudlet `setGridMode(areaID, true/false)` — toggle the area's grid layout.
     * Returns `false` when the area doesn't exist.
     */
    setGridMode(id: number, gridMode: boolean): boolean {
        const area = this.areas.get(id);
        if (!area) return false;
        area.gridMode = gridMode;
        this.notify();
        return true;
    }

    /**
     * Mudlet `getRoomAreaName(areaID|areaName)` — bidirectional. Given an ID
     * returns the name; given a name returns the ID. Returns undefined when
     * the input cannot be resolved.
     */
    getRoomAreaName(idOrName: number | string): string | number | undefined {
        if (typeof idOrName === 'number') {
            return this.areaNames.get(idOrName);
        }
        if (typeof idOrName === 'string') {
            for (const [aid, name] of this.areaNames) if (name === idOrName) return aid;
            return undefined;
        }
        return undefined;
    }

    /**
     * Mudlet `setAreaName(areaID|areaName, newName) → true | false, errMsg`.
     * Rejects empty new names and names that conflict with another area.
     */
    setAreaName(idOrName: number | string, newName: string): boolean | { ok: false; err: string } {
        if (typeof newName !== 'string' || newName.length === 0) {
            return { ok: false, err: 'setAreaName: new area name must be a non-empty string' };
        }
        const id = this.resolveAreaId(idOrName);
        if (id == null || !this.areaNames.has(id)) {
            return { ok: false, err: 'setAreaName: area not found' };
        }
        for (const [aid, n] of this.areaNames) {
            if (aid !== id && n === newName) {
                return { ok: false, err: `setAreaName: an area called "${newName}" already exists` };
            }
        }
        this.areaNames.set(id, newName);
        this.notify();
        return true;
    }

    /** Mudlet `getAreaRooms(areaID)` — the area's room ids, or undefined for an
     *  unknown area (Mudlet pushes nil, with no message). */
    getAreaRooms(areaId: number): number[] | undefined {
        const area = this.areas.get(areaId);
        return area ? [...area.rooms] : undefined;
    }

    /**
     * Mudlet `getCollisionLocationsInArea(areaID)` — the (x, y, z) coordinates
     * in an area occupied by more than one room, which render on top of each
     * other on the 2D map. Mirrors TArea::getCollisionNodes (TArea.cpp).
     * Returns null for an unknown area so the Lua wrapper can produce Mudlet's
     * (nil, errMsg) pair; an area with no overlaps yields an empty list.
     */
    getCollisionLocationsInArea(areaId: number): Array<[number, number, number]> | null {
        const area = this.areas.get(areaId);
        if (!area) return null;
        const seen = new Set<string>();
        const collisions: Array<[number, number, number]> = [];
        for (const roomId of area.rooms ?? []) {
            const room = this.rooms.get(roomId);
            if (!room) continue;
            const key = `${room.x},${room.y},${room.z}`;
            if (seen.has(key)) {
                // Only report each shared coordinate once, however many rooms
                // pile up on it.
                if (!collisions.some(([x, y, z]) => x === room.x && y === room.y && z === room.z)) {
                    collisions.push([room.x, room.y, room.z]);
                }
            } else {
                seen.add(key);
            }
        }
        return collisions;
    }

    /**
     * Room to center the 2D view on when an area is opened with no player room
     * in it, mirroring Mudlet's T2DMap::switchArea (T2DMap.cpp). Mudlet does NOT
     * center on the bounding-box midpoint (which can land on empty space for
     * sparse / L-shaped areas) — it:
     *   1. picks a z-level: `preferredZ` if the area has rooms there, otherwise
     *      the level carrying the most rooms (lowest z wins ties),
     *   2. takes the geometric centroid (mean x/y) of that level's rooms,
     *   3. returns the room nearest that centroid.
     * So the view always lands on an actual room. null when the area has no
     * rooms (Mudlet falls back to 0,0,0 in that case).
     */
    getAreaCenterRoomId(areaId: number, preferredZ?: number): number | null {
        const area = this.areas.get(areaId);
        if (!area || area.rooms.length === 0) return null;

        // Bucket the area's rooms by z-level.
        const byLevel = new Map<number, number[]>();
        for (const rid of area.rooms) {
            const r = this.rooms.get(rid);
            if (!r) continue;
            const bucket = byLevel.get(r.z);
            if (bucket) bucket.push(rid); else byLevel.set(r.z, [rid]);
        }
        if (byLevel.size === 0) return null;

        // Choose the level: the requested one if it has rooms, else the most
        // populated (lowest z on a tie — Mudlet's "lowest level with the highest
        // number of rooms").
        let level: number;
        if (preferredZ != null && byLevel.has(preferredZ)) {
            level = preferredZ;
        } else {
            level = [...byLevel.keys()][0];
            for (const [z, ids] of byLevel) {
                const best = byLevel.get(level)!.length;
                if (ids.length > best || (ids.length === best && z < level)) level = z;
            }
        }

        const ids = byLevel.get(level)!;
        // Centroid of the level's rooms.
        let meanX = 0, meanY = 0, n = 0;
        for (const rid of ids) {
            const r = this.rooms.get(rid)!;
            n++;
            meanX += (r.x - meanX) / n;
            meanY += (r.y - meanY) / n;
        }
        // Nearest room to the centroid.
        let bestId: number | null = null;
        let bestDist = Infinity;
        for (const rid of ids) {
            const r = this.rooms.get(rid)!;
            const dx = r.x - meanX, dy = r.y - meanY;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestId = rid; }
        }
        return bestId;
    }

    /**
     * Mudlet `getAreaExits(areaID[, fullData])` — exits crossing out of the area.
     * Without full data, a sorted list of the area's rooms that have any exit to
     * another area. With full data, `{ [fromRoomID] = { [exitName] = toRoomID } }`,
     * where `exitName` is the long direction name for stock exits or the verbatim
     * command for special exits. Returns `undefined` when the area is unknown.
     */
    getAreaExits(areaId: number, fullData = false): number[] | Record<number, Record<string, number>> | undefined {
        const area = this.areas.get(areaId);
        if (!area) return undefined;
        const full: Record<number, Record<string, number>> = {};
        const fromIds = new Set<number>();
        for (const rid of area.rooms) {
            const r = this.rooms.get(rid);
            if (!r) continue;
            const exits: Record<string, number> = {};
            for (const [dirNum, field] of Object.entries(DIR_FIELD)) {
                const dest = (r as unknown as Record<string, number>)[field];
                if (dest >= 0 && this.rooms.get(dest) && this.rooms.get(dest)!.area !== areaId) {
                    exits[DIR_FIELD[Number(dirNum)]] = dest;
                }
            }
            for (const [cmd, dest] of Object.entries(r.mSpecialExits)) {
                const destRoom = this.rooms.get(dest);
                if (destRoom && destRoom.area !== areaId) exits[cmd] = dest;
            }
            if (Object.keys(exits).length > 0) { fromIds.add(rid); full[rid] = exits; }
        }
        if (fullData) return full;
        return [...fromIds].sort((a, b) => a - b);
    }

    getRooms(): Record<number, string> {
        const out: Record<number, string> = {};
        for (const [id, r] of this.rooms) out[id] = r.name;
        return out;
    }

    /**
     * Mudlet `getMapLabels(areaID)` — returns `{ [labelID] = labelText }` for
     * every label in the area, or an empty object if the area has none / is
     * unknown. Each `MudletLabel.id` is the QMap key Mudlet uses internally,
     * which is also what `deleteMapLabel` expects.
     */
    getMapLabels(areaId: number): Record<number, string> {
        const out: Record<number, string> = {};
        for (const l of this.labels.get(areaId) ?? []) out[l.id] = l.text;
        return out;
    }

    /**
     * Mudlet `getMapLabel(areaID, labelID|labelText)`:
     *  - by ID (number): single flat properties record, or "noid" sentinel if the
     *    area has labels but not that ID
     *  - by text (string): `{[labelID]: properties}` for every label whose text
     *    matches exactly (possibly empty)
     *  - if the area has no labels at all: empty `multi: {}` regardless of key form
     *    (matches Mudlet's early-return)
     *  - if the area is missing: "noarea" sentinel
     *
     * Bridge.lua dispatches the sentinels into Mudlet's `(false, errMsg)` shape.
     */
    getMapLabel(areaId: number, key: number | string): MapLabelLookup {
        if (!this.areas.has(areaId)) return { ok: false, err: 'noarea' };
        const labels = this.labels.get(areaId) ?? [];
        if (labels.length === 0) return { ok: true, multi: {} };
        if (typeof key === 'number') {
            const hit = labels.find(l => l.id === key);
            if (!hit) return { ok: false, err: 'noid' };
            return { ok: true, single: labelToInfo(hit) };
        }
        const multi: Record<number, MapLabelInfo> = {};
        for (const l of labels) {
            if (l.text === key) multi[l.id] = labelToInfo(l);
        }
        return { ok: true, multi };
    }

    /** Next free label id within an area — Mudlet keys labels by an integer that
     *  is unique per area and starts at 0. */
    private nextLabelId(areaId: number): number {
        const labels = this.labels.get(areaId);
        if (!labels || labels.length === 0) return 0;
        let max = -1;
        for (const l of labels) if (l.id > max) max = l.id;
        return max + 1;
    }

    /**
     * Mudlet `createMapLabel(areaID, text, posx, posy, posz, fgRed, fgGreen,
     * fgBlue, bgRed, bgGreen, bgBlue [, zoom [, fontSize [, showOnTop [,
     * noScaling]]]])`. Adds a text label to the area and returns its new id, or
     * -1 if the area does not exist. (`zoom`/`fontSize` are accepted for
     * signature parity — mudix stores labels but the renderer does not yet draw
     * them, mirroring how labels loaded from binary maps are kept and queried
     * but not painted.)
     */
    createMapLabel(
        areaId: number, text: string,
        x: number, y: number, z: number,
        fgR: number, fgG: number, fgB: number,
        bgR: number, bgG: number, bgB: number,
        fontSize = 10, showOnTop = true, noScaling = false,
    ): number {
        if (!this.areas.has(areaId)) return -1;
        const id = this.nextLabelId(areaId);
        // The renderer derives a text label's on-map font size from its
        // Width/Height (a 0×0 box paints invisibly), so size the box in map
        // units from the requested point size and text length.
        const str = text ?? '';
        const fs = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 10;
        const fontUnits = Math.min(0.75, Math.max(0.2, fs / 20));
        const width = Math.max(0.5, str.length * fontUnits);
        const height = fontUnits / 0.9;
        const label: MudletLabel = {
            id,
            pos: [x, y, z],
            size: [width, height],
            text: str,
            fgColor: { spec: 1, alpha: 255, r: fgR, g: fgG, b: fgB },
            bgColor: { spec: 1, alpha: 255, r: bgR, g: bgG, b: bgB },
            pixMap: '',
            noScaling,
            showOnTop,
        };
        const arr = this.labels.get(areaId);
        if (arr) arr.push(label);
        else this.labels.set(areaId, [label]);
        this.notify();
        return id;
    }

    /**
     * Mudlet `createMapImageLabel(areaID, imagePathFileName, posx, posy, posz,
     * width, height, zoom [, showOnTop [, noScaling]])`. Adds an image label and
     * returns its new id, or -1 if the area is missing. The image reference is
     * stored verbatim in the label's `pixMap` (surfaced as `Pixmap` by
     * getMapLabel); like text labels it is not yet painted by the renderer.
     */
    createMapImageLabel(
        areaId: number, imagePath: string,
        x: number, y: number, z: number,
        width: number, height: number,
        showOnTop = true, noScaling = false,
    ): number {
        if (!this.areas.has(areaId)) return -1;
        const id = this.nextLabelId(areaId);
        const label: MudletLabel = {
            id,
            pos: [x, y, z],
            size: [width, height],
            text: '',
            fgColor: { spec: 1, alpha: 255, r: 255, g: 255, b: 255 },
            bgColor: { spec: 1, alpha: 0, r: 0, g: 0, b: 0 },
            pixMap: imagePath ?? '',
            noScaling,
            showOnTop,
        };
        const arr = this.labels.get(areaId);
        if (arr) arr.push(label);
        else this.labels.set(areaId, [label]);
        this.notify();
        return id;
    }

    /** Mudlet `deleteMapLabel(areaID, labelID)`. Removes the label; returns
     *  false when the area or label id does not exist. */
    deleteMapLabel(areaId: number, labelId: number): boolean {
        const arr = this.labels.get(areaId);
        if (!arr) return false;
        const idx = arr.findIndex(l => l.id === labelId);
        if (idx < 0) return false;
        arr.splice(idx, 1);
        this.notify();
        return true;
    }

    /**
     * Mudlet `auditAreas()` — sweep the map for area/room consistency problems
     * and repair what is safe to repair. mudix rebuilds every area's membership
     * list (`rooms[]`) from the authoritative `room.area` back-pointers, which
     * drops dangling room ids and re-files rooms that were missing from their
     * area's list. Rooms whose `area` points at a non-existent area are reported
     * but left untouched (they may be intentionally parked in the void area -1).
     * Returns a summary report (Mudlet returns nothing; mudix surfaces the audit
     * so scripts can act on it).
     */
    auditAreas(): {
        checkedAreas: number; checkedRooms: number; fixedAreas: number;
        orphanRooms: number[]; danglingRefs: number[];
    } {
        // Authoritative membership: group room ids by their `area` field.
        const byArea = new Map<number, number[]>();
        const orphanRooms: number[] = [];
        for (const [id, room] of this.rooms) {
            if (!this.areas.has(room.area)) orphanRooms.push(id);
            const list = byArea.get(room.area);
            if (list) list.push(id);
            else byArea.set(room.area, [id]);
        }
        const danglingSet = new Set<number>();
        let fixedAreas = 0;
        for (const [areaId, area] of this.areas) {
            const want = (byArea.get(areaId) ?? []).slice().sort((a, b) => a - b);
            const have = area.rooms;
            for (const rid of have) {
                if (!this.rooms.has(rid)) danglingSet.add(rid);
            }
            const same = have.length === want.length && have.every((v, i) => v === want[i]);
            if (!same) {
                area.rooms = want;
                fixedAreas++;
            }
        }
        if (fixedAreas > 0) this.notify();
        return {
            checkedAreas: this.areas.size,
            checkedRooms: this.rooms.size,
            fixedAreas,
            orphanRooms: orphanRooms.sort((a, b) => a - b),
            danglingRefs: [...danglingSet].sort((a, b) => a - b),
        };
    }

    // ── Map context-menu events (Mudlet addMapEvent) ──────────────────────────

    setMapEventDispatcher(fn: ((eventName: string, args: unknown[]) => void) | null): void {
        this.mapEventDispatcher = fn;
    }

    addMapEvent(
        uniqueName: string,
        eventName: string,
        parent: string | null = null,
        displayName: string | null = null,
        ...args: unknown[]
    ): boolean {
        if (!uniqueName || !eventName) return false;
        this.mapEvents.set(uniqueName, {
            uniqueName,
            eventName,
            parent: parent && parent.length > 0 ? parent : null,
            displayName: displayName && displayName.length > 0 ? displayName : uniqueName,
            args,
        });
        return true;
    }

    removeMapEvent(uniqueName: string): boolean {
        return this.mapEvents.delete(uniqueName);
    }

    getMapEvents(): MapEventEntry[] {
        return [...this.mapEvents.values()];
    }

    // ── Map context-menu submenus (Mudlet addMapMenu) ─────────────────────────

    /** Mudlet `addMapMenu(menuName [, parent [, displayName]])`. Registers a
     *  submenu in the map's right-click context menu that addMapEvent entries
     *  can nest under via their `parent`. Re-registering the same name replaces
     *  the prior entry. */
    addMapMenu(name: string, parent: string | null = null, displayName: string | null = null): boolean {
        if (!name) return false;
        this.mapMenus.set(name, {
            name,
            parent: parent && parent.length > 0 ? parent : null,
            displayName: displayName && displayName.length > 0 ? displayName : name,
        });
        return true;
    }

    removeMapMenu(name: string): boolean {
        const had = this.mapMenus.delete(name);
        // Mudlet removes a menu *and its children* — cascade to any submenus
        // nested under it (recursively, so grandchildren go too).
        for (const [childName, menu] of [...this.mapMenus]) {
            if (menu.parent === name) this.removeMapMenu(childName);
        }
        return had;
    }

    getMapMenus(): MapMenuEntry[] {
        return [...this.mapMenus.values()];
    }

    // ── Per-room border colour / thickness (Mudlet) ───────────────────────────
    // Custom per-room overrides of the map's default room border. Stored in side
    // maps keyed by room id (like roomHighlights); a missing entry means "use the
    // map default". Channel/range validation lives in the Lua bindings. (The
    // binary map renderer doesn't consume these yet — this is the data model the
    // get/set/clear API round-trips on.)
    private roomBorderColors = new Map<number, { r: number; g: number; b: number; a: number }>();
    private roomBorderThicknesses = new Map<number, number>();

    setRoomBorderColor(id: number, r: number, g: number, b: number, a: number): boolean {
        if (!this.rooms.has(id)) return false;
        this.roomBorderColors.set(id, { r, g, b, a });
        return true;
    }
    getRoomBorderColor(id: number): { r: number; g: number; b: number; a: number } | null {
        return this.roomBorderColors.get(id) ?? null;
    }
    clearRoomBorderColor(id: number): boolean {
        return this.roomBorderColors.delete(id);
    }

    setRoomBorderThickness(id: number, thickness: number): boolean {
        if (!this.rooms.has(id)) return false;
        this.roomBorderThicknesses.set(id, thickness);
        return true;
    }
    getRoomBorderThickness(id: number): number | null {
        return this.roomBorderThicknesses.get(id) ?? null;
    }
    clearRoomBorderThickness(id: number): boolean {
        return this.roomBorderThicknesses.delete(id);
    }

    /** Fire the registered event for a context-menu entry. Matches Mudlet's
     *  T2DMap::slot_userAction selection branch: raiseEvent(eventName,
     *  uniqueName, roomId). The right-clicked room stands in for Mudlet's
     *  multi-room selection; the entry's stored extra args are discarded
     *  (Mudlet does the same in this branch). */
    dispatchMapEvent(uniqueName: string, roomId: number): void {
        const entry = this.mapEvents.get(uniqueName);
        if (!entry) return;
        this.mapEventDispatcher?.(entry.eventName, [uniqueName, roomId]);
    }

    // ── Map info contributors (Mudlet registerMapInfo) ────────────────────────

    setMapInfoEvaluator(fn: MapStore['mapInfoEvaluator']): void {
        this.mapInfoEvaluator = fn;
    }

    /** Add or replace a contributor. Re-registering the same label keeps the
     *  current enabled state and returns the prior callbackId so the runtime
     *  can free the leaked Lua-registry slot. Registering over a built-in label
     *  ("Short"/"Full") overrides it with the script callback — Mudlet's
     *  registerMapInfo replaces same-named contributors the same way; the native
     *  evaluator is dropped so the script's version wins. */
    registerMapInfo(label: string, callbackId: number): { prevCallbackId: number | null } {
        const idx = this.mapInfoContributors.findIndex(c => c.label === label);
        let prev: number | null = null;
        if (idx >= 0) {
            prev = this.mapInfoContributors[idx].callbackId;
            this.builtinMapInfo.delete(label);
            this.mapInfoContributors[idx] = { label, callbackId, enabled: this.mapInfoContributors[idx].enabled };
        } else {
            // A label switched on before anything claimed it (showMapInfo, or an
            // enabled contributor that a Lua teardown swept away) starts enabled.
            // Set.delete reports whether it was pending, and consumes it.
            this.mapInfoContributors.push({ label, callbackId, enabled: this.pendingMapInfoEnabled.delete(label) });
        }
        this.notify();
        return { prevCallbackId: prev };
    }

    /** Remove a contributor entirely. Returns the freed callbackId (so the
     *  runtime can release the Lua-registry slot) or null when the label
     *  wasn't registered. Built-in contributors can't be removed (Mudlet's
     *  native "Short"/"Full" are likewise permanent — only enable/disable
     *  applies); the call is a no-op reporting removed:false. */
    killMapInfo(label: string): { callbackId: number | null; removed: boolean } {
        const idx = this.mapInfoContributors.findIndex(c => c.label === label);
        if (idx < 0) return { callbackId: null, removed: false };
        if (this.mapInfoContributors[idx].builtin) return { callbackId: null, removed: false };
        const cb = this.mapInfoContributors[idx].callbackId;
        this.mapInfoContributors.splice(idx, 1);
        // Mudlet's removeContributor drops the name from the enabled set too, so
        // killing a contributor forgets that it was on rather than re-enabling a
        // later registration under the same label.
        this.pendingMapInfoEnabled.delete(label);
        this.notify();
        return { callbackId: cb, removed: true };
    }

    enableMapInfo(label: string): boolean {
        const c = this.mapInfoContributors.find(c => c.label === label);
        if (!c) return false;
        if (c.enabled) return true;
        c.enabled = true;
        this.notify();
        return true;
    }

    disableMapInfo(label: string): boolean {
        const c = this.mapInfoContributors.find(c => c.label === label);
        if (!c) return false;
        if (!c.enabled) return true;
        c.enabled = false;
        this.notify();
        return true;
    }

    /** Mudlet `setConfig("showMapInfo", label)` — switch a map-info overlay on.
     *  Unlike `enableMapInfo`, an unknown label is *not* an error: Mudlet inserts
     *  the name straight into `mMapInfoContributors` without consulting the
     *  registry, so the overlay lights up if and when something registers under
     *  that label. Always succeeds, matching setConfig's unconditional success. */
    showMapInfo(label: string): void {
        if (this.enableMapInfo(label)) return;
        if (this.pendingMapInfoEnabled.has(label)) return;
        this.pendingMapInfoEnabled.add(label);
    }

    /** Mudlet `setConfig("hideMapInfo", label)` — switch a map-info overlay off.
     *  Clears a pending enable as well, so hiding a label that was turned on
     *  before its contributor existed actually cancels it. */
    hideMapInfo(label: string): void {
        this.pendingMapInfoEnabled.delete(label);
        this.disableMapInfo(label);
    }

    /** Snapshot for tests / debug. The panel goes through evaluateMapInfos. */
    getMapInfoContributors(): MapInfoContributor[] {
        return this.mapInfoContributors.map(c => ({ ...c }));
    }

    /** Run every enabled contributor and collect their (text, style, color)
     *  results. Built-in contributors are evaluated natively from MapStore data;
     *  script ones go through the LuaRuntime evaluator (skipped when it's
     *  unhooked). Empty when no enabled contributor returned a non-empty text. */
    evaluateMapInfos(
        roomId: number | null,
        selectionSize: number,
        areaId: number,
        displayedAreaId: number,
    ): MapInfoResult[] {
        if (this.mapInfoContributors.length === 0) return [];
        const evaluator = this.mapInfoEvaluator;
        const out: MapInfoResult[] = [];
        for (const c of this.mapInfoContributors) {
            if (!c.enabled) continue;
            let r: Omit<MapInfoResult, 'label'> | null = null;
            if (c.builtin) {
                const native = this.builtinMapInfo.get(c.label);
                if (native) r = native(roomId, selectionSize, areaId, displayedAreaId);
            } else if (c.callbackId != null && evaluator) {
                r = evaluator(c.callbackId, roomId, selectionSize, areaId, displayedAreaId);
            }
            if (r && r.text) out.push({ label: c.label, ...r });
        }
        return out;
    }

    /** Drop every script-registered contributor. Called on LuaRuntime teardown
     *  — the callback IDs index into the dying runtime's __mudix_cb registry.
     *  Built-in contributors are native (no Lua dependency) so they survive,
     *  keeping the default "Short"/"Full" overlays available across reconnects
     *  and script reloads. */
    clearMapInfoContributors(): void {
        const before = this.mapInfoContributors.length;
        // Mudlet's enabled set is host-level and untouched by script teardown, so
        // a contributor that was on comes back on when the reloaded script
        // re-registers it. Parking the label in the pending set reproduces that.
        for (const c of this.mapInfoContributors) {
            if (!c.builtin && c.enabled) this.pendingMapInfoEnabled.add(c.label);
        }
        this.mapInfoContributors = this.mapInfoContributors.filter(c => c.builtin);
        if (this.mapInfoContributors.length !== before) this.notify();
    }

    // ── Built-in map info contributors (Mudlet's native "Short" / "Full") ─────

    /** Seed the two built-in contributors. Mudlet registers "Short" then "Full"
     *  and enables "Full" by default (XMLimport seeds {"Full"} for a profile
     *  with no saved set); we mirror both the order and the default. */
    private seedBuiltinMapInfo(): void {
        this.builtinMapInfo.set('Short', (roomId, _selectionSize, areaId) =>
            this.shortMapInfo(roomId, areaId));
        this.builtinMapInfo.set('Full', (roomId, selectionSize, areaId, displayedAreaId) =>
            this.fullMapInfo(roomId, selectionSize, areaId, displayedAreaId));
        this.mapInfoContributors.push({ label: 'Short', callbackId: null, enabled: false, builtin: true });
        this.mapInfoContributors.push({ label: 'Full', callbackId: null, enabled: true, builtin: true });
    }

    /** Mudlet's "Short" contributor: `<room name> / <id> (<area name>)`,
     *  collapsing to just `<id> (<area name>)` when the room is unnamed or its
     *  name is exactly its id. Plain (no bold/italic), default colour. */
    private shortMapInfo(roomId: number | null, areaId: number): Omit<MapInfoResult, 'label'> | null {
        if (roomId == null) return null;
        const room = this.rooms.get(roomId);
        if (!room) return null;
        const areaName = this.areaNames.get(areaId) ?? '';
        const idStr = String(roomId);
        const name = room.name ?? '';
        const roomFragment = name && name !== idStr ? `${name} / ${idStr}` : idStr;
        return { text: `${roomFragment} (${areaName})`, isBold: false, isItalic: false };
    }

    /** Mudlet's "Full" contributor: area name/id + extent, optional room name,
     *  and the room id + position line whose suffix and styling depend on the
     *  selection (none → "Current player location"; 1 → "Selected room";
     *  many → "Center of N selected rooms"). Non-breaking spaces (U+00A0) and
     *  hyphens (U+2011) match Mudlet so the lines wrap the same way. Selections
     *  tint the block orange and bold it; with nothing selected the text is
     *  italic when the room's area isn't the one currently displayed, else bold.
     *  Mudlet keys the orange shade off the configured info-text lightness — we
     *  don't surface that, so we use its dark-background variant. */
    private fullMapInfo(
        roomId: number | null,
        selectionSize: number,
        areaId: number,
        displayedAreaId: number,
    ): Omit<MapInfoResult, 'label'> | null {
        if (roomId == null) return null;
        const room = this.rooms.get(roomId);
        if (!room) return null;
        const NBSP = ' '; // non-breaking space (matches Mudlet line-wrap control)
        const NBHY = '‑'; // non-breaking hyphen
        const area = this.areas.get(areaId);
        const areaName = this.areaNames.get(areaId) ?? '';
        const lines: string[] = [];
        if (area) {
            lines.push(
                `Area:${NBSP}${areaName} ID:${NBSP}${areaId} ` +
                `x:${NBSP}${area.min_x}${NBSP}<${NBHY}>${NBSP}${area.max_x} ` +
                `y:${NBSP}${area.min_y}${NBSP}<${NBHY}>${NBSP}${area.max_y} ` +
                `z:${NBSP}${area.min_z}${NBSP}<${NBHY}>${NBSP}${area.max_z}`,
            );
        }
        if (room.name) lines.push(`Room Name: ${room.name}`);

        let isBold = false;
        let isItalic = false;
        let color: { r: number; g: number; b: number } | undefined;
        let desc: string;
        if (selectionSize <= 0) {
            desc = 'Current player location';
            if (areaId !== displayedAreaId) isItalic = true;
            else isBold = true;
        } else {
            desc = selectionSize === 1 ? 'Selected room' : `Center of ${selectionSize} selected rooms`;
            isBold = true;
            color = { r: 255, g: 223, b: 191 }; // Mudlet's "slightly orange white"
        }
        lines.push(
            `Room${NBSP}ID:${NBSP}${roomId} Position${NBSP}on${NBSP}Map: ` +
            `(${room.x},${room.y},${room.z}) ${NBHY}${NBSP}${desc}`,
        );
        return { text: lines.join('\n'), isBold, isItalic, color };
    }

    // ── Custom env colors (Mudlet setCustomEnvColor) ──────────────────────────

    /** Mudlet setCustomEnvColor(envID, r, g, b, a). envID identifies the user
     *  environment used by setRoomEnv; the renderer reads mCustomEnvColors and
     *  paints rooms with that env using these RGB values. spec=1 (RGB) is the
     *  Qt QColor::Rgb spec, matching what the binary reader emits. */
    setCustomEnvColor(envId: number, r: number, g: number, b: number, a = 255): void {
        this.customEnvColors.set(envId, { spec: 1, alpha: a, r, g, b });
        this.notify();
    }

    /**
     * Seed env IDs 257-272 with the profile's 16 mapper colours, mirroring
     * TMap::restore16ColorSet. Mudlet keeps that block permanently present in
     * mCustomEnvColors — `setCustomEnvColor(257, …)` is documented as *also*
     * changing the profile's dark-red, and `getCustomEnvColorTable()[257]`
     * reads back even on a brand-new map — so it is re-applied whenever the
     * map is wiped rather than treated as user data.
     */
    private restore16ColorSet(): void {
        // Qt's colour constants, in TMap::restore16ColorSet's 257→272 order.
        const palette: Array<[number, number, number]> = [
            [128, 0, 0],       // 257 dark red
            [0, 128, 0],       // 258 dark green
            [128, 128, 0],     // 259 dark yellow
            [0, 0, 128],       // 260 dark blue
            [128, 0, 128],     // 261 dark magenta
            [0, 128, 128],     // 262 dark cyan
            [192, 192, 192],   // 263 light gray
            [0, 0, 0],         // 264 black
            [255, 0, 0],       // 265 red
            [0, 255, 0],       // 266 green
            [255, 255, 0],     // 267 yellow
            [0, 0, 255],       // 268 blue
            [255, 0, 255],     // 269 magenta
            [0, 255, 255],     // 270 cyan
            [255, 255, 255],   // 271 white
            [128, 128, 128],   // 272 dark gray
        ];
        palette.forEach(([r, g, b], i) => {
            this.customEnvColors.set(257 + i, { spec: 1, alpha: 255, r, g, b });
        });
    }

    getCustomEnvColor(envId: number): { r: number; g: number; b: number; a: number } | undefined {
        const c = this.customEnvColors.get(envId);
        return c ? { r: c.r, g: c.g, b: c.b, a: c.alpha } : undefined;
    }

    getCustomEnvColorTable(): Record<number, { r: number; g: number; b: number; a: number }> {
        const out: Record<number, { r: number; g: number; b: number; a: number }> = {};
        for (const [id, c] of this.customEnvColors) {
            out[id] = { r: c.r, g: c.g, b: c.b, a: c.alpha };
        }
        return out;
    }

    /** Mudlet removeCustomEnvColor(envID). Drops the override so the renderer
     *  falls back to the built-in env palette. Returns true if an entry was
     *  removed. */
    removeCustomEnvColor(envId: number): boolean {
        if (!this.customEnvColors.has(envId)) return false;
        this.customEnvColors.delete(envId);
        this.notify();
        return true;
    }

    // ── Map mode (Mudlet view/edit toggle, fires mapModeChangeEvent) ──────────
    // Mudlet's 2D map widget supports a "viewing" and "editing" mode. mudix has
    // a single render path right now; the mode is stored here so scripts can
    // toggle it and listen for the change event, even though no chrome wires
    // visible behaviour to the value yet.
    private mapMode: 'viewing' | 'editing' = 'viewing';
    private mapModeListener: ((mode: 'viewing' | 'editing') => void) | null = null;

    setMapModeListener(fn: ((mode: 'viewing' | 'editing') => void) | null): void {
        this.mapModeListener = fn;
    }

    getMapMode(): 'viewing' | 'editing' { return this.mapMode; }

    setMapMode(mode: 'viewing' | 'editing'): boolean {
        if (mode !== 'viewing' && mode !== 'editing') return false;
        if (this.mapMode === mode) return true;
        this.mapMode = mode;
        // The hidden-room lens reports a different isVisible() output for the
        // same room across viewing↔editing (editing shows hidden rooms). Bump
        // the lens version so the renderer rebuilds even when no hidden-set
        // mutation accompanied the mode flip.
        this.hiddenVersion++;
        this.mapModeListener?.(mode);
        this.notify();
        return true;
    }

    // ── Room char colour (Mudlet setRoomCharColor / getRoomCharColor) ─────────
    // The MudletRoom shape from mudlet-map-binary-reader has no charColor field
    // (Mudlet stores it on the C++ TRoom side-by-side with the symbol). Mirror
    // that with a separate Map keyed by room id; the renderer's
    // MudixMapReader can read this back when painting room symbols.
    private roomCharColors = new Map<number, MudletColor>();
    // ── Hidden rooms (Mudlet setRoomHidden / getRoomHidden / getHiddenRooms) ──
    // Mudlet stores `isHidden` on the C++ TRoom; the binary reader's MudletRoom
    // shape doesn't surface it. Mirror with a Set keyed by room id and let the
    // renderer's RoomLens (installed in MapPanel) consult this to skip painting.
    // The dedicated `hiddenVersion` counter is what the lens reports via
    // getVersion() and what MapPanel uses to decide when to force a rebuild —
    // the main `version` counter bumps on every store mutation, which would
    // defeat the renderer's lens-output cache.
    private hiddenRooms = new Set<number>();
    private hiddenVersion = 0;

    setRoomCharColor(id: number, r: number, g: number, b: number, a = 255): boolean {
        if (!this.rooms.has(id)) return false;
        this.roomCharColors.set(id, { spec: 1, alpha: a, r, g, b });
        this.notify();
        return true;
    }

    getRoomCharColor(id: number): { r: number; g: number; b: number; a: number } | undefined {
        const c = this.roomCharColors.get(id);
        return c ? { r: c.r, g: c.g, b: c.b, a: c.alpha } : undefined;
    }

    /**
     * Mudlet `unsetRoomCharColor(roomID)` — drop the per-room char colour
     * override so the renderer falls back to the default text colour. Returns
     * false when the room is missing or had no override to drop (Mudlet's
     * own semantics).
     */
    unsetRoomCharColor(id: number): boolean {
        if (!this.rooms.has(id)) return false;
        if (!this.roomCharColors.delete(id)) return false;
        this.notify();
        return true;
    }

    // ── Hidden rooms ──────────────────────────────────────────────────────────

    /**
     * Mudlet `setRoomHidden(roomID, hidden)`. Toggles the hidden flag; the
     * RoomLens installed on the renderer consults {@link isRoomHidden} when
     * deciding whether to paint a room, so hidden rooms (and exits whose
     * other endpoint is hidden) disappear from the view. Returns false when
     * the room doesn't exist; no-ops without a notify when the state is
     * already the requested one.
     */
    setRoomHidden(id: number, hidden: boolean): boolean {
        if (!this.rooms.has(id)) return false;
        const already = this.hiddenRooms.has(id);
        if (hidden === already) return true;
        if (hidden) this.hiddenRooms.add(id);
        else this.hiddenRooms.delete(id);
        this.hiddenVersion++;
        this.notify();
        return true;
    }

    /**
     * Mudlet `getRoomHidden(roomID)`. Returns the hidden flag (false by
     * default). The Lua binding re-shapes the missing-room case into
     * Mudlet's (false, errMsg) tuple.
     */
    getRoomHidden(id: number): boolean {
        return this.hiddenRooms.has(id);
    }

    /** True iff the room exists in the side-table. Used by the RoomLens. */
    isRoomHidden(id: number): boolean {
        return this.hiddenRooms.has(id);
    }

    /** Monotonic counter bumped only when the hidden-rooms set actually
     *  changes. Surfaced via the RoomLens's getVersion() so the renderer can
     *  cache lens output, and read by MapPanel to decide when a force-refresh
     *  is needed after store mutations that left area/level unchanged. */
    getHiddenVersion(): number { return this.hiddenVersion; }

    /**
     * Mudlet `getHiddenRooms()` — the hidden rooms of the whole map. Mudlet
     * takes no argument at all (TLuaInterpreter::getHiddenRooms walks the
     * entire room map); mudix additionally accepts an areaID to scope the
     * answer, in which case `undefined` distinguishes "no such area" from "no
     * hidden rooms here".
     */
    getHiddenRooms(areaId?: number): number[] | undefined {
        if (areaId === undefined) return [...this.hiddenRooms];
        const area = this.areas.get(areaId);
        if (!area) return undefined;
        const out: number[] = [];
        for (const id of area.rooms) {
            if (this.hiddenRooms.has(id)) out.push(id);
        }
        return out;
    }

    // ── Room highlights (Mudlet highlightRoom / unHighlightRoom) ──────────────

    /**
     * Mudlet highlightRoom(roomID, r1, g1, b1, r2, g2, b2, radius, a1, a2).
     * Painted by MudletHighlightOverlay as a radial gradient: color1 (with
     * a1 alpha) at the center, color2 (with a2 alpha) at the outer edge,
     * with the circle radius = settings.roomSize × `radius`. Returns false
     * if the room does not exist.
     */
    highlightRoom(
        id: number,
        r1: number, g1: number, b1: number,
        r2: number, g2: number, b2: number,
        radius: number,
        a1 = 255, a2 = 255,
    ): boolean {
        if (!this.rooms.has(id)) return false;
        this.roomHighlights.set(id, { r1, g1, b1, r2, g2, b2, a1, a2, radius });
        this.notifyHighlights();
        return true;
    }

    /** Mudlet unHighlightRoom(roomID). Returns false when the room had no highlight. */
    unHighlightRoom(id: number): boolean {
        if (!this.roomHighlights.delete(id)) return false;
        this.notifyHighlights();
        return true;
    }

    /** Snapshot of all active room highlights. MapPanel reads this each store
     *  notify to reconcile the renderer's overlay shapes against the store. */
    getRoomHighlights(): Map<number, RoomHighlight> {
        return this.roomHighlights;
    }

    // ── Map-room selection (Mudlet getMapSelection / clearMapSelection) ───────

    /** Monotonic counter bumped on every selection mutation. The
     *  MapSelectionOverlay reads this through its lens-style version channel so
     *  the renderer's overlay-output cache invalidates only when the set
     *  actually changes. */
    getSelectionVersion(): number { return this.selectionVersion; }

    /** True when the room is in the current selection — read by
     *  MapSelectionOverlay when emitting per-room shapes. */
    isRoomSelected(id: number): boolean { return this.selectedRooms.has(id); }

    /** The most recently single-clicked room (Mudlet's selection "center"), or
     *  null when nothing is selected. Used by MapSelectionOverlay to draw a
     *  distinct marker on the center. */
    getSelectionCenter(): number | null { return this.selectionCenter; }

    /** Size of the current selection — fed to registerMapInfo callbacks as
     *  Mudlet's `selectionSize` argument. */
    getMapSelectionSize(): number { return this.selectedRooms.size; }

    /**
     * Mudlet `getMapSelection()` → `{ rooms = {roomIDs}, center = roomID }`.
     * `rooms` is a list of selected room ids (sorted for deterministic
     * Lua-side iteration); `center` is the room marked as the selection's
     * focal point (Mudlet uses the last-clicked / right-clicked room). Both
     * are empty / null when nothing is selected.
     */
    getMapSelection(): { rooms: number[]; center: number | null } {
        return {
            rooms: [...this.selectedRooms].sort((a, b) => a - b),
            center: this.selectionCenter,
        };
    }

    /**
     * Replace the selection with a single room and mark it as the center.
     * Mudlet's plain left-click on a room does the same. Returns false when
     * the room doesn't exist (silently — the caller is usually a UI handler).
     */
    selectMapRoom(id: number): boolean {
        if (!this.rooms.has(id)) return false;
        if (this.selectedRooms.size === 1 && this.selectedRooms.has(id) && this.selectionCenter === id) {
            return true;
        }
        this.selectedRooms.clear();
        this.selectedRooms.add(id);
        this.selectionCenter = id;
        this.notifySelection();
        return true;
    }

    /**
     * Toggle a room in/out of the selection (Mudlet ctrl-click). Adding a
     * room makes it the new center; removing the current center promotes the
     * lowest remaining id as the new center (and nulls the center when the
     * selection ends up empty).
     */
    toggleMapRoomSelection(id: number): boolean {
        if (!this.rooms.has(id)) return false;
        if (this.selectedRooms.has(id)) {
            this.selectedRooms.delete(id);
            if (this.selectionCenter === id) {
                let next: number | null = null;
                for (const r of this.selectedRooms) {
                    if (next == null || r < next) next = r;
                }
                this.selectionCenter = next;
            }
        } else {
            this.selectedRooms.add(id);
            this.selectionCenter = id;
        }
        this.notifySelection();
        return true;
    }

    /**
     * Mudlet `clearMapSelection()` — wipe the selection set and the center.
     * Returns true when something was cleared, false when the selection was
     * already empty (so callers don't spin on a no-op notify).
     */
    clearMapSelection(): boolean {
        if (this.selectedRooms.size === 0 && this.selectionCenter == null) return false;
        this.selectedRooms.clear();
        this.selectionCenter = null;
        this.notifySelection();
        return true;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private updateAreaBounds(areaId: number): void {
        const area = this.areas.get(areaId);
        if (!area || area.rooms.length === 0) return;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const id of area.rooms) {
            const r = this.rooms.get(id);
            if (!r) continue;
            if (r.x < minX) minX = r.x; if (r.x > maxX) maxX = r.x;
            if (r.y < minY) minY = r.y; if (r.y > maxY) maxY = r.y;
            if (r.z < minZ) minZ = r.z; if (r.z > maxZ) maxZ = r.z;
        }
        area.min_x = minX === Infinity ? 0 : minX;
        area.min_y = minY === Infinity ? 0 : minY;
        area.min_z = minZ === Infinity ? 0 : minZ;
        area.max_x = maxX === -Infinity ? 0 : maxX;
        area.max_y = maxY === -Infinity ? 0 : maxY;
        area.max_z = maxZ === -Infinity ? 0 : maxZ;
    }
}
