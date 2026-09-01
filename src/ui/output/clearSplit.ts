/**
 * Closing the split view — Mudlet's `TConsole::clearSplit`, which drops the
 * frozen upper pane and puts the console back on the tail. Mudlet reaches it
 * two ways: Ctrl+Return in the command line (`TCommandLine::event`) and a
 * middle click anywhere on the console (`TTextEdit::mousePressEvent`). This
 * module holds the DOM-level predicate so it's unit-testable without React.
 */

/** True when `e` is the Ctrl/Cmd+Return that closes the split view. Shift and
 *  Alt combinations are left alone — the command bar stages a newline on those
 *  — as is anything typed into an editor that owns its own Ctrl+Enter: a code
 *  editor (contentEditable) or any textarea other than the command line, which
 *  is itself a textarea and so cannot be excluded by tag alone. */
export function matchClearSplitKey(e: KeyboardEvent): boolean {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
    const target = e.target as HTMLElement | null;
    if (target?.isContentEditable) return false;
    return !(target instanceof HTMLTextAreaElement && !target.classList.contains('command-input'));

}

/** True when `e` is the middle click that closes the split view. */
export function isClearSplitClick(e: { button: number }): boolean {
    return e.button === 1;
}
