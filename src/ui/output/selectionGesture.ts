/**
 * Telling a click that *made* a selection from a click that is about to clear
 * one — the question the console asks before handing focus back to the command
 * line, since focusing a text field collapses the page selection.
 *
 * It cannot be answered by looking at the selection alone. Chrome collapses a
 * selection on the click that lands inside it, but not until the tick *after*
 * the click handler runs, so at that moment "text is selected" is equally true
 * of a drag that just selected it and a click that is about to throw it away.
 * (Clicking outside the selection is different again: that collapses on mouseup,
 * before the click.) The gesture is what separates them — a drag or a
 * multi-click selects, a plain single click does not.
 */

/** The part of a click event this predicate reads. */
export interface ClickGesture {
    /** Clicks in this sequence — 2 and 3 are the double/triple click that select
     *  a word and a line. */
    detail: number;
    /** Shift+click extends an existing selection rather than clearing it. */
    shiftKey: boolean;
    clientX: number;
    clientY: number;
}

/** How far the pointer may travel between press and release and still count as
 *  a click rather than a drag — enough to absorb an unsteady hand, small enough
 *  that no real selection drag fits inside it. */
const DRAG_SLOP_PX = 4;

/**
 * True when this click is the end of a gesture that selected text, and so must
 * be left alone. False for a plain click — including one on top of an existing
 * selection, which the browser is about to collapse anyway.
 *
 * `downAt` is where the button went down (null when the press was not seen, e.g.
 * a click synthesised by the keyboard).
 */
export function clickMadeSelection(
    e: ClickGesture,
    downAt: { x: number; y: number } | null,
    selectedText: string,
): boolean {
    // A drag that selected nothing — a wobble on empty console space — is a
    // click as far as focus is concerned.
    if (!selectedText) return false;
    if (e.detail > 1 || e.shiftKey) return true;
    if (!downAt) return false;
    return Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_SLOP_PX;
}
