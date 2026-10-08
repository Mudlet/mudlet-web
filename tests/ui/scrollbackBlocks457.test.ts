// mudlet-web#457: the scrollback's rows are grouped into blocks of
// OUTPUT_BLOCK_ROWS, and `content-visibility` sits on the block instead of on
// every row — tens of thousands of rows tracked for visibility each frame was
// the largest cost in a frame once the scrollback passed ~10k lines. These pin
// that the rows really are grouped, and that everything that walks rows (the
// trigger cursor, eviction, the sticky split view, caret mode, scripted
// scrolling) reads them through the blocks exactly as it read flat rows.
import { describe, it, expect, beforeEach } from 'vitest';
import { Console } from '../../src/mud/text/Console';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { setupOutputRenderer, type CursorOps, type OutputRendererControls } from '../../src/ui/output/OutputRenderer';
import {
    OUTPUT_BLOCK_ROWS, appendRow, detachRows, lastRows, nextRow, outputRows, previousRow, rowAt, rowCount, rowIndex,
} from '../../src/ui/output/outputRows';
import { outputLineElements } from '../../src/ui/output/caretMode';

beforeEach(() => {
    document.body.replaceChildren();
});

function mount(stickyLines = 5): {
    wrapper: HTMLElement; sentinel: HTMLElement; stickyArea: HTMLElement;
    controls: OutputRendererControls; cursor: CursorOps;
} {
    const wrapper = document.createElement('div');
    const sentinel = document.createElement('div');
    wrapper.appendChild(sentinel);
    const stickyArea = document.createElement('div');
    document.body.append(wrapper, stickyArea);
    let cursor!: CursorOps;
    const controls = setupOutputRenderer(null, {
        outputWrapper: wrapper, sentinel, stickyArea,
        isSplitView: () => false, stickyLines,
        onCursorReady: ops => { cursor = ops; },
    });
    return { wrapper, sentinel, stickyArea, controls, cursor };
}

const blocks = (wrapper: HTMLElement) => Array.from(wrapper.querySelectorAll<HTMLElement>(':scope > .output-block'));
const text = (el: Element) => (el.querySelector('.output-msg-content') ?? el).textContent?.trim();
const texts = (els: Element[]) => els.map(text);

describe('scrollback blocks (#457)', () => {
    it('groups rows into blocks of OUTPUT_BLOCK_ROWS, ahead of the sentinel', () => {
        const { wrapper, sentinel, controls } = mount();
        const n = OUTPUT_BLOCK_ROWS * 2 + 7;
        for (let i = 0; i < n; i++) controls.push(`line ${i}`, 'mud');

        const bs = blocks(wrapper);
        expect(bs.map(b => b.childElementCount)).toEqual([OUTPUT_BLOCK_ROWS, OUTPUT_BLOCK_ROWS, 7]);
        // No row is a child of the scroller itself any more.
        expect(wrapper.querySelectorAll(':scope > .output-msg')).toHaveLength(0);
        expect(wrapper.lastElementChild).toBe(sentinel);
        // Only the newest block is open (always rendered); full ones may be skipped.
        expect(bs.map(b => b.classList.contains('output-block--open'))).toEqual([false, false, true]);
        expect(texts(outputRows(wrapper))).toEqual(Array.from({ length: n }, (_, i) => `line ${i}`));
    });

    it('keeps the trigger cursor exact across block boundaries', () => {
        const { controls, cursor } = mount();
        const n = OUTPUT_BLOCK_ROWS * 3;
        for (let i = 1; i <= n; i++) controls.push(`line ${i}`, 'mud');

        expect(cursor.getLineCount()).toBe(n);
        expect(cursor.getLine()).toBe(`line ${n}`);
        expect(cursor.getLineNumber()).toBe(n);

        const edge = OUTPUT_BLOCK_ROWS + 1; // the first row of the second block
        cursor.moveTo(edge);
        expect(cursor.getLine()).toBe(`line ${edge}`);
        expect(cursor.getLineNumber()).toBe(edge);
        cursor.moveUp();
        expect(cursor.getLine()).toBe(`line ${edge - 1}`);
        expect(cursor.getLineNumber()).toBe(edge - 1);
        cursor.moveDown();
        cursor.moveDown();
        expect(cursor.getLine()).toBe(`line ${edge + 1}`);

        expect(cursor.getLines(OUTPUT_BLOCK_ROWS - 1, OUTPUT_BLOCK_ROWS + 2)).toEqual([
            `line ${OUTPUT_BLOCK_ROWS - 1}`, `line ${OUTPUT_BLOCK_ROWS}`,
            `line ${OUTPUT_BLOCK_ROWS + 1}`, `line ${OUTPUT_BLOCK_ROWS + 2}`,
        ]);
        // Past the end stops at the last row; before the start reads nothing.
        expect(cursor.getLines(n - 1, n + 10)).toEqual([`line ${n - 1}`, `line ${n}`]);
        expect(cursor.getLines(0, 3)).toEqual([]);

        // Moving down off the newest row leaves the cursor on the newest row.
        cursor.moveTo(n);
        cursor.moveDown();
        expect(cursor.getLine()).toBe(`line ${n}`);
    });

    it('deleteLine takes an emptied block with it, and moveUp lands on the row before', () => {
        const { wrapper, controls, cursor } = mount();
        for (let i = 1; i <= OUTPUT_BLOCK_ROWS + 1; i++) controls.push(`line ${i}`, 'mud');
        expect(blocks(wrapper)).toHaveLength(2);

        // The newest row is alone in the second block.
        cursor.deleteLine();
        expect(blocks(wrapper)).toHaveLength(1);
        cursor.moveUp();
        expect(cursor.getLine()).toBe(`line ${OUTPUT_BLOCK_ROWS}`);
        expect(cursor.getLineCount()).toBe(OUTPUT_BLOCK_ROWS);

        // The full block is no longer open, so a new row starts a fresh one.
        controls.push('after', 'mud');
        expect(blocks(wrapper).map(b => b.childElementCount)).toEqual([OUTPUT_BLOCK_ROWS, 1]);
    });

    it('evicts whole blocks and the head of a partial one, leaving no empty block', () => {
        const { wrapper, controls } = mount();
        const con = new Console();
        con.setMaxLines(250);
        con.setBatchDeleteSize(130);
        for (let i = 1; i <= 400; i++) {
            con.echo(`line ${i}\n`);
            for (const line of con.takeLines()) controls.push(line, 'script', line.timestamp);
        }
        const live = con.getLineCount() + 1;
        const rows = outputRows(wrapper);
        expect(rows).toHaveLength(live);
        expect(text(rows[rows.length - 1])).toBe('line 400');
        for (const b of blocks(wrapper)) expect(b.childElementCount).toBeGreaterThan(0);
    });

    it('detachRows removes a run spanning blocks, and only that run', () => {
        const wrapper = document.createElement('div');
        const sentinel = document.createElement('div');
        wrapper.appendChild(sentinel);
        const all: HTMLElement[] = [];
        for (let i = 0; i < OUTPUT_BLOCK_ROWS * 2 + 10; i++) {
            const row = document.createElement('div');
            row.className = 'output-msg';
            row.textContent = `r${i}`;
            appendRow(wrapper, row, sentinel);
            all.push(row);
        }
        detachRows(all.slice(0, OUTPUT_BLOCK_ROWS + 5));
        expect(blocks(wrapper).map(b => b.childElementCount)).toEqual([OUTPUT_BLOCK_ROWS - 5, 10]);
        expect(texts(outputRows(wrapper))).toEqual(texts(all.slice(OUTPUT_BLOCK_ROWS + 5)));
        expect(wrapper.lastElementChild).toBe(sentinel);
    });

    it('the row helpers agree with a flat walk', () => {
        const wrapper = document.createElement('div');
        const sentinel = document.createElement('div');
        wrapper.appendChild(sentinel);
        for (let i = 0; i < 250; i++) {
            const row = document.createElement('div');
            row.className = 'output-msg';
            row.textContent = `${i}`;
            appendRow(wrapper, row, sentinel);
        }
        const flat = Array.from(wrapper.querySelectorAll('.output-msg'));
        expect(rowCount(wrapper)).toBe(250);
        expect(outputRows(wrapper)).toEqual(flat);
        expect(lastRows(wrapper, 3)).toEqual(flat.slice(-3));
        for (const i of [0, 99, 100, 101, 249]) {
            expect(rowAt(wrapper, i)).toBe(flat[i]);
            expect(rowIndex(wrapper, flat[i])).toBe(i);
            expect(previousRow(flat[i])).toBe(flat[i - 1] ?? null);
            expect(nextRow(flat[i])).toBe(flat[i + 1] ?? null);
        }
        expect(rowAt(wrapper, 250)).toBeNull();
        expect(rowAt(wrapper, -1)).toBeNull();
    });

    it('the split view and caret mode read the newest rows through the blocks', () => {
        const { wrapper, stickyArea, controls } = mount(3);
        for (let i = 1; i <= OUTPUT_BLOCK_ROWS + 1; i++) controls.push(`line ${i}`, 'mud');
        controls.populateStickyArea();
        expect(texts(Array.from(stickyArea.children))).toEqual([
            `line ${OUTPUT_BLOCK_ROWS - 1}`, `line ${OUTPUT_BLOCK_ROWS}`, `line ${OUTPUT_BLOCK_ROWS + 1}`,
        ]);
        expect(outputLineElements(wrapper)).toHaveLength(OUTPUT_BLOCK_ROWS + 1);
    });

    it('clear() empties the scroller of blocks but keeps the sentinel', () => {
        const { wrapper, sentinel, controls, cursor } = mount();
        for (let i = 0; i < 150; i++) controls.push(new AnsiAwareBuffer(`x ${i}`), 'mud');
        controls.clear();
        expect(Array.from(wrapper.children)).toEqual([sentinel]);
        expect(cursor.getLineCount()).toBe(0);
        controls.push('fresh', 'mud');
        expect(cursor.getLine()).toBe('fresh');
    });
});
