import type { BindingContext } from './context';

/**
 * Mudlet createTextEdit widgets - a plain multi-line text box addressed by
 * name, with get/set/append/clear and the usual geometry and styling setters.
 *  
 * Backed by TextEditManager, which is a pure data-model registry; the React
 * overlay renders whatever the model holds.
 */
export function installTextEditBindings({ lua, api, channel }: BindingContext): void {
    // ── Text edit widgets (Mudlet createTextEdit) ─────────────────────────
    // createTextEdit([parent,] name, x, y, w, h) → true. The delete/get/set/
    // property primitives below are __-prefixed and return bool/value; the
    // Bridge.lua wrappers reshape failures into Mudlet's (nil|false, errMsg).
    lua.global.set('createTextEdit', (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f?: unknown) => {
        const hasParent = f !== undefined;
        const [parent, name, x, y, w, h] = hasParent
            ? [a as string, b, c, d, e, f]
            : [undefined, a, b, c, d, e];
        if (typeof name !== 'string' || !name) return false;
        return api.textEdits.create(name, {
            parent: parent && parent !== 'main' ? (parent as string) : 'main',
            x: Number(x), y: Number(y), width: Number(w), height: Number(h),
        });
    });
    lua.global.set('__deleteTextEdit', (name: unknown) =>
        typeof name === 'string' ? api.textEdits.destroy(name) : false);
    // Returns the text (incl. "") on success or `false` when missing — the
    // Bridge wrapper distinguishes the empty string from the miss.
    lua.global.set('__getTextEditText', (name: unknown) => {
        if (typeof name !== 'string') return false;
        const t = api.textEdits.getText(name);
        return t === null ? false : t;
    });
    lua.global.set('__setTextEditText', (name: unknown, text: unknown) =>
        typeof name === 'string' ? api.textEdits.setText(name, String(text ?? '')) : false);
    lua.global.set('__clearTextEdit', (name: unknown) =>
        typeof name === 'string' ? api.textEdits.clear(name) : false);
    lua.global.set('__setTextEditReadOnly', (name: unknown, v: unknown) =>
        typeof name === 'string' ? api.textEdits.setReadOnly(name, !!v) : false);
    lua.global.set('__setTextEditPlaceholder', (name: unknown, t: unknown) =>
        typeof name === 'string' ? api.textEdits.setPlaceholder(name, String(t ?? '')) : false);
    lua.global.set('__setTextEditStyleSheet', (name: unknown, css: unknown) =>
        typeof name === 'string' ? api.textEdits.setStyleSheet(name, String(css ?? '')) : false);
    lua.global.set('__setTextEditFont', (name: unknown, font: unknown) =>
        typeof name === 'string' ? api.textEdits.setFont(name, String(font ?? '')) : false);
    lua.global.set('__setTextEditFontSize', (name: unknown, size: unknown) =>
        typeof name === 'string' ? api.textEdits.setFontSize(name, Number(size)) : false);
    lua.global.set('__setTextEditTabMovesFocus', (name: unknown, v: unknown) =>
        typeof name === 'string' ? api.textEdits.setTabMovesFocus(name, !!v) : false);
    // Mudlet `createBuffer(name)`. Off-screen text buffer (no panel) for
    // formatting/storing rich text — like a hidden miniconsole.
    lua.global.set('createBuffer', (name: unknown) => {
        if (typeof name === 'string') api.createBuffer(name);
    });
    // Mudlet `copy([window])`. Copies the current selection (with formatting)
    // into the session clipboard for paste()/appendBuffer().
    lua.global.set('copy', (name?: unknown) =>
        api.copy(typeof name === 'string' ? name : undefined));
    // Mudlet `cut()`. copy() plus the deletion of what was copied. No window
    // argument in Mudlet — it only ever acts on the main console.
    lua.global.set('cut', () => api.cut());
    // Mudlet `paste([window])`. Pastes the clipboard at the cursor (or
    // appends at the end when the cursor is on the last line).
    lua.global.set('paste', (name?: unknown) =>
        api.paste(typeof name === 'string' ? name : undefined));
    // Mudlet `appendBuffer([window])`. Appends the copied rich text as a new
    // line to the named window/buffer (defaults to main).
    lua.global.set('appendBuffer', (name?: unknown) =>
        api.appendBuffer(typeof name === 'string' ? name : undefined));
    // createMapper has two calling conventions:
    //   createMapper(x, y, w, h)             — 4 args, embedded in main window
    //   createMapper(parent, x, y, w, h)     — 5 args, embedded in a userwindow
    // Singleton: subsequent calls reposition the existing mapper.
    lua.global.set('createMapper', (a: unknown, b: unknown, c: unknown, d: unknown, e?: unknown) => {
        const hasParent = e !== undefined;
        const [parent, x, y, w, h] = hasParent
            ? [a as string, b, c, d, e]
            : [undefined, a, b, c, d];
        return api.createMapper(
            Number(x), Number(y),
            Number(w), Number(h),
            parent,
        );
    });
    lua.global.set('clearWindow',  (name?: string) => api.clearWindow(name));
    // hide/show/move/resize work on both labels and userwindows. Labels take
    // precedence: name uniqueness is shared across them, but createLabel can
    // race with openUserWindow under the same string.
    lua.global.set('hideWindow', (name: string) => {
        if (api.labels.has(name)) api.labels.hide(name);
        else if (api.cmdLines.has(name)) api.cmdLines.hide(name);
        else if (api.textEdits.has(name)) api.textEdits.hide(name);
        else if (api.scrollBoxes.has(name)) api.scrollBoxes.hide(name);
        else api.windows.hide(name);
    });
    // Mudlet showWindow(name) → bool. Returns true when the named label,
    // overlay command line, scroll box, or userwindow exists and is now
    // visible; false when nothing matches.
    lua.global.set('showWindow', (name: string) => {
        if (typeof name !== 'string' || !name) return false;
        if (api.labels.has(name)) return api.labels.show(name);
        if (api.cmdLines.has(name)) return api.cmdLines.show(name);
        if (api.textEdits.has(name)) return api.textEdits.show(name);
        if (api.scrollBoxes.has(name)) return api.scrollBoxes.show(name);
        return api.windows.show(name);
    });
    // Geometry crosses into Mudlet as C++ ints, so a fractional pixel is
    // truncated there before any widget sees it. Geyser routinely produces
    // fractions — a "20%" constraint on a 632px window is 126.4, and an HBox
    // splitting a remainder lands on 200.00000000000099 — and its own specs
    // assert the floored value. Doing the same here keeps the readback honest
    // and stops float dust accumulating across repeated re-layouts.
    const px = (v: unknown): number => Math.trunc(Number(v));
    lua.global.set('moveWindow', (name: string, x: unknown, y: unknown) => {
        const xn = px(x), yn = px(y);
        if (api.labels.has(name)) api.labels.move(name, xn, yn);
        else if (api.cmdLines.has(name)) api.cmdLines.move(name, xn, yn);
        else if (api.textEdits.has(name)) api.textEdits.move(name, xn, yn);
        else if (api.scrollBoxes.has(name)) api.scrollBoxes.move(name, xn, yn);
        else if (api.windows.has(name)) api.windows.move(name, xn, yn);
    });
    lua.global.set('resizeWindow', (name: string, w: unknown, h: unknown) => {
        const wn = px(w), hn = px(h);
        if (api.labels.has(name)) api.labels.resize(name, wn, hn);
        else if (api.cmdLines.has(name)) api.cmdLines.resize(name, wn, hn);
        else if (api.textEdits.has(name)) api.textEdits.resize(name, wn, hn);
        else if (api.scrollBoxes.has(name)) api.scrollBoxes.resize(name, wn, hn);
        else if (api.windows.has(name)) api.windows.resize(name, wn, hn);
    });
    // Window state getters. Each returns null for "no such widget" so the
    // Bridge.lua wrapper can build Mudlet's (nil, errMsg) pair; geometry comes
    // back as an object the wrapper spreads into four return values.
    lua.global.set('__getWindowGeometry', (name: unknown) =>
        (typeof name === 'string' ? api.getWindowGeometry(name) : null));
    // Wrapped in an object rather than returned bare: a bare `false` (hidden)
    // and `null` (no such window) would both arrive on the Lua side as falsy,
    // and the two cases have to stay distinguishable.
    lua.global.set('__windowVisible', (name: unknown) => {
        const v = typeof name === 'string' ? api.windowVisible(name) : null;
        return v === null ? null : { visible: v };
    });
    lua.global.set('__getLabelText', (name: unknown) =>
        (typeof name === 'string' ? api.getLabelText(name) : null));
    // Mudlet setWindow(windowName, name[, x, y, show]) → bool. Reparents a
    // label / cmdline / scroll box / miniconsole into another window
    // ('main', a userwindow, or a scroll box). Geyser's setContainerWindow
    // and GUIUtils' setGaugeWindow drive this.
    lua.global.set('setWindow', (windowName: unknown, name: unknown, x?: unknown, y?: unknown, show?: unknown) => {
        if (typeof windowName !== 'string' || typeof name !== 'string') return false;
        return api.setWindow(
            windowName, name,
            Number(x ?? 0), Number(y ?? 0),
            show === undefined ? true : !!show,
        );
    });
    // Mudlet setUserWindowTitle(name, [title]) → bool. Empty/missing title
    // resets to the window's id; missing window returns false.
    lua.global.set('setUserWindowTitle', (name: unknown, title?: unknown) => {
        if (typeof name !== 'string' || !name) return false;
        const t = title == null ? undefined : String(title);
        return api.windows.setTitle(name, t);
    });

    // Mudlet setBackgroundColor:
    //   setBackgroundColor(r, g, b [, a])           → main window
    //   setBackgroundColor(name, r, g, b [, a])     → named userwindow / miniconsole / label
    // Each channel is validated as a 0-255 integer (matches setFgColor /
    // setBgColor); invalid args return false without mutating state.
    // Returns true on success.
    lua.global.set('setBackgroundColor', (a: unknown, b: unknown, c: unknown, d?: unknown, e?: unknown) => {
        const hasName = typeof a === 'string';
        const r = channel(hasName ? b : a);
        const g = channel(hasName ? c : b);
        const bb = channel(hasName ? d : c);
        if (r === null || g === null || bb === null) return false;
        const aRaw = hasName ? e : d;
        const alpha = aRaw === undefined ? 255 : channel(aRaw);
        if (alpha === null) return false;
        return api.setBackgroundColor(
            hasName ? (a as string) : undefined,
            r, g, bb, alpha,
        );
    });

    // Mudlet `getBackgroundColor([name])`. Returns the rgba channels on
    // success or `(nil, errMsg)` when the named window doesn't resolve.
    // The raw entry point hands JS a 0-indexed [r, g, b, a] array, or null
    // for the miss case; Bridge.lua unpacks both into the documented
    // multi-return. The main window always resolves (defaults to
    // {0, 0, 0, 255} when no override is set).
    lua.global.set('__getBackgroundColor', (name?: unknown) => {
        const win = typeof name === 'string' && name && name !== 'main' ? name : undefined;
        if (win && !api.labels.has(win) && !api.windows.has(win)) {
            return null;
        }
        const c = api.getBackgroundColor(win) ?? { r: 0, g: 0, b: 0, a: 255 };
        return [c.r, c.g, c.b, c.a];
    });

    // Mudlet `setBackgroundImage` — overloaded across labels, miniconsoles,
    // userwindows, and the main window. The GUIUtils.lua wrapper has
    // already coerced any string mode ("center", "tile", …) into a number
    // by the time this binding fires, so the second/third arg's runtime
    // type is enough to disambiguate. All overload routing lives in
    // ScriptingAPI.setBackgroundImage — keep the binding thin so the
    // C++/Lua overload set stays in one place.
    lua.global.set('setBackgroundImage', (a: unknown, b?: unknown, c?: unknown) => {
        if (typeof a !== 'string') return false;
        if (b === undefined) return api.setBackgroundImage(a);
        if (c === undefined) {
            if (typeof b === 'number') return api.setBackgroundImage(a, b);
            if (typeof b === 'string') return api.setBackgroundImage(a, b);
            return false;
        }
        if (typeof b !== 'string') return false;
        return api.setBackgroundImage(a, b, Number(c));
    });

    // Mudlet `resetBackgroundImage([windowName])`. No name → main window.
    lua.global.set('resetBackgroundImage', (name?: unknown) => {
        return api.resetBackgroundImage(typeof name === 'string' ? name : undefined);
    });
}

