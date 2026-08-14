import { type OutputRendererControls } from '../output/OutputRenderer';
import type { Console } from '../../mud/text/Console';
import type { AnsiAwareBuffer } from '../../mud/text/FormatState';
import type { DockSide, MxpTabPage, WindowHandle, WindowOpenOptions, ScriptWindowRenderData } from './types';
import { MAP_VIEW_ID_RE, mapViewWindowId, migrateClientWindowHints } from './types';
import { MapStore } from '../../map/MapStore';
import { parseXmlMap } from '../../map/xmlMapImport';
import { exportAreaImage } from '../../map/mapImageExport';
import { useAppStore, selectProfileField } from '../../storage';
import { saveMap as saveMapToStorage, loadMap as loadMapFromStorage } from '../../storage/mapStorage';
import { readMapFromBuffer, writeMapToBuffer } from 'mudlet-map-binary-reader';
import { serializeMapInWorker, streamMapInWorker } from '../../map/mapParserClient';
import { Buffer } from 'buffer';
import { OverlayLayerOrder } from '../layout/overlayLayerOrder';

interface ScriptWindowData extends ScriptWindowRenderData {
    pendingText: Array<string | AnsiAwareBuffer>;
    /** Pre-mount holding cell for the latest partial line (script echo without
     *  a trailing newline). Only the most-recent value matters — the renderer
     *  paints partials in-place — so we overwrite rather than queue. */
    pendingPartial?: AnsiAwareBuffer;
}

interface WindowCmdLineState {
    /** Lua callback fired on Enter. When null/undefined, Enter falls through to
     *  the main connection (mirrors Mudlet's pre-setCmdLineAction default). */
    action: ((text: string) => void) | null;
}

interface ScrollState {
    scrollBarVisible: boolean;
    horizontalScrollBarVisible: boolean;
    scrollingEnabled: boolean;
}

/** Live handle onto a mounted map renderer, registered by MapPanel. Backs the
 *  Lua getMapZoom/setMapZoom/updateMap APIs, which need to read and drive the
 *  renderer state that lives inside the React component. */
export interface MapControl {
    getZoom: () => number | null;
    setZoom: (zoom: number) => void;
    redraw: () => void;
    /** Mudlet `exportAreaImage` — render an area (optionally a single z-level) to
     *  PNG bytes via a headless renderer, leaving the live view untouched.
     *  Returns null when the area is unknown / unrenderable. */
    exportArea: (areaId: number, zLevel?: number) => Uint8Array | null;
}

/** Progress of an in-flight streamed map load, as published by
 *  {@link WindowManager.subscribeMapLoadProgress}.
 *
 *  `total` is 0 until the worker has decoded the map header (the room count is
 *  summed from the areas' room-id lists, which the header carries) — until then
 *  the load is genuinely indeterminate and the UI should say so rather than
 *  guess a denominator. */
export interface MapLoadProgress {
    /** Rooms folded into the store so far. */
    loaded: number;
    /** Total rooms the map declares, or 0 while the header is still decoding. */
    total: number;
    /**
     * `rooms` — streaming rooms into the store; `loaded`/`total` advance.
     *
     * `building` — every room has landed and the renderer is indexing the map
     * and building its first scene. That work is synchronous and, on a large
     * map, by far the longest part of the wait, so it gets its own phase rather
     * than leaving the bar parked at 99% looking hung.
     */
    phase: 'rooms' | 'building';
}

/** Resolve after the browser has had a chance to paint. Two frames: the first
 *  callback runs before the upcoming paint, the second after it, so a state
 *  change published just before a long synchronous block is actually on screen
 *  by the time the block starts. Falls back to a timeout where rAF doesn't run
 *  (headless/background tabs, tests). */
function nextFrame(): Promise<void> {
    return new Promise<void>(resolve => {
        if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        requestAnimationFrame(() => requestAnimationFrame(done));
        // rAF is throttled to a stop in background tabs; don't hang the load.
        setTimeout(done, 100);
    });
}

const DEFAULT_SCROLL_STATE: ScrollState = {
    scrollBarVisible: true,
    horizontalScrollBarVisible: false,
    scrollingEnabled: true,
};

const TEXT_BUFFER_LIMIT = 5000;

/** Map a DOM MouseEvent.button to Mudlet's button number for
 *  sysWindowMousePress/ReleaseEvent. DOM: 0=left,1=middle,2=right,3=back,
 *  4=forward → Mudlet: 1=left,2=right,3=middle,4=back,5=forward (0 otherwise). */
function mouseButtonNumber(button: number): number {
    switch (button) {
        case 0: return 1; // left
        case 2: return 2; // right
        case 1: return 3; // middle
        case 3: return 4; // back
        case 4: return 5; // forward
        default: return 0;
    }
}

const DEFAULT_SIZE: Record<'text' | 'html' | 'map', { w: number; h: number }> = {
    text: { w: 400, h: 300 },
    html: { w: 400, h: 300 },
    map:  { w: 500, h: 400 },
};

const DEFAULT_DOCK_EXTENTS: Record<DockSide, number> = {
    left: 250, right: 250, top: 150, bottom: 150,
};

export type WindowsChangedFn = (
    windows: ScriptWindowRenderData[],
    dockExtents: Record<DockSide, number>,
) => void;

export class WindowManager {
    readonly mapStore = new MapStore();
    private readonly windows       = new Map<string, ScriptWindowData>();
    private readonly controls      = new Map<string, OutputRendererControls>();
    private readonly elements      = new Map<string, HTMLElement>();
    /** Outer panel element used by getSize / sysUserWindowResizeEvent. Distinct
     *  from `elements` (the writable text/HTML target) so size queries report the
     *  full user-window box that labels live in, not the inner output area. */
    private readonly viewports     = new Map<string, HTMLElement>();
    private readonly lineBuffers   = new Map<string, string>();
    /** Per-window scroll/scrollbar overrides applied via CSS classes when the
     *  console's wrapper element registers. Mudlet's enable/disable Scrolling
     *  and (Horizontal)ScrollBar APIs back into this. */
    private readonly scrollState   = new Map<string, ScrollState>();
    private readonly portalTargets = new Map<string, HTMLDivElement>();
    /** Hidden, detached div in the *main* document used as a temporary parking
     *  spot for a portal target while a popout window is torn down — re-adopting
     *  the node here before the child window closes keeps its content alive (a
     *  node orphaned in a closed window's document would be lost). */
    private portalHolding: HTMLDivElement | null = null;
    private readonly resizeObservers = new Map<string, ResizeObserver>();
    private readonly lastEmittedSize = new Map<string, { w: number; h: number }>();
    /** Per-window last reported character grid (cols, rows) — used to gate
     *  sysConsoleSizeChanged so the event fires only on actual grid changes. */
    private readonly lastEmittedGrid = new Map<string, { cols: number; rows: number }>();
    private readonly activeTabGroups = new Map<string, string>(); // groupId → active panelId
    /** Per-window command-line state. Keyed by window id; entry exists only
     *  after enableCommandLine. The actual rendered <input> lives in TextPanel
     *  /HtmlPanel and pulls its enabled/css/value from the ScriptWindowRenderData
     *  payload that notify() emits — this map only carries non-serializable
     *  state (the Lua callback). */
    private readonly cmdLineState = new Map<string, WindowCmdLineState>();
    private readonly mapCallbacks  = new Map<string, (roomId: number) => void>();
    private readonly mapControls   = new Map<string, MapControl>();
    /** Per-window teardown for the mousedown/mouseup listeners observeMouse
     *  attaches. Keyed by window id ('main' for the central output). */
    private readonly mouseCleanups = new Map<string, () => void>();
    /** Per-window teardown for the dragenter/dragover/drop listeners
     *  observeDrop attaches — these power Mudlet's sysDropEvent /
     *  sysDropUrlEvent on viewports. */
    private readonly dropCleanups = new Map<string, () => void>();
    private mapLoadCallback: ((buf?: ArrayBuffer) => boolean) | null = null;
    /** Live progress of a streamed map load, or null when none is running.
     *  Held here (rather than pushed only to subscribers) so a MapPanel that
     *  mounts mid-load — the normal case at cold start, where bootstrapMap
     *  begins before the panel exists — can render the bar straight away. */
    private mapLoadProgress: MapLoadProgress | null = null;
    private readonly mapProgressSubscribers = new Set<(p: MapLoadProgress | null) => void>();
    /** Single in-flight bootstrap promise — both ScriptingEngine.start (which
     *  awaits the map before applying scripts, Mudlet parity) and MapPanel on
     *  mount call into this; whichever lands first triggers the work. */
    private mapBootstrapInflight: Promise<boolean> | null = null;
    // Debounced background map-save state. scheduleMapSave() coalesces bursts of
    // view changes (per-area zoom) into one worker-serialised IndexedDB write;
    // flushMapSave() drains a pending save on session close.
    private mapSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private mapSavePending = false;
    /** MMP map URL announced by the game via GMCP `Client.Map` (Mudlet
     *  TMap::mMmpMapLocation). Lives here rather than on ScriptingEngine so it
     *  survives script reloads, like Mudlet's TMap does. */
    private _mmpMapLocation = '';
    private _connectionId = '';
    /** Names of windows created by Lua createMiniConsole — distinguishes them
     *  from openUserWindow panels for windowType() reporting. */
    private mainViewportEl: HTMLElement | null = null;
    private readonly miniConsoles  = new Set<string>();
    /** MXP `<FRAME>` tab strips, keyed by the frame that hosts the strip. Each
     *  page is another frame's console nested inside this one's viewport, so
     *  switching tabs just swaps which child is visible. Purely transient — MXP
     *  frames are torn down on reconnect and never persisted to a layout hint. */
    private readonly frameTabs = new Map<string, { pages: MxpTabPage[]; active: string }>();
    /** Consoles backing an MXP `<FRAME>`. They render with a hairline border,
     *  the way Mudlet outlines every frame container (TMxpFrameManager's
     *  `1px solid #444444`), so a server's panes read as separate panes. */
    private readonly mxpFrameIds = new Set<string>();
    /** See getMxpBorders. */
    private mxpBorders = { top: 0, right: 0, bottom: 0, left: 0 };
    private consoleRegistry: Map<string, Console> | null = null;
    private windowHints: Record<string, WindowOpenOptions> = {};
    private nextZ       = 10;
    private nextDockOrder = 0;
    private readonly dockExtents: Record<DockSide, number> = { ...DEFAULT_DOCK_EXTENTS };

    // Public so FloatingWindowLayer (and other overlay components sharing this
    // registry via the other managers) can read/subscribe to the nested
    // wrapper layer's z-index — see overlayLayerOrder.ts.
    constructor(readonly overlayZ: OverlayLayerOrder = new OverlayLayerOrder()) {}

    /** Resolves the same "nested under which parent" id FloatingWindowLayer's
     *  resolveParent uses: an explicit non-'main' parent, else 'main' when this
     *  is a mini-console (createMiniConsole/createMapper without an explicit
     *  parent still nests under the main viewport), else null for a genuine
     *  root floating window — which shares no stacking context with any
     *  parent's labels, so there's nothing to touch. */
    private overlayParentId(win: Pick<ScriptWindowData, 'id' | 'parent'>): string | null {
        if (win.parent && win.parent !== 'main') return win.parent;
        if (this.miniConsoles.has(win.id)) return 'main';
        return null;
    }

    private touchOverlayWindows(win: Pick<ScriptWindowData, 'id' | 'parent'>): void {
        const parentId = this.overlayParentId(win);
        if (parentId) this.overlayZ.touch(parentId, 'windows', win.id);
    }

    private sinkOverlayWindows(win: Pick<ScriptWindowData, 'id' | 'parent'>): void {
        const parentId = this.overlayParentId(win);
        if (parentId) this.overlayZ.sink(parentId, 'windows', win.id);
    }

    onWindowsChange?:     WindowsChangedFn;
    onWindowHint?:        (id: string, hint: WindowOpenOptions) => void;
    /** Called when a window is explicitly closed — use to clear its auto-open flag. */
    onWindowClosed?:      (id: string) => void;
    /** Called when a dock side's extent changes — use to persist it. */
    onDockExtentsChange?: (extents: Record<DockSide, number>) => void;
    /** Called when a map window is opened or made visible. */
    onMapOpen?:           (id: string) => void;
    /** Bridge to ScriptingEngine.raiseEvent — used to fire system events
     *  (e.g. sysUserWindowResizeEvent) from window-lifecycle code. */
    onRaiseEvent?:        (event: string, args: unknown[]) => void;
    /** Called when a real File is dropped on a window. The handler (wired by
     *  ScriptingEngine) writes the bytes into the profile VFS and then raises
     *  Mudlet's sysDropEvent with a readable path — browsers don't expose a
     *  filesystem path on the dropped File, so we can't raise it inline here. */
    onFileDrop?:          (file: File, x: number, y: number, id: string) => void;
    /** Called whenever the *main* console's character grid changes (columns ×
     *  rows). MudSession wires this to the client so NAWS (telnet window size)
     *  tracks the output area. Distinct from onRaiseEvent (which drives Lua
     *  sysConsoleSizeChanged) so window-size reporting doesn't depend on the
     *  scripting layer being attached. */
    onMainConsoleResize?: (cols: number, rows: number) => void;
    /** Set by MapPanel — mirrors Mudlet's signal_mmpMapLocationChanged, which
     *  drives the mapper's "download map" affordance appearing/disappearing. */
    onMmpMapLocationChanged?: (url: string) => void;
    /** Bridge to ScriptingEngine.downloadMap — the map UI's "download map from
     *  game" action (Mudlet dlgMapper's Download button). */
    onDownloadMap?:       () => void;
    /** Bridge to the Lua speedwalk entry point (Mudlet Host::startSpeedWalk),
     *  wired by ScriptingEngine. Driven by {@link startSpeedWalk}. */
    onStartSpeedWalk?:    (from: number, to: number) => void;

    /** The MMP map URL from GMCP `Client.Map`, or '' when none announced. */
    get mmpMapLocation(): string {
        return this._mmpMapLocation;
    }

    /** Record the game-announced map URL (Mudlet TMap::setMmpMapLocation). */
    setMmpMapLocation(url: string): void {
        if (this._mmpMapLocation === url) return;
        this._mmpMapLocation = url;
        this.onMmpMapLocationChanged?.(url);
    }

    setConsoleRegistry(registry: Map<string, Console>): void {
        this.consoleRegistry = registry;
    }

    setWindowHints(hints: Record<string, WindowOpenOptions>): void {
        this.windowHints = migrateClientWindowHints(hints);
        hints = this.windowHints;
        // Auto-restore windows that were open when the connection was last closed.
        for (const [id, hint] of Object.entries(hints)) {
            if (hint.autoOpen && !this.windows.has(id)) {
                this.open(id, hint);
            }
        }
    }

    /** Restore saved dock extents from storage (called on connect, before setWindowHints). */
    setDockExtentsFromStorage(extents: Record<string, number>): void {
        for (const [side, size] of Object.entries(extents)) {
            if (size !== undefined) this.dockExtents[side as DockSide] = size;
        }
        this.notify();
    }

    /** Call after setting onWindowsChange to deliver current state immediately.
     *  Needed because windows may have been opened (e.g. autoOpen) before the
     *  React subscriber mounted. */
    initialize(): void {
        this.notify();
    }

    // ── saveWindowLayout / loadWindowLayout ───────────────────────────────────

    /**
     * Snapshot the current window hints + dock extents. Returned object is a
     * deep copy — safe to persist without aliasing the live state. Backs
     * Mudlet's `saveWindowLayout()`.
     */
    captureLayoutSnapshot(): { hints: Record<string, WindowOpenOptions>; dockExtents: Record<DockSide, number> } {
        return {
            hints: structuredClone(this.windowHints),
            dockExtents: { ...this.dockExtents },
        };
    }

    /**
     * Re-apply a previously captured snapshot to the live state. Backs
     * Mudlet's `loadWindowLayout()`. Behaviour:
     *   - Replaces the stored windowHints + dockExtents with the snapshot.
     *   - For each currently open window with a snapshot entry, rewrites its
     *     geometry / dock state / style fields in place (keeps pendingText,
     *     controls, miniconsole content intact).
     *   - For each snapshot hint with no current window, opens the window when
     *     the snapshot recorded it as visible (hidden !== true).
     * `onWindowHint` / `onDockExtentsChange` callbacks fire so the persistence
     * layer mirrors the restored state.
     */
    applyLayoutSnapshot(snapshot: { hints: Record<string, WindowOpenOptions>; dockExtents: Record<string, number> }): void {
        // 1) Dock extents
        for (const [side, size] of Object.entries(snapshot.dockExtents)) {
            if (size !== undefined) this.dockExtents[side as DockSide] = size;
        }
        this.onDockExtentsChange?.({ ...this.dockExtents });

        // 2) Replace the hint cache. structuredClone so subsequent saveHint
        //    mutations don't write back into the snapshot object.
        this.windowHints = structuredClone(snapshot.hints);

        // 3) Re-apply hints to currently open windows.
        for (const [id, hint] of Object.entries(this.windowHints)) {
            const win = this.windows.get(id);
            if (!win) continue;

            if (hint.x          !== undefined) win.x          = hint.x;
            if (hint.y          !== undefined) win.y          = hint.y;
            if (hint.width      !== undefined) win.width      = hint.width;
            if (hint.height     !== undefined) win.height     = hint.height;
            if (hint.title      !== undefined) win.title      = hint.title;

            win.docked     = hint.docked;
            win.dockOrder  = hint.dockOrder;
            win.dockFlex   = hint.dockFlex;
            win.dockGroup  = hint.dockGroup;
            win.tabOrder   = hint.tabOrder;
            win.splitGroup = hint.splitGroup;
            win.splitOrder = hint.splitOrder;
            win.splitFlex  = hint.splitFlex;

            win.fontSize        = hint.fontSize;
            win.fontFamily      = hint.fontFamily;
            win.wrapAt          = hint.wrapAt;
            win.wrapIndent      = hint.wrapIndent;
            win.wrapHangingIndent = hint.wrapHangingIndent;
            win.backgroundColor = hint.backgroundColor;
            win.backgroundImage = hint.backgroundImage;

            // Snapshot is authoritative for visibility: hidden flag flips the
            // current state. Don't bump zIndex — preserve relative stacking.
            win.visible = hint.hidden !== true;

            if (hint.dockGroup) {
                if (hint.isActiveTab || !this.activeTabGroups.has(hint.dockGroup)) {
                    this.activeTabGroups.set(hint.dockGroup, id);
                }
            }
        }

        // 4) Open windows that the snapshot has but are not currently mounted,
        //    provided they were visible at save time. Use `ignoreHint: false`
        //    semantics — pass the hint directly via options so open() lays the
        //    window out from the snapshot rather than from any stale prior
        //    state. autoOpen is preserved by spreading the saved hint.
        for (const [id, hint] of Object.entries(this.windowHints)) {
            if (this.windows.has(id)) continue;
            if (hint.hidden === true) continue;
            if (!hint.kind) continue;
            this.open(id, hint);
        }

        // 5) Persist the restored hints (so the live store mirrors the
        //    snapshot, and a later save without intervening edits is a no-op).
        for (const [id, hint] of Object.entries(this.windowHints)) {
            this.onWindowHint?.(id, hint);
        }

        this.notify();
    }

    // ── Portal target ─────────────────────────────────────────────────────────

    /** Returns the stable portal-target div for a window, creating it on first call.
     *  This div is physically moved between dock slots and floating frames — the
     *  panel component rendered into it never unmounts during transitions. */
    getOrCreatePortalTarget(id: string): HTMLDivElement {
        if (!this.portalTargets.has(id)) {
            const div = document.createElement('div');
            div.style.display = 'contents';
            this.portalTargets.set(id, div);
        }
        return this.portalTargets.get(id)!;
    }

    getPortalTarget(id: string): HTMLDivElement | undefined {
        return this.portalTargets.get(id);
    }

    /** A hidden, detached holding element in the main document. PopoutWindow
     *  re-parents a portal target here before closing its child window so the
     *  panel's DOM survives the teardown; the next docked/floating frame to
     *  mount appendChilds it back out. Lazily created. */
    getPortalHolding(): HTMLDivElement {
        if (!this.portalHolding) {
            const div = document.createElement('div');
            div.style.display = 'none';
            this.portalHolding = div;
        }
        return this.portalHolding;
    }

    // ── Pop out to a separate browser window ──────────────────────────────────

    /** Detach a panel into its own browser window. Layout fields (docked side /
     *  floating rect) are left untouched so popIn() restores the panel in place.
     *  The PopoutWindow component reacts to the state change and opens the window. */
    popOut(id: string): void {
        const win = this.windows.get(id);
        if (!win || win.poppedOut) return;
        win.poppedOut = true;
        win.visible   = true;
        this.notify();
    }

    /** Re-dock/re-float a popped-out panel back into the main window. Triggered
     *  explicitly or automatically when the popout window closes. */
    popIn(id: string): void {
        const win = this.windows.get(id);
        if (!win || !win.poppedOut) return;
        win.poppedOut = false;
        this.notify();
    }

    isPoppedOut(id: string): boolean {
        return this.windows.get(id)?.poppedOut ?? false;
    }

    // ── Panel mount / unmount ─────────────────────────────────────────────────

    registerTextPanel(id: string, controls: OutputRendererControls, element: HTMLElement): void {
        this.controls.set(id, controls);
        // A timestamp preference set while the panel was unmounted applies now.
        const queuedTimestamps = this.pendingTimestamps.get(id);
        if (queuedTimestamps !== undefined) {
            controls.setTimestampVisibility(queuedTimestamps);
            this.pendingTimestamps.delete(id);
        }
        const win = this.windows.get(id);
        if (win?.pendingText.length) {
            // Drive the renderer's partial-completion path by tagging completed
            // lines with type 'script' so a previously-buffered script-partial
            // would be replaced in-place (matches the main-output flow).
            for (const line of win.pendingText) controls.push(line, 'script');
            win.pendingText = [];
        }
        if (win?.pendingPartial && win.pendingPartial.length > 0) {
            controls.push(win.pendingPartial, 'script-partial');
            win.pendingPartial = undefined;
        }
        this.elements.set(id, element);
        this.applyScrollClasses(id);
    }

    /** Registers the outer panel element for size queries and sysUserWindowResizeEvent.
     *  Distinct from the writable element registered via registerTextPanel /
     *  register('html'): labels position against this rectangle, so getUserWindowSize
     *  must report it (not the inner output area). */
    registerViewport(id: string, element: HTMLElement): void {
        this.viewports.set(id, element);
        this.observeResize(id, element);
        this.observeMouse(id, element);
        this.observeDrop(id, element);
        // Re-render: parented miniconsoles whose parent just mounted need a
        // chance to portal into the freshly registered viewport.
        this.notify();
    }

    getViewport(id: string): HTMLElement | undefined {
        return this.viewports.get(id);
    }

    /** OutputArea registers the main `.output-wrapper` here so getColumnCount()
     *  can measure character width against the actual rendered element. */
    registerMainOutput(element: HTMLElement | null): void {
        if (element) {
            this.elements.set('main', element);
            this.applyScrollClasses('main');
        } else {
            this.elements.delete('main');
        }
    }

    /**
     * Registers the full main-viewport element (the one that spans the entire
     * console area including any setBorderTop/Bottom/Left/Right insets). Used
     * by getMainWindowSize so label-positioning scripts always see the full
     * window bounds, matching Mudlet semantics where labels live in window
     * coordinates and borders carve space *out of* them.
     */
    registerMainViewport(element: HTMLElement | null): void {
        this.mainViewportEl = element;
        if (element) {
            this.observeResize('main', element);
            this.observeMouse('main', element);
            this.observeDrop('main', element);
        } else {
            this.resizeObservers.get('main')?.disconnect();
            this.resizeObservers.delete('main');
            this.lastEmittedSize.delete('main');
            this.mouseCleanups.get('main')?.();
            this.mouseCleanups.delete('main');
            this.dropCleanups.get('main')?.();
            this.dropCleanups.delete('main');
        }
        // Main-parented miniconsoles portal into this element; re-render so the
        // FloatingWindowLayer picks up the new (or cleared) target.
        this.notify();
    }

    getMainViewportElement(): HTMLElement | null {
        return this.mainViewportEl;
    }

    /**
     * The DOM element main-parented nested windows (mini-consoles, embedded
     * mapper) portal into. This is `.main-overlay-root` — the SAME wrapper the
     * main labels / command lines / scroll boxes render into — so a window's
     * z-index and a label's z-index compete in one CSS stacking context and the
     * overlayZ ordinals actually take visual effect. It must NOT be a separate
     * sibling of the label overlay: `.main-overlay-root` carries an explicit
     * `z-index` (a stacking context that keeps all overlay content below
     * floating windows / modals), so a nested window portaled anywhere else
     * would either be trapped in a different context or leak its z above the
     * labels — which was the long-standing "map paints over every label" bug.
     * Both `.main-overlay-root` and the console viewport are `inset:0` over the
     * same main-viewport, so the portal target swap doesn't shift coordinates.
     * Falls back to the console viewport if the host hasn't registered yet.
     */
    private mainOverlayHostEl: HTMLElement | null = null;
    registerMainOverlayHost(element: HTMLElement | null): void {
        this.mainOverlayHostEl = element;
        // Main-parented miniconsoles portal into this element; re-render so the
        // FloatingWindowLayer picks up the new (or cleared) target.
        this.notify();
    }

    getMainOverlayHost(): HTMLElement | null {
        return this.mainOverlayHostEl ?? this.mainViewportEl;
    }

    /** The overlay host element that widgets under `parentId` (labels AND
     *  nested windows) share so their z-indices compete in one stacking
     *  context: `.main-overlay-root` for 'main', else the userwindow's own
     *  viewport (where its panel already renders the label overlays). */
    getOverlayHost(parentId: string): HTMLElement | null {
        return parentId === 'main' ? this.getMainOverlayHost() : (this.getViewport(parentId) ?? null);
    }

    register(id: string, element: HTMLElement, _kind: 'html'): void {
        this.elements.set(id, element);
        const win = this.windows.get(id);
        if (win?.pendingText.length) {
            for (const line of win.pendingText) {
                if (typeof line === 'string') element.insertAdjacentHTML('beforeend', line);
            }
            win.pendingText = [];
        }
        this.applyScrollClasses(id);
    }

    pushBuffer(id: string, buffer: AnsiAwareBuffer): void {
        if (!this.windows.has(id)) this.open(id, { kind: 'text', title: id });
        const win = this.windows.get(id)!;
        if (win.kind !== 'text') return;
        this.flushLine(id);
        const ctrl = this.controls.get(id);
        if (ctrl) {
            // type='script' lets the renderer finalize a script-partial in-place
            // (instead of leaving an orphan element above the new line).
            ctrl.push(buffer, 'script');
        } else {
            win.pendingText.push(buffer);
            // A completed line supersedes any pending partial that belonged to
            // the same logical line — otherwise registerTextPanel would paint
            // both.
            win.pendingPartial = undefined;
            if (win.pendingText.length > TEXT_BUFFER_LIMIT) {
                win.pendingText.splice(0, win.pendingText.length - TEXT_BUFFER_LIMIT);
            }
        }
    }

    /** Push the current partial-line buffer (script echo without a trailing
     *  newline) so the renderer can paint it in-place via the 'script-partial'
     *  path. Repeated calls update the same DOM element; a subsequent
     *  pushBuffer completes the partial. Pre-mount, the latest partial is
     *  cached on the window and flushed by registerTextPanel. */
    pushPartialBuffer(id: string, buffer: AnsiAwareBuffer): void {
        const win = this.windows.get(id);
        if (!win || win.kind !== 'text') return;
        const ctrl = this.controls.get(id);
        if (ctrl) {
            ctrl.push(buffer, 'script-partial');
        } else {
            win.pendingPartial = buffer;
        }
    }

    registerConsole(id: string, console: Console): void {
        this.consoleRegistry?.set(id, console);
        // Mudlet `sysBufferShrinkEvent(name, linesRemoved)` — fire once per
        // batch of evicted lines so script-side buffers that mirror the
        // console can stay in sync. The main console plumbs its own shrink
        // hook via ScriptingAPI; this covers user-window consoles.
        console.onBufferShrink = (n) => this.onRaiseEvent?.('sysBufferShrinkEvent', [id, n]);
    }

    unregister(id: string): void {
        this.controls.delete(id);
        this.elements.delete(id);
        this.viewports.delete(id);
        this.consoleRegistry?.delete(id);
        this.resizeObservers.get(id)?.disconnect();
        this.resizeObservers.delete(id);
        this.lastEmittedSize.delete(id);
        this.lastEmittedGrid.delete(id);
        this.mouseCleanups.get(id)?.();
        this.mouseCleanups.delete(id);
        this.dropCleanups.get(id)?.();
        this.dropCleanups.delete(id);
    }

    /** Watch `element` for size changes and raise sysUserWindowResizeEvent
     *  whenever its rendered dimensions differ from the last reported pair.
     *  Catches both floating-window user drags and dock splitter drags through
     *  the same DOM-level signal, so script-driven setSize() calls also fire
     *  the event once the layout settles. */
    private observeResize(id: string, element: HTMLElement): void {
        if (typeof ResizeObserver === 'undefined') return;
        this.resizeObservers.get(id)?.disconnect();
        const observer = new ResizeObserver(() => this.measureAndEmitResize(id, element));
        observer.observe(element);
        this.resizeObservers.set(id, observer);
    }

    /** Force an immediate measure-and-emit for the main viewport, if it's
     *  registered. ResizeObserver's own first callback is spec-deferred (never
     *  synchronous with observe()) — registerMainViewport runs from
     *  OutputArea's mount effect, which commits before ScriptingEngine's
     *  constructor exists to wire up onRaiseEvent, so that deferred callback
     *  can easily land *after* Lua bootstrap has already dispatched
     *  sysLoadEvent/sysInstallPackage and run scripts that build
     *  percentage-positioned Geyser containers. GeyserReposition (the bundled
     *  Mudlet Lua that actually resolves that percentage geometry into pixels)
     *  only runs in response to sysWindowResizeEvent, so those containers —
     *  and anything gated on their resolved get_x()/get_width(), e.g.
     *  Adjustable.Container:attachToBorder's validAttachPositions() check —
     *  silently see stale/unresolved geometry and fail with no error. Called
     *  by ScriptingEngine right after it wires up onRaiseEvent (and after the
     *  Lua runtime exists to receive the event — see the guard in
     *  measureAndEmitResize), guaranteeing at least one sysWindowResizeEvent
     *  has already landed before any script-load event fires. The dedup check
     *  inside measureAndEmitResize makes the real (later) ResizeObserver tick
     *  a same-size no-op rather than a duplicate event. */
    primeMainResize(): void {
        if (this.mainViewportEl) this.measureAndEmitResize('main', this.mainViewportEl);
    }

    /** Shared by observeResize's ResizeObserver callback and primeMainResize's
     *  eager call — measures `element`, and raises sysWindowResizeEvent/
     *  sysUserWindowResizeEvent plus the console-grid and overflow events when
     *  the size actually changed since last reported. */
    private measureAndEmitResize(id: string, element: HTMLElement): void {
        const rect = element.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        // Skip the initial 0×0 frame and any spurious zero-size entries
        // that happen during portal moves between dock/floating shells.
        if (w <= 0 && h <= 0) return;
        const last = this.lastEmittedSize.get(id);
        const sizeChanged = !last || last.w !== w || last.h !== h;
        // Only record the size as "reported" once there's actually a listener
        // to deliver it to (onRaiseEvent is wired up by ScriptingEngine, later
        // than viewport registration — see primeMainResize). Recording it
        // unconditionally would make a premature call here permanently
        // suppress the real event once a listener does exist, since the dedup
        // check would see the size as unchanged.
        if (sizeChanged && this.onRaiseEvent) {
            this.lastEmittedSize.set(id, { w, h });
            // Mudlet argument order:
            //   sysWindowResizeEvent(width, height)         — main window
            //   sysUserWindowResizeEvent(width, height, name) — user windows
            // GeyserReposition's user-window branch reads `arg.."Container" == window.name`,
            // so the name must be the third arg, not the first.
            if (id === 'main') this.onRaiseEvent('sysWindowResizeEvent', [w, h]);
            else               this.onRaiseEvent('sysUserWindowResizeEvent', [w, h, id]);
        }
        // Mudlet sysConsoleSizeChanged(name, columns, rows) — fires when
        // the char-grid changes. cols is the wrap setting (falling back to
        // an estimate from element width); rows is derived from element
        // height. Both axes use the rendered monospace cell size so the
        // event values match what scripts can use to lay out output.
        this.emitConsoleGridIfChanged(id, w, h, element);
        // Mudlet sysWindowOverflowEvent(name, overflowLines) — fires when a
        // non-scrolling console pushes content past its visible row count.
        // The DOM exposes this directly via scrollHeight vs clientHeight; a
        // ResizeObserver tick is the cheapest reliable hook.
        this.emitWindowOverflowIfPresent(id, element);
    }

    /** Measure one monospace cell (px) by probing `el` with its own inherited
     *  font — the same technique getColumnCount uses, so the NAWS grid and
     *  getColumnCount agree. Falls back to a fontSize estimate when the probe
     *  can't measure (detached element / happy-dom tests). */
    private measureCharCell(el: HTMLElement): { cellW: number; cellH: number } {
        let cellW = 0, cellH = 0;
        try {
            const cs = getComputedStyle(el);
            const fs = parseFloat(cs.fontSize) || 12;
            const lh = parseFloat(cs.lineHeight);
            cellH = Number.isFinite(lh) && lh > 0 ? lh : fs * 1.4;
            const probe = document.createElement('span');
            probe.textContent = '0'.repeat(100);
            probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit;letter-spacing:inherit;';
            el.appendChild(probe);
            cellW = probe.getBoundingClientRect().width / 100;
            probe.remove();
            if (!(cellW > 0)) cellW = fs * 0.6; // estimate when layout reports 0
        } catch { /* SSR / detached element — keep fallback metrics */ }
        return { cellW: cellW > 0 ? cellW : 8, cellH: cellH > 0 ? cellH : 16 };
    }

    /** Synchronously re-measure the main console's char grid and emit it
     *  (sysConsoleSizeChanged + onMainConsoleResize) so NAWS can seed with the
     *  real on-screen size at connect time, rather than whatever the async
     *  resize observer last reported — which on a fast/mobile connect may be
     *  stale or not yet fired. No-op when the main element isn't mounted, or
     *  when the size is unchanged (the dedup guard in emitConsoleGridIfChanged). */
    remeasureMainGrid(): void {
        const el = this.elements.get('main') ?? this.mainViewportEl;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w <= 0 && h <= 0) return;
        this.emitConsoleGridIfChanged('main', w, h, el);
    }

    /** Compute the rendered char-grid for `id` and emit sysConsoleSizeChanged
     *  when (cols, rows) changes. Metrics are measured against the registered
     *  text element (which carries the MUD output font), not the observed
     *  viewport — the viewport's computed font is the app's base font, so
     *  estimating cells off it reports the wrong column count and, through
     *  onMainConsoleResize → NAWS, hands the server the wrong window width (so
     *  MOTDs / room art don't fit the screen). This matches getColumnCount,
     *  which probes the same element. Falls back to the viewport box when the
     *  text element isn't mounted yet. */
    private emitConsoleGridIfChanged(id: string, w: number, h: number, element: HTMLElement): void {
        const textEl = this.elements.get(id) ?? element;
        const { cellW, cellH } = this.measureCharCell(textEl);
        let usableW = textEl.clientWidth || w;
        let usableH = textEl.clientHeight || h;
        try {
            const cs = getComputedStyle(textEl);
            usableW -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
            usableH -= (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        } catch { /* keep the raw box */ }
        const win = this.windows.get(id);
        const wrap = win?.wrapAt ?? 0;
        const cols = wrap > 0 ? wrap : Math.max(1, Math.floor(Math.max(0, usableW) / cellW));
        const rows = Math.max(1, Math.floor(Math.max(0, usableH) / cellH));
        const last = this.lastEmittedGrid.get(id);
        if (last && last.cols === cols && last.rows === rows) return;
        this.lastEmittedGrid.set(id, { cols, rows });
        this.onRaiseEvent?.('sysConsoleSizeChanged', [id, cols, rows]);
        // Keep NAWS in sync with the main output area's character grid.
        if (id === 'main') this.onMainConsoleResize?.(cols, rows);
    }

    /** Mudlet sysWindowOverflowEvent(name, overflowLines). Fires when a console
     *  whose scrolling is disabled has more content than fits in the viewport.
     *  scrollHeight − clientHeight gives the pixel overflow; dividing by the
     *  estimated line height converts it to lines for the event payload. */
    private emitWindowOverflowIfPresent(id: string, element: HTMLElement): void {
        const scroll = this.scrollState.get(id);
        if (!scroll || scroll.scrollingEnabled) return;
        const overflowPx = element.scrollHeight - element.clientHeight;
        if (overflowPx <= 0) return;
        let cellH = 16;
        try {
            const cs = getComputedStyle(element);
            const fs = parseFloat(cs.fontSize) || 12;
            const lh = parseFloat(cs.lineHeight);
            cellH = Number.isFinite(lh) && lh > 0 ? lh : fs * 1.4;
        } catch { /* keep fallback */ }
        const overflowLines = Math.max(1, Math.ceil(overflowPx / cellH));
        this.onRaiseEvent?.('sysWindowOverflowEvent', [id, overflowLines]);
    }

    /** Raise Mudlet's sysWindowMousePress/ReleaseEvent for clicks anywhere on a
     *  window's box. Args mirror Mudlet: (button, x, y, name) where button is
     *  1=left, 2=right, 3=middle, 4=back, 5=forward (0 = anything else), x/y are
     *  pixel coordinates relative to the window, and name is the window id
     *  ('main' for the central output). */
    private observeMouse(id: string, element: HTMLElement): void {
        this.mouseCleanups.get(id)?.();
        const fire = (event: string) => (e: MouseEvent) => {
            const rect = element.getBoundingClientRect();
            const x = Math.round(e.clientX - rect.left);
            const y = Math.round(e.clientY - rect.top);
            this.onRaiseEvent?.(event, [mouseButtonNumber(e.button), x, y, id]);
        };
        const onDown = fire('sysWindowMousePressEvent');
        const onUp = fire('sysWindowMouseReleaseEvent');
        element.addEventListener('mousedown', onDown);
        element.addEventListener('mouseup', onUp);
        this.mouseCleanups.set(id, () => {
            element.removeEventListener('mousedown', onDown);
            element.removeEventListener('mouseup', onUp);
        });
    }

    /** Mudlet `sysDropEvent(filepath, suffix, x, y, name)` and
     *  `sysDropUrlEvent(url, schema, x, y, name)` — fired when the user drags
     *  a file or URL onto a window. We only acknowledge drops we can identify
     *  (a real File for sysDropEvent, a textual URL for sysDropUrlEvent); the
     *  default DragEvent behaviour is suppressed in both cases so the browser
     *  doesn't navigate away from the page. */
    private observeDrop(id: string, element: HTMLElement): void {
        this.dropCleanups.get(id)?.();
        const onDragOver = (e: DragEvent) => { e.preventDefault(); };
        const onDrop = (e: DragEvent) => {
            const rect = element.getBoundingClientRect();
            const x = Math.round(e.clientX - rect.left);
            const y = Math.round(e.clientY - rect.top);
            const dt = e.dataTransfer;
            if (!dt) return;
            const file = dt.files && dt.files.length > 0 ? dt.files[0] : null;
            if (file) {
                e.preventDefault();
                // Browsers don't expose a filesystem path on a dropped File, so
                // we can't raise sysDropEvent inline — the bundled packageDrop
                // handler would have nothing readable to install. Hand the File
                // to ScriptingEngine, which stages the bytes in the profile VFS
                // and raises sysDropEvent with a path that resolves there.
                this.onFileDrop?.(file, x, y, id);
                return;
            }
            const text = dt.getData('text/uri-list') || dt.getData('text/plain');
            if (text && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text.trim())) {
                e.preventDefault();
                const url = text.trim().split(/\r?\n/)[0];
                const schemaEnd = url.indexOf(':');
                const schema = schemaEnd >= 0 ? url.slice(0, schemaEnd) : '';
                this.onRaiseEvent?.('sysDropUrlEvent', [url, schema, x, y, id]);
            }
        };
        element.addEventListener('dragover', onDragOver);
        element.addEventListener('drop', onDrop);
        this.dropCleanups.set(id, () => {
            element.removeEventListener('dragover', onDragOver);
            element.removeEventListener('drop', onDrop);
        });
    }

    registerMapCallback(id: string, cb: (roomId: number) => void): void {
        this.mapCallbacks.set(id, cb);
    }

    unregisterMapCallback(id: string): void {
        this.mapCallbacks.delete(id);
    }

    centerView(roomId: number): boolean {
        // Mudlet's centerview rejects an unknown room id outright: it returns
        // (nil, errMsg) and does NOT touch mRoomIdHash. Mirror that — bail
        // before setting the player room or notifying the view, so a script
        // centerview()ing a stale/saved id (e.g. on sysLoadEvent before the map
        // covers it) is a clean failure, not a half-applied position.
        if (!this.mapStore.roomExists(roomId)) return false;
        // On success Mudlet sets the player room (mRoomIdHash) as a side effect,
        // so getPlayerRoom() returns this id afterwards.
        this.mapStore.setPlayerRoom(roomId);
        for (const cb of this.mapCallbacks.values()) cb(roomId);
        return true;
    }

    /**
     * Mudlet `T2DMap::initiateSpeedWalk` — start a speedwalk from the player's
     * current room to `targetRoomId`, the room the user double-clicked on the
     * map (or the far side of a double-clicked out-of-area exit).
     *
     * Like Mudlet, an unknown target room is ignored outright, while an unknown
     * *player* room is not: it pathfinds from -1 (Mudlet uses the missing
     * profile entry, 0), finds nothing, and the Lua side reports the mapper's
     * "cannot find a path" message rather than failing silently.
     *
     * Returns false when the gesture didn't start a walk — no such room, or no
     * scripting runtime attached to walk it.
     */
    startSpeedWalk(targetRoomId: number): boolean {
        if (!this.onStartSpeedWalk) return false;
        if (!this.mapStore.roomExists(targetRoomId)) return false;
        this.onStartSpeedWalk(this.mapStore.getPlayerRoom() ?? -1, targetRoomId);
        return true;
    }

    registerMapControl(id: string, ctrl: MapControl): void {
        this.mapControls.set(id, ctrl);
    }

    unregisterMapControl(id: string): void {
        this.mapControls.delete(id);
    }

    /** Live zoom of the displayed 2D map, or null when no map panel is mounted.
     *  mudix shows one area at a time through a single shared renderer, so the
     *  Mudlet `areaID` argument has no per-area analogue here — callers get the
     *  current view's zoom regardless. */
    getMapZoom(): number | null {
        for (const c of this.mapControls.values()) {
            const z = c.getZoom();
            if (z != null) return z;
        }
        return null;
    }

    /** Set the displayed map's zoom and redraw. Returns false when no map panel
     *  is mounted to receive the change. */
    setMapZoom(zoom: number): boolean {
        let applied = false;
        for (const c of this.mapControls.values()) {
            c.setZoom(zoom);
            applied = true;
        }
        return applied;
    }

    /** Force the map to re-read MapStore and redraw (Mudlet `updateMap`). */
    updateMap(): boolean {
        let redrawn = false;
        for (const c of this.mapControls.values()) {
            c.redraw();
            redrawn = true;
        }
        return redrawn;
    }

    // ── Secondary map views (Mudlet createMapView / closeMapView / …) ─────────
    // Mudlet's TMapViewManager hands each view its own floating dock holding a
    // second TMapView, so several areas can be watched at once while the primary
    // mapper follows the player. Here each view is a floating window of kind
    // 'map' plus the per-view state below; MapPanel reads its own view's area
    // through {@link mapViewAreaFor} so the windows don't all show the same one.

    private readonly mapViews = new Map<number, {
        areaId: number; zoom: number; zLevel: number; centeredRoomId: number;
    }>();
    /** View ids start at 1 — Mudlet treats 0 as "no view". */
    private nextMapViewId = 1;

    /** The window id backing a map view. Reserved to the client — see types.ts. */
    private static mapViewWindowId(viewId: number): string { return mapViewWindowId(viewId); }

    /**
     * Mudlet `createMapView([areaID])` — open a secondary map window. Returns
     * the new view id, or a message when the areaID doesn't name an area (0 or
     * omitted means "wherever the player is").
     */
    createMapView(areaId: number): number | string {
        if (areaId > 0 && !this.mapStore.hasArea(areaId)) {
            return `area ${areaId} does not exist`;
        }
        let area = areaId;
        if (area <= 0) {
            const room = this.mapStore.getPlayerRoom() ?? this.mapStore.getFallbackRoomId();
            area = (room != null ? this.mapStore.getRoomArea(room) : undefined) ?? -1;
        }
        const viewId = this.nextMapViewId++;
        this.mapViews.set(viewId, {
            areaId: area,
            zoom: this.mapStore.getAreaZoom(area) ?? MapStore.DEFAULT_MAP_ZOOM,
            zLevel: 0,
            centeredRoomId: this.mapStore.getAreaCenterRoomId(area, 0) ?? 0,
        });
        // Opens floating but stays dockable, matching Mudlet: the view is a real
        // dock widget added to the right dock area and then immediately floated,
        // so the user can drag it into a dock afterwards. `autoDock: false`
        // alone would imply lockFloating, which is right for miniconsoles but
        // would pin these permanently — hence the explicit false.
        this.open(WindowManager.mapViewWindowId(viewId), {
            kind: 'map',
            title: `Map View ${viewId}`,
            autoDock: false,
            lockFloating: false,
            ignoreHint: true,
        });
        return viewId;
    }

    /** Mudlet `closeMapView(viewID)`. False when no view has that id. */
    closeMapView(viewId: number): boolean {
        if (!this.mapViews.delete(viewId)) return false;
        this.close(WindowManager.mapViewWindowId(viewId));
        return true;
    }

    /** Mudlet `closeAllMapViews()` → how many were closed. */
    closeAllMapViews(): number {
        const ids = [...this.mapViews.keys()];
        for (const id of ids) this.closeMapView(id);
        return ids.length;
    }

    /** Mudlet `getMapViewIds()` — every open view, in creation order. */
    getMapViewIds(): number[] { return [...this.mapViews.keys()]; }

    /** Mudlet `getMapViewInfo(viewID)`. Undefined when no view has that id. */
    getMapViewInfo(viewId: number): { areaId: number; zoom: number; zLevel: number; centeredRoomId: number } | undefined {
        const v = this.mapViews.get(viewId);
        return v ? { ...v } : undefined;
    }

    /** The area a map window should show, when it is a secondary view rather
     *  than the primary mapper. Undefined for the primary one, which follows the
     *  player as before. */
    mapViewAreaFor(windowId: string): number | undefined {
        const m = MAP_VIEW_ID_RE.exec(windowId);
        if (!m) return undefined;
        return this.mapViews.get(Number(m[1]))?.areaId;
    }

    /** Record what a mounted secondary view is actually showing, so
     *  getMapViewInfo reports the live state rather than the creation-time one. */
    noteMapViewState(windowId: string, state: { areaId?: number; zoom?: number; zLevel?: number; centeredRoomId?: number }): void {
        const m = MAP_VIEW_ID_RE.exec(windowId);
        if (!m) return;
        const v = this.mapViews.get(Number(m[1]));
        if (!v) return;
        Object.assign(v, state);
    }

    /** Mudlet `exportAreaImage(areaID, filePath[, zLevel])` — render an area to
     *  PNG bytes. Prefers a mounted map widget so the export picks up that
     *  panel's live Mapper settings, but falls back to a standalone render off
     *  the same MapStore: the export never needed a panel (see mapImageExport),
     *  and requiring one would make the API unreachable from a script that runs
     *  before React has mounted the widget. Null when the area is unknown or the
     *  render fails. */
    exportAreaImage(areaId: number, zLevel?: number): Uint8Array | null {
        for (const c of this.mapControls.values()) {
            const bytes = c.exportArea(areaId, zLevel);
            if (bytes) return bytes;
        }
        const mapper = selectProfileField(useAppStore.getState(), this._connectionId, 'mapper');
        return exportAreaImage(this.mapStore, mapper, areaId, zLevel);
    }

    /** Set by MapPanel on mount; cleared on unmount. The callback parses+renders
     *  a buffer (when given) or reloads from IndexedDB (when omitted). */
    registerMapLoadCallback(cb: (buf?: ArrayBuffer) => boolean): void {
        this.mapLoadCallback = cb;
    }

    unregisterMapLoadCallback(): void {
        this.mapLoadCallback = null;
    }

    /**
     * Subscribe to streamed map-load progress. The callback fires on every
     * ingested batch and once with `null` when the load ends (either way), so a
     * progress UI can drive itself entirely off this channel. Fires immediately
     * with the current value on subscribe, so a panel mounting mid-load doesn't
     * have to wait for the next batch to render something.
     */
    subscribeMapLoadProgress(cb: (progress: MapLoadProgress | null) => void): () => void {
        this.mapProgressSubscribers.add(cb);
        cb(this.mapLoadProgress);
        return () => this.mapProgressSubscribers.delete(cb);
    }

    /** Current streamed-load progress, or null when no load is running. */
    getMapLoadProgress(): MapLoadProgress | null {
        return this.mapLoadProgress;
    }

    private publishMapLoadProgress(progress: MapLoadProgress | null): void {
        this.mapLoadProgress = progress;
        for (const cb of this.mapProgressSubscribers) cb(progress);
    }

    setConnectionId(id: string): void {
        this._connectionId = id;
    }

    /**
     * Parse a Mudlet `.dat` buffer and apply it to this session's MapStore.
     * Rooms / areas / hashes / labels / env colours / map-level user data all
     * land in {@link MapStore} via {@link MapStore.loadFromBinary}; the
     * renderer reads it back through the live {@link MudixMapReader}. Throws
     * on parse failure so callers can surface the error (the file-upload path
     * in MapPanel turns it into status='error'; bootstrap logs and moves on).
     */
    ingestMapBuffer(buf: ArrayBuffer): void {
        const mudletMap = readMapFromBuffer(Buffer.from(buf));
        this.mapStore.loadFromBinary(mudletMap);
    }

    /**
     * Async sibling of {@link ingestMapBuffer} that parses in a worker so the
     * main thread stays free for paint. `buf` is transferred — callers that
     * also need the bytes (e.g. IndexedDB persistence) must clone first.
     *
     * The worker streams the map room-by-room and the store folds each batch in
     * as it lands, so neither side ever holds two copies of the room graph.
     * Subscribers see nothing until the load completes (one notification, from
     * `endBinaryLoad`) — a half-populated store would have the renderer draw a
     * map with dangling exits.
     *
     * Batch progress is published on {@link subscribeMapLoadProgress} for the
     * map panel's progress bar; `onProgress` is an extra per-call hook.
     */
    async ingestMapBufferAsync(buf: ArrayBuffer, onProgress?: (loaded: number, total: number) => void): Promise<void> {
        // Rooms land in one notification at the end, so without this the UI has
        // nothing at all to show during the longest part of a big-map load.
        this.publishMapLoadProgress({ loaded: 0, total: 0, phase: 'rooms' });
        let ingested = 0;
        let expected = 0;
        try {
            await streamMapInWorker(buf, {
                onHeader: (header) => this.mapStore.beginBinaryLoad(header),
                onRooms: (rooms) => this.mapStore.ingestBinaryRooms(rooms),
                onProgress: (loaded, total) => {
                    ingested = loaded;
                    expected = total;
                    this.publishMapLoadProgress({ loaded, total, phase: 'rooms' });
                    onProgress?.(loaded, total);
                },
            });
        } catch (err) {
            // A mid-stream failure leaves the store holding a truncated map
            // that was never finalized. Reset to a clean empty map rather than
            // let scripts query half a world.
            this.mapStore.newEmptyMap();
            this.publishMapLoadProgress(null);
            throw err;
        }
        try {
            // Everything below is the renderer's problem, and on a large map it
            // dwarfs the streaming: indexing the map and building the first
            // scene is synchronous and can run for many seconds. Announce the
            // phase and hand the browser a frame to paint it, or the user
            // stares at a bar frozen mid-count with no idea anything is
            // happening.
            this.publishMapLoadProgress({ loaded: ingested, total: expected, phase: 'building' });
            await nextFrame();
            // The store's notify is microtask-coalesced, so endBinaryLoad
            // returns before the panel has rebuilt anything; the heavy work
            // runs in the drain right after. Yielding to a macrotask puts the
            // progress teardown after that work rather than before it.
            this.mapStore.endBinaryLoad();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        } finally {
            this.publishMapLoadProgress(null);
        }
    }

    /**
     * Mudlet parity: a map is available to scripts before `sysLoadEvent` fires.
     * ScriptingEngine awaits this in its start() path so the initial script
     * load runs against an initialized MapStore (and the binary's hashes + user
     * data when one is persisted). Idempotent — the first caller kicks off the
     * IndexedDB fetch, everyone else awaits the same promise. Returns true
     * when a persisted map was successfully ingested.
     */
    async bootstrapMap(): Promise<boolean> {
        if (this.mapBootstrapInflight) return this.mapBootstrapInflight;
        this.mapBootstrapInflight = (async () => {
            // Mudlet starts the session with an initialized (possibly empty)
            // map — calling newEmptyMap() flips isInitialized() so scripts can
            // start adding rooms without first calling it themselves.
            this.mapStore.newEmptyMap();
            if (!this._connectionId) return false;
            try {
                const buf = await loadMapFromStorage(this._connectionId);
                if (!buf) return false;
                // Off-main-thread parse — the boot path is what dominates LCP,
                // and the binary reader's Buffer-polyfill loop is the single
                // biggest synchronous cost when a saved map is large.
                await this.ingestMapBufferAsync(buf);
                return true;
            } catch (err) {
                console.warn('[WindowManager] bootstrapMap failed:', err);
                return false;
            }
        })();
        return this.mapBootstrapInflight;
    }

    /**
     * Mudlet `loadMap([location])`. With a buffer the bytes are persisted to
     * IndexedDB (so the map survives panel close/reopen and reload), parsed
     * into the manager/store, and any open MapPanel is asked to re-render.
     * Without a buffer the panel is told to reload from cache. Returns false
     * on synchronous parse failure; the IndexedDB write is fire-and-forget
     * (failures appear in console.warn). Fires sysMapLoadEvent on success.
     */
    loadMap(buf?: ArrayBuffer): boolean {
        if (buf && this._connectionId) {
            // Clone for IndexedDB: the parser (qtdatastream's QString.read)
            // mutates the buffer in-place via Buffer.swap16() to convert
            // UTF-16 BE → LE for toString('ucs2'). saveMap awaits openDb()
            // before put() does its structured clone, but the synchronous
            // ingest below runs first — so without a copy IDB persists
            // parser-mutated bytes, and the next mount loads them and
            // double-swaps QString regions into CJK garbage.
            saveMapToStorage(this._connectionId, buf.slice(0)).catch(err =>
                console.warn('[WindowManager] saveMap failed:', err));
            try {
                this.ingestMapBuffer(buf);
            } catch (err) {
                console.warn('[WindowManager] loadMap parse failed:', err);
                return false;
            }
        }
        // The panel callback is advisory — its return value reports render
        // success, but sysMapLoadEvent fires on successful data ingest so
        // headless scripts (no MapPanel open) still receive the event.
        this.mapLoadCallback?.(buf);
        if (buf) this.onRaiseEvent?.('sysMapLoadEvent', []);
        return true;
    }

    /**
     * Async sibling of {@link loadMap} with identical effects — IndexedDB
     * persistence, store ingest, panel re-render, `sysMapLoadEvent` — but the
     * parse runs in the worker and streams into the store, publishing progress
     * as it goes.
     *
     * Use this for every UI-driven load (file picker, map download, editor
     * hand-back): the synchronous {@link loadMap} blocks the main thread for the
     * whole parse, which on a large map means a frozen window and a progress bar
     * that could never paint. `loadMap` stays for Lua's synchronous
     * `loadMap()` contract.
     *
     * `buf` is transferred to the worker and must not be reused by the caller.
     */
    async loadMapAsync(buf: ArrayBuffer): Promise<boolean> {
        if (this._connectionId) {
            // Persist a copy before the original is transferred away. (The
            // sync path clones for a different reason — see loadMap — but the
            // upshot is the same: IDB must get untouched bytes.)
            saveMapToStorage(this._connectionId, buf.slice(0)).catch(err =>
                console.warn('[WindowManager] saveMap failed:', err));
        }
        try {
            await this.ingestMapBufferAsync(buf);
        } catch (err) {
            console.warn('[WindowManager] loadMapAsync parse failed:', err);
            return false;
        }
        // Same advisory contract as loadMap: the panel reports render success,
        // but the event fires on successful ingest so headless scripts still
        // see it. The buffer is detached by now, so the callback is invoked
        // without it — every consumer re-reads through the store anyway.
        this.mapLoadCallback?.();
        this.onRaiseEvent?.('sysMapLoadEvent', []);
        return true;
    }

    /**
     * Mudlet `saveMap([location])`. Serialises the in-memory MapStore to the
     * Mudlet binary `.dat` format and persists it to this connection's
     * IndexedDB slot — the equivalent of Mudlet's default profile map path,
     * picked up by {@link bootstrapMap} on next session start. Returns the
     * serialised bytes so the Lua binding can also write them to a VFS path
     * when the caller supplies one. Returns null when there is no connection
     * or serialisation fails.
     */
    saveMap(): ArrayBuffer | null {
        let bytes: ArrayBuffer;
        try {
            const buf = writeMapToBuffer(this.mapStore.toMudletMapForSave());
            // Copy into a freshly-allocated standalone ArrayBuffer — the
            // returned Buffer is a view onto a Node Buffer pool (and at the
            // type level its .buffer may be SharedArrayBuffer), neither of
            // which the binary reader or IDB persistence can handle directly.
            const out = new ArrayBuffer(buf.byteLength);
            new Uint8Array(out).set(buf);
            bytes = out;
        } catch (err) {
            console.warn('[WindowManager] saveMap serialisation failed:', err);
            return null;
        }
        if (this._connectionId) {
            // Same swap16 hazard as loadMap: the binary reader mutates buffers
            // in-place when parsing QStrings. Cloning before IDB persistence
            // keeps the bytes we return safe if anything later round-trips them
            // through readMapFromBuffer.
            saveMapToStorage(this._connectionId, bytes.slice(0)).catch(err =>
                console.warn('[WindowManager] saveMap persist failed:', err));
        }
        return bytes;
    }

    /**
     * Background counterpart to {@link saveMap}: serialise the map to the binary
     * format in a worker (so the encode never blocks the main thread) and persist
     * it to this connection's IndexedDB slot. Used for automatic saves — notably
     * to persist the per-area zoom held in the map's area userData — so they can
     * run frequently without jank. Returns true on success.
     */
    async saveMapAsync(): Promise<boolean> {
        const connId = this._connectionId;
        if (!connId || this.mapStore.isEmpty()) return false;
        this.mapSavePending = false;
        try {
            // toMudletMapForSave() is a cheap Map→object copy on the main thread;
            // the expensive binary encode happens off-thread in the worker.
            const bytes = await serializeMapInWorker(this.mapStore.toMudletMapForSave());
            await saveMapToStorage(connId, bytes);
            return true;
        } catch (err) {
            console.warn('[WindowManager] saveMapAsync failed:', err);
            return false;
        }
    }

    /**
     * Request a debounced background map save. Multiple calls within `delayMs`
     * collapse into a single {@link saveMapAsync}. Used by the map panel when the
     * per-area zoom changes so the view is persisted shortly after the user stops
     * adjusting it, without serialising on every wheel tick.
     */
    scheduleMapSave(delayMs = 2000): void {
        if (!this._connectionId) return;
        this.mapSavePending = true;
        if (this.mapSaveTimer) clearTimeout(this.mapSaveTimer);
        this.mapSaveTimer = setTimeout(() => {
            this.mapSaveTimer = null;
            void this.saveMapAsync();
        }, delayMs);
    }

    /**
     * Drain a pending debounced save immediately — called on session close so a
     * zoom change made just before disconnecting/switching profiles isn't lost.
     * The write is still async (worker + IndexedDB); on an in-app close it
     * completes because the worker and IDB outlive the session instance.
     */
    flushMapSave(): void {
        if (this.mapSaveTimer) { clearTimeout(this.mapSaveTimer); this.mapSaveTimer = null; }
        if (this.mapSavePending) void this.saveMapAsync();
    }

    /**
     * Mudlet `saveJsonMap(path)` backbone — serialise the current MapStore
     * to a JSON string. Used by the Lua binding, which writes the result to
     * the VFS path the script provided.
     */
    saveJsonMap(): string { return this.mapStore.toJsonString(); }

    /**
     * Mudlet `loadJsonMap(path)` backbone — parse a JSON payload previously
     * produced by `saveJsonMap` and replace MapStore's contents, then ask any
     * open map panel to re-render. Returns false on parse failure or when the
     * JSON doesn't carry the expected MudletMap shape.
     */
    loadJsonMap(json: string): boolean {
        if (!this.mapStore.loadFromJsonString(json)) return false;
        this.mapLoadCallback?.();
        this.onRaiseEvent?.('sysMapLoadEvent', []);
        return true;
    }

    /**
     * Import an IRE-style XML map (Mudlet TConsole::importMap →
     * XMLimport::readMap) — the format `loadMap("...xml")` and MMP map
     * downloads deliver. Replaces the MapStore contents, persists in the
     * canonical binary form so the next session bootstraps it from IndexedDB,
     * and asks any open MapPanel to re-render. Returns false when the text is
     * not a well-formed XML map.
     */
    loadMapXml(xmlText: string): boolean {
        const map = parseXmlMap(xmlText);
        if (!map) return false;
        this.mapStore.loadFromBinary(map);
        this.scheduleMapSave(0);
        this.mapLoadCallback?.();
        this.onRaiseEvent?.('sysMapLoadEvent', []);
        return true;
    }

    markAsMiniConsole(id: string): void {
        const win = this.windows.get(id);
        if (!win) return;
        // Idempotence guard: createMiniConsole/createMapper are singleton-
        // reposition calls that re-invoke this on every Geyser reflow cycle
        // (GeyserReposition() cascades from essentially any widget add/move
        // anywhere in the UI, so this can fire dozens of times a second).
        // Without the guard, the touch below fired every single time,
        // keeping this window permanently at the freshest possible z-order
        // touch — outranking every sibling label/container no matter how
        // recently *they* were actually raised (e.g. a map/EMCO console
        // staying on top of a just-dragged-to-front Adjustable.Container).
        if (this.miniConsoles.has(id)) return;
        this.miniConsoles.add(id);
        // A freshly-marked mini-console (createMiniConsole/createMapper without
        // an explicit parent) nests under the main viewport for the first time
        // here — open() ran before this call could see isMiniConsole()==true,
        // so the initial overlayParentId() resolution missed it.
        this.touchOverlayWindows(win);
    }

    isMiniConsole(id: string): boolean {
        return this.miniConsoles.has(id);
    }

    // ── MXP frame chrome ──────────────────────────────────────────────────────

    /** Flag a console as an MXP frame so it renders with a frame border. Also
     *  hides its scrollbar: Mudlet's frames are `TConsole::SubConsole`s, which
     *  start with theirs hidden, and no MXP server ever calls enableScrollBar.
     *  Idempotent — the layout re-places a frame on every reflow. */
    markAsMxpFrame(id: string): void {
        if (this.mxpFrameIds.has(id)) return;
        this.mxpFrameIds.add(id);
        this.setScrollBarVisible(id, false);
        this.notify();
    }

    /** Install (or replace) an MXP frame's tab strip. An empty `pages` list
     *  removes it. Pages other than the active one are hidden, which keeps their
     *  panel mounted — the content pool renders every open window regardless of
     *  visibility, so a background tab keeps its scrollback. */
    setFrameTabs(id: string, pages: MxpTabPage[], active: string): void {
        if (pages.length === 0) {
            if (!this.frameTabs.delete(id)) return;
            this.notify();
            return;
        }
        this.frameTabs.set(id, { pages, active });
        for (const page of pages) {
            if (page.id === id) continue; // the host frame's own console is always mounted
            if (page.id === active) this.show(page.id);
            else                    this.hide(page.id);
        }
        this.notify();
    }

    /** Switch an MXP frame's visible tab. Ignored for an unknown strip or page. */
    selectFrameTab(id: string, pageId: string): void {
        const strip = this.frameTabs.get(id);
        if (!strip || strip.active === pageId) return;
        if (!strip.pages.some(p => p.id === pageId)) return;
        this.setFrameTabs(id, strip.pages, pageId);
    }

    getFrameTabs(id: string): { pages: MxpTabPage[]; active: string } | undefined {
        return this.frameTabs.get(id);
    }

    /** Pixel insets MXP frames have carved out of the main console. Kept apart
     *  from the profile's setBorder* sizes (Mudlet splits them the same way, as
     *  Host::mUserBorders vs mMxpBorders) so a server layout never overwrites
     *  what a script or the settings modal set — OutputArea adds the two. */
    getMxpBorders(): { top: number; right: number; bottom: number; left: number } {
        return { ...this.mxpBorders };
    }

    setMxpBorders(borders: { top: number; right: number; bottom: number; left: number }): void {
        const cur = this.mxpBorders;
        if (cur.top === borders.top && cur.right === borders.right
            && cur.bottom === borders.bottom && cur.left === borders.left) return;
        this.mxpBorders = { ...borders };
        this.notify();
    }

    getRoomIDbyHash(hash: string): number | undefined {
        return this.mapStore.getRoomIDbyHash(hash);
    }

    // ── Floating window drag / resize ─────────────────────────────────────────

    setPosition(id: string, x: number, y: number): void {
        const win = this.windows.get(id);
        if (!win) return;
        win.x = x;
        win.y = y;
        this.notify();
        this.saveHint(id, win);
    }

    /** Mudlet setWindow for miniconsole / mapper panels — re-portal the panel
     *  into another window's viewport; `undefined` re-attaches it to the main
     *  viewport. Parent is runtime-only state (deliberately not part of the
     *  saved hint): scripts re-establish it on every load, matching Mudlet. */
    setParent(id: string, parent?: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        if (win.parent !== parent) {
            win.parent = parent;
            this.touchOverlayWindows(win);
            this.notify();
        }
        return true;
    }

    /** Mudlet setFontSize for a userwindow / miniconsole. Returns false if the
     *  window doesn't exist. Mudlet clamps font size between 1 and 99. */
    setFontSize(id: string, size: number): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        if (!Number.isFinite(size) || size < 1 || size > 99) return false;
        win.fontSize = Math.round(size);
        this.notify();
        this.saveHint(id, win);
        return true;
    }

    getFontSize(id: string): number | null {
        const win = this.windows.get(id);
        return win?.fontSize ?? null;
    }

    /** Mudlet setFont for a userwindow / miniconsole. Empty string clears the
     *  override and lets the inherited font take over. */
    setFont(id: string, family: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        win.fontFamily = family && family.trim() ? family : undefined;
        this.notify();
        this.saveHint(id, win);
        return true;
    }

    getFont(id: string): string | null {
        const win = this.windows.get(id);
        return win?.fontFamily ?? null;
    }

    /** Pin a console's rendered row height, in px. Consoles normally lay rows
     *  out at the stylesheet's `line-height`, which is roomier than the type
     *  itself; an MXP frame instead has to match Mudlet's row metric
     *  (`TTextEdit::mFontHeight` = ascent + descent), because its whole geometry
     *  contract is "this many rows fit in this box". Undefined restores the
     *  stylesheet default. */
    setLineHeight(id: string, px: number | undefined): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        win.lineHeight = px !== undefined && Number.isFinite(px) && px > 0 ? px : undefined;
        this.notify();
        return true;
    }

    /** Pin a console back to the first line. Consoles are scrollbacks and follow
     *  the tail, which is wrong for a pane the server rewrites wholesale: such a
     *  redraw arrives over several network flushes, so following the tail makes
     *  the content visibly slide as the rows land, then snap back on the next
     *  clear. No-op before the panel mounts. */
    scrollToTop(id: string): void {
        const el = this.elements.get(id);
        if (el) el.scrollTop = 0;
    }

    /** Consoles pinned to their first row rather than following the tail. See
     *  scrollToTop; TextPanel reads this live through the renderer's followTail. */
    private readonly topAnchored = new Set<string>();

    setTopAnchored(id: string, anchored: boolean): void {
        if (anchored) this.topAnchored.add(id);
        else this.topAnchored.delete(id);
    }

    isTopAnchored(id: string): boolean {
        return this.topAnchored.has(id);
    }

    /** Mudlet setWindowWrap. 0 (or any non-positive value) clears the override. */
    setWrap(id: string, wrapAt: number): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        if (!Number.isFinite(wrapAt)) return false;
        const v = Math.round(wrapAt);
        win.wrapAt = v > 0 ? v : undefined;
        this.notify();
        this.saveHint(id, win);
        // Wrap column = columns axis of the char grid; force-fire
        // sysConsoleSizeChanged so scripts notice the change without waiting
        // for a viewport resize.
        const el = this.elements.get(id) ?? this.viewports.get(id);
        const size = this.lastEmittedSize.get(id);
        if (el && size) this.emitConsoleGridIfChanged(id, size.w, size.h, el);
        return true;
    }

    getWrap(id: string): number | null {
        const win = this.windows.get(id);
        return win?.wrapAt ?? null;
    }

    /** Companions to {@link getWrap} for the two indents — read by wrapLine,
     *  which has to re-wrap to the same shape the renderer would. */
    getWrapIndent(id: string): number {
        return this.windows.get(id)?.wrapIndent ?? 0;
    }

    getWrapHangingIndent(id: string): number {
        return this.windows.get(id)?.wrapHangingIndent ?? 0;
    }

    /** Mudlet setWindowWrapIndent — indent (in characters) of newline-started
     *  lines. 0 (or negative) clears the override. */
    setWrapIndent(id: string, indent: number): boolean {
        const win = this.windows.get(id);
        if (!win || !Number.isFinite(indent)) return false;
        const v = Math.round(indent);
        win.wrapIndent = v > 0 ? v : undefined;
        this.notify();
        this.saveHint(id, win);
        return true;
    }

    /** Mudlet setWindowWrapHangingIndent — indent (in characters) of wrapped
     *  continuation lines. 0 (or negative) clears the override. */
    setWrapHangingIndent(id: string, indent: number): boolean {
        const win = this.windows.get(id);
        if (!win || !Number.isFinite(indent)) return false;
        const v = Math.round(indent);
        win.wrapHangingIndent = v > 0 ? v : undefined;
        this.notify();
        this.saveHint(id, win);
        return true;
    }

    // ── Scrollbar / scrolling ─────────────────────────────────────────────────

    /** Mudlet enable/disableScrollBar — toggle the vertical scrollbar's visibility
     *  on a console wrapper. Wheel/keyboard scrolling continues regardless; only
     *  the gutter rendering is affected. Persists across mounts; idempotent. */
    setScrollBarVisible(id: string, visible: boolean): void {
        this.getScrollStateMut(id).scrollBarVisible = visible;
        this.applyScrollClasses(id);
    }

    /**
     * Mudlet `getScrollBarVisible([window])`. Reads back the *intent* set by
     * enable/disableScrollBar rather than whether a gutter is on screen right
     * now: a console that is hidden still answers for the scroll bar it will
     * have when shown. Only the main window starts with one — a miniconsole is
     * created without, as in Mudlet.
     */
    scrollBarVisible(id: string): boolean {
        const s = this.scrollState.get(id);
        if (s) return s.scrollBarVisible;
        return id === 'main';
    }

    /** Mudlet enable/disableHorizontalScrollBar — toggle a horizontal scrollbar
     *  on a console wrapper. mudix wraps long lines by default so this is rarely
     *  needed; included for parity. */
    setHorizontalScrollBarVisible(id: string, visible: boolean): void {
        this.getScrollStateMut(id).horizontalScrollBarVisible = visible;
        this.applyScrollClasses(id);
    }

    /** Mudlet enable/disableScrolling — when disabled, the wrapper sticks to the
     *  bottom (wheel/touch/keys cannot scroll back). Mudlet forbids this on the
     *  main window; we follow that policy. Returns false on 'main', true otherwise. */
    setScrollingEnabled(id: string, enabled: boolean): boolean {
        if (id === 'main') return false;
        this.getScrollStateMut(id).scrollingEnabled = enabled;
        this.applyScrollClasses(id);
        return true;
    }

    /**
     * Mudlet `timeStampsEnabled(window)` — whether the console is showing its
     * timestamp column. Null when the window has no renderer registered, which
     * is how the Lua wrapper tells a missing window from one that simply has
     * timestamps off. Pre-mount, a queued preference wins over the default.
     */
    timeStampsEnabled(id: string): boolean | null {
        const queued = this.pendingTimestamps.get(id);
        if (queued !== undefined) return queued;
        const ctrl = this.controls.get(id);
        if (ctrl) return ctrl.areTimestampsVisible();
        // A console whose panel hasn't mounted yet still exists and still has
        // an answer — timestamps start off. Only a name that belongs to no
        // window at all is unanswerable, which is what null means here.
        if (id === 'main' || this.windows.has(id)) return false;
        return null;
    }

    /**
     * Mudlet `enable/disableTimeStamps(window)`. The renderer owns the column,
     * but a script can ask for it before the panel has mounted — openUserWindow
     * followed immediately by enableTimeStamps — so the preference is queued and
     * applied by registerTextPanel. False when the window doesn't exist at all.
     */
    setTimeStamps(id: string, visible: boolean): boolean {
        const ctrl = this.controls.get(id);
        if (ctrl) {
            ctrl.setTimestampVisibility(visible);
            this.pendingTimestamps.delete(id);
            return true;
        }
        if (!this.windows.has(id)) return false;
        this.pendingTimestamps.set(id, visible);
        return true;
    }

    /** Timestamp preference asked for before the panel mounted. */
    private readonly pendingTimestamps = new Map<string, boolean>();

    /** Mudlet `scrollingActive(window)` — whether scrollback is currently
     *  allowed. Always true for `'main'`, which setScrollingEnabled refuses to
     *  change, and true for any console nobody has called disableScrolling on. */
    isScrollingEnabled(id: string): boolean {
        if (id === 'main') return true;
        return this.scrollState.get(id)?.scrollingEnabled ?? DEFAULT_SCROLL_STATE.scrollingEnabled;
    }

    /** Buffer-line index of the topmost visible line in `id`'s wrapper. In tail
     *  mode returns the last line number (matching Mudlet's mCursorY behaviour at
     *  the end of the buffer). Returns 0 if the element is unmounted or empty.
     *
     *  Uses getBoundingClientRect rather than offsetTop because `.output-container`
     *  is `position: relative` — child offsetTop is relative to *that*, not to the
     *  scroll-container `.output-wrapper`, so the rectangles are the unambiguous
     *  way to relate child position to the scroll viewport. */
    /** Whether `id`'s wrapper is mounted with laid-out lines, i.e. whether
     *  {@link getScrollLine}'s measurement means anything. A console whose panel
     *  isn't on screen yet measures as 0, which is indistinguishable from being
     *  genuinely scrolled to the top. */
    canMeasureScroll(id: string): boolean {
        // A scripted scrollTo is an answer in its own right, laid-out panel or
        // not — see scriptScrollLine.
        if (this.scriptScrollLine.has(id)) return true;
        const el = this.elements.get(id);
        return !!el && this.lineElements(el).length > 0;
    }

    /**
     * Where `scrollTo` last parked each console, as a buffer line index; absent
     * means tail mode (or that only the user has scrolled it).
     *
     * Mudlet's getScroll/scrollTo are buffer-index operations. mudix measured
     * the DOM instead, which is fine for a console the player is looking at but
     * answers nothing useful for one whose panel has not been laid out yet — and
     * a script that scrolls and reads back in the same breath never gives React
     * a chance to commit in between. So the scripted position is remembered here
     * and the measurement is the fallback, not the source of truth.
     */
    private readonly scriptScrollLine = new Map<string, number>();

    /** Called when the *user* scrolls a console, so a script's remembered
     *  position stops overriding what they can see. */
    noteUserScroll(id: string): void {
        this.scriptScrollLine.delete(id);
    }

    getScrollLine(id: string): number {
        const parked = this.scriptScrollLine.get(id);
        if (parked !== undefined) return parked;
        const el = this.elements.get(id);
        if (!el) return 0;
        const lineEls = this.lineElements(el);
        const total = lineEls.length;
        if (total === 0) return 0;
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distFromBottom <= 1) return total - 1;
        const containerTop = el.getBoundingClientRect().top;
        for (let i = 0; i < total; i++) {
            const rect = lineEls[i].getBoundingClientRect();
            // First line whose bottom edge sits inside the viewport — that's the
            // topmost partly-visible line. -1 tolerates sub-pixel rounding.
            if (rect.bottom > containerTop + 1) return i;
        }
        return total - 1;
    }

    /** Scroll `id`'s wrapper so `line` (0-indexed) sits at the top. `undefined`
     *  resumes tail mode (scroll-to-bottom); negative values count from the end
     *  (Mudlet semantics). Returns false if the wrapper is not mounted. */
    scrollToLine(id: string, line: number | undefined): boolean {
        // Line counts come from the buffer, not the DOM: the console may have
        // 200 lines and no laid-out panel to measure them in.
        const total = this.consoleRegistry?.get(id)?.getLineCount() ?? -1;
        const lineCount = total >= 0 ? total + 1 : 0;
        const el = this.elements.get(id);
        if (!el && lineCount === 0) return false;

        if (line === undefined) {
            // Tail mode: forget the parked line so the measurement takes over.
            this.scriptScrollLine.delete(id);
            if (el) el.scrollTop = el.scrollHeight;
            return true;
        }
        let target = line;
        if (target < 0) target = Math.max(lineCount + target, 0);
        // Clamped to the last line index, which counts the always-open line the
        // buffer keeps past the finished ones (as getLastLineNumber does).
        target = Math.max(0, Math.min(target, lineCount));
        this.scriptScrollLine.set(id, target);

        const lineEls = el ? this.lineElements(el) : [];
        if (!el || lineEls.length === 0) return true;
        if (target >= lineEls.length - 1) {
            el.scrollTop = el.scrollHeight;
            return true;
        }
        if (target <= 0) {
            el.scrollTop = 0;
            return true;
        }
        // Bounding-rect math: convert the line's viewport-relative top into a
        // scroll position within the wrapper. offsetTop is relative to the
        // nearest positioned ancestor (`.output-container`), not to the scroll
        // container, so we can't read it directly.
        const containerRect = el.getBoundingClientRect();
        const lineRect = lineEls[target].getBoundingClientRect();
        el.scrollTop = Math.max(0, lineRect.top - containerRect.top + el.scrollTop);
        return true;
    }

    private getScrollStateMut(id: string): ScrollState {
        let s = this.scrollState.get(id);
        if (!s) {
            s = { ...DEFAULT_SCROLL_STATE };
            this.scrollState.set(id, s);
        }
        return s;
    }

    private applyScrollClasses(id: string): void {
        const el = this.elements.get(id);
        if (!el) return;
        const s = this.scrollState.get(id) ?? DEFAULT_SCROLL_STATE;
        el.classList.toggle('mudix-no-scrollbar', !s.scrollBarVisible);
        el.classList.toggle('mudix-h-scrollbar', s.horizontalScrollBarVisible);
        el.classList.toggle('mudix-no-scrolling', !s.scrollingEnabled);
    }

    /** Direct line-element children of the wrapper (skips the sticky-output
     *  sentinel, which sits at the end with height: 0). */
    private lineElements(el: HTMLElement): HTMLElement[] {
        const out: HTMLElement[] = [];
        for (const child of Array.from(el.children) as HTMLElement[]) {
            if (child.classList.contains('output-msg')) out.push(child);
        }
        return out;
    }

    /** Mudlet setBackgroundColor for a userwindow / miniconsole. */
    setBackgroundColor(id: string, r: number, g: number, b: number, a = 255): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        win.backgroundColor = { r, g, b, a };
        this.notify();
        this.saveHint(id, win);
        return true;
    }

    getBackgroundColor(id: string): { r: number; g: number; b: number; a: number } | null {
        const win = this.windows.get(id);
        return win?.backgroundColor ?? null;
    }

    /** Mudlet setBackgroundImage for a userwindow / miniconsole. */
    setBackgroundImage(id: string, url: string, mode: number): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        win.backgroundImage = { url, mode };
        this.notify();
        this.saveHint(id, win);
        return true;
    }

    /** Mudlet resetBackgroundImage for a userwindow / miniconsole. */
    resetBackgroundImage(id: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        win.backgroundImage = undefined;
        this.notify();
        this.saveHint(id, win);
        return true;
    }

    setSize(id: string, width: number, height: number): void {
        const win = this.windows.get(id);
        if (!win) return;
        // Miniconsoles bypass the floating-window minimums — the script picks
        // the exact pixel size, including small/zero dimensions.
        if (this.miniConsoles.has(id)) {
            win.width  = Math.max(0, width);
            win.height = Math.max(0, height);
        } else {
            win.width  = Math.max(150, width);
            win.height = Math.max(80, height);
        }
        this.notify();
        this.saveHint(id, win);
    }

    // ── Per-window command line ───────────────────────────────────────────────

    /** Mudlet enableCommandLine(name). Idempotent. Returns false when the
     *  window doesn't exist. */
    enableCommandLine(id: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        if (!this.cmdLineState.has(id)) this.cmdLineState.set(id, { action: null });
        if (win.cmdLineEnabled) return true;
        win.cmdLineEnabled = true;
        this.notify();
        return true;
    }

    /** Mudlet disableCommandLine(name). Idempotent. Returns false when the
     *  window doesn't exist. The action callback is kept so re-enabling
     *  resumes the same binding (matches Mudlet's behaviour). */
    disableCommandLine(id: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        if (!win.cmdLineEnabled) return true;
        win.cmdLineEnabled = false;
        this.notify();
        return true;
    }

    /** Mudlet setCmdLineStyleSheet(name, qss). Stored as raw QSS; the panel
     *  translates it through cmdLineQssToScopedCss at render time. Returns
     *  false when the window doesn't exist. */
    setCmdLineStyleSheet(id: string, qss: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        win.cmdLineStyleSheet = qss && qss.trim() ? qss : undefined;
        this.notify();
        return true;
    }

    /**
     * Mudlet setCommandForegroundColor / setCommandBackgroundColor for a named
     * window. Mudlet styles a per-window command line through QSS, so the colour
     * is patched into the same `cmdLineStyleSheet` a script could have set by
     * hand rather than kept as a parallel piece of state. False when the window
     * doesn't exist.
     */
    setCmdLineColor(id: string, property: 'color' | 'background-color',
                    r: number, g: number, b: number, a: number): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        const decl = `${property}: rgba(${r}, ${g}, ${b}, ${a});`;
        const current = win.cmdLineStyleSheet ?? '';
        // Anchored so "background-color" can't be hit when patching "color".
        const existing = new RegExp(`(^|[;\\s])${property}\\s*:[^;]*;`, 'g');
        win.cmdLineStyleSheet = existing.test(current)
            ? current.replace(existing, (_m, lead: string) => `${lead}${decl}`)
            : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${decl}`;
        this.notify();
        return true;
    }

    /** Bind the Lua callback fired when the user presses Enter in this
     *  window's command line. Pass null to clear. Returns false when the
     *  window doesn't exist. */
    setCmdLineAction(id: string, cb: ((text: string) => void) | null): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        const state = this.cmdLineState.get(id) ?? { action: null };
        state.action = cb;
        this.cmdLineState.set(id, state);
        return true;
    }

    /** Whether a script has bound a per-window Enter handler. */
    hasCmdLineAction(id: string): boolean {
        return !!this.cmdLineState.get(id)?.action;
    }

    /** Read the bound callback (or null). The TextPanel input invokes this
     *  directly on Enter so the React tree never sees the function. */
    getCmdLineAction(id: string): ((text: string) => void) | null {
        return this.cmdLineState.get(id)?.action ?? null;
    }

    /** Mudlet clearCmdLine([name]) when name is a userwindow — wipes the
     *  input contents. The seq bump forces React to apply the seed even
     *  when the value didn't change. Returns false when the window doesn't
     *  exist or has no command line. */
    clearWindowCmdLine(id: string): boolean {
        const win = this.windows.get(id);
        if (!win || !win.cmdLineEnabled) return false;
        win.cmdLineValue = '';
        win.cmdLineValueSeq = (win.cmdLineValueSeq ?? 0) + 1;
        this.notify();
        return true;
    }

    /** Mudlet printCmdLine([name], text) when name is a userwindow — replaces
     *  the input contents and moves the caret to the end (React side). */
    printWindowCmdLine(id: string, text: string): boolean {
        const win = this.windows.get(id);
        if (!win || !win.cmdLineEnabled) return false;
        win.cmdLineValue = String(text ?? '');
        win.cmdLineValueSeq = (win.cmdLineValueSeq ?? 0) + 1;
        this.notify();
        return true;
    }

    /** Mudlet appendCmdLine([name], text) when name is a userwindow — pushes
     *  `text` onto the end of the current contents. */
    appendWindowCmdLine(id: string, text: string): boolean {
        const win = this.windows.get(id);
        if (!win || !win.cmdLineEnabled) return false;
        win.cmdLineValue = String(win.cmdLineValue ?? '') + String(text ?? '');
        win.cmdLineValueSeq = (win.cmdLineValueSeq ?? 0) + 1;
        this.notify();
        return true;
    }

    /** Used by ScriptingAPI.getCmdLine([name]) when the name targets a window;
     *  returns the cached value last seeded. The actual live input value is
     *  reported by the TextPanel through a register callback (see
     *  registerCmdLineValueProbe). */
    private cmdLineValueProbes = new Map<string, () => string>();
    registerCmdLineValueProbe(id: string, probe: () => string): () => void {
        this.cmdLineValueProbes.set(id, probe);
        return () => {
            if (this.cmdLineValueProbes.get(id) === probe) this.cmdLineValueProbes.delete(id);
        };
    }
    getCmdLineValue(id: string): string {
        const probe = this.cmdLineValueProbes.get(id);
        if (probe) return probe();
        return this.windows.get(id)?.cmdLineValue ?? '';
    }

    bringToFront(id: string): void {
        const win = this.windows.get(id);
        if (!win) return;
        win.zIndex = ++this.nextZ;
        this.touchOverlayWindows(win);
        this.notify();
    }

    /** Mudlet lowerWindow for a userwindow — drop below every other floating
     *  window. Computes a fresh below-min zIndex so successive lowerWindow
     *  calls maintain relative order. */
    sendToBack(id: string): void {
        const win = this.windows.get(id);
        if (!win) return;
        let min = Infinity;
        for (const w of this.windows.values()) if (w.id !== id && w.zIndex < min) min = w.zIndex;
        win.zIndex = (Number.isFinite(min) ? min : 10) - 1;
        this.sinkOverlayWindows(win);
        this.notify();
    }

    // ── Dock management ───────────────────────────────────────────────────────

    dock(id: string, side: DockSide, slotIndex?: number): void {
        const win = this.windows.get(id);
        if (!win) return;
        if (win.dockGroup)  this.removeFromGroup(id);
        if (win.splitGroup) this.removeFromSplitGroup(id);
        const existing = [...this.windows.values()]
            .filter(w => w.docked === side)
            .sort((a, b) => (a.dockOrder ?? 0) - (b.dockOrder ?? 0));
        // Unique dockOrder values represent logical slots (all members of a tab/split
        // group share one dockOrder). Translate the visual slot index to a dockOrder
        // value so that sparse dockOrders (from previous undock/redock cycles) don't
        // cause the panel to land at the wrong position.
        const slotOrders = [...new Set(existing.map(w => w.dockOrder ?? 0))];
        let insertAt: number;
        if (slotIndex === undefined || slotIndex >= slotOrders.length) {
            insertAt = slotOrders.length > 0 ? slotOrders[slotOrders.length - 1] + 1 : 0;
        } else {
            insertAt = slotOrders[slotIndex];
        }
        existing.forEach(w => {
            if ((w.dockOrder ?? 0) >= insertAt) w.dockOrder = (w.dockOrder ?? 0) + 1;
        });
        win.docked    = side;
        win.dockOrder = insertAt;
        win.dockFlex  = 1;
        win.visible   = true;
        this.notify();
        this.saveHint(id, win);
    }

    /** Stack panel `id` as a tab with panel `targetId` (or into its existing group). */
    tabIntoGroup(id: string, targetId: string): void {
        const source = this.windows.get(id);
        const target = this.windows.get(targetId);
        if (!source || !target || !target.docked) return;
        // Leave any existing group membership
        if (source.dockGroup) this.removeFromGroup(id);

        // Get or create the target's group
        let groupId: string;
        if (target.dockGroup) {
            groupId = target.dockGroup;
        } else {
            groupId = `grp_${targetId}`;
            target.dockGroup = groupId;
            target.tabOrder  = 0;
            this.activeTabGroups.set(groupId, targetId);
            this.saveHint(targetId, target);
        }

        const members   = [...this.windows.values()].filter(w => w.dockGroup === groupId);
        const maxOrder  = members.reduce((m, w) => Math.max(m, w.tabOrder ?? 0), -1);

        source.docked    = target.docked;
        source.dockOrder = target.dockOrder;
        source.dockFlex  = target.dockFlex;
        source.dockGroup = groupId;
        source.tabOrder  = maxOrder + 1;
        source.visible   = true;
        // If the target panel lives inside a split group, the new tab member must
        // inherit the same split position so it's rendered inside the split slot.
        if (target.splitGroup) {
            source.splitGroup = target.splitGroup;
            source.splitOrder = target.splitOrder;
            source.splitFlex  = target.splitFlex;
        }

        this.activeTabGroups.set(groupId, id);
        this.notify();
        this.saveHint(id, source);
    }

    setActiveTab(panelId: string): void {
        const win = this.windows.get(panelId);
        if (!win?.dockGroup) return;
        this.activeTabGroups.set(win.dockGroup, panelId);
        this.notify();
    }

    /** Split panel `id` above or below `targetId` (cross-axis within the same dock slot). */
    splitIntoGroup(id: string, targetId: string, splitBefore: boolean): void {
        const source = this.windows.get(id);
        const target = this.windows.get(targetId);
        if (!source || !target || !target.docked) return;
        if (source.dockGroup)  this.removeFromGroup(id);
        if (source.splitGroup) this.removeFromSplitGroup(id);

        let splitGroupId: string;
        if (target.splitGroup) {
            splitGroupId = target.splitGroup;
        } else if (target.dockGroup) {
            // Entire tab group becomes one split member — assign splitGroup to every
            // member so SplitGroupPanel can render the group as a unit without creating
            // a panel that has both dockGroup and splitGroup in isolation.
            splitGroupId = `splt_${target.dockGroup}`;
            const tabSplitOrder = splitBefore ? 1 : 0;
            for (const m of this.windows.values()) {
                if (m.dockGroup !== target.dockGroup) continue;
                m.splitGroup = splitGroupId;
                m.splitOrder = tabSplitOrder;
                m.splitFlex  = 1;
                this.saveHint(m.id, m);
            }
            source.docked     = target.docked;
            source.dockOrder  = target.dockOrder;
            source.dockFlex   = target.dockFlex;
            source.splitGroup = splitGroupId;
            source.splitOrder = splitBefore ? 0 : 1;
            source.splitFlex  = 1;
            source.visible    = true;
            this.notify();
            this.saveHint(id, source);
            return;
        } else {
            splitGroupId = `splt_${targetId}`;
            target.splitGroup = splitGroupId;
            target.splitOrder = 0;
            target.splitFlex  = 1;
            this.saveHint(targetId, target);
        }

        const members  = [...this.windows.values()]
            .filter(w => w.splitGroup === splitGroupId)
            .sort((a, b) => (a.splitOrder ?? 0) - (b.splitOrder ?? 0));
        const targetIdx = members.findIndex(m => m.id === targetId);
        const insertAt  = splitBefore ? (targetIdx < 0 ? 0 : targetIdx) : (targetIdx < 0 ? members.length : targetIdx + 1);

        members.forEach(w => {
            if ((w.splitOrder ?? 0) >= insertAt) w.splitOrder = (w.splitOrder ?? 0) + 1;
        });

        source.docked     = target.docked;
        source.dockOrder  = target.dockOrder;
        source.dockFlex   = target.dockFlex;
        source.splitGroup = splitGroupId;
        source.splitOrder = insertAt;
        source.splitFlex  = 1;
        source.visible    = true;

        this.notify();
        this.saveHint(id, source);
    }

    setSplitFlex(panelId: string, flex: number): void {
        const win = this.windows.get(panelId);
        if (!win?.splitGroup) return;
        const normalized = Math.max(0.05, flex);
        // Update all panels at the same split position (tab group members share a slot)
        for (const w of this.windows.values()) {
            if (w.splitGroup === win.splitGroup && w.splitOrder === win.splitOrder) {
                w.splitFlex = normalized;
                this.saveHint(w.id, w);
            }
        }
        this.notify();
    }

    /** Undock. Pass the panel's screen rect so the floating window appears in-place. */
    undock(id: string, visualWidth?: number, visualHeight?: number, screenX?: number, screenY?: number): void {
        const win = this.windows.get(id);
        if (!win) return;
        if (win.dockGroup)  this.removeFromGroup(id);
        if (win.splitGroup) this.removeFromSplitGroup(id);
        const side = win.docked;
        if (visualWidth  !== undefined) win.width  = visualWidth;
        else if (side === 'left' || side === 'right') win.width = this.dockExtents[side!];
        if (visualHeight !== undefined) win.height = visualHeight;
        else if (side === 'top' || side === 'bottom') win.height = this.dockExtents[side!];
        if (screenX !== undefined) win.x = screenX;
        if (screenY !== undefined) win.y = screenY;
        delete win.docked;
        delete win.dockOrder;
        delete win.dockFlex;
        win.visible = true;
        win.zIndex  = ++this.nextZ;
        this.notify();
        this.saveHint(id, win);
    }

    getDockExtent(side: DockSide): number {
        return this.dockExtents[side];
    }

    setDockExtent(side: DockSide, size: number): void {
        const min = side === 'left' || side === 'right' ? 80 : 50;
        this.dockExtents[side] = Math.max(min, size);
        this.notify();
        this.onDockExtentsChange?.({ ...this.dockExtents });
    }

    setDockFlex(id: string, flex: number): void {
        const win = this.windows.get(id);
        if (!win?.docked) return;
        win.dockFlex = Math.max(0.05, flex);
        this.notify();
        this.saveHint(id, win);
    }

    /** Set flex for all panels in the same slot (by panel ID, tab-group ID, or split-group ID). */
    setSlotFlex(slotId: string, flex: number): void {
        const normalized = Math.max(0.05, flex);
        for (const win of this.windows.values()) {
            if (win.id === slotId || win.dockGroup === slotId || win.splitGroup === slotId) {
                win.dockFlex = normalized;
            }
        }
        this.notify();
        for (const win of this.windows.values()) {
            if (win.id === slotId || win.dockGroup === slotId || win.splitGroup === slotId) {
                this.saveHint(win.id, win);
            }
        }
    }

    // ── Scripting API ─────────────────────────────────────────────────────────

    open(id: string, options: WindowOpenOptions = {}): WindowHandle {
        const existing = this.windows.get(id);
        if (existing) {
            if (options.title) existing.title = options.title;
            // Geometry given explicitly applies to a window that is already
            // open, too. Mudlet's moveMapWidget/resizeMapWidget are openMapWidget
            // in disguise (see GUIUtils.lua), so a re-open that ignored the
            // coordinates left both of them doing nothing at all once the map
            // widget was up. Undocking follows, because a floating position is
            // meaningless while docked — which is what upstream warns about.
            if (options.x !== undefined || options.width !== undefined) {
                if (options.x !== undefined) existing.x = options.x;
                if (options.y !== undefined) existing.y = options.y;
                if (options.width !== undefined) existing.width = options.width;
                if (options.height !== undefined) existing.height = options.height;
                existing.docked = undefined;
                this.saveHint(id, existing);
            }
            existing.visible = true;
            existing.zIndex  = ++this.nextZ;
            this.touchOverlayWindows(existing);
            this.notify();
            if (existing.kind === 'map') this.onMapOpen?.(id);
            return this.makeHandle(id);
        }

        const kind = options.kind ?? 'text';
        const hint = options.ignoreHint ? undefined : this.windowHints[id];
        const def  = DEFAULT_SIZE[kind];

        // Determine dock state, following Mudlet semantics:
        //   autoDock=false           → always float
        //   hint present             → restore saved dock position
        //   dockingArea (no hint)    → dock to that side
        //   otherwise                → float
        let docked: DockSide | undefined;
        let dockOrder: number | undefined;
        let dockFlex: number | undefined;
        let dockGroup: string | undefined;
        let tabOrder: number | undefined;
        let splitGroup: string | undefined;
        let splitOrder: number | undefined;
        let splitFlex: number | undefined;

        if (options.autoDock === false) {
            // Force floating
        } else if (hint?.docked) {
            docked    = hint.docked;
            dockOrder = hint.dockOrder;
            dockFlex  = hint.dockFlex;
            if (hint.dockGroup) {
                dockGroup = hint.dockGroup;
                tabOrder  = hint.tabOrder;
                if (hint.isActiveTab || !this.activeTabGroups.has(hint.dockGroup)) {
                    this.activeTabGroups.set(hint.dockGroup, id);
                }
            }
            if (hint.splitGroup) {
                splitGroup = hint.splitGroup;
                splitOrder = hint.splitOrder;
                splitFlex  = hint.splitFlex;
            }
        } else if (options.dockingArea && options.dockingArea !== 'main') {
            const areaMap: Partial<Record<string, DockSide>> = {
                left: 'left', right: 'right', top: 'top', bottom: 'bottom',
            };
            docked = areaMap[options.dockingArea];
            if (docked) { dockFlex = 1; dockOrder = ++this.nextDockOrder; }
        }

        const win: ScriptWindowData = {
            id,
            title:       options.title ?? (kind === 'map' ? 'Map' : id),
            kind,
            // Honor `hidden` from options (setWindowHints spreads the saved
            // hint into options for autoOpen restore) but NOT from the bare
            // saved hint — an explicit script `openMapWidget()` or toolbar
            // click should always make the window visible, even when the
            // user's last action was to hide/close it.
            visible:     options.hidden !== true,
            x:           hint?.x      ?? this.defaultX(options.position),
            y:           hint?.y      ?? this.defaultY(options.position),
            width:       hint?.width  ?? options.width  ?? def.w,
            height:      hint?.height ?? options.height ?? def.h,
            zIndex:      ++this.nextZ,
            docked,
            dockOrder,
            dockFlex,
            dockGroup,
            tabOrder,
            splitGroup,
            splitOrder,
            splitFlex,
            fontSize: hint?.fontSize,
            fontFamily: hint?.fontFamily,
            wrapAt: hint?.wrapAt,
            wrapIndent: hint?.wrapIndent,
            wrapHangingIndent: hint?.wrapHangingIndent,
            backgroundColor: hint?.backgroundColor,
            backgroundImage: hint?.backgroundImage,
            parent: options.parent,
            // Mudlet's openUserWindow(..., autoDock=false) opens the window
            // floating AND prevents the user from later docking it. Persist
            // the lock so re-opens after layout restore preserve the intent
            // (the saved hint carries the flag through saveHint).
            lockFloating: options.lockFloating ?? hint?.lockFloating ?? (options.autoDock === false ? true : undefined),
            pendingText: [],
        };

        this.windows.set(id, win);
        this.touchOverlayWindows(win);
        this.windowHints[id] = {
            ...this.windowHints[id],
            kind:     win.kind,
            autoOpen: options.autoOpen ?? this.windowHints[id]?.autoOpen,
        };
        this.saveHint(id, win);
        this.notify();
        if (kind === 'map') this.onMapOpen?.(id);
        return this.makeHandle(id);
    }

    close(id: string): void {
        const win = this.windows.get(id);
        if (win) {
            const parentId = this.overlayParentId(win);
            if (parentId) this.overlayZ.forget(parentId, 'windows', id);
        }
        this.windows.delete(id);
        this.controls.delete(id);
        this.elements.delete(id);
        this.lineBuffers.delete(id);
        this.portalTargets.delete(id);
        this.consoleRegistry?.delete(id);
        this.miniConsoles.delete(id);
        this.frameTabs.delete(id);
        this.mxpFrameIds.delete(id);
        this.topAnchored.delete(id);
        this.cmdLineState.delete(id);
        this.cmdLineValueProbes.delete(id);
        // A secondary map view closed from its own titlebar (rather than
        // through closeMapView) must leave the registry too, or getMapViewIds
        // would keep reporting a window that is gone.
        const viewMatch = MAP_VIEW_ID_RE.exec(id);
        if (viewMatch) this.mapViews.delete(Number(viewMatch[1]));
        this.onWindowClosed?.(id);
        this.notify();
    }

    clearAll(): void {
        for (const id of this.windows.keys()) {
            this.controls.delete(id);
            this.elements.delete(id);
            this.lineBuffers.delete(id);
            this.portalTargets.delete(id);
            this.consoleRegistry?.delete(id);
        }
        this.windows.clear();
        this.miniConsoles.clear();
        this.frameTabs.clear();
        this.mxpFrameIds.clear();
        this.topAnchored.clear();
        this.cmdLineState.clear();
        this.cmdLineValueProbes.clear();
        this.notify();
    }

    hide(id: string): void {
        const win = this.windows.get(id);
        if (!win || !win.visible) return;
        win.visible = false;
        this.saveHint(id, win);
        this.notify();
    }

    show(id: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        if (win.visible) return true;
        win.visible = true;
        win.zIndex  = ++this.nextZ;
        this.saveHint(id, win);
        this.notify();
        return true;
    }

    isVisible(id: string): boolean {
        return this.windows.get(id)?.visible ?? false;
    }

    /** Stored geometry for a user window / miniconsole — deliberately the saved
     *  x/y/width/height rather than {@link getSize}'s live DOM rect, so it is an
     *  exact inverse of moveWindow/resizeWindow (Mudlet's getWindowGeometry
     *  reads back through the dock widget the same way). Null if unknown. */
    getGeometry(id: string): { x: number; y: number; width: number; height: number } | null {
        const win = this.windows.get(id);
        if (!win) return null;
        return { x: win.x, y: win.y, width: win.width, height: win.height };
    }

    /** The window this one nests inside, or null for a root floating window.
     *  Used by the ancestor-aware windowVisible walk. */
    parentOf(id: string): string | null {
        const win = this.windows.get(id);
        return win ? this.overlayParentId(win) : null;
    }

    write(id: string, text: string): void {
        if (!this.windows.has(id)) this.open(id, { kind: 'text', title: id });
        const win = this.windows.get(id)!;
        if (win.kind === 'map') return;

        const buffered = (this.lineBuffers.get(id) ?? '') + text;
        const lines    = buffered.split('\n');
        for (let i = 0; i < lines.length - 1; i++) this.pushLine(win, id, lines[i]);

        const remainder = lines[lines.length - 1];
        if (remainder) this.lineBuffers.set(id, remainder);
        else           this.lineBuffers.delete(id);
    }

    flushLine(id: string): void {
        const partial = this.lineBuffers.get(id);
        if (!partial) return;
        this.lineBuffers.delete(id);
        const win = this.windows.get(id);
        if (win) this.pushLine(win, id, partial);
    }

    flushAllLines(): void {
        for (const id of this.lineBuffers.keys()) this.flushLine(id);
    }

    clear(id: string): void {
        const win = this.windows.get(id);
        if (!win) return;
        win.pendingText = [];
        win.pendingPartial = undefined;
        this.lineBuffers.delete(id);
        this.controls.get(id)?.clear();
        const el = this.elements.get(id);
        if (el && win.kind === 'html') el.replaceChildren();
        // Also reset the upstream Console — without this the next echo would
        // re-include any pre-clear partial text when drainWindowConsole fires.
        this.consoleRegistry?.get(id)?.clear();
    }

    /**
     * Mudlet setUserWindowTitle(name, [title]) → bool. With a non-empty title
     * the panel header shows that string; with an empty/missing title the
     * window's id is used as the title (matches Mudlet's "reset to default"
     * behaviour). Returns false when the named window doesn't exist.
     */
    setTitle(id: string, title?: string): boolean {
        const win = this.windows.get(id);
        if (!win) return false;
        win.title = title && title.length > 0 ? title : this.defaultTitle(id);
        this.notify();
        return true;
    }

    /** Mudlet `getUserWindowTitle(name)` — the header text, whether it was set
     *  or generated. Null when there is no such window. */
    getTitle(id: string): string | null {
        return this.windows.get(id)?.title ?? null;
    }

    /**
     * The title a window carries when nobody has set one. Mudlet builds it from
     * the profile and the window's own name ("<profile> - <window>"), which is
     * what a player sees on a freshly opened user window; mudix used to fall
     * back to the bare id, so resetting a title lost the profile half of it.
     * The profile name is injected by ScriptingAPI — the manager has no other
     * reason to know it.
     */
    profileName = '';

    defaultTitle(id: string): string {
        return this.profileName ? `${this.profileName} - ${id}` : id;
    }

    focus(id: string): void { this.bringToFront(id); }
    has(id: string): boolean { return this.windows.has(id); }
    getElement(id: string): HTMLElement | null { return this.elements.get(id) ?? null; }

    /** Mudlet getUserWindowSize. Reports the live rendered size of a userwindow
     *  / miniconsole when mounted (so docked panels return their actual on-screen
     *  pixels rather than the stored hint), else falls back to the saved width
     *  /height. Returns null if the window doesn't exist. Prefers the viewport
     *  element so the reported box matches the rectangle labels position against —
     *  not the inner output area, which has paddings and a scrollbar gutter. */
    getSize(id: string): { width: number; height: number } | null {
        const win = this.windows.get(id);
        if (!win) return null;
        const el = this.viewports.get(id) ?? this.elements.get(id);
        if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) {
                return { width: rect.width, height: rect.height };
            }
        }
        return { width: win.width, height: win.height };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private pushLine(win: ScriptWindowData, id: string, line: string): void {
        if (win.kind === 'text') {
            const ctrl = this.controls.get(id);
            if (ctrl) {
                ctrl.push(line);
            } else {
                win.pendingText.push(line);
                if (win.pendingText.length > TEXT_BUFFER_LIMIT) {
                    win.pendingText.splice(0, win.pendingText.length - TEXT_BUFFER_LIMIT);
                    console.warn(`[WindowManager] pre-mount buffer for "${id}" exceeded ${TEXT_BUFFER_LIMIT} lines`);
                }
            }
        } else if (win.kind === 'html') {
            const el = this.elements.get(id);
            if (el) el.insertAdjacentHTML('beforeend', line);
            else    win.pendingText.push(line);
        }
    }

    private defaultX(position?: string): number {
        if (position === 'right') return Math.round(window.innerWidth * 0.6);
        if (position === 'left')  return 20;
        return 20 + (this.windows.size % 8) * 30;
    }

    private defaultY(position?: string): number {
        if (position === 'above') return 20;
        if (position === 'below') return Math.round(window.innerHeight * 0.55);
        return 20 + (this.windows.size % 8) * 30;
    }

    private notify(): void {
        const arr = [...this.windows.values()]
            .map(({ id, title, kind, visible, x, y, width, height, zIndex, docked, dockOrder, dockFlex, dockGroup, tabOrder, splitGroup, splitOrder, splitFlex, fontSize, fontFamily, lineHeight, wrapAt, wrapIndent, wrapHangingIndent, backgroundColor, backgroundImage, parent, lockFloating, poppedOut, cmdLineEnabled, cmdLineStyleSheet, cmdLineValue, cmdLineValueSeq }) => ({
                id, title, kind, visible, x, y, width, height, zIndex,
                docked, dockOrder, dockFlex, dockGroup, tabOrder, splitGroup, splitOrder, splitFlex,
                fontSize, fontFamily, lineHeight, wrapAt, wrapIndent, wrapHangingIndent, backgroundColor, backgroundImage, parent, lockFloating, poppedOut,
                cmdLineEnabled, cmdLineStyleSheet, cmdLineValue, cmdLineValueSeq,
                isActiveTab: dockGroup ? this.activeTabGroups.get(dockGroup) === id : undefined,
                frameTabs: this.frameTabs.get(id),
                isMxpFrame: this.mxpFrameIds.has(id) || undefined,
            }))
            .sort((a, b) => a.zIndex - b.zIndex);
        this.onWindowsChange?.(arr, { ...this.dockExtents });
    }

    private saveHint(id: string, win: ScriptWindowData): void {
        // Secondary map views are deliberately NOT persisted, matching Mudlet:
        // closing a profile loses them, and creating one again opens a fresh
        // floating window rather than restoring wherever the last one was
        // docked. Skipping the hint covers the layout snapshot too, which is
        // built from the same cache.
        if (MAP_VIEW_ID_RE.test(id)) return;
        const hint: WindowOpenOptions = {
            x: win.x, y: win.y, width: win.width, height: win.height,
            kind:      win.kind,
            title:     win.title,
            autoOpen:  this.windowHints[id]?.autoOpen,
            hidden:    win.visible ? undefined : true,
            docked:    win.docked,    dockOrder:  win.dockOrder,  dockFlex:  win.dockFlex,
            dockGroup: win.dockGroup, tabOrder:   win.tabOrder,
            isActiveTab: win.dockGroup ? this.activeTabGroups.get(win.dockGroup) === id : undefined,
            splitGroup: win.splitGroup, splitOrder: win.splitOrder, splitFlex: win.splitFlex,
            fontSize:  win.fontSize,
            fontFamily: win.fontFamily,
            wrapAt:    win.wrapAt,
            wrapIndent: win.wrapIndent,
            wrapHangingIndent: win.wrapHangingIndent,
            backgroundColor: win.backgroundColor,
            backgroundImage: win.backgroundImage,
            lockFloating: win.lockFloating,
        };
        this.windowHints[id] = hint;
        this.onWindowHint?.(id, hint);
    }

    private removeFromSplitGroup(id: string): void {
        const win = this.windows.get(id);
        if (!win?.splitGroup) return;
        const groupId = win.splitGroup;
        delete win.splitGroup;
        delete win.splitOrder;
        delete win.splitFlex;

        // Dissolve group when only one distinct split position remains.
        // Tab groups in a split share one splitOrder, so count unique orders not panels.
        const remaining = [...this.windows.values()].filter(w => w.splitGroup === groupId);
        const uniqueOrders = new Set(remaining.map(w => w.splitOrder ?? 0));
        if (uniqueOrders.size <= 1) {
            for (const last of remaining) {
                delete last.splitGroup;
                delete last.splitOrder;
                delete last.splitFlex;
                this.saveHint(last.id, last);
            }
        }
    }

    private removeFromGroup(id: string): void {
        const win = this.windows.get(id);
        if (!win?.dockGroup) return;
        const groupId = win.dockGroup;
        delete win.dockGroup;
        delete win.tabOrder;

        // Switch active tab if this was the active one
        if (this.activeTabGroups.get(groupId) === id) {
            const remaining = [...this.windows.values()].filter(w => w.dockGroup === groupId);
            if (remaining.length > 0) {
                this.activeTabGroups.set(groupId, remaining[0].id);
            } else {
                this.activeTabGroups.delete(groupId);
            }
        }

        // Dissolve group when only one panel remains
        const remaining = [...this.windows.values()].filter(w => w.dockGroup === groupId);
        if (remaining.length === 1) {
            const last = remaining[0];
            delete last.dockGroup;
            delete last.tabOrder;
            this.activeTabGroups.delete(groupId);
            this.saveHint(last.id, last);
        } else if (remaining.length === 0) {
            this.activeTabGroups.delete(groupId);
        }
    }

    private makeHandle(id: string): WindowHandle {
        const m = this;
        return {
            get id()      { return id; },
            get kind()    { return m.windows.get(id)?.kind ?? 'text'; },
            get element() { return m.elements.get(id) ?? document.createElement('div'); },
            write(text)   { m.write(id, text); },
            clear()       { m.clear(id); },
            setTitle(t)   { m.setTitle(id, t); },
            focus()       { m.focus(id); },
            close()       { m.close(id); },
        };
    }
}
