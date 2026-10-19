// The rows of a console's scrollback, grouped into blocks (#457).
//
// Every line a console draws is one `div.output-msg` row. They used to be
// flat children of the `.output-wrapper` scroller, each with
// `content-visibility: auto` (#443) — but with a long scrollback that is tens
// of thousands of elements the browser tracks for visibility every frame, and
// that tracking became the largest cost in the frame: a client streaming 20
// lines a second fell seconds behind the server once the scrollback passed
// 20k lines. Now the rows go into `div.output-block`s of OUTPUT_BLOCK_ROWS
// each, and the block carries `content-visibility` (App.css): a frame looks
// at a hundredth as many elements, and a block off screen skips style,
// layout and paint for all its rows at once.
//
// Desktop's TTextEdit paints only the lines in view; this keeps every row in
// the DOM — find-in-page, selection, copy, caret mode and the accessibility
// tree all still see the whole scrollback — and only lets the browser skip
// whole blocks of it.
//
// Everything that walks a console's rows goes through here rather than
// through the scroller's children, so it reads the same whether a row sits in
// a block or (a console built before this, or a test fixture) directly in the
// scroller.

export const OUTPUT_ROW_CLASS = 'output-msg';
export const OUTPUT_BLOCK_CLASS = 'output-block';
/** The newest block, still being written to, which is always rendered. */
export const OUTPUT_OPEN_BLOCK_CLASS = 'output-block--open';
/** Rows a block holds before the next row starts a new one. */
export const OUTPUT_BLOCK_ROWS = 100;

function isRow(el: Element | null): el is HTMLElement {
    return el !== null && el.classList.contains(OUTPUT_ROW_CLASS);
}

export function isOutputBlock(el: Element | null): el is HTMLElement {
    return el !== null && el.classList.contains(OUTPUT_BLOCK_CLASS);
}

/**
 * Add `row` as the console's newest line: into the last block before
 * `sentinel` (the end of the scroller when null), or a new block when that
 * one is full or there is none.
 */
export function appendRow(container: HTMLElement, row: HTMLElement, sentinel: Element | null = null): void {
    const before = sentinel && sentinel.parentElement === container ? sentinel : null;
    const last = before ? before.previousElementSibling : container.lastElementChild;
    let block: Element;
    if (isOutputBlock(last) && last.childElementCount < OUTPUT_BLOCK_ROWS) {
        block = last;
    } else {
        // The block before is full: from here on the browser may skip it
        // while it is off screen (App.css).
        if (isOutputBlock(last)) last.classList.remove(OUTPUT_OPEN_BLOCK_CLASS);
        block = document.createElement('div');
        block.className = `${OUTPUT_BLOCK_CLASS} ${OUTPUT_OPEN_BLOCK_CLASS}`;
        container.insertBefore(block, before);
    }
    block.appendChild(row);
}

/** Every row of the console, oldest first. */
export function outputRows(container: Element): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let el = container.firstElementChild; el; el = el.nextElementSibling) {
        if (isOutputBlock(el)) {
            for (let row = el.firstElementChild; row; row = row.nextElementSibling) {
                if (isRow(row)) out.push(row);
            }
        } else if (isRow(el)) {
            out.push(el);
        }
    }
    return out;
}

/** The last `n` rows of the console, oldest first. */
export function lastRows(container: Element, n: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let el = container.lastElementChild; el && out.length < n; el = el.previousElementSibling) {
        if (isOutputBlock(el)) {
            for (let row = el.lastElementChild; row && out.length < n; row = row.previousElementSibling) {
                if (isRow(row)) out.push(row);
            }
        } else if (isRow(el)) {
            out.push(el);
        }
    }
    return out.reverse();
}

/** How many rows the console holds. Counts blocks, not rows. */
export function rowCount(container: Element): number {
    let n = 0;
    for (let el = container.firstElementChild; el; el = el.nextElementSibling) {
        if (isOutputBlock(el)) n += el.childElementCount;
        else if (isRow(el)) n++;
    }
    return n;
}

/** The row at 0-based `index`, or null past either end. */
export function rowAt(container: Element, index: number): HTMLElement | null {
    if (index < 0) return null;
    let left = index;
    for (let el = container.firstElementChild; el; el = el.nextElementSibling) {
        if (isOutputBlock(el)) {
            const n = el.childElementCount;
            if (left < n) {
                const row = el.children[left];
                return isRow(row) ? row : null;
            }
            left -= n;
        } else if (isRow(el)) {
            if (left === 0) return el;
            left--;
        }
    }
    return null;
}

/** `row`'s 0-based position in the console, or -1 when it is not one of its rows. */
export function rowIndex(container: Element, row: Element): number {
    const parent = row.parentElement;
    if (!parent) return -1;
    const block = parent === container ? null : parent;
    if (block && block.parentElement !== container) return -1;
    let n = 0;
    for (let el = container.firstElementChild; el; el = el.nextElementSibling) {
        if (el === block) {
            for (let r = el.firstElementChild; r; r = r.nextElementSibling) {
                if (r === row) return n;
                n++;
            }
            return -1;
        }
        if (el === row) return n;
        if (isOutputBlock(el)) n += el.childElementCount;
        else if (isRow(el)) n++;
    }
    return -1;
}

/** The newest row, or null when the console is empty. */
export function lastRow(container: Element): HTMLElement | null {
    return lastRows(container, 1)[0] ?? null;
}

/** The row before `row`, across a block boundary; null at the oldest. */
export function previousRow(row: Element): HTMLElement | null {
    let el = row.previousElementSibling;
    while (el && !isRow(el)) {
        if (isOutputBlock(el) && el.lastElementChild) return el.lastElementChild as HTMLElement;
        el = el.previousElementSibling;
    }
    if (el) return el;
    const parent = row.parentElement;
    if (!isOutputBlock(parent)) return null;
    for (let b = parent.previousElementSibling; b; b = b.previousElementSibling) {
        if (isOutputBlock(b) && isRow(b.lastElementChild)) return b.lastElementChild;
        if (isRow(b)) return b;
    }
    return null;
}

/** The row after `row`, across a block boundary; null at the newest. */
export function nextRow(row: Element): HTMLElement | null {
    let el = row.nextElementSibling;
    while (el && !isRow(el)) {
        if (isOutputBlock(el) && el.firstElementChild) return el.firstElementChild as HTMLElement;
        el = el.nextElementSibling;
    }
    if (el) return el;
    const parent = row.parentElement;
    if (!isOutputBlock(parent)) return null;
    for (let b = parent.nextElementSibling; b; b = b.nextElementSibling) {
        if (isOutputBlock(b) && isRow(b.firstElementChild)) return b.firstElementChild;
        if (isRow(b)) return b;
    }
    return null;
}

/** Take `el` out of its parent, and the block it was in with it once empty. */
export function detachRow(el: Element): void {
    const parent = el.parentElement;
    if (!parent) return;
    parent.removeChild(el);
    if (isOutputBlock(parent) && parent.childElementCount === 0) parent.remove();
}

/**
 * Take a run of `rows` out of the DOM at once — eviction's batch removal. A
 * trim takes lines off the head of the console, which sit side by side in a
 * few blocks: a block they fill goes whole, and the part of one they share
 * with lines that stay goes as one Range deletion. Rows not side by side in
 * their parent (some other element between two of them) are removed one at a
 * time, so nothing that is not one of these rows is touched.
 */
export function detachRows(rows: readonly Element[]): void {
    let i = 0;
    while (i < rows.length) {
        const parent = rows[i].parentElement;
        let j = i + 1;
        while (j < rows.length && rows[j].parentElement === parent) j++;
        if (parent) detachRun(parent, rows, i, j);
        i = j;
    }
}

function detachRun(parent: HTMLElement, rows: readonly Element[], from: number, to: number): void {
    const count = to - from;
    // nextSibling, not nextElementSibling: a range takes every node between
    // its ends, so not even a stray text node may sit in the run.
    let contiguous = true;
    for (let k = from + 1; k < to; k++) {
        if (rows[k - 1].nextSibling !== rows[k]) { contiguous = false; break; }
    }
    if (contiguous && isOutputBlock(parent) && parent.childNodes.length === count) {
        parent.remove();
        return;
    }
    if (contiguous && count > 1 && typeof document !== 'undefined' && document.createRange) {
        const range = document.createRange();
        range.setStartBefore(rows[from]);
        range.setEndAfter(rows[to - 1]);
        range.deleteContents();
    } else {
        for (let k = from; k < to; k++) parent.removeChild(rows[k]);
    }
    if (isOutputBlock(parent) && parent.childElementCount === 0) parent.remove();
}

/** Remove every row (and block) of the console, keeping anything else — the
 *  sticky sentinel. */
export function clearRows(container: Element): void {
    for (let el = container.firstElementChild; el;) {
        const next = el.nextElementSibling;
        if (isOutputBlock(el) || isRow(el)) el.remove();
        el = next;
    }
}
