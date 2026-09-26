import { OverlayLayerOrder } from '../layout/overlayLayerOrder';

export interface CmdLineCreateOptions {
    /** Parent window id ('main' for the main viewport). */
    parent?: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface CmdLineState {
    name: string;
    parent: string;
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    /** Last value pushed from script (printCmdLine / clearCmdLine / appendCmdLine).
     *  The React input owns its own typed state; this seed is only applied when
     *  `valueSeq` changes, mirroring the per-userwindow command-line pattern. */
    value: string;
    valueSeq: number;
    /** When false, the input is rendered with the `disabled` attribute so the
     *  user can't focus/type. Mudlet disableCommandLine(name). */
    enabled: boolean;
    /** Raw Qt-style CSS string from setCmdLineStyleSheet. Translated to scoped
     *  CSS at render time via {@link cmdLineQssToScopedCss}. */
    styleSheet?: string;
    /** Lua-side Enter handler. Plain field; not part of the React snapshot. */
    action: ((text: string) => void) | null;
}

type Listener = (cmdLines: CmdLineState[]) => void;

function safeCoord(n: number): number {
    return Number.isFinite(n) ? n : 0;
}

/**
 * Registry for overlay command-line widgets (Mudlet createCommandLine). Mirrors
 * {@link LabelManager}'s shape: per-parent subscribers, one Map keyed by name.
 *
 * Distinct from {@link WindowManager}'s per-userwindow command lines — those are
 * dockview-panel inputs gated by enableCommandLine; these are absolutely-
 * positioned overlay `<input>` elements on top of a parent viewport, sibling to
 * createLabel.
 */
export class CommandLineManager {
    private readonly cmdLines = new Map<string, CmdLineState>();
    private readonly listeners = new Map<string, Set<Listener>>();
    /** Per-cmdline live value probe registered by the React mount. Lets
     *  ScriptingAPI.getCmdLine read the current typed text without round-
     *  tripping through React state. */
    private readonly valueProbes = new Map<string, () => string>();
    /** Per-cmdline imperative control registered by the React mount —
     *  selectAll() drives <input>.select() (Mudlet selectCmdLineText). */
    private readonly controls = new Map<string, { selectAll: () => void }>();

    // Public so CommandLineOverlay (and other overlay components sharing this
    // registry via the other managers) can read/subscribe to the wrapper
    // layer's z-index — see overlayLayerOrder.ts.
    constructor(readonly overlayZ: OverlayLayerOrder = new OverlayLayerOrder()) {}

    /** Mudlet createCommandLine(name, x, y, w, h) — false when a cmd line with
     *  that name already exists. */
    create(name: string, opts: CmdLineCreateOptions): boolean {
        if (this.cmdLines.has(name)) return false;
        const parent = opts.parent ?? 'main';
        this.cmdLines.set(name, {
            name, parent,
            x: safeCoord(opts.x), y: safeCoord(opts.y),
            width: safeCoord(opts.width), height: safeCoord(opts.height),
            visible: true,
            value: '',
            valueSeq: 0,
            enabled: true,
            action: null,
        });
        this.overlayZ.touch(parent, 'cmdlines', name);
        this.notify(parent);
        return true;
    }

    has(name: string): boolean {
        return this.cmdLines.has(name);
    }

    /** Read-only handle on a command line's stored state, for the geometry and
     *  visibility getters (getWindowGeometry, windowVisible). */
    get(name: string): Readonly<CmdLineState> | undefined {
        return this.cmdLines.get(name);
    }

    destroy(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        this.cmdLines.delete(name);
        this.valueProbes.delete(name);
        this.controls.delete(name);
        this.overlayZ.forget(cl.parent, 'cmdlines', name);
        this.notify(cl.parent);
        return true;
    }

    move(name: string, x: number, y: number): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        cl.x = safeCoord(x); cl.y = safeCoord(y);
        this.notify(cl.parent);
        return true;
    }

    resize(name: string, width: number, height: number): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        cl.width = safeCoord(width); cl.height = safeCoord(height);
        this.notify(cl.parent);
        return true;
    }

    /** Mudlet setWindow — reparent a command line into another window's
     *  overlay. Both the old and the new parent's overlays re-render. */
    setParent(name: string, parent: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        if (cl.parent !== parent) {
            const old = cl.parent;
            cl.parent = parent;
            this.overlayZ.forget(old, 'cmdlines', name);
            this.overlayZ.touch(parent, 'cmdlines', name);
            this.notify(old);
            this.notify(parent);
        }
        return true;
    }

    show(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        if (!cl.visible) { cl.visible = true; this.notify(cl.parent); }
        return true;
    }

    hide(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        if (cl.visible) { cl.visible = false; this.notify(cl.parent); }
        return true;
    }

    raise(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        this.overlayZ.touch(cl.parent, 'cmdlines', name);
        this.notify(cl.parent);
        return true;
    }

    lower(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        this.overlayZ.sink(cl.parent, 'cmdlines', name);
        this.notify(cl.parent);
        return true;
    }

    enable(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        if (!cl.enabled) { cl.enabled = true; this.notify(cl.parent); }
        return true;
    }

    disable(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        if (cl.enabled) { cl.enabled = false; this.notify(cl.parent); }
        return true;
    }

    setStyleSheet(name: string, css: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        cl.styleSheet = css && css.trim() ? css : undefined;
        this.notify(cl.parent);
        return true;
    }

    /** Mudlet printCmdLine — replace contents, caret to end. */
    setValue(name: string, text: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        cl.value = String(text ?? '');
        cl.valueSeq++;
        this.notify(cl.parent);
        return true;
    }

    /** Mudlet appendCmdLine — push onto the end of the current contents. */
    appendValue(name: string, text: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        // Read the live value from the probe so we append onto what the user
        // sees, not the last script-seeded snapshot.
        const live = this.valueProbes.get(name)?.() ?? cl.value;
        cl.value = String(live ?? '') + String(text ?? '');
        cl.valueSeq++;
        this.notify(cl.parent);
        return true;
    }

    /** Mudlet clearCmdLine — wipe the contents. */
    clearValue(name: string): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        cl.value = '';
        cl.valueSeq++;
        this.notify(cl.parent);
        return true;
    }

    /** Mudlet getCmdLine — live value via the React-registered probe, falling
     *  back to the last seed when nothing has mounted yet. */
    getValue(name: string): string {
        const probe = this.valueProbes.get(name);
        if (probe) return probe();
        return this.cmdLines.get(name)?.value ?? '';
    }

    setAction(name: string, cb: ((text: string) => void) | null): boolean {
        const cl = this.cmdLines.get(name);
        if (!cl) return false;
        cl.action = cb;
        return true;
    }

    getAction(name: string): ((text: string) => void) | null {
        return this.cmdLines.get(name)?.action ?? null;
    }

    /** Where Enter goes on a command line with no action bound: the game, as
     *  typed input. Set by the ScriptingEngine (its `hostSend`). */
    onDefaultSend?: (text: string) => void;

    /**
     * The user pressed Enter on `name` with `text` in it. Runs the bound
     * action, or else sends the text the way Mudlet's
     * TCommandLine::enterCommand falls back to `Host::send`. Returns whether
     * anything took the text, i.e. whether the line should clear.
     */
    submit(name: string, text: string): boolean {
        const cb = this.getAction(name);
        if (cb) {
            try { cb(text); } catch (err) { console.warn(`[CommandLine ${name}] action threw:`, err); }
            return true;
        }
        if (!this.onDefaultSend) return false;
        this.onDefaultSend(text);
        return true;
    }

    hasAction(name: string): boolean {
        return !!this.cmdLines.get(name)?.action;
    }

    /** Mudlet selectCmdLineText — highlight all text in the input. */
    selectAll(name: string): boolean {
        const ctrl = this.controls.get(name);
        if (!ctrl) return false;
        ctrl.selectAll();
        return true;
    }

    registerValueProbe(name: string, probe: () => string): () => void {
        this.valueProbes.set(name, probe);
        return () => {
            if (this.valueProbes.get(name) === probe) this.valueProbes.delete(name);
        };
    }

    registerControl(name: string, ctrl: { selectAll: () => void }): () => void {
        this.controls.set(name, ctrl);
        return () => {
            if (this.controls.get(name) === ctrl) this.controls.delete(name);
        };
    }

    list(parent: string): CmdLineState[] {
        const out: CmdLineState[] = [];
        for (const c of this.cmdLines.values()) if (c.parent === parent) out.push(c);
        return out;
    }

    subscribe(parent: string, fn: Listener): () => void {
        let set = this.listeners.get(parent);
        if (!set) { set = new Set(); this.listeners.set(parent, set); }
        set.add(fn);
        fn(this.list(parent));
        return () => {
            set!.delete(fn);
            if (set!.size === 0) this.listeners.delete(parent);
        };
    }

    clearAll(): void {
        const parents = new Set<string>();
        for (const c of this.cmdLines.values()) parents.add(c.parent);
        this.cmdLines.clear();
        this.valueProbes.clear();
        this.controls.clear();
        for (const p of parents) this.notify(p);
    }

    private notify(parent: string): void {
        const set = this.listeners.get(parent);
        if (!set) return;
        const list = this.list(parent);
        for (const fn of set) fn(list);
    }
}
