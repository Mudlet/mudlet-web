import type { BindingContext } from './context';
import { describeThrown } from '../../../utils/describeThrown';

/**
 * Error reporting and the send/alias expansion primitives.
 *  
 * Grouped because both are about what user code does *around* a command rather
 * than with the console: raising a script error the editor can attribute, and
 * expanding an alias without executing it.
 */
export function installDiagnosticsBindings({ lua, api }: BindingContext): void {
    // ── Error / debug ─────────────────────────────────────────────────────
    // showHandlerError is called by Other.lua's dispatchEventToFunctions when
    // a handler throws — it's a C++ function in Mudlet, bridged here.
    // Bridge.lua type-guards both arguments, so `error` is a string in every
    // call that gets this far; describeThrown only matters if that guard is
    // ever relaxed — a raw object here would print as "[object Object]".
    lua.global.set('showHandlerError', (event: string, error: string) => {
        api.printError(`[event "${event}"] ${describeThrown(error, `event "${event}"`)}`);
    });
    // Mudlet `debugc(content)` and `errorc(content, [debugInfo])` both
    // accept a single content arg (plus an optional debug-info string on
    // errorc). They route to Mudlet's "Errors" console; mudix has no
    // equivalent dock, so debugc lands in devtools and errorc routes
    // through the script log (same destination as printError).
    lua.global.set('debugc', (content: unknown) => {
        console.debug('[Lua]', String(content ?? ''));
    });
    lua.global.set('errorc', (content: unknown, debugInfo?: unknown) => {
        const msg = String(content ?? '');
        const trailer = debugInfo == null ? '' : ` ${String(debugInfo)}`;
        api.printError(msg + trailer);
    });

    // ── Send / alias ──────────────────────────────────────────────────────
    // Mudlet `expandAlias(text, [echo])`. Default for `echo` is **true**
    // — Mudlet's TLuaInterpreter::expandAlias initialises `wantPrint = true`
    // and only honours an explicit boolean 2nd arg. The command is echoed
    // in the main window the same way a typed-in alias would be. Passing
    // `false` opts out. Returns true once the expansion is dispatched.
    lua.global.set('expandAlias', (text: unknown, echo?: unknown) => {
        api.expandAlias(String(text ?? ''), echo == null ? true : !!echo);
        api.flushOutput();
        return true;
    });
    // Mudlet sendCmdLine([cmdLineName,] text) stages text into the command
    // bar (setPlainText + selectAll) without submitting it. Scripts use
    // this to pre-fill the input for the user to edit before pressing
    // Enter. The cmdLineName arg is ignored — mudix has a single command
    // bar.
    lua.global.set('sendCmdLine', (a: unknown, b?: unknown) => {
        // wasmoon hands an omitted Lua argument over as `null`, not `undefined`,
        // so `== null` is what distinguishes "no cmdLineName given".
        const text = b == null ? String(a ?? '') : String(b);
        api.printCmdLine(text);
    });
}

