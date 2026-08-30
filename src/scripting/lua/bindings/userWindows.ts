import type { BindingContext } from './context';
import { MAP_WIDGET_ID } from '../../../ui/windows/types';

/** Mudlet's docking-area codes → the side names WindowManager docks against
 *  ('main' = floating). Host::openWindow accepts BOTH the single letter and
 *  the spelled-out word, and Geyser passes the words — `dockPosition = "left"`
 *  straight from a UserWindow constructor, and `setDockPosition("left")` /
 *  `"floating"` afterwards. Listing only the letters meant every one of those
 *  missed and fell through to the 'right' default, so a package asking for a
 *  left dock got its panels stacked on the right. Anything genuinely
 *  unrecognised still falls back to 'right', matching Mudlet. */
const DOCKMAP: Record<string, string> = {
    r: 'right',    right: 'right',
    l: 'left',     left: 'left',
    t: 'top',      top: 'top',
    b: 'bottom',   bottom: 'bottom',
    f: 'main',     floating: 'main',
    main: 'main',
};

/**
 * Creating and destroying the addressable UI surfaces Lua can open:
 * user windows, the map widget, mini-consoles, command lines, and scroll
 * boxes - plus windowType(), which reports what a given name resolves to.
 *
 * Deletion is the interesting half. Each destroy path has to free whatever
 * Lua-side callback slots the widget had bound before dropping it, or the
 * registry entry leaks for the lifetime of the runtime.
 */
export function installUserWindowBindings({
    lua,
    api,
    emitEvent,
    unregisterCb,
    overlayCmdLineActionCbIds,
}: BindingContext): void {
    // Mudlet `windowType(name)` → kind string. Returns `(nil, errMsg)` when
    // the name doesn't resolve. The raw entry point hands JS `null` for the
    // miss case; the Bridge.lua wrapper re-shapes it into the multi-return.
    // mudix has no "commandline" or "textedit" concepts, so those kinds are
    // not reported; off-screen buffers (createBuffer) report "buffer".
    lua.global.set('__windowType', (window: unknown) => {
        if (typeof window !== 'string') return null;
        if (window === 'main') return 'main';
        if (api.labels.has(window)) return 'label';
        if (api.windows.isMiniConsole(window)) return 'miniconsole';
        if (api.windows.has(window)) return 'userwindow';
        if (api.cmdLines.has(window)) return 'commandline';
        if (api.textEdits.has(window)) return 'textedit';
        if (api.scrollBoxes.has(window)) return 'scrollbox';
        if (api.isBuffer(window)) return 'buffer';
        return null;
    });
    // Mudlet `openUserWindow(name, [restoreLayout, autoDock, dockingArea]) → true`.
    // Always returns true once the window registry has the panel. The handle
    // returned by ScriptingWindowsAPI.open is kept internal — userscripts
    // address windows by name everywhere else (write/move/resize/etc.), so
    // returning `true` (Mudlet shape) avoids leaking the handle object.
    lua.global.set('openUserWindow', (window: string, restoreLayout: boolean = true, autoDock: boolean = true, dockingArea?: string) => {
        // Mudlet leaves the 4th argument EMPTY when it is not passed, and
        // Host::openWindow then returns without touching placement; only a new
        // dock widget picks a side on its own (Qt::RightDockWidgetArea).
        const area = typeof dockingArea === 'string' && dockingArea
            ? (DOCKMAP[dockingArea.toLowerCase()] ?? 'right')
            : undefined;
        const existed = api.windows.has(window);
        api.windows.open(window, {
            autoDock,
            // Only a freshly-created window falls back to the right dock.
            ...(area ? { dockingArea: area } : existed ? {} : { dockingArea: 'right' }),
            // restoreLayout=true means "come back where you were" — so the
            // saved hint WINS; only restoreLayout=false ignores it and uses
            // the dockingArea (Geyser passes "floating" in that branch and
            // then moves/resizes the window itself). Inverting these two
            // dropped every restoring userwindow into the default right dock.
            ignoreHint: !restoreLayout,
        });
        // An area given for a window that is ALREADY open re-docks it — open()
        // only reads dockingArea while creating. That re-dock is the whole of
        // Geyser.UserWindow:setDockPosition, so without it a package could
        // never move a panel out of the side it was born in.
        if (existed && area) api.windows.setDockArea(window, area);
        return true;
    });
    // Mudlet `openMapWidget([dockingArea | x, y [, w, h]]) → true`.
    //   no args            → restore saved layout, or right-dock if none
    //   (area)             → "f" floating, or "l"/"r"/"t"/"b" dock side
    //   (x, y)             → floating at (x, y); width/height inherit the
    //                        saved hint (or panel defaults if none)
    //   (x, y, w, h)       → floating at given pixel position and size
    // Explicit args override the saved layout hint. Always returns true.
    lua.global.set('openMapWidget', (a?: unknown, b?: unknown, c?: unknown, d?: unknown) => {
        // 2- or 4-arg numeric form: floating at (x, y[, w, h]). A negative
        // coordinate means "leave it where it is" — that is how
        // resizeMapWidget reaches this call (openMapWidget(-1, -1, w, h)),
        // asking for a size without naming a position.
        if (typeof a === 'number' && typeof b === 'number') {
            const hasSize = c !== undefined && d !== undefined;
            const keepPosition = Number(a) < 0 && Number(b) < 0;
            api.windows.open(MAP_WIDGET_ID, {
                kind: 'map',
                // Only names a *new* widget: reopening one keeps the title it
                // was given, since it is the same dock coming back rather than
                // a fresh one (Mapper_spec pins that).
                ...(api.windows.has(MAP_WIDGET_ID) ? {} : { title: 'Map' }),
                autoDock: false,
                ignoreHint: true,
                ...(keepPosition ? {} : { x: Number(a), y: Number(b) }),
                ...(hasSize ? { width: Number(c), height: Number(d) } : {}),
            });
            return true;
        }
        // 0-arg: restore saved layout, fall back to right dock
        if (a === undefined || a === null) {
            api.windows.open(MAP_WIDGET_ID, {
                kind: 'map',
                // Only names a *new* widget: reopening one keeps the title it
                // was given, since it is the same dock coming back rather than
                // a fresh one (Mapper_spec pins that).
                ...(api.windows.has(MAP_WIDGET_ID) ? {} : { title: 'Map' }),
                dockingArea: 'right',
            });
            return true;
        }
        // 1-arg: dockingArea string
        const area = String(a);
        if (area === 'f') {
            api.windows.open(MAP_WIDGET_ID, {
                kind: 'map',
                // Only names a *new* widget: reopening one keeps the title it
                // was given, since it is the same dock coming back rather than
                // a fresh one (Mapper_spec pins that).
                ...(api.windows.has(MAP_WIDGET_ID) ? {} : { title: 'Map' }),
                autoDock: false,
                ignoreHint: true,
            });
            return true;
        }
        const side = DOCKMAP[area.toLowerCase()] ?? 'right';
        const existed = api.windows.has(MAP_WIDGET_ID);
        api.windows.open(MAP_WIDGET_ID, {
            kind: 'map',
            title: 'Map',
            ignoreHint: true,
            dockingArea: side,
        });
        // See openUserWindow: a named area moves a widget that is already up,
        // which is how Geyser.Mapper:setDockPosition re-docks the mapper.
        if (existed) api.windows.setDockArea(MAP_WIDGET_ID, side);
        return true;
    });
    // ── Widget state getters (Mudlet 4.21's read-back family) ──────────────
    // Titles, stylesheets and tooltips could only ever be set; these answer
    // what they were set to, so a script can restore what it found rather than
    // guessing. Argument contracts and the (nil, message) shapes live in
    // Bridge.lua alongside the matching setters'.
    // The map widget counts as open only while it is showing: closeMapWidget
    // hides the dock rather than destroying it (so a reopen hands back the same
    // one, title and all), which means "is there a map window?" is a visibility
    // question, not a presence one.
    const mapWidgetOpen = () =>
        api.windows.has(MAP_WIDGET_ID) && api.windows.isVisible(MAP_WIDGET_ID);

    lua.global.set('__getUserWindowTitle', (name: unknown) =>
        api.windows.getTitle(String(name ?? '')));
    lua.global.set('__getUserWindowStyleSheet', (name: unknown) =>
        api.getUserWindowStyleSheet(String(name ?? '')));
    lua.global.set('__getScrollBarVisible', (name?: unknown) =>
        api.windows.scrollBarVisible(typeof name === 'string' && name ? name : 'main'));
    lua.global.set('__getMapWindowTitle', () => (mapWidgetOpen() ? api.windows.getTitle(MAP_WIDGET_ID) : null));
    // x, y, width, height as a 0-indexed array; Bridge.lua unpacks it into the
    // four values Mudlet returns.
    lua.global.set('__getMapWidgetGeometry', () => {
        const g = mapWidgetOpen() ? api.windows.getGeometry(MAP_WIDGET_ID) : null;
        return g ? [g.x, g.y, g.width, g.height] : null;
    });

    // Mudlet `closeMapWidget() → true`. Hidden, not destroyed: Mudlet closes
    // the dock widget and keeps it, so a later openMapWidget hands the same one
    // back — with the title it was given, which a freshly created widget would
    // have lost. False when no map widget is open to close.
    lua.global.set('closeMapWidget', () => {
        if (!mapWidgetOpen()) return false;
        api.windows.hide(MAP_WIDGET_ID);
        return true;
    });
    // Mudlet clearUserWindow([name]) — defaults to clearing the main
    // console when no name is given (matches `clearWindow` behaviour).
    lua.global.set("clearUserWindow", (window?: unknown) => {
        const name = typeof window === 'string' ? window : undefined;
        if (!name || name === 'main') api.clearWindow();
        else api.windows.clear(name);
    });
    // createMiniConsole has two calling conventions:
    //   createMiniConsole(name, x, y, w, h)              — 5 args, parent defaults to main
    //   createMiniConsole(parent, name, x, y, w, h)      — 6 args, miniconsole inside a userwindow
    // Number() coerces because regex-capture args arrive as Lua strings.
    lua.global.set('createMiniConsole', (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f?: unknown) => {
        const hasParent = f !== undefined;
        const [parent, name, x, y, w, h] = hasParent
            ? [a as string, b, c, d, e, f]
            : [undefined, a, b, c, d, e];
        return api.createMiniConsole(
            String(name ?? ''),
            Number(x), Number(y),
            Number(w), Number(h),
            parent,
        );
    });
    // Mudlet createCommandLine([parent,] name, x, y, w, h) — absolutely-
    // positioned overlay <input> element on the named parent viewport
    // (defaults to 'main'). Returns true on success, false when a command
    // line of that name already exists. The unified moveWindow / resizeWindow
    // / showWindow / hideWindow lookup below picks it up automatically.
    lua.global.set('createCommandLine', (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f?: unknown) => {
        const hasParent = f !== undefined;
        const [parent, name, x, y, w, h] = hasParent
            ? [a as string, b, c, d, e, f]
            : [undefined, a, b, c, d, e];
        if (typeof name !== 'string' || !name) return false;
        return api.cmdLines.create(name, {
            parent: parent && parent !== 'main' ? parent : 'main',
            x: Number(x), y: Number(y),
            width: Number(w), height: Number(h),
        });
    });
    // Mudlet deleteCommandLine(name) → bool. Destroys an overlay command line
    // created by createCommandLine. Fires sysCommandLineDeleted(name) on
    // success, matching Mudlet's sysLabelDeleted / sysMiniConsoleDeleted.
    // Mudlet deleteCommandLine(name) → true, or (false, errMsg) when the named
    // command line doesn't exist. Bridge.lua adds the error string (and the
    // "main cannot be deleted" guard). Fires sysCommandLineDeleted(name) on
    // success.
    lua.global.set('__deleteCommandLine', (name: unknown) => {
        if (typeof name !== 'string') return false;
        // Free any bound action callback chunk so the Lua registry slot is
        // released — overlayCmdLineActionCbIds bookkeeping mirrors the
        // per-window cmd-line lifecycle.
        const prev = overlayCmdLineActionCbIds.get(name);
        if (prev) { unregisterCb(prev); overlayCmdLineActionCbIds.delete(name); }
        const ok = api.cmdLines.destroy(name);
        if (ok) emitEvent('sysCommandLineDeleted', [name]);
        return ok;
    });
    // Mudlet deleteMiniConsole(name) → true, or (false, errMsg) when the named
    // mini-console doesn't exist (Bridge.lua adds the error string). Rejects
    // non-miniconsole targets (main window, dock panels, unknown names).
    lua.global.set('__deleteMiniConsole', (name: unknown) =>
        typeof name === 'string' ? api.deleteMiniConsole(name) : false);
    // Mudlet createScrollBox([parent,] name, x, y, w, h) — absolutely-
    // positioned scrollable container on the named parent viewport (defaults
    // to 'main'). Other overlay widgets nest inside it by passing this box's
    // name as their parent. Returns false when a box of that name already
    // exists. Picked up by the unified moveWindow / resizeWindow / showWindow
    // / hideWindow / raiseWindow / lowerWindow lookups below.
    lua.global.set('createScrollBox', (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f?: unknown) => {
        const hasParent = f !== undefined;
        const [parent, name, x, y, w, h] = hasParent
            ? [a as string, b, c, d, e, f]
            : [undefined, a, b, c, d, e];
        if (typeof name !== 'string' || !name) return false;
        // Mudlet reuses a scroll box that already carries this name — it moves
        // and resizes the existing one instead of creating a second or failing
        // (createMiniConsole behaves the same way, and the Bridge.lua wrapper
        // turns the reuse into Mudlet's `false, "... moving/resizing ..."`).
        if (api.scrollBoxes.has(name)) {
            api.scrollBoxes.move(name, Math.trunc(Number(x)), Math.trunc(Number(y)));
            api.scrollBoxes.resize(name, Math.trunc(Number(w)), Math.trunc(Number(h)));
            return true;
        }
        return api.scrollBoxes.create(name, {
            parent: parent && parent !== 'main' ? parent : 'main',
            x: Math.trunc(Number(x)), y: Math.trunc(Number(y)),
            width: Math.trunc(Number(w)), height: Math.trunc(Number(h)),
        });
    });
    // Mudlet deleteScrollBox(name) → bool. Destroys a scroll box created via
    // createScrollBox. Fires sysScrollBoxDeleted(name) on success, matching
    // sysCommandLineDeleted / sysMiniConsoleDeleted.
    lua.global.set('__deleteScrollBox', (name: unknown) => {
        if (typeof name !== 'string') return false;
        const ok = api.scrollBoxes.destroy(name);
        if (ok) emitEvent('sysScrollBoxDeleted', [name]);
        return ok;
    });
}

