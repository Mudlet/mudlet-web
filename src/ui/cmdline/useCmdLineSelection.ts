import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Where a script left the command line's caret: at the end with nothing
 *  selected (printCmdLine, appendCmdLine), or around all of it
 *  (selectCmdLineText, sendCmdLine). */
export type CmdLineSelection = 'end' | 'all';

/**
 * Place a command line's caret or selection once the text a script put there
 * has actually reached the input.
 *
 * A script's printCmdLine only reaches the input through React state, so the
 * new value lands on the next commit — and writing a controlled input's value
 * moves its caret to the end, wiping any selection made before it. Applying
 * the selection straight away (or from a microtask, which runs before a
 * render scheduled from a timer) is how `printCmdLine("ghi");
 * selectCmdLineText()` left nothing selected, so the next keystroke appended
 * instead of replacing (issue #284). Desktop applies both to the widget
 * synchronously, so the later call always wins; here the latest request is
 * held and applied in a layout effect after the commit that carries the text.
 *
 * `value` is the input's controlled value. The returned function records a
 * request and forces a render, so a request with no text change still lands.
 * A script's request also focuses the input; `focus: false` is for the
 * client's own selection after a send, which must not pull focus back to an
 * input the send just let go of (a phone's keyboard).
 */
export function useCmdLineSelection(
    inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
    value: string,
): (selection: CmdLineSelection | null, focus?: boolean) => void {
    const pending = useRef<{ selection: CmdLineSelection; focus: boolean } | null>(null);
    const [tick, setTick] = useState(0);
    useLayoutEffect(() => {
        const want = pending.current;
        if (!want) return;
        pending.current = null;
        const el = inputRef.current;
        if (!el) return;
        if (want.focus) el.focus();
        const len = el.value.length;
        el.setSelectionRange(want.selection === 'all' ? 0 : len, len);
    }, [tick, value, inputRef]);
    // null drops a request still waiting — the line was cleared after it.
    return useCallback((selection: CmdLineSelection | null, focus = true) => {
        pending.current = selection ? { selection, focus } : null;
        if (selection) setTick(t => t + 1);
    }, []);
}
