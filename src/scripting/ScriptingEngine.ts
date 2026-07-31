import type {MudSession, ScriptLogSource, ScriptLogSourceKind} from '../mud/MudSession';
import { qtModifiersToList } from '../mud/keybindings/qtKeys';
import type {AliasEngine, AliasNode} from '../mud/aliases/AliasEngine';
import {TriggerEngine, type TriggerNode} from '../mud/triggers/TriggerEngine';
import type {TimerEngine} from '../mud/timers/TimerEngine';
import type {KeyEngine, KeyNode} from '../mud/keybindings/KeyEngine';
import {findReservedKeybindings, reservedKeyNote} from '../mud/keybindings/browserReservedKeys';
import type {ButtonNode, ScriptNode} from '../storage/schema';
import {buildEffectivelyEnabledIds, isEffectivelyEnabled} from '../storage/schema';
import {useAppStore, connectionUrl} from '../storage';
import {isPackageRemovable} from '../branding';
import {saveProfileData} from '../storage/profileVfsData';
import type {BufferSegment, FormatColor, FormatStateSnapshot, RgbColor} from '../mud/text/FormatState';
import {AnsiAwareBuffer, computeTrailingState} from '../mud/text/FormatState';
import {HyperlinkPresetRegistry} from '../mud/text/hyperlinkConfig';
import {HyperlinkVisibilityController} from '../mud/text/hyperlinkVisibility';
import type {MspCommand, MxpLink} from '../mud/protocol';
import {MxpParser, splitMxpResultLines} from '../mud/protocol';
import {ScriptingAPI, type InstallOutcome} from './ScriptingAPI';
import type { EngineHost } from './EngineHost';
import {formatClosedCaption, type MediaCaptionInfo} from '../ui/sound/closedCaption';
import type {PlayMusicOptions} from '../ui/sound/SoundManager';

/** The fields every tree node (alias/trigger/timer/key/button/script) shares —
 *  enough for the tree-walking APIs (ancestors/findItems/isAncestorsActive/
 *  getProfileStats). `patterns` is trigger-only and optional. */
type BaseTreeNode = {
    id: string;
    name: string;
    enabled: boolean;
    isGroup: boolean;
    parentId: string | null;
    packageName?: string;
    patterns?: unknown[];
};
import {LuaRuntime} from './lua/LuaRuntime';
import type {IScriptingRuntime, LuaGlobalEntry} from './IScriptingRuntime';
import {ProfileVFS} from './vfs/ProfileVFS';
import {rewriteVfsUrlsInCss} from './vfs/cssRewrite';
import {rewriteVfsUrlsInHtml} from './vfs/htmlRewrite';
import {MapOpenNotifier} from './MapOpenNotifier';
import {installModuleFromVfsPath, installPackageFromBytes, moduleXmlAbsolutePath, reloadModuleFromVfs, uninstallPackageFiles} from '../import/packageInstaller';
import {downloadFromUrl, filenameFromUrl, isClientGuiRedelivery, parseClientGuiPayload, parseClientMapPayload} from '../import/remotePackageInstall';
import {ensureDefaultPackages} from '../import/defaultPackages';
import {serializeMudletXml, type SerializeInput} from '../import/mudletXmlExport';
import {isMudletProfileVfs, readNewestParseableXml} from '../import/mudletLink';
import {buildLinkedWriteback, mudletTimestamp} from '../import/mudletWriteback';

// Linked-profile write-back. serializeMudletXml now emits Mudlet's exact format
// (node flags as attributes, correct child elements/order — matched to Mudlet's
// XMLexport.cpp and verified against real saves), and the folder backend truncates
// on overwrite, so writes are clean and Mudlet-loadable. The parseable-save
// fallback means a residual mismatch can't brick the profile either.
const LINKED_WRITEBACK_ENABLED = true;
import type {PackageManifest} from '../storage/schema';

function hexToRgb(hex: string): RgbColor | null {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return null;
    return { space: 'rgb', r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/** Mirrors `debugMspEnabled` in MudClient.ts — same `mudix.debugMsp`
 *  localStorage gate, duplicated here because the engine and the client
 *  don't share a debug-flags module. Toggle in the browser console:
 *  `localStorage.setItem('mudix.debugMsp', '1')`. */
function debugMspEnabled(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('mudix.debugMsp') === '1';
    } catch {
        return false;
    }
}

/** `mudix.debugGmcp` — log each incoming GMCP message's path + truncated body,
 *  so we can see exactly which modules a server drives (e.g. whether audio
 *  arrives over `Client.Media.*` GMCP or MSP tags). */
function debugGmcpEnabled(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('mudix.debugGmcp') === '1';
    } catch {
        return false;
    }
}

// Lua chunks loaded with `loadstring(code, "@" .. name)` produce errors as
// `<name>:LINE: msg` (the `@` tells Lua to treat the name as a source file —
// no `[string "..."]` wrapping). Without `@` the format is `[string "<name>"]:LINE: msg`.
// We accept both by matching the first `:DIGITS: ` (trailing space ensures we
// hit the line/message separator, not a digit run inside the name).
const LUA_LINE_RE = /:(\d+):\s/;
function parseLuaErrorLine(msg: string): number | undefined {
    const m = LUA_LINE_RE.exec(msg);
    if (!m) return undefined;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function formatErrorPrefix(kind: ScriptLogSourceKind, name: string): string {
    switch (kind) {
        case 'script':
        case 'alias':
            return name;
        case 'trigger': return `trigger "${name}"`;
        case 'timer':   return `timer "${name}"`;
        case 'key':     return `key "${name}"`;
        case 'button':  return `button "${name}"`;
    }
}

// Some MUDs send lines that carry only ANSI colour codes (no visible text) between
// real output lines — an artifact of how they format their output.  Filtering them
// removes unintended blank lines, but also removes intentional spacing in MUDs that
// use ANSI-only lines deliberately.  Toggle this flag per preference.
const FILTER_ANSI_ONLY_LINES = true;

// Mudlet-style INFO prefix used by postMessage(): yellow "[ INFO ]" then a green body.
// See Mudlet's ctelnet.cpp / Host.cpp where strings like "[ INFO ]  - " are passed to
// postMessage(); the two-space-dash separator is part of Mudlet's convention.
function mudletInfo(message: string): string {
    return `\x1b[33m[ INFO ]\x1b[32m  - ${message}\x1b[0m`;
}

// Mudlet-style WARN prefix: yellow "[ WARN ]" then a yellow body. Used for advisory
// notices (e.g. browser-reserved keybindings) that aren't script errors.
function mudletWarn(message: string): string {
    return `\x1b[33m[ WARN ]  - ${message}\x1b[0m`;
}

/** Mudlet `permKey` modifier int → KeyNode.modifiers string array. The values
 *  are Qt::KeyboardModifier's real bits (Shift 0x02000000, Control 0x04000000,
 *  …) — the same ones `mudlet.keymodifier` publishes and tempKey already went
 *  through, so this shares that conversion. -1 (or anything <0) means "no
 *  modifier", which is what the permGroup overload passes. */
function modifiersFromMudletInt(modifier: number): string[] {
    if (!Number.isFinite(modifier) || modifier < 0) return [];
    return qtModifiersToList(modifier);
}

/** Mudlet's permKey takes a Qt::Key int. We accept either an int (best-effort
 *  mapped to the F-keys + a few common ones) or a string (passed through as the
 *  KeyNode.key — KeyEngine compares against `KeyboardEvent.code`). */
function keyCodeFromMudletKey(key: string | number): string {
    if (typeof key === 'string') return key;
    if (!Number.isFinite(key)) return '';
    // Qt::Key_F1 = 0x01000030 .. Qt::Key_F35 = 0x01000052.
    const n = Number(key);
    if (n >= 0x01000030 && n <= 0x01000052) return `F${n - 0x01000030 + 1}`;
    // Single-character keys: ascii letter 0x41..0x5A → "KeyA".."KeyZ".
    if (n >= 0x41 && n <= 0x5a) return `Key${String.fromCharCode(n)}`;
    if (n >= 0x30 && n <= 0x39) return `Digit${String.fromCharCode(n)}`;
    return '';
}

/** Mudlet `tempButtonToolbar` location int → ButtonLocation. */
const BUTTON_LOCATIONS = ['top', 'bottom', 'left', 'right', 'floating'] as const;

/**
 * Compare the slice of nodes tagged with `pkgName` between two arrays. Returns
 * true if any tagged node was added, removed, or replaced (Zustand mutators
 * always produce new node references for changed items, so reference equality
 * is sufficient).
 */
/**
 * Effective load priority of a node: looks up the owning module's priority,
 * defaulting to 0 for profile-owned nodes (no `packageName`) and for tagged
 * nodes whose package isn't in the priority map (e.g. plain non-module
 * packages, which Mudlet treats as priority 0).
 */
function priorityFor(node: { packageName?: string }, priorityMap: Map<string, number>): number {
    if (!node.packageName) return 0;
    return priorityMap.get(node.packageName) ?? 0;
}

function hasTaggedSliceChanged<T extends { id: string; packageName?: string }>(
    pkgName: string,
    next: T[] | undefined,
    prev: T[] | undefined,
): boolean {
    if (next === prev) return false;
    const a = (prev ?? []).filter(n => n.packageName === pkgName);
    const b = (next ?? []).filter(n => n.packageName === pkgName);
    if (a.length !== b.length) return true;
    const byId = new Map(a.map(n => [n.id, n]));
    for (const n of b) {
        const old = byId.get(n.id);
        if (old !== n) return true;
    }
    return false;
}

export class ScriptingEngine implements EngineHost {
    private runtimes: { lua: IScriptingRuntime | null } = { lua: null };
    private readonly unsubs: (() => void)[] = [];
    private readonly api: ScriptingAPI;
    private promptPending = false;
    // Persistent SGR state at the end of the last MUD-typed line, so colors
    // carry across line breaks (and across WebSocket frames) the way Mudlet's
    // TBuffer does. Polish MUDs like Arkadia colour a header line and let
    // subsequent lines inherit that colour until the next SGR — without a
    // persistent carry, a blank line or frame boundary drops the colour.
    private mudCarryState: FormatStateSnapshot | undefined = undefined;
    // Tracks whether GMCP/MSDP finished negotiating on the live connection, so
    // the symmetric sysProtocolDisabled can fire on disconnect. Reset on
    // disconnect.
    private gmcpNegotiated = false;
    private msdpNegotiated = false;
    private msspNegotiated = false;
    private mnesNegotiated = false;
    private mxpNegotiated = false;
    /** True once MXP (telnet option 91) has been negotiated on the live
     *  connection. Gates in-band MXP markup parsing in processFlushBatch so
     *  non-MXP MUDs (where `<grin>` is literal text) are untouched. Reset on
     *  connect/disconnect. */
    private mxpActive = false;
    /** Mudlet's Host::mForceMXPProcessorOn — setConfig("specialForceMXPProcessorOn")
     *  runs the in-band parser without an option-91 handshake, which is how a
     *  script can drive MXP markup through feedTriggers on a profile that never
     *  negotiated it. Does NOT enable the handshake replies. */
    forceMxpProcessorOn = false;
    /** Whether MXP `<SUPPORTS>`/`<VERSION>` handshake replies may be sent. Only
     *  true when MXP was started via the telnet option-91 handshake — an
     *  in-band-detected server's inbound MXP isn't confirmed, so we'd otherwise
     *  spam it with text it reads as invalid commands. */
    private mxpHandshakeEnabled = false;
    /** Per-session OSC 8 preset registry (`preset:NAME` definitions). Shared
     *  between the MXP parser and the plain-ANSI render path so a preset defined
     *  in either mode resolves in both. */
    private readonly osc8Presets = new HyperlinkPresetRegistry();
    /** Drives expire-on-event OSC 8 visibility links (conceal on the next user
     *  input / prompt / output after they're clicked). Scans the live output. */
    private readonly visibility = new HyperlinkVisibilityController(
        () => (typeof document !== 'undefined' ? document : null),
    );
    /** Per-session MXP parser. The send callback carries the in-band
     *  `<SUPPORTS>`/`<VERSION>` handshake replies (gated on
     *  `mxpHandshakeEnabled`); `api` is read lazily at call time so this
     *  initializer is safe before the constructor body runs. */
    private readonly mxp = new MxpParser({
        send: (raw) => { if (this.mxpHandshakeEnabled) this.api.send(raw, false); },
        presets: this.osc8Presets,
        // Mudlet publishes every use of a server-defined element as
        // `mxp.<element>` and raises an event of the same name.
        onElementEvent: (name, attrs) => {
            this.runtimes.lua?.setMxpElement(name, attrs);
            this.raiseEvent(`mxp.${name.toLowerCase()}`);
        },
    });
    private vfs: ProfileVFS | null = null;
    private readonly runtimeReady: Promise<IScriptingRuntime>;
    // Resolves once the initial load pass has finished — scripts/aliases/timers/
    // keys applied, triggers compiled (PCRE wasm ready and patterns applied),
    // and sysLoadEvent fired. The auto-connect path awaits this so the socket
    // isn't dialed until every script handler and trigger is in place — matching
    // Mudlet, where a profile loads before it connects. Resolves on every load
    // path including failures so a connect never hangs waiting on it.
    private readonly scriptsLoaded: Promise<void>;
    private resolveScriptsLoaded!: () => void;
    // True once the initial load pass has finished. Until then, every connect
    // request (auto-connect on open, or a script calling connect()/
    // connectToServer() during load) is held in pendingConnectUrl and dialed
    // when the load completes — last request wins, so exactly one socket opens.
    private scriptsLoadComplete = false;
    private pendingConnectUrl: string | null = null;
    private readonly mapOpen = new MapOpenNotifier(() => this.raiseEvent('mapOpenEvent'));
    private readonly connectionId: string;
    private storeUnsub: (() => void) | null = null;
    // Triggers can't apply until the PCRE wasm has initialized — we hold
    // off the first apply (and any subsequent store updates for triggers)
    // until TriggerEngine.ready() resolves.
    private triggersReady = false;
    // Microtask-coalesce trigger reloads. A burst of N store mutations in
    // one synchronous tick (e.g. a Lua package registering 30 triggers in a
    // loop, or zustand emitting many sets back-to-back during boot) used to
    // run loadPerm N times — each call is O(triggers). With a flag + queued
    // flush, the burst collapses into one rebuild per tick. flushPending* is
    // exposed so notifyPackageInstalled can drain synchronously before
    // sysInstallPackage fires (handlers may add/inspect triggers).
    private triggersDirty = false;
    // Last seen script list for the active connection. Used to diff against
    // the next store update so we know which scripts to load/unload.
    private prevScripts: ScriptNode[] = [];
    // resetProfile() coalescing + a teardown guard so a deferred reset that
    // fires after the engine was destroyed is a no-op.
    private resetting = false;
    private disposed = false;
    // Pending debounced XML writes for sync-enabled modules (key: module name).
    private moduleSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private static readonly MODULE_SYNC_DEBOUNCE_MS = 500;
    // Pending debounced write of this profile's automation data to its VFS
    // (.mudix/profile.json). Coalesces bursts of store mutations into one write.
    private profileDataSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly PROFILE_DATA_SAVE_DEBOUNCE_MS = 1000;
    /** For a linked Mudlet profile: the timestamped current/*.xml filename this
     *  session writes back to (created lazily on first write, reused thereafter). */
    private mudletSaveName: string | null = null;
    // Per-kind default MSP base URL, set by any `!!SOUND`/`!!MUSIC` tag that
    // carries U=. Lets servers (e.g. Alteraeon) announce their sound pack
    // location once with `!!SOUND(Off U=https://.../wav_v1/)` and then send
    // subsequent tags with just the filename.
    private mspBaseUrl: { sound?: string; music?: string } = {};
    // Default media URL for the GMCP media protocol, set by a
    // `Client.Media.Default { "url": ... }` message. Used as the base directory
    // for any subsequent Play/Load whose payload omits its own `url`.
    private gmcpMediaDefaultUrl = '';
    // sysExitEvent must fire exactly once per engine — either on teardown
    // (destroy) or on page unload, whichever comes first.
    private exitFired = false;
    private readonly beforeUnload = () => { this.fireExit(); this.flushProfileData(); };

    // Mudlet's permScript/permRegexTrigger/setScript return a numeric script id;
    // our store keys nodes by UUID. Hand each UUID a stable monotonic int when
    // we first hit it so Lua callers see consistent numeric identity (and code
    // doing `tbl[id] = x` doesn't break the way a UUID string would).
    private uuidToNumericId = new Map<string, number>();
    private nextNumericId = 1;
    private numericIdFor(uuid: string): number {
        let n = this.uuidToNumericId.get(uuid);
        if (n === undefined) { n = this.nextNumericId++; this.uuidToNumericId.set(uuid, n); }
        return n;
    }

    constructor(
        private readonly session: MudSession,
        private readonly aliasEngine: AliasEngine,
        private readonly triggerEngine: TriggerEngine,
        private readonly timerEngine: TimerEngine,
        private readonly keyEngine: KeyEngine,
        connectionId: string,
        connectionName = '',
        private readonly proxyUrlGetter: () => string | undefined = () => undefined,
        // The profile's VFS, mounted by the caller (App) before the session
        // renders so per-profile data is available synchronously at first paint.
        // The engine consumes it but does not own its lifecycle — App mounts,
        // registers, flushes, and unmounts it. Null = mount failed/unavailable
        // (degraded mode: Lua file I/O is disabled).
        injectedVfs: ProfileVFS | null = null,
    ) {
        this.api = new ScriptingAPI(session, aliasEngine, triggerEngine, timerEngine, keyEngine, connectionId);
        this.api.profileName = connectionName;
        // The map store keys its saved player room (Mudlet's mRoomIdHash) by the
        // profile name; set it before start() awaits bootstrapMap() so the
        // boot-time map load can restore the position.
        session.windows.mapStore.profileName = connectionName;
        this.connectionId = connectionId;
        // Bind the host here rather than after the Lua runtime resolves: the
        // runtime is created asynchronously and executes the whole bundled
        // Mudlet Lua during setup, so binding later leaves a real window in
        // which script-reachable APIs (send → dispatchSendRequest, getPackages,
        // exists, …) have no engine behind them. Every field those methods read
        // is assigned above, and nothing calls them synchronously from here.
        this.api.setHost(this);
        this.bridgeEvents(session);
        // Let WindowManager raise system events (e.g. sysUserWindowResizeEvent)
        // through the same path as everything else.
        session.windows.onRaiseEvent = (event, args) => this.raiseEvent(event, args);
        // Map UI "download map from game" → the Client.Map/MMP download flow.
        session.windows.onDownloadMap = () => void this.downloadMap();
        // Double-clicking a room on the map walks there (Mudlet
        // T2DMap::initiateSpeedWalk): pathfind, then hand the route to the
        // mapper package's doSpeedWalk.
        session.windows.onStartSpeedWalk = (from, to) => this.runtimes.lua?.startSpeedWalk(from, to);
        // A File dropped on a window can't be installed from its name alone, so
        // stage its bytes in the profile VFS and then raise sysDropEvent with a
        // path the bundled packageDrop handler can read.
        session.windows.onFileDrop = (file, x, y, id) => { void this.stageDroppedFile(file, x, y, id); };
        // SoundManager raises sysMediaFinished(name, path) when a source ends.
        // sysSoundFinished is the pre-4.15 name, superseded by sysMediaFinished
        // but still fired here as a compat alias so older scripts keep working.
        session.sounds.onMediaFinished = (name, path) => {
            this.raiseEvent('sysMediaFinished', [name, path]);
            this.raiseEvent('sysSoundFinished', [name, path]);
        };
        // Closed captions (Mudlet enableClosedCaption): print a text line when a
        // sound/music starts or stops, gated on the setting (decided per-event so
        // toggling takes effect live).
        session.sounds.onMediaCaption = (info) => this.printClosedCaption(info);
        // Mudlet fires sysExitEvent as the profile shuts down. The engine is
        // torn down on connection switch/unmount (destroy), but a full page
        // unload skips React cleanup — cover that with a beforeunload hook.
        window.addEventListener('beforeunload', this.beforeUnload);
        this.scriptsLoaded = new Promise<void>(resolve => { this.resolveScriptsLoaded = resolve; });
        // The VFS is injected already-mounted; the engine builds its runtime over
        // it but never mounts/unmounts (App owns that lifecycle).
        this.vfs = injectedVfs;
        this.runtimeReady = this.initRuntime();
        this.attachToStore(session);
    }

    /**
     * Subscribe to the appStore and apply diffs synchronously on every
     * mutation. Zustand fires subscribers synchronously inside `set()`, so a
     * UI action like `installPackage(...)` immediately propagates into the
     * Lua runtime — handlers register before the caller's next line runs.
     * That guarantee is what lets `notifyPackageInstalled` raise its event
     * right after the store update without a React commit in between.
     *
     * Covers all five entity types — scripts, aliases, triggers, timers,
     * keybindings — so the engine is the single owner of the
     * store-to-runtime mapping. The UI just dispatches store actions.
     *
     * The first apply is gated on `output.ready` because some scripts open
     * windows on load and the dock system needs to be wired up first.
     * Triggers additionally wait for the PCRE wasm via TriggerEngine.ready()
     * — patterns won't compile before that.
     */
    private attachToStore(session: MudSession): void {
        const start = async () => {
            // Wait for the VFS mount before touching disk-backed install paths.
            // In practice initRuntime resolves long before output.ready fires,
            // but the await is what guarantees this.vfs is non-null below.
            await this.runtimeReady.catch(() => { /* runtime failure already surfaced */ });

            // The main viewport's ResizeObserver first callback is spec-deferred
            // and can otherwise land after the script load below has already run
            // Geyser-based UI setup — GeyserReposition (which resolves percentage
            // container geometry into pixels) only runs on sysWindowResizeEvent,
            // so anything gated on that resolved geometry during sysLoadEvent/
            // sysInstallPackage (e.g. Adjustable.Container:attachToBorder) would
            // silently fail. Force one now that the Lua runtime (and onRaiseEvent)
            // both exist, before any script-load event fires; see
            // WindowManager.primeMainResize for the full race description.
            session.windows.primeMainResize();

            // The store was already seeded from this profile's VFS
            // (.mudix/profile.json) by App, before this session rendered — so the
            // loaded automation + UI data is in place before the default-package
            // install and apply* calls below, and before any synchronous render
            // read. The subscription isn't attached yet, so that hydrate didn't
            // trigger a write-back.

            // Install Mudlet's default packages (run-lua-code, …) into fresh profiles.
            // Idempotent: skips packages already in the store, so existing profiles
            // also pick up newly-added defaults on next open. Runs before
            // applyScriptsFromStore so the alias/script nodes participate in the
            // very first runtime load. Freshly-(re)installed names are remembered so
            // sysInstallPackage can be raised for them below, once their own
            // handlers are registered.
            let freshlyInstalledPackages: string[] = [];
            if (this.vfs) {
                freshlyInstalledPackages = await ensureDefaultPackages(this.connectionId, this.vfs);
                // See the disposal note below — the same race applies to this
                // await, and reloadModulesFromVfs() mutates the store.
                if (this.disposed) return;
            }

            // Modules are loaded from disk on every profile open — XML on disk is the
            // source of truth, so we re-read each module's XML and replace its nodes
            // before any script/alias/trigger load runs against the store. This
            // happens before the subscription is attached, so the reload itself
            // doesn't trigger a write-back loop.
            this.reloadModulesFromVfs();

            // Mudlet parity: the persisted map is parsed into the MapStore
            // before scripts run, so the initial script load (and sysLoadEvent)
            // sees an initialized map — hashes via getRoomIDbyHash and map-level
            // user data via getMapUserData are immediately queryable.
            const mapLoaded = await this.session.windows.bootstrapMap();

            // Closing the profile — or React's StrictMode remount, or a fast
            // profile switch — can destroy this engine while the awaits above are
            // still in flight. destroy() has then already closed the Lua VM and
            // dropped the store subscription, but this continuation is still
            // queued and would run the whole profile's script bodies anyway:
            // applyScriptsFromStore → reloadScript → (runtimes.lua now null) →
            // runtimeReady.then(...) → a full 198-script load into a dead engine.
            // Observed as N concurrent zombie engines per open, each re-running
            // every script, and intermittently as a hard main-thread freeze when
            // a load lands on a freed lua_State. Bail instead.
            if (this.disposed) return;

            // Saved Lua globals go back into _G before any script runs, so script
            // bodies and sysLoadEvent handlers see their persisted state.
            this.restoreSavedVariables();
            this.applyScriptsFromStore();
            this.applyAliasesFromStore();
            this.applyTimersFromStore();
            this.applyKeybindingsFromStore();
            this.warnBrowserReservedKeybindings();
            this.storeUnsub = useAppStore.subscribe((state, prevState) => {
                const id = this.connectionId;
                const scriptsChanged  = state.connectionScripts[id]      !== prevState.connectionScripts[id];
                const aliasesChanged  = state.connectionAliases[id]      !== prevState.connectionAliases[id];
                const timersChanged   = state.connectionTimers[id]       !== prevState.connectionTimers[id];
                const keysChanged     = state.connectionKeybindings[id]  !== prevState.connectionKeybindings[id];
                const triggersChanged = state.connectionTriggers[id]     !== prevState.connectionTriggers[id];
                const buttonsChanged  = state.connectionButtons[id]      !== prevState.connectionButtons[id];
                const packagesChanged = state.connectionPackages[id]     !== prevState.connectionPackages[id];

                if (scriptsChanged) this.applyScriptsFromStore();
                if (aliasesChanged) this.applyAliasesFromStore();
                if (timersChanged)  this.applyTimersFromStore();
                if (keysChanged)    this.applyKeybindingsFromStore();
                if (this.triggersReady && triggersChanged) this.scheduleTriggerApply();

                const automationChanged = scriptsChanged || aliasesChanged || timersChanged
                    || keysChanged || triggersChanged || buttonsChanged || packagesChanged;

                // The per-profile UI/settings/layout slices also live in the VFS
                // now, so a change to any of them must trigger a profile save too.
                const uiChanged =
                       state.connectionProfile[id]            !== prevState.connectionProfile[id]
                    || state.connectionWindowHints[id]        !== prevState.connectionWindowHints[id]
                    || state.connectionDockExtents[id]        !== prevState.connectionDockExtents[id]
                    || state.connectionScriptEditorBounds[id] !== prevState.connectionScriptEditorBounds[id]
                    || state.connectionModalBounds[id]        !== prevState.connectionModalBounds[id]
                    || state.connectionLayoutSnapshots[id]    !== prevState.connectionLayoutSnapshots[id]
                    // Only the save-list (config) triggers a save; captured values are
                    // refreshed by the flush itself and must not re-arm it.
                    || state.connectionVariables[id]?.saveList !== prevState.connectionVariables[id]?.saveList;

                // Persist this profile's data to its VFS on any change.
                if (automationChanged || uiChanged) this.scheduleProfileDataSave();

                // Sync-on-edit for modules: any tagged-node mutation schedules
                // a debounced XML rewrite for affected modules.
                if (automationChanged) {
                    this.scheduleModuleSyncForChanges(state, prevState);
                }
            });

            // Triggers need PCRE wasm, so unlike every other unit they can't be
            // compiled synchronously. Mudlet compiles them as part of the load
            // (getTriggerUnit()->compileAll(), Host.cpp) and only *then* raises
            // sysLoadEvent, so a handler always runs against live triggers — and
            // scripts rely on that: one that calls permRegexTrigger/tempTrigger
            // from a sysLoadEvent handler would otherwise have the store change
            // dropped by the `triggersReady` guard above and its trigger would
            // silently never fire. So wait for the compile here, before the load
            // events, rather than letting it land after them. The subscription is
            // already attached, so anything those handlers create propagates.
            let triggersCompiled = true;
            try {
                await TriggerEngine.ready();
            } catch {
                triggersCompiled = false; // wasm init failed; load still completes
            }
            // destroy() during the await already closed the Lua VM and calls
            // markScriptsLoaded() itself, so bailing here can't strand a connect.
            if (this.disposed) return;
            if (triggersCompiled) {
                this.triggersReady = true;
                this.applyTriggersFromStore();
            }

            // sysLoadEvent fires first, before notifying freshly-installed
            // default/brand packages of their install. In real Mudlet,
            // sysInstallPackage and sysLoadEvent essentially never fire together
            // in the same burst for one package — a package is either installed
            // into an already-running profile (only sysInstallPackage fires) or
            // a profile with already-installed packages is opened (only
            // sysLoadEvent fires, against a package whose saved state already
            // reflects a prior real install). mudix's default/brand-package
            // bootstrap is the one case that fires both, synchronously, for the
            // same freshly-installed package — and a package's own sysLoadEvent
            // handler commonly restores saved UI/layout state (e.g. Mudlet's
            // Adjustable.Container:load()) captured before the package had ever
            // run its sysInstallPackage setup. Firing install-notify first let
            // that later load-restore silently undo whatever install just set up
            // (e.g. attachToBorder) with no error anywhere. Firing sysLoadEvent
            // first instead makes sysInstallPackage's setup the last word for
            // this bootstrap, matching what a real first-time install feels like
            // to the package (nothing left to load/restore over it yet).
            // sysMapLoadEvent follows when a persisted map was ingested, so
            // scripts can register a sysMapLoadEvent handler during sysLoadEvent
            // and still see the firing for the boot-time load.
            // Map-open notification keeps map-aware scripts in sync if the
            // map is already visible at connection time.
            this.raiseEvent('sysLoadEvent');
            if (mapLoaded) this.raiseEvent('sysMapLoadEvent');
            if (this.api.windows.isVisible('map')) this.mapOpen.notify();
            // Default/brand packages installed just above never go through
            // installPackageFromVfsPath, so notifyPackageInstalled was never
            // called for them — fire it now that their own scripts are loaded
            // (applyScriptsFromStore, above) and can see it.
            for (const name of freshlyInstalledPackages) this.notifyPackageInstalled(name);
            this.api.flushOutput();

            // Capture the merged boot state (loaded file + freshly-installed default
            // packages + reloaded modules) once, since those mutations ran before
            // the subscription was attached and so didn't schedule a write.
            if (this.vfs) this.scheduleProfileDataSave();

            // Everything is wired: scripts/aliases/timers/keys applied, triggers
            // compiled, load events delivered. Unblocks whenScriptsLoaded() and
            // dials any connect deferred during the load.
            this.markScriptsLoaded();
        };
        const safeStart = () => {
            start().catch(err => {
                console.warn('[ScriptingEngine] start failed:', err);
                // start() bailed before the trigger-ready block could mark the
                // load complete — unblock any awaiting/deferred connect so a
                // failed load doesn't leave the profile permanently un-dialed.
                this.markScriptsLoaded();
            });
        };
        if (session.outputReady) {
            safeStart();
        } else {
            this.unsubs.push(session.events.on('output.ready', safeStart, { once: true }));
        }
    }

    /**
     * For each installed module, re-parse its on-disk XML and replace its tagged
     * nodes in the store. Errors are logged but don't abort the rest of profile
     * load — a corrupted module shouldn't take the whole session down.
     */
    private reloadModulesFromVfs(): void {
        const vfs = this.vfs;
        if (!vfs) return;
        const id = this.connectionId;
        const packages = useAppStore.getState().connectionPackages[id] ?? [];
        for (const pkg of packages) {
            if (pkg.kind !== 'module') continue;
            try {
                const data = reloadModuleFromVfs(pkg, vfs);
                useAppStore.getState().installPackage(id, pkg, data);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.api.printError(`[module] failed to reload "${pkg.name}": ${msg}`);
            }
        }
    }

    /**
     * Detect whether any node tagged with a sync-enabled module's name changed
     * between two store states; for each module that changed, schedule a
     * debounced write of its current XML to disk. Comparison is done per
     * collection so an unrelated change in another module doesn't cause a write.
     */
    private scheduleModuleSyncForChanges(state: ReturnType<typeof useAppStore.getState>, prevState: ReturnType<typeof useAppStore.getState>): void {
        const id = this.connectionId;
        const packages = state.connectionPackages[id] ?? [];
        const dirtyModules = packages.filter(p => p.kind === 'module' && p.sync);
        if (dirtyModules.length === 0) return;

        for (const pkg of dirtyModules) {
            const changed =
                hasTaggedSliceChanged(pkg.name, state.connectionScripts[id],     prevState.connectionScripts[id]) ||
                hasTaggedSliceChanged(pkg.name, state.connectionAliases[id],     prevState.connectionAliases[id]) ||
                hasTaggedSliceChanged(pkg.name, state.connectionTriggers[id],    prevState.connectionTriggers[id]) ||
                hasTaggedSliceChanged(pkg.name, state.connectionTimers[id],      prevState.connectionTimers[id]) ||
                hasTaggedSliceChanged(pkg.name, state.connectionKeybindings[id], prevState.connectionKeybindings[id]) ||
                hasTaggedSliceChanged(pkg.name, state.connectionButtons[id],     prevState.connectionButtons[id]);
            if (changed) this.queueModuleSync(pkg.name);
        }
    }

    private queueModuleSync(moduleName: string): void {
        const existing = this.moduleSyncTimers.get(moduleName);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.moduleSyncTimers.delete(moduleName);
            this.syncModuleToFile(moduleName).catch(err => {
                const msg = err instanceof Error ? err.message : String(err);
                this.api.printError(`[module] sync failed for "${moduleName}": ${msg}`);
            });
        }, ScriptingEngine.MODULE_SYNC_DEBOUNCE_MS);
        this.moduleSyncTimers.set(moduleName, timer);
    }

    /** Debounce a write of this profile's automation data to its VFS. */
    private scheduleProfileDataSave(): void {
        if (!this.vfs) return;
        if (this.profileDataSaveTimer) clearTimeout(this.profileDataSaveTimer);
        this.profileDataSaveTimer = setTimeout(() => {
            this.profileDataSaveTimer = null;
            this.flushProfileData();
        }, ScriptingEngine.PROFILE_DATA_SAVE_DEBOUNCE_MS);
    }

    /** Write this profile's automation data to its VFS now. */
    private flushProfileData(): void {
        const vfs = this.vfs;
        if (!vfs) return;
        if (this.profileDataSaveTimer) {
            clearTimeout(this.profileDataSaveTimer);
            this.profileDataSaveTimer = null;
        }
        try {
            this.captureSavedVariables();
            // Linked Mudlet profile write-back is DISABLED: serializeMudletXml does
            // NOT yet produce Mudlet-loadable XML (it emits trigger/alias/etc. flags
            // as child elements rather than the attributes Mudlet's parser reads, and
            // omits some fields), so writing it back corrupts the profile for Mudlet.
            // Link mode stays read-only until the serializer is fixed + verified
            // against real Mudlet output. See writeBackLinkedProfile.
            if (LINKED_WRITEBACK_ENABLED && isMudletProfileVfs(vfs)) this.writeBackLinkedProfile(vfs);
            saveProfileData(vfs, this.connectionId);
            // writeFile only updates the RAM cache; both IDB- and folder-backed
            // mounts persist to the backend on flush(). Drain now so the write is
            // durable immediately rather than waiting for an unrelated flush
            // (matches every other VFS write site, e.g. package install). On
            // destroy() the subsequent oldVfs.flush() covers the same data too.
            void vfs.flush();
        } catch (err) {
            console.warn('[ScriptingEngine] profile data save failed:', err);
        }
    }

    /**
     * Restore this profile's saved Lua globals (Mudlet `<VariablePackage>`) into
     * `_G`. Called once before the initial script load so handlers see their
     * persisted state, and again after a profile reset (fresh global table).
     */
    private restoreSavedVariables(): void {
        const rt = this.runtimes.lua;
        if (!rt) return;
        const values = useAppStore.getState().connectionVariables[this.connectionId]?.values;
        if (!values || values.length === 0) return;
        try {
            rt.restoreVariables(values);
        } catch (err) {
            console.warn('[ScriptingEngine] variable restore failed:', err);
        }
    }

    /**
     * Snapshot the save-listed globals out of `_G` into the store, just before a
     * profile-data flush so the values land in `.mudix/profile.json`. Updates
     * only the values (the save-list array reference is preserved), so the save
     * subscription — which keys on the save-list — doesn't reschedule a flush.
     */
    private captureSavedVariables(): void {
        const rt = this.runtimes.lua;
        if (!rt) return;
        const state = useAppStore.getState();
        const saveList = state.connectionVariables[this.connectionId]?.saveList;
        if (!saveList || saveList.length === 0) return;
        try {
            state.setVariableValues(this.connectionId, rt.captureVariables(saveList));
        } catch (err) {
            console.warn('[ScriptingEngine] variable capture failed:', err);
        }
    }

    /**
     * Write the live store state back into a linked Mudlet folder's profile save.
     * Bases on the newest parseable save (so external Mudlet edits to Host/unknown
     * fields are preserved), replaces the automation + variable packages with
     * mudix's current data, and writes a Mudlet-style timestamped file in current/
     * — one per session, overwritten on subsequent saves (the overwrite is safe
     * now that the folder backend truncates). Mudlet loads the newest such file.
     */
    private writeBackLinkedProfile(vfs: ProfileVFS): void {
        try {
            // Base on the newest *parseable* save, so a corrupt save is healed
            // (rewritten clean) rather than aborting the write.
            const base = readNewestParseableXml(vfs);
            if (!base) return;
            const s = useAppStore.getState();
            const id = this.connectionId;
            const trees: SerializeInput = {
                scripts: s.connectionScripts[id] ?? [],
                aliases: s.connectionAliases[id] ?? [],
                triggers: s.connectionTriggers[id] ?? [],
                timers: s.connectionTimers[id] ?? [],
                keys: s.connectionKeybindings[id] ?? [],
                buttons: s.connectionButtons[id] ?? [],
            };
            const values = s.connectionVariables[id]?.values ?? [];
            const xml = buildLinkedWriteback(
                base.xml, trees, { hidden: [], variables: values }, s.connectionProfile[id],
            );
            // One timestamped save per session (Mudlet's naming), overwritten on
            // later flushes so a session doesn't flood current/ with files.
            this.mudletSaveName ??= `${mudletTimestamp(new Date())}.xml`;
            vfs.writeFile(`current/${this.mudletSaveName}`, xml);
        } catch (err) {
            console.warn('[ScriptingEngine] Mudlet write-back failed:', err);
        }
    }

    /** `_G` entries for the Variables view (user globals nested, built-ins
     *  flagged). Empty until the runtime is up. */
    listGlobals(): LuaGlobalEntry[] {
        return this.runtimes.lua?.listGlobals() ?? [];
    }

    /**
     * Write the current in-store nodes for a module back to its XML file on disk.
     * Used both by the auto-sync debounce and the "Sync to file" UI action.
     */
    async syncModuleToFile(moduleName: string): Promise<void> {
        const vfs = this.vfs;
        if (!vfs) throw new Error('no profile VFS available');
        const id = this.connectionId;
        const state = useAppStore.getState();
        const pkg = (state.connectionPackages[id] ?? []).find(p => p.name === moduleName);
        if (!pkg) throw new Error(`module not installed: ${moduleName}`);
        if (pkg.kind !== 'module') throw new Error(`not a module: ${moduleName}`);
        const path = moduleXmlAbsolutePath(pkg, vfs);
        if (!path) throw new Error(`module "${moduleName}" has no xmlPath`);

        const filterPkg = <T extends { packageName?: string }>(arr: T[] | undefined): T[] =>
            (arr ?? []).filter(n => n.packageName === moduleName);

        const xml = serializeMudletXml({
            scripts:  filterPkg(state.connectionScripts[id]),
            aliases:  filterPkg(state.connectionAliases[id]),
            triggers: filterPkg(state.connectionTriggers[id]),
            timers:   filterPkg(state.connectionTimers[id]),
            keys:     filterPkg(state.connectionKeybindings[id]),
            buttons:  filterPkg(state.connectionButtons[id]),
        }, moduleName);

        const parent = path.substring(0, path.lastIndexOf('/'));
        if (parent && !vfs.exists(parent)) vfs.mkdir(parent);
        vfs.writeFile(path, xml);
        await vfs.flush();
        this.raiseEvent('sysSyncOnModule', [moduleName]);
    }

    /**
     * Re-read a module's XML from disk and replace its tagged nodes in the store.
     * Pairs with the "Reload from file" UI action.
     */
    reloadModuleFromFile(moduleName: string): boolean {
        const vfs = this.vfs;
        if (!vfs) {
            this.api.printError('[module] no profile VFS available');
            return false;
        }
        const id = this.connectionId;
        const pkg = (useAppStore.getState().connectionPackages[id] ?? []).find(p => p.name === moduleName);
        if (!pkg || pkg.kind !== 'module') {
            this.api.printError(`[module] not a module: ${moduleName}`);
            return false;
        }
        try {
            const data = reloadModuleFromVfs(pkg, vfs);
            useAppStore.getState().installPackage(id, pkg, data);
            this.raiseEvent('sysReadModuleEvent', [moduleName]);
            return true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.api.printError(`[module] reload failed for "${moduleName}": ${msg}`);
            return false;
        }
    }

    /** Toggle a module's sync flag. Updates the manifest in the store. */
    setModuleSync(moduleName: string, sync: boolean): void {
        const id = this.connectionId;
        useAppStore.getState().updatePackageManifest(id, moduleName, { sync });
    }

    /** Read a module's sync flag. Returns false if the package isn't a module. */
    getModuleSync(moduleName: string): boolean {
        const pkg = this.findManifest(moduleName);
        return pkg?.kind === 'module' && !!pkg.sync;
    }

    /**
     * Set a module's load priority. Negative values cause its scripts to load
     * before profile scripts on the next full reload. The priority is metadata
     * only — changing it doesn't re-run anything; the new order takes effect on
     * the next profile open or explicit reload.
     */
    setModulePriority(moduleName: string, priority: number): boolean {
        const pkg = this.findManifest(moduleName);
        if (pkg?.kind !== 'module') return false;
        const p = Math.trunc(Number(priority) || 0);
        useAppStore.getState().updatePackageManifest(this.connectionId, moduleName, { priority: p });
        return true;
    }

    /** Read a module's load priority (default 0). Returns 0 for non-modules. */
    getModulePriority(moduleName: string): number {
        const pkg = this.findManifest(moduleName);
        if (pkg?.kind !== 'module') return 0;
        return pkg.priority ?? 0;
    }

    /** List installed module names. Order matches install order. */
    getModuleNames(): string[] {
        const packages = useAppStore.getState().connectionPackages[this.connectionId] ?? [];
        return packages.filter(p => p.kind === 'module').map(p => p.name);
    }

    /** Snapshot of a module's manifest, or null if not installed / not a module. */
    getModuleInfo(moduleName: string): PackageManifest | null {
        const pkg = this.findManifest(moduleName);
        return pkg?.kind === 'module' ? { ...pkg } : null;
    }

    /**
     * In-memory custom info fields set via setPackageInfo / setModuleInfo. These
     * mirror Mudlet's mPackageInfo / mModuleInfo — volatile string→string maps
     * that overlay the manifest-derived fields, repopulated by scripts as
     * needed (Mudlet itself loses them on restart too).
     */
    private packageInfoOverrides = new Map<string, Map<string, string>>();
    private moduleInfoOverrides = new Map<string, Map<string, string>>();

    /** Manifest's standard info fields as a string→string map (Mudlet's
     *  config.lua-derived package info keys). Empty values are omitted. */
    private manifestInfoBase(pkg: PackageManifest): Record<string, string> {
        const base: Record<string, string> = {};
        const put = (k: string, v: unknown) => {
            if (v !== undefined && v !== null && v !== '') base[k] = String(v);
        };
        put('name', pkg.name);
        put('title', pkg.title);
        put('author', pkg.author);
        put('version', pkg.version);
        put('description', pkg.description);
        put('created', pkg.created);
        put('icon', pkg.icon);
        put('installed', pkg.installedAt);
        return base;
    }

    /** Overlay the in-memory custom fields for `name` onto `base` (mutates). */
    private applyInfoOverrides(base: Record<string, string>, overrides: Map<string, Map<string, string>>, name: string): void {
        const ov = overrides.get(name);
        if (ov) for (const [k, v] of ov) base[k] = v;
    }

    /** Mudlet `getPackageInfo(name)`. Manifest fields overlaid with anything set
     *  via setPackageInfo. Empty table when the package is unknown and nothing
     *  was set for that name. */
    getPackageInfo(name: string): Record<string, string> {
        const pkg = this.findManifest(name);
        const base = pkg ? this.manifestInfoBase(pkg) : {};
        this.applyInfoOverrides(base, this.packageInfoOverrides, name);
        return base;
    }

    /** Mudlet `setPackageInfo(name, key, value)`. Records a custom info field.
     *  Always succeeds (matches Mudlet, which sets the map unconditionally). */
    setPackageInfo(name: string, key: string, value: string): boolean {
        if (!key) return false;
        let ov = this.packageInfoOverrides.get(name);
        if (!ov) { ov = new Map(); this.packageInfoOverrides.set(name, ov); }
        ov.set(key, value);
        return true;
    }

    /** Mudlet `setModuleInfo(name, key, value)`. Records a custom info field
     *  surfaced by getModuleInfo. Always succeeds. */
    setModuleInfo(name: string, key: string, value: string): boolean {
        if (!key) return false;
        let ov = this.moduleInfoOverrides.get(name);
        if (!ov) { ov = new Map(); this.moduleInfoOverrides.set(name, ov); }
        ov.set(key, value);
        return true;
    }

    /**
     * Mudlet `getModulePath(name) → path`. Absolute VFS path of an installed
     * module's XML. Modules referencing a file outside the managed package dir
     * store it verbatim in `xmlVfsPath`; packaged modules store an XML path
     * relative to `<profilePath>/<name>/`. Null when not installed, not a
     * module, or no path is resolvable.
     */
    getModulePath(moduleName: string): string | null {
        const pkg = this.findManifest(moduleName);
        if (pkg?.kind !== 'module') return null;
        if (pkg.xmlVfsPath) return pkg.xmlVfsPath;
        const vfs = this.vfs;
        if (!vfs || !pkg.xmlPath) return null;
        return `${vfs.profilePath}/${pkg.name}/${pkg.xmlPath}`;
    }

    /**
     * Install a module from a path inside the profile VFS. Plain XML stays in
     * place (manifest holds the absolute VFS path). Zips/.mpackages extract into
     * the standard pkgDir. Raises sysInstall, sysInstallPackage and
     * sysInstallModule on success — sysInstallModule is the module-specific
     * counterpart to sysInstallPackage. This method is reached only via the
     * Lua `installModule()` binding, so it also raises Mudlet's
     * `sysLuaInstallModule` (name, fileName) for ported-script parity.
     */
    installModuleFromPath(path: string): InstallOutcome {
        const vfs = this.vfs;
        if (!vfs) {
            const error = 'no profile VFS available';
            this.api.printError(`[installModule] ${error}`);
            return { ok: false, error };
        }
        try {
            const { manifest, data } = installModuleFromVfsPath(path, vfs);
            useAppStore.getState().installPackage(this.connectionId, manifest, data);
            this.notifyPackageInstalled(manifest.name);
            this.raiseEvent('sysInstallModule', [manifest.name]);
            this.raiseEvent('sysLuaInstallModule', [manifest.name, path]);
            // Mudlet raises sysSyncInstallModule for modules flagged to sync
            // (so sibling profiles reload them). mudix is single-profile, so
            // this fires locally for ported scripts that listen on it.
            if (manifest.sync) this.raiseEvent('sysSyncInstallModule', [manifest.name, path]);
            void vfs.flush();
            return { ok: true, error: null };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.api.printError(`[installModule] ${error}`);
            return { ok: false, error };
        }
    }

    /**
     * Uninstall a module by name. Refuses to act on regular packages so callers
     * can keep installPackage/uninstallPackage and installModule/uninstallModule
     * cleanly separated. Modules unlink — the on-disk XML is left in place.
     */
    uninstallModuleByName(moduleName: string): boolean {
        const pkg = this.findManifest(moduleName);
        if (pkg?.kind !== 'module') {
            this.api.printError(`[uninstallModule] not a module: ${moduleName}`);
            return false;
        }
        this.notifyPackageUninstalled(moduleName);
        this.raiseEvent('sysUninstallModule', [moduleName]);
        // Reached only via the Lua `uninstallModule()` binding — also raise
        // Mudlet's Lua-specific event for ported-script parity.
        this.raiseEvent('sysLuaUninstallModule', [moduleName]);
        // Mudlet's sync-module counterpart, fired for sync-flagged modules
        // (see sysSyncInstallModule above for the single-profile caveat).
        if (pkg.sync) this.raiseEvent('sysSyncUninstallModule', [moduleName]);
        useAppStore.getState().uninstallPackage(this.connectionId, moduleName);
        if (this.vfs) {
            const vfs = this.vfs;
            void uninstallPackageFiles(pkg, vfs).catch(err => {
                console.warn('[ScriptingEngine] failed to remove module files:', err);
            });
        }
        return true;
    }

    private findManifest(name: string): PackageManifest | undefined {
        return (useAppStore.getState().connectionPackages[this.connectionId] ?? []).find(p => p.name === name);
    }

    private applyAliasesFromStore(): void {
        const aliases = useAppStore.getState().connectionAliases[this.connectionId] ?? [];
        this.aliasEngine.loadPerm(aliases);
    }

    private applyTriggersFromStore(): void {
        this.triggersDirty = false;
        const triggers = useAppStore.getState().connectionTriggers[this.connectionId] ?? [];
        this.triggerEngine.loadPerm(triggers);
    }

    private scheduleTriggerApply(): void {
        if (this.triggersDirty) return;
        this.triggersDirty = true;
        queueMicrotask(() => {
            if (!this.triggersDirty) return;
            this.applyTriggersFromStore();
        });
    }

    /**
     * Drain any pending coalesced reloads synchronously. Callers that raise
     * events whose handlers may depend on the just-mutated store (e.g.
     * notifyPackageInstalled → sysInstallPackage) must call this between the
     * store update and the event so handlers see the post-mutation engine state.
     */
    flushPendingApplies(): void {
        if (this.triggersReady && this.triggersDirty) this.applyTriggersFromStore();
    }

    private applyTimersFromStore(): void {
        const timers = useAppStore.getState().connectionTimers[this.connectionId] ?? [];
        this.timerEngine.loadPerm(timers, (timer) => {
            if (timer.command) this.api.send(timer.command, false);
            if (timer.code && timer.language === 'lua') {
                try {
                    this.runtimes.lua?.run(timer.code, `timer "${timer.name}"`);
                } catch (err) {
                    this.reportEntityError('timer', timer.id, timer.name, err);
                }
            }
            this.api.flushOutput();
        });
    }

    private applyKeybindingsFromStore(): void {
        const keys = useAppStore.getState().connectionKeybindings[this.connectionId] ?? [];
        this.keyEngine.loadPerm(keys);
    }

    /**
     * On profile open, warn about enabled keybindings the browser intercepts
     * above the page (Ctrl+T new tab, Ctrl+W close tab, F12 devtools, …). Native
     * Mudlet packages bind these freely, but in a browser they can never reach
     * mudix — the warning explains why they "do nothing". Page-level shortcuts
     * mudix can still capture (Ctrl+R, Ctrl+S, F5, …) are intentionally not
     * flagged: they work while the client is focused, same as in Mudlet.
     * Fired once at load (not on every store change) so it can't spam the output.
     */
    private warnBrowserReservedKeybindings(): void {
        const keys = useAppStore.getState().connectionKeybindings[this.connectionId] ?? [];
        const enabledIds = buildEffectivelyEnabledIds(keys);
        const enabled = keys.filter(k => enabledIds.has(k.id));
        const reserved = findReservedKeybindings(enabled);
        if (reserved.length === 0) return;

        const plural = reserved.length === 1 ? '' : 's';
        this.session.events.emit('message',
            mudletWarn(`${reserved.length} keybinding${plural} may be intercepted by your browser:`),
            'info', Date.now());
        for (const r of reserved) {
            // Point at which keybinding is affected: its editor name and, when it
            // came from an installed package, the package it belongs to.
            const tags: string[] = [];
            if (r.node.name) tags.push(`"${r.node.name}"`);
            if (r.node.packageName) tags.push(`pkg: ${r.node.packageName}`);
            const where = tags.length ? ` (${tags.join(', ')})` : '';
            this.session.events.emit('message',
                mudletWarn(`  • ${r.combo}${where} — ${reservedKeyNote(r.action)}`),
                'info', Date.now());
        }
    }

    private applyScriptsFromStore(): void {
        const next = useAppStore.getState().connectionScripts[this.connectionId] ?? [];
        const prev = this.prevScripts;
        this.prevScripts = next;
        if (prev === next) return;

        const prevEnabledIds = buildEffectivelyEnabledIds(prev);
        const nextEnabledIds = buildEffectivelyEnabledIds(next);
        const prevEnabled = new Map(
            prev.filter(s => s.language === 'lua' && prevEnabledIds.has(s.id))
                .map(s => [s.id, s] as const),
        );
        const nextEnabledLuaIds = new Set(
            next.filter(s => s.language === 'lua' && nextEnabledIds.has(s.id))
                .map(s => s.id),
        );
        for (const id of prevEnabled.keys()) {
            if (!nextEnabledLuaIds.has(id)) this.unloadScript(id);
        }
        // Mudlet-style module load priority: scripts owned by modules with a
        // negative priority load before profile scripts; non-negative priorities
        // load after. Within a priority bucket, original array order is preserved
        // so existing trees stay deterministic. Profile-owned scripts (no
        // packageName) are treated as priority 0.
        const priorityMap = this.modulePriorityMap();
        const orderedNext = next
            .map((s, idx) => ({ s, idx, prio: priorityFor(s, priorityMap) }))
            .sort((a, b) => a.prio - b.prio || a.idx - b.idx);
        for (const { s } of orderedNext) {
            if (s.language !== 'lua' || !nextEnabledIds.has(s.id)) continue;
            const was = prevEnabled.get(s.id);
            const handlersChanged = !!was && was.eventHandlers.join('\n') !== s.eventHandlers.join('\n');
            if (!was || was.code !== s.code || handlersChanged) {
                this.reloadScript(s);
            }
        }
    }

    /** Map of module name → priority. Profile (no packageName) is implicitly 0. */
    private modulePriorityMap(): Map<string, number> {
        const map = new Map<string, number>();
        const packages = useAppStore.getState().connectionPackages[this.connectionId] ?? [];
        for (const p of packages) {
            if (p.kind === 'module') map.set(p.name, p.priority ?? 0);
        }
        return map;
    }

    private initRuntime(): Promise<IScriptingRuntime> {
        // VFS is already mounted (injected by App); just build the runtime over it.
        return this.createRuntime(this.vfs);
    }

    // ── EngineHost ───────────────────────────────────────────────────────────
    // The rest of the interface is satisfied by methods the engine already had
    // (toggleScriptByName, createPermTrigger, installModuleFromPath, …). Only
    // these seven existed solely as inline arrows in the old wiring block, so
    // they get real methods here.

    /** Run a chunk of Lua on behalf of a clicked hyperlink. */
    runLinkCode(code: string): void {
        const lua = this.runtimes.lua;
        if (!lua) return;
        try {
            lua.run(code, 'link');
        } catch (err) {
            this.api.printError(`[link] ${err instanceof Error ? err.message : String(err)}`);
        }
        this.api.flushOutput();
    }

    /** Mudlet `expandAlias` — run text through the alias pipeline, sending it
     *  to the MUD when nothing consumes it. */
    expandAlias(text: string, echo: boolean): void {
        if (!this.processInput(text)) this.api.send(text, echo);
    }

    /** Mudlet `reconnect()` — redial the last URL, refused during teardown. */
    requestReconnect(): boolean {
        if (this.disposed) { this.refuseDuringTeardown('reconnect()'); return false; }
        if (this.session.reconnect()) return true;
        // Nothing dialled yet this session, so there is no "last URL" to redial.
        // Mudlet's reconnect() works regardless — it re-reads the profile's
        // configured server — so fall back to that rather than doing nothing.
        const conn = useAppStore.getState().connections.find(c => c.id === this.connectionId);
        if (!conn) return false;
        const url = connectionUrl(conn, useAppStore.getState().client.userProxyUrl);
        if (!url) return false;
        this.session.connect(url);
        return true;
    }

    /** Raise sysDataSendRequest; true means a handler called denyCurrentSend(). */
    dispatchSendRequest(text: string): boolean {
        return this.runtimes.lua?.dispatchSendRequest(text) ?? false;
    }

    /** Names of every package installed in this profile. */
    getPackageNames(): string[] {
        return (useAppStore.getState().connectionPackages[this.connectionId] ?? []).map(p => p.name);
    }

    /** Module manifest fields as a flat record, with Lua-set overrides applied. */
    getModuleInfoRecord(name: string): Record<string, unknown> | null {
        const info = this.getModuleInfo(name);
        if (!info) return null;
        const rec = info as unknown as Record<string, unknown>;
        this.applyInfoOverrides(rec as Record<string, string>, this.moduleInfoOverrides, name);
        return rec;
    }

    /** Rewrite VFS-relative url(...) references to service-worker paths. */
    rewriteCss(css: string): string {
        const v = this.vfs;
        if (!v) return css;
        return rewriteVfsUrlsInCss(css, this.connectionId, v);
    }

    /** Rewrite VFS-relative `<img src>` / inline-style refs in Lua-supplied
     *  HTML to service-worker paths. */
    rewriteHtml(html: string): string {
        const v = this.vfs;
        if (!v) return html;
        return rewriteVfsUrlsInHtml(html, this.connectionId, v);
    }

    /** Raw-bytes reader for synchronous binary consumers (setMovie's GIF
     *  decoder). ProfileVFS resolves leading-slash paths absolutely (so
     *  getMudletHomeDir()-prefixed paths work) and relative ones against the
     *  profile root. */
    readFileBytes(path: string): Uint8Array | null {
        const v = this.vfs;
        if (!v) return null;
        try {
            return v.readBinaryFile(path);
        } catch {
            return null;
        }
    }

    private createRuntime(vfs: ProfileVFS | null): Promise<IScriptingRuntime> {
        return LuaRuntime.create(this.api, vfs, this.proxyUrlGetter).then(rt => {
            this.runtimes.lua = rt;
            // Sound loader: absolute URLs hit the network; everything else is
            // resolved against the mounted profile VFS so package-bundled sounds
            // work out of the box.
            this.session.sounds.setLoader(async (path) => {
                if (/^https?:|^data:|^blob:/.test(path)) {
                    const res = await fetch(path);
                    if (!res.ok) return null;
                    return await res.arrayBuffer();
                }
                const v = this.vfs;
                if (!v) return null;
                const abs = path.startsWith('/') ? `${v.profilePath}${path}` : `${v.profilePath}/${path}`;
                try {
                    const bytes = v.readBinaryFile(abs);
                    const out = new ArrayBuffer(bytes.byteLength);
                    new Uint8Array(out).set(bytes);
                    return out;
                } catch {
                    return null;
                }
            });
            // VideoManager reuses the same VFS-or-URL loader as sounds, and
            // emits sysMediaFinished on natural end (matching Mudlet).
            this.session.videos.setLoader(async (path) => {
                if (/^https?:|^data:|^blob:/.test(path)) {
                    const res = await fetch(path);
                    if (!res.ok) return null;
                    return await res.arrayBuffer();
                }
                const v = this.vfs;
                if (!v) return null;
                const abs = path.startsWith('/') ? `${v.profilePath}${path}` : `${v.profilePath}/${path}`;
                try {
                    const bytes = v.readBinaryFile(abs);
                    const out = new ArrayBuffer(bytes.byteLength);
                    new Uint8Array(out).set(bytes);
                    return out;
                } catch {
                    return null;
                }
            });
            this.session.videos.setMountPoint(() => this.session.windows.getMainViewportElement());
            this.session.videos.onEnded = (name, path) => this.raiseEvent('sysMediaFinished', [name, path]);
            this.session.videos.onMediaCaption = (info) => this.printClosedCaption(info);
            this.triggerEngine.setLuaEval((code) => {
                const lua = this.runtimes.lua;
                return lua ? lua.evalTriggerPattern(code) : false;
            });
            // Perm colorTrigger patterns delegate to the same buffer scan the
            // tempColorTrigger binding uses — both inspect the line that
            // beginLine() just appended to the main console.
            this.triggerEngine.setColorMatcher((fg, bg) => this.api.currentLineMatchesColor(fg, bg));
            return rt;
        }).catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[ScriptingEngine] Lua runtime init failed:', err);
            this.api.printError(`[scripting] Lua runtime init failed: ${msg}`);
            throw err;
        });
    }

    /**
     * Tear down a script's event-handler registrations. Used when a script is
     * removed or transitions enabled→disabled so its handlers stop firing
     * before the next full runtime reload.
     *
     * Runs synchronously once the runtime is up so the store-subscription
     * pipeline (script removed → handlers gone) completes inside the same
     * tick as the store mutation. See attachToStore for the rationale.
     */
    unloadScript(scriptId: string): void {
        const rt = this.runtimes.lua;
        if (rt) { rt.killScriptHandlers(scriptId); return; }
        this.runtimeReady.then(rt => rt.killScriptHandlers(scriptId)).catch(() => {});
    }

    /**
     * Raise sysInstall / sysInstallPackage. The caller is expected to have
     * just committed the package's items to the appStore — our subscription
     * loads the new scripts synchronously inside that commit, so by the time
     * this method runs the package's event handlers are already registered.
     */
    notifyPackageInstalled(packageName: string): void {
        this.flushPendingApplies();
        this.raiseEvent('sysInstall', [packageName]);
        this.raiseEvent('sysInstallPackage', [packageName]);
    }

    /**
     * Raise sysUninstall / sysUninstallPackage. Call this BEFORE removing the
     * package's items from the store so the package's own handlers (and the
     * scripts they live in) are still loaded when the event fires.
     */
    notifyPackageUninstalled(packageName: string): void {
        this.raiseEvent('sysUninstall', [packageName]);
        this.raiseEvent('sysUninstallPackage', [packageName]);
    }

    /**
     * Stage a File dropped on a window into the profile VFS, then raise Mudlet's
     * sysDropEvent(filepath, suffix, x, y, name) with the resulting VFS path. The
     * bundled packageDrop handler (Other.lua) picks it up and routes acceptable
     * suffixes to verbosePackageInstall / verboseModuleInstall — so dropping an
     * XML/.mpackage/.zip onto the main console or a userwindow installs it, the
     * same as Mudlet. Non-package files just land in the profile home dir, which
     * matches the harmless no-op packageDrop does for unrecognised suffixes.
     */
    private async stageDroppedFile(file: File, x: number, y: number, id: string): Promise<void> {
        const vfs = this.vfs;
        if (!vfs) return;
        const name = file.name || 'dropped-file';
        const dest = `${vfs.profilePath}/${name}`;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            vfs.writeBinaryFile(dest, bytes);
            await vfs.flush();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.api.printError(`[drop] could not stage ${name}: ${msg}`);
            return;
        }
        const dot = name.lastIndexOf('.');
        const suffix = dot >= 0 ? name.slice(dot + 1) : '';
        this.raiseEvent('sysDropEvent', [dest, suffix, x, y, id]);
    }

    /**
     * Install a package from a path inside the VFS. Reads the bytes synchronously,
     * commits to the store (which loads scripts into Lua synchronously via the
     * store subscription), then raises sysInstallPackage. The disk flush happens
     * in the background. Returns { ok: false, error } on any failure (file
     * missing, parse error, etc.) — the error string is both printed to the
     * script log and handed back to Lua for Mudlet's (ok, err) contract.
     */
    installPackageFromVfsPath(path: string): InstallOutcome {
        const vfs = this.vfs;
        if (!vfs) {
            const error = 'no profile VFS available';
            this.api.printError(`[installPackage] ${error}`);
            return { ok: false, error };
        }
        if (!vfs.exists(path)) {
            const error = `file not found: ${path}`;
            this.api.printError(`[installPackage] ${error}`);
            return { ok: false, error };
        }
        try {
            const buf = vfs.readBinaryFile(path);
            const filename = path.split('/').pop() || path;
            const { manifest, data } = installPackageFromBytes(filename, buf, vfs, { sourcePath: path });
            useAppStore.getState().installPackage(this.connectionId, manifest, data);
            this.notifyPackageInstalled(manifest.name);
            void vfs.flush();
            return { ok: true, error: null };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.api.printError(`[installPackage] ${error}`);
            return { ok: false, error };
        }
    }

    /**
     * Handle a `Client.GUI` GMCP message: download the URL and install the
     * resulting package. Honors `client.allowMudPackageInstall` (default true,
     * undefined = true). Deduplicates against previously-installed packages
     * via `manifest.sourceUrl` + `manifest.sourceVersion` so the same MUD
     * telling us to install on every connect doesn't churn the file system.
     * The server's declared version is recorded as `sourceVersion` and never
     * overwrites the package's own `version` — matching Mudlet, which keeps it
     * in a separate `Host::mServerGUI_Package_version`.
     */
    /**
     * Dispatch a parsed `!!SOUND` / `!!MUSIC` tag to the SoundManager. `Off`
     * stops playback; otherwise the file is resolved against `<profile>/media/`
     * (downloading from `U=` on cache miss) and the resulting VFS path is
     * handed to the SoundManager.
     */
    /**
     * Print a closed caption for a media play/stop, when `enableClosedCaption`
     * is on (Mudlet's `TMedia::printClosedCaption`). The line is emitted as
     * normal main-output text so it renders, is logged, and rides the screen-
     * reader announce path — exactly as Mudlet's `mpConsole->print()` does.
     */
    private printClosedCaption(info: MediaCaptionInfo): void {
        if (!this.api.getConfig('enableClosedCaption')) return;
        this.session.events.emit('message', formatClosedCaption(info), 'caption', Date.now());
    }

    private async handleMspCommand(command: MspCommand): Promise<void> {
        const debug = debugMspEnabled();
        // Any tag carrying U= updates the per-kind default base URL.
        // Alteraeon (and others) use `!!SOUND(Off U=https://.../wav_v1/)` at
        // session start to point us at the sound pack, then send subsequent
        // tags without U=. Track per-kind so sounds/music can come from
        // different hosts.
        if (command.url) this.mspBaseUrl[command.kind] = command.url;
        const isOff = command.file === 'Off';
        if (isOff) {
            if (command.kind === 'sound') this.session.sounds.stopSounds();
            else this.session.sounds.stopMusic(command.type ? { tag: command.type } : {});
            if (debug) console.debug(`[mudix.msp] dispatch stop ${command.kind}`, command.type ? `tag=${command.type}` : '');
            return;
        }
        const name = await this.resolveMspMedia(command);
        if (!name) return;
        // MSP is server-driven, so it rides the 'game' mute gate (muteMediaGame).
        const opts: { name: string; volume?: number; loops?: number; tag?: string; continue?: boolean; origin?: 'api' | 'game' } = { name, origin: 'game' };
        if (command.volume !== undefined) opts.volume = command.volume;
        if (command.loops !== undefined) opts.loops = command.loops;
        if (command.type) opts.tag = command.type;
        if (command.kind === 'music') {
            if (command.continueIfPlaying) opts.continue = true;
            if (debug) console.debug('[mudix.msp] dispatch playMusic', opts);
            void this.session.sounds.playMusic(opts);
        } else {
            if (debug) console.debug('[mudix.msp] dispatch playSound', opts);
            void this.session.sounds.playSound(opts);
        }
    }

    /**
     * Resolve an MSP `file` (+ optional `U=` base URL) to a VFS-relative path
     * the SoundManager loader can read. Per the MSP spec `U=` is a *directory*
     * the filename is appended to (not a full URL). Downloads land in
     * `<profile>/media/` and are reused on subsequent plays and across page
     * reloads. Returns null when the file can't be located or fetched.
     */
    private async resolveMspMedia(command: MspCommand): Promise<string | null> {
        // Per-command U= wins; otherwise use the kind's default set by an
        // earlier tag (often the Alteraeon-style `Off U=...` boot directive).
        const baseUrl = command.url ?? this.mspBaseUrl[command.kind];
        return this.resolveMediaFile(command.file ?? '', baseUrl, '[mudix.msp]', debugMspEnabled());
    }

    /**
     * Resolve a media `file` (+ optional base `url` directory) to a VFS-relative
     * path under `media/` the SoundManager loader can read, downloading and
     * caching it on a miss. Shared by MSP (`resolveMspMedia`) and the GMCP media
     * protocol (`handleClientMedia`). The whole filename — including any
     * subdirectories — is appended to the base URL and mirrored under `media/`,
     * so the cache layout matches the server's. `..`/`.` segments are rejected
     * so a hostile server can't escape the cache root. Returns null when the
     * file can't be located or fetched.
     */
    private async resolveMediaFile(
        file: string,
        baseUrl: string | undefined,
        logPrefix: string,
        debug: boolean,
    ): Promise<string | null> {
        const vfs = this.vfs;
        if (!vfs) {
            if (debug) console.debug(`${logPrefix} no profile VFS — cannot resolve media`);
            return null;
        }
        const raw = (file ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
        const segments = raw.split('/').filter(s => s.length > 0);
        const cleanSegments: string[] = [];
        for (const seg of segments) {
            if (seg === '.' || seg === '..') {
                if (debug) console.debug(`${logPrefix} rejecting traversal segment in "${file}"`);
                return null;
            }
            const clean = seg.replace(/[^\w.\-]/g, '_').replace(/^\.+/, '');
            if (!clean) {
                if (debug) console.debug(`${logPrefix} empty segment after sanitising "${file}"`);
                return null;
            }
            cleanSegments.push(clean);
        }
        if (cleanSegments.length === 0) {
            if (debug) console.debug(`${logPrefix} empty filename "${file}"`);
            return null;
        }
        const cleanFile = cleanSegments.join('/');
        const vfsPath = `media/${cleanFile}`;
        const absPath = `${vfs.profilePath}/${vfsPath}`;
        if (vfs.exists(absPath)) {
            if (debug) console.debug(`${logPrefix} cache hit ${vfsPath}`);
            return vfsPath;
        }
        if (!baseUrl) {
            if (debug) console.debug(`${logPrefix} "${cleanFile}" not in media/ and no base URL`);
            return null;
        }
        let downloadUrl: string;
        try {
            // URL() treats `base` as a file when it has no trailing slash, so
            // normalise: `http://x/sounds` + `zap.wav` → `http://x/sounds/zap.wav`.
            const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
            downloadUrl = new URL(cleanFile, base).toString();
        } catch {
            if (debug) console.debug(`${logPrefix} invalid base URL "${baseUrl}"`);
            return null;
        }
        try {
            const bytes = await downloadFromUrl(downloadUrl, this.proxyUrlGetter());
            vfs.writeBinaryFile(absPath, bytes);
            if (debug) console.debug(`${logPrefix} downloaded ${downloadUrl} → ${vfsPath} (${bytes.byteLength} bytes)`);
            return vfsPath;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (debug) console.debug(`${logPrefix} download failed ${downloadUrl}: ${msg}`);
            return null;
        }
    }

    /**
     * Handle a GMCP media message (`Client.Media.Play/Load/Stop/Default`).
     * Mirrors Mudlet's `TMedia` MediaProtocolGMCP. The payload is the already-
     * parsed JSON body; `action` is the lowercased segment after `Client.Media`
     * (defaulting to `play`, matching Mudlet's bare `Client.Media`). Server-
     * driven, so playback rides the `game` mute gate like MSP.
     */
    private async handleClientMedia(action: string, value: unknown): Promise<void> {
        const debug = debugGmcpEnabled();
        // Per-profile opt-out (undefined/true = allowed), Mudlet's
        // mAcceptServerMedia. Bail before anything is resolved or downloaded —
        // this is a hard block, not the `game` mute gate (which still fetches
        // and plays, silently). Mudlet drops the message just as early, in
        // cTelnet::setGMCPVariables and again atop TMedia::parseGMCP, and it
        // still advertises "Client.Media 1" in Core.Supports.Set either way,
        // so MudClient's handshake stays untouched.
        if (useAppStore.getState().connectionProfile[this.connectionId]?.allowServerMedia === false) {
            if (debug) console.debug(`[mudix.gmcp] media ${action} ignored (disabled in settings)`);
            return;
        }
        const obj: Record<string, unknown> =
            value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
        const str = (k: string): string => {
            const v = obj[k];
            return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
        };
        const num = (k: string): number | undefined => {
            const v = obj[k];
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
            return undefined;
        };
        const bool = (k: string): boolean | undefined => {
            const v = obj[k];
            if (typeof v === 'boolean') return v;
            if (typeof v === 'string') return v.toLowerCase() === 'true';
            return undefined;
        };

        if (action === 'default') {
            // Client.Media.Default { url } — remember the base directory for
            // later Play/Load messages that omit their own url.
            const url = str('url');
            if (url) this.gmcpMediaDefaultUrl = url;
            if (debug) console.debug(`[mudix.gmcp] media default url=${url || '(none)'}`);
            return;
        }

        if (action === 'stop') {
            // Client.Media.Stop [{ name, type, tag, key, fadeout }] — stop
            // matching media (everything when no filters are given).
            const type = str('type').toLowerCase();
            const name = str('name') || undefined;
            const key = str('key') || undefined;
            const tag = str('tag') || undefined;
            const fadeout = num('fadeout');
            if (type !== 'sound') {
                this.session.sounds.stopMusic({ name, key, tag, fadeout });
            }
            if (type !== 'music') {
                this.session.sounds.stopSounds();
            }
            if (debug) console.debug(`[mudix.gmcp] media stop type=${type || 'all'}`);
            return;
        }

        // Play / Load both need a resolved file.
        const name = str('name');
        if (!name) return;
        const baseUrl = str('url') || this.gmcpMediaDefaultUrl || undefined;
        const resolved = await this.resolveMediaFile(name, baseUrl, '[mudix.gmcp] media', debug);
        if (!resolved) return;

        if (action === 'load') {
            // Client.Media.Load — preload/cache only, don't play.
            this.session.sounds.preload(resolved);
            if (debug) console.debug(`[mudix.gmcp] media load ${resolved}`);
            return;
        }

        // action === 'play' (or bare Client.Media).
        const type = (str('type') || 'sound').toLowerCase();
        const opts: PlayMusicOptions = { name: resolved, origin: 'game' };
        const volume = num('volume');
        if (volume !== undefined) opts.volume = volume;
        const loops = num('loops');
        if (loops !== undefined) opts.loops = loops;
        const fadein = num('fadein');
        if (fadein !== undefined) opts.fadein = fadein;
        const fadeout = num('fadeout');
        if (fadeout !== undefined) opts.fadeout = fadeout;
        const start = num('start');
        if (start !== undefined) opts.start = start;
        const key = str('key');
        if (key) opts.key = key;
        const tag = str('tag');
        if (tag) opts.tag = tag;

        if (type === 'music') {
            // Mudlet's music `continue` defaults to true — a repeat Play of the
            // same track is ignored while it's already playing.
            opts.continue = bool('continue') ?? true;
            if (debug) console.debug('[mudix.gmcp] media playMusic', opts);
            void this.session.sounds.playMusic(opts);
        } else {
            if (debug) console.debug('[mudix.gmcp] media playSound', opts);
            void this.session.sounds.playSound(opts);
        }
    }

    private async handleClientGuiInstall(value: unknown): Promise<void> {
        const parsed = parseClientGuiPayload(value);
        if (!parsed) return;
        const { url, version } = parsed;

        // Per-profile opt-out (undefined/true = allowed).
        const allowInstall = useAppStore.getState().connectionProfile[this.connectionId]?.allowMudPackageInstall;
        if (allowInstall === false) {
            this.session.events.emit('message',
                mudletInfo(`ignored install request for ${url} (disabled in settings)`),
                'info', Date.now());
            return;
        }

        // Same URL already installed, and the server names no newer delivery
        // revision → no-op. Compared against sourceVersion (what the server
        // said last time), never the package's own version — see
        // isClientGuiRedelivery for why an absent version means "skip".
        const existing = (useAppStore.getState().connectionPackages[this.connectionId] ?? [])
            .find(p => p.sourceUrl === url);
        if (isClientGuiRedelivery(existing, version)) return;

        const vfs = this.vfs;
        if (!vfs) {
            this.api.printError(`[Client.GUI] no profile VFS available`);
            return;
        }

        const displayName = filenameFromUrl(url).replace(/\.[^.]+$/, '') || 'package';
        this.session.events.emit('message',
            mudletInfo(`Downloading and installing package '${displayName}' (url='${url}').`),
            'info', Date.now());

        let bytes: Uint8Array;
        try {
            bytes = await downloadFromUrl(url, this.proxyUrlGetter());
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.api.printError(`[Client.GUI] download failed: ${msg}`);
            return;
        }

        try {
            const filename = filenameFromUrl(url);
            const { manifest, data } = installPackageFromBytes(filename, bytes, vfs);
            const finalManifest: PackageManifest = {
                ...manifest,
                sourceUrl: url,
                ...(version ? { sourceVersion: version } : {}),
            };
            // Make the extracted files durable BEFORE registering the package.
            // ZenFS keeps writes in memory until sync() (ProfileVFS.flush), so a
            // fire-and-forget flush is lost if the page is killed or wedges
            // first — leaving the package recorded in profile.json with nothing
            // on disk. Scripts then load fine (they live in the store) while the
            // package's data files are simply gone, which is how f2ce-tools'
            // bundled map databases went missing and its importer reported
            // "File not found". Registering only after the bytes have landed
            // means the failure mode is "not installed", which the next
            // Client.GUI delivery repairs, instead of a half-install that
            // dedupe treats as complete.
            await vfs.flush();
            useAppStore.getState().installPackage(this.connectionId, finalManifest, data);
            this.notifyPackageInstalled(finalManifest.name);
            const versionSuffix = finalManifest.version ? ` v${finalManifest.version}` : '';
            this.session.events.emit('message',
                mudletInfo(`installed ${finalManifest.name}${versionSuffix}`),
                'info', Date.now());
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.api.printError(`[Client.GUI] install failed: ${msg}`);
        }
    }

    /** Guards against overlapping downloads — Mudlet TMap::mImportRunning. */
    private mapDownloadRunning = false;

    /**
     * Mudlet TMap::downloadMap + slot_replyFinished: fetch the map the game
     * published (GMCP `Client.Map` MMP location, or an explicit URL), load it
     * into the map store, and raise `sysMapDownloadEvent` once it has parsed
     * successfully. Like Mudlet, `.xml` locations go through the XML map
     * importer and everything else through the binary `.dat` reader.
     */
    async downloadMap(remoteUrl?: string): Promise<boolean> {
        if (this.mapDownloadRunning) {
            this.session.events.emit('message',
                mudletWarn('a map download is already in progress — wait for it to complete before retrying'),
                'info', Date.now());
            return false;
        }
        const url = remoteUrl || this.session.windows.mmpMapLocation;
        if (!url) {
            this.api.printError('[downloadMap] no map URL known — the game has not sent a GMCP Client.Map location');
            return false;
        }
        let pathname = url;
        try { pathname = new URL(url).pathname; } catch { /* keep raw url for the extension check */ }
        const isXml = pathname.toLowerCase().endsWith('.xml');
        this.mapDownloadRunning = true;
        try {
            this.session.events.emit('message',
                mudletInfo('Map download initiated, please wait...'), 'info', Date.now());
            let bytes: Uint8Array;
            try {
                bytes = await downloadFromUrl(url, this.proxyUrlGetter());
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.api.printError(`[downloadMap] download failed: ${msg}`);
                return false;
            }
            this.session.events.emit('message',
                mudletInfo('... map downloaded and stored, now parsing it...'), 'info', Date.now());
            let ok: boolean;
            if (isXml) {
                ok = this.session.windows.loadMapXml(new TextDecoder().decode(bytes));
            } else {
                // Copy into a standalone ArrayBuffer — the download may be a view
                // into a larger buffer, and the load transfers what it's given.
                // The streamed load keeps the UI responsive (and drives the map
                // panel's progress bar) while a freshly-downloaded map parses.
                const buf = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(buf).set(bytes);
                ok = await this.session.windows.loadMapAsync(buf);
            }
            if (!ok) {
                this.api.printError(`[downloadMap] failure in parsing downloaded map from ${url}`);
                return false;
            }
            this.raiseEvent('sysMapDownloadEvent');
            return true;
        } finally {
            this.mapDownloadRunning = false;
        }
    }

    /**
     * Uninstall a previously installed package by name. Raises sysUninstallPackage
     * before the store removal so the package's own handlers can still run.
     * Removes the on-disk package directory in the background.
     */
    uninstallPackageByName(packageName: string): boolean {
        const installed = useAppStore.getState().connectionPackages[this.connectionId] ?? [];
        const manifest = installed.find(p => p.name === packageName);
        if (!manifest) {
            // Mudlet silently no-ops when the package isn't installed.
            return false;
        }
        // Brand-bundled packages marked removable:false can't be uninstalled
        // (and would reinstall on next open anyway).
        if (!isPackageRemovable(packageName)) return false;
        this.notifyPackageUninstalled(packageName);
        useAppStore.getState().uninstallPackage(this.connectionId, packageName);
        if (this.vfs) {
            const vfs = this.vfs;
            void uninstallPackageFiles(manifest, vfs).catch(err => {
                console.warn('[ScriptingEngine] failed to remove package files:', err);
            });
        }
        return true;
    }

    /**
     * Toggle a script's enabled flag by name (Mudlet enableScript/disableScript).
     * The store subscription picks up the change synchronously and either loads
     * or unloads handlers in the runtime.
     */
    toggleScriptByName(name: string, enabled: boolean): boolean {
        const store = useAppStore.getState();
        const scripts = store.connectionScripts[this.connectionId] ?? [];
        const target = scripts.find(s => s.name === name);
        if (!target) return false;
        if (target.enabled === enabled) return true;
        store.updateScript(this.connectionId, target.id, { enabled });
        return true;
    }

    /**
     * Toggle triggers' enabled flag by name (Mudlet enableTrigger/disableTrigger).
     * Mudlet matches every trigger or group sharing the name, so we do the same:
     * toggling a group cascades to children via isEffectivelyEnabled. All
     * matching ids are flipped in one `set()` so the store subscription (and
     * the trigger recompile it triggers) fires exactly once.
     */
    toggleTriggerByName(name: string, enabled: boolean): boolean {
        const store = useAppStore.getState();
        const triggers = store.connectionTriggers[this.connectionId] ?? [];
        const targets = triggers.filter(t => t.name === name);
        if (targets.length === 0) return false;
        const patches = targets
            .filter(t => t.enabled !== enabled)
            .map(t => ({ id: t.id, patch: { enabled } }));
        if (patches.length > 0) store.updateTriggers(this.connectionId, patches);
        return true;
    }

    /**
     * Mudlet `setTriggerStayOpen(name, lines)`. Keeps every trigger matching the
     * name open for `lines` more lines of input (Mudlet matches by name, which
     * need not be unique). This affects only the *current* run: it adjusts the
     * engine's transient chain window, leaving the persisted trigger (and its
     * `fireLength`) untouched. Negative line counts clamp to 0, matching Mudlet.
     */
    setTriggerStayOpenByName(name: string, lines: number): boolean {
        const store = useAppStore.getState();
        const triggers = store.connectionTriggers[this.connectionId] ?? [];
        const targets = triggers.filter(t => t.name === name);
        if (targets.length === 0) return false;
        this.triggerEngine.setStayOpen(targets.map(t => t.id), lines);
        return true;
    }

    /**
     * Toggle timers' enabled flag by name (Mudlet enableTimer/disableTimer).
     * Same batching as toggleTriggerByName: one set() collapses N matches into
     * a single subscription tick (and a single TimerEngine.loadPerm rebuild).
     */
    toggleTimerByName(name: string, enabled: boolean): boolean {
        const store = useAppStore.getState();
        const timers = store.connectionTimers[this.connectionId] ?? [];
        const targets = timers.filter(t => t.name === name);
        if (targets.length === 0) return false;
        const patches = targets
            .filter(t => t.enabled !== enabled)
            .map(t => ({ id: t.id, patch: { enabled } }));
        if (patches.length > 0) store.updateTimers(this.connectionId, patches);
        return true;
    }

    /**
     * Toggle aliases' enabled flag by name (Mudlet enableAlias/disableAlias).
     * Mirrors trigger/timer batching: flipping a group cascades to children via
     * isEffectivelyEnabled at compile time, so one set() rebuilds AliasEngine once.
     */
    toggleAliasByName(name: string, enabled: boolean): boolean {
        const store = useAppStore.getState();
        const aliases = store.connectionAliases[this.connectionId] ?? [];
        const targets = aliases.filter(a => a.name === name);
        if (targets.length === 0) return false;
        const patches = targets
            .filter(a => a.enabled !== enabled)
            .map(a => ({ id: a.id, patch: { enabled } }));
        if (patches.length > 0) store.updateAliases(this.connectionId, patches);
        return true;
    }

    /**
     * Toggle keybindings' enabled flag by name (Mudlet enableKey/disableKey).
     * Mudlet matches every key (or group) sharing the name. The store has no
     * batch keybinding update, so matches are flipped one at a time; the store
     * subscription coalesces the resulting KeyEngine reloads within the tick.
     */
    toggleKeyByName(name: string, enabled: boolean): boolean {
        const store = useAppStore.getState();
        const keys = store.connectionKeybindings[this.connectionId] ?? [];
        const targets = keys.filter(k => k.name === name);
        if (targets.length === 0) return false;
        for (const k of targets) {
            if (k.enabled !== enabled) store.updateKeybinding(this.connectionId, k.id, { enabled });
        }
        return true;
    }

    /**
     * Mudlet `exists(nameOrId, type)`. With a name string, returns the count of
     * items matching the name in the named collection. With a numeric id, looks
     * up the perm item by its monotonic id (the one permScript/permRegexTrigger
     * etc. return) and reports 1 if it lives in the matching collection, else 0.
     * Type aliases follow Mudlet: "key" and "keybind" both target keybindings.
     * Unknown types return 0.
     */
    /** The saved keybinding carrying this numeric id, or null. Lets getKeyCode
     *  answer for a permanent key by the id permKey handed back, not just by
     *  name — the key engine only indexes permanent keys by name. */
    keyNodeByNumericId(numericId: number): { key: string; modifiers: string[] } | null {
        const list = useAppStore.getState().connectionKeybindings[this.connectionId] ?? [];
        for (const node of list) {
            if (this.uuidToNumericId.get(node.id) === numericId && node.key) {
                return { key: node.key, modifiers: node.modifiers ?? [] };
            }
        }
        return null;
    }

    /** enable/disable a script-created temp trigger or alias by numeric id.
     *  Those live in the Lua runtime, not the saved tree. */
    setTempItemEnabled(id: number, enabled: boolean): boolean {
        return this.runtimes.lua?.setTempItemEnabled(id, enabled) ?? false;
    }

    setForceMxpProcessorOn(on: boolean): void {
        this.forceMxpProcessorOn = on;
        // Mudlet locks secure mode alongside the flag — see lockSecureMode.
        this.mxp.lockSecureMode(on);
    }

    existsByName(nameOrId: string | number, type: string): number {
        const store = useAppStore.getState();
        const id = this.connectionId;
        const list = ((): { id: string; name: string }[] => {
            switch (type) {
                case 'alias':   return store.connectionAliases[id]      ?? [];
                case 'trigger': return store.connectionTriggers[id]     ?? [];
                case 'timer':   return store.connectionTimers[id]       ?? [];
                case 'key':
                case 'keybind': return store.connectionKeybindings[id]  ?? [];
                case 'button':  return store.connectionButtons[id]      ?? [];
                case 'script':  return store.connectionScripts[id]      ?? [];
                default:        return [];
            }
        })();
        if (typeof nameOrId === 'number' && Number.isFinite(nameOrId)) {
            const wanted = nameOrId;
            for (const item of list) {
                const n = this.uuidToNumericId.get(item.id);
                if (n !== undefined && n === wanted) return 1;
            }
            // Temp (script-created) items aren't in the store. Aliases and
            // triggers are tracked by the runtime; temp KEYS live in the key
            // engine, which owns their ids. Mudlet's exists() counts both.
            if (this.runtimes.lua?.tempItemExists(wanted, type)) return 1;
            if ((type === 'key' || type === 'keybind') && this.api.keys.hasTemp(wanted)) return 1;
            return 0;
        }
        const name = String(nameOrId);
        return list.filter(i => i.name === name).length;
    }

    /**
     * Mudlet `isActive(nameOrId, type [, checkAncestors])`. Returns the count of
     * *active* items matching the name (1 or 0 for a numeric id). An item is
     * active when its own enabled flag is set; with `checkAncestors` every
     * ancestor group must be enabled too (isEffectivelyEnabled). Type aliases
     * and the collection lookup mirror `existsByName`. Unknown types return 0.
     */
    isActiveByName(nameOrId: string | number, type: string, checkAncestors: boolean): number {
        const store = useAppStore.getState();
        const id = this.connectionId;
        const list = ((): { id: string; name: string; enabled: boolean; parentId: string | null }[] => {
            switch (type) {
                case 'alias':   return store.connectionAliases[id]      ?? [];
                case 'trigger': return store.connectionTriggers[id]     ?? [];
                case 'timer':   return store.connectionTimers[id]       ?? [];
                case 'key':
                case 'keybind': return store.connectionKeybindings[id]  ?? [];
                case 'button':  return store.connectionButtons[id]      ?? [];
                case 'script':  return store.connectionScripts[id]      ?? [];
                default:        return [];
            }
        })();
        const isOn = (item: { enabled: boolean; parentId: string | null; id: string }): boolean =>
            checkAncestors ? isEffectivelyEnabled(item, list) : item.enabled;
        if (typeof nameOrId === 'number' && Number.isFinite(nameOrId)) {
            for (const item of list) {
                const n = this.uuidToNumericId.get(item.id);
                if (n !== undefined && n === nameOrId) return isOn(item) ? 1 : 0;
            }
            // Temp keys are held by the key engine, not the store (see existsByName).
            if ((type === 'key' || type === 'keybind') && this.api.keys.hasTemp(nameOrId)) {
                return this.api.keys.isTempEnabled(nameOrId) ? 1 : 0;
            }
            // Temp aliases/triggers are held by the runtime, likewise.
            if (this.runtimes.lua?.tempItemExists(nameOrId, type)) {
                return this.runtimes.lua.tempItemEnabled(nameOrId) ? 1 : 0;
            }
            return 0;
        }
        const name = String(nameOrId);
        return list.filter(i => i.name === name && isOn(i)).length;
    }

    /**
     * Shared type→node-list lookup for the tree-walking APIs (ancestors,
     * findItems, isAncestorsActive). Type aliases mirror Mudlet: "key" and
     * "keybind" both target keybindings. Unknown types return an empty list.
     */
    private nodeListForType(type: string): BaseTreeNode[] {
        const store = useAppStore.getState();
        const id = this.connectionId;
        switch (type.toLowerCase()) {
            case 'alias':   return store.connectionAliases[id]      ?? [];
            case 'trigger': return store.connectionTriggers[id]     ?? [];
            case 'timer':   return store.connectionTimers[id]       ?? [];
            case 'key':
            case 'keybind': return store.connectionKeybindings[id]  ?? [];
            case 'button':  return store.connectionButtons[id]      ?? [];
            case 'script':  return store.connectionScripts[id]      ?? [];
            default:        return [];
        }
    }

    private nodeTypeLabel(node: BaseTreeNode): 'package' | 'group' | 'item' {
        if (!node.isGroup) return 'item';
        return node.packageName && node.packageName === node.name ? 'package' : 'group';
    }

    /**
     * Mudlet `ancestors(id, type)`. Walks from the item's immediate parent up to
     * the root, returning each ancestor as `{id, name, node, isActive}` where
     * `node` is "package"/"group"/"item" and `isActive` is that ancestor's own
     * enabled flag. Returns null when no item of `type` carries the numeric `id`
     * (the Lua wrapper turns that into a `(false, errMsg)` miss).
     */
    ancestorsById(id: number, type: string): Array<{ id: number; name: string; node: string; isActive: boolean }> | null {
        const list = this.nodeListForType(type);
        const byUuid = new Map(list.map(i => [i.id, i]));
        const start = list.find(i => this.uuidToNumericId.get(i.id) === id);
        if (!start) return null;
        const out: Array<{ id: number; name: string; node: string; isActive: boolean }> = [];
        let node = start.parentId ? byUuid.get(start.parentId) : undefined;
        while (node) {
            out.push({
                id: this.numericIdFor(node.id),
                name: node.name,
                node: this.nodeTypeLabel(node),
                isActive: node.enabled,
            });
            node = node.parentId ? byUuid.get(node.parentId) : undefined;
        }
        return out;
    }

    /**
     * Mudlet `findItems(name, type [, exact [, caseSensitive]])`. Returns the
     * numeric ids of every item (and group) whose name matches. `exact` (default
     * true) toggles exact vs substring; `caseSensitive` (default true) toggles
     * case folding. Empty array when nothing matches or the type is unknown.
     */
    findItemsByName(name: string, type: string, exact: boolean, caseSensitive: boolean): number[] {
        const list = this.nodeListForType(type);
        const needle = caseSensitive ? name : name.toLowerCase();
        const out: number[] = [];
        for (const item of list) {
            const hay = caseSensitive ? item.name : item.name.toLowerCase();
            const hit = exact ? hay === needle : hay.includes(needle);
            if (hit) out.push(this.numericIdFor(item.id));
        }
        return out;
    }

    /**
     * Mudlet `isAncestorsActive(id, type)`. True when every ancestor group of
     * the item is enabled (the item's own state is ignored); true when the item
     * sits at root with no ancestors. Returns null when no item of `type`
     * carries the numeric `id`.
     */
    isAncestorsActiveById(id: number, type: string): boolean | null {
        const list = this.nodeListForType(type);
        const byUuid = new Map(list.map(i => [i.id, i]));
        const start = list.find(i => this.uuidToNumericId.get(i.id) === id);
        if (!start) return null;
        let node = start.parentId ? byUuid.get(start.parentId) : undefined;
        while (node) {
            if (!node.enabled) return false;
            node = node.parentId ? byUuid.get(node.parentId) : undefined;
        }
        return true;
    }

    /**
     * Mudlet `getProfileStats()`. Counts of total/active items per family plus
     * the trigger pattern tally. Temporary items (tempTimer/tempAlias/... ) are
     * not kept in the persisted node tree but live in the per-family engines, so
     * their counts come from those engines: `temp` is the live temp count and
     * is folded into `total`/`active` (a live temp is always active), matching
     * Mudlet's report. Scripts have no temp form. There's no animated-GIF
     * tracker, so `gifs` is always zero.
     */
    getProfileStats(): Record<string, unknown> {
        const store = useAppStore.getState();
        const cid = this.connectionId;
        const triggers = store.connectionTriggers[cid] ?? [];
        const aliases = store.connectionAliases[cid] ?? [];
        const timers = store.connectionTimers[cid] ?? [];
        const keys = store.connectionKeybindings[cid] ?? [];
        const scripts = store.connectionScripts[cid] ?? [];

        const tally = (list: BaseTreeNode[], tempCount: number) => {
            const items = list.filter(i => !i.isGroup);
            return {
                total: items.length + tempCount,
                temp: tempCount,
                active: items.filter(i => i.enabled).length + tempCount,
            };
        };

        const tempTriggers = this.triggerEngine.tempCount;
        let patternsTotal = tempTriggers;
        let patternsActive = tempTriggers;
        for (const t of triggers) {
            if (t.isGroup) continue;
            const n = Array.isArray(t.patterns) ? t.patterns.length : 0;
            patternsTotal += n;
            if (t.enabled) patternsActive += n;
        }

        return {
            triggers: { ...tally(triggers, tempTriggers), patterns: { total: patternsTotal, active: patternsActive } },
            aliases: tally(aliases, this.aliasEngine.tempCount),
            timers: tally(timers, this.timerEngine.tempCount),
            keys: tally(keys, this.keyEngine.tempCount),
            scripts: tally(scripts, 0),
            gifs: { total: 0, active: 0 },
        };
    }

    /**
     * Mudlet `permScript(name, parent, luaCode)`. Creates a saved Lua script
     * named `name` under the script group `parent` (empty = root). Returns the
     * new script's id on success, -1 if `parent` is given but no script group
     * with that name exists. The store subscription loads the script's
     * handlers synchronously inside the addScript commit.
     */
    createPermScript(name: string, parent: string, code: string): number {
        if (!name) return -1;
        const store = useAppStore.getState();
        const scripts = store.connectionScripts[this.connectionId] ?? [];
        let parentId: string | null = null;
        if (parent && parent.length > 0) {
            const group = scripts.find(s => s.isGroup && s.name === parent);
            if (!group) return -1;
            parentId = group.id;
        }
        const uuid = store.addScript(this.connectionId, {
            name,
            enabled: true,
            isGroup: false,
            parentId,
            code,
            language: 'lua',
            eventHandlers: [],
        });
        return this.numericIdFor(uuid);
    }

    /**
     * Mudlet `permRegexTrigger(name, parent, regexes, luaCode)`. Creates a saved
     * trigger named `name` under the trigger group `parent` (empty = root) with
     * one or more regex patterns; matches fire OR-style. An empty `regexes` table
     * creates a trigger group instead — matches the convention `permGroup` uses
     * to bootstrap folders. Returns the new trigger's id, or -1 if `parent` is
     * given but no trigger group with that name exists.
     */
    createPermRegexTrigger(name: string, parent: string, regexes: string[], code: string): number {
        return this.createPermTrigger(name, parent, regexes, 'regex', code);
    }

    /**
     * Mudlet `permSubstringTrigger(name, parent, patterns, luaCode)`. Same
     * shape as createPermRegexTrigger but each pattern matches by substring
     * (the temp-trigger semantics: literal `String.prototype.includes`).
     */
    createPermSubstringTrigger(name: string, parent: string, patterns: string[], code: string): number {
        return this.createPermTrigger(name, parent, patterns, 'substring', code);
    }

    /**
     * Mudlet `permBeginOfLineStringTrigger(name, parent, patterns, luaCode)`.
     * Same shape as createPermSubstringTrigger but each pattern only matches at
     * the start of the line (`String.prototype.startsWith`).
     */
    createPermBeginOfLineStringTrigger(name: string, parent: string, patterns: string[], code: string): number {
        return this.createPermTrigger(name, parent, patterns, 'startOfLine', code);
    }

    /**
     * Mudlet `permExactMatchTrigger(name, parent, patterns, luaCode)`. Same
     * shape as createPermSubstringTrigger but each pattern matches only on
     * full-line equality (the temp-trigger `exactMatch` semantics).
     */
    createPermExactMatchTrigger(name: string, parent: string, patterns: string[], code: string): number {
        return this.createPermTrigger(name, parent, patterns, 'exactMatch', code);
    }

    /**
     * Mudlet `permPromptTrigger(name, parent, luaCode)`. Creates a persistent
     * trigger that fires on every server prompt line (GA/EOR). It carries a
     * single pattern of type 'prompt' with empty text — not a group.
     */
    createPermPromptTrigger(name: string, parent: string, code: string): number {
        return this.createPermTrigger(name, parent, [''], 'prompt', code);
    }

    private createPermTrigger(
        name: string,
        parent: string,
        patternStrings: string[],
        kind: 'regex' | 'substring' | 'startOfLine' | 'exactMatch' | 'prompt',
        code: string,
    ): number {
        if (!name) return -1;
        const store = useAppStore.getState();
        const triggers = store.connectionTriggers[this.connectionId] ?? [];
        let parentId: string | null = null;
        if (parent && parent.length > 0) {
            const group = triggers.find(t => t.isGroup && t.name === parent);
            if (!group) return -1;
            parentId = group.id;
        }
        // A prompt trigger has no text pattern but is never a group; every other
        // kind treats an empty pattern list as a request to create a group.
        const isGroup = kind !== 'prompt' && patternStrings.length === 0;
        const patterns: TriggerNode['patterns'] = isGroup
            ? []
            : patternStrings.map(text => ({ type: kind, text }));
        const uuid = store.addTrigger(this.connectionId, {
            name,
            enabled: true,
            isGroup,
            parentId,
            patterns,
            code,
            language: 'lua',
            fireLength: 0,
            multipleMatches: false,
            multiline: false,
            delta: 0,
            isFilter: false,
        });
        return this.numericIdFor(uuid);
    }

    /**
     * Mudlet `permAlias(name, parent, regex, luaCode)`. Creates a saved alias
     * named `name` under the alias group `parent` (empty = root). The pattern
     * is treated as a PCRE regex (matches Mudlet's TAlias.mRegexCode).
     * Returns the new alias id, or -1 if `parent` is non-empty but no alias
     * group of that name exists.
     */
    createPermAlias(name: string, parent: string, pattern: string, code: string): number {
        if (!name) return -1;
        const store = useAppStore.getState();
        const aliases = store.connectionAliases[this.connectionId] ?? [];
        let parentId: string | null = null;
        if (parent && parent.length > 0) {
            const group = aliases.find(a => a.isGroup && a.name === parent);
            if (!group) return -1;
            parentId = group.id;
        }
        const uuid = store.addAlias(this.connectionId, {
            name,
            enabled: true,
            isGroup: false,
            parentId,
            pattern,
            command: '',
            code,
            language: 'lua',
        });
        return this.numericIdFor(uuid);
    }

    /**
     * Mudlet `permTimer(name, parent, seconds, luaCode)`. Creates a saved
     * one-shot timer under the timer group `parent` (empty = root). Returns
     * the new timer id, or -1 if `parent` is non-empty but no timer group of
     * that name exists.
     */
    createPermTimer(name: string, parent: string, delay: number, code: string): number {
        if (!name) return -1;
        const store = useAppStore.getState();
        const timers = store.connectionTimers[this.connectionId] ?? [];
        let parentId: string | null = null;
        if (parent && parent.length > 0) {
            const group = timers.find(t => t.isGroup && t.name === parent);
            if (!group) return -1;
            parentId = group.id;
        }
        const seconds = Number.isFinite(delay) && delay > 0 ? delay : 0;
        const uuid = store.addTimer(this.connectionId, {
            name,
            enabled: true,
            isGroup: false,
            parentId,
            seconds,
            code,
            language: 'lua',
            repeat: false,
        });
        return this.numericIdFor(uuid);
    }

    /**
     * Mudlet `permKey(name, parent, modifier, key, code)`. Creates a saved
     * keybinding under the key group `parent` (empty = root). `modifier` uses
     * the Qt::KeyboardModifier int (1=shift, 2=ctrl, 4=alt, 8=meta); -1 means
     * "no modifier" — used by `permGroup(name,"key")` to make a key folder.
     * Returns the new id or -1 when `parent` is non-empty but no key group of
     * that name exists.
     */
    createPermKey(name: string, parent: string, modifier: number, key: string | number, code: string): number {
        if (!name) return -1;
        const store = useAppStore.getState();
        const keys = store.connectionKeybindings[this.connectionId] ?? [];
        let parentId: string | null = null;
        if (parent && parent.length > 0) {
            const group = keys.find(k => k.isGroup && k.name === parent);
            if (!group) return -1;
            parentId = group.id;
        }
        // Mudlet's permKey overload that creates a group passes modifier=-1
        // with an empty key. Mirror that here so `permGroup("name","key")` lands
        // on a real ButtonNode-style group.
        const isGroup = modifier < 0 && (!key || key === '');
        const uuid = store.addKeybinding(this.connectionId, {
            name,
            enabled: true,
            isGroup,
            parentId,
            key: isGroup ? '' : keyCodeFromMudletKey(key),
            modifiers: isGroup ? [] : modifiersFromMudletInt(modifier),
            code,
            language: 'lua',
        });
        return this.numericIdFor(uuid);
    }

    /**
     * Mudlet `tempButton(toolbar, name, code[, orientation])`. Appends a
     * transient button under an existing toolbar group. Returns the new id, or
     * -1 when no toolbar of that name exists. `orientation` is round-tripped
     * onto the leaf for parity with Mudlet — the renderer doesn't use it at the
     * leaf, but ports that read it back via the store get a stable value.
     */
    createTempButton(toolbar: string, name: string, code: string, _orientation: number): number {
        if (!toolbar || !name) return -1;
        const store = useAppStore.getState();
        const buttons = store.connectionButtons[this.connectionId] ?? [];
        const parent = buttons.find(b => b.isGroup && b.name === toolbar);
        if (!parent) return -1;
        const uuid = store.addButton(this.connectionId, {
            name,
            enabled: true,
            isGroup: false,
            parentId: parent.id,
            orientation: parent.orientation,
            location: parent.location,
            columns: 0,
            isPushDown: false,
            buttonState: false,
            code,
            language: 'lua',
        });
        return this.numericIdFor(uuid);
    }

    /**
     * Mudlet `tempButtonToolbar(name [, orientation [, location]])`. Creates a
     * transient toolbar (ButtonNode group). `orientation`: 0=horizontal,
     * 1=vertical. `location`: 0=top, 1=bottom, 2=left, 3=right, 4=floating.
     * Returns -1 when a toolbar group of that name already exists.
     */
    createTempButtonToolbar(name: string, orientation: number, location: number): number {
        if (!name) return -1;
        const store = useAppStore.getState();
        const buttons = store.connectionButtons[this.connectionId] ?? [];
        if (buttons.some(b => b.isGroup && b.name === name)) return -1;
        const uuid = store.addButton(this.connectionId, {
            name,
            enabled: true,
            isGroup: true,
            parentId: null,
            orientation: orientation === 1 ? 'vertical' : 'horizontal',
            location: BUTTON_LOCATIONS[location] ?? 'top',
            columns: 0,
            isPushDown: false,
            buttonState: false,
            code: '',
            language: 'lua',
        });
        return this.numericIdFor(uuid);
    }

    /** Mudlet `setButtonState(name, state)`. Flips the buttonState on the named
     *  two-state button. */
    setButtonStateByName(name: string, state: boolean): boolean {
        if (!name) return false;
        const store = useAppStore.getState();
        const buttons = store.connectionButtons[this.connectionId] ?? [];
        const target = buttons.find(b => !b.isGroup && b.name === name);
        if (!target) return false;
        store.updateButton(this.connectionId, target.id, { buttonState: !!state });
        return true;
    }

    /** Mudlet `getButtonState(name)`. Reads the pressed state on a two-state
     *  button by name. Returns null when no such button (the Lua binding maps
     *  that to nil — Mudlet returns false/error). */
    getButtonStateByName(name: string): boolean | null {
        if (!name) return null;
        const store = useAppStore.getState();
        const buttons = store.connectionButtons[this.connectionId] ?? [];
        const target = buttons.find(b => !b.isGroup && b.name === name);
        if (!target) return null;
        return !!target.buttonState;
    }

    /** Mudlet `setButtonStyleSheet(name, css)`. Stores raw CSS on the
     *  ButtonNode; ButtonsBar applies it inline. */
    setButtonStyleSheetByName(name: string, css: string): boolean {
        if (!name) return false;
        const store = useAppStore.getState();
        const buttons = store.connectionButtons[this.connectionId] ?? [];
        const target = buttons.find(b => !b.isGroup && b.name === name);
        if (!target) return false;
        store.updateButton(this.connectionId, target.id, { styleSheet: String(css ?? '') });
        return true;
    }

    /** Mudlet `showToolBar(name)` / `hideToolBar(name)`. Toggles the toolbar
     *  group's enabled flag (the ButtonsBar already filters by
     *  isEffectivelyEnabled, so this is the show/hide hook). */
    toggleToolBarByName(name: string, show: boolean): boolean {
        if (!name) return false;
        const store = useAppStore.getState();
        const buttons = store.connectionButtons[this.connectionId] ?? [];
        const target = buttons.find(b => b.isGroup && b.name === name);
        if (!target) return false;
        store.updateButton(this.connectionId, target.id, { enabled: !!show });
        return true;
    }

    /**
     * Mudlet `setScript(name, luaCode[, pos])`. Replaces the source of the
     * `pos`-th script (1-indexed; default 1) named `name`. Updating via the
     * store re-runs the script load through the regular subscription pipeline,
     * so handlers re-register cleanly. Returns true on success, -1 if no such
     * script exists.
     */
    setScriptByName(name: string, code: string, pos: number): number {
        if (!name) return -1;
        const store = useAppStore.getState();
        const scripts = store.connectionScripts[this.connectionId] ?? [];
        const matches = scripts.filter(s => s.name === name);
        const index = Math.max(1, Math.floor(pos)) - 1;
        const target = matches[index];
        if (!target) return -1;
        store.updateScript(this.connectionId, target.id, { code });
        return this.numericIdFor(target.id);
    }

    /**
     * Mudlet `getScript(name [, pos]) → code, count`. Returns the source of the
     * pos-th (1-indexed; default 1) script named `name` and how many scripts
     * share that name. Returns null when none match — the Bridge.lua wrapper
     * turns that into ("", 0).
     */
    getScriptByName(name: string, pos: number): { code: string; count: number } | null {
        if (!name) return null;
        const store = useAppStore.getState();
        const scripts = store.connectionScripts[this.connectionId] ?? [];
        const matches = scripts.filter(s => s.name === name);
        if (matches.length === 0) return null;
        const index = Math.max(1, Math.floor(pos)) - 1;
        const target = matches[index];
        if (!target) return null;
        return { code: target.code ?? '', count: matches.length };
    }

    /**
     * Mudlet `killTimer/killAlias/killTrigger/killKey(name)` deletes every
     * permanent item sharing the given name. Returns true if at least one was
     * removed. Mirrors `toggleTriggerByName`'s "all matches" semantics so
     * groups and their sibling-named items vanish together. The store
     * subscription tears down the runtime side (timers stop firing, triggers
     * recompile) on the next tick.
     */
    killByName(kind: 'timer' | 'alias' | 'trigger' | 'key', name: string): boolean {
        if (!name) return false;
        const store = useAppStore.getState();
        const id = this.connectionId;
        switch (kind) {
            case 'timer':
            case 'alias':
            case 'trigger':
                // Mudlet's kill* only removes TEMPORARY items — TimerUnit::killTimer,
                // AliasUnit::killAlias and TriggerUnit::killTrigger each bail out on
                // a non-temporary match, commented there as "permanent objects cannot
                // be removed". Temp items never reach here: the bindings resolve those
                // by the numeric id they handed the script, before falling back to
                // this name lookup.
                return false;
            case 'key':
                // Mudlet's KeyUnit::killKey refuses a permanent key outright —
                // killKey only removes temporary ones, and named keys created
                // with permKey are permanent. (killTimer/killAlias/killTrigger
                // above do delete their permanent items, matching Mudlet.)
                return false;
        }
    }

    /**
     * Run a single script on the existing runtime without restarting it.
     *
     * Runs synchronously when the runtime is already up. That sync path is
     * load-bearing: notifyPackageInstalled raises sysInstallPackage right
     * after applyScriptsFromStore returns, and the package's own event
     * handlers (and the function `_G[scriptName]` they dispatch to) must be
     * defined by then. An `await` here — even on an already-resolved promise
     * — would defer the load to a microtask and the event would fire against
     * an empty handler set.
     */
    reloadScript(script: ScriptNode): void {
        // destroy() closes the Lua VM synchronously, so anything that reaches
        // here afterwards would load into a freed lua_State. The deferred branch
        // below is the dangerous one: it survives teardown by construction, so it
        // re-checks after the await as well as before.
        if (this.disposed) return;
        if (script.language !== 'lua' || !script.code) return;
        const rt = this.runtimes.lua;
        if (rt) { this.runScriptLoad(rt, script); return; }
        this.runtimeReady
            .then(rt => { if (!this.disposed) this.runScriptLoad(rt, script); })
            .catch(() => {});
    }

    /**
     * Force-run a profile script's body right now, even if its code is unchanged.
     * Backs the editor's "Run" / "Save & Run" button: the store subscription only
     * re-runs a script when its code or handlers actually change (so editing one
     * script doesn't re-execute its untouched siblings), which means clicking
     * "Run" twice — or running a script you didn't edit — would otherwise do
     * nothing. wrapScript kills the script's previously registered anonymous
     * handlers before re-registering, so repeated runs stay idempotent.
     */
    runScript(scriptId: string): void {
        const node = (useAppStore.getState().connectionScripts[this.connectionId] ?? [])
            .find(s => s.id === scriptId);
        if (node) this.reloadScript(node);
    }

    private runScriptLoad(rt: IScriptingRuntime, script: ScriptNode): void {
        try {
            rt.load(this.wrapScript(script), script.name);
        } catch (err) {
            this.reportEntityError('script', script.id, script.name, err);
        }
        this.api.flushOutput();
    }

    get currentVFS(): ProfileVFS | null { return this.vfs; }

    /**
     * Send a command from the command bar. Raises sysDataSendRequest, then either
     * sends (and echoes locally) or aborts when a handler calls denyCurrentSend().
     */
    sendCommand(text: string): void {
        this.api.send(text, true);
    }

    /** Run input through aliases. Returns true if an alias matched (caller should not send). */
    processInput(text: string): boolean {
        // setCmdLineAction takes the whole Enter event; aliases and the MUD
        // send are bypassed when an action is installed (matches Mudlet — the
        // script owns the command bar end-to-end). Errors in the action are
        // routed through printError and still consume the input so the bare
        // text isn't silently sent.
        const action = this.api.getCmdLineAction();
        if (action) {
            try { action(text); }
            catch (e) { this.api.printError(`[setCmdLineAction] ${e instanceof Error ? e.message : String(e)}`); }
            this.api.flushOutput();
            return true;
        }
        // Mirror the input into the Lua `command` global before alias matching,
        // matching Mudlet's AliasUnit::processDataStream. Persists between inputs
        // so the stock "Repeat Last Command" key (`send(command)`) works.
        this.runtimes.lua?.setCommand(text);
        // JS temp aliases
        if (this.aliasEngine.processTemp(text)) {
            this.api.flushOutput();
            return true;
        }
        // Permanent aliases
        const permMatch = this.aliasEngine.matchPerm(text);
        if (permMatch) {
            // matches[1] is the matched portion (Mudlet semantics), not the
            // whole input — see the perm-trigger note above (issue #4).
            this.executePermAlias(permMatch.alias, [permMatch.matchedText, ...permMatch.captures]);
            this.api.flushOutput();
            return true;
        }
        this.api.flushOutput();
        return false;
    }

    /** Process a keyboard event. Returns true if a keybinding consumed it. */
    processKey(event: KeyboardEvent): boolean {
        // JS temp keybindings
        if (this.keyEngine.processTemp(event)) {
            this.api.flushOutput();
            return true;
        }
        // Permanent keybindings
        const permMatch = this.keyEngine.matchPerm(event);
        if (permMatch) {
            this.executePermKeybinding(permMatch);
            this.api.flushOutput();
            return true;
        }
        this.api.flushOutput();
        return false;
    }

    raiseEvent(event: string, args: unknown[] = []): void {
        this.emit(event, args);
    }

    /** Raise sysExitEvent at most once, while the Lua runtime is still alive. */
    private fireExit(): void {
        if (this.exitFired) return;
        this.exitFired = true;
        this.raiseEvent('sysExitEvent');
    }

    notifyMapOpen(): void {
        this.mapOpen.notify();
    }

    /** Hand the API a getter for the current command-line text, used until the
     *  first {@link setCmdLineValue} mirrors one. Pass null to clear. */
    setCmdLineProvider(fn: (() => string) | null): void {
        this.api.setCmdLineProvider(fn);
    }

    /** Mirror a command-bar edit so Lua's getCmdLine() reads it without waiting
     *  for a re-render. Called by ProfileSession on every change. */
    setCmdLineValue(text: string): void {
        this.api.setCmdLineValue(text);
    }

    /** Hand the API a startLogging hook. Wired by ProfileSession, which owns
     *  the actual SessionLogger lifecycle. */
    setLoggingToggler(fn: ((enabled: boolean) => boolean) | null): void {
        this.api.setLoggingToggler(fn);
    }

    /** Mudlet's "Show errors in main console" — when on, script errors are also
     *  echoed (in red) into the main output window, not just the Errors tab. */
    setShowErrorsInMainWindow(enabled: boolean): void {
        this.api.showErrorsInMainWindow = enabled;
    }

    /** Mudlet `appendLog(text)` — forward to the active SessionLogger. */
    setLogAppender(fn: ((text: string) => void) | null): void {
        this.api.setLogAppender(fn);
    }

    /** Mudlet `closeMudlet()` — close the active profile (disconnect + return
     *  to the connection screen). */
    setCloseProfileCallback(fn: (() => void) | null): void {
        this.api.setCloseProfileCallback(fn);
    }

    /**
     * Mudlet `exportAreaImage(areaID, filePath[, zLevel])`. Renders the area to
     * PNG bytes via the mounted map widget's renderer, then writes them to the
     * profile VFS at `filePath` (relative paths resolve under the profile root,
     * the same convention as `io.open`/`downloadFile`). Returns the absolute
     * path written, or an error string (no VFS, mapper not open, or write
     * failure). Mudlet requires the mapper open; mudix's renderer lives in the
     * map widget, so the same precondition applies.
     */
    exportAreaImageToVfs(areaId: number, filePath: string, zLevel?: number): { path: string } | { error: string } {
        const vfs = this.vfs;
        if (!vfs) return { error: 'no profile filesystem mounted' };
        if (!filePath) return { error: 'filePath is required' };
        const bytes = this.session.windows.exportAreaImage(areaId, zLevel);
        if (!bytes) return { error: `area ${areaId} could not be rendered (is the mapper open?)` };
        const abs = filePath.startsWith('/') ? filePath : `${vfs.profilePath}/${filePath}`;
        const slash = abs.lastIndexOf('/');
        const parent = slash > 0 ? abs.slice(0, slash) : '';
        try {
            if (parent && !vfs.exists(parent)) vfs.mkdir(parent);
            vfs.writeBinaryFile(abs, bytes);
            void vfs.flush();
            return { path: abs };
        } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
        }
    }

    /**
     * Mudlet `resetProfile()` — reload the entire profile as if just reopened:
     * clear every UI surface, tear down and recreate the Lua runtime (fresh
     * globals + event handlers), and re-run all scripts/aliases/triggers/timers/
     * keys from the current profile state. The reinit is deferred to a fresh
     * task: we are invoked from inside a Lua→JS call, and closing the lua_State
     * mid-call would free the VM under the running call (WASM abort). This is
     * exactly why Mudlet warns against calling it from a script-item — defer it
     * (`tempTimer(0, resetProfile)` works) or run it from the command line. A
     * concurrent reset is coalesced.
     */
    resetProfile(): void {
        if (this.disposed) { this.refuseDuringTeardown('resetProfile()'); return; }
        // Already resetting is legitimate de-duplication, not a refusal.
        if (this.resetting) return;
        this.resetting = true;
        setTimeout(() => { void this.performReset(); }, 0);
    }

    private async performReset(): Promise<void> {
        if (this.disposed) { this.resetting = false; return; }
        try {
            // 1. Stop autonomous Lua callers, then tear down the runtime + the
            //    automation engines (NOT the VFS — unlike destroy(); we reopen
            //    against the same mount). The engines are reusable after
            //    destroy(): loadPerm/addTemp repopulate their cleared maps.
            this.timerEngine.destroy();
            this.runtimes.lua?.destroy();
            this.runtimes.lua = null;
            this.triggerEngine.destroy();
            this.aliasEngine.destroy();
            this.keyEngine.destroy();
            // 2. Clear every UI surface — "all UI elements will be cleared".
            this.session.windows.clearAll();
            this.session.labels.clearAll();
            this.session.cmdLines.clearAll();
            this.session.scrollBoxes.clearAll();
            this.session.sounds.stopAll();
            this.session.videos.stopAll();
            // 3. Recreate the Lua runtime against the same mounted VFS. This
            //    re-wires every api.* callback, reloads the bundled Lua, and
            //    gives a clean global table + empty event-handler registry.
            await this.createRuntime(this.vfs);
            // 4. Re-run all automation from the current store state and re-fire
            //    the load event. Resetting prevScripts forces a full reload
            //    (every enabled script is treated as new).
            this.prevScripts = [];
            this.triggersReady = true; // PCRE wasm resolved long before any reset
            this.restoreSavedVariables();
            this.applyScriptsFromStore();
            this.applyAliasesFromStore();
            this.applyTriggersFromStore();
            this.applyTimersFromStore();
            this.applyKeybindingsFromStore();
            this.raiseEvent('sysLoadEvent');
            this.api.flushOutput();
        } catch (err) {
            console.warn('[ScriptingEngine] resetProfile failed:', err);
            this.api.printError(`[resetProfile] ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.resetting = false;
        }
    }

    /**
     * Resolves once the initial load pass has finished (scripts/aliases/timers/
     * keys applied, triggers compiled, sysLoadEvent fired). The auto-connect
     * path awaits this so the MUD socket isn't dialed until every handler and
     * trigger is in place. Always resolves — never rejects — so a failed or
     * torn-down load can't leave a profile waiting to connect forever.
     */
    whenScriptsLoaded(): Promise<void> {
        return this.scriptsLoaded;
    }

    /**
     * Single entry point for dialing the MUD socket. Before the initial load
     * finishes, the request is deferred (held in pendingConnectUrl) so the
     * connection isn't made until every script handler and trigger is in place
     * — this covers both the auto-connect on profile open and any script that
     * calls connect()/connectToServer() from its body or a sysLoadEvent handler.
     * Once loading is done, requests dial immediately (the normal reconnect
     * path). The latest pending request wins, so exactly one socket opens.
     */
    /**
     * Report a script-initiated call that teardown refused.
     *
     * Mudlet and mudix reach the same end state by opposite routes, and it is
     * worth being precise about which:
     *
     *   Mudlet guards the ARRIVAL side. `TMainConsole::closeEvent` raises
     *   sysExitEvent while `Host::mIsClosingDown` is still false, so a
     *   handler's connectToServer/reconnect is accepted and may even open a
     *   socket. `Host::closeChildren()` sets the flag afterwards, and every
     *   inbound callback is gated on it — cTelnet::slot_socketConnected,
     *   slot_socketDisconnected, slot_socketReadyToBeRead, postData,
     *   postMessage all early-return. The connection is accepted, then
     *   discarded.
     *
     *   mudix guards the INITIATION side, because its teardown is synchronous:
     *   destroy() runs start to finish with no yield point, and MudSession
     *   disposes the client immediately after, so a socket opened here would
     *   be torn down microseconds later regardless. Refusing up front is the
     *   same outcome without the pointless socket.
     *
     * The observable difference is only what the script is told, and there
     * mudix is deliberately the more honest of the two: Mudlet returns success
     * for a connection that will never deliver a byte. Hence this log line —
     * the divergence is intentional, but it must not be silent.
     *
     * Routed to script.log rather than the output window: by this point the
     * console may already be unmounting, and the log buffer lives on MudSession
     * so the Errors tab can still show it.
     */
    private refuseDuringTeardown(call: string): void {
        const msg = `${call} ignored — the profile is shutting down. `
            + '(Mudlet accepts this during sysExitEvent but then discards the '
            + 'resulting connection; mudix refuses it up front.)';
        this.session.events.emit('script.log', msg, 'error');
        console.warn(`[mudix] ${msg}`);
    }

    requestConnect(url: string): void {
        if (this.disposed) { this.refuseDuringTeardown('connect()'); return; }
        if (this.scriptsLoadComplete) {
            this.session.connect(url);
        } else {
            this.pendingConnectUrl = url;
        }
    }

    /**
     * Mark the initial load complete: unblock whenScriptsLoaded() and dial any
     * connect request that arrived while loading. Idempotent. Called on every
     * load outcome — success, load failure, and teardown — so a connect never
     * waits forever.
     */
    private markScriptsLoaded(): void {
        if (this.scriptsLoadComplete) return;
        this.scriptsLoadComplete = true;
        this.resolveScriptsLoaded();
        const url = this.pendingConnectUrl;
        this.pendingConnectUrl = null;
        if (url !== null && !this.disposed) this.session.connect(url);
    }

    destroy(): void {
        // ── Phase 1: disarm ──────────────────────────────────────────────────
        // The bare minimum that must precede user code, and nothing else. Both
        // of these stop a sysExitEvent handler from resurrecting the profile
        // we are closing: `disposed` makes connect()/resetProfile() inert, and
        // dropping a deferred dial stops markScriptsLoaded() from opening a
        // socket on the way down. Deliberately NOT teardown — every other
        // subsystem is still fully live for phase 2.
        this.disposed = true;
        this.pendingConnectUrl = null;
        window.removeEventListener('beforeunload', this.beforeUnload);

        // ── Phase 2: user code, against an intact engine ─────────────────────
        // sysExitEvent dispatches into Lua synchronously, so handlers run to
        // completion here — with the store, the VFS, the SQL bridge, the Lua
        // VM and the socket all still working. This is the only re-entrancy
        // point in destroy(); nothing below may move above it.
        this.fireExit();

        // ── Phase 3: persist what phase 2 produced ───────────────────────────
        // Runs after the handlers so anything they changed is captured:
        // flushProfileData() snapshots the live store and the Lua globals
        // (captureSavedVariables), and the store subscription is still bound
        // so their edits are visible. Both must precede the VFS/VM teardown.
        this.markScriptsLoaded();
        this.flushProfileData();

        // ── Phase 4: tear down ───────────────────────────────────────────────
        for (const t of this.moduleSyncTimers.values()) clearTimeout(t);
        this.moduleSyncTimers.clear();
        // Cancel a still-pending deferred mapOpenEvent so it can't fire mid/post
        // teardown (the emit would no-op anyway, but don't leave a stray timer).
        this.mapOpen.dispose();
        this.storeUnsub?.();
        this.storeUnsub = null;
        for (const unsub of this.unsubs) unsub();
        this.unsubs.length = 0;
        this.session.windows.onRaiseEvent = undefined;
        this.session.windows.onDownloadMap = undefined;
        this.session.windows.onStartSpeedWalk = undefined;
        this.session.windows.onFileDrop = undefined;
        this.session.sounds.onMediaFinished = undefined;
        this.session.sounds.onMediaCaption = undefined;
        this.session.videos.onMediaCaption = null;
        // Stop everything that can fire a Lua callback BEFORE closing the VM.
        // The timer engine is the only autonomous async caller into Lua (a
        // tempTimer's setTimeout → dispatchCb); line feed and key bindings are
        // pull-based and already severed above (flushLines unsub), and HTTP/
        // sound/TTS/map events route through guarded paths or nulled dispatchers.
        // This runs after fireExit so a timer scheduled by a sysExitEvent handler
        // is cleared too. (TimerEngine.destroy is idempotent — useEngines also
        // calls it.) Without this, a timer firing post-close hits a freed
        // lua_State → WASM out-of-bounds abort → broken teardown → app hang.
        this.timerEngine.destroy();
        this.runtimes.lua?.destroy();
        this.runtimes.lua = null;
        this.triggerEngine.setLuaEval(null);
        this.triggerEngine.setColorMatcher(null);
        // Unbind the host. This does NOT guard against late *Lua* calls —
        // lua_close ran a few lines up. It guards against DOM-side callers
        // that outlive the engine: a rendered line's hyperlink onClick closure
        // captures the API, and the output area may unmount after this. Those
        // paths bottom out in guarded methods (`if (!lua) return`), but the
        // store-backed ones do not — without this, getPackageNames /
        // createPermTrigger would read and mutate a closed profile's tree.
        //
        // Placement: destroy() is fully synchronous, so nothing external can
        // observe the states between its statements — this call's position is
        // free EXCEPT for one hard constraint. fireExit() above dispatches
        // sysExitEvent into Lua synchronously, so exit handlers re-enter the
        // API while teardown is in progress. Hoisting this above fireExit()
        // (tempting, since "unbind first" reads tidier) would hand those
        // handlers an inert host and silently break every sysExitEvent script
        // that saves state on the way out. It must stay after fireExit().
        this.api.setHost(null);
        this.session.sounds.stopAll();
        this.session.sounds.setLoader(null);
        this.api.destroy();
        // The VFS is owned by App (it mounted/registered it before render and
        // flushes/unmounts it on profile close) — the engine only drops its
        // reference here, it does not unmount.
        this.vfs = null;
    }

    // Tag a Lua error with the source entity (kind + id + name + line) so the
    // error log can render a jump-to-source button. `printError` forwards the
    // source through the script.log event into the session buffer.
    private reportEntityError(
        kind: ScriptLogSourceKind,
        id: string,
        name: string,
        err: unknown,
    ): void {
        const msg = err instanceof Error ? err.message : String(err);
        const source: ScriptLogSource = { kind, id, name };
        const line = parseLuaErrorLine(msg);
        if (line !== undefined) source.line = line;
        this.api.printError(`[${formatErrorPrefix(kind, name)}] ${msg}`, source);
    }

    // Mudlet TScript semantics: the body runs at load time (defining e.g.
    // `function MyScript(event, ...) ... end` as a global), and each event
    // handler fires by looking up the function named after the script and
    // calling it. We resolve by name on every dispatch (not by capturing a
    // function reference) so re-saving the script picks up the new function,
    // and so missing/mistyped names silently no-op like Mudlet.
    //
    // The lookup goes through __mudix_resolve_handler, which walks dotted names
    // the way Mudlet's `return <name>` evaluation does — packages commonly name
    // a script after the table field it defines (`mmp.centerRoominfo`), and a
    // flat _G[name] lookup would never find those.
    //
    // The wrapper also kills any previously-registered handlers for this
    // script (Bridge.lua's __mudix_script_handlers tracks IDs by script id)
    // so re-saving doesn't accumulate duplicate registrations.
    private wrapScript(script: ScriptNode): string {
        if (script.eventHandlers.length === 0) return script.code;
        const sidLiteral = JSON.stringify(script.id);
        const nameLiteral = JSON.stringify(script.name);
        const registrations = script.eventHandlers
            .map(e =>
                `__mudix_script_handlers[${sidLiteral}][#__mudix_script_handlers[${sidLiteral}]+1] = ` +
                `registerAnonymousEventHandler(${JSON.stringify(e)}, function(...) ` +
                `local __fn = __mudix_resolve_handler(${nameLiteral}); ` +
                `if __fn then return __fn(...) end ` +
                `end)`)
            .join('\n');
        return [
            `__mudix_kill_script_handlers(${sidLiteral})`,
            `__mudix_script_handlers[${sidLiteral}] = {}`,
            script.code,
            registrations,
        ].join('\n');
    }

    private executePermAlias(alias: AliasNode, matches: string[]): void {
        if (alias.command) {
            const cmd = alias.command.replace(/%(\d)/g, (_, d) => {
                const idx = Number(d);
                return idx === 0 ? matches[0] : (matches[idx] ?? '');
            });
            this.api.send(cmd);
        }
        if (alias.code && alias.language === 'lua') {
            try {
                this.runtimes.lua?.runWithMatches(alias.code, alias.name, matches);
            } catch (err) {
                this.reportEntityError('alias', alias.id, alias.name, err);
            }
        }
    }

    private executePermTrigger(
        trigger: TriggerNode,
        matches: (string | undefined)[],
        matchedText: string,
        multimatches?: (string | undefined)[][],
        namedGroups?: Record<string, string>,
        captureSpans?: { start: number; length: number }[],
        namedSpans?: Record<string, { start: number; length: number }>,
        matchStart?: number,
    ): void {
        // Built-in command send
        if (trigger.command) {
            const cmd = trigger.command.replace(/%(\d)/g, (_, d) => {
                const idx = Number(d);
                return (idx === 0 ? matches[0] : matches[idx]) ?? '';
            });
            this.api.send(cmd, false);
        }

        // Built-in highlight
        if (trigger.highlight && matchedText) {
            const { fg, bg } = trigger.highlight;
            if (fg || bg) {
                const idx = this.api.selectString(matchedText, 1);
                if (idx >= 0) {
                    const fgColor = fg ? hexToRgb(fg) : null;
                    const bgColor = bg ? hexToRgb(bg) : null;
                    if (fgColor || bgColor) {
                        this.api.applyFormatToSelection({
                            ...(fgColor ? { foreground: fgColor } : {}),
                            ...(bgColor ? { background: bgColor } : {}),
                        });
                    }
                    this.api.deselect();
                }
            }
        }

        // User code
        if (trigger.code && trigger.language === 'lua') {
            try {
                const fullMatchSpan = matchStart !== undefined && matchedText
                    ? { start: matchStart, length: matchedText.length }
                    : undefined;
                this.runtimes.lua?.runWithMatches(
                    trigger.code, trigger.name, matches, multimatches, namedGroups,
                    captureSpans, namedSpans, fullMatchSpan);
            } catch (err) {
                this.reportEntityError('trigger', trigger.id, trigger.name, err);
            }
        }
    }

    private executePermKeybinding(binding: KeyNode): void {
        if (binding.command) this.api.send(binding.command, false);
        if (binding.code && binding.language === 'lua') {
            try {
                this.runtimes.lua?.run(binding.code, `key "${binding.name}"`);
            } catch (err) {
                this.reportEntityError('key', binding.id, binding.name, err);
            }
        }
    }

    /**
     * Run a button's command + code. The Lua `code` runs on every click.
     * For two-state buttons, `nextState=true` (going DOWN) sends `commandDown`,
     * otherwise (going UP, or single-state click) sends `command`.
     */
    executeButton(button: ButtonNode, nextState: boolean): void {
        const goingDown = button.isPushDown && nextState;
        const cmd = goingDown ? button.commandDown : button.command;
        if (cmd) this.api.send(cmd, false);
        if (button.code && button.language === 'lua') {
            try {
                this.runtimes.lua?.run(button.code, `button "${button.name}"`);
            } catch (err) {
                this.reportEntityError('button', button.id, button.name, err);
            }
        }
        this.api.flushOutput();
    }

    /**
     * Run a flushLines batch end-to-end: triggers, rendering, then deferred-echo
     * flush. Shared between the network-driven flushLines listener and the
     * scripting `feedTriggers` API so both paths preserve identical semantics
     * (line ordering, ANSI carry, trigger-echo placement).
     */
    /** Part of {@link EngineHost} — also reached directly from the flushLines
     *  subscription, and by feedTriggers via the host so synthetic batches share
     *  ordering semantics with network output. */
    processFlushBatch(groups: { text: string; type: string }[]): void {
        for (const { text, type } of groups) {
            try {
                const lines = text.split('\n');
                if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

                // Only MUD-typed groups participate in cross-line/cross-batch
                // SGR carry. Client-side echoes and errors are formatted
                // independently and shouldn't inherit (or perturb) the server's
                // running colour state.
                const carryEnabled = type === 'mud';
                let carryState: FormatStateSnapshot | undefined =
                    carryEnabled ? this.mudCarryState : undefined;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const lineIsPrompt = this.promptPending && i === lines.length - 1;
                    if (lineIsPrompt) this.promptPending = false;

                    // Build the render units for this network line. Normally one
                    // unit per line, but when MXP is active a single line can carry
                    // several visual lines via <BR> tags — splitMxpResultLines
                    // breaks the parsed result on those newlines so each renders
                    // (and fires triggers) on its own. `blankRenders` forces a
                    // blank line to render (true for an intentional <BR>-split gap;
                    // for a single line it mirrors the old `line === ''` rule so a
                    // text-free MXP line — e.g. pure <!ENTITY> defs — stays hidden).
                    const units: { plain: string; buffer: AnsiAwareBuffer; outputLine: string; blankRenders: boolean }[] = [];
                    if ((this.mxpActive || this.forceMxpProcessorOn) && type === 'mud') {
                        // MXP is live: parse the in-band markup into styled
                        // segments + clean (tag/entity-decoded) plain text, and
                        // wire any <SEND>/<A> links into clickable hyperlinks.
                        // The parser owns SGR carry on these lines (it walked
                        // every byte), so computeTrailingState is bypassed.
                        const r = this.mxp.parseLine(line, carryState);
                        if (debugMxpEnabled()) logMxpLine(line, r.segments);
                        carryState = r.trailingSnapshot;
                        const parts = splitMxpResultLines(r);
                        const multiLine = parts.length > 1;
                        for (const part of parts) {
                            const buffer = new AnsiAwareBuffer(part.segments);
                            this.wireMxpLinks(buffer, part.links);
                            this.wireOsc8Links(buffer);
                            units.push({
                                plain: part.plain,
                                buffer,
                                outputLine: multiLine ? part.plain : line,
                                blankRenders: multiLine ? true : line === '',
                            });
                        }
                        // MXP <FRAME> creates/closes a mini-console; <DEST> writes
                        // redirected text into it. A redirect to a frame that
                        // doesn't exist falls back to inline main rendering (the
                        // parser already pulled it out of the main line), matching
                        // Mudlet's degradation when setMxpDestination fails.
                        if (r.frames) for (const f of r.frames) this.api.mxpFrame(f.name, f.attrs);
                        if (r.redirects) for (const rd of r.redirects) {
                            const fbuf = new AnsiAwareBuffer(rd.segments);
                            if (!this.api.mxpWriteToFrame(rd.frame, fbuf, rd.eof)) {
                                units.push({ plain: rd.plain, buffer: fbuf, outputLine: rd.plain, blankRenders: rd.plain === '' });
                            }
                        }
                        // MXP <SOUND>/<MUSIC> are the same server-driven audio
                        // triggers as MSP, so route them through the identical
                        // resolve-and-play path (media/ cache, U= download, game
                        // mute gate).
                        if (r.sounds) for (const s of r.sounds) void this.handleMspCommand(s);
                    } else {
                        const buffer = new AnsiAwareBuffer(line, carryState, this.osc8Presets);
                        this.wireOsc8Links(buffer);
                        // The buffer's text is the line with every escape
                        // sequence (SGR, OSC 8 links, cursor moves, …) already
                        // consumed — exactly what's rendered — so trigger
                        // matching sees the same plain text the user sees.
                        const plain = buffer.text;
                        // computeTrailingState reflects the *actual* end-of-line
                        // SGR — including trailing resets, and unchanged across
                        // blank lines — unlike buffer.trailingState() which only
                        // sees the last text segment's state.
                        carryState = computeTrailingState(line, carryState);
                        units.push({ plain, buffer, outputLine: line, blankRenders: line === '' });
                    }

                    for (let u = 0; u < units.length; u++) {
                        const { plain, buffer, outputLine, blankRenders } = units[u];
                        // Only the final visual line of a prompt-bearing network
                        // line is the prompt (e.g. just the "> ", not the room).
                        const isPrompt = lineIsPrompt && u === units.length - 1;

                        if (plain.length > 0) {
                            this.processLineTriggers(plain, buffer, isPrompt);
                            this.emit('output', [outputLine, type]);
                        }

                        let shouldRender =
                            !buffer.deleted &&
                            (blankRenders || plain.length > 0 || !FILTER_ANSI_ONLY_LINES);
                        // Mudlet `blankLinesBehaviour` (TBuffer): for empty server
                        // lines, either hide them or replace them with a single
                        // space. Scoped to mud-typed output — echoes/errors are
                        // unaffected, matching Mudlet's TBuffer-only handling.
                        let renderBuffer = buffer;
                        if (shouldRender && type === 'mud' && plain.length === 0) {
                            const behaviour = this.session.blankLinesBehaviour;
                            if (behaviour === 'hide') {
                                shouldRender = false;
                            } else if (behaviour === 'replacewithspace') {
                                renderBuffer = new AnsiAwareBuffer(' ');
                            }
                        }
                        if (shouldRender) {
                            this.session.events.emit('message', renderBuffer, type, Date.now(), isPrompt);
                        }

                        // Flush this line's trigger echoes right after it renders so
                        // they land in Mudlet's position — directly after the line
                        // they fired on — instead of being deferred to the end of
                        // the whole batch (which dumped every line's echo below the
                        // last rendered line).
                        this.api.flushDeferredEcho();
                    }
                }

                if (carryEnabled) this.mudCarryState = carryState;
            } finally {
                // Safety net: guarantees isDeferringEcho is reset and any echo
                // left buffered by a mid-line throw is flushed.
                this.api.flushDeferredEcho();
            }
        }
    }

    /**
     * Attach clickable hyperlinks for the MXP `<SEND>`/`<A>` ranges the parser
     * found. `setHyperlink` overlays each range while preserving the segments'
     * existing colours/attributes (including the underline the parser applied as
     * a link cue). Link behaviour — send a MUD command, open a URL in a new tab,
     * or pop up a multi-command menu — is built by ScriptingAPI.
     */
    private wireMxpLinks(buffer: AnsiAwareBuffer, links: MxpLink[]): void {
        for (const link of links) {
            const hl = this.api.createMxpHyperlink(
                link.kind, link.payload, link.hint, link.prompts?.cmds, link.prompts?.hints,
            );
            buffer.setHyperlink([link.start, link.end], hl);
        }
    }

    /**
     * Turn OSC 8 hyperlinks (recorded by the ANSI/MXP parser as a bare `url` on
     * the segment) into clickable links. `createOsc8Hyperlink` maps the URI's
     * scheme to the action — send a command, seed the command bar, or open a
     * URL — and drops links whose scheme isn't allowed. Runs after
     * `wireMxpLinks` so an MXP `<SEND>` overlaid on the same text wins.
     */
    private wireOsc8Links(buffer: AnsiAwareBuffer): void {
        buffer.bindUrlHyperlinks((url, link) => this.api.createOsc8Hyperlink(url, link));
    }

    /**
     * Run all triggers against `plain` (the original ANSI-stripped text).
     * Trigger handlers that call selectString/fg/bg/deleteLine modify `buffer`
     * in-place. The buffer is NOT rendered here — the caller renders it after
     * this returns, so the final rendered line already has all colorization.
     *
     * echo/cecho output from trigger handlers is deferred (via ScriptingAPI)
     * and flushed after all lines in the batch are rendered.
     */
    private processLineTriggers(plain: string, buffer: AnsiAwareBuffer, isPrompt = false): void {
        this.api.beginLine(buffer, isPrompt);
        try {
            this.runtimes.lua?.setCurrentLine(plain, isPrompt);
            // Single Mudlet-style pass over permanent + temporary triggers in one
            // ordered list: each node is matched and acted on in registration
            // order, so a permanent trigger fires before a temp created later
            // that also matches the line (and vice-versa for the rare runtime
            // permanent). Replaces the old temp-then-perm two-phase split.
            this.triggerEngine.process(plain, isPrompt, (m) => {
                this.executePermTrigger(
                    m.trigger,
                    // Mudlet (and mudix's temp-trigger path) put the whole regex
                    // MATCH at matches[1], not the whole line — they only differ
                    // for an unanchored pattern that matches a substring. Passing
                    // `plain` here made `selectString(matches[1])` highlight the
                    // entire line (issue #4). matchedText is the matched portion.
                    [m.matchedText, ...m.captures],
                    m.matchedText,
                    m.multimatches,
                    m.namedGroups,
                    m.captureSpans,
                    m.namedSpans,
                    m.matchStart,
                );
            });
        } finally {
            this.api.endLine();
        }
    }

    private emit(event: string, args: unknown[]): void {
        try {
            this.runtimes.lua?.emitEvent(event, args);
        } catch (err) {
            this.api.printError(`[event "${event}"] ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private bridgeEvents(session: MudSession): void {
        // Mudlet `sysProfileFocusChangeEvent(focused)` — fires on tab/window
        // focus transitions for this profile. mudix has one active profile at
        // a time, so we map it to document.visibilitychange (the cheapest
        // signal that fires both on Alt-Tab and tab switches).
        const onVisibility = () => {
            this.raiseEvent('sysProfileFocusChangeEvent', [document.visibilityState === 'visible']);
        };
        document.addEventListener('visibilitychange', onVisibility);
        this.unsubs.push(() => document.removeEventListener('visibilitychange', onVisibility));

        // Mudlet `sysSettingChanged(setting, value)` — fired whenever the
        // per-connection profile settings slice mutates. We diff the slice
        // by key so each changed field gets its own event (matching Mudlet's
        // per-setting granularity).
        const seedProfile = useAppStore.getState().connectionProfile[this.connectionId];
        let lastProfile: Record<string, unknown> = (seedProfile ?? {}) as Record<string, unknown>;
        this.unsubs.push(useAppStore.subscribe((state) => {
            const next = (state.connectionProfile[this.connectionId] ?? {}) as Record<string, unknown>;
            if (next === lastProfile) return;
            for (const key of Object.keys(next)) {
                if (next[key] !== lastProfile[key]) {
                    this.raiseEvent('sysSettingChanged', [key, next[key]]);
                }
            }
            for (const key of Object.keys(lastProfile)) {
                if (!(key in next) && lastProfile[key] !== undefined) {
                    this.raiseEvent('sysSettingChanged', [key, undefined]);
                }
            }
            lastProfile = next;
        }));

        this.unsubs.push(
            session.events.on('prompt', () => {
                this.promptPending = true;
                this.visibility.onPrompt();
            }),
            // OSC 8 visibility expiry: a user command (echo) is "input", any
            // other non-error line is "output". Concealment of armed links is
            // handled by the controller scanning the live output.
            session.events.on('message', (_text, type) => {
                if (type === 'echo') this.visibility.onInput();
                else if (type !== 'error') this.visibility.onOutput();
            }),
            // Mudlet `sysTelnetEvent(type, option, message)` — fired by
            // MudClient for any unsupported telnet IAC sequence.
            session.events.on('telnet.event', (type, option, message) => {
                this.raiseEvent('sysTelnetEvent', [type, option, message]);
            }),
            // Mudlet `sysEchoAnomalyDetected` — raised once when the echo
            // handler trips its 5-toggles-in-5s safeguard and refuses ECHO
            // for the rest of the session.
            session.events.on('telnet.echo.anomaly', () => {
                this.raiseEvent('sysEchoAnomalyDetected', []);
            }),
            // Mudlet `raiseProtocolEvent("sysProtocolRejected", name)` — fired
            // when mudix refuses a telnet option it deliberately doesn't support
            // (SUPPRESS_GO_AHEAD, LINEMODE — line mode only, like Mudlet).
            session.events.on('protocol.rejected', (protocol) => {
                this.raiseEvent('sysProtocolRejected', [protocol]);
            }),
            // Mudlet `sysCharacterModeDetected` — the server requested SGA and
            // enabled server-side echo (character-at-a-time), which mudix can't
            // drive well. Raised once per connection, and — matching Mudlet's
            // cTelnet::checkCharacterModePattern — accompanied by a visible
            // [ WARN ] line in the main output.
            session.events.on('charmode.detected', () => {
                this.raiseEvent('sysCharacterModeDetected', []);
                this.session.events.emit('message',
                    mudletWarn('This game appears to use character-at-a-time mode, which is not '
                        + 'supported. Input may not work as expected. Consider using keybindings '
                        + 'for immediate key response instead.'),
                    'warn', Date.now());
            }),
            session.events.on('flushLines', (groups) => {
                // TEMP DIAGNOSTIC: set window.__MUDIX_DEBUG_FLUSH = true in the
                // devtools console to log each network flush batch's raw line
                // groups (newlines escaped) so we can see the exact order lines
                // arrive relative to trigger echoes. Remove once diagnosed.
                if ((globalThis as { __MUDIX_DEBUG_FLUSH?: boolean }).__MUDIX_DEBUG_FLUSH) {
                    // eslint-disable-next-line no-console
                    console.log('[FLUSH BATCH]', groups.map(g => ({ type: g.type, text: g.text })));
                }
                try {
                    this.processFlushBatch(groups);
                } catch (err) {
                    this.api.printError(`[scripting] line flush failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }),
            session.events.on('client.connect', () => {
                // Drop any colour carry from a prior session — the new server
                // starts at default SGR.
                this.mudCarryState = undefined;
                // MXP renegotiates per connection; drop any leftover definitions/
                // open tags/modes and wait for the new session's mxp.negotiated.
                this.mxp.reset();
                this.mxpActive = false;
                this.mxpHandshakeEnabled = false;
                // mudix's native `connect` plus the Mudlet-standard name — the
                // bundled generic mapper and ported scripts register a
                // sysConnectionEvent handler, so both must fire.
                this.emit('connect', []);
                this.emit('sysConnectionEvent', []);
            }),
            session.events.on('client.disconnect', () => {
                this.emit('disconnect', []);
                this.emit('sysDisconnectionEvent', []);
                // Mudlet raises sysProtocolDisabled as protocols tear down. GMCP
                // is the only protocol mudix negotiates, and it ends with the
                // socket, so mirror the enabled/disabled pair here.
                if (this.gmcpNegotiated) {
                    this.gmcpNegotiated = false;
                    this.emit('sysProtocolDisabled', ['GMCP']);
                }
                if (this.msdpNegotiated) {
                    this.msdpNegotiated = false;
                    this.emit('sysProtocolDisabled', ['MSDP']);
                }
                if (this.msspNegotiated) {
                    this.msspNegotiated = false;
                    this.emit('sysProtocolDisabled', ['MSSP']);
                }
                if (this.mxpNegotiated) {
                    this.mxpNegotiated = false;
                    this.mxpActive = false;
                    this.emit('sysProtocolDisabled', ['MXP']);
                }
                if (this.mnesNegotiated) {
                    this.mnesNegotiated = false;
                    this.emit('sysProtocolDisabled', ['MNES']);
                }
            }),
            // GMCP finished negotiating (server WILL → client DO). Mudlet's
            // bundled GMCP.lua re-subscribes its registered modules on this
            // event; without it Core.Supports.Add is never re-sent on reconnect.
            session.events.on('gmcp.negotiated', () => {
                this.gmcpNegotiated = true;
                this.emit('sysProtocolEnabled', ['GMCP']);
            }),
            // Built-in Client.GUI handler — Mudlet semantics. One entry point
            // for both wire formats: the client emits this after the gmcp.*
            // event chain for the JSON shape (so scripts observe the payload
            // before we act on it) and instead of it for the legacy shape,
            // which Mudlet keeps out of the GMCP table entirely.
            session.events.on('clientGui', (payload) => {
                void this.handleClientGuiInstall(payload);
            }),
            session.events.on('gmcp', ({ path, value }) => {
                // Mirrors Mudlet TLuaInterpreter::parseJSON: write into the
                // Lua `gmcp` global first (additively — only the leaf is
                // replaced, siblings survive), then raise gmcp.Char,
                // gmcp.Char.Items, gmcp.Char.Items.List for an incoming
                // "Char.Items.List", each with args (eventName, fullKey).
                if (!path) return;
                if (debugGmcpEnabled()) {
                    const body = JSON.stringify(value);
                    console.debug(`[mudix.gmcp] ${path}`,
                        body.length > 200 ? body.slice(0, 200) + '…' : body);
                }
                this.runtimes.lua?.setGmcpValue(path, value);
                const fullKey = `gmcp.${path}`;
                let token = 'gmcp';
                for (const segment of path.split('.')) {
                    token += `.${segment}`;
                    this.emit(token, [token, fullKey]);
                }
                // Built-in Client.Map handler — Mudlet Host::setMmpMapLocation.
                // Records the game's published map URL; the actual download is
                // user-triggered from the map panel (Mudlet parity: dlgMapper's
                // Download button only enables once this location is known).
                if (path.toLowerCase() === 'client.map') {
                    const url = parseClientMapPayload(value);
                    if (url) this.session.windows.setMmpMapLocation(url);
                }
                // Built-in Client.Media handler — Mudlet's GMCP media protocol
                // (TMedia MediaProtocolGMCP). `Client.Media.Play/Load/Stop/
                // Default` drive server-side audio; we advertise `Client.Media 1`
                // in Core.Supports.Set, so a server may send these instead of MSP.
                const lowerPath = path.toLowerCase();
                if (lowerPath === 'client.media' || lowerPath.startsWith('client.media.')) {
                    const action = lowerPath.slice('client.media'.length).replace(/^\./, '');
                    void this.handleClientMedia(action || 'play', value);
                }
            }),
            // MSDP finished negotiating (server WILL → client DO). Mirrors the
            // GMCP pair so scripts can hook sysProtocolEnabled('MSDP') to send
            // their LIST / REPORT requests.
            session.events.on('msdp.negotiated', () => {
                this.msdpNegotiated = true;
                this.emit('sysProtocolEnabled', ['MSDP']);
            }),
            session.events.on('msdp', ({ path, value }) => {
                // Mirror Mudlet: write the decoded value into the Lua `msdp`
                // global, then raise a single `msdp.<VARNAME>` event with args
                // (eventName, fullKey). MSDP variable names are flat (no dotted
                // descent like GMCP), so nesting comes only from the value.
                if (!path) return;
                this.runtimes.lua?.setMsdpValue(path, value);
                const token = `msdp.${path}`;
                this.emit(token, [token, token]);
            }),
            // MSSP finished negotiating — mirrors the GMCP/MSDP pair so scripts
            // can hook sysProtocolEnabled('MSSP').
            session.events.on('mssp.negotiated', () => {
                this.msspNegotiated = true;
                this.emit('sysProtocolEnabled', ['MSSP']);
            }),
            // MNES / NEW-ENVIRON finished negotiating (server DO → client WILL).
            // Mirror the GMCP/MSDP/MSSP pair so scripts can hook
            // sysProtocolEnabled. The payload names the active mode ('MNES' or
            // 'NEW-ENVIRON') — both ride telnet option 39 but report different
            // variable sets.
            session.events.on('mnes.negotiated', (protocol) => {
                this.mnesNegotiated = true;
                this.emit('sysProtocolEnabled', [protocol]);
            }),
            // MXP finished negotiating (telnet option 91). Flip on in-band markup
            // parsing and mirror the GMCP/MSDP/MSSP pair so scripts can hook
            // sysProtocolEnabled('MXP').
            session.events.on('mxp.negotiated', (viaTelnet) => {
                this.mxpActive = true;
                // Only a real option-91 handshake authorizes sending the
                // <SUPPORTS>/<VERSION> replies (see ScriptingAPI / event doc).
                if (viaTelnet) this.mxpHandshakeEnabled = true;
                if (!this.mxpNegotiated) {
                    this.mxpNegotiated = true;
                    this.emit('sysProtocolEnabled', ['MXP']);
                }
            }),
            session.events.on('mssp', ({ name, value }) => {
                // Mirror Mudlet TLuaInterpreter::parseMSSP: write the value into
                // the Lua `mssp` global, then raise a single `mssp.<VARNAME>`
                // event with args (eventName, fullKey). MSSP variables are flat
                // scalar strings.
                if (!name) return;
                this.runtimes.lua?.setMsspValue(name, value);
                const token = `mssp.${name}`;
                this.emit(token, [token, token]);
            }),
            // MSP — translate parsed `!!SOUND` / `!!MUSIC` tags into
            // SoundManager calls. `Off` stops the matching kind; otherwise
            // the file is cached under `<profile>/media/` (downloading from
            // the `U=` base URL on first miss) before being played.
            session.events.on('msp', (command) => {
                void this.handleMspCommand(command);
            }),
            // Package install/uninstall events are dispatched by callers via
            // notifyPackageInstalled / notifyPackageUninstalled (not the
            // session event bus) so we can sequence the script-load before
            // sysInstallPackage fires. See those methods for rationale.
        );
    }
}

/**
 * Diagnostic gate — enable via `localStorage.setItem('mudix.debugMxp', '1')` in
 * the browser console to log every raw MXP line (escapes visible) alongside the
 * colour the parser assigned to each rendered segment. Use this to tell whether
 * a colour (e.g. the green object-id digits in a clickable item list) comes from
 * the server's own ANSI/`<COLOR>` markup or from a client parsing artifact.
 */
function debugMxpEnabled(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('mudix.debugMxp') === '1';
    } catch {
        return false;
    }
}

/** Render a FormatColor compactly for the MXP debug log (`#rrggbb`, `idx:N`). */
function describeColor(c?: FormatColor): string {
    if (!c) return '-';
    if (c.space === 'rgb') {
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
    }
    if (c.space === 'hex') return c.color.startsWith('#') ? c.color : `#${c.color}`;
    return `idx:${c.index}`;
}

/** Log one parsed MXP line: the raw input with escapes visible, then each
 *  segment's text and its foreground/background/flags. The raw line reveals
 *  whether the server itself emitted the colour codes the segments carry. */
function logMxpLine(raw: string, segments: BufferSegment[]): void {
    const segs = segments.map((s) => {
        const st = s.state;
        const flags = st
            ? [st.bold && 'b', st.italic && 'i', st.underline && 'u', st.strikethrough && 's']
                  .filter(Boolean).join('')
            : '';
        return `  ${JSON.stringify(s.text)} fg=${describeColor(st?.foreground)}`
            + ` bg=${describeColor(st?.background)}${flags ? ` [${flags}]` : ''}`;
    });
    // eslint-disable-next-line no-console
    console.debug(`[mudix.mxp] raw=${JSON.stringify(raw)}\n${segs.join('\n')}`);
}
