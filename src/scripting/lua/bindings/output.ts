import type { BindingContext } from './context';

/**
 * Console output and text formatting: the echo family's targets, foreground/
 * background pens, bold/italic/underline/strikethrough attributes, hyperlink
 * and popup insertion, and the format-state reset primitives.
 *  
 * Colour channels are validated through the shared 0..255 coercion; Mudlet
 * silently no-ops on an out-of-range channel rather than raising.
 */
export function installOutputBindings({ lua, api }: BindingContext): void {
    // ── Output / format ───────────────────────────────────────────────────
    lua.global.set('fg',          (name: string)  => api.fg(name));
    lua.global.set('bg',          (name: string)  => api.bg(name));
    // insertText([window,] text). Mudlet's xEcho passes (win, segment) into
    // _G["insertText"] for cinsertText/creplace/prefix; without the window
    // overload the window name lands in the text slot and the actual segment
    // is dropped, producing a wall of "main"s. The API itself decides where
    // to write (lineBuffer at cursor inside triggers, echo otherwise).
    lua.global.set('insertText', (a: string, b?: string) => {
        if (b !== undefined) api.insertText(b, a);
        else                 api.insertText(a);
    });
    lua.global.set('feedTriggers',(text: string)  => api.feedTriggers(text));
    lua.global.set('deleteLine',  (win?: string)  => api.deleteLine(win));
    // Mudlet `wrapLine([window,] lineNumber)`. Re-displays a line, re-wrapping
    // it and interpreting embedded \n. Overloaded: a string first arg is the
    // window (lineNumber follows); a number first arg targets the main window.
    lua.global.set('wrapLine', (a: unknown, b?: unknown) => {
        if (typeof a === 'string') return api.wrapLine(Number(b), a);
        return api.wrapLine(Number(a));
    });
    // Mudlet `printError(msg, [showStackTrace], [haltExecution])`. mudix
    // routes every script-emitted error through the same logging path so
    // there's no JS-level stack to render; we accept the optional flags for
    // signature parity and honour `haltExecution=true` by raising a Lua
    // error so the calling script aborts (Mudlet's behaviour).
    lua.global.set('printError', (text: unknown, _showStack?: unknown, haltExec?: unknown) => {
        api.printError(String(text ?? ''));
        if (haltExec) {
            throw new Error(typeof text === 'string' ? text : String(text));
        }
    });
    // echoLink primitive — always string cmd. Function-cmd conversion is done
    // by the Lua wrapper installed later in the doString block.
    lua.global.set('echoLink', (a: unknown, b: unknown, c: unknown, d?: unknown, e?: unknown) => {
        // Calling conventions (Mudlet-compatible):
        //   echoLink(text, cmd, tooltip [, useCurrentFormat])           — 3-4 args, no window
        //   echoLink(window, text, cmd, tooltip [, useCurrentFormat])   — 4-5 args, with window
        // Distinguish by typeof d: 'string' = tooltip (window form), 'boolean'|undefined = useCurrentFormat
        const hasWindow = typeof d === 'string';
        const win = hasWindow ? (a as string) : undefined;
        const text = hasWindow ? (b as string) : (a as string);
        const cmd = hasWindow ? (c as string) : (b as string);
        const tooltip = hasWindow ? (d as string) : (c as string);
        const useCurrentFormat = !!(hasWindow ? e : d);
        // Mudlet validates each argument up front and raises when the call is
        // missing them outright; returns true once the span is written.
        if (typeof text !== 'string' || typeof cmd !== 'string') {
            throw new Error('echoLink: bad argument (text and command as strings expected)');
        }
        api.echoLink(text, cmd, tooltip, win, useCurrentFormat);
        return true;
    });

    // insertLink primitive — same overload set as echoLink, but inserts at the
    // cursor on the current line instead of echoing to the end of the buffer.
    // Lua-side `cinsertLink`/`dinsertLink`/`hinsertLink` (in mudlet-lua/GUIUtils)
    // route here via xEcho.
    lua.global.set('insertLink', (a: unknown, b: unknown, c: unknown, d?: unknown, e?: unknown) => {
        const hasWindow = typeof d === 'string';
        const win = hasWindow ? (a as string) : undefined;
        const text = hasWindow ? (b as string) : (a as string);
        const cmd = hasWindow ? (c as string) : (b as string);
        const tooltip = hasWindow ? (d as string) : (c as string);
        const useCurrentFormat = !!(hasWindow ? e : d);
        if (typeof text !== 'string' || typeof cmd !== 'string') {
            throw new Error('insertLink: bad argument (text and command as strings expected)');
        }
        api.insertLink(text, cmd, tooltip, win, useCurrentFormat);
        return true;
    });

    // Mudlet `setLink([window,] cmd, hint)` — applies the link to the current
    // selection. Function-cmd conversion is done in Bridge.lua (same pattern
    // as echoLink). Disambiguate by argc: 3 strings → with-window, 2 → main.
    lua.global.set('setLink', (a: unknown, b: unknown, c?: unknown) => {
        const hasWindow = typeof c === 'string';
        const win = hasWindow ? (a as string) : undefined;
        const cmd = hasWindow ? (b as string) : (a as string);
        const hint = hasWindow ? (c as string) : (b as string);
        return api.setLink(cmd ?? '', hint ?? '', win);
    });

    // Lua wrapper converts cmds/hints tables to \x01-delimited strings before calling here.
    // xEcho always passes (win, text, cmds_str, hints_str, fmt); win defaults to "main".
    lua.global.set('echoPopup', (win: unknown, text: unknown, cmds: unknown, hints: unknown, fmt?: unknown) => {
        const textStr = text as string;
        if (!textStr) return;
        const split = (s: unknown) => s ? String(s).split('\x01').filter(Boolean) : [];
        const cmdsArr = split(cmds);
        const hintsArr = split(hints);
        const winStr = (win && win !== 'main') ? win as string : undefined;
        api.echoPopup(textStr, cmdsArr, hintsArr, winStr, !!fmt);
        return true;
    });

    // insertPopup primitive — same \x01-flatten convention as echoPopup, but
    // inserts the popup span at the cursor instead of appending. The Lua
    // wrapper (Bridge.lua) handles overload disambiguation + table flatten;
    // cinsertPopup/dinsertPopup/hinsertPopup (GUIUtils.lua) route here via xEcho.
    lua.global.set('insertPopup', (win: unknown, text: unknown, cmds: unknown, hints: unknown, fmt?: unknown) => {
        const textStr = text as string;
        if (!textStr) return;
        const split = (s: unknown) => s ? String(s).split('\x01').filter(Boolean) : [];
        const winStr = (win && win !== 'main') ? win as string : undefined;
        api.insertPopup(textStr, split(cmds), split(hints), winStr, !!fmt);
        return true;
    });

    // setPopup primitive — attaches a popup to the current selection. The Lua
    // wrapper normalizes the optional window arg and flattens cmds/hints.
    lua.global.set('setPopup', (win: unknown, cmds: unknown, hints: unknown) => {
        const split = (s: unknown) => s ? String(s).split('\x01').filter(Boolean) : [];
        const winStr = (win && win !== 'main') ? win as string : undefined;
        return api.setPopup(split(cmds), split(hints), winStr);
    });

    // Mudlet `openWebPage(url) → bool`. Opens the URL in the user's
    // default browser; returns false when the popup is blocked or the URL
    // is empty.
    lua.global.set('openWebPage', (url: unknown) => {
        const u = typeof url === 'string' ? url.trim() : '';
        if (!u) return false;
        const w = window.open(u, '_blank');
        return !!w;
    });

    // Mudlet `openUrl(url)`. Like openWebPage for http(s) URLs, but a
    // `file:` prefix routes to the VFS file browser — that's how Mudlet
    // scripts expose VFS paths to the user (`openUrl("file:" .. getMudletHomeDir())`).
    lua.global.set('openUrl', (url: unknown) => {
        return api.openUrl(typeof url === 'string' ? url : '');
    });
}

