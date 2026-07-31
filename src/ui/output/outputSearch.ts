/**
 * Find-in-output: scans the rendered scrollback for a query and tints every hit.
 *
 * This works purely on the rendered DOM rather than on the `AnsiAwareBuffer`
 * model behind each line. Two reasons:
 *
 *  - Highlighting is transient. `buffer.applyFormat()` rewrites segment state,
 *    so undoing a search highlight would mean snapshotting and restoring every
 *    touched line's formatting — and a script that recolours a line mid-search
 *    would lose its change. Wrapping text nodes in `<mark>` leaves the model
 *    untouched, and unwrapping restores the DOM exactly.
 *  - Offsets line up by construction. `appendCells` can substitute text on the
 *    way to the DOM (tab-stop expansion, Mudlet control-character glyphs), so
 *    `buffer.text` offsets do not always index the rendered line. Searching the
 *    rendered text means we match what the player can actually see.
 *
 * The sticky split-view panel holds `cloneNode` copies of the last N lines, so
 * it is not scanned — it lives outside the `.output-wrapper` scroller we walk.
 * Re-populating it after highlighting copies the marks along with the lines.
 */

import type { MatchRange, SearchMatcher } from '../search/matcher';

export const HIT_CLASS = 'output-search-hit';
export const CURRENT_HIT_CLASS = 'output-search-hit--current';

export interface OutputMatch {
    /** The `.output-msg` line element containing this hit. */
    line: HTMLElement;
    /** Offsets into the line's rendered text — `[start, end)`. */
    range: MatchRange;
}

/** The span holding a line's rendered content, excluding the timestamp column
 *  (which sits in a sibling span and must not be searchable — it is a UI
 *  affordance, not MUD output). */
function contentOf(line: Element): HTMLElement | null {
    return line.querySelector<HTMLElement>('.output-msg-content');
}

/**
 * Every match in the output, in document (i.e. chronological) order.
 *
 * Cheap enough to re-run on each keystroke: the per-line cost is one
 * `textContent` read plus the matcher's scan, and only lines that actually hit
 * get walked node-by-node later, in {@link applyHighlights}.
 */
export function scanOutput(container: HTMLElement, matcher: SearchMatcher): OutputMatch[] {
    const out: OutputMatch[] = [];
    if (!matcher.valid) return out;
    for (const line of container.querySelectorAll<HTMLElement>('.output-msg')) {
        const content = contentOf(line);
        if (!content) continue;
        const text = content.textContent ?? '';
        if (!text) continue;
        for (const range of matcher.ranges(text)) {
            out.push({ line, range });
        }
    }
    return out;
}

/** Text nodes of `root` in render order — collected up front because wrapping
 *  mutates the tree and would invalidate a live TreeWalker mid-iteration. */
function textNodesOf(root: HTMLElement): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    return nodes;
}

interface Piece {
    node: Text;
    /** Offsets within `node`, not within the line. */
    start: number;
    end: number;
    current: boolean;
}

/**
 * Wrap `ranges` in mark elements inside one line.
 *
 * A range can straddle several text nodes — an ANSI colour change, or a `.ocell`
 * box around a wide glyph, splits the line into multiple nodes. Each crossed
 * node gets its own mark, which is exactly what we want visually: the tint
 * follows the text and the existing per-segment colours show through.
 */
function markLine(content: HTMLElement, ranges: MatchRange[], currentRange: MatchRange | null): void {
    const byNode = new Map<Text, Piece[]>();
    let offset = 0;
    for (const node of textNodesOf(content)) {
        const nodeStart = offset;
        const nodeEnd = offset + node.data.length;
        offset = nodeEnd;
        for (const range of ranges) {
            const from = Math.max(range[0], nodeStart);
            const to = Math.min(range[1], nodeEnd);
            if (from >= to) continue;
            const piece: Piece = {
                node,
                start: from - nodeStart,
                end: to - nodeStart,
                current: currentRange !== null && range[0] === currentRange[0] && range[1] === currentRange[1],
            };
            const existing = byNode.get(node);
            if (existing) existing.push(piece);
            else byNode.set(node, [piece]);
        }
    }

    for (const pieces of byNode.values()) {
        // Split back-to-front: `splitText` leaves the head in the original node,
        // so earlier pieces' offsets stay valid as we work leftwards.
        pieces.sort((a, b) => b.start - a.start);
        for (const piece of pieces) {
            const { node, start, end } = piece;
            node.splitText(end);
            const middle = node.splitText(start);
            const mark = document.createElement('mark');
            mark.className = piece.current ? `${HIT_CLASS} ${CURRENT_HIT_CLASS}` : HIT_CLASS;
            middle.parentNode?.replaceChild(mark, middle);
            mark.appendChild(middle);
        }
    }
}

/**
 * Tint every match, giving `matches[currentIndex]` the "current hit" treatment.
 *
 * Callers must {@link clearHighlights} first — marking an already-marked line
 * would nest marks. Matches whose line has since been evicted from the DOM are
 * skipped rather than treated as an error; the scrollback trims as new output
 * arrives and a stale match is normal, not exceptional.
 */
export function applyHighlights(matches: OutputMatch[], currentIndex: number): void {
    if (matches.length === 0) return;
    const current = matches[currentIndex] ?? null;
    // One pass per line, so a line holding several hits is walked once.
    const byLine = new Map<HTMLElement, MatchRange[]>();
    for (const match of matches) {
        if (!match.line.isConnected) continue;
        const existing = byLine.get(match.line);
        if (existing) existing.push(match.range);
        else byLine.set(match.line, [match.range]);
    }
    for (const [line, ranges] of byLine) {
        const content = contentOf(line);
        if (!content) continue;
        markLine(content, ranges, current && current.line === line ? current.range : null);
    }
}

/** Unwrap every mark this module added, restoring the pristine rendered line.
 *  `normalize()` re-merges the text nodes `splitText` created so a subsequent
 *  scan sees the same node layout it started with. */
export function clearHighlights(container: HTMLElement): void {
    const marks = container.querySelectorAll<HTMLElement>(`mark.${HIT_CLASS}`);
    const touched = new Set<HTMLElement>();
    for (const mark of marks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        if (parent instanceof HTMLElement) touched.add(parent);
    }
    for (const parent of touched) parent.normalize();
}

/**
 * Scroll the output so `line` sits mid-viewport.
 *
 * Deliberately not `scrollIntoView` — that walks up and scrolls every scrollable
 * ancestor, which in a docked layout drags the whole panel around. Measuring
 * against the wrapper's own rect keeps the movement inside the output.
 */
export function revealLine(container: HTMLElement, line: HTMLElement): void {
    if (!line.isConnected) return;
    const wrapRect = container.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const delta = (lineRect.top - wrapRect.top) - (container.clientHeight - lineRect.height) / 2;
    container.scrollTop = Math.max(0, Math.min(container.scrollTop + delta, container.scrollHeight));
}

/**
 * Index of the match nearest the current viewport — where a fresh search should
 * start so the first Enter moves from what the player is looking at rather than
 * from the top of a thousand-line scrollback. Falls back to the last (most
 * recent) match when nothing is on screen.
 */
export function indexNearViewport(container: HTMLElement, matches: OutputMatch[]): number {
    if (matches.length === 0) return -1;
    const wrapTop = container.getBoundingClientRect().top;
    const viewTop = container.scrollTop;
    for (let i = 0; i < matches.length; i++) {
        const line = matches[i].line;
        if (!line.isConnected) continue;
        const offset = (line.getBoundingClientRect().top - wrapTop) + viewTop;
        if (offset >= viewTop) return i;
    }
    return matches.length - 1;
}

/** A selection this long is a paragraph, not a search term. */
const MAX_SEED_LENGTH = 100;

/**
 * Text to prefill the find box with — whatever the player has selected *in the
 * output*, mirroring the browser's own find.
 *
 * Scoped to `container` on purpose. The command line keeps its last command
 * selected after sending, and `window.getSelection()` can surface that, which
 * would seed the box with the command the player just ran.
 */
export function seedFromSelection(container: HTMLElement | null): string {
    if (!container) return '';
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return '';

    // A selection crossing lines is a passage, not a term. Checked structurally
    // rather than by looking for a newline: `Selection.toString()` does not
    // reliably put one between the line elements.
    const lineOf = (node: Node): Element | null =>
        (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('.output-msg') ?? null;
    const startLine = lineOf(range.startContainer);
    if (!startLine || startLine !== lineOf(range.endContainer)) return '';

    const text = selection.toString().trim();
    if (!text || text.length > MAX_SEED_LENGTH || text.includes('\n')) return '';
    return text;
}

/** Locate `target` in a freshly rescanned match list, so incoming MUD output
 *  does not move the player's place in the results. */
export function findMatchIndex(matches: OutputMatch[], target: OutputMatch | null): number {
    if (!target) return -1;
    return matches.findIndex(m => m.line === target.line && m.range[0] === target.range[0]);
}
