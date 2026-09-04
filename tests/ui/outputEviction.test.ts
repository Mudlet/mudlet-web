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
