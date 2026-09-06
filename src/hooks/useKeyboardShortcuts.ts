import { useEffect, useRef } from 'react';
import { canonicalSequence, stepFromEvent, stepHasModifier } from '../ui/commands/keyMatch';

/**
 * Dispatching the client's own keyboard shortcuts, and any a package placed
 * with `addCommand`.
 *
 * Two things make this more than a switch on `event.key`:
 *
 *  - **It must fire while the player is typing.** The command line is a
 *    textarea and has the keyboard essentially all the time; a handler that
 *    bailed out on text-entry targets would be a shortcut system that never
 *    ran. So the guard is on the shortcut instead: a combination with a
 *    modifier is dispatched wherever focus is, a bare key only outside text
 *    entry — nobody should lose the letter E because a command is bound to it.
 *
 *  - **Qt sequences can have up to four steps** ("Ctrl+Alt+F1, Ctrl+Alt+F2"),
 *    and `addCommand` accepts them, so a keypress can be the start of something
 *    rather than the whole of it. Steps matched so far are held until one
 *    sequence completes, nothing can still match, or the player pauses.
 */

export interface ShortcutBinding {
    /** The Qt-style sequence, as written by a default or by the player. */
    shortcut: string;
    run: () => void;
}

/** How long a half-typed sequence waits for its next step. Qt has no timeout at
 *  all — a chord waits forever — but a browser tab is not a modal application:
 *  a forgotten prefix that swallows the next keystroke an hour later is worse
 *  than one that quietly gives up. */
const CHORD_TIMEOUT_MS = 1500;

function isTextEntry(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export function useKeyboardShortcuts(bindings: readonly ShortcutBinding[], enabled = true): void {
    // The listener is installed once and reads the current bindings through a
    // ref: they are rebuilt on every render (each closes over live state), and
    // re-subscribing a document listener that often would drop a keypress
    // between the removeEventListener and the addEventListener.
    const latest = useRef(bindings);
    latest.current = bindings;

    useEffect(() => {
        if (!enabled) return;
        let pending: string[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;

        const reset = () => {
            pending = [];
            if (timer) clearTimeout(timer);
            timer = undefined;
        };

        const onKeyDown = (e: KeyboardEvent) => {
            const step = stepFromEvent(e);
            if (step === null) return;   // a modifier on its own

            // Sequences are resolved fresh on every press rather than cached:
            // one of them may have just been rebound in the settings dialog,
            // which is open over this very window.
            const parsed = latest.current
                .map(b => ({ steps: canonicalSequence(b.shortcut), run: b.run }))
                .filter((b): b is { steps: string[]; run: () => void } => b.steps !== null);

            const attempt = (steps: string[]): 'ran' | 'partial' | 'none' => {
                const exact = parsed.find(b =>
                    b.steps.length === steps.length && b.steps.every((s, i) => s === steps[i]));
                if (exact) {
                    // A bare key is only ours outside a text field. Checked
                    // here rather than when the binding is made, because the
                    // same binding is legitimate in the output area and wrong
                    // in the command line.
                    if (steps.length === 1 && !stepHasModifier(steps[0]) && isTextEntry(e.target)) return 'none';
                    e.preventDefault();
                    // The Lua keybinding engine listens on the bubble phase.
                    // A menu accelerator wins over it, as it does in Qt.
                    e.stopPropagation();
                    exact.run();
                    return 'ran';
                }
                const prefix = parsed.some(b =>
                    b.steps.length > steps.length && steps.every((s, i) => b.steps[i] === s));
                if (!prefix) return 'none';
                if (steps.length === 1 && !stepHasModifier(steps[0]) && isTextEntry(e.target)) return 'none';
                e.preventDefault();
                e.stopPropagation();
                return 'partial';
            };

            const outcome = attempt([...pending, step]);
            if (outcome === 'ran') { reset(); return; }
            if (outcome === 'partial') {
                pending = [...pending, step];
                if (timer) clearTimeout(timer);
                timer = setTimeout(reset, CHORD_TIMEOUT_MS);
                return;
            }
            // Nothing matched. If steps were pending, this press may still be
            // the *first* step of something — "Ctrl+A, Ctrl+B" abandoned
            // halfway, then "Ctrl+A" again, should start over rather than be
            // eaten as the failure of the old attempt.
            if (pending.length === 0) return;
            reset();
            if (attempt([step]) === 'partial') {
                pending = [step];
                timer = setTimeout(reset, CHORD_TIMEOUT_MS);
            }
        };

        // Capture, so a shortcut still reaches this from inside CodeMirror and
        // the command line, both of which handle keys of their own.
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            reset();
        };
    }, [enabled]);
}
