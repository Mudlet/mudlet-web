import { isKeypadEvent } from './qtKeys';

/**
 * Whether a keydown belongs to the focused text widget rather than to the
 * keybinding engine.
 *
 * The MUD command line is a `<textarea class="command-input">` (an `<input>`
 * of the same class in password mode) and holds focus for essentially the
 * whole session. So the usual "don't hijack keys while the user is typing"
 * guard — `tagName === 'TEXTAREA'` — cannot be applied to it: it is true
 * almost always, and it silently disables every keybinding in the profile.
 * Typing a command is the app's resting state, not a text-entry mode that
 * should own every hotkey.
 *
 * The command lines scripts make are command lines too, not text entry:
 * `createCommandLine` (and Geyser.CommandLine on top of it) and a miniconsole's
 * or user window's `enableCommandLine`. Every desktop TCommandLine — main,
 * SubCommandLine and ConsoleCommandLine alike — runs the same `event()`, which
 * offers its keys to the KeyUnit, so a binding fires from any of them.
 *
 * Real text entry elsewhere — the Lua script editor (CodeMirror, so
 * `contentEditable`), a modal's form field, the script tree's filter box —
 * does keep the event to itself.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return !isCommandLineTarget(target);
    }
    return false;
}

/** Classes of the inputs that stand for a Mudlet TCommandLine: the main one
 *  (textarea, or the password-mode input of the same class), a
 *  createCommandLine overlay, and a miniconsole's or user window's own. */
const COMMAND_LINE_CLASSES = ['command-input', 'cmdline-overlay-input', 'window-cmdline'];

/** Whether `target` is a command line — the main one or a script-made one. */
export function isCommandLineTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && COMMAND_LINE_CLASSES.some(c => target.classList.contains(c));
}

/**
 * Whether the command line claims `e` for itself before any keybinding sees it.
 *
 * Desktop's `TCommandLine::event` handles these combinations outright and only
 * offers a key to the keybinding engine when it is pressed with some OTHER set
 * of modifiers — so a binding on plain Up never fires from the command line,
 * while one on Alt+Up does:
 *
 *  - Return: plain (send), Ctrl (clearSplit), Shift (newline)
 *  - Up/Down: plain (history), Ctrl (move the caret between rows)
 *  - Tab and Space: plain or Shift (completion, typing)
 *  - Backspace: plain, Ctrl and/or Shift (editing)
 *  - Escape, PageUp, PageDown, Delete: plain
 *
 * Cmd counts as Ctrl, as Qt maps it on macOS.
 *
 * None of that holds on the numpad. Qt reports a numpad key with
 * KeypadModifier set, so "plain" Enter or Up there is not plain to
 * TCommandLine: numpad Enter and NumLock-off numpad 8/2/9 reach the key unit
 * first, and a Keypad+Enter or Keypad+Up binding fires instead of sending the
 * command or walking the history. With no binding on the key the command line
 * still gets it (the keybinding listener lets the event through), so numpad
 * Enter sends as before.
 */
export function commandLineReservesKey(e: KeyboardEvent): boolean {
    if (isKeypadEvent(e)) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    const none = !ctrl && !e.shiftKey && !e.altKey;
    const ctrlOnly = ctrl && !e.shiftKey && !e.altKey;
    switch (e.key) {
        case 'Enter':
            return none || ctrlOnly || (e.shiftKey && !ctrl && !e.altKey);
        case 'ArrowUp':
        case 'ArrowDown':
            return none || ctrlOnly;
        case 'Tab':
        case ' ':
            return !ctrl && !e.altKey;
        case 'Backspace':
            return !e.altKey;
        case 'Escape':
        case 'PageUp':
        case 'PageDown':
        case 'Delete':
            return none;
        default:
            return false;
    }
}

/**
 * Wire the keybinding engine to `doc`'s keydown events; returns the cleanup.
 *
 * Keys typed into the command line are offered in the CAPTURE phase, before
 * CommandBar's own handler runs, and a binding that fires consumes the key —
 * desktop's TCommandLine::event asks the key unit first and stops there, so a
 * bound Alt+Return must not also stage a newline (and send an empty command
 * with the next Enter). The combinations the command line reserves (see
 * {@link commandLineReservesKey}) never reach a binding from there.
 *
 * That capture listener sits on the WINDOW, not the document. The client's own
 * shortcuts (Ctrl+F's find bar, Ctrl+Shift+P's quick-open, F3) are capture
 * listeners on the document, and `stopPropagation` does not stop a sibling
 * listener on the same node — so with both on the document a binding on one of
 * those keys ran AND opened the find bar, which then took focus and the rest
 * of the typing (mudlet-web#340). The window's capture runs before any of them,
 * and a binding that fires stops the event there, as desktop's binding
 * replaces the find bar.
 *
 * The exception is a menu accelerator (`yieldTo`): on desktop Alt+K is a
 * QAction's shortcut, which Qt resolves before the command line ever sees the
 * key, so a binding on it does not run. A key `yieldTo` claims is left alone.
 *
 * Everywhere else keeps a bubble-phase listener, so a modal's own key handling
 * still gets first say, and real text entry (see {@link isTextEntryTarget})
 * keeps its keys.
 */
export function listenForKeybindings(
    doc: Document,
    processKey: (e: KeyboardEvent) => boolean,
    yieldTo: (e: KeyboardEvent) => boolean = () => false,
): () => void {
    const onCommandLineKey = (e: KeyboardEvent) => {
        if (!isCommandLineTarget(e.target) || e.isComposing) return;
        if (commandLineReservesKey(e) || yieldTo(e)) return;
        if (processKey(e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    const onKey = (e: KeyboardEvent) => {
        if (isTextEntryTarget(e.target) || isCommandLineTarget(e.target)) return;
        if (yieldTo(e)) return;
        if (processKey(e)) e.preventDefault();
    };
    const captureRoot: EventTarget = doc.defaultView ?? doc;
    captureRoot.addEventListener('keydown', onCommandLineKey as EventListener, true);
    doc.addEventListener('keydown', onKey);
    return () => {
        captureRoot.removeEventListener('keydown', onCommandLineKey as EventListener, true);
        doc.removeEventListener('keydown', onKey);
    };
}
