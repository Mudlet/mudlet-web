import type { BindingContext } from './context';
import { parseXmlMapResult } from '../../../map/xmlMapImport';

/**
 * Mudlet's map API: the 2D view, room and area CRUD, exits, doors, custom
 * lines, labels, highlights, selection, per-room styling, user data, and the
 * mapInfo / context-menu extension points.
 *
 * This is by far the widest binding surface in the runtime — it mirrors
 * Mudlet's map Lua API essentially one-for-one — so it lives in its own
 * module. The heavy lifting is all in MapStore behind `api.map`; the code
 * here is argument coercion and Mudlet's return-shape conventions (notably
 * alse where Mudlet returns nil, which Bridge.lua unpacks into the
 * documented (nil, errMsg) multi-returns).
 */
/** The Mudlet binary map format versions mudix's reader/writer covers. Outside
 *  this range a save is refused rather than written in a shape nothing reads. */
/** Coerce an optional numeric arg: nil stays nil so the store's own Mudlet
 *  default applies, rather than collapsing to 0 the way `Number(nil)` would. */
function opt(v: unknown): number | undefined {
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

const MIN_MAP_FORMAT = 17;
const MAX_MAP_FORMAT = 21;

export function installMapBindings({
    lua,
    api,
    vfs,
    channel,
    emitEvent,
    unregisterCb,
    pushJsValue,
    registerRawGlobal,
    evaluateMapInfo,
    evaluateExitWeightFilter,
}: BindingContext): void {
    // Mudlet's profile always has its map folder — TMap makes it at load, long
    // before anything saves — and scripts write into it by name on that
    // assumption. Make it here for the same reason, so a save that names a file
    // inside it isn't also the call that has to create it.
    if (vfs) {
        try { vfs.mkdir(`${vfs.profilePath}/map`); } catch { /* already there */ }
    }

    // A bare or relative map name resolves against the profile directory, not
    // against whatever the process's working directory happens to be — a spec
    // run's is the source tree, and a map saved there is a map nobody finds
    // again. Absolute paths are left alone.
    const resolveMapPath = (location: string): string =>
        location.startsWith('/') ? location : `${vfs?.profilePath ?? ''}/${location}`;

    /** Whether a save can land at `target`. The VFS creates missing parents on
     *  write, which is convenient everywhere else and wrong here: Mudlet opens
     *  the file with QFile and a save into a directory that does not exist
     *  fails, so `saveMap("/nosuchdirectory/x.dat")` has to answer false rather
     *  than quietly conjure the directory. */
    const parentExists = (target: string): boolean => {
        const dir = target.slice(0, target.lastIndexOf('/'));
        if (!vfs || dir === '') return true;   // writing into the VFS root
        return vfs.stat(dir)?.type === 'dir';
    };

    /** `<profile>/map/<yyyy-MM-dd#hh-mm-ss>map.dat`, the name Mudlet gives a
     *  save that was not told where to go. */
    const defaultMapPath = (): string | null => {
        if (!vfs) return null;
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
            + `#${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
        try { vfs.mkdir(`${vfs.profilePath}/map`); } catch { /* already there */ }
        return `${vfs.profilePath}/map/${stamp}map.dat`;
    };

    /** The most recently written map file in the profile's map folder, which is
     *  what a `loadMap()` with no path restores. Picked by modification time,
     *  not by name: a save that was told where to go lands here under a name of
     *  the caller's choosing, and sorting those alphabetically against the
     *  timestamp names the no-path saves use picks the wrong file. */
    const newestMapFile = (): string | null => {
        if (!vfs) return null;
        const dir = `${vfs.profilePath}/map`;
        let names: string[];
        try { names = vfs.readdir(dir).filter(n => n.toLowerCase().endsWith('.dat')); }
        catch { return null; }
        let newest: string | null = null;
        let newestAt = -Infinity;
        for (const name of names) {
            const path = `${dir}/${name}`;
            const at = vfs.stat(path)?.mtime?.getTime() ?? 0;
            if (at >= newestAt) { newestAt = at; newest = path; }
        }
        return newest;
    };

    // ── Map view ──────────────────────────────────────────────────────────
    // Returns a bool; the Bridge.lua `centerview` wrapper turns false into
    // Mudlet's (nil, errMsg) multi-return for an unknown room id.
    lua.global.set('__centerview',    (id: number)              => api.centerView(id));
    // Mudlet getMapZoom([areaID]) / setMapZoom(zoom[, areaID]) / updateMap().
    // mudix has a single shared 2D view, so areaID is accepted for compat but
    // applies to the current view. getMapZoom returns false (→ nil) with no
    // map panel open. The zoom value is Mudlet-compatible: the number of map
    // units across the viewport's shorter edge (must be >= 3.0 to set).
    // Both report their refusal to Bridge.lua: getMapZoom via null (unknown
    // areaID), setMapZoom via the message string (null = success).
    lua.global.set('__getMapZoom', (areaID?: unknown) =>
        api.getMapZoom(areaID == null || areaID === '' ? undefined : Number(areaID)) ?? null);
    lua.global.set('__setMapZoom', (zoom: unknown, areaID?: unknown) =>
        api.setMapZoom(Number(zoom), areaID == null || areaID === '' ? undefined : Number(areaID)));
    lua.global.set('updateMap',        ()                         => { api.updateMap(); });
    // ── Secondary map views ───────────────────────────────────────────────
    // createMapView hands back the new id, or the refusal message as a string;
    // getMapViewInfo hands back the info table or null. Bridge.lua shapes both
    // into Mudlet's (nil, errMsg) pairs and 1-indexes the id list.
    lua.global.set('__createMapView', (areaId?: unknown) =>
        api.createMapView(areaId == null || areaId === '' ? 0 : Number(areaId)));
    lua.global.set('closeMapView', (viewId: unknown) => api.closeMapView(Number(viewId)));
    lua.global.set('closeAllMapViews', () => api.closeAllMapViews());
    lua.global.set('__getMapViewIds', () => api.getMapViewIds());
    lua.global.set('__getMapViewInfo', (viewId: unknown) =>
        api.getMapViewInfo(Number(viewId)) ?? null);
    // Mudlet getPlayerRoom: nil when no map / no valid room. We return
    // false because wasmoon nil round-trips through false more reliably.
    lua.global.set('getPlayerRoom',   ()                         => api.map.getPlayerRoom() ?? false);
    // Mudlet getRoomIDbyHash: returns -1 when no room has the given hash.
    lua.global.set('getRoomIDbyHash', (hash: string)            => api.getRoomIDbyHash(hash) ?? -1);
    lua.global.set('setRoomIDbyHash', (id: number, hash: string)=> api.map.setRoomIDbyHash(id, hash));
    // Mudlet getRoomHashByID: returns the hash string, or (false, errMsg) on
    // miss / when the room has no hash. JS hands back the string or null;
    // Bridge.lua unpacks the multi-return.
    lua.global.set('__getRoomHashByID', (id: number)            => api.map.getRoomHashByID(id) ?? null);

    // Mudlet loadMap([location]). With a path, reads the map from VFS —
    // an `.xml` path goes through the IRE-style XML importer (Mudlet
    // TConsole::importMap), anything else through the binary `.dat`
    // reader — and hands it over for re-render and IDB persistence.
    // Without a path the panel reloads from already-stored bytes. Returns
    // true on success, false if the file is missing, unreadable, or fails
    // to parse.
    // Returns true / false for the binary path and, for XML, either true or a
    // string explaining what went wrong — Bridge.lua turns that string into
    // Mudlet's (nil, message) pair. XML says more than binary because Mudlet's
    // XML importer does: a parse failure there is worth a reason.
    lua.global.set('__loadMap', (location?: unknown, xml?: unknown) => {
        if (typeof location === 'string' && location.length > 0) {
            const path = resolveMapPath(location);
            if (!vfs) return false;
            if (path.toLowerCase().endsWith('.xml')) {
                // Bridge.lua reads the text and passes it as the second
                // argument: an XML map can live outside the profile filesystem
                // — the busted corpus keeps its fixture in the read-only /lua/
                // namespace — and only Lua's io layer sees both.
                const text = String(xml ?? '');
                try {
                    if (api.loadMapXml(text)) return true;
                } catch { /* reported below */ }
                // Only the failure path re-parses, and it says which of Mudlet's
                // three failures this was (TMap::readXmlMapFile): a document
                // rooted anywhere but <map> is somebody else's — a game with no
                // map to offer answering a download with an error page — while
                // one rooted at <map> that will not parse is the player's own
                // map, damaged, and neither is a file that is not XML at all.
                // Telling them apart is the point: a player whose map broke must
                // not be told it was never a map. In every case the loaded map is
                // untouched, since nothing is cleared before the parse.
                const parsed = parseXmlMapResult(text);
                const reason = parsed.ok ? 'import-failed' : parsed.reason;
                if (reason === 'not-a-map') {
                    return `loadMap: the file:\n"${location}"\ndoes not contain a map, so the current map has been left as it was.`;
                }
                if (reason === 'damaged') {
                    return `loadMap: the file:\n"${location}"\nis damaged or unreadable, so the current map has been left as it was.`;
                }
                return `loadMap: failure to import XML map file "${location}"`;
            }
            let bytes: Uint8Array;
            try { bytes = vfs.readBinaryFile(path); }
            catch { return false; }
            return api.loadMap(bytes, location);
        }
        // No path: the profile's most recent save, then whatever is already
        // stored. Mudlet reads the newest file out of the map folder, and a
        // script that saved without naming a file expects to get that back.
        const newest = vfs ? newestMapFile() : null;
        if (newest) {
            try { return api.loadMap(vfs!.readBinaryFile(newest), newest); }
            catch { /* fall through to the stored bytes */ }
        }
        return api.loadMap();
    });

    // Mudlet saveMap([location]). Serialises the current MapStore to the
    // Mudlet binary `.dat` format and persists it to this connection's
    // IndexedDB slot. With a path, the same bytes are also written to the
    // VFS so external tools (or a future loadMap(path)) can read them
    // back. Returns true on success, false if serialisation fails or the
    // VFS write throws.
    lua.global.set('__saveMap', (location?: unknown, formatVersion?: unknown) => {
        // The argument is Mudlet's, and so are the bounds (TMap::mMinVersion 17
        // to mMaxVersion 20, plus the experimental 21): a version outside them
        // is refused flatly, as desktop refuses it.
        //
        // Inside them it is accepted and then ignored — the file is always
        // written as v20, because `mudlet-map-binary-reader` writes only v20
        // and is not going to write the older formats it can read. Keeping the
        // signature means a Mudlet package that passes a version still works
        // rather than erroring; what it does not get is a v17 file. Desktop's
        // "Map format version" preference is absent for the same reason (see
        // docs/settings-divergence.md), and saving for an older Mudlet is a job
        // for desktop Mudlet, which still writes those formats.
        if (formatVersion !== undefined && formatVersion !== null) {
            const v = Number(formatVersion);
            if (!Number.isFinite(v) || v < MIN_MAP_FORMAT || v > MAX_MAP_FORMAT) return false;
        }
        const bytes = api.saveMap();
        if (!bytes) return false;
        // No location: the profile's own map folder, named for the time of the
        // save, exactly as Mudlet does it. A script that calls saveMap() with
        // no arguments expects a file to appear, not just an IndexedDB write.
        const target = typeof location === 'string' && location.length > 0
            ? resolveMapPath(location)
            : defaultMapPath();
        if (!vfs || !target) return false;
        if (!parentExists(target)) return false;
        try { vfs.writeBinaryFile(target, bytes); }
        catch { return false; }
        return true;
    });

    // Mudlet `saveJsonMap(path)` — write the current MapStore to a JSON
    // file. The on-disk format is the same shape as the in-memory
    // MudletMap so `loadJsonMap` can round-trip it. Returns false when
    // serialisation fails or the VFS write throws.
    // Null on success, or the reason it did not happen — Bridge.lua turns the
    // second into Mudlet's (nil, why). The destination's TYPE is checked there
    // too, because Mudlet reads it with getVerifiedString, which raises.
    lua.global.set('__saveJsonMap', (location?: unknown): string | undefined => {
        if (typeof location !== 'string' || location.length === 0) {
            return 'saveJsonMap: a non-empty path and file name is needed to save the map to';
        }
        if (!vfs) return 'saveJsonMap: no profile filesystem to write to';
        // Mudlet appends the suffix itself rather than writing a file the
        // loader will not recognise later.
        const path = /\.json$/i.test(location) ? location : `${location}.json`;
        // The VFS makes a write's parent directory on demand, which is right for
        // a script keeping its own data and wrong for a destination the player
        // named: saving a map into a folder that is not there is a typo, and
        // Mudlet reports it rather than inventing the folder.
        const parent = path.slice(0, path.lastIndexOf('/'));
        if (parent && !vfs.exists(parent)) {
            return `saveJsonMap: could not open file "${path}" for writing, "${parent}" is not a directory`;
        }
        let json: string;
        try { json = api.saveJsonMap(); }
        catch (e) { return `saveJsonMap: could not serialise the map (${String(e)})`; }
        try { vfs.writeFile(path, json); }
        catch { return `saveJsonMap: could not open file "${path}" for writing`; }
        return undefined;
    });
    // Mudlet `loadJsonMap(path)` — read a JSON map previously produced by
    // saveJsonMap and replace the in-memory map. Raises sysMapLoadEvent
    // on success. Returns false on missing file / bad JSON / wrong shape.
    // Each refusal names what it actually found, in Mudlet's words: a package
    // that hands a user's file to this needs to say which of "not there", "not
    // JSON", "not a map" and "not a map this build reads" happened.
    lua.global.set('__loadJsonMap', (location?: unknown): string | undefined => {
        if (typeof location !== 'string' || location.length === 0) {
            return 'loadJsonMap: a non-empty path and file name is needed to read the map from';
        }
        if (!vfs) return 'loadJsonMap: no profile filesystem to read from';
        let json: string;
        try { json = vfs.readFile(location); }
        catch { return `loadJsonMap: could not open file "${location}" for reading`; }
        let parsed: unknown;
        try { parsed = JSON.parse(json); }
        catch { return `loadJsonMap: could not parse file "${location}" as JSON`; }
        const doc = (parsed ?? {}) as { formatVersion?: unknown; areas?: unknown };
        if (typeof doc.formatVersion !== 'number') {
            return `loadJsonMap: no format version detected in file "${location}"`;
        }
        // Quoted to three decimals as Mudlet prints it — the version is a
        // number there and the message shows it the way a version reads.
        if (doc.formatVersion !== 1) {
            return `loadJsonMap: invalid format version "${doc.formatVersion.toFixed(3)}" detected`
                + ` in file "${location}"`;
        }
        if (!Array.isArray(doc.areas) || doc.areas.length === 0) {
            return `loadJsonMap: no areas detected in file "${location}"`;
        }
        if (!api.loadJsonMap(json)) return `loadJsonMap: could not read the map in file "${location}"`;
        // The map-level settings ride in the same document, and are applied
        // after the rooms so a failed load cannot leave the profile wearing an
        // imported map's appearance without its map.
        api.applyJsonMapSettings(doc as Record<string, unknown>);
        return undefined;
    });

    // ── Room CRUD ─────────────────────────────────────────────────────────
    // Mudlet `createRoomID([minimum])` — smallest unused room id at or
    // above `minimum`, or above the running cursor if no floor is given.
    lua.global.set('createRoomID', (minimum?: unknown) => {
        const m = Number(minimum);
        return api.map.createRoomID(Number.isFinite(m) && m > 0 ? m : undefined);
    });
    // Mudlet addRoom(roomID [, areaID]) — when an areaID is given the new room
    // is placed in that area, which must already exist. Without one the room
    // lives in the default area until a later setRoomArea call. Returns the
    // boolean "was it created", or the message string when it was created but
    // the requested area didn't exist (Bridge.lua makes that Mudlet's
    // `(nil, errMsg)`, with the room left in areaID -1).
    lua.global.set('__addRoom', (id: unknown, areaId?: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return false;
        const aid = areaId != null && areaId !== '' ? Number(areaId) : undefined;
        const r = api.map.addRoom(rid, Number.isFinite(aid as number) ? aid : undefined);
        return typeof r === 'object' ? r.err : r;
    });
    lua.global.set('deleteRoom',   (id: number)    => api.map.deleteRoom(id));
    lua.global.set('roomExists',   (id: number)    => api.map.roomExists(id));

    // ── Room properties ───────────────────────────────────────────────────
    // Mudlet getRoomName: returns the name string, or (false, errMsg) on
    // miss. JS hands back the string or null; Bridge.lua unpacks the
    // multi-return.
    lua.global.set('__getRoomName', (id: number)              => api.map.getRoomName(id) ?? null);
    lua.global.set('setRoomName',  (id: number, n: string)   => api.map.setRoomName(id, n));
    // Mudlet `getRoomArea(id)` — area id, or -1 when the room is missing.
    lua.global.set('getRoomArea',  (id: number)              => api.map.getRoomArea(Number(id)) ?? null);
    // Mudlet setRoomArea(roomID|{ids}, areaID|areaName). Bridge.lua flattens the
    // table form into a comma-separated id list — wasmoon's table proxy can't be
    // iterated reliably from JS (the object form threw outright) — and shapes
    // the returned refusal message into Mudlet's (nil, errMsg).
    lua.global.set('__setRoomArea', (ids: unknown, a: unknown) => {
        const rooms = String(ids ?? '').split(',').filter(Boolean).map(Number);
        const area = typeof a === 'number' ? a : String(a ?? '');
        return api.map.setRoomArea(rooms, area);
    });
    // getRoomCoordinates returns [x,y,z] as a 0-indexed table; a Lua wrapper
    // below unpacks to three values. Raw-marshalled (issue #2) — undefined
    // (room miss) lands as nil, which Bridge.lua turns into the `false` miss.
    registerRawGlobal('__getRoomCoordinates', (L) => {
        const id = lua.global.luaApi.lua_tointeger(L, 1);
        pushJsValue(L, api.map.getRoomCoordinates(id));
        return 1;
    });
    lua.global.set('setRoomCoordinates',   (id: number, x: number, y: number, z: number) => api.map.setRoomCoordinates(id, x, y, z));
    lua.global.set('__getRoomsByPosition', (areaId: unknown, x: unknown, y: unknown, z: unknown) =>
        api.map.getRoomsByPosition(Number(areaId), Number(x), Number(y), Number(z)) ?? null);
    lua.global.set('getRoomEnv',   (id: number)              => api.map.getRoomEnv(id));
    lua.global.set('setRoomEnv',   (id: number, e: number)   => api.map.setRoomEnv(id, e));
    // Mudlet getRoomChar(id) → symbol string, or (nil, errMsg) when the
    // room doesn't exist. The raw entry point returns the empty string for
    // an unset symbol and `null` for the miss case; Bridge.lua re-shapes.
    lua.global.set('__getRoomChar', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid) || !api.map.roomExists(rid)) return null;
        return api.map.getRoomChar(rid);
    });
    lua.global.set('setRoomChar',  (id: number, c: string)   => api.map.setRoomChar(id, c));
    // Mudlet lockRoom(roomID, lockIfTrue) → true on success. roomLocked
    // returns the lock state, or nil when the room doesn't exist (Mudlet
    // distinguishes the miss from an unlocked room).
    lua.global.set('lockRoom',     (id: unknown, b: unknown)  => api.map.lockRoom(Number(id), !!b));
    // An unknown room reads as unlocked (Mudlet pushes false, not nil).
    lua.global.set('roomLocked',   (id: unknown) => api.map.roomLocked(Number(id)));
    // Mudlet setRoomHidden(roomID, hidden) → true on success, false when
    // the room is missing. getRoomHidden(roomID) → bool, or (false, errMsg)
    // when the room is missing — Bridge.lua re-shapes the null we return
    // here into Mudlet's tuple form.
    lua.global.set('setRoomHidden', (id: unknown, hidden: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return false;
        return api.map.setRoomHidden(Math.trunc(rid), !!hidden);
    });
    lua.global.set('__getRoomHidden', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid) || !api.map.roomExists(rid)) return null;
        return api.map.getRoomHidden(Math.trunc(rid));
    });
    // Mudlet getHiddenRooms(areaID) → 1-indexed Lua table of room ids in
    // that area whose hidden flag is set. JS hands back an array (which
    // lands 0-indexed in wasmoon) or null when the area is missing;
    // Bridge.lua re-indexes to 1-based and shapes the miss into Mudlet's
    // (false, errMsg) tuple.
    lua.global.set('__getHiddenRooms', (areaId: unknown) => {
        if (areaId == null || areaId === '') return api.map.getHiddenRooms() ?? null;
        const aid = Number(areaId);
        if (!Number.isFinite(aid)) return null;
        return api.map.getHiddenRooms(Math.trunc(aid)) ?? null;
    });
    // Mudlet getRoomWeight(roomID) → the room's pathfinding weight, or no
    // value when the room is missing (we hand back false). setRoomWeight
    // returns true on success.
    lua.global.set('getRoomWeight', (id: unknown) => {
        const w = api.map.getRoomWeight(Number(id));
        return w === undefined ? false : w;
    });
    lua.global.set('setRoomWeight', (id: unknown, w: unknown) => api.map.setRoomWeight(Number(id), Number(w)));
    // Mudlet `getRoomUserData(id, key [, fullErr])`. Default behaviour
    // returns the string value, or "" if either the room or key is missing.
    // With `fullErr=true` Mudlet differentiates the miss cases: returns
    // (false, errMsg). The raw entry point reports which case applied so
    // the Bridge.lua wrapper can shape the multi-return.
    // Raw-marshalled (issue #2): this is the hottest per-room query in the
    // map-iteration trace. The {miss}/{value} shape is unchanged, so the
    // Bridge.lua getRoomUserData wrapper consumes it exactly as before.
    registerRawGlobal('__getRoomUserData', (L) => {
        const luaApi = lua.global.luaApi;
        const rid = luaApi.lua_tointeger(L, 1);
        const key = luaApi.lua_tolstring(L, 2, null) ?? '';
        let result: unknown;
        if (!api.map.roomExists(rid)) {
            result = { miss: 'room', id: rid };
        } else {
            const v = api.map.getRoomUserData(rid, key);
            result = v === undefined ? { miss: 'key', key } : { value: v };
        }
        pushJsValue(L, result);
        return 1;
    });
    // The value is stored as a STRING, whatever Lua passed: Mudlet reads it
    // with lua_tostring, so `setRoomUserData(id, k, 5)` and a later
    // getRoomUserData both see "5". Storing the number instead made the pair
    // asymmetric — bundled Lua writes a bare number here (setRoomNameOffset's
    // one-value branch) and every reader expects a string back.
    lua.global.set('setRoomUserData', (id: number, k: string, v: unknown) =>
        api.map.setRoomUserData(id, k, v == null ? '' : String(v)));
    // Mudlet `getRoomUserDataKeys(id)` → sequential table of keys, or nil
    // when the room doesn't exist. JS hands back an array (wasmoon 0-indexed
    // on the Lua side) or `null` for the miss; Bridge.lua re-indexes to a
    // 1-indexed Lua table.
    lua.global.set('__getRoomUserDataKeys', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return null;
        return api.map.getRoomUserDataKeys(rid) ?? null;
    });
    // Mudlet getAllRoomUserData(id) → { key = value }, or (false, errMsg)
    // when the room is missing. JS hands back the dict (string keys cross
    // the bridge as-is) or `null`; Bridge.lua shapes the miss.
    lua.global.set('__getAllRoomUserData', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return null;
        return api.map.getAllRoomUserData(rid) ?? null;
    });
    // Mudlet clearRoomUserData(id) / clearRoomUserDataItem(id, key) →
    // bool, or (false, errMsg) when the room is missing. JS returns
    // `null` for the missing-room case so Bridge.lua can distinguish it
    // from the "nothing to clear" false.
    lua.global.set('__clearRoomUserData', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return null;
        return api.map.clearRoomUserData(rid) ?? null;
    });
    lua.global.set('__clearRoomUserDataItem', (id: unknown, k: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return null;
        return api.map.clearRoomUserDataItem(rid, String(k ?? '')) ?? null;
    });
    // Mudlet resetRoomArea(id) — move the room to the void area (-1).
    // (false, errMsg) when the room is missing; Bridge.lua shapes it.
    lua.global.set('__resetRoomArea', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return null;
        return api.map.resetRoomArea(rid) ?? null;
    });

    // ── Map-level user data ───────────────────────────────────────────────
    // Mudlet getMapUserData(key) / setMapUserData(key, value) /
    // clearMapUserData() / clearMapUserDataItem(key) operate on
    // MapStore.mapUserData and serialize into MudletMap.mUserData when
    // toMudletMap() runs; loaded maps push their mUserData in via
    // MapPanel.loadFromBuffer → MapStore.loadMapUserData.
    // Mudlet getMapUserData(key) → value on success, (false, errMsg) when
    // the key is not present. The raw entry point hands JS `null` for the
    // miss case; Bridge.lua re-shapes it into the documented multi-return.
    lua.global.set('__getMapUserData', (k: unknown) => {
        const v = api.map.getMapUserData(String(k ?? ''));
        return v === undefined ? null : v;
    });
    lua.global.set('setMapUserData',    (k: unknown, v: unknown) => {
        api.map.setMapUserData(String(k ?? ''), String(v ?? ''));
        return true;
    });
    // Mudlet split: clearMapUserData() wipes the whole dict;
    // clearMapUserDataItem(key) drops a single key.
    lua.global.set('clearMapUserData',     ()              => api.map.clearMapUserData());
    lua.global.set('clearMapUserDataItem', (k: unknown)    => api.map.clearMapUserDataItem(String(k ?? '')));
    lua.global.set('getAllMapUserData', () => api.map.getAllMapUserData());

    // ── Exits ─────────────────────────────────────────────────────────────
    // Mudlet's setExit/setExitStub accept the direction either as the
    // numeric 1-12 index or as a name ("north"/"n"/etc.); MapStore's
    // parseDirection normalizes both forms.
    // Raw-marshalled (issue #2): returns a {dir = roomId} table (string keys,
    // integer values), identical to the generic path. Empty table for a miss.
    registerRawGlobal('getRoomExits', (L) => {
        const id = lua.global.luaApi.lua_tointeger(L, 1);
        pushJsValue(L, api.map.getRoomExits(id));
        return 1;
    });
    // Mudlet getPath(from, to). Returns a string error message (validation
    // failure or no-path) or the PathfindResult object. The Bridge.lua
    // wrapper resets the speedWalkPath/Dir/Weight globals on every call,
    // populates them 1-indexed on success, and unpacks the JS shape into
    // Mudlet's (true, totalWeight) / (false, -1, errMsg) multi-return.
    lua.global.set('__getPath', (from: unknown, to: unknown) => {
        const fromId = Number(from), toId = Number(to);
        if (!Number.isFinite(fromId)) {
            return `getPath: bad argument #1 type (number expected, got ${typeof from}!)`;
        }
        if (!Number.isFinite(toId)) {
            return `getPath: bad argument #2 type (number expected, got ${typeof to}!)`;
        }
        if (!api.map.roomExists(fromId)) {
            return `getPath: number ${fromId} is not a valid source roomID`;
        }
        if (!api.map.roomExists(toId)) {
            return `getPath: number ${toId} is not a valid target roomID`;
        }
        return api.map.findPath(fromId, toId);
    });
    // Mudlet getCollisionLocationsInArea(areaID). JS returns a 0-indexed array
    // of [x,y,z] arrays (or null for an unknown area); the Bridge.lua wrapper
    // rebases both levels to 1-indexed and makes the (nil, errMsg) pair.
    lua.global.set('__getCollisionLocationsInArea', (areaId: unknown) =>
        api.map.getCollisionLocationsInArea(Number(areaId)));
    // Mudlet setExitWeightFilter(fn|nil) — Bridge.lua registers the callback
    // and passes its id here (0 clears). The stored filter is consulted by
    // findPath for every candidate exit, re-entering Lua each time; releasing
    // the previous registry slot on replace keeps repeated installs from
    // leaking callbacks.
    let exitWeightFilterCbId = 0;
    lua.global.set('__setExitWeightFilter', (cbId: unknown) => {
        const id = Number(cbId) | 0;
        if (exitWeightFilterCbId && exitWeightFilterCbId !== id) {
            unregisterCb(exitWeightFilterCbId);
        }
        exitWeightFilterCbId = id;
        api.map.setExitWeightFilter(
            id ? (roomId, exitCommand) => evaluateExitWeightFilter(id, roomId, exitCommand) : null,
        );
    });
    lua.global.set('setExit', (from: unknown, to: unknown, dir: unknown) =>
        api.map.setExit(Number(from), Number(to), dir as number | string));
    lua.global.set('__getExitStubs',    (id: unknown)                         => api.map.getExitStubs(Number(id)) ?? null);
    lua.global.set('setExitStub', (id: unknown, dir: unknown, set: unknown) =>
        api.map.setExitStub(Number(id), dir as number | string, !!set));
    // Mudlet lockExit(roomID, direction, lockIfTrue) — mutates the room's
    // exitLocks array directly so pathfinding (which reads room.exitLocks)
    // honours the lock. Direction accepts 1-12 ints or names ("north"/"n"/
    // …) — parseDirection normalises both.
    lua.global.set('lockExit', (id: unknown, dir: unknown, lock: unknown) =>
        api.map.lockExit(Number(id), dir as number | string, !!lock));
    // Mudlet hasExitLock(roomID, direction). Lua-side wrapper rejects unknown
    // string directions before calling in (matches the parity check in
    // Other.lua); JS returns false for unknown rooms/dirs as well.
    lua.global.set('hasExitLock', (id: unknown, dir: unknown) =>
        api.map.hasExitLock(Number(id), dir as number | string));
    // addSpecialExit/removeSpecialExit/setExitWeight/setDoor hand back the
    // refusal message (or null on success); Bridge.lua shapes Mudlet's
    // (nil, errMsg) pair from it.
    lua.global.set('__addSpecialExit',    (from: unknown, to: unknown, cmd: unknown) =>
        api.map.addSpecialExit(Number(from), Number(to), typeof cmd === 'string' ? cmd : String(cmd ?? '')));
    lua.global.set('__removeSpecialExit', (from: unknown, cmd: unknown) =>
        api.map.removeSpecialExit(Number(from), typeof cmd === 'string' ? cmd : String(cmd ?? '')));
    lua.global.set('getSpecialExitsSwap',(id: number)                         => api.map.getSpecialExitsSwap(id));
    // Mudlet getSpecialExits(roomID [, listAllExits]) → { [exitRoomID] =
    // { [command] = "0"|"1" } }. The outer keys are room ids, which wasmoon
    // hands to Lua as stringified keys; Bridge.lua re-keys them to integers.
    lua.global.set('__getSpecialExits', (id: unknown, listAll?: unknown) =>
        api.map.getSpecialExits(Number(id), !!listAll) ?? null);
    // Mudlet getExitWeights(roomID) → { [exit] = weight }; keys are short
    // direction names or special-exit commands (already strings, so no
    // re-keying needed).
    lua.global.set('getExitWeights', (id: unknown) => api.map.getExitWeights(Number(id)));
    // Mudlet setExitWeight(roomID, exitCommand, weight). exitCommand is a
    // stock direction (1-12 or name) or a special-exit command; a numeric
    // direction arriving as a regex-capture string is coerced back to a
    // number so parseDirection recognizes it.
    lua.global.set('__setExitWeight', (id: unknown, cmd: unknown, w: unknown) => {
        let dir: number | string;
        if (typeof cmd === 'number') dir = cmd;
        else { const s = String(cmd ?? ''); dir = /^\d+$/.test(s) ? Number(s) : s; }
        return api.map.setExitWeight(Number(id), dir, Number(w));
    });
    // Mudlet `getCustomLines(roomID)` → { [dir] = { attributes={color,style,arrow}, points=[{x,y,z},...] } }.
    // Returns nil when the room doesn't exist; wasmoon converts the JS
    // arrays/objects directly — the `points` array lands 0-indexed on the
    // Lua side, matching Mudlet's documented shape.
    lua.global.set('getCustomLines', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return null;
        return api.map.getCustomLines(rid) ?? null;
    });
    // Mudlet removeCustomLine(roomID, direction). A numeric-string direction
    // (e.g. a regex capture "4") is coerced back to a number so MapStore's
    // parseDirection recognizes it; arbitrary special-exit commands pass through.
    lua.global.set('removeCustomLine', (id: unknown, dir: unknown) => {
        let d: number | string;
        if (typeof dir === 'number') d = dir;
        else { const s = String(dir ?? ''); d = /^-?\d+$/.test(s.trim()) ? Number(s) : s; }
        return api.map.removeCustomLine(Number(id), d);
    });
    // Mudlet addCustomLine(roomID, id_to, direction, style, color, arrow).
    // Bridge.lua flattens the table args (the {points} list and {r,g,b}
    // color) since wasmoon's table proxy doesn't iterate reliably from JS:
    //   target = "R:<toId>"  OR  "P:x,y,z;x,y,z;..."  (P: with no points → "")
    // direction arrives as a string; a numeric direction is coerced back so
    // MapStore's parseDirection recognizes it.
    lua.global.set('__mudix_addCustomLine', (
        id: unknown, targetStr: unknown, direction: unknown, style: unknown,
        r: unknown, g: unknown, b: unknown, arrow: unknown,
    ) => {
        const ts = String(targetStr ?? '');
        let target: number | Array<[number, number, number]>;
        if (ts.startsWith('R:')) {
            target = Number(ts.slice(2));
        } else {
            const body = ts.startsWith('P:') ? ts.slice(2) : ts;
            target = body.split(';').filter(Boolean).map(seg => {
                const [x, y, z] = seg.split(',').map(Number);
                return [x, y, z ?? 0] as [number, number, number];
            });
        }
        const ds = String(direction ?? '');
        const dir: number | string = /^-?\d+$/.test(ds.trim()) ? Number(ds) : ds;
        return api.map.addCustomLine(
            Number(id), target, dir, String(style ?? ''),
            { r: Number(r), g: Number(g), b: Number(b) }, !!arrow,
        );
    });
    // Mudlet getExitStubsNames(roomID) → 1-indexed direction-name list (or
    // (false, errMsg) when the room is missing). Bridge.lua re-indexes.
    lua.global.set('__getExitStubsNames', (id: unknown) => api.map.getExitStubsNames(Number(id)) ?? null);
    // Mudlet getAllRoomEntrances(roomID) → sorted id list of rooms with an
    // exit into this one; nil/(false,errMsg) when the room is missing.
    lua.global.set('__getAllRoomEntrances', (id: unknown) => api.map.getAllRoomEntrances(Number(id)) ?? null);
    // Mudlet getAreaExits(areaID[, fullData]). Without full data → id array;
    // with → { [fromRoomID] = { [exit] = toRoomID } }. Bridge.lua re-keys the
    // outer ids (wasmoon stringifies them) / 1-indexes the array form.
    lua.global.set('__getAreaExits', (areaId: unknown, full?: unknown) => {
        const r = api.map.getAreaExits(Number(areaId), !!full);
        return r === undefined ? null : r;
    });
    // Mudlet clearSpecialExits(roomID) — remove all special exits. We return a
    // bool (mudix extension; Mudlet returns nothing) so scripts can detect a
    // bad roomID.
    lua.global.set('clearSpecialExits', (id: unknown) => api.map.clearSpecialExits(Number(id)));
    // Mudlet lockSpecialExit / hasSpecialExitLock take (from, to, command) —
    // the `to` argument is ignored (Bridge.lua drops it). The JS side returns
    // true / boolean on success or an error string; Bridge.lua re-shapes the
    // string into Mudlet's (false, errMsg) / (nil, errMsg).
    lua.global.set('__lockSpecialExit', (from: unknown, cmd: unknown, lock: unknown) =>
        api.map.lockSpecialExit(Number(from), String(cmd ?? ''), !!lock));
    lua.global.set('__hasSpecialExitLock', (from: unknown, cmd: unknown) =>
        api.map.hasSpecialExitLock(Number(from), String(cmd ?? '')));
    // Mudlet connectExitStub(fromID, direction) | (fromID, toID[, direction]).
    // Returns true on success or an error string Bridge.lua turns into
    // (false, errMsg). A numeric-string second/third arg is coerced so a
    // direction code survives the wasmoon string round-trip.
    lua.global.set('__connectExitStub', (from: unknown, a2: unknown, a3?: unknown) => {
        const coerce = (v: unknown): number | string => {
            if (typeof v === 'number') return v;
            const s = String(v ?? '');
            return /^-?\d+$/.test(s.trim()) ? Number(s) : s;
        };
        // wasmoon hands a trailing Lua nil over as null, not undefined.
        return api.map.connectExitStub(Number(from), coerce(a2), a3 == null ? undefined : coerce(a3));
    });
    // Mudlet deleteMap() — wipe the map back to a single empty default area.
    lua.global.set('deleteMap', () => api.map.deleteMap());
    // Mudlet searchRoom(roomID|name[, caseSensitive[, exactMatch]]). By id →
    // name string; by name → { [roomID] = name }. Bridge.lua re-keys the
    // table form's ids back to integers.
    lua.global.set('__searchRoom', (arg: unknown, cs?: unknown, em?: unknown) => {
        // Mudlet branches on lua_isnumber, which in Lua 5.1 accepts a numeric
        // STRING too — so searchRoom("1234") is a roomID lookup, not a name
        // search. A miss returns null for Bridge.lua to report as (nil, errMsg).
        const s = String(arg ?? '');
        const id = typeof arg === 'number' ? arg : (/^\s*-?\d+\s*$/.test(s) ? Number(s) : null);
        if (id !== null) return api.map.searchRoom(Math.trunc(id)) ?? null;
        return api.map.searchRoom(s, !!cs, !!em);
    });
    // Mudlet searchRoomUserData / searchAreaUserData ([key[, value]]) →
    // 0-indexed JS arrays; Bridge.lua re-indexes to 1-based Lua sequences.
    const optStr = (v: unknown): string | undefined => (v == null ? undefined : String(v));
    lua.global.set('__searchRoomUserData', (key?: unknown, value?: unknown) =>
        api.map.searchRoomUserData(optStr(key), optStr(value)));
    lua.global.set('__searchAreaUserData', (key?: unknown, value?: unknown) =>
        api.map.searchAreaUserData(optStr(key), optStr(value)));

    // ── Doors ─────────────────────────────────────────────────────────────
    // setDoor's direction can be a stock direction (numeric or name) or
    // an arbitrary special-exit command string.
    lua.global.set('__getDoors', (id: unknown)                    => api.map.getDoors(Number(id)) ?? null);
    // A numeric direction arriving as a regex-capture string is coerced back so
    // parseDirection recognises it.
    lua.global.set('__setDoor', (id: unknown, dir: unknown, val: unknown) => {
        let d: number | string;
        if (typeof dir === 'number') d = dir;
        else { const s = String(dir ?? ''); d = /^-?\d+$/.test(s.trim()) ? Number(s) : s; }
        return api.map.setDoor(Number(id), d, Number(val));
    });

    // ── Map context-menu events ───────────────────────────────────────────
    // Mudlet addMapEvent(uniqueName, eventName [, parent [, displayName [, ...args]]]).
    // Right-click on a room → context menu of registered entries; clicking one
    // fires raiseEvent(eventName, uniqueName, roomId) — matching Mudlet's
    // T2DMap::slot_userAction selection branch. mudix treats the right-clicked
    // room as the selection (we don't have multi-select); the extra args
    // registered with addMapEvent are dropped, same as Mudlet does here.
    api.map.setMapEventDispatcher((event, args) => emitEvent(event, args));
    // Mudlet add/removeMapEvent both push a plain  (the spec asserts it),
    // and register even before the map widget exists.
    lua.global.set('addMapEvent', (
        uniqueName: unknown, eventName: unknown,
        parent?: unknown, displayName?: unknown, ...args: unknown[]
    ) => {
        api.map.addMapEvent(
            String(uniqueName ?? ''),
            String(eventName ?? ''),
            parent == null ? null : String(parent),
            displayName == null ? null : String(displayName),
            ...args,
        );
        return true;
    });
    lua.global.set('removeMapEvent', (uniqueName: unknown) => {
        api.map.removeMapEvent(String(uniqueName ?? ''));
        return true;
    });
    // Mudlet shape:
    //   { [uniqueName] = {
    //         ["event name"]   = "...",
    //         ["parent"]       = "...",
    //         ["display name"] = "...",
    //         ["arguments"]    = { ... },  -- 1-indexed extra args
    //   } }
    // Build the per-entry table on the Lua side via doString so the keys
    // land as proper Lua strings and the args table is 1-indexed (wasmoon
    // would otherwise key a JS array 0..n-1).
    lua.global.set('__getMapEvents', () => api.map.getMapEvents());

    // ── Map context-menu submenus (Mudlet addMapMenu) ─────────────────────
    // addMapMenu(menuName [, parent [, displayName]]) registers a submenu
    // that addMapEvent entries nest under via their parent. Both push a plain
    // , even with no map widget open.
    lua.global.set('addMapMenu', (
        name: unknown, parent?: unknown, displayName?: unknown,
    ) => {
        api.map.addMapMenu(
            String(name ?? ''),
            parent == null ? null : String(parent),
            displayName == null ? null : String(displayName),
        );
        return true;
    });
    lua.global.set('removeMapMenu', (name: unknown) => {
        api.map.removeMapMenu(String(name ?? ''));
        return true;
    });
    // Mudlet shape: { [menuName] = { ["parent"]=..., ["display name"]=... } }.
    // JS hands back an array of entries (0-indexed); Bridge.lua rebuilds the
    // keyed Lua table.
    lua.global.set('__getMapMenus', () => api.map.getMapMenus());

    // ── Per-room border colour / thickness ────────────────────────────────
    // Mudlet setRoomBorderColor(id, r, g, b [, a]) / setRoomBorderThickness
    // (id, t) → true, or (nil, errMsg) for bad channel/range or a missing
    // room. These __-prefixed bindings return true on success or an error
    // STRING; the Bridge.lua wrappers reshape the string into (nil, errMsg).
    const channel255 = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
    };
    lua.global.set('__setRoomBorderColor', (id: unknown, r: unknown, g: unknown, b: unknown, a?: unknown) => {
        const rr = channel255(r), gg = channel255(g), bb = channel255(b);
        // wasmoon hands a missing Lua arg over as `null` (not `undefined`),
        // so use `== null` to default the optional alpha to fully opaque.
        const aa = a == null ? 255 : channel255(a);
        if (rr === null || gg === null || bb === null || aa === null) {
            return 'setRoomBorderColor: colour channels must be integers between 0 and 255';
        }
        if (!api.map.setRoomBorderColor(Number(id), rr, gg, bb, aa)) {
            return `setRoomBorderColor: room ${Number(id)} does not exist`;
        }
        return true;
    });
    // getRoomBorderColor(id) → r, g, b, a (or nil). JS returns a 0-indexed
    // array or null; Bridge.lua unpacks it.
    lua.global.set('__getRoomBorderColor', (id: unknown) => {
        const c = api.map.getRoomBorderColor(Number(id));
        return c ? [c.r, c.g, c.b, c.a] : null;
    });
    lua.global.set('clearRoomBorderColor', (id: unknown) => api.map.clearRoomBorderColor(Number(id)));
    lua.global.set('__setRoomBorderThickness', (id: unknown, t: unknown) => {
        const n = Number(t);
        if (!Number.isInteger(n) || n < 1 || n > 10) {
            return 'setRoomBorderThickness: thickness must be an integer between 1 and 10';
        }
        if (!api.map.setRoomBorderThickness(Number(id), n)) {
            return `setRoomBorderThickness: room ${Number(id)} does not exist`;
        }
        return true;
    });
    // getRoomBorderThickness(id) → number, or nil when the room uses the map
    // default. Returns null (→ Lua nil) directly, so no Bridge wrapper needed.
    lua.global.set('getRoomBorderThickness', (id: unknown) => api.map.getRoomBorderThickness(Number(id)));
    lua.global.set('clearRoomBorderThickness', (id: unknown) => api.map.clearRoomBorderThickness(Number(id)));


    // ── Map info contributors (Mudlet registerMapInfo) ────────────────────
    // Bridge.lua compiles the callback into the `__mudix_cb` registry and
    // hands JS only the numeric id (same pattern as label/timer callbacks).
    // Re-registering an existing label frees the prior cb slot to avoid
    // leaks. The evaluator is invoked from MapPanel via evaluateMapInfos
    // — see __mudix_dispatch_mapinfo in Bridge.lua for the multi-return
    // unpacking dance.
    api.map.setMapInfoEvaluator((cbId, roomId, selectionSize, areaId, displayedAreaId) =>
        evaluateMapInfo(cbId, roomId, selectionSize, areaId, displayedAreaId));
    lua.global.set('__mudix_registerMapInfo', (label: unknown, cbId: unknown) => {
        const id = Number(cbId);
        if (typeof label !== 'string' || !label || !Number.isFinite(id)) return false;
        const { prevCallbackId } = api.map.registerMapInfo(label, id);
        if (prevCallbackId && prevCallbackId !== id) unregisterCb(prevCallbackId);
        return true;
    });
    lua.global.set('__killMapInfo', (label: unknown) => {
        if (typeof label !== 'string' || !label) return false;
        const { callbackId, removed } = api.map.killMapInfo(label);
        if (callbackId) unregisterCb(callbackId);
        return removed;
    });
    lua.global.set('__enableMapInfo', (label: unknown) => {
        if (typeof label !== 'string' || !label) return false;
        return api.map.enableMapInfo(label);
    });
    lua.global.set('__disableMapInfo', (label: unknown) => {
        if (typeof label !== 'string' || !label) return false;
        return api.map.disableMapInfo(label);
    });
    // Mudlet getMapInfo() → { [label] = enabledBool }. JS returns the
    // contributor array ({ label, enabled, ... }); Bridge.lua keys it by label.
    lua.global.set('__getMapInfo', () => api.map.getMapInfoContributors());

    // ── Map selection (Mudlet getMapSelection / clearMapSelection) ────────
    // Selection is paint-only — driven by clicks in MapPanel — but Mudlet
    // surfaces it to Lua. Bridge.lua rebuilds `rooms` as a 1-indexed
    // table; we hand the JS object straight over.
    lua.global.set('__getMapSelection', () => {
        const sel = api.map.getMapSelection();
        return { rooms: sel.rooms, center: sel.center };
    });
    lua.global.set('clearMapSelection', () => api.map.clearMapSelection());

    // Mudlet unsetRoomCharColor(roomID) — drop a per-room char-colour
    // override so the renderer falls back to the default. Pairs with
    // setRoomCharColor; returns false when the room is missing or there
    // was no override to clear.
    lua.global.set('unsetRoomCharColor', (roomId: unknown) => {
        const id = Number(roomId);
        if (!Number.isFinite(id)) return false;
        return api.map.unsetRoomCharColor(Math.trunc(id));
    });

    // ── Custom env colors ─────────────────────────────────────────────────
    // Mudlet setCustomEnvColor(envID, r, g, b, a). Updates mCustomEnvColors
    // on the active map; the renderer reads this when painting rooms whose
    // environment matches envID. A component outside 0-255 is a (nil, errMsg)
    // return naming the offending channel, so the message is handed back for
    // Bridge.lua to shape (null = success).
    lua.global.set('__setCustomEnvColor', (envId: unknown, r: unknown, g: unknown, b: unknown, a?: unknown) => {
        const eid = Number(envId);
        if (!Number.isFinite(eid)) return 'setCustomEnvColor: environmentID must be a number';
        const named: Array<[string, unknown]> = [['red', r], ['green', g], ['blue', b]];
        if (a !== undefined && a !== null) named.push(['alpha', a]);
        const parsed: number[] = [];
        for (const [name, raw] of named) {
            const v = channel(raw);
            if (v === null) return `${name} color component ${String(raw)} out of range {0 to 255}`;
            parsed.push(v);
        }
        api.map.setCustomEnvColor(Math.trunc(eid), parsed[0], parsed[1], parsed[2], parsed[3] ?? 255);
        return null;
    });
    // getCustomEnvColor(envID) → r, g, b, a (4 return values), or nil if
    // the envID has no override. The Lua wrapper unpacks the JS array.
    lua.global.set('__getCustomEnvColor', (envId: unknown) => {
        const c = api.map.getCustomEnvColor(Number(envId));
        return c ? [c.r, c.g, c.b, c.a] : null;
    });
    // Mudlet getCustomEnvColorTable() → { [envID] = {r, g, b, a} } with
    // 1-indexed inner arrays. The raw JS bridge returns plain objects; the
    // Bridge.lua wrapper rebuilds the inner tables 1-indexed and re-keys by
    // numeric envID.
    lua.global.set('__getCustomEnvColorTable',
        () => api.map.getCustomEnvColorTable());
    // Mudlet removeCustomEnvColor(envID). Drops the override; the renderer
    // falls back to the built-in env palette.
    lua.global.set('removeCustomEnvColor', (envId: unknown) => {
        const id = Number(envId);
        if (!Number.isFinite(id)) return false;
        return api.map.removeCustomEnvColor(Math.trunc(id));
    });
    // Mudlet setRoomCharColor(roomID, r, g, b [, a]). Sets the per-room
    // colour for the symbol painted by the renderer. (false, errMsg) when
    // the room is missing.
    lua.global.set('setRoomCharColor', (roomId: unknown, r: unknown, g: unknown, b: unknown, a?: unknown) => {
        const id = Number(roomId);
        if (!Number.isFinite(id)) return false;
        const rr = Math.max(0, Math.min(255, Number(r) || 0));
        const gg = Math.max(0, Math.min(255, Number(g) || 0));
        const bb = Math.max(0, Math.min(255, Number(b) || 0));
        const aa = a == null ? 255 : Math.max(0, Math.min(255, Number(a) || 0));
        return api.map.setRoomCharColor(Math.trunc(id), rr, gg, bb, aa);
    });
    // Mudlet getRoomCharColor(roomID) → r, g, b; nil when no per-room colour
    // was ever set. Three channels, not four: a symbol colour has no alpha in
    // Mudlet, unlike the border colour beside it, which does return one.
    lua.global.set('__getRoomCharColor', (roomId: unknown) => {
        const id = Number(roomId);
        if (!Number.isFinite(id)) return null;
        const c = api.map.getRoomCharColor(Math.trunc(id));
        return c ? [c.r, c.g, c.b] : null;
    });
    // Mudlet setMapBackgroundColor(r, g, b [, a]) / setMapRoomExitsColor(r, g, b).
    // Stored on the profile mapper settings — MapPanel reads from there each
    // render. Each returns the out-of-range message (or nil), which Bridge.lua
    // shapes into Mudlet's (nil, errMsg); the argument TYPE checks are up there
    // too, so what arrives here is already three or four whole numbers.
    lua.global.set('setMapBackgroundColor', (r: number, g: number, b: number, a?: number) =>
        api.setMapBackgroundColor(r, g, b, a ?? 255));
    lua.global.set('__getMapBackgroundColor', () => api.getMapBackgroundColor());
    lua.global.set('setMapRoomExitsColor', (r: number, g: number, b: number) =>
        api.setMapRoomExitsColor(r, g, b));
    lua.global.set('__getMapRoomExitsColor', () => api.getMapRoomExitsColor());
    // Mudlet setDefaultAreaVisible(visible) — TMap::mShowDefaultArea.
    lua.global.set('setDefaultAreaVisible', (visible: boolean) => api.setDefaultAreaVisible(visible));
    // Mudlet setMapRoomSize(roomSize). The renderer reads this from
    // settings.roomSize (units = map cells; ~0.6 default).
    lua.global.set('setMapRoomSize', (size: unknown) => api.setMapRoomSize(Number(size)));
    // Mudlet getMapRoomSize() — returns the active room-size value.
    lua.global.set('getMapRoomSize', () => api.getMapRoomSize());
    // Mudlet setMapMode("viewing"|"editing") / getMapMode(). Round-trips the
    // mode on MapStore; transitions raise mapModeChangeEvent.
    lua.global.set('setMapMode', (mode: unknown) => {
        const m = String(mode ?? '');
        if (m !== 'viewing' && m !== 'editing') return false;
        return api.map.setMapMode(m);
    });
    lua.global.set('getMapMode', () => api.map.getMapMode());
    api.map.setMapModeListener((mode) => emitEvent('mapModeChangeEvent', [mode]));

    // ── Room highlights ──────────────────────────────────────────────────
    // Mudlet highlightRoom(id, c1R, c1G, c1B, c2R, c2G, c2B, radius, c1A, c2A).
    // Two-color radial gradient with alpha — rendered Mudlet-style by
    // MudletHighlightOverlay. Wasmoon hands regex captures as strings, so
    // every channel goes through channel() for 0..255 validation.
    lua.global.set('highlightRoom', (
        id: unknown,
        r1: unknown, g1: unknown, b1: unknown,
        r2: unknown, g2: unknown, b2: unknown,
        radius: unknown,
        a1?: unknown, a2?: unknown,
    ) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return false;
        const c1r = channel(r1), c1g = channel(g1), c1b = channel(b1);
        const c2r = channel(r2), c2g = channel(g2), c2b = channel(b2);
        if (c1r === null || c1g === null || c1b === null) return false;
        if (c2r === null || c2g === null || c2b === null) return false;
        const rad = Number(radius);
        if (!Number.isFinite(rad)) return false;
        const c1a = a1 === undefined ? 255 : channel(a1);
        const c2a = a2 === undefined ? 255 : channel(a2);
        if (c1a === null || c2a === null) return false;
        return api.map.highlightRoom(
            Math.trunc(rid),
            c1r, c1g, c1b, c2r, c2g, c2b,
            rad, c1a, c2a,
        );
    });
    lua.global.set('unHighlightRoom', (id: unknown) => {
        const rid = Number(id);
        if (!Number.isFinite(rid)) return false;
        return api.map.unHighlightRoom(Math.trunc(rid));
    });

    // ── Areas ─────────────────────────────────────────────────────────────
    // Mudlet addAreaName / setAreaName return (false, errMsg) on duplicate
    // or empty inputs; MapStore packs failures as { ok:false, err } and a
    // Bridge.lua wrapper turns those into a Lua multi-return.
    lua.global.set('__addAreaName', (name: unknown) => {
        const r = api.map.addAreaName(String(name ?? ''));
        if (typeof r === 'number') return r;
        return { ok: false, err: r.err };
    });
    // deleteArea(areaID|areaName) — accept either form; the refusal message
    // (or null on success) is shaped into (nil, errMsg) by Bridge.lua.
    lua.global.set('__deleteArea', (idOrName: unknown) =>
        api.map.deleteArea(idOrName as number | string));
    lua.global.set('getAreaTable',   ()                        => api.map.getAreaTable());
    // Mudlet getAreaTableSwap() → { [areaID] = name }. JS hands back an
    // object whose numeric ids cross the bridge as stringified keys;
    // Bridge.lua re-keys them to integers (same dance as getMapLabels).
    lua.global.set('__getAreaTableSwap', ()                    => api.map.getAreaTableSwap());
    // ── Area user data ────────────────────────────────────────────────────
    // Mudlet getAreaUserData distinguishes a missing area from a missing
    // key; the raw entry point reports which case applied so Bridge.lua can
    // shape Mudlet's (false, errMsg) multi-return.
    lua.global.set('__getAreaUserData', (id: unknown, k: unknown) => {
        const aid = Number(id);
        const key = String(k ?? '');
        if (!Number.isFinite(aid) || !api.map.hasArea(aid)) {
            return { miss: 'area', id: aid };
        }
        const v = api.map.getAreaUserData(aid, key);
        return v === undefined ? { miss: 'key', key } : { value: v };
    });
    lua.global.set('setAreaUserData', (id: unknown, k: unknown, v: unknown) =>
        api.map.setAreaUserData(Number(id), String(k ?? ''), String(v ?? '')));
    // getAllAreaUserData(id) → { key = value }, or (false, errMsg) when the
    // area is missing (JS hands back `null` for the miss).
    lua.global.set('__getAllAreaUserData', (id: unknown) => {
        const aid = Number(id);
        if (!Number.isFinite(aid)) return null;
        return api.map.getAllAreaUserData(aid) ?? null;
    });
    // clearAreaUserData(id) / clearAreaUserDataItem(id, key) → bool, or
    // (false, errMsg) when the area is missing (JS `null`).
    lua.global.set('__clearAreaUserData', (id: unknown) => {
        const aid = Number(id);
        if (!Number.isFinite(aid)) return null;
        return api.map.clearAreaUserData(aid) ?? null;
    });
    lua.global.set('__clearAreaUserDataItem', (id: unknown, k: unknown) => {
        const aid = Number(id);
        if (!Number.isFinite(aid)) return null;
        return api.map.clearAreaUserDataItem(aid, String(k ?? '')) ?? null;
    });
    // ── Grid mode ─────────────────────────────────────────────────────────
    // getGridMode(id) → bool, or (false, errMsg) when the area is missing
    // (JS `null`). setGridMode(id, bool) → bool (false when area missing).
    lua.global.set('__getGridMode', (id: unknown) => {
        const aid = Number(id);
        if (!Number.isFinite(aid)) return null;
        return api.map.getGridMode(aid) ?? null;
    });
    lua.global.set('setGridMode', (id: unknown, b: unknown) =>
        api.map.setGridMode(Number(id), !!b));
    // Existence probe for the Bridge.lua argument guards, which only need to
    // know whether an areaID resolves before calling through.
    lua.global.set('__areaExists', (id: unknown) => {
        const aid = Number(id);
        return Number.isFinite(aid) && api.map.hasArea(Math.trunc(aid));
    });
    // getRoomAreaName is bidirectional: number → name string, name → number.
    // Returns false when the input cannot be resolved (matches the
    // existing convention; Mudlet returns nil/false on miss).
    lua.global.set('getRoomAreaName', (idOrName: unknown) => {
        const v = api.map.getRoomAreaName(idOrName as number | string);
        return v ?? false;
    });
    lua.global.set('__setAreaName', (idOrName: unknown, n: unknown) => {
        const r = api.map.setAreaName(idOrName as number | string, String(n ?? ''));
        if (r === true) return true;
        return { ok: false, err: typeof r === 'object' ? r.err : 'setAreaName: failed' };
    });
    // Raw-marshalled (issue #2): getAreaRooms → 0-indexed array of room ids
    // (getAreaRooms1 reindexes to 1-based); getRooms → { [roomId] = name }
    // with string keys, both identical to the generic path.
    registerRawGlobal('getAreaRooms', (L) => {
        const areaId = lua.global.luaApi.lua_tointeger(L, 1);
        pushJsValue(L, api.map.getAreaRooms(areaId));
        return 1;
    });
    // getRooms → { [roomId] = name }. Mudlet keys this by INTEGER room id
    // (its map is a QMap<int,...>); the generic pushValue path stringified
    // the keys, so build the table with integer keys directly here to match
    // real Mudlet (room ids are genuine integers — unlike GMCP/MSDP object
    // keys, which Mudlet's parseJSON keeps as strings).
    registerRawGlobal('getRooms', (L) => {
        const luaApi = lua.global.luaApi;
        const rooms = api.map.getRooms();
        const keys = Object.keys(rooms);
        luaApi.lua_checkstack(L, 4);
        luaApi.lua_createtable(L, 0, keys.length);
        for (const k of keys) {
            luaApi.lua_pushstring(L, rooms[k as unknown as number]);
            luaApi.lua_rawseti(L, -2, Number(k));
        }
        return 1;
    });
    // Mudlet getMapLabels(areaID) → { [labelID] = labelText }. Bridge.lua
    // re-keys via tonumber since wasmoon hands object keys across as
    // numeric strings; Mudlet scripts expect to index by integer label id.
    lua.global.set('__getMapLabels', (areaId: unknown) =>
        api.map.getMapLabels(Number(areaId)));
    // Mudlet getMapLabel(areaID, labelID|labelText) — overloaded by arg-2
    // type. JS returns a discriminated result ({ok:false,err}/{ok:true,single|multi});
    // Bridge.lua rebuilds the final shape — flat properties for the by-id
    // form, {[id]=props,...} for by-text — and translates errors into
    // Mudlet's (false, errMsg) multi-return.
    lua.global.set('__getMapLabel', (areaId: unknown, key: unknown) =>
        api.map.getMapLabel(Number(areaId), typeof key === 'number' ? key : String(key ?? '')));
    // Mudlet createMapLabel(areaID, text, x, y, z, fgR,fgG,fgB, bgR,bgG,bgB,
    // zoom, fontSize, showOnTop, noScaling, fontName, fgTransparency,
    // bgTransparency, temporary, outlineR,outlineG,outlineB). Bridge.lua has
    // already applied Mudlet's arg-count gating and type checks, so anything
    // still nil here is genuinely "not supplied" and MapStore fills the default.
    // → new labelID, or -1 for a missing area / empty text.
    lua.global.set('__createMapLabel', (
        areaId: unknown, text: unknown,
        x: unknown, y: unknown, z: unknown,
        fgR: unknown, fgG: unknown, fgB: unknown,
        bgR: unknown, bgG: unknown, bgB: unknown,
        zoom?: unknown, fontSize?: unknown, showOnTop?: unknown, noScaling?: unknown,
        fontName?: unknown, fgAlpha?: unknown, bgAlpha?: unknown, temporary?: unknown,
        olR?: unknown, olG?: unknown, olB?: unknown,
    ) => api.map.createMapLabel(
        Number(areaId), String(text ?? ''),
        Number(x) || 0, Number(y) || 0, Number(z) || 0,
        Number(fgR) || 0, Number(fgG) || 0, Number(fgB) || 0,
        Number(bgR) || 0, Number(bgG) || 0, Number(bgB) || 0,
        {
            zoom: opt(zoom), fontSize: opt(fontSize),
            showOnTop: showOnTop == null ? undefined : !!showOnTop,
            noScaling: noScaling == null ? undefined : !!noScaling,
            fontName: fontName == null ? undefined : String(fontName),
            fgAlpha: opt(fgAlpha), bgAlpha: opt(bgAlpha),
            temporary: temporary == null ? undefined : !!temporary,
            // All three arrive together or not at all (Mudlet requires the
            // triple), so one being present is enough to build the colour.
            outline: olR == null ? undefined
                : { r: Number(olR) || 0, g: Number(olG) || 0, b: Number(olB) || 0 },
        },
    ));
    // Mudlet createMapImageLabel(areaID, imagePath, x, y, z, w, h, [zoom,]
    // showOnTop, noScaling). → new labelID or -1.
    lua.global.set('__createMapImageLabel', (
        areaId: unknown, imagePath: unknown,
        x: unknown, y: unknown, z: unknown,
        w: unknown, h: unknown,
        showOnTop?: unknown, noScaling?: unknown,
    ) => api.map.createMapImageLabel(
        Number(areaId), String(imagePath ?? ''),
        Number(x) || 0, Number(y) || 0, Number(z) || 0,
        Number(w) || 0, Number(h) || 0,
        showOnTop == null ? true : !!showOnTop,
        !!noScaling,
    ));
    lua.global.set('deleteMapLabel', (areaId: unknown, labelId: unknown) =>
        api.map.deleteMapLabel(Number(areaId), Number(labelId)));
    // Mudlet auditAreas() — repair area/room membership consistency. Returns
    // a summary; Bridge.lua 1-indexes the orphanRooms/danglingRefs arrays.
    lua.global.set('__auditAreas', () => api.map.auditAreas());
}

