/**
 * Mudlet's "Stop selecting a word on these characters"
 * (`doubleclick_ignore_lineedit`).
 *
 * A double-click in the main display is the browser's own word selection, and
 * the browser's idea of a word is not configurable. Mudlet's is: a profile can
 * name extra characters that end a word, so double-clicking `"Ancalagon"` in a
 * game that quotes names gives you the name rather than the name plus quotes.
 *
 * So the selection is narrowed after the fact — the browser picks a range, and
 * this pulls each end inward past any listed character. Narrowing only: a
 * double-click never selects *more* than the browser would, which keeps the
 * behaviour predictable when the character set is empty or unhelpful.
 */

/**
 * Where the selection should end up, given the text the browser selected and
 * the characters that end a word. Pure, so the edge cases are testable without
 * a DOM: returns offsets into `text`, always within the original `[start, end)`.
 *
 * Trims from both ends, then — because a boundary character in the *middle* is
 * a boundary too — keeps the run containing the click. `anchor` is where in the
 * text the user actually clicked; the run covering it is the one they meant.
 */
export function trimWordSelection(
    text: string,
    start: number,
    end: number,
    ignore: string,
    anchor: number = start,
): { start: number; end: number } {
    if (!ignore || end <= start) return { start, end };
    const stops = new Set([...ignore]);
    // The click can land on the far edge of the selection; clamp it inside so
    // the scan below always begins somewhere in range.
    const at = Math.min(Math.max(anchor, start), Math.max(start, end - 1));
    // A click that landed on a boundary character itself has no word to keep —
    // leave the browser's answer alone rather than collapsing to nothing.
    if (stops.has(text[at])) return { start, end };
    let lo = at;
    let hi = at + 1;
    while (lo > start && !stops.has(text[lo - 1])) lo--;
    while (hi < end && !stops.has(text[hi])) hi++;
    return { start: lo, end: hi };
}

/**
 * Apply {@link trimWordSelection} to the live selection after a double-click.
 * A no-op when the selection spans more than one text node — that is a
 * multi-line or cross-span selection, which is not what a word looks like.
 */
export function trimSelectionForDoubleClick(ignore: string): void {
    if (!ignore) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node !== range.endContainer || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    const { start, end } = trimWordSelection(text, range.startOffset, range.endOffset, ignore);
    if (start === range.startOffset && end === range.endOffset) return;
    const next = document.createRange();
    next.setStart(node, start);
    next.setEnd(node, end);
    sel.removeAllRanges();
    sel.addRange(next);
}
