import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type React from 'react';
import type { CmdLineHost, CmdLineView, SubCommandLine } from './subCommandLine';

interface Options {
    model: SubCommandLine;
    host: () => CmdLineHost;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    /** The line's live text (what getCmdLine reads), kept current by the caller. */
    valueRef: MutableRefObject<string>;
    setValue: (text: string) => void;
    /** Hand one command (one line of the box) to the action, or the game. */
    dispatch: (command: string) => void;
    /** The text a script put on this line (printCmdLine and the like) while
     *  the commands ran, marking it applied; null when none did. */
    takeScripted: () => string | null;
}

/**
 * Key handling for a named command line — the createCommandLine overlay and a
 * miniconsole's / user window's own line — driving {@link SubCommandLine}, the
 * port of desktop's TCommandLine. Returns the textarea's onKeyDown and
 * onChange.
 *
 * The keys desktop's TCommandLine::event takes for itself are taken here too:
 * Enter sends, Shift+Enter starts another line in the box, Up/Down walk the
 * history, Tab and Shift+Tab complete, Escape selects everything. Only a Tab
 * on an empty line, or after a space, is let through, as on the main command
 * line, so the keyboard can still leave the box (WCAG 2.1.2).
 */
export function useSubCommandLineKeys({ model, host, inputRef, valueRef, setValue, dispatch, takeScripted }: Options) {
    // A selection to apply once React has put the new text in the textarea:
    // writing a controlled value moves the caret to the end.
    const pending = useRef<CmdLineView | null>(null);
    const [tick, setTick] = useState(0);
    useLayoutEffect(() => {
        const want = pending.current;
        if (!want) return;
        pending.current = null;
        const el = inputRef.current;
        if (el && el.value === want.text) el.setSelectionRange(want.start, want.end);
    }, [tick, inputRef]);

    const show = useCallback((view: CmdLineView) => {
        valueRef.current = view.text;
        pending.current = view;
        setValue(view.text);
        setTick(t => t + 1);
    }, [setValue, valueRef]);

    const current = (): CmdLineView => {
        const el = inputRef.current;
        const text = valueRef.current;
        return {
            text,
            start: el?.selectionStart ?? text.length,
            end: el?.selectionEnd ?? text.length,
        };
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing) return;
        const mods = e.ctrlKey || e.metaKey || e.altKey;
        switch (e.key) {
            case 'Enter': {
                e.preventDefault();
                if (mods) return;
                if (e.shiftKey) {
                    const { text, start, end } = current();
                    model.edited();
                    const next = text.slice(0, start) + '\n' + text.slice(end);
                    show({ text: next, start: start + 1, end: start + 1 });
                    return;
                }
                const h = host();
                const { commands, after } = model.enter(valueRef.current, h);
                // The box keeps its text while the commands run, so an action
                // reading getCmdLine() sees all of it, as on desktop.
                for (const command of commands) dispatch(command);
                // TCommandLine::enterCommand clears or selects only after the
                // commands ran: a cleared line drops what an action printed
                // there, a kept one selects whatever the line now holds.
                const scripted = takeScripted();
                show(scripted !== null && !h.autoClear()
                    ? { text: scripted, start: 0, end: scripted.length }
                    : after);
                return;
            }
            case 'Tab': {
                if (mods) return;
                const view = current();
                if (view.text === '' || /\s$/.test(view.text)) return;
                e.preventDefault();
                const done = model.tabComplete(e.shiftKey ? -1 : 1, view, host());
                if (done) show(done.view);
                return;
            }
            case 'ArrowUp':
            case 'ArrowDown': {
                if (mods || e.shiftKey) return;
                e.preventDefault();
                const next = model.historyMove(e.key === 'ArrowUp', current(), host());
                if (next) show(next);
                return;
            }
            case 'Escape': {
                if (mods || e.shiftKey) return;
                e.preventDefault();
                show(model.escape(current()));
                return;
            }
        }
    };

    const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        model.edited();
        valueRef.current = e.target.value;
        setValue(e.target.value);
    };

    return { onKeyDown, onChange };
}
