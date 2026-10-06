import { describe, it, expect, beforeEach } from 'vitest';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import { matchPageScrollKey } from '../../src/ui/output/clearSplit';
import type { Console } from '../../src/mud/text/Console';

// mudlet-web#369: scrolling against desktop PTB 96fbed5. Desktop's scroll
// position is the upper pane's mCursorY, and that pane draws the rows above it
// (TTextEdit::imageTopLine = mCursorY - mScreenHeight) — so scrollTo(win, N)
// and getScroll both name the first line *below* the scrolled view, whose
// bottom row is N - 1. Mudlet Web anchored both to the top row instead.

const ROW = 10;
const VIEW = 100;   // wrapper clientHeight: 10 rows
const PANE = 30;    // the split view's lower pane: 3 rows

beforeEach(() => {
    document.body.replaceChildren();
});

/** A console wrapper of `rows` rows laid out by the test (happy-dom does no
 *  layout), with the split view's sticky pane as its sibling, as
 *  StickyOutputPanel renders them. Row i spans [i*ROW, (i+1)*ROW) in content
 *  coordinates and the wrapper's top edge is at 0. */
function mount(wm: WindowManager, id: string, rows: number) {
    const parent = document.createElement('div');
    const el = document.createElement('div');
    parent.appendChild(el);
    const sticky = document.createElement('div');
    sticky.className = 'output-sticky';
    sticky.getBoundingClientRect = () => ({ top: VIEW - PANE, bottom: VIEW, height: PANE } as DOMRect);
    parent.appendChild(sticky);
    document.body.appendChild(parent);
    const geo = { scrollTop: rows * ROW - VIEW };
    for (let i = 0; i < rows; i++) {
        const row = document.createElement('div');
        row.className = 'output-msg';
        row.getBoundingClientRect = () => ({
            top: i * ROW - geo.scrollTop, bottom: (i + 1) * ROW - geo.scrollTop, height: ROW,
        } as DOMRect);
        el.appendChild(row);
    }
    el.getBoundingClientRect = () => ({ top: 0, bottom: VIEW, height: VIEW } as DOMRect);
    Object.defineProperty(el, 'scrollHeight', { get: () => rows * ROW });
    Object.defineProperty(el, 'clientHeight', { get: () => VIEW });
    Object.defineProperty(el, 'scrollTop', {
        get: () => geo.scrollTop,
        set: (v: number) => {
            geo.scrollTop = Math.max(0, Math.min(v, rows * ROW - VIEW));
            el.dispatchEvent(new Event('scroll'));
        },
    });
    // The buffer behind it: `rows` finished lines, so Lua's getLastLineNumber
    // (the always-open line past them) is `rows`.
    const registry = new Map<string, Console>([[id, { getLineCount: () => rows - 1, clear() {} } as unknown as Console]]);
    wm.setConsoleRegistry(registry);
    if (id === 'main') wm.registerMainOutput(el);
    else wm.registerTextPanel(id, { push() {}, clear() {} } as never, el);
    /** Bottom row of the scrolled view, the split pane excluded. */
    const bottomRow = () => Math.floor((geo.scrollTop + VIEW - PANE) / ROW) - 1;
    return { el, geo, bottomRow };
}

/** What getScroll reads, before ScriptingAPI clamps it to the last line. */
const scroll = (wm: WindowManager, id: string, rows: number) => wm.getScrollLine(id) ?? rows;

describe('mudlet-web#369 item 2 — scrollTo and getScroll measure from the bottom edge', () => {
    it('scrollTo(win, N) leaves line N - 1 as the bottom row, and getScroll answers N', () => {
        const wm = new WindowManager();
        const { bottomRow } = mount(wm, 'main', 200);
        wm.scrollToLine('main', 100);
        expect(bottomRow()).toBe(99);
        expect(scroll(wm, 'main', 200)).toBe(100);
    });

    it('measures a wheel scroll the same way: one past the bottom row', () => {
        const wm = new WindowManager();
        const { el, geo, bottomRow } = mount(wm, 'main', 200);
        // The reader scrolls up; nothing scripted is parked.
        geo.scrollTop = 1000;
        el.dispatchEvent(new Event('scroll'));
        expect(bottomRow()).toBe(106);
        expect(wm.getScrollLine('main')).toBe(107);
        // And scrollTo to that number lands exactly there.
        wm.scrollToLine('main', 50);
        wm.noteUserScroll('main');
        expect(wm.getScrollLine('main')).toBe(50);
    });

    it('scrollTo near the top keeps the view at the first line', () => {
        const wm = new WindowManager();
        const { geo } = mount(wm, 'mc', 100);
        wm.scrollToLine('mc', 3);
        expect(geo.scrollTop).toBe(0);
        expect(scroll(wm, 'mc', 100)).toBe(3);
    });
});

describe('mudlet-web#369 item 3 — disableScrolling closes the split', () => {
    it('puts a scrolled-up miniconsole back on its tail', () => {
        const wm = new WindowManager();
        const { el, geo } = mount(wm, 'mc', 100);
        wm.scrollToLine('mc', 30);
        expect(wm.getScrollLine('mc')).toBe(30);
        wm.setScrollingEnabled('mc', false);
        expect(geo.scrollTop).toBe(el.scrollHeight - VIEW);
        expect(wm.getScrollLine('mc')).toBeNull();
    });
});

describe('mudlet-web#369 item 4 — getScroll follows the view back to the tail', () => {
    it('scrollTo at or past the last line resumes tail mode instead of parking there', () => {
        const wm = new WindowManager();
        mount(wm, 'main', 200);
        wm.scrollToLine('main', 50);
        wm.scrollToLine('main', 99999);
        expect(wm.getScrollLine('main')).toBeNull();
        wm.scrollToLine('main', 50);
        wm.scrollToLine('main', 200);
        expect(wm.getScrollLine('main')).toBeNull();
    });

    it('clearing a window forgets the line it was scrolled to', () => {
        const wm = new WindowManager();
        wm.open('mc', { kind: 'text', title: 'mc' });
        mount(wm, 'mc', 100);
        wm.scrollToLine('mc', 30);
        wm.clear('mc');
        expect(wm.getScrollLine('mc')).toBeNull();
    });

    it('a reader scroll replaces the scripted position', () => {
        const wm = new WindowManager();
        const { el } = mount(wm, 'main', 200);
        wm.scrollToLine('main', 100);
        // Middle click / Ctrl+Return / the "new output" button: back to the end.
        el.scrollTop = el.scrollHeight;
        expect(wm.getScrollLine('main')).toBeNull();
    });
});

describe('mudlet-web#369 item 5 — PageUp / PageDown page the main console', () => {
    it('pages up a scrolled-view height at a time and back down to the tail', () => {
        const wm = new WindowManager();
        const { geo, el } = mount(wm, 'main', 200);
        const tail = geo.scrollTop;
        wm.scrollPage('main', 'up');
        expect(geo.scrollTop).toBe(tail - (VIEW - PANE));
        wm.scrollPage('main', 'up');
        expect(geo.scrollTop).toBe(tail - 2 * (VIEW - PANE));
        expect(wm.getScrollLine('main')).not.toBeNull();
        wm.scrollPage('main', 'down');
        expect(geo.scrollTop).toBe(tail - (VIEW - PANE));
        // Paging into what the lower pane already shows closes the split.
        wm.scrollPage('main', 'down');
        expect(geo.scrollTop).toBe(el.scrollHeight - VIEW);
        expect(wm.getScrollLine('main')).toBeNull();
    });

    function press(target: HTMLElement, init: KeyboardEventInit): 'up' | 'down' | null {
        document.body.appendChild(target);
        let got: 'up' | 'down' | null = null;
        const onKey = (e: Event) => { got = matchPageScrollKey(e as KeyboardEvent); };
        document.addEventListener('keydown', onKey, true);
        target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
        document.removeEventListener('keydown', onKey, true);
        return got;
    }
    const commandLine = () => {
        const el = document.createElement('textarea');
        el.className = 'command-input';
        return el;
    };

    it('takes plain PageUp / PageDown from the main command line only', () => {
        expect(press(commandLine(), { key: 'PageUp' })).toBe('up');
        expect(press(commandLine(), { key: 'PageDown' })).toBe('down');
        // Modified: offered to keybindings, as desktop does.
        expect(press(commandLine(), { key: 'PageUp', shiftKey: true })).toBeNull();
        expect(press(commandLine(), { key: 'PageDown', ctrlKey: true })).toBeNull();
        // Numpad PageUp carries KeypadModifier on desktop.
        expect(press(commandLine(), { key: 'PageUp', code: 'Numpad9', location: 3 })).toBeNull();
        // Some other text field keeps its own PageUp.
        expect(press(document.createElement('textarea'), { key: 'PageUp' })).toBeNull();
    });
});
