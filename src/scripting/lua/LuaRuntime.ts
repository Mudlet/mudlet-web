import {Lua, LuaReturn, LUA_REGISTRYINDEX, type LuaThread} from 'wasmoon-lua5.1';
// Self-host the Lua interpreter WASM as a build asset. Without this, wasmoon
// fetches liblua5.1.wasm from unpkg.com at runtime (its hardcoded default) —
// a third-party supply-chain + availability risk for the executable that runs
// all Lua scripting. The `?url` import makes Vite copy it into the bundle and
// hand back a base-aware same-origin URL we pass as `customWasmUri` below.
import luaWasmUrl from 'wasmoon-lua5.1/dist/liblua5.1.wasm?url';
import {unzip, strFromU8} from 'fflate';
import type {IScriptingRuntime, CaptureSpan, LuaGlobalEntry} from '../IScriptingRuntime';
import type {ScriptingAPI} from '../ScriptingAPI';
import type {ProfileVFS} from '../vfs/ProfileVFS';
import UTF8 from './utf8.lua?raw';
import VFS_LUA from './VFS.lua?raw';
import LUAGLOBAL from './LuaGlobal.lua?raw';
import BRIDGE_LUA from './Bridge.lua?raw';
import EXEC_LUA from './Exec.lua?raw';
import LUA_GLOBAL_SETUP from './LuaGlobalSetup.lua?raw';
import LUASQL_LUA from './Luasql.lua?raw';
import {encodeRowsToLuaSource} from './sqlRowEncoder';
import YAJL_LUA from './Yajl.lua?raw';
import {setupRex} from './rex';
import {setupYajl, type LuaValueTransform} from './yajl';
import {parseImageSize} from './imageSize';
import {isQtResourcePath, qtResourceBytes} from '../../assets/qt-resources';
import {getSqliteClient, sqliteReady} from '../../db/sqliteClient';
import {QT_CURSOR_NAME_TO_INT, QT_CURSOR_TO_CSS} from '../../ui/labels/cursorShapes';
import {qtKeyToDomCode, qtModifiersToList, domCodeToQtKey, listToQtModifiers} from '../../mud/keybindings/qtKeys';
import xterm256 from '../../mud/text/xterm256';
import {HttpService} from '../http/HttpService';
import {TtsManager} from '../../ui/tts/TtsManager';
import {GlobalEventChannel} from '../GlobalEventChannel';
import {type MudletVariable, normalizeVariableTree} from '../../import/mudletVariables';
import type {BindingContext} from './bindings/context';
import {installSoundBindings, installVideoBindings, installTtsBindings} from './bindings/media';
import {installMapBindings} from './bindings/map';
import {installWindowBindings} from './bindings/window';
import {installCursorBindings} from './bindings/cursor';
import {installAutomationBindings} from './bindings/automation';
import {installPackageBindings} from './bindings/packages';
import {installOutputBindings} from './bindings/output';
import {installTextEditBindings} from './bindings/textEdit';
import {installCommandLineBindings} from './bindings/commandLine';
import {installDiagnosticsBindings} from './bindings/diagnostics';
import {installSessionBindings} from './bindings/session';
import {installUserWindowBindings} from './bindings/userWindows';

// wasmoon doesn't re-export its opaque lua_State pointer type; derive it from
// the public API so the raw lua_* bindings (see pushJsValue / registerRawGlobal)
// can be typed without reaching into the package internals.
type LuaState = Lua['global']['address'];

// A handler suspended mid-invokeFileDialog (see parkDialogThread). The thread
// is anchored in the Lua registry via `ref` so it survives being popped off
// the global stack while the picker is open.
interface ParkedDialogThread {
    thread: LuaThread;
    /** Registry ref (luaL_ref) keeping the suspended thread alive. */
    ref: number;
    label: string;
    /** 'exec' threads finish with __exec's (err, result) tuple on their stack;
     *  'chunk' threads (dispatch chunks) return nothing meaningful. */
    kind: 'exec' | 'chunk';
}

// All *.lua and *.json files under mudlet-lua/ are served via the VFS at
// /lua/<relative-path>. Adding a new file to the directory tree automatically
// makes it available to dofile() / io.open(). JSON files ship the translation
// data Mudlet's loadTranslations() reads (e.g. /lua/translations/mudlet-lua.json).
const MUDLET_LUA_FILES = import.meta.glob('./mudlet-lua/**/*.{lua,json}', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

// Mudlet's busted *_spec.lua suite + the vendored busted runtime, bundled ONLY
// when VITE_BUSTED=1 so production builds tree-shake the test corpus out. Both
// are registered into the same /lua/ VFS namespace as MUDLET_LUA_FILES and
// resolved by require() via the package.loaders[2] VFS loader. The runner is
// exposed to the browser as window.__runBusted in flagged builds. See
// src/scripting/lua/busted/VENDORED.md.
const BUSTED_ENABLED = !!(import.meta.env as Record<string, unknown>).VITE_BUSTED;
const BUSTED_FILES = BUSTED_ENABLED
    ? (import.meta.glob('./busted/**/*.lua', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    : {};
const SPEC_FILES = BUSTED_ENABLED
    ? (import.meta.glob('./specs/**/*_spec.lua', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    : {};

// VFS spec paths the busted runner can target (e.g. /lua/specs/StringUtils_spec.lua).
const bustedSpecVfsPaths = (): string[] =>
    Object.keys(SPEC_FILES).map(p => `/lua/specs/${p.slice('./specs/'.length)}`);

// Mudlet's HTTP APIs accept Lua header tables of the shape
// `{["Header-Name"] = "value"}`. wasmoon hands these in as a Proxy-wrapped
// LuaTable — Object.keys/bracket access fall through to the JS instance's
// own props (alive/thread/ref/pointer) and the proxy `get` handler tries to
// .bind() the boolean, which throws. $detach(DictType.Object=1) materializes
// the actual Lua keys into a plain object.
/**
 * HTTP headers as sent over from Bridge.lua: a flat "k\1v\1k\1v" string, or nil
 * when there are none.
 *
 * Deliberately *not* a Lua table. Reading one here meant wasmoon's `$detach`,
 * which traps the whole runtime with "memory access out of bounds" on some call
 * shapes — `postHTTP(data, url, headers, file)` with the optional file argument
 * present was one, so every upload with headers took the Lua state down. The
 * table is walked on the Lua side now (see `__mudix_headers_to_string`), where
 * it is an ordinary `pairs` loop.
 */
function luaTableToHeaders(h: unknown): Record<string, string> | undefined {
    if (typeof h !== 'string' || !h) return undefined;
    const parts = h.split('');
    const out: Record<string, string> = {};
    // Trailing odd element would mean a key with no value — drop it rather than
    // sending a header whose value is "undefined".
    for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
    return Object.keys(out).length ? out : undefined;
}

// Image MIME for a VFS path's extension, used when inlining a profile icon as
// a data: URI. Falls back to image/png for unknown extensions (most icons are
// PNG and browsers sniff the bytes anyway).
function imageMimeForPath(path: string): string {
    const ext = path.toLowerCase().split('.').pop() ?? '';
    switch (ext) {
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'svg': return 'image/svg+xml';
        case 'webp': return 'image/webp';
        case 'bmp': return 'image/bmp';
        case 'ico': return 'image/x-icon';
        case 'png': default: return 'image/png';
    }
}

// Encode raw image bytes as a self-contained data: URI. Profile icons are
// small, but chunk the fromCharCode call anyway to stay within its argument
// limit (same pattern as MudClient's binary-frame encoder).
function bytesToImageDataUrl(bytes: Uint8Array, path: string): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${imageMimeForPath(path)};base64,${btoa(binary)}`;
}


// Rebuild saved globals (Mudlet <VariablePackage>) into _G. The value tree is
// constructed on the Lua side so numeric table keys and nested/mixed-key tables
// keep full fidelity — a JS→Lua object coercion would stringify numeric keys and
// can't represent a table with both. `__mudix_var_payload` is the descriptor
// array (set from JS); iterated with pairs() so the 0-indexed table wasmoon makes
// from a JS array doesn't matter.
const RESTORE_VARS_LUA = `
local payload = __mudix_var_payload
local function build(d)
  local vt = d.valueType
  if vt == 'table' then
    local t = {}
    local kids = d.children
    if kids then
      for _, c in pairs(kids) do
        local key = c.name
        if c.keyKind == 'number' then key = tonumber(key) end
        t[key] = build(c)
      end
    end
    return t
  elseif vt == 'boolean' then
    return d.value == 'true'
  elseif vt == 'number' then
    return tonumber(d.value)
  else
    return d.value
  end
end
if payload then
  for _, d in pairs(payload) do
    if d.name ~= nil then _G[d.name] = build(d) end
  end
end
__mudix_var_payload = nil
`;

// Walk the save-listed globals out of _G into a descriptor tree and hand it back
// as JSON (via yajl, same Lua→JS path the busted bridge uses). keyType/valueType
// are read from Lua's own type(), so numeric vs string keys survive. `seen`
// breaks reference cycles (e.g. a table that points back at an ancestor, or _G
// itself) — cleared after each branch so a DAG (same table in sibling slots) is
// still fully captured.
const CAPTURE_VARS_LUA = `
local names = __mudix_save_list
local function capture(v, seen)
  local t = type(v)
  if t == 'table' then
    if seen[v] then return { valueType = 'table', children = {} } end
    seen[v] = true
    local children = {}
    for k, val in pairs(v) do
      local kt = type(k)
      if kt == 'string' or kt == 'number' then
        local child = capture(val, seen)
        if child then
          child.name = tostring(k)
          child.keyKind = kt
          children[#children + 1] = child
        end
      end
    end
    seen[v] = nil
    return { valueType = 'table', children = children }
  elseif t == 'boolean' then
    return { valueType = 'boolean', value = tostring(v) }
  elseif t == 'number' then
    return { valueType = 'number', value = tostring(v) }
  elseif t == 'string' then
    return { valueType = 'string', value = v }
  else
    return nil
  end
end
local out = {}
if names then
  for _, name in pairs(names) do
    local d = capture(_G[name], {})
    if d then
      d.name = name
      d.keyKind = 'string'
      out[#out + 1] = d
    end
  end
end
__mudix_save_list = nil
return yajl.to_string(out)
`;

// Snapshot the set of global names that exist right after the runtime boots —
// the default Lua + Mudlet API namespace. Stored as a Lua set so listGlobals can
// flag those as built-ins (hidden by default in the Variables view, matching
// Mudlet, which only shows user-created variables). Run once at the end of init,
// before any saved-variable restore or user script adds globals. The set's own
// name starts with __mudix so it's excluded from the view.
const CAPTURE_BASELINE_LUA = `
__mudix_baseline = {}
for k in pairs(_G) do
  if type(k) == 'string' then __mudix_baseline[k] = true end
end
`;

// Enumerate globals for the Variables view as a full nested tree: name, Lua
// type, a scalar value preview, whether it's a table, and whether it's flaggable
// to save. Functions/userdata/threads are listed but not saveable (Mudlet greys
// them). Built-in globals (in __mudix_baseline) are flagged and NOT recursed —
// only user globals get their contents walked, so the payload stays bounded to
// user data while the view can expand any of it instantly (no re-fetch). `seen`
// breaks reference cycles.
const LIST_GLOBALS_LUA = `
local baseline = __mudix_baseline or {}
local function describe(v, recurse, seen)
  local t = type(v)
  local e = { valueType = t }
  if t == 'string' or t == 'number' or t == 'boolean' then
    e.value = tostring(v)
    e.saveable = true
  elseif t == 'table' then
    e.saveable = true
    e.isTable = true
    if recurse and not seen[v] then
      seen[v] = true
      local kids = {}
      for k, val in pairs(v) do
        local kt = type(k)
        if kt == 'string' or kt == 'number' then
          local c = describe(val, true, seen)
          c.name = tostring(k)
          c.keyKind = kt
          kids[#kids + 1] = c
        end
      end
      seen[v] = nil
      e.children = kids
    end
  else
    e.saveable = false
  end
  return e
end
local out = {}
for k, v in pairs(_G) do
  if type(k) == 'string' and k:sub(1, 7) ~= '__mudix' then
    local isBuiltin = baseline[k] == true
    local e = describe(v, not isBuiltin, {})
    e.name = k
    e.builtin = isBuiltin
    out[#out + 1] = e
  end
end
return yajl.to_string(out)
`;

// Coerce a yajl-decoded global entry into a well-formed LuaGlobalEntry. yajl
// can't tell an empty Lua table from an empty array, so an empty `children`
// arrives as `{}`; normalise those to arrays (and recurse).
function normalizeGlobalEntry(raw: unknown): LuaGlobalEntry {
    const o = (raw ?? {}) as Record<string, unknown>;
    const entry: LuaGlobalEntry = {
        name: String(o.name ?? ''),
        valueType: String(o.valueType ?? 'nil'),
        saveable: !!o.saveable,
    };
    if (o.value !== undefined) entry.value = String(o.value);
    if (o.isTable) entry.isTable = true;
    if (o.builtin) entry.builtin = true;
    if (o.keyKind) entry.keyKind = String(o.keyKind);
    if (Array.isArray(o.children) && o.children.length) {
        entry.children = o.children.map(normalizeGlobalEntry);
    }
    return entry;
}

export class LuaRuntime implements IScriptingRuntime {

    // Temp alias/trigger IDs → { kill fn, type }. Engines return unsub, not
    // numeric IDs; the type lets exists(id, "alias"/"trigger") recognise
    // script-created temp items the way Mudlet does.
    // Script-created (temp) aliases and triggers, by the id handed back to Lua.
    //  backs enableTrigger/disableTrigger/isActive with a numeric id —
    // Mudlet toggles temp items exactly like saved ones, so the dispatch checks
    // it before firing.
    private readonly tempIds = new Map<number, { kill: () => void; type: 'alias' | 'trigger'; enabled: boolean }>();
    private nextTempId = 1;
    // Tracks label callback ids per slot so re-binds can free the prior Lua-
    // registry slot via __mudix_unregister_cb (avoids the leak the audit flagged
    // for setLabelClickCallback). Outer key: label name, inner key: slot id
    // ("click", "doubleClick", "release", ...). Value: registered cb id or 0
    // when cleared.
    private readonly labelCbIds = new Map<string, Map<string, number>>();
    // Mudlet setCmdLineAction installs at most one Enter-interceptor. Track its
    // cb id so a re-bind frees the prior chunk (same leak fix as label cbs).
    private cmdLineActionCbId = 0;
    // Per-userwindow setCmdLineAction cb ids — same leak-free re-bind logic but
    // keyed by window name. Bound when setCmdLineAction targets a userwindow
    // command line (vs the main command bar). Cleared on disableCommandLine /
    // resetCmdLineAction(name) and when the window is closed.
    private windowCmdLineActionCbIds = new Map<string, number>();
    // Per-overlay-cmd-line setCmdLineAction cb ids. Same role as
    // windowCmdLineActionCbIds but keyed by createCommandLine names. Cleared on
    // resetCmdLineAction(name) and when the cmd line is deleted.
    private overlayCmdLineActionCbIds = new Map<string, number>();
    // [fullMatch, cap1, cap2, ...]; an entry is `undefined` for a capture group
    // that didn't participate (→ nil in the Lua `matches` table, Mudlet parity).
    private currentMatches: (string | undefined)[] = [];
    // selectCaptureGroup needs the actual offset of each capture in the
    // source line; without these spans it falls back to selectString(text, 1)
    // which picks the wrong occurrence when the captured text repeats.
    // Indexed as [cap1Span, cap2Span, ...] — explicit captures only, no
    // full-match entry. Empty when matches come from a non-PCRE source.
    private currentCaptureSpans: CaptureSpan[] = [];
    private currentNamedSpans: Record<string, CaptureSpan> = {};
    // Span of the whole regex match (Mudlet's `selectCaptureGroup(1)` target).
    // Null when the matcher can't produce one (e.g. a perm substring trigger
    // doesn't report a position) — selectCaptureGroup(1) then falls back to
    // selectString on currentMatches[0].
    private currentFullMatchSpan: CaptureSpan | null = null;
    private _denyCurrentSend = false;
    private destroyed = false;
    // Mudlet addFileWatch / removeFileWatch — set of resolved absolute VFS
    // paths. Mutations through the __vfs_* hooks below call
    // notifyVfsPathChange() which fires sysPathChanged. Browser has no native
    // FS notifier, so this only catches Lua-driven changes; external edits to
    // a linked folder still need a ProfileVFS.resync() to be observed.
    private readonly watchedPaths = new Set<string>();
    // Emscripten function-table slots allocated by registerRawGlobal() for the
    // raw lua_CFunction map getters. Freed in destroy() so a profile/connection
    // switch doesn't leak table entries across runtime lifecycles.
    private readonly rawFnPtrs: number[] = [];
    private http!: HttpService;
    // Web Speech text-to-speech backend (Mudlet ttsSpeak/ttsQueue/...). Raises
    // tts* state + change events through emitEvent, same as HttpService.
    private tts!: TtsManager;
    // Cross-tab transport for raiseGlobalEvent — broadcasts to other profiles'
    // tabs; incoming events dispatch locally through emitEvent.
    private globalEvents!: GlobalEventChannel;
    // Set by setupSqlBridge — forces every debounced SQL VFS snapshot to write
    // immediately. Called from saveProfile() so user code can ensure SQL state
    // is durable before the default 500 ms debounce window elapses.
    private flushPendingSqlSnapshots: () => void = () => {};
    // Same JSON→Lua remap yajl uses (1-indexed arrays, null sentinel).
    // Captured here so setGmcpValue can shape incoming GMCP payloads
    // identically to Mudlet's `gmcp` global.
    private toLuaValue: LuaValueTransform = v => v;

    private constructor(
        private readonly lua: Lua,
        private readonly api: ScriptingAPI,
        private vfs: ProfileVFS | null = null,
        private readonly proxyUrlGetter: () => string | undefined = () => undefined,
    ) {
    }

    static async create(
        api: ScriptingAPI,
        vfs: ProfileVFS | null = null,
        proxyUrlGetter: () => string | undefined = () => undefined,
    ): Promise<LuaRuntime> {
        const lua = await Lua.create({ customWasmUri: luaWasmUrl });
        const rt = new LuaRuntime(lua, api, vfs, proxyUrlGetter);
        await rt.setup();
        return rt;
    }

    private async setup(): Promise<void> {
        // echo([window,] text). Mudlet routes echo to labels when the target
        // name is a label — its HTML is replaced (not appended to).
        this.lua.global.set('echo', (a: string, b?: string) => {
            if (b !== undefined) {
                if (a === 'main') {
                    this.api.echo(b);
                } else if (this.api.labels.has(a)) {
                    this.api.labels.setHtml(a, b);
                } else {
                    this.api.echoToWindow(a, b);
                }
            } else {
                this.api.echo(a);
            }
        });

        // Native fast path for the color-echo family. The Lua wrapper installed
        // after LuaGlobal.lua (see FAST_COLOR_ECHO_LUA) calls this before falling
        // back to Mudlet's per-segment xEcho. Returns true iff handled natively.
        this.lua.global.set('__mudixFastColorEcho', (kind: unknown, win: unknown, str: unknown): boolean => {
            if (typeof kind !== 'string' || typeof win !== 'string' || typeof str !== 'string') return false;
            return this.api.fastColorEcho(kind, win, str);
        });

        // Format state — called by xEcho between text chunks.
        // Lua calling conventions:
        //   setFgColor([win,] r, g, b)
        //   setBgColor([win,] r, g, b, [a])
        // Mudlet validates each channel as integer 0..255; non-finite, negative,
        // or >255 inputs are rejected. We mirror that — invalid args produce a
        // silent no-op (Mudlet logs an error; we can't, so the caller sees the
        // pen unchanged on the next echo).
        const channel = (v: unknown): number | null => {
            const n = Number(v);
            if (!Number.isFinite(n)) return null;
            const i = Math.round(n);
            return i >= 0 && i <= 255 ? i : null;
        };

        // Mudlet user code passes Lua functions to the temp-item primitives.
        // Calling a wasmoon Lua-function proxy back from a JS callback fails
        // inside the WASM bridge ("attempt to call a number value"), so the Lua
        // wrappers stash the function in a Lua-side registry and pass a numeric
        // callback ID to JS instead. Declared up here (rather than beside the
        // timer bindings that first used them) because the binding modules
        // below take them through `bindings`.
        const dispatchCb = (cbId: number, label: string): void => this.dispatchCb(cbId, label);
        const releaseCb = (cbId: number): void => {
            try { this.lua.doStringSync(`__mudix_unregister_cb(${cbId})`); } catch {}
        };

        // Handle passed to the extracted binding modules (./bindings/*). See
        // BindingContext for why this is an explicit object rather than `this`.
        const bindings: BindingContext = {
            lua: this.lua,
            api: this.api,
            channel,
            dispatchCb,
            releaseCb,
            emitEvent: (name, args) => this.emitEvent(name, args),
            vfs: this.vfs,
            overlayCmdLineActionCbIds: this.overlayCmdLineActionCbIds,
            unregisterCb: (cbId) => this.unregisterCb(cbId),
            pushJsValue: (L, value, depth) => this.pushJsValue(L, value, depth),
            registerRawGlobal: (name, fn) => this.registerRawGlobal(name, fn),
            evaluateMapInfo: (cbId, roomId, selectionSize, areaId, displayedAreaId) =>
                this.evaluateMapInfo(cbId, roomId, selectionSize, areaId, displayedAreaId),
            evaluateExitWeightFilter: (cbId, roomId, exitCommand) =>
                this.evaluateExitWeightFilter(cbId, roomId, exitCommand),
        };

        this.lua.global.set('setFgColor', (winOrR: unknown, rOrG: unknown, gOrB?: unknown, b?: unknown) => {
            const hasWin = typeof winOrR === 'string';
            const r = channel(hasWin ? rOrG : winOrR);
            const g = channel(hasWin ? gOrB : rOrG);
            const bb = channel(hasWin ? b : gOrB);
            if (r === null || g === null || bb === null) return;
            this.api.setFgColor(r, g, bb, hasWin ? (winOrR as string) : undefined);
        });
        this.lua.global.set('setBgColor', (winOrR: unknown, rOrG: unknown, gOrB?: unknown, b?: unknown, alpha?: unknown) => {
            const hasWin = typeof winOrR === 'string';
            const r = channel(hasWin ? rOrG : winOrR);
            const g = channel(hasWin ? gOrB : rOrG);
            const bb = channel(hasWin ? b : gOrB);
            if (r === null || g === null || bb === null) return;
            const aRaw = hasWin ? alpha : b;
            const a = aRaw !== undefined ? channel(aRaw) : undefined;
            if (aRaw !== undefined && a === null) return;
            this.api.setBgColor(r, g, bb, a ?? undefined, hasWin ? (winOrR as string) : undefined);
        });
        // Mudlet overloads these: setBold(v) or setBold(win, v). Disambiguate by first-arg type.
        const styleSetter = (apply: (v: boolean, win?: string) => void) =>
            (a: unknown, b?: unknown) => {
                if (typeof a === 'string') apply(!!b, a);
                else apply(!!a);
            };
        this.lua.global.set('setBold',      styleSetter((v, w) => this.api.setBold(v, w)));
        this.lua.global.set('setItalics',   styleSetter((v, w) => this.api.setItalic(v, w)));
        this.lua.global.set('setUnderline', styleSetter((v, w) => this.api.setUnderline(v, w)));
        this.lua.global.set('setStrikeOut', styleSetter((v, w) => this.api.setStrikethrough(v, w)));
        this.lua.global.set('setOverline',  styleSetter((v, w) => this.api.setOverline(v, w)));
        this.lua.global.set('setReverse',   styleSetter((v, w) => this.api.setReverse(v, w)));
        this.lua.global.set('resetFormat', (_win?: string) => this.api.resetFormat(_win));

        // Mudlet setTextFormat(windowName, r1, g1, b1, r2, g2, b2, bold,
        // underline, italics, [strikeout], [overline], [reverse], [blinkMode]).
        // r1/g1/b1 is BACKGROUND, r2/g2/b2 is FOREGROUND (Mudlet quirk).
        // Boolean attrs accept boolean or number (non-zero = true) per Mudlet.
        // blinkMode is "none"/"slow"/"fast". Returns true on success, false when
        // the named window doesn't exist.
        const boolOrNum = (v: unknown): boolean => {
            if (typeof v === 'boolean') return v;
            if (typeof v === 'number') return v !== 0;
            return false;
        };
        this.lua.global.set('setTextFormat', (
            winName: unknown,
            r1: unknown, g1: unknown, b1: unknown,
            r2: unknown, g2: unknown, b2: unknown,
            bold: unknown, underline: unknown, italics: unknown,
            strikeout?: unknown, overline?: unknown, reverse?: unknown,
            blinkMode?: unknown,
        ) => {
            const clamp = (v: unknown): number =>
                Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
            const win = typeof winName === 'string' && winName && winName !== 'main' ? winName : undefined;
            const bg = { r: clamp(r1), g: clamp(g1), b: clamp(b1) };
            const fg = { r: clamp(r2), g: clamp(g2), b: clamp(b2) };
            const mode = typeof blinkMode === 'string'
                && (blinkMode === 'slow' || blinkMode === 'fast') ? blinkMode : 'none';
            return this.api.setTextFormat(
                win,
                bg, fg,
                boolOrNum(bold), boolOrNum(underline), boolOrNum(italics),
                boolOrNum(strikeout), boolOrNum(overline), boolOrNum(reverse),
                mode,
            );
        });
        this.lua.global.set('deselect', (win?: string) =>
            this.api.deselect(typeof win === 'string' ? win : undefined),
        );

        this.lua.global.set('getProfileName', () => this.api.profileName);
        // Mudlet getProfiles() — record keyed by profile name, each entry
        // { host, port, loaded, connected, description }. Bridge.lua rebuilds it
        // into a clean Lua table (wasmoon hands JS objects over as proxies).
        this.lua.global.set('__getProfiles', () => this.api.getProfiles());
        // Mudlet loadProfile(name) — open the named profile in a new tab + connect.
        this.lua.global.set('loadProfile', (name?: unknown) =>
            this.api.loadProfile(typeof name === 'string' ? name : ''),
        );
        // Mudlet getCharacterName() — mudix maps this to the profile name.
        this.lua.global.set('getCharacterName', () => this.api.getCharacterName());
        // Mudlet getMudletInfo() — echoes a diagnostic block, returns nothing.
        this.lua.global.set('getMudletInfo', () => { this.api.getMudletInfo(); });

        // Mudlet getCommandSeparator() — the profile's multi-command separator.
        this.lua.global.set('getCommandSeparator', () => this.api.getCommandSeparator());

        // Mudlet setConfig/getConfig. These are the *base* C++-equivalent
        // bindings; Other.lua wraps them to add the table-form and no-arg "dump
        // all" variants, capturing these as oldsetConfig/oldgetConfig — so they
        // MUST be bound before LuaGlobal.lua/Other.lua run (they are: this whole
        // block precedes the bundle doString calls). getConfig returns nil for
        // unknown keys; setConfig returns false for unknown/read-only keys.
        this.lua.global.set('getConfig', (key: unknown, useStringFormat?: unknown) =>
            this.api.getConfig(String(key ?? ''), !!useStringFormat));
        this.lua.global.set('setConfig', (key: unknown, value: unknown) =>
            this.api.setConfig(String(key ?? ''), value));
        // Which value type an option takes (or null for an unknown key) — the
        // Bridge.lua wrappers need it to tell Mudlet's raise-on-wrong-type apart
        // from its (nil, errMsg) refuse-on-bad-value.
        this.lua.global.set('__mudix_config_kind', (key: unknown) =>
            this.api.configKeyKind(String(key ?? '')));

        // Mudlet profile description (single free-text slot). The optional
        // profile-name argument of the Mudlet overloads is ignored — mudix is
        // single-profile.
        this.lua.global.set('getProfileInformation', () => this.api.getProfileInformation());
        this.lua.global.set('setProfileInformation', (a: unknown, b?: unknown) =>
            this.api.setProfileInformation(String((b !== undefined ? b : a) ?? '')));
        this.lua.global.set('clearProfileInformation', () => this.api.clearProfileInformation());

        // Mudlet profile icon (shown on the connection-selection screen).
        // setProfileIcon(path) takes a VFS image path; we read the bytes here and
        // inline them as a data: URI so the picker screen can render the icon
        // without mounting the profile VFS. Returns { ok, path } / { ok:false,
        // error } — the Bridge.lua wrapper reshapes it into Mudlet's
        // (true, path) / (false, errorMessage) multi-return.
        this.lua.global.set('__setProfileIcon', (path: unknown) => {
            const p = String(path ?? '');
            if (!p) return { ok: false, error: 'setProfileIcon: no icon path given' };
            if (!this.vfs) return { ok: false, error: 'setProfileIcon: no profile filesystem available' };
            let bytes: Uint8Array;
            try { bytes = this.vfs.readBinaryFile(p); }
            catch { return { ok: false, error: `setProfileIcon: cannot read "${p}"` }; }
            const uri = bytesToImageDataUrl(bytes, p);
            if (!this.api.setProfileIcon(uri)) return { ok: false, error: 'setProfileIcon: failed to store icon' };
            return { ok: true, path: p };
        });
        this.lua.global.set('getProfileIcon', () => this.api.getProfileIcon());
        this.lua.global.set('resetProfileIcon', () => this.api.resetProfileIcon());

        // Mudlet getImageSize(path) → width, height (or nil). We parse the
        // dimensions straight out of the VFS file's header (synchronous, unlike
        // new Image()). Returns a 0-indexed [w, h] array; Bridge.lua unpacks it.
        this.lua.global.set('__getImageSize', (path: unknown) => {
            const p = String(path ?? '');
            if (!p) return false;
            let bytes: Uint8Array | null;
            if (isQtResourcePath(p)) {
                // `:/…` addresses Mudlet's compiled-in Qt resources, not the
                // profile VFS — see src/assets/qt-resources.
                bytes = qtResourceBytes(p);
            } else {
                if (!this.vfs) return false;
                try { bytes = this.vfs.readBinaryFile(p); }
                catch { return false; }
            }
            if (!bytes) return false;
            const size = parseImageSize(bytes);
            return size ? [size.width, size.height] : false;
        });

        // Mudlet holdingModifiers(number) — exact match against the held
        // keyboard modifiers (Qt bitmask, as in mudlet.keymodifier).
        this.lua.global.set('holdingModifiers', (mods: unknown) => this.api.holdingModifiers(Number(mods)));

        this.lua.global.set('getEpoch', () => Date.now() / 1000);

        // Mudlet getOS() → osName, osVersion, [osType (Linux only)], processor.
        // We sniff the underlying OS so windows/mac-specific scripts behave. JS
        // hands back a 0-indexed array (length 3, or 4 on Linux); the Bridge.lua
        // wrapper unpacks it into Mudlet's multi-return. The first value is still
        // the platform name, so `getOS() == "windows"` comparisons keep working.
        this.lua.global.set('__getOS', () => this.api.getOSInfo());

        // ── Session introspection, events, and UI surface creation ─────────────
        // See ./bindings/session.ts and ./bindings/userWindows.ts. The cross-tab
        // event channel is built here because it needs this runtime's emitter and
        // the live profile name.
        this.globalEvents = new GlobalEventChannel(
            (event, args) => this.emitEvent(event, args),
            () => this.api.profileName,
        );
        installSessionBindings(bindings, this.globalEvents);
        installUserWindowBindings(bindings);

        // -- createTextEdit widgets --
        installTextEditBindings(bindings);

        // ── Labels ────────────────────────────────────────────────────────────
        // createLabel([window,] name, x, y, w, h, fillBackground [, clickThrough]).
        // Mudlet detects the optional window arg by counting; we use the second-
        // arg type because (string,string) ⇒ window form and (string,number) ⇒
        // no window. fillBackground/clickThrough accept booleans or numbers —
        // Mudlet's own createGauge passes `1` for fillBg and the documented API
        // is "0 (transparent) or 1 (filled)", so rejecting numbers breaks
        // gauges and scripts ported from Mudlet. Anything else raises a
        // bad-argument error matching Mudlet's shape.
        const boolArg = (v: unknown, who: string, argN: number, optional: boolean): boolean => {
            if (optional && (v === undefined || v === null)) return false;
            if (typeof v === 'boolean') return v;
            if (typeof v === 'number') return v !== 0;
            throw new Error(`${who}: bad argument #${argN} type (boolean expected, got ${typeof v})`);
        };
        this.lua.global.set('createLabel', (...args: unknown[]) => {
            const hasWindow = typeof args[0] === 'string' && typeof args[1] === 'string';
            const window = hasWindow ? (args[0] as string) : 'main';
            const i = hasWindow ? 1 : 0;
            const name = args[i] as string;
            const fill = boolArg(args[i + 5], 'createLabel', hasWindow ? 7 : 6, false);
            const clickThrough = boolArg(args[i + 6], 'createLabel', hasWindow ? 8 : 7, true);
            return this.api.labels.create(name, {
                parent: window === 'main' ? 'main' : window,
                // Truncated to whole pixels, as the C++ int parameters do in
                // Mudlet. Geyser hands over fractions routinely — a "20%"
                // constraint on a 632px window is 126.4 — and its own specs
                // assert the floored value comes back out of getWindowGeometry.
                x: Math.trunc(Number(args[i + 1])), y: Math.trunc(Number(args[i + 2])),
                width: Math.trunc(Number(args[i + 3])), height: Math.trunc(Number(args[i + 4])),
                fillBackground: fill,
                clickThrough,
            });
        });
        // Mudlet deleteLabel(name) → true on success, (false, errMsg) when the
        // label doesn't exist. Bridge.lua wraps the bool into the multi-return.
        // Raises sysLabelDeleted(name) on success, matching Mudlet.
        this.lua.global.set('__deleteLabel', (name: unknown) => {
            if (typeof name !== 'string') return false;
            const ok = this.api.labels.destroy(name);
            if (ok) this.emitEvent('sysLabelDeleted', [name]);
            return ok;
        });
        // setLabelStyleSheet(name, css) — Qt-style CSS string, applied to the
        // label DIV. Used by Mudlet's setGaugeStyleSheet via the _back/_front/_text
        // labels.
        // Returns true on success, false when the label doesn't exist; the
        // Bridge.lua wrapper turns the failure (and the empty-name case) into
        // Mudlet's (nil, errMsg) multi-return.
        this.lua.global.set('__setLabelStyleSheet', (name: unknown, css: unknown) => {
            if (typeof name !== 'string' || !this.api.labels.has(name)) return false;
            this.api.labels.setStyleSheet(name, css == null ? '' : String(css));
            return true;
        });
        // Mudlet getLabelStyleSheet(name) → the CSS string last set (or "" when
        // none). Returns "" for a missing label too, matching the Lua-side
        // getLabelFormat consumer which only branches on the empty string.
        this.lua.global.set('getLabelStyleSheet', (name: unknown) =>
            this.api.labels.getStyleSheet(typeof name === 'string' ? name : '') ?? '');
        // Mudlet setLinkStyle(labelName, linkColor, linkVisitedColor [, underline]).
        // underline defaults to true (matching Mudlet's TLabel). Colors are any
        // CSS color string; "" leaves that channel at the default.
        this.lua.global.set('setLinkStyle', (
            name: unknown, color?: unknown, visited?: unknown, underline?: unknown,
        ) => this.api.labels.setLinkStyle(
            String(name ?? ''),
            color == null ? '' : String(color),
            visited == null ? '' : String(visited),
            underline === undefined ? true : !!underline,
        ));
        // Mudlet resetLinkStyle(labelName) — clears a setLinkStyle override.
        this.lua.global.set('resetLinkStyle', (name: unknown) =>
            this.api.labels.resetLinkStyle(String(name ?? '')));
        // Mudlet getLabelSizeHint(name) → width, height. JS hands back a 0-indexed
        // [w, h] array (wasmoon convention) or false (no such label); Bridge.lua
        // unpacks it into the documented multi-return / (nil, errMsg) shape.
        this.lua.global.set('__getLabelSizeHint', (name: unknown) => {
            const s = this.api.getLabelSizeHint(typeof name === 'string' ? name : '');
            return s ? [s.width, s.height] : false;
        });
        // Mudlet's setLabelClickCallback / setLabelDoubleClickCallback /
        // setLabelReleaseCallback / setLabelMoveCallback / setLabelOnEnter /
        // setLabelOnLeave / setLabelWheelCallback all share a shape: name + a
        // Lua function (or `nil` to clear). Bridge.lua compiles the function
        // and hands JS a numeric cb id (via `__mudix_register_cb`); cb id 0
        // means "clear". We track the prior id per label-per-slot so a rebind
        // unregisters the prior chunk in `__mudix_cb` instead of leaking it.
        type LabelCbSlot = 'click' | 'doubleClick' | 'release' | 'move' | 'enter' | 'leave' | 'wheel';
        const setLabelCb = (
            name: string,
            slot: LabelCbSlot,
            cbId: number,
            install: (handler: ((event: unknown) => void) | undefined) => boolean,
        ): boolean => {
            let slots = this.labelCbIds.get(name);
            if (!slots) { slots = new Map(); this.labelCbIds.set(name, slots); }
            const prev = slots.get(slot) ?? 0;
            if (prev && prev !== cbId) this.unregisterCb(prev);
            if (!cbId) {
                slots.delete(slot);
                return install(undefined);
            }
            slots.set(slot, cbId);
            return install((event: unknown) =>
                this.dispatchCbWithArg(cbId, event, `label "${name}" ${slot}`));
        };

        this.lua.global.set('__mudix_setLabelClickCallback', (name: string, cbId: number) =>
            setLabelCb(name, 'click', cbId, fn => this.api.labels.setClickCallback(name, fn as never)));
        this.lua.global.set('__mudix_setLabelDoubleClickCallback', (name: string, cbId: number) =>
            setLabelCb(name, 'doubleClick', cbId, fn => this.api.labels.setDoubleClickCallback(name, fn as never)));
        this.lua.global.set('__mudix_setLabelReleaseCallback', (name: string, cbId: number) =>
            setLabelCb(name, 'release', cbId, fn => this.api.labels.setMouseUpCallback(name, fn as never)));
        this.lua.global.set('__mudix_setLabelMoveCallback', (name: string, cbId: number) =>
            setLabelCb(name, 'move', cbId, fn => this.api.labels.setMouseMoveCallback(name, fn as never)));
        this.lua.global.set('__mudix_setLabelOnEnter', (name: string, cbId: number) =>
            setLabelCb(name, 'enter', cbId, fn => this.api.labels.setMouseEnterCallback(name, fn as never)));
        this.lua.global.set('__mudix_setLabelOnLeave', (name: string, cbId: number) =>
            setLabelCb(name, 'leave', cbId, fn => this.api.labels.setMouseLeaveCallback(name, fn as never)));
        this.lua.global.set('__mudix_setLabelWheelCallback', (name: string, cbId: number) =>
            setLabelCb(name, 'wheel', cbId, fn => this.api.labels.setWheelCallback(name, fn as never)));
        // setLabelToolTip(name, text [, duration]) → bool. Mudlet returns false
        // when the named label doesn't exist; the duration arg is accepted for
        // compatibility but ignored — the DOM `title` attribute has no per-tip
        // duration. resetLabelToolTip clears the tooltip.
        this.lua.global.set('setLabelToolTip', (name: unknown, text?: unknown, _duration?: unknown) => {
            if (typeof name !== 'string') return false;
            return this.api.labels.setTooltip(name, text == null ? undefined : String(text));
        });
        this.lua.global.set('resetLabelToolTip', (name: unknown) => {
            if (typeof name !== 'string') return false;
            return this.api.labels.setTooltip(name, undefined);
        });
        // Runtime clickthrough toggle. Flips pointer-events live; the click
        // handler set via setLabelClickCallback stays installed either way.
        this.lua.global.set('enableClickthrough', (name: unknown) => {
            if (typeof name === 'string') this.api.labels.setClickThrough(name, true);
        });
        this.lua.global.set('disableClickthrough', (name: unknown) => {
            if (typeof name === 'string') this.api.labels.setClickThrough(name, false);
        });
        // Mudlet raiseWindow(name) / lowerWindow(name) — works on labels and
        // userwindows. For labels, each call bumps z past every other raised
        // label (or below every other lowered one). For userwindows, the call
        // restacks the floating window. Returns true if the target existed.
        const raiseAny = (name: unknown): boolean => {
            if (typeof name !== 'string') return false;
            if (this.api.labels.has(name)) { this.api.labels.raise(name); return true; }
            if (this.api.cmdLines.has(name)) { this.api.cmdLines.raise(name); return true; }
            if (this.api.scrollBoxes.has(name)) { this.api.scrollBoxes.raise(name); return true; }
            if (this.api.windows.has(name)) { this.api.windows.bringToFront(name); return true; }
            // A bare Geyser container identity (no real widget of its own —
            // e.g. Adjustable.Container's raiseAll() raises self.name before
            // each child). Mudlet's flat z-order has nothing to raise for it;
            // the per-child raises that follow carry the z. Return false, as
            // Mudlet's raiseWindow does for an unknown window.
            return false;
        };
        const lowerAny = (name: unknown): boolean => {
            if (typeof name !== 'string') return false;
            if (this.api.labels.has(name)) { this.api.labels.lower(name); return true; }
            if (this.api.cmdLines.has(name)) { this.api.cmdLines.lower(name); return true; }
            if (this.api.scrollBoxes.has(name)) { this.api.scrollBoxes.lower(name); return true; }
            if (this.api.windows.has(name)) { this.api.windows.sendToBack(name); return true; }
            return false;
        };
        this.lua.global.set('raiseWindow', raiseAny);
        this.lua.global.set('lowerWindow', lowerAny);
        // raiseLabel / lowerLabel are mudix-only legacy names. Mudlet doesn't
        // have them; ported scripts should use raiseWindow / lowerWindow. Kept
        // as aliases so existing user scripts don't break.
        this.lua.global.set('raiseLabel', raiseAny);
        this.lua.global.set('lowerLabel', lowerAny);
        // setLabelCursor(name, shape). The Mudlet GUIUtils.lua wrapper maps
        // string shape names (e.g. "PointingHand") to ints via mudlet.cursor
        // before calling here; we accept either form so the primitive works
        // even before GUIUtils.lua loads. shape -1 ('Reset') clears.
        this.lua.global.set('setLabelCursor', (name: unknown, shape: unknown) => {
            if (typeof name !== 'string') return;
            let n: number;
            if (typeof shape === 'string') {
                const lookup = QT_CURSOR_NAME_TO_INT[shape];
                if (lookup === undefined) {
                    this.api.labels.setCursor(name, undefined);
                    return;
                }
                n = lookup;
            } else {
                n = Number(shape);
            }
            if (n === -1 || Number.isNaN(n)) {
                this.api.labels.setCursor(name, undefined);
                return;
            }
            this.api.labels.setCursor(name, QT_CURSOR_TO_CSS[n] ?? 'default');
        });
        this.lua.global.set('resetLabelCursor', (name: unknown) => {
            if (typeof name === 'string') this.api.labels.setCursor(name, undefined);
        });
        // setLabelCustomCursor(name, cursorPath, [hotX, hotY]) — point a label's
        // cursor at a custom image. hotX/hotY are the hotspot in pixels; numbers
        // may arrive as capture strings, so coerce with Number().
        this.lua.global.set('setLabelCustomCursor', (name: unknown, path: unknown, hotX?: unknown, hotY?: unknown) => {
            if (typeof name !== 'string') return false;
            return this.api.setLabelCustomCursor(
                name,
                String(path ?? ''),
                hotX === undefined ? undefined : Number(hotX),
                hotY === undefined ? undefined : Number(hotY),
            );
        });

        // ── Label movies (Mudlet's QMovie family) ────────────────────────────
        // setMovie(labelName, pathToGif) — decode + install + start playing.
        this.lua.global.set('setMovie', (name: unknown, path: unknown) => {
            if (typeof name !== 'string' || name === '') return false;
            return this.api.setMovie(name, String(path ?? ''));
        });
        this.lua.global.set('startMovie', (name: unknown) => {
            return typeof name === 'string' && this.api.startMovie(name);
        });
        this.lua.global.set('pauseMovie', (name: unknown) => {
            return typeof name === 'string' && this.api.pauseMovie(name);
        });
        // Frame numbers / speed can arrive as capture strings — coerce.
        this.lua.global.set('setMovieFrame', (name: unknown, frame: unknown) => {
            return typeof name === 'string' && this.api.setMovieFrame(name, Number(frame));
        });
        this.lua.global.set('setMovieSpeed', (name: unknown, percent: unknown) => {
            return typeof name === 'string' && this.api.setMovieSpeed(name, Number(percent));
        });
        // scaleMovie(labelName, [autoscale]) — autoscale defaults to true.
        this.lua.global.set('scaleMovie', (name: unknown, autoscale?: unknown) => {
            return typeof name === 'string'
                && this.api.scaleMovie(name, autoscale === undefined ? true : autoscale !== false);
        });

        // Mudlet setAppStyleSheet(css, [tag]) — install or replace a CSS block
        // in document.head, then raise sysAppStyleSheetChange so theme scripts
        // can re-apply derivative styles. The optional `tag` lets multiple
        // independent stylesheets coexist (each is keyed in `<style>`'s id).
        this.lua.global.set('setAppStyleSheet', (css: unknown, tag?: unknown) => {
            return this.api.setAppStyleSheet(
                String(css ?? ''),
                tag != null ? String(tag) : undefined,
            );
        });

        // Mudlet setUserWindowStyleSheet(name, css) — install or replace a
        // per-window CSS block. `QWidget { … }` (the canonical Mudlet selector)
        // and bare declarations auto-scope to `[data-mudix-window="name"]`, so
        // a stylesheet like `QWidget { padding: 15 20; }` actually pads the
        // panel viewport. Script authors can also write the attribute selector
        // explicitly for rules that wouldn't be a plain QWidget block.
        this.lua.global.set('setUserWindowStyleSheet', (name: unknown, css: unknown) => {
            return this.api.setUserWindowStyleSheet(String(name ?? ''), String(css ?? ''));
        });

        // Mudlet setProfileStyleSheet(stylesheet) — install or replace a
        // profile-wide CSS block (browser: a dedicated <style> tag in
        // document.head, keyed apart from setAppStyleSheet).
        this.lua.global.set('setProfileStyleSheet', (css: unknown) => {
            return this.api.setProfileStyleSheet(String(css ?? ''));
        });

        // Mudlet setClipboardText(textContent) → bool. Updates the session text
        // clipboard and best-effort syncs to navigator.clipboard.
        this.lua.global.set('setClipboardText', (text: unknown) => {
            return this.api.setClipboardText(String(text ?? ''));
        });

        // Mudlet getClipboardText() → string. Returns the session text
        // clipboard (refreshing from the OS clipboard asynchronously).
        this.lua.global.set('getClipboardText', () => {
            return this.api.getClipboardText();
        });

        // No-op stubs for unimplemented label callbacks and the cmdline action
        // hook. mudlet-lua/GUIUtils.lua wraps each of these globals at load via
        // `_G[funcName] = wrapper(_G[funcName], ...)`; if the underlying global
        // is nil, the wrapper crashes with "attempt to call local 'callbackFunc'
        // (a nil value)" the first time user code calls it. Registering stubs
        // here gives the wrapper something callable so unrelated scripts load,
        // even though the callback itself does nothing yet.
        const stubWarned: Record<string, boolean> = {};
        // `result` is the value (or factory, for table returns that need a fresh
        // instance) handed back to Lua so the stub matches the documented return
        // of the real Mudlet function.
        const registerStub = (name: string, result?: unknown) => {
            this.lua.global.set(name, () => {
                if (!stubWarned[name]) {
                    stubWarned[name] = true;
                    console.warn(`[mudix] ${name} is not available in this client; call ignored.`);
                }
                return typeof result === 'function' ? (result as () => unknown)() : result;
            });
        };
        // setLabelDoubleClickCallback / setLabelReleaseCallback /
        // setLabelMoveCallback / setLabelWheelCallback / setLabelOnEnter /
        // setLabelOnLeave: real bindings installed in Bridge.lua over the
        // __mudix_setLabel* primitives above.

        // Warning-emitting no-op stubs for Mudlet APIs with no meaningful browser
        // implementation: Discord Rich Presence (needs the Discord SDK), the IRC
        // client (a separate external service), process spawning (no subprocess
        // in the sandbox) and Hunspell spell-check (no dictionary engine). These
        // must be *bound* — not left nil — so an imported Mudlet package that
        // touches one on load doesn't die with "attempt to call a nil value".
        // Each logs once and returns the value the real function would on a
        // no-op. See MUDLET_API.md "Not Applicable".
        const emptyTable = () => [] as unknown[];
        [
            // Discord Rich Presence — getters return nil, setters/reset no-op.
            'getDiscordDetail', 'setDiscordDetail',
            'getDiscordLargeIcon', 'setDiscordLargeIcon',
            'getDiscordLargeIconText', 'setDiscordLargeIconText',
            'getDiscordSmallIcon', 'setDiscordSmallIcon',
            'getDiscordSmallIconText', 'setDiscordSmallIconText',
            'getDiscordParty', 'setDiscordParty',
            'getDiscordState', 'setDiscordState',
            'getDiscordTimeStamps', 'setDiscordElapsedStartTime', 'setDiscordRemainingEndTime',
            'resetDiscordData',
            'setDiscordApplicationID', 'setDiscordGame', 'setDiscordGameUrl',
            'usingMudletsDiscordID',
            // IRC client actions — no IRC client in mudix.
            'openIRC', 'restartIrc', 'sendIrc',
            'setIrcChannels', 'setIrcNick', 'setIrcServer',
            // Spell-check dictionary mutators — no Hunspell.
            'addWordToDictionary', 'removeWordFromDictionary',
        ].forEach(name => registerStub(name));
        // Stubs whose real counterpart returns a non-nil value.
        registerStub('spawn', false);
        registerStub('spellCheckWord', true);          // treat every word as correct
        registerStub('spellSuggestWord', emptyTable);  // no suggestions
        registerStub('getDictionaryWordList', emptyTable);
        registerStub('getIrcChannels', emptyTable);
        registerStub('getIrcConnectedHost', '');
        registerStub('getIrcNick', '');
        registerStub('getIrcServer', '');

        // Mudlet setCmdLineAction([cmdLineName,] fn, [args...]). With no
        // cmdLineName (or "main") the binding targets the single main command
        // bar; with a userwindow name it targets that window's per-window
        // command line (enabled via enableCommandLine). JS receives a numeric
        // cb id; 0 clears. Prior cb ids are freed in __mudix_cb on rebind so
        // closures don't leak.
        this.lua.global.set('__mudix_setCmdLineAction', (cbId: number, windowName?: unknown) => {
            const name = typeof windowName === 'string' && windowName && windowName !== 'main' ? windowName : null;
            if (name && this.api.cmdLines.has(name)) {
                const prev = this.overlayCmdLineActionCbIds.get(name);
                if (prev && prev !== cbId) this.unregisterCb(prev);
                if (!cbId) {
                    this.overlayCmdLineActionCbIds.delete(name);
                    return this.api.cmdLines.setAction(name, null);
                }
                this.overlayCmdLineActionCbIds.set(name, cbId);
                return this.api.cmdLines.setAction(name, (text: string) => {
                    this.dispatchCbWithArg(cbId, text, 'setCmdLineAction');
                });
            }
            if (name) {
                const prev = this.windowCmdLineActionCbIds.get(name);
                if (prev && prev !== cbId) this.unregisterCb(prev);
                if (!cbId) {
                    this.windowCmdLineActionCbIds.delete(name);
                    return this.api.windows.setCmdLineAction(name, null);
                }
                this.windowCmdLineActionCbIds.set(name, cbId);
                return this.api.windows.setCmdLineAction(name, (text: string) => {
                    this.dispatchCbWithArg(cbId, text, 'setCmdLineAction');
                });
            }
            const prev = this.cmdLineActionCbId;
            if (prev && prev !== cbId) this.unregisterCb(prev);
            this.cmdLineActionCbId = cbId || 0;
            if (!cbId) {
                this.api.setCmdLineAction(null);
                return true;
            }
            this.api.setCmdLineAction((text: string) => {
                this.dispatchCbWithArg(cbId, text, 'setCmdLineAction');
            });
            return true;
        });
        this.lua.global.set('__mudix_resetCmdLineAction', (windowName?: unknown) => {
            const name = typeof windowName === 'string' && windowName && windowName !== 'main' ? windowName : null;
            if (name && this.api.cmdLines.has(name)) {
                const prev = this.overlayCmdLineActionCbIds.get(name);
                if (prev) this.unregisterCb(prev);
                this.overlayCmdLineActionCbIds.delete(name);
                return this.api.cmdLines.setAction(name, null);
            }
            if (name) {
                const prev = this.windowCmdLineActionCbIds.get(name);
                if (prev) this.unregisterCb(prev);
                this.windowCmdLineActionCbIds.delete(name);
                return this.api.windows.setCmdLineAction(name, null);
            }
            const prev = this.cmdLineActionCbId;
            if (prev) this.unregisterCb(prev);
            this.cmdLineActionCbId = 0;
            this.api.setCmdLineAction(null);
            return true;
        });

        // ── Map ───────────────────────────────────────────────────────────────
        // The full Mudlet map surface (view, rooms, areas, exits, labels,
        // highlights, selection, mapInfo, context menus) — see ./bindings/map.ts.
        installMapBindings(bindings);

        // Mudlet `addSupportedTelnetOption(option)`. Returns true if the
        // option is newly registered; false if it was already known or the
        // option byte is out of range.
        this.lua.global.set('addSupportedTelnetOption', (option: unknown) => {
            const n = Number(option);
            if (!Number.isFinite(n)) return false;
            return this.api.addSupportedTelnetOption(n);
        });

        // Mudlet `pauseSounds([channel])`. Stops all in-flight sound effects
        // (Web Audio source nodes can't truly pause), optionally filtered by
        // tag. Music isn't affected — stopMusic covers that path.
        this.lua.global.set('pauseSounds', (channel?: unknown) => {
            this.api.sounds.pauseSounds(typeof channel === 'string' ? channel : undefined);
        });

        // Mudlet `startLogging(state)`. Toggle the persistent session logger
        // for this profile. ProfileSession owns the SessionLogger lifecycle;
        // the API forwards through a registered toggler.
        this.lua.global.set('startLogging', (state?: unknown) => this.api.startLogging(!!state));
        // Mudlet `appendLog(text)`. Append an arbitrary line to the active log.
        this.lua.global.set('appendLog', (text?: unknown) => this.api.appendLog(String(text ?? '')));
        // Mudlet `getProfileTabNumber([name])`. Single-profile web app — always 1.
        this.lua.global.set('getProfileTabNumber', (_name?: unknown) => 1);
        // Mudlet `ioprint(...)`. Prints to stdout in desktop Mudlet; in the
        // browser the closest analogue is the devtools console.
        this.lua.global.set('ioprint', (...args: unknown[]) => {
            console.log(...args.map(a => (a == null ? '' : String(a))));
        });

        // Mudlet `tempColorTrigger(fg, bg, code)`. The trigger fires when the
        // current rendered line carries a span whose foreground / background
        // matches the requested ANSI palette index (or -1 for "any colour").
        // The actual colour scan lives in ScriptingAPI.currentLineMatchesColor
        // since it needs access to the line's AnsiAwareBuffer (the trigger
        // engine itself only sees plain text). Self-expires after
        // `expirationCount` fires.
        this.lua.global.set('__mudix_tempColorTrigger', (fg: unknown, bg: unknown, cbId: number, expirationCount?: number) => {
            const wantFg = Number(fg);
            const wantBg = Number(bg);
            const max = (typeof expirationCount === 'number' && expirationCount > 0) ? expirationCount : -1;
            const id = this.nextTempId++;
            let fires = 0;
            let killed = false;
            // Empty-string substring trigger fires once per line; the colour
            // check then runs against the live buffer to gate the callback.
            const unsub = this.api.triggers.addTemp('', () => {
                if (killed || this.tempIds.get(id)?.enabled === false) return;
                // matches[1] is the coloured RUN, not the whole line — the
                // empty-substring pattern this rides on has no match text of
                // its own, so the colour lookup supplies it.
                const run = this.api.currentLineColorMatch(wantFg, wantBg);
                if (run === null) return;
                this.setMatches([run]);
                dispatchCb(cbId, 'tempColorTrigger');
                fires++;
                if (max > 0 && fires >= max) {
                    killed = true;
                    unsub();
                    releaseCb(cbId);
                    this.tempIds.delete(id);
                }
            }, 'substring');
            this.tempIds.set(id, { kill: () => { unsub(); releaseCb(cbId); }, type: 'trigger', enabled: true });
            return id;
        });

        // Mudlet saveWindowLayout / loadWindowLayout. Captures the current
        // dock layout (window positions/sizes/docking + dock-area extents) to
        // a per-connection snapshot in persistent storage; loadWindowLayout
        // restores it (re-positions live windows, opens any saved-visible
        // windows that are currently closed). Both return false on failure
        // — saveWindowLayout when there's no active connection,
        // loadWindowLayout when no snapshot exists yet.
        this.lua.global.set('saveWindowLayout', () => this.api.saveWindowLayout());
        this.lua.global.set('loadWindowLayout', () => this.api.loadWindowLayout());


        // -- Console output and text formatting --
        installOutputBindings(bindings);

        // ── Send ─────────────────────────────────────────────────────────────
        // Mudlet `send(text, [echo=true]) → true`. Echo defaults to true.
        this.lua.global.set('send', (text: unknown, echo?: unknown) => {
            this.api.send(String(text ?? ''), echo == null ? true : !!echo);
            return true;
        });
        // Mudlet `sendGMCP(message, [what])`: the caller passes a single string
        // body (e.g. `Core.Supports.Add ["Char 1"]`), framed by IAC SB GMCP …
        // IAC SE. The optional second `what` arg is concatenated with a space
        // separator (Mudlet behaviour) so scripts can pass the package name
        // and payload separately.
        this.lua.global.set('sendGMCP', (message: unknown, what?: unknown) => {
            const body = String(message ?? '');
            const tail = what != null ? ' ' + String(what) : '';
            this.api.sendGmcp(body + tail);
        });
        // Mudlet `sendMSDP(variable [, value, ...])`. The Bridge.lua wrapper
        // packs the variadic values into a \x01-delimited string (wasmoon's
        // varargs handling is unreliable); we split them back here. Frames as
        // IAC SB MSDP MSDP_VAR var [MSDP_VAL val]... IAC SE.
        this.lua.global.set('__mudix_sendMSDP', (variable: unknown, valuesStr?: unknown) => {
            const v = String(variable ?? '');
            if (!v) return false;
            const s = valuesStr != null ? String(valuesStr) : '';
            const values = s.length === 0 ? [] : s.split('\x01');
            return this.api.sendMSDP(v, values);
        });
        // Mudlet `sendSocket(data)`: send literal bytes over the socket, no
        // telnet/encoding processing.
        // `sendSocket` itself is a Bridge.lua wrapper over __mudix_sendSocket,
        // which adds Mudlet's type check and (nil, errMsg) failure return.
        // Mudlet getServerEncoding/setServerEncoding/getServerEncodingsList —
        // the CHARSET (RFC 2066) decoder MudClient negotiates. The list is built
        // 1-indexed (sparse array → wasmoon lands it at t[1..n]).
        this.lua.global.set('getServerEncoding', () => this.api.getServerEncoding());
        this.lua.global.set('setServerEncoding', (name: unknown) => this.api.setServerEncoding(String(name ?? '')));
        this.lua.global.set('getServerEncodingsList', () => {
            const list = this.api.getServerEncodingsList();
            const out: string[] = [];
            for (let i = 0; i < list.length; i++) out[i + 1] = list[i];
            return out;
        });
        // Mudlet sendATCP(message) / sendTelnetChannel102(msg) — raw telnet
        // subnegotiations (options 200 and 102).
        // sendATCP takes an optional second `what`, appended after a space
        // exactly as Mudlet frames it (TLuaInterpreterNetworking.cpp). Argument
        // validation and the (nil, errMsg) contracts live in the Bridge.lua
        // wrappers; these primitives just report success as a boolean.
        this.lua.global.set('__mudix_sendATCP', (message: unknown, what?: unknown) => {
            const body = String(message ?? '');
            const tail = what != null && String(what) !== '' ? ' ' + String(what) : '';
            return this.api.sendATCP(body + tail);
        });
        this.lua.global.set('__mudix_sendTelnetChannel102', (msg: unknown) =>
            this.api.sendTelnetChannel102(String(msg ?? '')));
        this.lua.global.set('__mudix_sendSocket', (data: unknown) => this.api.sendSocket(String(data ?? '')));
        /** Whether the session currently has a live connection — drives the
         *  "not connected to game server" guards Mudlet applies before sending
         *  ATCP/GMCP/MSDP. */
        this.lua.global.set('__mudix_is_connected', () => this.api.getConnectionInfo().connected);
        // Mudlet reconnect() — disconnect and redial the last URL.
        this.lua.global.set('reconnect', () => this.api.reconnect());
        // Mudlet `feedTelnet(data)`: inject raw server bytes into the inbound
        // pipeline as if received from the MUD.
        // Returns the refusal message (or nil when the data was fed); the
        // Bridge.lua wrapper shapes that into Mudlet's (nil, errMsg) / true.
        this.lua.global.set('__feedTelnet', (data: unknown) => this.api.feedTelnet(String(data ?? '')));
        // Mudlet `loadReplay(fileName)` — play back a binary replay (.dat) from
        // the profile VFS. The format parse + chunk scheduling live in
        // MudSession; this binding just reads the bytes. Returns an
        // [ok, errMsg] tuple that Bridge.lua reshapes into Mudlet's documented
        // `true` / `(nil, errMsg)` multi-return.
        this.lua.global.set('__mudix_loadReplay', (path: unknown): [boolean, string] => {
            const p = typeof path === 'string' ? path : '';
            if (!p) return [false, 'a blank string is not a valid replay file name'];
            if (!this.vfs) return [false, 'no profile filesystem available'];
            let bytes: Uint8Array;
            try { bytes = this.vfs.readBinaryFile(p); }
            catch { return [false, `cannot read file "${p}"`]; }
            const err = this.api.loadReplay(bytes);
            return err ? [false, `unable to start replay, reason: '${err}'`] : [true, ''];
        });
        // Mudlet `receiveMSP(text)`: parse an MSP payload and dispatch its
        // sound/music commands as if the server had sent them.
        // The MSP-enabled guard and argument check live in the Bridge.lua
        // wrapper, matching Mudlet's order (enabled first, then type).
        this.lua.global.set('__mudix_receiveMSP', (data: unknown) => this.api.receiveMSP(String(data ?? '')));
        this.lua.global.set('__mudix_is_msp_enabled', () => this.api.isMspNegotiated());
        // Mudlet `disconnect()`: drop the current connection.
        this.lua.global.set('disconnect', () => { this.api.disconnect(); });
        // Mudlet `closeMudlet()`: mudix closes the active profile — disconnect
        // and return to the connection screen.
        this.lua.global.set('closeMudlet', () => { this.api.closeMudlet(); });
        // Mudlet `resetProfile()`: reload the whole profile (UI cleared, fresh
        // Lua VM, scripts re-run). The engine defers the actual reinit since it
        // closes this very lua_State — see ScriptingEngine.resetProfile.
        this.lua.global.set('resetProfile', () => { this.api.resetProfile(); });
        // Mudlet `exportAreaImage(areaID, filePath [, zLevel])`: render the area
        // to a PNG in the profile VFS. Returns a 0-indexed [ok, pathOrErr] array
        // that Bridge.lua unpacks into Mudlet's (bool[, errMsg]) multi-return.
        this.lua.global.set('__mudix_exportAreaImage', (areaId: unknown, filePath: unknown, zLevel?: unknown): [boolean, string] => {
            const aid = Number(areaId);
            if (!Number.isFinite(aid)) return [false, 'exportAreaImage: areaID must be a number'];
            const z = zLevel != null && zLevel !== '' ? Number(zLevel) : undefined;
            return this.api.exportAreaImage(
                Math.trunc(aid),
                String(filePath ?? ''),
                z != null && Number.isFinite(z) ? Math.trunc(z) : undefined,
            );
        });
        // Mudlet `clearVisitedLinks()`: forgets which clickable links have been
        // visited (Mudlet greys visited echoLink targets). mudix tracks no
        // visited-link state, so there is nothing to clear — a true no-op.
        this.lua.global.set('clearVisitedLinks', () => {});
        // Mudlet `connectToServer(host, port [, save])`: (re)connect through the
        // proxy; `save` persists host/port onto the active connection.
        // Argument validation and the invalid-port (nil, errMsg) return live in
        // the Bridge.lua wrapper, matching Mudlet's contract.
        this.lua.global.set('__mudix_connectToServer', (host: unknown, port?: unknown, save?: unknown) =>
            this.api.connectToServer(String(host ?? ''), port === undefined ? 23 : Number(port), !!save));
        // Cancels the in-flight sysDataSendRequest dispatch. Only meaningful while
        // a sysDataSendRequest handler is on the stack — flag is reset before each send.
        this.lua.global.set('denyCurrentSend', () => { this._denyCurrentSend = true; });

        // -- Command bar, command lines, and their context menu --
        installCommandLineBindings(bindings);

        // -- Packages and modules --
        installPackageBindings(bindings);

        // -- Script/trigger/alias/timer/key/button management --
        installAutomationBindings(bindings);

        // ── Async unzip ───────────────────────────────────────────────────────
        // Mudlet's unzipAsync is fire-and-forget: returns immediately, raises
        // sysUnzipDone(zipPath, destDir) on success or
        // sysUnzipError(zipPath, destDir) on failure. fflate's unzip uses Web
        // Workers internally on platforms that support them, falling back to
        // a chunked main-thread decode otherwise.
        this.lua.global.set('unzipAsync', (zipPath: string, destDir: string) => {
            this.runUnzipAsync(String(zipPath ?? ''), String(destDir ?? ''));
        });

        // ── File watches ──────────────────────────────────────────────────────
        // Mudlet addFileWatch(path)/removeFileWatch(path). Watches are matched
        // by resolved absolute path; the VFS mutation hooks above fire
        // sysPathChanged(path) when a watched file or any descendant of a
        // watched directory changes.
        this.lua.global.set('addFileWatch', (path: unknown): boolean => {
            const vfs = this.vfs;
            if (!vfs || typeof path !== 'string' || !path) return false;
            if (!vfs.exists(path)) return false;
            this.watchedPaths.add(vfs.resolvePath(path));
            return true;
        });

        this.lua.global.set('removeFileWatch', (path: unknown): boolean => {
            const vfs = this.vfs;
            if (!vfs || typeof path !== 'string' || !path) return false;
            return this.watchedPaths.delete(vfs.resolvePath(path));
        });

        // Mudlet saveProfile([location]). zustand state (scripts/aliases/etc.)
        // already auto-syncs to localStorage on every mutation; the work this
        // call adds is forcing pending VFS writes through to IndexedDB / the
        // linked folder. Synchronously snapshots any debounced SQL writes,
        // then kicks off vfs.flush() in the background. Returns the profile
        // path immediately so the Lua wrapper below can shape it as
        // (true, path). The optional `location` arg is accepted for
        // compatibility but ignored — there is no alternate save target.
        // Returns an [ok, path|errMsg] tuple synchronously. Async flush errors
        // can't be reported through the return — they raise `sysSaveProfileError`
        // (eventName, profilePath, errMsg) so user code can subscribe.
        this.lua.global.set('__mudix_saveProfile', (_location?: unknown): [boolean, string] => {
            this.flushPendingSqlSnapshots();
            const vfs = this.vfs;
            if (!vfs) return [false, 'saveProfile: no profile VFS available'];
            const path = vfs.profilePath ?? '';
            vfs.flush().catch(err => {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn('[saveProfile] vfs flush failed:', err);
                this.emitEvent('sysSaveProfileError', [path, msg]);
            });
            return [true, path];
        });

        // -- Line / cursor / scrollback inspection --
        installCursorBindings(bindings);

        // ── Temp callbacks (timer/alias/trigger/key) ──────────────────────────
        // The `dispatchCb` / `releaseCb` helpers these primitives run on are
        // declared at the top of setup() alongside the binding context.

        // ── Timers ────────────────────────────────────────────────────────────
        this.lua.global.set('__mudix_tempTimer', (seconds: number, cbId: number, repeating?: boolean) => {
            const isRepeat = repeating ?? false;
            return this.api.timers.addTemp(seconds, () => {
                dispatchCb(cbId, 'tempTimer');
                if (!isRepeat) releaseCb(cbId);
            }, isRepeat);
        });
        // Mudlet `killTimer(idOrName)`: numeric id kills a temp timer; a name
        // string removes a permanent timer (and any group sharing the name).
        this.lua.global.set('killTimer', (idOrName: number | string) =>
            typeof idOrName === 'string'
                ? this.api.killByName('timer', idOrName)
                : this.api.timers.killTimer(idOrName));

        // ── Aliases ───────────────────────────────────────────────────────────
        this.lua.global.set('__mudix_tempAlias', (pattern: string, cbId: number) => {
            const id = this.nextTempId++;
            const unsub = this.api.aliases.addTemp(pattern, (m: RegExpMatchArray) => {
                if (this.tempIds.get(id)?.enabled === false) return;
                this.setMatches(Array.from(m));
                dispatchCb(cbId, 'tempAlias');
            });
            this.tempIds.set(id, { kill: () => { unsub(); releaseCb(cbId); }, type: 'alias', enabled: true });
            return id;
        });
        this.lua.global.set('killAlias', (idOrName: number | string) => {
            if (typeof idOrName === 'string') return this.api.killByName('alias', idOrName);
            const entry = this.tempIds.get(idOrName);
            if (!entry) return false;
            entry.kill(); this.tempIds.delete(idOrName); return true;
        });

        // ── Triggers ──────────────────────────────────────────────────────────
        // Mudlet semantics:
        //   tempTrigger(pattern, fn, [expirationCount])              — substring match
        //   tempRegexTrigger(pattern, fn, [expirationCount])         — PCRE match
        //   tempExactMatchTrigger(pattern, fn, [expirationCount])    — full-line equality
        //   tempBeginOfLineTrigger(pattern, fn, [expirationCount])   — literal prefix (startsWith)
        // All share auto-expiration: positive N auto-removes the trigger after
        // N fires; -1/0/omitted = unlimited. The Bridge.lua wrappers dispatch
        // to one of the JS bindings below.
        const installTempTrigger = (
            pattern: string, cbId: number, kind: 'regex' | 'substring' | 'startOfLine' | 'exactMatch' | 'prompt',
            expirationCount: number | undefined, label: string,
        ) => {
            const id = this.nextTempId++;
            const max = (typeof expirationCount === 'number' && expirationCount > 0) ? expirationCount : -1;
            let fires = 0;
            let killed = false;
            let unsub: () => void = () => {};
            const kill = () => {
                if (killed) return;
                killed = true;
                unsub();
                releaseCb(cbId);
                this.tempIds.delete(id);
            };
            unsub = this.api.triggers.addTemp(pattern, (matches, spans, namedGroups) => {
                if (killed || this.tempIds.get(id)?.enabled === false) return;
                const prevSpans = this.currentCaptureSpans;
                const prevNamed = this.currentNamedSpans;
                const prevMatches = this.currentMatches;
                const prevFullMatchSpan = this.currentFullMatchSpan;
                this.currentMatches = matches;
                this.currentCaptureSpans = spans?.captureSpans ?? [];
                this.currentNamedSpans = spans?.namedSpans ?? {};
                this.currentFullMatchSpan = spans?.matchSpan ?? null;
                this.setMatches(matches, undefined, namedGroups);
                try {
                    dispatchCb(cbId, label);
                } finally {
                    this.currentMatches = prevMatches;
                    this.currentCaptureSpans = prevSpans;
                    this.currentNamedSpans = prevNamed;
                    this.currentFullMatchSpan = prevFullMatchSpan;
                }
                fires++;
                if (max > 0 && fires >= max) kill();
            }, kind);
            this.tempIds.set(id, { kill, type: 'trigger', enabled: true });
            return id;
        };
        this.lua.global.set('__mudix_tempTrigger', (pattern: string, cbId: number, expirationCount?: number) =>
            installTempTrigger(pattern, cbId, 'substring', expirationCount, 'tempTrigger'));
        this.lua.global.set('__mudix_tempRegexTrigger', (pattern: string, cbId: number, expirationCount?: number) =>
            installTempTrigger(pattern, cbId, 'regex', expirationCount, 'tempRegexTrigger'));
        this.lua.global.set('__mudix_tempExactMatchTrigger', (pattern: string, cbId: number, expirationCount?: number) =>
            installTempTrigger(pattern, cbId, 'exactMatch', expirationCount, 'tempExactMatchTrigger'));
        this.lua.global.set('__mudix_tempBeginOfLineTrigger', (pattern: string, cbId: number, expirationCount?: number) =>
            installTempTrigger(pattern, cbId, 'startOfLine', expirationCount, 'tempBeginOfLineTrigger'));
        // tempPromptTrigger(fn[, expirationCount]) — fires on every line the
        // server flags as a prompt (GA/EOR). No pattern; the empty string is a
        // placeholder the 'prompt' kind ignores.
        this.lua.global.set('__mudix_tempPromptTrigger', (cbId: number, expirationCount?: number) =>
            installTempTrigger('', cbId, 'prompt', expirationCount, 'tempPromptTrigger'));
        // tempLineTrigger(from, howMany, fn) — position-based, no pattern. Fires
        // on `howMany` lines starting `from` lines ahead (from=1 = next line),
        // then self-expires. The TriggerEngine handles the line countdown; here
        // we mirror it with a `fires` counter so the callback is released after
        // the final fire (or earlier via killTrigger).
        this.lua.global.set('__mudix_tempLineTrigger', (from: unknown, howMany: unknown, cbId: number) => {
            const id = this.nextTempId++;
            const total = Math.max(1, Math.trunc(Number(howMany)) || 1);
            let fires = 0;
            let killed = false;
            let unsub: () => void = () => {};
            const kill = () => {
                if (killed) return;
                killed = true;
                unsub();
                releaseCb(cbId);
                this.tempIds.delete(id);
            };
            unsub = this.api.triggers.addTempLine(Number(from), Number(howMany), (matches) => {
                if (killed || this.tempIds.get(id)?.enabled === false) return;
                this.setMatches(matches);
                dispatchCb(cbId, 'tempLineTrigger');
                fires++;
                if (fires >= total) kill();
            });
            this.tempIds.set(id, { kill, type: 'trigger', enabled: true });
            return id;
        });
        this.lua.global.set('killTrigger', (idOrName: number | string) => {
            if (typeof idOrName === 'string') return this.api.killByName('trigger', idOrName);
            const entry = this.tempIds.get(idOrName);
            if (!entry) return false;
            entry.kill(); this.tempIds.delete(idOrName); return true;
        });

        // ── Keys ──────────────────────────────────────────────────────────────
        // Mudlet `tempKey([modifier,] keyCode, fn)`. modifier is a Qt::Key-
        // boardModifier bitmask (default 0 = no modifier); keyCode is a
        // Qt::Key int. The Bridge.lua wrapper resolves the optional-modifier
        // overload before passing here.
        this.lua.global.set('__mudix_tempKey', (modifier: number, key: string | number, cbId: number, source?: string) => {
            const mods = qtModifiersToList(modifier);
            const keyCode = qtKeyToDomCode(key, modifier);
            // Keep the raw Qt key/modifier so getKeyCode() can report them back
            // unchanged (the Qt→DOM translation above is lossy).
            const qtKey = typeof key === 'number' ? key : (domCodeToQtKey(key) ?? 0);
            this.api.warnReservedTempKey(keyCode, mods, typeof source === 'string' && source ? source : undefined);
            return this.api.keys.addTemp(keyCode, mods, () => {
                dispatchCb(cbId, 'tempKey');
            }, { keyCode: qtKey, modifier });
        });
        this.lua.global.set('killKey', (idOrName: number | string) =>
            typeof idOrName === 'string'
                ? this.api.killByName('key', idOrName)
                : this.api.keys.killKey(idOrName));
        // Mudlet getKeyCode(idOrName) → keyCode, modifiers (Qt::Key int + modifier
        // mask), or (nil, errorMessage) when no binding matches. A non-number,
        // non-string argument is a hard error (matches Mudlet's arg validation).
        // JS returns a 0-indexed array; Bridge.lua unpacks it into the multi-return.
        this.lua.global.set('__getKeyCode', (arg: unknown) => {
            if (typeof arg !== 'number' && typeof arg !== 'string') {
                throw new Error('getKeyCode: bad argument #1 (key id number or name string expected)');
            }
            let info = this.api.keys.getKeyCode(arg);
            // A numeric id can also name a PERMANENT key (the id permKey
            // returned); the key engine indexes those by name only.
            if (!info && typeof arg === 'number') {
                const node = this.api.keyNodeByNumericId(arg);
                if (node) {
                    info = {
                        keyCode: domCodeToQtKey(node.key) ?? 0,
                        modifiers: listToQtModifiers(node.modifiers),
                    };
                }
            }
            if (!info) {
                return [null, typeof arg === 'number'
                    ? `getKeyCode: no key binding with id ${arg}`
                    : `getKeyCode: no key binding named '${arg}'`];
            }
            return [info.keyCode, info.modifiers];
        });

        // -- Error reporting, send/alias expansion --
        installDiagnosticsBindings(bindings);

        // ── Text manipulation ─────────────────────────────────────────────────
        this.lua.global.set('replace', (a: unknown, b?: unknown, c?: unknown) => {
            // Mudlet calling conventions:
            //   replace(with)
            //   replace(with, keepcolor)
            //   replace(window, with [, keepcolor])
            // Disambiguate the 2-arg form by typeof b: string ⇒ window form,
            // boolean ⇒ keepcolor form.
            let win: string | undefined;
            let text: string;
            let keepColor = false;
            if (c !== undefined) {
                win = a as string;
                text = String(b ?? '');
                keepColor = !!c;
            } else if (typeof b === 'string') {
                win = a as string;
                text = b;
            } else if (b !== undefined) {
                text = String(a ?? '');
                keepColor = !!b;
            } else {
                text = String(a ?? '');
            }
            this.api.replace(text, win, keepColor);
        });
        // Mudlet `selectCaptureGroup(groupNumber|groupName)`. Numeric form
        // selects group N (1-indexed; N=0 is invalid). Mudlet's convention:
        //   N=1 → full regex match (NOT the first capture)
        //   N=2 → first explicit capture
        //   N=k → (k-1)th explicit capture
        // Named form selects the (?<name>...) capture by name. Returns the
        // start column of the selection, or -1 if no such capture / unmatched.
        this.lua.global.set('selectCaptureGroup', (groupOrName: number | string) => {
            if (typeof groupOrName === 'number') {
                if (groupOrName < 1) return -1;
                if (groupOrName === 1) {
                    if (this.currentFullMatchSpan) {
                        if (this.currentFullMatchSpan.length === 0) return -1;
                        this.api.selectSection(this.currentFullMatchSpan.start, this.currentFullMatchSpan.length);
                        return this.currentFullMatchSpan.start;
                    }
                    // No span (substring/startOfLine perm trigger): pick the
                    // first textual occurrence of the matched text.
                    const text = this.currentMatches[0] ?? '';
                    return text ? this.api.selectString(text, 1) : -1;
                }
                // Group N>1 is the (N-1)th explicit capture. currentMatches is
                // [fullLine, cap1, cap2, ...], so the text sits at index N-1
                // and the span at N-2 in currentCaptureSpans (which holds only
                // explicit captures).
                const captureIdx = groupOrName - 1;
                if (captureIdx >= this.currentMatches.length) return -1;
                const text = this.currentMatches[captureIdx];
                const span = this.currentCaptureSpans[captureIdx - 1];
                if (!span) return text ? this.api.selectString(text, 1) : -1;
                if (span.length === 0) return -1;
                this.api.selectSection(span.start, span.length);
                return span.start;
            }
            const span = this.currentNamedSpans[groupOrName];
            if (!span || span.length === 0) return -1;
            this.api.selectSection(span.start, span.length);
            return span.start;
        });

        // ── Network ───────────────────────────────────────────────────────────
        // Mudlet `getNetworkLatency()` returns seconds (float). Our cached
        // value is in ms — convert to seconds for the script side. The cache
        // returns -1 when no measurement has been recorded yet; we propagate
        // that sentinel unchanged.
        this.lua.global.set('getNetworkLatency', () => {
            const ms = this.api.getNetworkLatency();
            return ms < 0 ? -1 : ms / 1000;
        });

        // ── HTTP / downloads ──────────────────────────────────────────────────
        // Mudlet's HTTP API is fire-and-forget. The service runs each request
        // in the background and reports completion via sysXxxHttpDone /
        // sysDownloadDone events; we route those through emitEvent so they
        // dispatch to user handlers the same as gmcp/connect/etc. Late-arriving
        // emits after destroy() are no-ops thanks to the `destroyed` guard.
        this.http = new HttpService(
            (event, args) => this.emitEvent(event, args),
            () => this.vfs,
            this.proxyUrlGetter,
        );
        // Mudlet HTTP APIs all return (true, url) immediately and then surface
        // success/error via sysXxxHttp* events. The JS bindings below just kick
        // off the background request; the (true, url) tuple is added by the
        // Bridge.lua wrappers that call these `__` primitives.
        // Mudlet refuses a malformed url locally — QUrl::fromUserInput(...) then
        // !isValid() — and returns (nil, "<fn>: url is invalid, reason: ...")
        // without issuing a request. Report the reason here (a real parser lives
        // on this side) and let the Bridge.lua wrappers shape the tuple. The
        // scheme test mirrors fromUserInput's leniency: a bare "localhost/x" is
        // a valid url that means http://localhost/x.
        this.lua.global.set('__mudix_url_invalid_reason', (url: unknown) => {
            const s = String(url ?? '').trim();
            if (!s) return 'empty url';
            try {
                new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : `http://${s}`);
                return false;
            } catch (e) {
                return e instanceof Error ? e.message : 'malformed url';
            }
        });
        // Mudlet opens the upload file before issuing the request and reports
        // (nil, "couldn't open '<path>'...") when it can't, without emitting an
        // error event (TLuaInterpreter.cpp, performHttpRequest). Checking here
        // rather than in HttpService matters for more than parity: the failure
        // there surfaced as a *synchronous* emit from inside a Lua→JS call,
        // which re-enters the Lua state mid-call and takes the whole runtime
        // down with a wasm "memory access out of bounds".
        this.lua.global.set('__mudix_upload_file_error', (file: unknown) => {
            const path = String(file ?? '');
            if (!path) return false;
            if (!this.vfs) return 'no profile VFS available for file upload';
            // exists(), not a trial read: the body gets read for real moments
            // later, and an upload is exactly the case where reading twice is
            // worth avoiding. A path that exists but still can't be read falls
            // through to HttpService's (now deferred) error event.
            return this.vfs.exists(path)
                ? false
                : `couldn't open '${path}', is the location correct and do you have permissions to it?`;
        });
        this.lua.global.set('__downloadFile', (saveTo: unknown, url: unknown) => {
            this.http.downloadFile(String(saveTo ?? ''), String(url ?? ''));
        });
        this.lua.global.set('__getHTTP', (url: unknown, headers?: unknown) => {
            this.http.getHTTP(String(url ?? ''), luaTableToHeaders(headers));
        });
        this.lua.global.set('__postHTTP', (data: unknown, url: unknown, headers?: unknown, file?: unknown) => {
            this.http.postHTTP(
                data == null ? null : String(data),
                String(url ?? ''),
                luaTableToHeaders(headers),
                file == null ? undefined : String(file),
            );
        });
        this.lua.global.set('__putHTTP', (data: unknown, url: unknown, headers?: unknown, file?: unknown) => {
            this.http.putHTTP(
                data == null ? null : String(data),
                String(url ?? ''),
                luaTableToHeaders(headers),
                file == null ? undefined : String(file),
            );
        });
        this.lua.global.set('__deleteHTTP', (url: unknown, headers?: unknown) => {
            this.http.deleteHTTP(String(url ?? ''), luaTableToHeaders(headers));
        });
        // Mudlet customHTTP(method, data, url, headers, [file]). The optional
        // file arg replaces `data` with the bytes read from the VFS path.
        this.lua.global.set('__customHTTP', (method: unknown, data: unknown, url: unknown, headers?: unknown, file?: unknown) => {
            this.http.customHTTP(
                String(method ?? ''),
                data == null ? null : String(data),
                String(url ?? ''),
                luaTableToHeaders(headers),
                file == null ? undefined : String(file),
            );
        });

        // ── Media: sounds, music, video, text-to-speech ───────────────────────
        // See ./bindings/media.ts. TtsManager is constructed here rather than in
        // that module because it needs the runtime's own event emitter; the
        // bindings themselves stay free of runtime internals.
        installSoundBindings(bindings);
        installVideoBindings(bindings);
        this.tts = new TtsManager((event, args) => this.emitEvent(event, args));
        installTtsBindings(bindings, this.tts);

        // -- Window geometry, borders, memory introspection --
        installWindowBindings(bindings);

        // ── Timers (extended) ─────────────────────────────────────────────────
        // Mudlet remainingTime(idOrName). Numeric arg → tempTimer id; string
        // arg → permanent timer name. -1 when no live timer matches.
        this.lua.global.set('remainingTime', (idOrName: unknown) => {
            if (typeof idOrName === 'number') return this.api.timers.remainingTime(idOrName);
            if (typeof idOrName === 'string') return this.api.timers.remainingTime(idOrName);
            return -1;
        });

        // Bootstrap chunks run sync — none of them yield. setupRex needs an
        // await for one-time PCRE wasm init; sqliteReady gates the SQL bridge
        // until the sqlite module has finished loading.
        this.lua.doStringSync(BRIDGE_LUA);
        await setupRex(this.lua);
        this.lua.doStringSync(EXEC_LUA);
        this.execModule(UTF8, 'utf8', 'utf8');

        // Built-in Lua files served read-only via the VFS at /lua/<relative-path>.
        // Derived from mudlet-lua/ directory; keys mirror the paths LuaGlobal.lua
        // constructs with luaGlobalPath="/lua" (e.g. /lua/3rdparty/Inspect.lua).
        const builtins = new Map(
            Object.entries(MUDLET_LUA_FILES).map(([p, src]) => {
                const rel = p.slice('./mudlet-lua/'.length);
                return [`/lua/${rel}`, src] as [string, string];
            })
        );
        // Vendored busted runtime + spec corpus (VITE_BUSTED builds only). Keyed
        // so require() resolves them: /lua/busted/core.lua, /lua/luassert/init.lua,
        // /lua/runBusted.lua, /lua/specs/<Name>_spec.lua, ...
        for (const [p, src] of Object.entries(BUSTED_FILES)) {
            builtins.set(`/lua/${p.slice('./busted/'.length)}`, src);
        }
        for (const [p, src] of Object.entries(SPEC_FILES)) {
            builtins.set(`/lua/specs/${p.slice('./specs/'.length)}`, src);
        }
        this.setupVFS(this.vfs, builtins);
        this.exec(VFS_LUA, 'VFS');
        this.exec(LUA_GLOBAL_SETUP, 'lua-globals-setup');
        await sqliteReady;
        this.setupSqlBridge();
        this.exec(LUASQL_LUA, 'Luasql');
        this.toLuaValue = setupYajl(this.lua).transform;
        this.exec(YAJL_LUA, 'Yajl');
        // lpeg (Mudlet 4.21 bundles the C library). The browser has no C lpeg, so
        // we register the pure-Lua LuLPeg port under package.loaded["lpeg"]. This
        // MUST run before LuaGlobal.lua, whose `if package.loaded["lpeg"] then lpeg
        // = require "lpeg" end` guard publishes the global. dofile (not require) —
        // bundled modules sit in the VFS at /lua/... but /lua isn't on package.path
        // outside busted builds, so LuaGlobal.lua loads its own 3rdparty/* the same
        // way. pcall-guarded so a load failure leaves lpeg nil (the prior
        // behaviour) rather than aborting runtime setup.
        this.exec(
            `do local ok, mod = pcall(dofile, "/lua/3rdparty/lulpeg.lua")
                 if ok and mod then package.loaded["lpeg"] = mod
                 else print("[mudix] lpeg (LuLPeg) failed to load: " .. tostring(mod)) end
             end`,
            'lpeg-register',
        );
        this.exec(LUAGLOBAL, 'LuaGlobal');
        this.installMudletLuaOverrides();
        this.installFastColorEcho();
        this.setupAnsiColorTable();
        // Record the default namespace so the Variables view can hide built-ins.
        // Must run after the bundle but before any user global is added.
        this.exec(CAPTURE_BASELINE_LUA, 'baseline-globals');

        if (BUSTED_ENABLED) this.setupBustedBridge();
    }

    // The two places the browser can't match Mudlet's own Lua, fixed up from the
    // outside so the vendored mudlet-lua/ tree stays a verbatim mirror of
    // upstream — same tactic as installFastColorEcho below, and the reason
    // re-syncing that tree can't silently drop a mudix change. Runs immediately
    // after LuaGlobal.lua, before any user script can observe either global.
    // See src/scripting/lua/mudlet-lua/SYNCED.md.
    private installMudletLuaOverrides(): void {
        this.exec(
            `-- MMCP is peer-to-peer chat over a direct TCP socket, which a browser tab
-- can't open. mmcp.* IS bound, as no-op stubs (Bridge.lua), so feature-detecting
-- scripts have to see it unsupported here or they'll happily call into them.
if mudlet and mudlet.supports then mudlet.supports.mmcp = false end

-- Other.lua's dispatchEventToFunctions guards every handler with pcall, and Lua
-- 5.1 cannot yield across pcall's C frame: an event handler that suspends on
-- invokeFileDialog dies there with "attempt to yield across metamethod/C-call
-- boundary". Swapping just THAT function's environment re-points its \`pcall\` at
-- the coroutine-aware Bridge.lua version, while every other global it reads
-- (showHandlerError, pairs, ...) falls through to _G untouched. Rebuilding the
-- closure instead would mean recreating \`handlers\`, a local upvalue of the
-- do-block Other.lua defines it in.
if __mudix_pcall_co and type(dispatchEventToFunctions) == 'function' then
  setfenv(dispatchEventToFunctions, setmetatable(
    { pcall = __mudix_pcall_co },
    -- __newindex too: a proxy env that only forwards reads would quietly
    -- swallow a global write, should upstream ever add one.
    { __index = _G, __newindex = _G }))
end`,
            'mudlet-lua-overrides',
        );
    }

    // Shadow the shared `xEcho` dispatcher (not decho/cecho/hecho themselves) so
    // that a colour echo tries the native fast path (__mudixFastColorEcho) and
    // falls back to the original xEcho for anything the fast path declines
    // (labels, style tags, combined fg/bg, backgrounds, unknown colour names,
    // trigger-time matched-line echo, etc). Wrapping xEcho — rather than the
    // public functions — is deliberate:
    //   * it keeps decho/cecho/hecho's function identities intact, which
    //     prefix()/suffix() depend on (GUIUtils' `insertFuncs` maps those exact
    //     identities to their insert variants), and
    //   * it only accelerates func == "echo"; insertText/echoLink/echoPopup and
    //     the label-HTML path route through the untouched original.
    // The bundled GUIUtils.lua is not modified. Runs after LuaGlobal.lua.
    private installFastColorEcho(): void {
        this.exec(
            `do
  local fast = __mudixFastColorEcho
  local orig_xEcho = xEcho
  local styleKind = { Decimal = 'decho', Color = 'cecho', Hex = 'hecho' }
  function xEcho(style, func, ...)
    if func == 'echo' then
      local kind = styleKind[style]
      if kind then
        local n = select('#', ...)
        local a, b = ...
        local win, str
        if n >= 2 and type(a) == 'string' and type(b) == 'string' then
          win, str = a, b
        elseif n >= 1 and type(a) == 'string' then
          win, str = 'main', a
        end
        if str ~= nil and fast(kind, win, str) then return end
      end
    end
    return orig_xEcho(style, func, ...)
  end
end
__mudixFastColorEcho = nil`,
            'fast-color-echo',
        );
    }

    // Seed color_table with the xterm-256 palette (ansi_000..ansi_255). Mudlet's
    // C++ does this; GUIUtils.lua only fills the *named* colours. ansi2decho,
    // closestColor and the colour-conversion helpers all read color_table
    // ["ansi_NNN"], so without these they produce wrong output. Sourced from
    // mudix's own xterm256 palette (shared with the ANSI renderer, so the table
    // matches what's actually drawn) and only set where unset, so a runtime/theme
    // override survives. Must run after LuaGlobal.lua creates color_table.
    private setupAnsiColorTable(): void {
        const triples = xterm256.map(hex => {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `{${r},${g},${b}}`;
        }).join(',');
        // The 16 base colours also get Mudlet's named aliases, in BOTH the
        // snake_case (ansi_light_red) and camelCase (ansiLightRed) conventions
        // Mudlet ships — keyed to indices 0..15. cecho/hecho conversions and
        // cecho2string reference these names.
        const named = [
            'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
            'light_black', 'light_red', 'light_green', 'light_yellow',
            'light_blue', 'light_magenta', 'light_cyan', 'light_white',
        ].flatMap((name, i) => {
            const camel = 'ansi' + name.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('');
            return [
                `  if not color_table["ansi_${name}"] then color_table["ansi_${name}"] = p[${i + 1}] end`,
                `  if not color_table["${camel}"] then color_table["${camel}"] = p[${i + 1}] end`,
            ];
        }).join('\n');
        this.exec(
            `do
  color_table = color_table or {}
  local p = {${triples}}
  for i = 0, ${xterm256.length - 1} do
    local k = string.format("ansi_%03d", i)
    if not color_table[k] then color_table[k] = p[i + 1] end
  end
${named}
end`,
            'ansi-color-table',
        );
    }

    /**
     * True when a script-created (temp) alias/trigger with this id is live and of
     * the given type. Backs exists(id, "alias"/"trigger") for temp items, which
     * don't live in the persisted store the way permanent items do.
     */
    tempItemExists(id: number, type: string): boolean {
        return this.tempIds.get(id)?.type === type;
    }

    /** enableTrigger/disableTrigger/enableAlias/disableAlias with a numeric id.
     *  False when no temp item of that id is live. */
    setTempItemEnabled(id: number, enabled: boolean): boolean {
        const entry = this.tempIds.get(id);
        if (!entry) return false;
        entry.enabled = enabled;
        return true;
    }

    /** Whether a live temp item is enabled — backs isActive(id, type). */
    tempItemEnabled(id: number): boolean {
        return this.tempIds.get(id)?.enabled === true;
    }

    // ── busted bridge (VITE_BUSTED builds only) ──────────────────────────────
    // Puts the vendored busted runtime + spec corpus on require()'s search path
    // and exposes window.__runBusted(pattern) -> results object. The runner is
    // driven through busted's programmatic core API (see runBusted.lua); results
    // round-trip as JSON via yajl so there's no DOM race for assertions.
    private setupBustedBridge(): void {
        // The mudlet-lua builtins are loaded by explicit dofile('/lua/...') paths,
        // so /lua was never on package.path. busted uses require(), so add it.
        this.lua.doStringSync('package.path = "/lua/?.lua;/lua/?/init.lua;" .. package.path');

        // ── waitForEvent's pump ───────────────────────────────────────────────
        // Mudlet's waitForEvent blocks in a nested QEventLoop, which keeps Qt
        // delivering timers while the Lua C function sits on the stack. A browser
        // cannot re-enter its event loop, and the whole busted run happens inside
        // one synchronous doStringSync — so a blocking wait would starve the very
        // setTimeout it waits on and could only ever time out.
        //
        // Instead Lua spins on this: each call fires the timers that have come
        // due (bypassing the blocked event loop) and then burns a short slice of
        // real time so the next ones become due. Busy-waiting is unavoidable —
        // any sleep would need the event loop we are blocking — but it is bounded
        // by the caller's timeout and only ever runs in a test build.
        //
        // Registered only here, so it ships in VITE_BUSTED builds alone; Mudlet
        // likewise gates waitForEvent behind MUDLET_TEST_MODE.
        // Clock readings are relative to this origin, NOT epoch ms: wasmoon
        // truncates numbers to 32-bit signed on the way into Lua, so a raw
        // Date.now() (~1.79e12) arrives as a negative garbage value and every
        // deadline computed from it is already in the past. Milliseconds since
        // the bridge was built stay comfortably inside int32.
        const clockOrigin = Date.now();
        this.lua.global.set('__mudix_now', () => Date.now() - clockOrigin);
        this.lua.global.set('__mudix_pump', (deadlineMs: unknown) => {
            const deadline = clockOrigin + Number(deadlineMs);
            this.api.timers.pumpDue();
            if (Date.now() >= deadline) return true;
            // Let real time advance a little so pending timers come due, without
            // overshooting the caller's deadline.
            const until = Math.min(deadline, Date.now() + 2);
            while (Date.now() < until) { /* spin */ }
            return Date.now() >= deadline;
        });

        if (typeof window === 'undefined') return;

        // ── readiness gate for the e2e harness ───────────────────────────────
        // __runBusted goes live here, at the tail of setup() — but the engine's
        // load pass isn't finished: triggers compile only once PCRE wasm resolves,
        // and perm aliases/triggers reach the engines through the store
        // subscription attached at the end of ScriptingEngine.start(). A run
        // started in that window sees a half-wired engine, and since the whole run
        // is one synchronous doStringSync no queued apply can catch up mid-run —
        // every perm* spec then fails at random. sysLoadEvent is raised last, once
        // all of that is in place (Mudlet parity: Host.cpp compiles the trigger
        // unit before raising it), so the flag it sets is the exact gate we need.
        // Kept in Lua rather than on window so it dies with this lua_State: a
        // runtime that gets recreated (StrictMode remount, profile switch) can
        // never leave a stale "ready" behind for the next one.
        this.lua.doStringSync(
            '__mudix_busted_loaded = false\n' +
            'registerAnonymousEventHandler("sysLoadEvent", function() __mudix_busted_loaded = true end, true)',
        );
        (window as unknown as { __mudixBustedReady?: () => boolean }).__mudixBustedReady = () =>
            this.lua.doStringSync('return __mudix_busted_loaded == true') === true;

        const specPaths = bustedSpecVfsPaths();
        (window as unknown as { __runBusted?: (pattern?: string) => unknown }).__runBusted = (pattern?: string) => {
            // Prefer an exact spec-name match (`Foo` → /lua/specs/Foo_spec.lua) so
            // a name that is a substring of another (e.g. "UI" within "GUIUtils")
            // selects only its own spec; fall back to substring for free patterns.
            const exact = pattern ? specPaths.filter(p => p.endsWith(`/${pattern}_spec.lua`)) : [];
            const selected = !pattern || pattern === '*'
                ? specPaths
                : (exact.length ? exact : specPaths.filter(p => p.includes(pattern)));
            // Long-bracket string literals — spec VFS paths never contain ']]'.
            const listLua = '{' + selected.map(p => `[[${p}]]`).join(',') + '}';
            const json = this.lua.doStringSync(
                `return yajl.to_string(require('runBusted')(${listLua}))`,
            ) as string;
            return JSON.parse(json);
        };
    }

    // ── luasql.sqlite3 bridge ────────────────────────────────────────────────
    // Exposes globals consumed by Luasql.lua: __sql_open / __sql_exec /
    // __sql_close / __sql_escape. All synchronous — sqlite runs on the main
    // thread, so Lua doesn't need to yield Promises.
    //
    // VFS round-trip: on open we preload from the ProfileVFS via
    // sqlite3_deserialize; the VFS file is the source of truth. After each
    // mutation we schedule a debounced snapshot (setTimeout) back to the same
    // VFS path so a tight INSERT loop coalesces into one write.
    //
    // Row arrays are 1-indexed for Lua: wasmoon's pushTable iterates
    // Object.keys, so a sparse JS array with index 0 absent and 1..n populated
    // lands in Lua as a clean 1-indexed sequence.
    private setupSqlBridge(): void {
        const sql = getSqliteClient();

        const toLuaArray = <T>(arr: T[]): T[] => {
            const r: T[] = [];
            for (let i = 0; i < arr.length; i++) r[i + 1] = arr[i];
            return r;
        };

        const SNAPSHOT_DEBOUNCE_MS = 500;
        const dbPaths = new Map<number, string>();
        const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();

        const snapshotNow = (dbId: number): void => {
            const path = dbPaths.get(dbId);
            if (!path || !this.vfs) return;
            try {
                const bytes = sql.exportFile(dbId);
                // sqlite3_js_db_export returns an empty Uint8Array for an
                // in-memory DB with no committed pages (a bare connect+close
                // with no DDL/DML). Writing 0 bytes would poison the VFS path:
                // the next __sql_open would read it back and reject it as too
                // small for a SQLite header. Skip the write instead.
                if (bytes.byteLength === 0) return;
                this.vfs.writeBinaryFile(path, bytes);
            } catch (e) {
                console.warn('[sql snapshot]', path, e);
            }
        };

        const scheduleSnapshot = (dbId: number): void => {
            if (!this.vfs) return;
            // The very first write goes out immediately: DB.lua's
            // db:_isActiveDBName (which db:close and db:create both consult)
            // tests io.exists on the database path, so a database that only
            // existed in memory read back as "not open" until the debounce
            // fired half a second later.
            const path = dbPaths.get(dbId);
            if (path && !this.vfs.exists(path)) { snapshotNow(dbId); return; }
            const prev = pendingTimers.get(dbId);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
                pendingTimers.delete(dbId);
                snapshotNow(dbId);
            }, SNAPSHOT_DEBOUNCE_MS);
            pendingTimers.set(dbId, t);
        };

        this.flushPendingSqlSnapshots = () => {
            for (const [dbId, t] of pendingTimers) {
                clearTimeout(t);
                snapshotNow(dbId);
            }
            pendingTimers.clear();
        };

        this.lua.global.set('__sql_open', (path: unknown): number => {
            const p = String(path);
            // Reuse a still-open connection to the same path. DB.lua's db:create
            // → db:_migrate reconnects mid-session (adding a column, changing
            // _violations) by overwriting db.__conn WITHOUT closing the previous
            // handle. Opening a fresh :memory: DB each time would both strand the
            // rows written since the last snapshot (Lua runs synchronously, so
            // the debounced VFS snapshot hasn't fired) and leak the old handle.
            // The live in-memory DB already holds the current committed state, so
            // hand the same dbId back; the VFS is consulted only on a cold open.
            const live = sql.liveId(p);
            if (live != null) return live;
            let preload: Uint8Array | undefined;
            if (this.vfs && this.vfs.exists(p)) {
                let raw: Uint8Array;
                try {
                    raw = this.vfs.readBinaryFile(p);
                } catch (e) {
                    throw new Error(`VFS read of '${p}' failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                // Normalize to a fresh, byteOffset=0, standalone Uint8Array —
                // ZenFS may return a Buffer slice that spans only part of an
                // underlying ArrayBuffer.
                const fresh = new Uint8Array(raw.byteLength);
                fresh.set(raw);
                // 0-byte file: treat as if the DB doesn't exist yet. snapshotNow
                // now skips empty exports, but older sessions or interrupted runs
                // may have left a 0-byte file behind that would otherwise jam
                // every future open of this path.
                if (fresh.byteLength === 0) {
                    console.warn(`[__sql_open] '${p}' exists as 0 bytes — opening as fresh database`);
                } else if (fresh.byteLength < 512) {
                    throw new Error(`VFS file '${p}' is ${fresh.byteLength} bytes, too small to be a SQLite database`);
                } else {
                    // Quick header sniff — SQLite files start with "SQLite format 3\0".
                    const HDR = 'SQLite format 3\0';
                    let headerOk = true;
                    for (let i = 0; i < HDR.length; i++) {
                        if (fresh[i] !== HDR.charCodeAt(i)) { headerOk = false; break; }
                    }
                    if (!headerOk) {
                        throw new Error(`VFS file '${p}' is not a SQLite database (bad header). First bytes: ${Array.from(fresh.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                    }
                    preload = fresh;
                }
            }
            const dbId = sql.open(p, preload);
            dbPaths.set(dbId, p);
            return dbId;
        });

        this.lua.global.set('__sql_exec', (dbId: unknown, sqlText: unknown) => {
            const id = Number(dbId);
            try {
                const r = sql.exec(id, String(sqlText));
                if (r.kind === 'rows') {
                    // Return rows as a Lua source literal instead of a nested
                    // JS array. wasmoon's pushTable crosses the JS↔WASM boundary
                    // once per cell — for a fetch of N rows × M columns that's
                    // N*M crossings, which dominates large-result paths. By
                    // emitting `{{...},{...},...}` and letting Lua's loadstring
                    // parse it, we replace N*M boundary crossings with one
                    // string push plus an in-wasm parse.
                    const rowsSrc = encodeRowsToLuaSource(r.rows as unknown[][]);
                    const cols1 = toLuaArray(r.columns);
                    return {kind: 'rows', rowsSrc, columns: cols1};
                }
                // Any non-query (INSERT/UPDATE/DELETE/DDL) — schedule a debounced
                // VFS snapshot. Coalesces a tight db:add loop into one write.
                scheduleSnapshot(id);
                return {kind: 'changes', changes: r.changes};
            } catch (e) {
                return {kind: 'error', message: e instanceof Error ? e.message : String(e)};
            }
        });

        this.lua.global.set('__sql_close', (dbId: unknown): boolean => {
            const id = Number(dbId);
            try {
                const t = pendingTimers.get(id);
                if (t) { clearTimeout(t); pendingTimers.delete(id); }
                snapshotNow(id);
                sql.close(id);
                dbPaths.delete(id);
                return true;
            } catch {
                return false;
            }
        });

        this.lua.global.set('__sql_escape', (s: unknown): string => sql.escape(String(s ?? '')));
    }

    // ── VFS bridge ───────────────────────────────────────────────────────────

    /**
     * Fire sysPathChanged for any addFileWatch subscription whose path equals
     * `changedPath` or is an ancestor directory of it. Mudlet's QFileSystemWatcher
     * reports the *watched* path (not the inner file) for directory watches, so
     * we do the same — handlers comparing `path == watchedPath` round-trip.
     */
    private notifyVfsPathChange(changedPath: string): void {
        if (this.watchedPaths.size === 0) return;
        if (this.watchedPaths.has(changedPath)) {
            this.emitEvent('sysPathChanged', [changedPath]);
        }
        for (const watched of this.watchedPaths) {
            if (watched !== changedPath && changedPath.startsWith(watched + '/')) {
                this.emitEvent('sysPathChanged', [watched]);
            }
        }
    }

    private setupVFS(vfs: ProfileVFS | null, builtins = new Map<string, string>()): void {
        let nextId = 1;
        let lastError = '';

        interface Handle {
            path: string;
            mode: string;
            /** File body as a Latin-1 byte-string (charCode === byte), so
             *  positions are true byte offsets and binary content survives. */
            content: string;
            pos: number;
            dirty: boolean;
        }

        const handles = new Map<number, Handle>();

        // ── Binary armoring across the wasmoon bridge ─────────────────────────
        // wasmoon marshals strings between Lua and JS with emscripten's
        // UTF8ToString / stringToUTF8: Lua→JS stops at the first NUL byte and
        // UTF-8-*decodes* the rest, JS→Lua re-encodes chars ≥ 0x80 as multi-byte
        // UTF-8. Fine for text, silently corrupting for binary (a replay file's
        // int32 headers lost every \0). So every io payload crosses the bridge
        // "armored" as pure ASCII: a marker char (\2 = raw, \1 = encoded) plus
        // the payload with NUL / '%' / 0x80–0xFF bytes as %XX escapes. VFS.lua
        // mirrors the scheme (_armor/_unarmor) on the Lua side.
        const VFS_RAW = 2;
        const NEEDS_ARMOR = /[\x00%\x80-\xff]/;
        const armor = (s: string): string => {
            if (!NEEDS_ARMOR.test(s)) return '\x02' + s;
            return '\x01' + s.replace(/[\x00%\x80-\xff]/g,
                c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
        };
        const unarmor = (s: string): string => {
            const payload = s.substring(1);
            if (s.charCodeAt(0) === VFS_RAW) return payload;
            return payload.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
        };

        // Byte-string ↔ bytes for the storage boundary. Chunked to stay within
        // String.fromCharCode's argument limit on large files.
        const bytesToLatin1 = (bytes: Uint8Array): string => {
            let out = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
                out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            }
            return out;
        };
        const latin1ToBytes = (s: string): Uint8Array => {
            const bytes = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
            return bytes;
        };
        /** Read a file's raw bytes as a Latin-1 byte-string. Builtins are JS
         *  text — take their UTF-8 bytes so Lua sees what a file would hold. */
        const readAsLatin1 = (filename: string): string =>
            builtins.has(filename)
                ? bytesToLatin1(new TextEncoder().encode(builtins.get(filename)!))
                : bytesToLatin1(vfs!.readBinaryFile(filename));

        this.lua.global.set('__vfs_err__', () => lastError);
        this.lua.global.set('__vfs_exists__', (path: string) =>
            builtins.has(path) || (vfs ? vfs.exists(path) : false));
        this.lua.global.set('__vfs_profile_dir__', () => vfs?.profilePath ?? '/profiles/default');

        this.lua.global.set('__vfs_io_open__', (filename: string, mode: string): number | null => {
            try {
                const m = (mode ?? 'r').replace(/b/g, '');
                let content = '';
                let resolvedPath = filename;
                let dirty = false;

                if (builtins.has(filename)) {
                    if (m !== 'r') { lastError = `cannot open '${filename}': read-only`; return null; }
                    content = readAsLatin1(filename);
                } else if (vfs) {
                    resolvedPath = vfs.resolvePath(filename);
                    if (m === 'r' || m === 'r+') {
                        if (!vfs.exists(filename)) {
                            lastError = `cannot open '${filename}': No such file or directory`;
                            return null;
                        }
                        content = readAsLatin1(filename);
                    } else if (m === 'a' || m === 'a+') {
                        if (vfs.exists(filename)) content = readAsLatin1(filename);
                    }
                    dirty = m === 'w' || m === 'w+';
                } else {
                    lastError = `cannot open '${filename}': No such file or directory`;
                    return null;
                }

                const id = nextId++;
                handles.set(id, {
                    path: resolvedPath,
                    mode: m,
                    content,
                    pos: m.startsWith('a') ? content.length : 0,
                    dirty,
                });
                return id;
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                return null;
            }
        });

        this.lua.global.set('__vfs_io_read__', (id: number, fmt: string | number): string | number | null => {
            const h = handles.get(id);
            if (!h) { lastError = 'invalid file handle'; return null; }
            if (h.mode === 'w' || h.mode === 'a') { lastError = 'file is write-only'; return null; }

            if (typeof fmt === 'number') {
                if (fmt === 0) return armor('');
                const chunk = h.content.substring(h.pos, h.pos + fmt);
                if (chunk.length === 0) return null;
                h.pos += chunk.length;
                return armor(chunk);
            }

            // Lua 5.1's liolib only inspects the character after '*', so '*all'
            // and '*a' both mean "read entire file". Match that behavior.
            const raw = (fmt ?? '*l').toString();
            const f = (raw.startsWith('*') ? raw.charAt(1) : raw.charAt(0)) || 'l';

            if (f === 'l' || f === 'L') {
                if (h.pos >= h.content.length) return null;
                const nl = h.content.indexOf('\n', h.pos);
                if (nl === -1) {
                    const line = h.content.substring(h.pos);
                    h.pos = h.content.length;
                    return armor(f === 'L' ? line + '\n' : line);
                }
                const line = h.content.substring(h.pos, nl);
                h.pos = nl + 1;
                return armor(f === 'L' ? line + '\n' : line);
            }
            if (f === 'a') {
                const rest = h.content.substring(h.pos);
                h.pos = h.content.length;
                return armor(rest);
            }
            if (f === 'n') {
                const m = h.content.substring(h.pos).match(/^\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
                if (!m) return null;
                h.pos += m[0].length;
                return parseFloat(m[1]);
            }
            return null;
        });

        this.lua.global.set('__vfs_io_write__', (id: number, armored: string): string | null => {
            const h = handles.get(id);
            if (!h) return 'invalid file handle';
            if (h.mode === 'r') return 'file is read-only';
            const data = unarmor(armored);
            if (h.mode === 'a' || h.mode === 'a+') {
                h.content += data;
            } else {
                h.content = h.content.substring(0, h.pos) + data + h.content.substring(h.pos + data.length);
                h.pos += data.length;
            }
            h.dirty = true;
            return null;
        });

        this.lua.global.set('__vfs_io_seek__', (id: number, whence: string, offset: number): number | null => {
            const h = handles.get(id);
            if (!h) { lastError = 'invalid file handle'; return null; }
            const o = offset ?? 0;
            let newPos: number;
            if ((whence ?? 'cur') === 'set') newPos = o;
            else if ((whence ?? 'cur') === 'cur') newPos = h.pos + o;
            else if (whence === 'end') newPos = h.content.length + o;
            else { lastError = 'invalid whence'; return null; }
            h.pos = Math.max(0, Math.min(newPos, h.content.length));
            return h.pos;
        });

        this.lua.global.set('__vfs_io_close__', (id: number): string | null => {
            const h = handles.get(id);
            if (!h) return 'invalid file handle';
            try {
                if (h.dirty && vfs) {
                    vfs.writeBinaryFile(h.path, latin1ToBytes(h.content));
                    this.notifyVfsPathChange(h.path);
                }
                handles.delete(id);
                return null;
            } catch (e) {
                handles.delete(id);
                return e instanceof Error ? e.message : String(e);
            }
        });

        this.lua.global.set('__vfs_os_remove__', (path: string): boolean => {
            if (!vfs) { lastError = 'no profile VFS'; return false; }
            const abs = vfs.resolvePath(path);
            try { vfs.deleteFile(path); this.notifyVfsPathChange(abs); return true; }
            catch (e) { lastError = e instanceof Error ? e.message : String(e); return false; }
        });

        this.lua.global.set('__vfs_os_rename__', (oldPath: string, newPath: string): boolean => {
            if (!vfs) { lastError = 'no profile VFS'; return false; }
            const oldAbs = vfs.resolvePath(oldPath);
            const newAbs = vfs.resolvePath(newPath);
            try {
                vfs.rename(oldPath, newPath);
                this.notifyVfsPathChange(oldAbs);
                if (oldAbs !== newAbs) this.notifyVfsPathChange(newAbs);
                return true;
            }
            catch (e) { lastError = e instanceof Error ? e.message : String(e); return false; }
        });

        this.lua.global.set('__vfs_lfs_chdir__', (path: string): boolean => {
            if (!vfs) { lastError = 'no profile VFS'; return false; }
            const err = vfs.chdir(path);
            if (err) { lastError = err; return false; }
            return true;
        });

        this.lua.global.set('__vfs_lfs_currentdir__', () => vfs?.cwd ?? '/');

        this.lua.global.set('__vfs_lfs_mkdir__', (path: string): boolean => {
            if (!vfs) { lastError = 'no profile VFS'; return false; }
            const abs = vfs.resolvePath(path);
            try { vfs.mkdir(path); this.notifyVfsPathChange(abs); return true; }
            catch (e) { lastError = e instanceof Error ? e.message : String(e); return false; }
        });

        this.lua.global.set('__vfs_lfs_rmdir__', (path: string): boolean => {
            if (!vfs) { lastError = 'no profile VFS'; return false; }
            const abs = vfs.resolvePath(path);
            try { vfs.rmdir(path); this.notifyVfsPathChange(abs); return true; }
            catch (e) { lastError = e instanceof Error ? e.message : String(e); return false; }
        });

        this.lua.global.set('__vfs_lfs_dir__', (path: string): string[] | null => {
            if (!vfs) { lastError = 'no profile VFS'; return null; }
            try {
                return ['.', '..', ...vfs.readdir(path)];
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                return null;
            }
        });

        this.lua.global.set('__vfs_lfs_stat__', (path: string): object | null => {
            // Builtins (Mudlet-lua JS-bundled assets) must report a stat too so
            // io.exists / lfs.attributes resolve them — loadTranslations probes
            // its JSON files via io.exists before opening them.
            if (builtins.has(path)) {
                const content = builtins.get(path)!;
                return {type: 'file', size: content.length, modification: 0, access: 0};
            }
            const s = vfs?.stat(path) ?? null;
            if (!s) return null;
            return {
                type: s.type,
                size: s.size,
                modification: Math.floor(s.mtime.getTime() / 1000),
                access: Math.floor(s.atime.getTime() / 1000),
            };
        });
    }

    // ── IScriptingRuntime ─────────────────────────────────────────────────────

    load(code: string, name: string): void {
        this.exec(code, name);
    }

    run(code: string, name: string): void {
        this.exec(code, name);
    }

    /**
     * Restore saved Lua globals (a parsed Mudlet `<VariablePackage>` tree) into
     * `_G`. Call on profile load, after the bundle is up but before user scripts
     * run, so handlers see their persisted state. No-op for an empty list.
     */
    restoreVariables(vars: MudletVariable[]): void {
        if (!vars.length) return;
        this.lua.global.set('__mudix_var_payload', vars);
        this.exec(RESTORE_VARS_LUA, 'restore-vars');
    }

    /**
     * Snapshot the current values of the save-listed globals out of `_G` into a
     * `MudletVariable[]` tree (for serialization to `<VariablePackage>` / the
     * profile JSON). `saveList` is the set of top-level global names flagged to
     * persist (Mudlet's VarUnit::mSaveList). Names that are unset or hold a
     * non-serializable value (function/userdata/thread) are skipped.
     */
    captureVariables(saveList: string[]): MudletVariable[] {
        if (!saveList.length) return [];
        this.lua.global.set('__mudix_save_list', saveList);
        const json = this.execInner(CAPTURE_VARS_LUA, 'capture-vars');
        if (typeof json !== 'string') return [];
        try {
            return normalizeVariableTree(JSON.parse(json));
        } catch {
            return [];
        }
    }

    /** Enumerate `_G` (user globals as a nested tree, built-ins flagged) for the
     *  Variables view. See {@link LuaGlobalEntry}. */
    listGlobals(): LuaGlobalEntry[] {
        const json = this.execInner(LIST_GLOBALS_LUA, 'list-globals');
        if (typeof json !== 'string') return [];
        try {
            const parsed = JSON.parse(json);
            return Array.isArray(parsed) ? parsed.map(normalizeGlobalEntry) : [];
        } catch {
            return [];
        }
    }

    runWithMatches(
        code: string,
        name: string,
        matches: (string | undefined)[],
        multimatches?: (string | undefined)[][],
        namedGroups?: Record<string, string>,
        captureSpans?: CaptureSpan[],
        namedSpans?: Record<string, CaptureSpan>,
        fullMatchSpan?: CaptureSpan,
    ): void {
        const prevMatches = this.currentMatches;
        const prevSpans = this.currentCaptureSpans;
        const prevNamedSpans = this.currentNamedSpans;
        const prevFullMatchSpan = this.currentFullMatchSpan;
        this.currentMatches = matches;
        this.currentCaptureSpans = captureSpans ?? [];
        this.currentNamedSpans = namedSpans ?? {};
        this.currentFullMatchSpan = fullMatchSpan ?? null;
        this.setMatches(matches, multimatches, namedGroups);
        try {
            this.execInner(code, name);
        } finally {
            this.currentMatches = prevMatches;
            this.currentCaptureSpans = prevSpans;
            this.currentNamedSpans = prevNamedSpans;
            this.currentFullMatchSpan = prevFullMatchSpan;
        }
    }

    // wasmoon's pushTable iterates Object.keys(arr) and uses the keys as
    // numeric Lua indices — so a normal JS array becomes a 0-indexed Lua
    // table. Object.keys skips holes, so a sparse array with index 0 empty
    // pushes as a 1-indexed Lua sequence (which Mudlet user code expects:
    // matches[1] = full match, matches[2] = first capture).
    //
    // Named-capture keys are stuffed onto the same array via string property
    // assignment. wasmoon's pushTable splits numeric vs string keys at push
    // time, so `matches[2]` and `matches.foo` coexist on the Lua side just
    // like in Mudlet.
    private setMatches(matches: (string | undefined)[], multimatches?: (string | undefined)[][], namedGroups?: Record<string, string>): void {
        // Build matches/multimatches with raw lua_createtable pushes instead of
        // wasmoon's auto-converting global.set — ~2.4× cheaper per fired trigger,
        // and the matches table is the dominant cost of trigger/alias dispatch.
        // GMCP/MSDP already build their tables this way (pushJsValue).
        const api = this.lua.global.luaApi;
        const L = this.lua.global.address;
        this.pushMatchesTable(L, matches, namedGroups);
        api.lua_setglobal(L, 'matches');
        api.lua_createtable(L, multimatches?.length ?? 0, 0);
        if (multimatches) {
            for (let i = 0; i < multimatches.length; i++) {
                this.pushMatchesTable(L, multimatches[i]);
                api.lua_rawseti(L, -2, i + 1);
            }
        }
        api.lua_setglobal(L, 'multimatches');
        // Mudlet also exposes a separate `namedCaptures` table; keep parity.
        this.pushJsValue(L, namedGroups ?? {});
        api.lua_setglobal(L, 'namedCaptures');
    }

    /** Push a 1-indexed Lua table of capture strings (`matches[1]` = whole match),
     *  optionally merging named captures as string keys (`matches.hp`). Same shape
     *  the old `oneIndexed()` + `global.set` produced, via raw stack ops. An
     *  unmatched optional group (`undefined`) is left unset → nil, as before. */
    private pushMatchesTable(L: LuaState, arr: (string | undefined)[], named?: Record<string, string>): void {
        const api = this.lua.global.luaApi;
        api.lua_checkstack(L, 4);
        api.lua_createtable(L, arr.length, named ? Object.keys(named).length : 0);
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (v === undefined) continue;
            api.lua_pushstring(L, v);
            api.lua_rawseti(L, -2, i + 1);
        }
        if (named) {
            for (const k in named) {
                api.lua_pushstring(L, named[k]);
                api.lua_setfield(L, -2, k);
            }
        }
    }

    private exec(code: string, name: string): void {
        this.execInner(code, name);
    }

    // Run a chunk on a fresh thread and return its first return value. The
    // fresh thread isolates the chunk's frame from any caller already
    // mid-execution (e.g. a trigger handler calling expandAlias). The chunk
    // returns __exec's (err, result) tuple via the thread's stack, so we read
    // it from there instead of a global to avoid races with re-entrant exec.
    //
    // newThread() pushes a thread object onto the global stack; we have to
    // pop it via global.remove(threadIndex) in finally or the slot leaks and
    // the lua_State stack eventually overflows. close() alone is a JS-side
    // marker only — it does not pop.
    private execInner(code: string, name: string): unknown {
        const g = this.lua.global;
        const t = g.newThread();
        const threadIndex = g.getTop();
        try {
            t.loadString('return __exec(...)', '@' + name);
            t.pushValue(code);
            t.pushValue(name);
            const res = t.resume(2);
            if (res.result === LuaReturn.Yield) {
                // invokeFileDialog suspended the handler; resumeDialogThread
                // finishes it later and reports its errors. There is no result
                // to hand back synchronously.
                this.parkDialogThread(t, name, 'exec', threadIndex);
                return undefined;
            }
            t.assertOk(res.result);
            const top = t.getTop();
            const err = top >= 1 ? t.getValue(1) : null;
            const result = top >= 2 ? t.getValue(2) : undefined;
            if (err != null) throw new Error(String(err));
            return result;
        } finally {
            g.remove(threadIndex);
        }
    }

    // Run a chunk that doesn't return anything (event/cb/pattern dispatch).
    // The chunk's own pcall captures Lua errors; runtime/wasm errors surface
    // as a thrown JS exception that we route to the error console.
    private runChunk(chunk: string, label: string): void {
        const g = this.lua.global;
        const t = g.newThread();
        const threadIndex = g.getTop();
        try {
            t.loadString(chunk, '@' + label);
            const res = t.resume(0);
            if (res.result === LuaReturn.Yield) {
                this.parkDialogThread(t, label, 'chunk', threadIndex);
                return;
            }
            t.assertOk(res.result);
        } catch (e) {
            this.api.printError(`[${label}] ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            g.remove(threadIndex);
        }
    }

    // ── invokeFileDialog park/resume ──────────────────────────────────────
    // Mudlet's invokeFileDialog blocks the calling script until the user picks
    // a file. A browser can't block, but every JS→Lua entry above runs on its
    // own coroutine, so the Lua wrapper (Bridge.lua) yields a sentinel plus
    // the request args up to the resume boundary here. We anchor the suspended
    // thread in the registry, show the in-app VFS picker, and resume the
    // thread with the picked path ('' on cancel). From the script's view the
    // call is synchronous; the client keeps running meanwhile — matching
    // Mudlet, where QFileDialog spins a nested event loop and triggers/timers
    // keep firing while the dialog is open.
    private static readonly FILE_DIALOG_SENTINEL = '\x01__mudix_file_dialog';

    /** Threads suspended in invokeFileDialog, tracked so destroy() forgets
     *  them (their registry refs die with the closed Lua state). */
    private readonly parkedDialogs = new Set<ParkedDialogThread>();

    /**
     * A thread resume returned LUA_YIELD. If it is invokeFileDialog's yield
     * (sentinel first), read the request off the thread stack, anchor the
     * thread, and open the picker — returns true. Any other yield reaching
     * the handler boundary is a script bug (stock Lua 5.1 errors with
     * "attempt to yield from outside a coroutine" there): report and abandon
     * the thread — returns false.
     *
     * First park: the thread still sits at `threadIndex` on the global stack
     * (the caller's finally pops it), so take a registry ref now. Re-park
     * (`existingRef` set): the previous ref already anchors this thread.
     */
    private parkDialogThread(t: LuaThread, label: string, kind: 'exec' | 'chunk', threadIndex?: number, existingRef?: number): boolean {
        const top = t.getTop();
        const sentinel = top >= 1 ? t.getValue(1) : null;
        if (sentinel !== LuaRuntime.FILE_DIALOG_SENTINEL) {
            if (top > 0) t.pop(top);
            this.api.printError(
                `[${label}] coroutine.yield reached the top of the handler — the handler was abandoned ` +
                `(yielding to the client is only supported via invokeFileDialog)`);
            return false;
        }
        const fileMode = t.getValue(2) === true;
        const rawTitle = top >= 3 ? t.getValue(3) : '';
        const rawLocation = top >= 4 ? t.getValue(4) : '';
        t.pop(top);
        let ref = existingRef;
        if (ref === undefined) {
            const api = this.lua.global.luaApi;
            api.lua_pushvalue(this.lua.global.address, threadIndex!);
            ref = api.luaL_ref(this.lua.global.address, LUA_REGISTRYINDEX);
        }
        const park: ParkedDialogThread = {thread: t, ref, label, kind};
        this.parkedDialogs.add(park);
        this.api.invokeFileDialog(
            {
                mode: fileMode ? 'file' : 'folder',
                title: typeof rawTitle === 'string' ? rawTitle : '',
                location: typeof rawLocation === 'string' ? rawLocation : '',
            },
            path => this.resumeDialogThread(park, path),
        );
        return true;
    }

    /** Continue a parked handler with the picked VFS path ('' = cancelled). */
    private resumeDialogThread(park: ParkedDialogThread, path: string): void {
        this.parkedDialogs.delete(park);
        // After lua_close the thread died with the state — touching it (or
        // unreffing) would poke freed WASM memory.
        if (this.destroyed) return;
        const t = park.thread;
        let reparked = false;
        try {
            t.pushValue(typeof path === 'string' ? path : '');
            const res = t.resume(1);
            if (res.result === LuaReturn.Yield) {
                // The handler called invokeFileDialog again.
                reparked = this.parkDialogThread(t, park.label, park.kind, undefined, park.ref);
            } else {
                t.assertOk(res.result);
                if (park.kind === 'exec') {
                    // __exec finished after the original exec() caller already
                    // returned — route its (err, result) tuple's error here.
                    const err = t.getTop() >= 1 ? t.getValue(1) : null;
                    if (err != null) this.api.printError(`[${park.label}] ${String(err)}`);
                }
            }
        } catch (e) {
            this.api.printError(`[${park.label}] ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            if (!reparked) {
                this.lua.global.luaApi.luaL_unref(this.lua.global.address, LUA_REGISTRYINDEX, park.ref);
            }
            this.api.flushOutput();
        }
    }

    // Fire a registered Lua callback by id (label clicks, tempTimer/Alias/
    // Trigger/Key).
    private dispatchCb(cbId: number, label: string): void {
        this.runChunk(`__mudix_dispatch_cb(${cbId})`, label);
        this.api.flushOutput();
    }

    // Same as dispatchCb but passes a single argument to the callback. Used by
    // label mouse callbacks to deliver the {button, x, y, ...} event table.
    private dispatchCbWithArg(cbId: number, arg: unknown, label: string): void {
        if (this.destroyed) return;
        this.lua.global.set('__mudix_cb_arg', arg);
        this.runChunk(`__mudix_dispatch_cb_arg(${cbId})`, label);
        this.api.flushOutput();
    }

    // Unregister a previously registered callback id (Lua side). Used to free
    // entries in __mudix_cb on rebind so labels with rapidly-changing handlers
    // don't leak refs.
    private unregisterCb(cbId: number): void {
        if (!cbId) return;
        this.runChunk(`__mudix_unregister_cb(${cbId})`, 'unregister cb');
    }

    /**
     * Mudlet `T2DMap::initiateSpeedWalk` / `Host::startSpeedWalk` — the map's
     * double-click-to-walk gesture. Pathfinds `from` → `to` (unless the mapper
     * opted into `mudlet.custom_speedwalk`) and calls the mapper package's
     * `doSpeedWalk`; see `__mudix_start_speedwalk` in Bridge.lua. Errors inside
     * the mapper are reported, never thrown at the UI caller.
     */
    startSpeedWalk(from: number, to: number): void {
        if (this.destroyed) return;
        this.runChunk(`__mudix_start_speedwalk(${Math.trunc(from)}, ${Math.trunc(to)})`,
            'speedwalk');
        this.api.flushOutput();
    }

    private execModule(code: string, name: string, globalName: string): void {
        const result = this.execInner(code, name);
        if (result !== undefined && result !== null) this.lua.global.set(globalName, result);
    }

    // Mudlet parity (Host::raiseEvent): an event raised while another event is
    // still dispatching — installPackage inside a sysDownloadDone handler
    // raising sysInstallPackage, any handler calling raiseEvent — is queued and
    // dispatched after the in-flight event finishes. Synchronous nested
    // dispatch let a handler registered mid-dispatch see the event already in
    // flight: EleUI2's GitUpdater (registered while its package installed
    // inside the sysDownloadDone dispatch) received that same sysDownloadDone,
    // mistook the package's own install download for a finished update, and
    // uninstalled the package.
    private dispatchingEvent = false;
    private readonly pendingEvents: Array<{ event: string; args: unknown[] }> = [];

    emitEvent(event: string, args: unknown[]): void {
        // HTTP callbacks fire from background fetches and may resolve after the
        // owning ScriptingEngine tore us down; emitting on a closed lua_State
        // throws a confusing wasm error. Drop the event silently in that case.
        if (this.destroyed) return;
        this.pendingEvents.push({ event, args });
        if (this.dispatchingEvent) return;
        this.dispatchingEvent = true;
        try {
            while (this.pendingEvents.length > 0 && !this.destroyed) {
                const next = this.pendingEvents.shift()!;
                this.dispatchEventNow(next.event, next.args);
            }
        } finally {
            this.dispatchingEvent = false;
            // A throw mid-drain would otherwise leak stale events into the
            // next dispatch.
            this.pendingEvents.length = 0;
        }
    }

    private dispatchEventNow(event: string, args: unknown[]): void {
        // Refresh the Lua-side getMainWindowSize cache (Bridge.lua) from the
        // authoritative new size on the SAME signal that triggers Geyser's
        // reposition, set before dispatch so the reposition handler reads current
        // values. This lets Geyser resolve every percentage against a Lua local
        // instead of crossing into JS + getBoundingClientRect once per widget.
        if (event === 'sysWindowResizeEvent'
            && typeof args[0] === 'number' && typeof args[1] === 'number') {
            this.lua.global.set('__mws_w', args[0]);
            this.lua.global.set('__mws_h', args[1]);
        }
        this.lua.global.set('__mudix_evt_args', args);
        // Explicit count: a nil/false-carrying payload (raiseEvent("x", nil,
        // false, "y")) lands in Lua as a table with holes, and neither `#` nor a
        // nil-terminated walk can recover the caller's real arity. Mudlet passes
        // every argument through positionally, so the count has to travel too.
        this.lua.global.set('__mudix_evt_argc', args.length);
        this.lua.global.set('__mudix_evt_name', event);
        this.runChunk('__mudix_dispatch_event()', `event "${event}"`);
        this.api.flushOutput();
    }

    // Bridges a single GMCP message into the Lua `gmcp` global. Path is the
    // dotted server key (e.g. "Char.Vitals"); value is the JSON-decoded payload.
    // The leaf is replaced; siblings under shared parents are preserved.
    setGmcpValue(path: string, value: unknown): void {
        if (this.destroyed || !path) return;
        this.lua.global.set('__mudix_gmcp_path', path);
        // Raw-push the (potentially large, deeply nested) decoded payload instead
        // of wasmoon's generic pushValue, whose ref/unref bookkeeping is O(n²) in
        // the node count (issue #2). pushJsValue mirrors toLuaValue's conventions
        // and delegates the yajl.null sentinel leaves back to wasmoon.
        const L = this.lua.global.address;
        this.pushJsValue(L, this.toLuaValue(value));
        this.lua.global.luaApi.lua_setglobal(L, '__mudix_gmcp_val');
        this.runChunk('__mudix_set_gmcp(__mudix_gmcp_path, __mudix_gmcp_val)', `set-gmcp "${path}"`);
    }

    // Bridges a single MSDP variable into the Lua `msdp` global. `path` is the
    // top-level variable name (flat — MSDP nesting lives inside the value, not
    // the key); `value` is the decoded string / array / table.
    setMsdpValue(path: string, value: unknown): void {
        if (this.destroyed || !path) return;
        this.lua.global.set('__mudix_msdp_path', path);
        // Raw-push the decoded value (see setGmcpValue) to avoid the O(n²)
        // generic pushValue on large nested MSDP tables (issue #2).
        const L = this.lua.global.address;
        this.pushJsValue(L, this.toLuaValue(value));
        this.lua.global.luaApi.lua_setglobal(L, '__mudix_msdp_val');
        this.runChunk('__mudix_set_msdp(__mudix_msdp_path, __mudix_msdp_val)', `set-msdp "${path}"`);
    }

    // Bridges a single MSSP variable into the Lua `mssp` global. `name` is the
    // flat variable name (e.g. "PLAYERS"); `value` is the reported string.
    setMsspValue(name: string, value: string): void {
        if (this.destroyed || !name) return;
        this.lua.global.set('__mudix_mssp_name', name);
        this.lua.global.set('__mudix_mssp_val', value);
        this.runChunk('__mudix_set_mssp(__mudix_mssp_name, __mudix_mssp_val)', `set-mssp "${name}"`);
    }

    /**
     * Bridges one use of a server-defined MXP element into the Lua `mxp` global
     * as `mxp.<element>` — a fresh table each time, with every attribute key
     * lowercased and a `text` field, exactly as Mudlet's signalMXPEvent builds
     * it. Values keep their case.
     */
    setMxpElement(name: string, attrs: Record<string, string>): void {
        if (this.destroyed || !name) return;
        this.lua.global.set('__mudix_mxp_name', name.toLowerCase());
        // Flattened rather than handed over as an object: wasmoon's table proxy
        // is unreliable to iterate from Lua, and the keys are arbitrary server
        // text. \x01 separates entries, \x02 a key from its value.
        const flat = Object.entries(attrs)
            .map(([k, v]) => `${k.toLowerCase()}\x02${v}`)
            .join('\x01');
        this.lua.global.set('__mudix_mxp_attrs', flat);
        this.runChunk('__mudix_set_mxp(__mudix_mxp_name, __mudix_mxp_attrs)', `set-mxp "${name}"`);
    }

    /**
     * Mudlet-style async unzip. Reads the zip from the profile VFS, decodes
     * it on a worker (fflate falls back to a chunked main-thread decode where
     * workers aren't available), writes every entry under destDir, then
     * raises sysUnzipDone / sysUnzipError. Always fire-and-forget.
     */
    private runUnzipAsync(zipPath: string, destDir: string): void {
        const vfs = this.vfs;
        const fail = (msg: string) => {
            console.warn('[unzipAsync]', msg);
            this.emitEvent('sysUnzipError', [zipPath, destDir]);
        };
        if (!vfs)         return fail('no profile VFS available');
        if (!zipPath)     return fail('zipPath is required');
        if (!destDir)     return fail('destDir is required');
        if (!vfs.exists(zipPath)) return fail(`zip not found: ${zipPath}`);

        let buf: Uint8Array;
        try { buf = vfs.readBinaryFile(zipPath); }
        catch (err) { return fail(`read failed: ${err instanceof Error ? err.message : String(err)}`); }

        const TEXT_EXT = /\.(xml|lua|txt|json|md|css|html|htm|js|csv|ini|cfg|conf|yml|yaml)$/i;
        unzip(buf, (err, entries) => {
            if (this.destroyed) return;
            if (err) return fail(`unzip failed: ${err.message}`);
            try {
                if (!vfs.exists(destDir)) vfs.mkdir(destDir);
                for (const [name, data] of Object.entries(entries)) {
                    if (name.endsWith('/')) {
                        vfs.mkdir(`${destDir}/${name}`);
                        continue;
                    }
                    const dest = `${destDir}/${name}`;
                    const parent = dest.substring(0, dest.lastIndexOf('/'));
                    if (parent && !vfs.exists(parent)) vfs.mkdir(parent);
                    if (TEXT_EXT.test(name)) vfs.writeFile(dest, strFromU8(data));
                    else                     vfs.writeBinaryFile(dest, data);
                }
                void vfs.flush();
                this.emitEvent('sysUnzipDone', [zipPath, destDir]);
            } catch (e) {
                fail(`extract failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        });
    }

    setCurrentLine(line: string, _isPrompt: boolean): void {
        // Mudlet exposes the bare ANSI-stripped line as the global `line` so
        // triggers can read it without going through getCurrentLine. The
        // per-line prompt flag now travels on the buffer itself via
        // ScriptingAPI.beginLine, so we no longer need to mirror it here.
        this.lua.global.set('line', line);
    }

    // Mudlet sets the global `command` to the raw command-bar input at the start
    // of alias processing (AliasUnit::processDataStream). It persists between
    // inputs so keys/scripts like the stock "Repeat Last Command" can `send(command)`.
    setCommand(command: string): void {
        if (this.destroyed) return;
        this.lua.global.set('command', command);
    }

    dispatchSendRequest(text: string): boolean {
        this._denyCurrentSend = false;
        this.emitEvent('sysDataSendRequest', [text]);
        return this._denyCurrentSend;
    }

    killScriptHandlers(scriptId: string): void {
        if (this.destroyed) return;
        this.lua.global.set('__mudix_kill_sid', scriptId);
        this.runChunk('__mudix_kill_script_handlers(__mudix_kill_sid)', 'kill-script-handlers');
    }

    /**
     * Mudlet REGEX_LUA_CODE: the pattern body runs as a Lua function on every
     * incoming line. Side effects (raiseEvent, etc.) always run; the trigger
     * "matches" only when the body returns a truthy value.
     */
    evalTriggerPattern(code: string): boolean {
        this.lua.global.set('__mudix_pat_code', code);
        this.runChunk('__mudix_eval_pattern(__mudix_pat_code)', 'lua-pattern');
        return this.lua.global.get('__mudix_pat_result') === true;
    }

    /**
     * Invoke a `registerMapInfo` contributor. The Lua dispatcher pcalls the
     * stashed callback and writes its multi-return into scalar globals
     * (`__mudix_mapinfo_text` / _bold / _italic / _r / _g / _b). Returning
     * `null` covers three cases: runtime is being torn down, callback id is
     * stale, or the callback returned a nil/empty text — the panel treats
     * all three the same (skip the entry).
     */
    private evaluateMapInfo(
        cbId: number,
        roomId: number | null,
        selectionSize: number,
        areaId: number,
        displayedAreaId: number,
    ): { text: string; isBold: boolean; isItalic: boolean; color?: { r: number; g: number; b: number } } | null {
        if (this.destroyed || !cbId) return null;
        const roomArg = roomId == null ? 'nil' : String(roomId | 0);
        this.runChunk(
            `__mudix_dispatch_mapinfo(${cbId}, ${roomArg}, ${selectionSize | 0}, ${areaId | 0}, ${displayedAreaId | 0})`,
            'registerMapInfo callback',
        );
        const text = this.lua.global.get('__mudix_mapinfo_text');
        if (typeof text !== 'string' || !text) return null;
        const isBold = this.lua.global.get('__mudix_mapinfo_bold') === true;
        const isItalic = this.lua.global.get('__mudix_mapinfo_italic') === true;
        const r = this.lua.global.get('__mudix_mapinfo_r');
        const g = this.lua.global.get('__mudix_mapinfo_g');
        const b = this.lua.global.get('__mudix_mapinfo_b');
        const ch = (v: unknown): number | null => {
            if (typeof v !== 'number' || !Number.isFinite(v)) return null;
            const i = Math.round(v);
            return i >= 0 && i <= 255 ? i : null;
        };
        const rr = ch(r), gg = ch(g), bb = ch(b);
        const color = rr !== null && gg !== null && bb !== null ? { r: rr, g: gg, b: bb } : undefined;
        return { text, isBold, isItalic, color };
    }

    /**
     * Invoke a `setExitWeightFilter` callback for a single candidate exit.
     * The Lua dispatcher pcalls the stashed callback and normalises its return
     * into two scalar globals, mirroring Mudlet's applyExitWeightFilter
     * (TLuaInterpreterMapper.cpp): boolean `false` or the string "block"
     * (case-insensitive) blocks the exit; a number becomes a weight override
     * clamped to [1, INT_MAX]; nil, `true` and anything else are ignored.
     *
     * Runs re-entrantly — findPath calls this while Lua is already suspended
     * inside the `__getPath` JS call — so it must not touch the output queue or
     * any other state a live Lua frame could also be mutating.
     */
    private evaluateExitWeightFilter(
        cbId: number,
        roomId: number,
        exitCommand: string,
    ): { blocked?: boolean; weightOverride?: number } {
        if (this.destroyed || !cbId) return {};
        this.lua.global.set('__mudix_ewf_cmd', exitCommand);
        this.runChunk(
            `__mudix_dispatch_exit_weight_filter(${cbId}, ${roomId | 0}, __mudix_ewf_cmd)`,
            'setExitWeightFilter callback',
        );
        if (this.lua.global.get('__mudix_ewf_blocked') === true) return { blocked: true };
        const w = this.lua.global.get('__mudix_ewf_weight');
        if (typeof w === 'number' && Number.isFinite(w)) return { weightOverride: w };
        return {};
    }

    /**
     * Push a JS value onto `L`'s stack via the raw lua_* C API, mirroring
     * wasmoon's pushValue conventions EXACTLY so behaviour is byte-identical to
     * the generic path — only the O(n²) ref/unref bookkeeping wasmoon's
     * pushTable does (see issue #2) is gone:
     *   - integer-valued numbers → lua_pushinteger, others → lua_pushnumber
     *   - arrays keyed by Object.keys + lua_rawseti, so dense 0-based arrays
     *     (map getters) stay 0-indexed and the sparse 1-based arrays toLuaValue
     *     builds stay 1-indexed — identical to wasmoon's arrIndexs handling
     *   - plain objects → string keys via lua_setfield
     * Anything that isn't a primitive / plain array / plain object (wasmoon
     * LuaTable proxies such as the yajl.null sentinel, functions, Maps, class
     * instances) is delegated to wasmoon's own pushValue, which is O(1) for
     * these leaves and preserves their reference identity. Such values only
     * appear as leaves of GMCP/MSDP payloads (toLuaValue rebuilds every
     * container as a fresh plain array/object) and always push on the main
     * thread; on a coroutine stack we can't safely delegate, so degrade to nil.
     */
    private pushJsValue(L: LuaState, value: unknown, depth = 0): void {
        const api = this.lua.global.luaApi;
        if (value === null || value === undefined) {
            api.lua_pushnil(L);
            return;
        }
        switch (typeof value) {
            case 'number':
                if (Number.isInteger(value)) api.lua_pushinteger(L, value);
                else api.lua_pushnumber(L, value);
                return;
            case 'string':
                api.lua_pushstring(L, value);
                return;
            case 'boolean':
                api.lua_pushboolean(L, value ? 1 : 0);
                return;
        }
        const isArray = Array.isArray(value);
        if (!isArray) {
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) {
                // Proxy / function / Map / class instance — defer to wasmoon so
                // reference identity is preserved. Safe only on the main thread.
                if (L === this.lua.global.address) this.lua.global.pushValue(value);
                else api.lua_pushnil(L);
                return;
            }
        }
        // Guard against pathological / cyclic input overflowing the WASM stack.
        // Map data and decoded GMCP/MSDP are shallow JSON, so this never trips
        // in practice; it just bounds the blast radius of a surprise cycle.
        if (depth > 64) { api.lua_pushnil(L); return; }
        api.lua_checkstack(L, 4);
        const keys = Object.keys(value as object);
        if (isArray) {
            const arr = value as unknown[];
            api.lua_createtable(L, arr.length, 0);
            for (const k of keys) {
                this.pushJsValue(L, arr[Number(k)], depth + 1);
                api.lua_rawseti(L, -2, Number(k));
            }
        } else {
            api.lua_createtable(L, 0, keys.length);
            for (const k of keys) {
                this.pushJsValue(L, (value as Record<string, unknown>)[k], depth + 1);
                api.lua_setfield(L, -2, k);
            }
        }
    }

    /**
     * Register `name` as a raw lua_CFunction (bypassing wasmoon's generic
     * pushValue marshalling for the return value). `fn` receives the lua_State
     * pointer, reads its args via the raw lua_* API, pushes its results with
     * pushJsValue(), and returns the result count. A throw across the WASM
     * trampoline would corrupt the C stack, so it is contained and the getter
     * degrades to a single nil (these are read-only queries — a nil miss is a
     * safe fallback).
     */
    private registerRawGlobal(name: string, fn: (L: LuaState) => number): void {
        const api = this.lua.global.luaApi;
        const mod = api.module as unknown as {
            addFunction(f: (L: LuaState) => number, sig: string): number;
        };
        const ptr = mod.addFunction((L: LuaState) => {
            try {
                return fn(L);
            } catch (err) {
                console.error(`[mudix] raw lua binding "${name}" threw (ignored):`, err);
                api.lua_pushnil(L);
                return 1;
            }
        }, 'ii');
        this.rawFnPtrs.push(ptr);
        api.lua_pushcfunction(this.lua.global.address, ptr);
        api.lua_setglobal(this.lua.global.address, name);
    }

    destroy(): void {
        if (this.destroyed) return; // idempotent — a double lua_close corrupts the heap
        this.destroyed = true;
        // Parked invokeFileDialog threads (and their registry refs) die with
        // the state below; a picker resolving later hits the destroyed guard.
        this.parkedDialogs.clear();
        this.globalEvents?.close();
        this.tts?.destroy();
        this.api.map.setMapEventDispatcher(null);
        this.api.map.setMapInfoEvaluator(null);
        this.api.map.clearMapInfoContributors();
        // Callers must stop everything that can call into Lua (timers, key
        // bindings, line feed) BEFORE this runs — see useEngines teardown order.
        // wasmoon's lua_close still runs GC finalizers inside the WASM and can
        // abort with a "memory/table index out of bounds" RuntimeError on a
        // large/long-lived state; contain it so the throw doesn't unwind the
        // caller's teardown (which would leave subscriptions live → app hang).
        try {
            this.lua.global.close();
        } catch (err) {
            console.error('[mudix] error closing Lua runtime (ignored):', err);
        }
        // Release the Emscripten function-table slots for the raw map getters.
        // The module survives lua_close, so the slots would otherwise leak for
        // the life of the page across repeated profile switches.
        try {
            const mod = this.lua.global.luaApi.module as unknown as {
                removeFunction(p: number): void;
            };
            for (const ptr of this.rawFnPtrs) mod.removeFunction(ptr);
            this.rawFnPtrs.length = 0;
        } catch (err) {
            console.error('[mudix] error freeing raw lua bindings (ignored):', err);
        }
    }
}
