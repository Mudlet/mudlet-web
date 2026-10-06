import { describe, it, expect } from 'vitest';
import { WindowManager } from '../../src/ui/windows/WindowManager';

// mudlet-web#341 item 5: desktop's getScroll answers the last line while a
// console follows its output (TTextEdit::mIsTailMode). The measurement here is
// the DOM's, and output is appended before the renderer scrolls down to it, so
// between the two a following console measured as scrolled up — right after a
// burst of echoes, as the very top. Tail mode now comes from scroll events.

/** A wrapper whose geometry the test sets, happy-dom doing no layout. */
function wrapper(lines: number) {
    const el = document.createElement('div');
    for (let i = 0; i < lines; i++) {
        const row = document.createElement('div');
        row.className = 'output-msg';
        el.appendChild(row);
    }
    const geo = { scrollHeight: 1000, clientHeight: 100, scrollTop: 0 };
    Object.defineProperty(el, 'scrollHeight', { get: () => geo.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { get: () => geo.clientHeight });
    Object.defineProperty(el, 'scrollTop', {
        get: () => geo.scrollTop,
        set: (v: number) => { geo.scrollTop = v; },
    });
    const scroll = (top: number) => {
        geo.scrollTop = top;
        el.dispatchEvent(new Event('scroll'));
    };
    return { el, geo, scroll };
}

describe('WindowManager.getScrollLine tail mode', () => {
    it('reports tail mode for a console nobody has scrolled, wherever the DOM is', () => {
        const wm = new WindowManager();
        const { el } = wrapper(30);
        wm.registerMainOutput(el);
        // scrollTop 0 with 900px below: what a burst of echoes looks like before
        // the renderer has scrolled to it.
        expect(wm.getScrollLine('main')).toBeNull();
    });

    it('leaves tail mode only when scrolled back, and returns to it at the end', () => {
        const wm = new WindowManager();
        const { el, geo, scroll } = wrapper(30);
        wm.registerMainOutput(el);
        scroll(500);
        expect(wm.getScrollLine('main')).not.toBeNull();
        // More output arriving while scrolled back does not re-enter tail mode.
        geo.scrollHeight = 2000;
        expect(wm.getScrollLine('main')).not.toBeNull();
        scroll(geo.scrollHeight - geo.clientHeight);
        expect(wm.getScrollLine('main')).toBeNull();
        // Output appended after that, not yet scrolled to, is still followed.
        geo.scrollHeight = 3000;
        expect(wm.getScrollLine('main')).toBeNull();
    });
});
