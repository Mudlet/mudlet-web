import type { BindingContext } from './context';

/**
 * Main-window and user-window geometry, border sizes/colours, and the Mudlet
 * 4.21 memory-introspection helpers.
 *  
 * Borders here are the *main console's* insets (Mudlet's setBorderTop and
 * friends), not per-window padding - they shrink the area the MUD output wraps
 * into, which is how Geyser reserves room for docked labels and gauges.
 */
export function installWindowBindings({ lua, api, channel }: BindingContext): void {
    // ── Window geometry ───────────────────────────────────────────────────
    // Returns [w, h] from JS; a Lua wrapper below unpacks it to two values.
    // __getUserWindowSize returns null when the window doesn't exist so
    // Bridge.lua can shape it as (nil, errMsg) (Mudlet miss-shape).
    lua.global.set('__getMainWindowSize', () => api.getMainWindowSize());
    /**
     * Mudlet `setMainWindowSize(width, height)` resizes the application window.
     * A browser tab cannot resize itself — `window.resizeTo` is refused for
     * anything the script did not open — so this reports the attempt and changes
     * nothing.
     *
     * Bound rather than left out: Bridge.lua wraps it for its argument contract
     * and captured a nil, so every call died on "attempt to call upvalue" rather
     * than doing nothing. Doing nothing is the honest answer, and callers that
     * measure afterwards (Mudlet's own specs among them) see the size did not
     * move and take the "this display does not honour a resize" path a tiling
     * window manager would put them on.
     */
    lua.global.set('setMainWindowSize', () => true);
    lua.global.set('__getMousePosition', () => api.getMousePosition());
    lua.global.set('__getUserWindowSize', (name: unknown) => {
        const n = String(name ?? '');
        // Mudlet resolves the default/"main" name to the main window, so
        // Geyser code (e.g. Label:onRightClick) that calls this with a
        // main-window label's windowname gets the viewport size, not nil.
        if (!n || n === 'main') return api.getMainWindowSize();
        if (!api.windows.has(n)) return null;
        return api.getUserWindowSize(n);
    });

    // setFontSize([windowName,] size) / getFontSize([windowName]) — Mudlet
    // overloads by arg count. Distinguish on first-arg type. The raw
    // primitives below return false / null for miss cases; Bridge.lua
    // re-shapes those into Mudlet's (nil, errMsg) multi-return.
    lua.global.set('__setFontSize', (a: unknown, b?: unknown) => {
        return (typeof a === 'string')
            ? api.setFontSize(Number(b), a)
            : api.setFontSize(Number(a));
    });
    lua.global.set('__getFontSize', (a?: unknown) => {
        const size = (typeof a === 'string')
            ? api.getFontSize(a)
            : api.getFontSize();
        return size ?? null;
    });

    // Mudlet setMiniConsoleFontSize(name, size) — miniconsole-only sibling
    // of setFontSize. Raw entry returns false on miss; Bridge.lua re-shapes
    // it into Mudlet's (nil, errMsg) failure shape.
    lua.global.set('__setMiniConsoleFontSize', (name: unknown, size: unknown) => {
        if (typeof name !== 'string') return false;
        return api.setMiniConsoleFontSize(name, Number(size));
    });

    // setFont([windowName,] family) / getFont([windowName]). Mudlet returns
    // (nil, errMsg) when the named window doesn't exist; Bridge.lua re-
    // shapes the JS bool/string from the raw primitives below.
    lua.global.set('__setFont', (a: unknown, b?: unknown) => {
        return (typeof b === 'string' || typeof b === 'number')
            ? api.setFont(String(b), String(a ?? ''))
            : api.setFont(String(a ?? ''));
    });
    lua.global.set('__getFont', (a?: unknown) => {
        const family = (typeof a === 'string')
            ? api.getFont(a)
            : api.getFont();
        return family ?? null;
    });

    // Mudlet getAvailableFonts() — set-style table {[family] = true}. JS
    // returns a plain object with string keys, which wasmoon converts to a
    // Lua table directly (same path as getBorderSizes). See ScriptingAPI
    // for what goes into the merged set.
    lua.global.set('getAvailableFonts', () => api.getAvailableFonts());

    // Mudlet calcFontSize(size [, family]) | calcFontSize(windowName).
    // Dispatches on first-arg type — Lua-style: numeric strings (e.g. from
    // a trigger capture) coerce to the size overload. Returns [w, h] from
    // JS; Bridge.lua unpacks to two values and shapes the miss case.
    lua.global.set('__calcFontSize', (a: unknown, b?: unknown) => {
        let arg: number | string;
        if (typeof a === 'number') {
            arg = a;
        } else if (typeof a === 'string') {
            const n = Number(a);
            arg = (a.trim() !== '' && Number.isFinite(n)) ? n : a;
        } else {
            return null;
        }
        const fname = (typeof b === 'string' || typeof b === 'number') ? String(b) : undefined;
        return api.calcFontSize(arg, fname);
    });

    // ── Borders ───────────────────────────────────────────────────────────
    // Mudlet setBorderTop/Bottom/Left/Right, setBorderSizes, setBorderColor.
    // Numeric coercion because trigger captures arrive as Lua strings.
    lua.global.set('setBorderTop',    (n: unknown) => api.setBorderTop(Number(n)));
    lua.global.set('setBorderBottom', (n: unknown) => api.setBorderBottom(Number(n)));
    lua.global.set('setBorderLeft',   (n: unknown) => api.setBorderLeft(Number(n)));
    lua.global.set('setBorderRight',  (n: unknown) => api.setBorderRight(Number(n)));

    // Mudlet setBorderSizes follows CSS-shorthand semantics:
    //   1 arg  → uniform
    //   2 args → (vertical, horizontal)
    //   3 args → (top, horizontal, bottom)
    //   4 args → (top, right, bottom, left)
    // ScriptingAPI.setBorderSizes does the case-split; we forward only the
    // args that were actually passed so the undefined slots stay undefined.
    lua.global.set('setBorderSizes', (a?: unknown, b?: unknown, c?: unknown, d?: unknown) => {
        const num = (v: unknown) => v === undefined ? undefined : Number(v);
        api.setBorderSizes(num(a), num(b), num(c), num(d));
    });

    lua.global.set('getBorderTop',    () => api.getBorderTop());
    lua.global.set('getBorderBottom', () => api.getBorderBottom());
    lua.global.set('getBorderLeft',   () => api.getBorderLeft());
    lua.global.set('getBorderRight',  () => api.getBorderRight());

    // Mudlet returns a Lua table {top, right, bottom, left}; wasmoon converts
    // a plain JS object the same way, so a direct return suffices.
    lua.global.set('getBorderSizes',  () => api.getBorderSizes());

    // Mudlet setBorderColor(r, g, b). Channels are validated as 0..255 ints
    // (same `channel()` helper used by setFgColor/setBgColor); invalid args
    // produce a silent no-op. Mudlet forces alpha to 255 — an alpha arg is
    // accepted for parity and ignored.
    lua.global.set('setBorderColor', (r: unknown, g: unknown, b: unknown, _a?: unknown) => {
        const rr = channel(r);
        const gg = channel(g);
        const bb = channel(b);
        if (rr === null || gg === null || bb === null) return;
        api.setBorderColor(rr, gg, bb, 255);
    });
    lua.global.set('resetBorderColor', () => api.resetBorderColor());

    // Mudlet getBorderColor() → r, g, b (the main console frame border).
    // Returns a JS array unpacked to three values by the Bridge.lua wrapper.
    lua.global.set('__getBorderColor', () => api.getBorderColor());

    // ── Memory introspection (Mudlet 4.21) ─────────────────────────────────
    // getProcessMemoryUsage() → Kb. Browser-adapted (JS heap, see ScriptingAPI).
    lua.global.set('getProcessMemoryUsage', () => api.getProcessMemoryUsage());
    // getSubsystemMemoryStats() → table. The JS side returns heap + subsystem
    // counts as a plain object (→ Lua table); the Bridge.lua wrapper adds the
    // Lua GC figure (collectgarbage), which is only observable from Lua.
    lua.global.set('__getSubsystemMemoryStats', () => api.getSubsystemMemoryStats());
}

