import {LUA_REGISTRYINDEX, type Lua} from 'wasmoon-lua5.1';

// JSON ↔ Lua bridge for Mudlet's `yajl` module. The encoder, the generator and
// the streaming parser live in Yajl.lua; this file owns the decoder behind
// yajl.to_value (JSON.parse in JS, then handed to Lua) and the `yajl.null`
// sentinel.
//
// Desktop Mudlet links lua-yajl (brimworks/lua-yajl, lua_yajl.c). What it does
// and this file has to reproduce:
//   - JSON arrays come out 1-indexed (yajl's got_array_value starts at 1).
//   - JSON `null` is `yajl.null`, a zero-size *userdata* (`type()` says
//     "userdata", indexing it or taking `#` raises). It is stored in the
//     registry under "yajl.null" and pushed wherever a null is decoded.
//   - numbers go through strtod, so `1e999` is inf and `-0` keeps its sign.
//   - the decoder keeps three Lua stack slots per open container and calls
//     lua_checkstack(L, 4) on every open, so past LUAI_MAXCSTACK (8000) slots —
//     the 2666th nested container — it raises "lua stack overflow". Anything
//     shallower decodes, however deep.

type LuaApi = Lua['global']['luaApi'];
type LuaState = Lua['global']['address'];

/**
 * Stands for JSON null in a JS value about to be pushed to Lua; the raw pusher
 * swaps it for the registry's `yajl.null` userdata. The GMCP/MSDP bridge never
 * hands wasmoon the sentinel itself: wasmoon reads a userdata's first word as
 * one of its own JS references, which is why the userdata built here is
 * zero-filled (reference 0 is unused, so wasmoon sees `undefined`).
 */
export const YAJL_NULL: unique symbol = Symbol('yajl.null');

/** Registry key lua_yajl stores the null sentinel under. */
const NULL_REGISTRY_KEY = 'yajl.null';

/**
 * The deepest container nesting lua_yajl's to_value accepts: one more and
 * lua_checkstack fails (see the header). Measured from the C, not guessed —
 * 3 base slots + 3 per open level + the 4 it asks for must stay ≤ 8000.
 */
export const MAX_DECODE_DEPTH = 2665;

/** The error lua_yajl raises past MAX_DECODE_DEPTH (luaL_error from a C frame: no position). */
export const DECODE_DEPTH_ERROR = 'lua stack overflow';

// Handing a decoded object graph back to Lua through wasmoon makes it walk the
// graph node by node through its proxy layer. That is fine for a GMCP packet and
// pathological for a map database: measured on f2ce-tools' 8.1 MB
// galaxy_brief.json, JSON.parse cost 45ms while the marshalling cost 280
// SECONDS — 99.98% of the total, and the whole of the UI freeze this decoder
// used to cause.
//
// So the fast path never returns a graph. It emits the value as Lua
// table-constructor source and lets Lua's own C parser build the tables, which
// crosses the bridge as one flat ASCII string instead of hundreds of thousands
// of proxy operations. See __yajl_parse_src__ below. Documents nested too deeply
// to express as constructors (or that fail to compile) go through
// __yajl_parse__, which builds the value with the raw lua_* API iteratively.

/** Printable ASCII excluding `"` (0x22) and `\` (0x5C) — emittable verbatim. */
const LUA_SAFE_ASCII = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/;

const utf8 = new TextEncoder();

/**
 * Append `s` as a Lua string literal. Non-ASCII is emitted as three-digit
 * decimal escapes of its UTF-8 bytes: Lua strings are byte strings, and a
 * pure-ASCII chunk also sidesteps the UTF-8 mangling the wasmoon string bridge
 * applies to high bytes (the same hazard VFS.lua armors around). Escapes are
 * always padded to three digits so a following literal digit can't be absorbed
 * into the escape.
 */
function pushLuaString(s: string, out: string[]): void {
    if (LUA_SAFE_ASCII.test(s)) {
        out.push('"', s, '"');
        return;
    }
    const bytes = utf8.encode(s);
    let lit = '"';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x22) lit += '\\"';
        else if (b === 0x5C) lit += '\\\\';
        else if (b >= 0x20 && b <= 0x7E) lit += String.fromCharCode(b);
        else lit += '\\' + String(b).padStart(3, '0');
    }
    out.push(lit, '"');
}

// Lua's parser caps nested constructors (LUAI_MAXCCALLS, 200 by default), so a
// pathologically deep document must not be emitted as source. Well under the
// limit to leave room for the wrapper.
const MAX_EMIT_DEPTH = 150;

class TooDeepError extends Error {}

/**
 * A number as Lua source. Infinity and -0 cannot be literals: Lua has no
 * infinity literal, and `-0` would constant-fold into the function's constant
 * table, where 0 and -0 are the SAME key — so one would silently become the
 * other. The chunk prologue computes them at runtime instead (`I`, `Z`).
 */
function luaNumber(v: number): string {
    if (Number.isFinite(v)) return Object.is(v, -0) ? 'Z' : String(v);
    if (v === Infinity) return 'I';
    if (v === -Infinity) return '(-I)';
    return '(I-I)'; // NaN: JSON can't carry it, but a hand-built value could
}

function pushLuaValue(v: unknown, out: string[], depth: number): void {
    if (depth > MAX_EMIT_DEPTH) throw new TooDeepError();
    if (v === null || v === YAJL_NULL) { out.push('N'); return; }
    switch (typeof v) {
        case 'string':  pushLuaString(v, out); return;
        case 'number':  out.push(luaNumber(v)); return;
        case 'boolean': out.push(v ? 'true' : 'false'); return;
    }
    if (Array.isArray(v)) {
        // A plain constructor is already 1-indexed, which is exactly what
        // lua_yajl produces.
        out.push('{');
        for (let i = 0; i < v.length; i++) {
            if (i > 0) out.push(',');
            pushLuaValue(v[i], out, depth + 1);
        }
        out.push('}');
        return;
    }
    if (typeof v === 'object') {
        out.push('{');
        let first = true;
        for (const k of Object.keys(v as object)) {
            if (!first) out.push(',');
            first = false;
            // Bracketed keys: JSON keys can be reserved words, digits or empty,
            // none of which are valid bare Lua identifiers.
            out.push('[');
            pushLuaString(k, out);
            out.push(']=');
            pushLuaValue((v as Record<string, unknown>)[k], out, depth + 1);
        }
        out.push('}');
        return;
    }
    out.push('nil');
}

/** Every chunk starts with this; Yajl.lua tells a chunk from an error message by it. */
const CHUNK_PROLOGUE = 'local N=... local I=1/0 local Z=-1/I return ';

/**
 * Serialise a JSON-decoded value as a Lua chunk returning it. The chunk takes
 * the null sentinel as its vararg so nulls survive without a global lookup.
 * Returns null when the value nests too deeply to express as source.
 */
export function luaChunkForValue(v: unknown): string | null {
    const out: string[] = [CHUNK_PROLOGUE];
    try {
        pushLuaValue(v, out, 0);
    } catch (err) {
        if (err instanceof TooDeepError) return null;
        throw err;
    }
    return out.join('');
}

/** Container nesting depth of a JSON value (a scalar is 0, `[]` is 1), without recursing. */
export function jsonDepth(root: unknown): number {
    let max = 0;
    const stack: Array<[unknown, number]> = [[root, 0]];
    while (stack.length > 0) {
        const [v, d] = stack.pop()!;
        if (v === null || typeof v !== 'object') continue;
        const depth = d + 1;
        if (depth > max) max = depth;
        const children = Array.isArray(v) ? v : Object.values(v as object);
        for (const c of children) {
            if (c !== null && typeof c === 'object') stack.push([c, depth]);
        }
    }
    return max;
}

function pushScalar(api: LuaApi, L: LuaState, v: unknown): void {
    if (v === null || v === YAJL_NULL) {
        api.lua_getfield(L, LUA_REGISTRYINDEX, NULL_REGISTRY_KEY);
        return;
    }
    switch (typeof v) {
        case 'number':
            // lua_Integer is 32 bits in this build, and -0 has no integer form:
            // everything else goes in as a double (which is all a Lua 5.1
            // number is anyway).
            if (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff && !Object.is(v, -0)) api.lua_pushinteger(L, v);
            else api.lua_pushnumber(L, v);
            return;
        case 'string':
            // lua_pushstring stops at the first NUL; lua_yajl keeps the byte
            // (Lua strings are counted), so push those with their UTF-8 length.
            if (v.includes('\0')) api.lua_pushlstring(L, v, api.module.lengthBytesUTF8(v));
            else api.lua_pushstring(L, v);
            return;
        case 'boolean':
            api.lua_pushboolean(L, v ? 1 : 0);
            return;
    }
    api.lua_pushnil(L);
}

interface Frame {
    arr: unknown[] | null;
    obj: Record<string, unknown> | null;
    keys: string[] | null;
    i: number;
}

/**
 * Push a JSON-shaped value (plain arrays/objects/scalars, `null` or YAJL_NULL
 * for JSON null) onto `L` with the raw lua_* API, the way lua_yajl's to_value
 * builds it: arrays 1-indexed, nulls as the registry `yajl.null`.
 *
 * Iterative, so neither the JS nor the C stack grows with the document's depth
 * — wasmoon's own pushValue recursed and wrote past the Lua stack, which is the
 * "memory access out of bounds" that used to kill the VM on a deep document.
 * Returns false, having pushed nothing, when the value is nested deeper than
 * lua_yajl accepts (MAX_DECODE_DEPTH) or the Lua stack can't take it.
 */
export function pushJsonValue(api: LuaApi, L: LuaState, root: unknown): boolean {
    const depth = jsonDepth(root);
    if (depth > MAX_DECODE_DEPTH) return false;
    // One slot per open container plus the value being stored into it.
    if (!api.lua_checkstack(L, depth + 4)) return false;

    const stack: Frame[] = [];
    // Push `v`: a scalar lands on the stack ready to store; a container gets an
    // empty table on the stack and a frame that fills it.
    const open = (v: unknown): boolean => {
        if (v === null || typeof v !== 'object') {
            pushScalar(api, L, v);
            return false;
        }
        if (Array.isArray(v)) {
            api.lua_createtable(L, v.length, 0);
            stack.push({arr: v, obj: null, keys: null, i: 0});
        } else {
            const keys = Object.keys(v as object);
            api.lua_createtable(L, 0, keys.length);
            stack.push({arr: null, obj: v as Record<string, unknown>, keys, i: 0});
        }
        return true;
    };
    // Store the value on top of the stack into the frame's table at its cursor.
    const store = (f: Frame): void => {
        if (f.arr) api.lua_rawseti(L, -2, f.i + 1);
        else api.lua_setfield(L, -2, f.keys![f.i]);
        f.i++;
    };

    if (!open(root)) return true;
    while (stack.length > 0) {
        const f = stack[stack.length - 1];
        const n = f.arr ? f.arr.length : f.keys!.length;
        if (f.i >= n) {
            stack.pop();
            if (stack.length > 0) store(stack[stack.length - 1]);
            continue;
        }
        const child = f.arr ? f.arr[f.i] : f.obj![f.keys![f.i]];
        if (!open(child)) store(f);
    }
    return true;
}

export interface YajlBridge {
    /**
     * Push a JSON-decoded value (JSON.parse output) onto `L` exactly as
     * yajl.to_value would build it. False, with nothing pushed, if it is too
     * deep for lua_yajl (see pushJsonValue).
     */
    pushValue(L: LuaState, value: unknown): boolean;
}

export function setupYajl(
    lua: Lua,
    registerRawGlobal: (name: string, fn: (L: LuaState) => number) => void,
): YajlBridge {
    const api = lua.global.luaApi;
    const G = lua.global.address;

    // yajl.null: a userdata, as on desktop. Built here because Lua 5.1 code can
    // only make a zero-size one (newproxy), and wasmoon reads the first word of
    // any userdata that crosses into JS as one of its reference ids — reading
    // past a zero-size block returns whatever reference happens to sit there.
    // A zeroed word is reference 0, which wasmoon never hands out: undefined.
    const ud = api.lua_newuserdata(G, 8);
    api.module.setValue(ud, 0, 'i32');
    api.module.setValue(ud + 4, 0, 'i32');
    api.luaL_newmetatable(G, 'yajl.null.meta');
    api.lua_setmetatable(G, -2);
    api.lua_pushvalue(G, -1);
    api.lua_setfield(G, LUA_REGISTRYINDEX, NULL_REGISTRY_KEY);
    api.lua_setglobal(G, '__yajl_null__');

    // The last document __yajl_parse_src__ parsed but could not express as
    // source; Yajl.lua hands the same string straight to __yajl_parse__, which
    // then needn't parse it again.
    let pending: { s: string; v: unknown } | null = null;

    const parse = (s: string): { v: unknown } | { err: string } => {
        try {
            return {v: JSON.parse(s)};
        } catch (err) {
            return {err: `InvalidJSONInput: ${err instanceof Error ? err.message : String(err)}`};
        }
    };

    // Fast path. Returns the chunk source (always starting with CHUNK_PROLOGUE),
    // an error message for Yajl.lua to raise, or null when the document must go
    // through __yajl_parse__ instead.
    lua.global.set('__yajl_parse_src__', (s: unknown): string | null => {
        pending = null;
        const text = String(s ?? '');
        const r = parse(text);
        if ('err' in r) return r.err;
        const chunk = luaChunkForValue(r.v);
        if (chunk !== null) return chunk;
        if (jsonDepth(r.v) > MAX_DECODE_DEPTH) return DECODE_DEPTH_ERROR;
        pending = {s: text, v: r.v};
        return null;
    });

    // Raw path: returns the value, or nil plus an error message. A raw binding
    // must not throw across the trampoline, so Yajl.lua raises the error.
    registerRawGlobal('__yajl_parse__', (L) => {
        const text = api.lua_tolstring(L, 1, null) ?? '';
        let v: unknown;
        if (pending && pending.s === text) {
            v = pending.v;
        } else {
            const r = parse(text);
            if ('err' in r) {
                api.lua_pushnil(L);
                api.lua_pushstring(L, r.err);
                return 2;
            }
            v = r.v;
        }
        pending = null;
        if (pushJsonValue(api, L, v)) return 1;
        api.lua_pushnil(L);
        api.lua_pushstring(L, DECODE_DEPTH_ERROR);
        return 2;
    });

    return {
        pushValue: (L, value) => pushJsonValue(api, L, value),
    };
}
