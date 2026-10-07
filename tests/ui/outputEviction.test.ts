import { describe, it, expect, beforeEach } from 'vitest';
import { Console } from '../../src/mud/text/Console';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { setupOutputRenderer, type OutputRendererControls } from '../../src/ui/output/OutputRenderer';

beforeEach(() => {
    document.body.replaceChildren();
});

/** A bare main-output renderer over a detached wrapper + sentinel, the same
 *  shape `useOutput` mounts. Driven directly via `controls.push` so the test
 *  can feed it exactly the buffers the Console produced. */
function mountRenderer(): { wrapper: HTMLElement; sentinel: HTMLElement; controls: OutputRendererControls } {
    const wrapper = document.createElement('div');
    const sentinel = document.createElement('div');
    sentinel.className = 'output-sentinel';
    wrapper.appendChild(sentinel);
    const stickyArea = document.createElement('div');
    document.body.append(wrapper, stickyArea);

    const controls = setupOutputRenderer(null, {
        outputWrapper: wrapper,
        sentinel,
        stickyArea,
        isSplitView: () => false,
        stickyLines: 5,
    });
    return { wrapper, sentinel, controls };
}

/** Echo one line into the console and render every line it completed — the
 *  order the live pipeline uses (drain after each flush), so a line is always
 *  in the DOM before the cap can evict it. */
function echoLine(console_: Console, controls: OutputRendererControls, text: string): void {
    console_.echo(text);
    for (const line of console_.takeLines()) controls.push(line, 'script', line.timestamp);
}

function rows(wrapper: HTMLElement): HTMLElement[] {
    return Array.from(wrapper.querySelectorAll<HTMLElement>('.output-msg'));
}

describe('scrollback eviction', () => {
    it('removes the whole row, not just its content span', () => {
        const { wrapper, controls } = mountRenderer();
        const con = new Console();
        con.setMaxLines(10);
        con.setBatchDeleteSize(5);

        for (let i = 1; i <= 40; i++) echoLine(con, controls, `line ${i}\n`);

        // getLineCount() is Mudlet's 0-indexed last line, so history holds one more.
        const live = con.getLineCount() + 1;
        expect(live).toBeLessThanOrEqual(10);
        expect(rows(wrapper).length).toBe(live);
        // No empty shells: every surviving row still carries its content span.
        for (const row of rows(wrapper)) {
            expect(row.querySelector('.output-msg-content')).not.toBeNull();
        }
        // ...and no orphaned timestamp spans left over from evicted rows.
        expect(wrapper.querySelectorAll('.output-timestamp').length).toBe(live);
    });

    it('evicts blank lines too', () => {
        const { wrapper, controls } = mountRenderer();
        const con = new Console();
        con.setMaxLines(10);
        con.setBatchDeleteSize(5);

        for (let i = 0; i < 40; i++) echoLine(con, controls, '\n');

        const live = con.getLineCount() + 1;
        expect(live).toBeLessThanOrEqual(10);
        expect(rows(wrapper).length).toBe(live);
    });

    it('evicts a mix of blank and non-blank lines down to the cap', () => {
        const { wrapper, controls } = mountRenderer();
        const con = new Console();
        con.setMaxLines(10);
        con.setBatchDeleteSize(5);

        for (let i = 1; i <= 40; i++) echoLine(con, controls, i % 2 === 0 ? '\n' : `line ${i}\n`);

        expect(rows(wrapper).length).toBe(con.getLineCount() + 1);
    });

    it('deleteLine removes the row rather than blanking it', () => {
        const { wrapper, controls } = mountRenderer();
        const con = new Console();

        for (let i = 1; i <= 3; i++) echoLine(con, controls, `line ${i}\n`);
        expect(rows(wrapper).length).toBe(3);

        con.moveTo(1);
        con.deleteLine();
        expect(rows(wrapper).length).toBe(2);
        expect(rows(wrapper).map(r => r.textContent ?? '').join('|')).not.toContain('line 2');
    });
});

describe('AnsiAwareBuffer.removeFromDom', () => {
    it('detaches the registered row, timestamp span and all', () => {
        const row = document.createElement('div');
        row.className = 'output-msg';
        const stamp = document.createElement('span');
        stamp.className = 'output-timestamp';
        const content = document.createElement('span');
        content.className = 'output-msg-content';
        row.append(stamp, content);
        document.body.appendChild(row);

        const buf = new AnsiAwareBuffer('hello');
        content.appendChild(buf.toDom());
        buf.notifyRender(content, row);

        buf.removeFromDom();
        expect(document.querySelectorAll('.output-msg').length).toBe(0);
        expect(document.querySelectorAll('.output-timestamp').length).toBe(0);
    });

    it('falls back to the registered element when no row is given', () => {
        const line = document.createElement('div');
        document.body.appendChild(line);
        const buf = new AnsiAwareBuffer('hello');
        line.appendChild(buf.toDom());
        buf.notifyRender(line);

        buf.removeFromDom();
        expect(line.parentElement).toBeNull();
    });
});

// mudlet-web#443 item 1: a trim took its batch with one shift() per line — 20,000
// shifts of a 100,000-line array, seconds of freeze — and one removeChild per
// row. It is now one splice and, for rows that sit together, one DOM removal.
describe('mudlet-web#443: a batch trim', () => {
    it('drops the oldest batch in one go and reports its size', () => {
        const con = new Console();
        con.setMaxLines(100_000);
        con.setBatchDeleteSize(20_000);
        const shrinks: number[] = [];
        con.onBufferShrink = n => { shrinks.push(n); };
        for (let i = 0; i < 99_998; i++) con.appendLine(new AnsiAwareBuffer(`L${i}`));
        expect(shrinks).toEqual([]);
        const started = performance.now();
        for (let i = 99_998; i < 100_010; i++) con.appendLine(new AnsiAwareBuffer(`L${i}`));
        const elapsed = performance.now() - started;
        expect(shrinks).toEqual([20_000]);
        // Every surviving line moved up by exactly the batch.
        const first = Number(con.getLines(0, 1)[0].slice(1));
        expect(first).toBe(100_010 - (con.getLineCount() + 1));
        expect(con.getLines(con.getLineCount(), con.getLineCount() + 1)).toEqual(['L100009']);
        // Generous: the shift loop took seconds here; the splice takes well
        // under a millisecond.
        expect(elapsed).toBeLessThan(250);
    });

    it('takes the same lines the batch loop took when one batch is not enough', () => {
        // A limit lowered under the history drops whole batches until it fits.
        const con = new Console();
        for (let i = 0; i < 50; i++) con.appendLine(new AnsiAwareBuffer(`L${i}`));
        const shrinks: number[] = [];
        con.onBufferShrink = n => { shrinks.push(n); };
        con.setBatchDeleteSize(7);
        con.setMaxLines(20);
        // 50 lines over a limit of 20: five batches of 7 (35) bring it to 15.
        expect(shrinks).toEqual([35]);
        expect(con.getLines(0, 1)).toEqual(['L35']);
        expect(con.getLineCount() + 1).toBe(15);
    });

    it('removes the evicted rows and nothing else from the scrollback', () => {
        const { wrapper, sentinel, controls } = mountRenderer();
        const con = new Console();
        con.setMaxLines(30);
        con.setBatchDeleteSize(10);
        for (let i = 1; i <= 29; i++) echoLine(con, controls, `line ${i}\n`);
        expect(rows(wrapper).length).toBe(29);

        echoLine(con, controls, 'line 30\n');
        const texts = rows(wrapper).map(r => r.querySelector('.output-msg-content')!.textContent);
        expect(texts.length).toBe(con.getLineCount() + 1);
        expect(texts[0]).toBe(con.getLines(0, 1)[0]);
        expect(texts[texts.length - 1]).toBe('line 30');
        expect(wrapper.lastElementChild).toBe(sentinel);
    });

    it('leaves alone an element that is not one of the evicted lines', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const bufs: AnsiAwareBuffer[] = [];
        const foreign = document.createElement('div');
        for (let i = 0; i < 6; i++) {
            if (i === 3) parent.appendChild(foreign);
            const row = document.createElement('div');
            const buf = new AnsiAwareBuffer(`r${i}`);
            row.appendChild(buf.toDom());
            buf.notifyRender(row);
            parent.appendChild(row);
            bufs.push(buf);
        }
        const kept = document.createElement('div');
        parent.appendChild(kept);

        AnsiAwareBuffer.removeAllFromDom(bufs);
        expect(Array.from(parent.children)).toEqual([foreign, kept]);
    });

    it('takes a contiguous run of rows and stops at its last one', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const bufs: AnsiAwareBuffer[] = [];
        for (let i = 0; i < 6; i++) {
            const row = document.createElement('div');
            const buf = new AnsiAwareBuffer(`r${i}`);
            row.appendChild(buf.toDom());
            buf.notifyRender(row);
            parent.appendChild(row);
            bufs.push(buf);
        }
        const survivors = Array.from(parent.children).slice(4);
        AnsiAwareBuffer.removeAllFromDom(bufs.slice(0, 4));
        expect(Array.from(parent.children)).toEqual(survivors);
        // A buffer already taken off is not taken again.
        bufs[0].removeFromDom();
        expect(Array.from(parent.children)).toEqual(survivors);
    });
});
