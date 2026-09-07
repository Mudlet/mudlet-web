import type { GlobalEventChannel } from '../../GlobalEventChannel';
import type { BindingContext } from './context';

/**
 * Session-level introspection and event raising: stopwatches, the console
 * width, connection info, desktop notifications, screen-reader announcements,
 * the clock, and raiseEvent / raiseGlobalEvent.
 *
 * These share no subsystem - what groups them is that each answers a question
 * about (or acts on) the session as a whole rather than a specific window,
 * which is why they were interleaved in the original setup().
 *
 * The cross-tab channel behind raiseGlobalEvent is constructed by the runtime
 * and passed in: it needs the runtime's event emitter and the live profile
 * name, neither of which belongs in this module.
 */
export function installSessionBindings(
    { lua, api, emitEvent }: BindingContext,
    globalEvents: GlobalEventChannel,
): void {
    // Mudlet getWindowsCodepage() → active ANSI code page string. The browser
    // VFS is UTF-8 (code page 65001) on every host, which is what we report —
    // it lets the bundled utf8_filenames.lua skip legacy-ANSI transcoding
    // instead of erroring or corrupting UTF-8 paths.
    lua.global.set('getWindowsCodepage', () => api.getWindowsCodepage());

    // ── Stopwatches ───────────────────────────────────────────────────────
    // Mudlet stopwatch family. Every function accepts a numeric watchID or a
    // string name; Mudlet's lua_isnumber treats a numeric string (e.g. "5",
    // common from a trigger capture) as an id, so resolveWatchArg coerces
    // those to numbers while leaving real names and the empty string (=first
    // unnamed watch) as strings.
    const resolveWatchArg = (v: unknown): number | string => {
        const s = typeof v === 'string' ? v : String(v ?? '');
        if (s.trim() === '') return '';
        const n = typeof v === 'number' ? v : Number(s);
        return Number.isFinite(n) ? Math.trunc(n) : s;
    };
    // createStopWatch([name] | [autostart], [autostart]). A string first arg
    // names the watch and defaults autostart off; a boolean is the autostart
    // flag; nothing autostarts an unnamed watch. Returns the id, or false if
    // the name is already taken.
    lua.global.set('createStopWatch', (a?: unknown, b?: unknown) => {
        let name = '';
        let autoStart = true;
        if (typeof a === 'string') { name = a; autoStart = false; }
        else if (typeof a === 'boolean') { autoStart = a; }
        if (typeof b === 'boolean') autoStart = b;
        return api.stopwatches.create(name, autoStart) ?? false;
    });
    // startStopWatch(id|name, [resetAndRestart]). A bare numeric id resets to
    // zero and restarts (legacy behaviour); the name form just resumes.
    lua.global.set('startStopWatch', (a: unknown, b?: unknown) => {
        const arg = resolveWatchArg(a);
        const resetAndRestart = typeof arg === 'number'
            ? (b === undefined ? true : !!b)
            : false;
        return api.stopwatches.start(arg, resetAndRestart);
    });
    // stopStopWatch / getStopWatchTime return elapsed seconds (false on miss).
    lua.global.set('stopStopWatch', (a: unknown) =>
        api.stopwatches.stop(resolveWatchArg(a)) ?? false);
    lua.global.set('getStopWatchTime', (a: unknown) =>
        api.stopwatches.getTime(resolveWatchArg(a)) ?? false);
    lua.global.set('resetStopWatch', (a: unknown) =>
        api.stopwatches.reset(resolveWatchArg(a)));
    lua.global.set('adjustStopWatch', (a: unknown, b: unknown) =>
        api.stopwatches.adjust(resolveWatchArg(a), Number(b)));
    lua.global.set('deleteStopWatch', (a: unknown) =>
        api.stopwatches.delete(resolveWatchArg(a)));
    // setStopWatchPersistence(id|name, state). Persistent watches are saved
    // to localStorage (keyed per connection) and restored on the next load.
    lua.global.set('setStopWatchPersistence', (a: unknown, b: unknown) =>
        api.stopwatches.setPersistence(resolveWatchArg(a), !!b));
    // getStopWatches → record keyed by stringified id; Bridge.lua re-keys to
    // integer ids and rebuilds the nested table off the wasmoon proxy.
    lua.global.set('__getStopWatches', () => api.stopwatches.getAll());
    // setStopWatchName(id|name, newName) — assign/rename; false on unknown
    // watch, empty name, or a name already taken by another watch.
    lua.global.set('setStopWatchName', (a: unknown, newName: unknown) =>
        api.stopwatches.setName(resolveWatchArg(a), String(newName ?? '')));
    // getStopWatchBrokenDownTime(id|name) → day/hour/minute/second table;
    // Bridge.lua rebuilds it off the proxy and maps the miss to false.
    lua.global.set('__getStopWatchBrokenDownTime', (a: unknown) =>
        api.stopwatches.getBrokenDownTime(resolveWatchArg(a)));

    // Mudlet getMainConsoleWidth() → pixel width of the main console text area.
    lua.global.set('getMainConsoleWidth', () => api.getMainConsoleWidth());

    // Mudlet getConnectionInfo() → host, port, connected. JS hands back a
    // 0-indexed [host, port, connected] array; Bridge.lua unpacks it into
    // the three documented return values.
    lua.global.set('__getConnectionInfo', () => {
        const info = api.getConnectionInfo();
        return [info.host, info.port, info.connected];
    });

    // Mudlet announce(text [, processing]). processing is a politeness hint
    // ("importantall"/"importantmostrecent" → assertive, else polite); any
    // other (or missing) value is treated as polite. No return value.
    lua.global.set('announce', (text: unknown, processing?: unknown) => {
        api.announce(
            String(text ?? ''),
            typeof processing === 'string' ? processing : undefined,
        );
    });

    // Mudlet hasFocus([window]) → bool. True when the named console (or the
    // main command bar when omitted) holds keyboard focus.
    lua.global.set('hasFocus', (name?: unknown) =>
        api.hasFocus(typeof name === 'string' ? name : undefined));
    // Mudlet alert([seconds]) — flash for attention. Browsers can't flash the
    // taskbar, so Mudlet Web flashes the document title for `seconds` (default 10).
    lua.global.set('alert', (seconds?: unknown) => {
        api.alert(seconds === undefined ? undefined : Number(seconds));
    });

    // Mudlet showNotification(title, [content], [expiryInSeconds]) → true.
    lua.global.set('showNotification', (title: unknown, content?: unknown, expiry?: unknown) => {
        return api.showNotification(
            String(title ?? ''),
            content == null ? undefined : String(content),
            expiry == null ? undefined : Number(expiry),
        );
    });

    // Mudlet `getTime([asString, format])`. The Bridge.lua wrapper handles
    // the table-vs-string dispatch and Qt-style format token expansion on
    // top of this raw time record.
    lua.global.set('__getTime', () => api.getTime());

    // registerAnonymousEventHandler is provided by Bridge.lua — it mirrors
    // Mudlet's C++ TLuaInterpreter::registerAnonymousEventHandler so module-
    // load-time registrations (Geyser etc.) made before Other.lua's Lua-side
    // override land in the native handler table dispatched from
    // __mudlet_dispatch_event.

    // raiseEvent runs every handler synchronously. JS is single-threaded
    // so handler-A-before-handler-B ordering falls out of the call stack.
    // Mudlet returns `true` on success (the only failure mode is a missing
    // event name); Mudlet Web matches.
    lua.global.set('raiseEvent', (event: string, ...args: unknown[]) => {
        if (typeof event !== 'string' || event.length === 0) return false;
        emitEvent(event, args);
        return true;
    });

    // raiseGlobalEvent fires the event in every OTHER open profile (each in
    // its own tab) but NOT this one — see GlobalEventChannel. Mudlet appends
    // the sending profile's name as the final arg; args are limited to
    // string/number/boolean/nil. The channel itself is constructed by the
    // runtime and handed in, since it needs the runtime's event emitter.
    lua.global.set('raiseGlobalEvent', (event: unknown, ...args: unknown[]) => {
        if (typeof event !== 'string' || event.length === 0) {
            throw new Error('raiseGlobalEvent: missing argument #1 (eventName as a string expected!)');
        }
        return globalEvents.raise(event, args);
    });
}

