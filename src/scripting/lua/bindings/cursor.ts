import type { BindingContext } from './context';

/**
 * Line, cursor, and scrollback inspection: reading the buffer, moving the
 * output cursor, scrolling, wrap settings, column/row geometry, and the
 * selection primitives triggers use to recolour matched text.
 *  
 * Mudlet models a console as a cursor over a line buffer, so most of these are
 * stateful with respect to the currently selected window.
 */
export function installCursorBindings({ lua, api }: BindingContext): void {
    // ── Line / cursor inspection ──────────────────────────────────────────
    // Mudlet `isPrompt([window])` — reports the per-line prompt flag for
    // the line at the current cursor position. ScriptingAPI tags the buffer
    // when beginLine() runs the trigger pass, so historical lines remain
    // queryable via moveCursor + isPrompt (not just the most recent line).
    lua.global.set('isPrompt', (win?: unknown) =>
        api.isPrompt(typeof win === 'string' ? win : undefined));
    // Mudlet `getCurrentLine([window])` → line text, or `(nil, errMsg)` for
    // a non-existent named window. The raw entry point hands JS `null` for
    // the miss case; Bridge.lua re-shapes it into the documented multi-return.
    lua.global.set('__getCurrentLine', (win?: string) => api.getCurrentLine(win));
    // Mudlet `getTimestamp([console_name,] lineNumber)`. Optional leading
    // window name; lineNumber is 1-based. Returns the formatted time string
    // or false (miss) — Bridge.lua maps false to Mudlet's (nil, errMsg).
    lua.global.set('__getTimestamp', (a?: unknown, b?: unknown) => {
        if (typeof a === 'string') {
            return api.getTimestamp(b === undefined ? undefined : Number(b), a) ?? false;
        }
        return api.getTimestamp(a === undefined ? undefined : Number(a)) ?? false;
    });
    lua.global.set('getLineNumber',  (win?: string)=> api.getLineNumber(win));
    lua.global.set('getLineCount',   (win?: string)=> api.getLineCount(win));
    lua.global.set('getLastLineNumber', (win?: string)=> api.getLastLineNumber(win));
    // Mudlet [enable|disable][Horizontal]ScrollBar([windowName])
    const scrollWin = (win?: unknown) => typeof win === 'string' ? win : undefined;
    lua.global.set('disableScrollBar',           (win?: unknown) => api.disableScrollBar(scrollWin(win)));
    lua.global.set('enableScrollBar',            (win?: unknown) => api.enableScrollBar(scrollWin(win)));
    lua.global.set('disableHorizontalScrollBar', (win?: unknown) => api.disableHorizontalScrollBar(scrollWin(win)));
    lua.global.set('enableHorizontalScrollBar',  (win?: unknown) => api.enableHorizontalScrollBar(scrollWin(win)));
    lua.global.set('disableScrolling',           (win?: unknown) => api.disableScrolling(scrollWin(win)));
    lua.global.set('enableScrolling',            (win?: unknown) => api.enableScrolling(scrollWin(win)));
    lua.global.set('scrollingActive', (win?: unknown) => api.scrollingActive(scrollWin(win)));
    // Mudlet enable/disableTimeStamps(window) + timeStampsEnabled(window). The
    // renderer already draws the column (the main output's context menu toggles
    // the same thing) — these just drive it per console from a script.
    lua.global.set('__timeStampsEnabled', (win?: unknown) =>
        api.timeStampsEnabled(typeof win === 'string' ? win : 'main'));
    lua.global.set('__setTimeStamps', (win: unknown, visible: unknown) =>
        api.setTimeStamps(typeof win === 'string' ? win : 'main', !!visible));
    // Mudlet getScroll([windowName]) — buffer line index at viewport top.
    lua.global.set('getScroll', (win?: unknown) => api.getScroll(scrollWin(win)));
    // Mudlet scrollTo([windowName,] [lineNumber]). With no line (or no args)
    // resume tail mode. Wasmoon hands regex captures as strings, so the
    // numeric branch wraps with Number().
    lua.global.set('scrollTo', (a?: unknown, b?: unknown) => {
        if (typeof a === 'string') {
            return api.scrollTo(a, b === undefined ? undefined : Number(b));
        }
        if (a === undefined) return api.scrollTo(undefined, undefined);
        return api.scrollTo(undefined, Number(a));
    });
    lua.global.set('getColumnNumber',(win?: string)=> api.getColumnNumber(win));
    lua.global.set('getColumnCount', (win?: string)=> api.getColumnCount(win));
    lua.global.set('getRowCount',    (win?: string)=> api.getRowCount(win));
    // setWindowWrap(windowName, charsPerLine) — Mudlet shape. The name arg
    // is required; non-string raises a bad-argument error so scripts that
    // forgot the name (the no-arg "shorthand") see the same failure they
    // would in Mudlet.
    lua.global.set('setWindowWrap', (a: unknown, b?: unknown) => {
        if (typeof a !== 'string') {
            throw new Error('setWindowWrap: bad argument #1 type (window name as string expected, got ' + typeof a + ')');
        }
        return api.setWindowWrap(a, Number(b));
    });
    // Mudlet getWindowWrap(windowName) → wrap columns (0 unset, -1 missing).
    lua.global.set('getWindowWrap', (name: unknown) =>
        api.getWindowWrap(typeof name === 'string' ? name : 'main'));
    // Mudlet setWindowWrapIndent(windowName, indentSize) — indent of
    // newline-started lines. setWindowWrapHangingIndent — indent of wrapped
    // continuation lines. Number() because regex captures arrive as strings.
    lua.global.set('setWindowWrapIndent', (name: unknown, indent: unknown) =>
        api.setWindowWrapIndent(typeof name === 'string' ? name : 'main', Number(indent)));
    lua.global.set('setWindowWrapHangingIndent', (name: unknown, indent: unknown) =>
        api.setWindowWrapHangingIndent(typeof name === 'string' ? name : 'main', Number(indent)));
    // Mudlet setMapWindowTitle(title) — empty title resets to the default.
    lua.global.set('setMapWindowTitle', (title: unknown) =>
        api.setMapWindowTitle(String(title ?? '')));
    // Mudlet isAnsiFgColor/isAnsiBgColor(ansiColor). Number() because regex
    // captures arrive from Lua as strings.
    lua.global.set('isAnsiFgColor', (c: unknown) => api.isAnsiFgColor(Number(c)));
    lua.global.set('isAnsiBgColor', (c: unknown) => api.isAnsiBgColor(Number(c)));
    // Mudlet getConsoleBufferSize([consoleName]) → linesLimit, batchSize.
    // JS returns a 0-indexed [limit, batch] array (or nil for a missing
    // console); Bridge.lua unpacks it to the two return values.
    lua.global.set('__getConsoleBufferSize', (win?: unknown) =>
        api.getConsoleBufferSize(typeof win === 'string' ? win : undefined));
    // Mudlet setConsoleBufferSize([consoleName,] linesLimit, sizeOfBatchDeletion).
    // A leading string is the console name; otherwise the args apply to the
    // main window.
    // Bridge.lua owns the overload split, the clamping contract and the
    // (nil, message) shapes; this takes the resolved arguments.
    lua.global.set('__setConsoleBufferSize', (
        name?: unknown, lines?: unknown, batch?: unknown, useMaximum?: unknown,
    ) => api.setConsoleBufferSize(
        typeof name === 'string' ? name : undefined,
        Number(lines),
        batch === undefined || batch === null ? undefined : Number(batch),
        useMaximum === true,
    ));
    // getLines([window,] from, to) — JS array crosses wasmoon as a
    // 0-indexed Lua table; the Bridge.lua wrapper rebuilds it as a
    // 1-indexed sequence so `ipairs` works as Mudlet scripts expect.
    lua.global.set('__getLines', (a: string | number, b: number, c?: number) => {
        return c !== undefined
            ? api.getLines(b, c, a as string)
            : api.getLines(a as number, b);
    });
    // Mudlet moveCursorUp/Down([window,] [lines=1,] [keepHorizontal=false]).
    // Disambiguate by type of the first arg: a leading string is the window
    // name; a leading number is the lines count (window defaults to main).
    const parseMoveLineArgs = (a: unknown, b: unknown, c: unknown): [string | undefined, number, boolean] => {
        if (typeof a === 'string') {
            const lines = b === undefined ? 1 : Number(b);
            const keep = !!c;
            return [a, Number.isFinite(lines) ? lines : 1, keep];
        }
        if (a === undefined) return [undefined, 1, false];
        const lines = Number(a);
        const keep = !!b;
        return [undefined, Number.isFinite(lines) ? lines : 1, keep];
    };
    lua.global.set('moveCursorUp', (a?: unknown, b?: unknown, c?: unknown) => {
        const [win, lines, keep] = parseMoveLineArgs(a, b, c);
        return api.moveCursorUp(win, lines, keep);
    });
    lua.global.set('moveCursorDown', (a?: unknown, b?: unknown, c?: unknown) => {
        const [win, lines, keep] = parseMoveLineArgs(a, b, c);
        return api.moveCursorDown(win, lines, keep);
    });
    lua.global.set('moveCursorEnd',  (win?: string)=> api.moveCursorEnd(win));
    // moveCursor([window,] x, y) → bool. Mudlet returns true on success.
    lua.global.set('moveCursor', (a: string | number, b: number, c?: number) => {
        return c !== undefined
            ? api.moveCursor(a as string, b, c)
            : api.moveCursor(undefined, a as number, b);
    });
    lua.global.set('selectString', (a: string, b: string | number, c?: number) => {
        // selectString([window,] text, occurrence)
        return c !== undefined ? api.selectString(b as string, c, a) : api.selectString(a, b as number);
    });
    lua.global.set('selectSection', (a: string | number, b: number, c?: number) => {
        // selectSection([window,] from, length) → bool
        return c !== undefined
            ? api.selectSection(b, c, a as string)
            : api.selectSection(a as number, b);
    });
    lua.global.set('selectCurrentLine', (win?: string) => api.selectCurrentLine(win));
    // Mudlet getSelection([window]) → text, start, length (3 returns) or
    // false, errMsg. The wasmoon → Lua boundary returns one value, so we
    // hand back a 0-indexed [text, start, length] array (or null) and let
    // Bridge.lua unpack into the documented multi-return.
    lua.global.set('__getSelection', (win?: string) => {
        const sel = api.getSelection(win);
        return sel ? [sel.text, sel.start, sel.length] : null;
    });

    // Mudlet getFgColor([window]) / getBgColor([window]) → r, g, b at the
    // current selection's start position, or no values when there is no
    // selection / the cursor sits past the end of the line. The JS side
    // hands back a 0-indexed [r, g, b] array or null; Bridge.lua unpacks.
    lua.global.set('__getFgColor', (win?: unknown) => {
        const rgb = api.getFgColor(typeof win === 'string' ? win : undefined);
        return rgb ?? null;
    });
    lua.global.set('__getBgColor', (win?: unknown) => {
        const rgb = api.getBgColor(typeof win === 'string' ? win : undefined);
        return rgb ?? null;
    });

    // Mudlet getTextFormat([window]) → table of the display attributes at the
    // current selection's start, or (nil, errMsg) when there is no usable
    // selection. wasmoon's nested-table marshalling is unreliable, so JS
    // hands back a flat 0-indexed array of primitives and Bridge.lua rebuilds
    // the documented table (with 1-indexed foreground/background triples).
    lua.global.set('__getTextFormat', (win?: unknown) => {
        const f = api.getTextFormat(typeof win === 'string' ? win : undefined);
        if (!f) return null;
        return [
            f.bold, f.italic, f.underline, f.strikeout, f.reverse,
            f.overline, f.concealed, f.alternateFont, f.blinking,
            f.foreground[0], f.foreground[1], f.foreground[2],
            f.background[0], f.background[1], f.background[2],
        ];
    });
}

