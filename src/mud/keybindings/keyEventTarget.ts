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
