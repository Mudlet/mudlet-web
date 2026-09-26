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
 * Real text entry elsewhere — the Lua script editor (CodeMirror, so
 * `contentEditable`), a modal's form field, the script tree's filter box —
 * does keep the event to itself.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return !target.classList.contains('command-input');
    }
    return false;
}

/** Whether `target` is the MUD command line (textarea, or the password-mode
 *  input of the same class). */
export function isCommandLineTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && target.classList.contains('command-input');
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
 */
export function commandLineReservesKey(e: KeyboardEvent): boolean {
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
 * Everywhere else keeps a bubble-phase listener, so a modal's own key handling
 * still gets first say, and real text entry (see {@link isTextEntryTarget})
 * keeps its keys.
 */
export function listenForKeybindings(doc: Document, processKey: (e: KeyboardEvent) => boolean): () => void {
    const onCommandLineKey = (e: KeyboardEvent) => {
        if (!isCommandLineTarget(e.target) || e.isComposing) return;
        if (commandLineReservesKey(e)) return;
        if (processKey(e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    const onKey = (e: KeyboardEvent) => {
        if (isTextEntryTarget(e.target) || isCommandLineTarget(e.target)) return;
        if (processKey(e)) e.preventDefault();
    };
    doc.addEventListener('keydown', onCommandLineKey, true);
    doc.addEventListener('keydown', onKey);
    return () => {
        doc.removeEventListener('keydown', onCommandLineKey, true);
        doc.removeEventListener('keydown', onKey);
    };
}
