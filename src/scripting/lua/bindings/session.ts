import { LuaType } from 'wasmoon-lua5.1';
import type { GlobalEventChannel } from '../../GlobalEventChannel';
import type { BindingContext, LuaState } from './context';
import { isRefusal, type StopwatchRefusal, type StopwatchSubject } from '../../StopwatchManager';
import { timeZoneAbbreviation } from '../../../utils/timeZone';

/**
 * Session-level introspection and event raising: stopwatches, the console
 * width, connection info, desktop notifications, screen-reader announcements,
 * the clock, and raiseGlobalEvent (raiseEvent lives in Bridge.lua).
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
    { lua, api, registerRawGlobal }: BindingContext,
    globalEvents: GlobalEventChannel,
): void {
    // Mudlet getWindowsCodepage() → active ANSI code page string. The browser
    // VFS is UTF-8 (code page 65001) on every host, which is what we report —
    // it lets the bundled utf8_filenames.lua skip legacy-ANSI transcoding
    // instead of erroring or corrupting UTF-8 paths.
    lua.global.set('getWindowsCodepage', () => api.getWindowsCodepage());

    // ── Stopwatches ───────────────────────────────────────────────────────
    // Mudlet stopwatch family. Every function takes a numeric watchID or a
    // string name, and only a Lua NUMBER is an ID: Mudlet tests the argument
    // with lua_type(L, 1) == LUA_TNUMBER, so "5" (a trigger capture, say)
    // names a stopwatch called 5. The empty string is the first unnamed watch.
    //
    // A refusal comes back to Lua as its message string; the guard in
    // Bridge.lua (which also raises for a subject of the wrong type) turns
    // that into Mudlet's (nil, message). None of the family succeeds with a
    // string, so a string is unambiguously the refusal.
    const watchSubject = (v: unknown): StopwatchSubject =>
        typeof v === 'number' ? Math.trunc(v) : String(v ?? '');
    const answer = <T>(r: T | StopwatchRefusal): T | string => isRefusal(r) ? r.refused : r;
    // createStopWatch([name] | [autostart], [autostart]). A string first arg
    // names the watch and defaults autostart off; a boolean is the autostart
    // flag; nothing autostarts an unnamed watch. Returns the id, or the
    // refusal when the name is already taken.
    lua.global.set('createStopWatch', (a?: unknown, b?: unknown) => {
        let name = '';
        let autoStart = true;
        if (typeof a === 'string') { name = a; autoStart = false; }
        else if (typeof a === 'boolean') { autoStart = a; }
        if (typeof b === 'boolean') autoStart = b;
        return answer(api.stopwatches.create(name, autoStart));
    });
    // startStopWatch(id|name, [resetAndRestart]). A bare numeric id resets to
    // zero and restarts (legacy behaviour); the name form just resumes.
    lua.global.set('startStopWatch', (a: unknown, b?: unknown) => {
        const subject = watchSubject(a);
        const resetAndRestart = typeof subject === 'number'
            ? (b === undefined || b === null ? true : !!b)
            : false;
        return answer(api.stopwatches.start(subject, resetAndRestart));
    });
    // stopStopWatch / getStopWatchTime return elapsed seconds.
    //
    // Raw-marshalled, unlike the rest of the family: wasmoon pushes an integral
    // JS number with lua_pushinteger, and lua_Integer is 32 bits in this wasm
    // build, so a whole-numbered elapsed time past ~2.1e9 s arrived in Lua as
    // garbage of whatever sign the wraparound produced (1e12 s came back as
    // -727379968). A stopwatch holds far more than that on purpose — see
    // MAX_STOPWATCH_MS — and pushing the double directly is what carries it.
    const pushWatchTime = (L: LuaState, value: number | StopwatchRefusal): number => {
        if (isRefusal(value)) lua.global.luaApi.lua_pushstring(L, value.refused);
        else lua.global.luaApi.lua_pushnumber(L, value);
        return 1;
    };
    // The subject is read off the stack rather than through wasmoon: a raw
    // lua_CFunction gets no converted arguments.
    const watchArg = (L: LuaState): StopwatchSubject =>
        watchSubject(lua.global.luaApi.lua_type(L, 1) === LuaType.Number
            ? lua.global.luaApi.lua_tonumber(L, 1)
            : lua.global.luaApi.lua_tolstring(L, 1, null) ?? '');
    registerRawGlobal('stopStopWatch', (L) =>
        pushWatchTime(L, api.stopwatches.stop(watchArg(L))));
    registerRawGlobal('getStopWatchTime', (L) =>
        pushWatchTime(L, api.stopwatches.getTime(watchArg(L))));
    lua.global.set('resetStopWatch', (a: unknown) =>
        answer(api.stopwatches.reset(watchSubject(a))));
    lua.global.set('adjustStopWatch', (a: unknown, b: unknown) =>
        answer(api.stopwatches.adjust(watchSubject(a), Number(b))));
    lua.global.set('deleteStopWatch', (a: unknown) =>
        answer(api.stopwatches.delete(watchSubject(a))));
    // setStopWatchPersistence(id|name, state). Persistent watches are saved
    // to localStorage (keyed per connection) and restored on the next load.
    lua.global.set('setStopWatchPersistence', (a: unknown, b: unknown) =>
        answer(api.stopwatches.setPersistence(watchSubject(a), !!b)));
    // getStopWatches → record keyed by stringified id; Bridge.lua re-keys to
    // integer ids and rebuilds the nested table off the wasmoon proxy.
    lua.global.set('__getStopWatches', () => api.stopwatches.getAll());
    // setStopWatchName(id|name, newName) — assign, rename, or (with "") take
    // the name away; refuses a name another watch already has.
    lua.global.set('setStopWatchName', (a: unknown, newName: unknown) =>
        answer(api.stopwatches.setName(watchSubject(a), String(newName ?? ''))));
    // getStopWatchBrokenDownTime(id|name) → day/hour/minute/second table;
    // Bridge.lua rebuilds it off the proxy.
    lua.global.set('__getStopWatchBrokenDownTime', (a: unknown) =>
        answer(api.stopwatches.getBrokenDownTime(watchSubject(a))));

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
    // The local zone's abbreviation at an epoch time in seconds — glibc's %Z,
    // which Bridge.lua's os.date wrapper substitutes for emscripten's full name.
    lua.global.set('__mudlet_tz_abbrev', (seconds: unknown) =>
        timeZoneAbbreviation(new Date(Number(seconds) * 1000)));

    // Helpers for the user-dictionary functions in Bridge.lua, which need the
    // Unicode case mappings and the collation Lua's C-locale string library
    // lacks. Words cross as one "\n"-joined string — a dictionary word never
    // holds a line break (storableWord refuses one).
    // getDictionaryWordList sorts with a case-insensitive QCollator; the
    // accent-sensitivity collator is ICU's secondary strength, which is what
    // Qt's case-insensitive QCollator sets. Equal words fall back to code order
    // so the result is deterministic.
    let dictCollator: Intl.Collator | null = null;
    lua.global.set('__mudlet_dict_sort', (joined: unknown) => {
        if (typeof joined !== 'string' || joined === '') return '';
        dictCollator ??= new Intl.Collator('en', { sensitivity: 'accent' });
        const c = dictCollator;
        return joined.split('\n')
            .sort((a, b) => c.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))
            .join('\n');
    });
    lua.global.set('__mudlet_upper', (s: unknown) => String(s ?? '').toUpperCase());
    lua.global.set('__mudlet_lower', (s: unknown) => String(s ?? '').toLowerCase());

    // os.clock(), which Bridge.lua points here. Desktop's is stock Lua 5.1's
    // clock(): CPU time the process has used, which stands still while the
    // client idles. emscripten's clock() is wall time since start, so a script
    // that waits 1.5s on a tempTimer read 1.5s where desktop reads ~0. A page
    // has no CPU-time clock, so this counts the time the main thread is busy
    // in the tasks that read it: the first reading in a task opens a segment,
    // and a microtask — which only runs once the synchronous Lua call that
    // read it has unwound — closes it and banks its length. Idle gaps between
    // tasks are never counted; a benchmark inside one call measures as it does
    // on desktop. Work in tasks that never read the clock (rendering, other
    // JS) is not counted either — see e2e/knownDivergences.ts.
    let cpuBanked = 0;
    let segmentStart: number | null = null;
    lua.global.set('__mudlet_cpu_clock', () => {
        const now = performance.now();
        if (segmentStart === null) {
            segmentStart = now;
            queueMicrotask(() => {
                if (segmentStart !== null) cpuBanked += performance.now() - segmentStart;
                segmentStart = null;
            });
        }
        return (cpuBanked + (now - segmentStart)) / 1000;
    });

    // registerAnonymousEventHandler is provided by Bridge.lua — it mirrors
    // Mudlet's C++ TLuaInterpreter::registerAnonymousEventHandler so module-
    // load-time registrations (Geyser etc.) made before Other.lua's Lua-side
    // override land in the native handler table dispatched from
    // __mudlet_dispatch_event.

    // raiseEvent is defined in Bridge.lua, not here: dispatching in Lua keeps
    // its arguments Lua values, where a round trip through JS mangled tables.

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

