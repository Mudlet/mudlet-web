import type { Lua } from 'wasmoon-lua5.1';
import type { ScriptingAPI } from '../../ScriptingAPI';
import type { ExitWeightFilterResult } from '../../../map/pathfinding';
import type { ProfileVFS } from '../../vfs/ProfileVFS';

/** wasmoon doesn't re-export its opaque lua_State pointer type; derive it from
 *  the public API so raw lua_* bindings can be typed without reaching into the
 *  package internals. Mirrors the alias in LuaRuntime. */
export type LuaState = Lua['global']['address'];

/** What a `registerMapInfo` callback yields once evaluated on the Lua side. */
export interface MapInfoEvaluation {
    text: string;
    isBold: boolean;
    isItalic: boolean;
    color?: { r: number; g: number; b: number };
}

/**
 * The slice of {@link LuaRuntime} internals that the extracted binding modules
 * are allowed to touch.
 *
 * Historically every Mudlet global was registered inside a single 3,700-line
 * `LuaRuntime.setup()`, so each binding closed over `this` and could reach any
 * private field. Splitting those registrations into per-domain modules needs a
 * deliberate seam: this interface *is* that seam. Anything a binding module
 * needs from the runtime is declared here, which keeps the dependency surface
 * visible (and reviewable) instead of implicit.
 *
 * Mutable runtime state is exposed as accessor methods rather than fields —
 * a plain field copy would snapshot the value at context-construction time and
 * miss every later mutation (`nextTempId`, the match arrays, and the callback
 * id counters are all reassigned during normal operation).
 */
export interface BindingContext {
    /** The live Lua VM. Bindings register globals via `lua.global.set(...)`. */
    readonly lua: Lua;
    /** The bridge into MUD sends, windows, timers, sound, the map, and so on. */
    readonly api: ScriptingAPI;

    /**
     * Coerce a Lua-passed value to an integer colour channel in 0..255,
     * returning null when it is non-finite or out of range. Mudlet validates
     * each channel this way and silently no-ops on a bad one, so callers treat
     * null as "leave the pen alone".
     *
     * Shared rather than per-module: nine different binding domains (labels,
     * borders, env colours, room highlights, sounds, …) validate channels.
     */
    channel(v: unknown): number | null;

    /**
     * Invoke a Lua callback previously registered through `__mudlet_register_cb`.
     * `what` names the call site and is used only to attribute errors.
     */
    dispatchCb(id: number, what: string): void;

    /** Release a registered Lua callback slot so its chunk can be collected. */
    releaseCb(id: number): void;

    /** Raise a Mudlet event on the Lua side (deferred if a dispatch is live). */
    emitEvent(name: string, args: unknown[]): void;

    /** This profile's virtual filesystem, or null before one is mounted.
     *  Never reassigned after the runtime is constructed, so a plain reference
     *  is safe here. */
    readonly vfs: ProfileVFS | null;

    /** Drop a Lua-side callback registration by id (the registry slot behind
     *  `__mudlet_register_cb`). Distinct from {@link releaseCb}, which goes
     *  through Lua; this is the direct JS-side removal. */
    unregisterCb(cbId: number): void;

    /** Marshal a JS value onto the Lua stack. Used by the raw lua_CFunction
     *  getters that return tables too large to round-trip through wasmoon's
     *  automatic conversion. */
    pushJsValue(L: LuaState, value: unknown, depth?: number): void;

    /** Register a global implemented as a raw lua_CFunction rather than a
     *  wasmoon-wrapped JS function. */
    registerRawGlobal(name: string, fn: (L: LuaState) => number): void;

    /** Callback-registry ids for `setCmdLineAction` handlers bound to overlay
     *  command lines (createCommandLine widgets), keyed by widget name. Held so
     *  a re-bind or a delete can free the previous Lua registry slot instead of
     *  leaking it. Mutated in place and never reassigned, so a reference is
     *  enough. */
    readonly overlayCmdLineActionCbIds: Map<string, number>;

    /** Run a registerMapInfo callback and read back what it produced. */
    evaluateMapInfo(
        cbId: number,
        roomId: number | null,
        selectionSize: number,
        areaId: number,
        displayedAreaId: number,
    ): MapInfoEvaluation | null;

    /** Run a `setExitWeightFilter` callback for one candidate exit and read
     *  back its verdict. Called from inside findPath — i.e. re-entrantly,
     *  while Lua is already suspended in the `__getPath` JS call. */
    evaluateExitWeightFilter(
        cbId: number,
        roomId: number,
        exitCommand: string,
    ): ExitWeightFilterResult;
}
