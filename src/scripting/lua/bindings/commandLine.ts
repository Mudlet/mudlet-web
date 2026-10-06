import type { BindingContext } from './context';
import { cmdLinePlainText } from '../../../ui/cmdline/plainText';

/**
 * The main command bar and Mudlet's createCommandLine overlays: reading and
 * writing the input text, styling, autocomplete suggestions, and the
 * right-click context menu Lua can populate.
 *  
 * 'Command line' here covers three distinct targets - the main command bar, a
 * user window's embedded input, and a free-floating createCommandLine widget -
 * which cmdLineKind below resolves from the name Lua passed.
 */
export function installCommandLineBindings({ lua, api, emitEvent }: BindingContext): void {
    // ── Command bar ───────────────────────────────────────────────────────
    // Mudlet's cmdline APIs accept an optional first window-name arg for
    // sub-command-lines (overlay createCommandLine widgets or userwindow
    // command lines). Overlay cmd-lines (cmdLines registry) win first;
    // userwindow cmd-lines (windows registry) second; otherwise drop the
    // name and target the main command bar. Bridge.lua refuses a name that
    // resolves to neither before print/append/get/clearCmdLine get here.
    const cmdLineKind = (name?: unknown): 'overlay' | 'window' | null => {
        if (typeof name !== 'string' || !name || name === 'main') return null;
        if (api.cmdLines.has(name)) return 'overlay';
        if (api.windows.has(name)) return 'window';
        return null;
    };
    lua.global.set('appendCmdLine', (a: unknown, b?: unknown) => {
        const kind = cmdLineKind(a);
        if (kind === 'overlay') { api.cmdLines.appendValue(a as string, String(b ?? '')); return; }
        if (kind === 'window')  { api.windows.appendCmdLine(a as string, String(b ?? '')); return; }
        api.appendCmdLine(String(b !== undefined ? b : a));
    });
    lua.global.set('printCmdLine', (a: unknown, b?: unknown) => {
        const kind = cmdLineKind(a);
        if (kind === 'overlay') { api.cmdLines.setValue(a as string, String(b ?? '')); return; }
        if (kind === 'window')  { api.windows.printCmdLine(a as string, String(b ?? '')); return; }
        api.printCmdLine(String(b !== undefined ? b : a));
    });
    lua.global.set('clearCmdLine', (name?: unknown) => {
        const kind = cmdLineKind(name);
        if (kind === 'overlay') { api.cmdLines.clearValue(name as string); return; }
        if (kind === 'window')  { api.windows.clearCmdLine(name as string); return; }
        api.clearCmdLine();
    });
    // Mudlet getCmdLine([name]) → current input string. Routes through
    // cmdLines / windows live value probes when targeting a named cmd line,
    // else returns the main command bar's text. As plain text, the way
    // TCommandLine's toPlainText() reads it: a non-breaking space comes back as
    // a space and U+2028/U+2029 as line feeds (#375).
    lua.global.set('getCmdLine', (name?: unknown) => {
        const kind = cmdLineKind(name);
        if (kind === 'overlay') return cmdLinePlainText(api.cmdLines.getValue(name as string));
        if (kind === 'window')  return cmdLinePlainText(api.windows.getCmdLineValue(name as string));
        return cmdLinePlainText(api.getCmdLine());
    });
    // Mudlet selectCmdLineText([commandLine]) — highlight all text. Targets
    // an overlay cmd line first, then the main command bar. (User-window
    // cmd lines have no select-all hook yet; arg is accepted for parity.)
    lua.global.set('selectCmdLineText', (name?: unknown) => {
        const kind = cmdLineKind(name);
        if (kind === 'overlay') { api.cmdLines.selectAll(name as string); return; }
        api.selectCmdLineText(typeof name === 'string' ? name : undefined);
    });
    // Mudlet setCommandBackgroundColor([windowName,] r, g, b [, a]) and
    // setCommandForegroundColor — recolor the main command bar. Optional
    // leading windowName string; numeric channels arrive as regex-capture
    // strings, so coerce with Number(). Alpha defaults to 255 (opaque).
    const cmdColorSetter = (apply: (r: number, g: number, b: number, a: number, win?: string) => boolean) =>
        (a: unknown, b: unknown, c: unknown, d?: unknown, e?: unknown) => {
            if (typeof a === 'string') {
                return apply(Number(b), Number(c), Number(d), e === undefined ? 255 : Number(e), a);
            }
            return apply(Number(a), Number(b), Number(c), d === undefined ? 255 : Number(d));
        };
    lua.global.set('setCommandBackgroundColor',
        cmdColorSetter((r, g, b, al, win) => api.setCommandBackgroundColor(r, g, b, al, win)));
    lua.global.set('setCommandForegroundColor',
        cmdColorSetter((r, g, b, al, win) => api.setCommandForegroundColor(r, g, b, al, win)));
    // Mudlet enableCommandLine / disableCommandLine. For overlay cmd lines
    // this toggles the input's `disabled` attribute; for userwindows it
    // shows/hides the docked <input> at the bottom of the panel. Mudlet Web
    // doesn't (yet) gate the main cmd bar this way — calling with no name
    // or "main" is a no-op that returns true so scripts targeting the main
    // bar don't crash.
    // Mudlet's enable/disableCommandLine change *visibility* — UI_spec asserts
    // windowVisible() flips — so an overlay command line is shown/hidden as well
    // as made inert. Doing only the latter left a dead input box on screen.
    lua.global.set('enableCommandLine', (name?: unknown) => {
        if (typeof name !== 'string' || !name || name === 'main') return true;
        if (api.cmdLines.has(name)) {
            api.cmdLines.enable(name);
            return api.cmdLines.show(name);
        }
        return api.windows.enableCommandLine(name);
    });
    lua.global.set('disableCommandLine', (name?: unknown) => {
        if (typeof name !== 'string' || !name || name === 'main') return true;
        if (api.cmdLines.has(name)) {
            api.cmdLines.disable(name);
            return api.cmdLines.hide(name);
        }
        return api.windows.disableCommandLine(name);
    });
    // Mudlet setCmdLineStyleSheet(name, css). Routes the QSS string to the
    // overlay cmd line, the userwindow cmd line, or — for the main bar —
    // a no-op returning true (no main-bar QSS hook). The legacy 1-arg form
    // (no name → "" CSS on main bar) is preserved.
    lua.global.set('setCmdLineStyleSheet', (a: unknown, b?: unknown) => {
        // One argument is the CSS for the main bar; two name the command line
        // first. A lone string is therefore CSS, not a name — which is why the
        // name is only taken when there IS a second argument.
        const named = b !== undefined;
        const name = named && typeof a === 'string' ? a : 'main';
        const css = String((named ? b : a) ?? '');
        api.noteCmdLineStyleSheet(name, css);
        if (name === 'main') return true;
        if (api.cmdLines.has(name)) return api.cmdLines.setStyleSheet(name, css);
        return api.windows.setCmdLineStyleSheet(name, css);
    });
    lua.global.set('__getCmdLineStyleSheet', (name?: unknown) =>
        api.getCmdLineStyleSheet(typeof name === 'string' ? name : 'main'));
    // Mudlet (add|remove)CmdLineSuggestion([name], word) /
    // clearCmdLineSuggestions([name]) and the matching blacklist trio. Each
    // command line keeps its own two lists (TCommandLine::addSuggestion /
    // addBlacklist); a lone argument is the word for the main command bar, two
    // name the command line first. Bridge.lua has already refused a name that
    // is not a command line. Suggestions add to what Tab can complete to, the
    // blacklist strikes words out of it whichever source they came from.
    const cmdLineSuggestArgs = (a: unknown, b?: unknown): [string, string] =>
        b !== undefined && b !== null
            ? [String(b), typeof a === 'string' && a ? a : 'main']
            : [String(a ?? ''), 'main'];
    const cmdLineNameArg = (name?: unknown): string =>
        typeof name === 'string' && name ? name : 'main';
    lua.global.set('addCmdLineSuggestion', (a: unknown, b?: unknown) => {
        api.addCmdLineSuggestion(...cmdLineSuggestArgs(a, b));
    });
    lua.global.set('removeCmdLineSuggestion', (a: unknown, b?: unknown) => {
        api.removeCmdLineSuggestion(...cmdLineSuggestArgs(a, b));
    });
    lua.global.set('clearCmdLineSuggestions', (name?: unknown) => {
        api.clearCmdLineSuggestions(cmdLineNameArg(name));
    });
    lua.global.set('__addCmdLineBlacklist', (a: unknown, b?: unknown) => {
        api.addCmdLineBlacklist(...cmdLineSuggestArgs(a, b));
    });
    lua.global.set('__removeCmdLineBlacklist', (a: unknown, b?: unknown) => {
        api.removeCmdLineBlacklist(...cmdLineSuggestArgs(a, b));
    });
    lua.global.set('__clearCmdLineBlacklist', (name?: unknown) => {
        api.clearCmdLineBlacklist(cmdLineNameArg(name));
    });

    // Whether `name` is a command line right now: one made with
    // createCommandLine, or a miniconsole's / user window's own line once
    // enableCommandLine has given it one (desktop's mSubCommandLineMap). A
    // console that never had its line enabled has none, so getCmdLine and
    // friends refuse it rather than answer for a line that is not there (#342).
    lua.global.set('__hasCmdLine', (name?: unknown) =>
        typeof name === 'string' && name !== ''
        && (api.cmdLines.has(name) || api.windows.hasCommandLine(name)));

    // Mudlet get/setSaveCommandHistory([cmdLineName][, save]) — the per-command
    // -line half of history saving. Bridge.lua owns the argument shapes and the
    // profile-wide gate; these two just carry the flag.
    lua.global.set('__getSaveCommandHistory', (name?: unknown) =>
        api.saveCommandHistoryFor(typeof name === 'string' && name ? name : 'main'));
    lua.global.set('__setSaveCommandHistory', (name: unknown, save: unknown) => {
        api.setSaveCommandHistoryFor(typeof name === 'string' && name ? name : 'main', save === true);
    });

    // ── Command-line context menu ─────────────────────────────────────────
    // Mudlet addCommandLineMenuEvent([cmdLineName,] menuLabel, eventName).
    // The menuLabel is both the unique key and the display string — there
    // is no separate displayName arg. We support the single command bar
    // and ignore the optional cmdLineName arg.
    api.cmdLineMenu.setDispatcher((event, args) => emitEvent(event, args));
    lua.global.set('addCommandLineMenuEvent', (
        a: unknown, b: unknown, c?: unknown,
    ) => {
        // 2 args: (menuLabel, eventName).
        // 3 args: (cmdLineName, menuLabel, eventName) — drop cmdLineName.
        // `== null` rather than `!== undefined`: a Lua nil handed over the
        // wasmoon boundary is not reliably `undefined`, and reading it as a
        // present third argument shifted everything one place, registering an
        // entry with an empty event name (which `add` then refused).
        let menuLabel: unknown, eventName: unknown;
        if (c == null) {
            menuLabel = a; eventName = b;
        } else {
            menuLabel = b; eventName = c;
        }
        return api.cmdLineMenu.add(
            String(menuLabel ?? ''),
            String(eventName ?? ''),
        );
    });
    // Mudlet removeCommandLineMenuEvent(uniqueName) → true on success, or
    // (false, errMsg) when the entry doesn't exist. The optional leading
    // cmdLineName arg is accepted for parity and ignored.
    lua.global.set('__removeCommandLineMenuEvent', (a: unknown, b?: unknown) => {
        // Same nil-vs-undefined trap as addCommandLineMenuEvent above.
        const uniqueName = b == null ? a : b;
        return api.cmdLineMenu.remove(String(uniqueName ?? ''));
    });
    // Mudlet shape: { [uniqueName] = { event, display } }
    lua.global.set('getCommandLineMenuEvents', () => {
        const out: Record<string, unknown> = {};
        for (const e of api.cmdLineMenu.list()) {
            out[e.uniqueName] = { event: e.eventName, display: e.displayName };
        }
        return out;
    });

    // Mudlet addMouseEvent(uniqueName, eventName [, displayName [, tooltip]]).
    // Registers a custom entry in the main output area's right-click menu;
    // clicking it raises eventName. Returns true, or false when the name is
    // empty or already registered (Mudlet warns + returns nil there).
    api.mouseEvents.setDispatcher((event, args) => emitEvent(event, args));
    lua.global.set('addMouseEvent', (
        uniqueName: unknown, eventName: unknown, displayName?: unknown, tooltip?: unknown,
    ) => api.mouseEvents.add(
        String(uniqueName ?? ''),
        String(eventName ?? ''),
        displayName !== undefined ? String(displayName) : undefined,
        tooltip !== undefined ? String(tooltip) : undefined,
    ));
    // Mudlet removeMouseEvent(uniqueName). Mudlet returns nothing; we return
    // a boolean for parity with the rest of the registry API.
    lua.global.set('removeMouseEvent', (uniqueName: unknown) =>
        api.mouseEvents.remove(String(uniqueName ?? '')));
    // Mudlet getMouseEvents() →
    //   { [uniqueName] = { ["event name"], ["display name"], ["tooltip text"] } }
    lua.global.set('getMouseEvents', () => {
        const out: Record<string, unknown> = {};
        for (const e of api.mouseEvents.list()) {
            out[e.uniqueName] = {
                'event name': e.eventName,
                'display name': e.displayName,
                'tooltip text': e.tooltip,
            };
        }
        return out;
    });
}

