// Issue #283, the parts that need a DOM: label size hints, the order a label's
// move and press callbacks arrive in, and docked user-window geometry.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LabelManager } from '../../src/ui/labels/LabelManager';
import { LabelOverlay } from '../../src/ui/labels/LabelOverlay';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import type { ScriptWindowRenderData } from '../../src/ui/windows/types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read off disk: a `?raw` CSS import comes back empty under Vitest.
const labelCss = readFileSync(resolve(process.cwd(), 'src/ui/labels/LabelOverlay.css'), 'utf8');

type ActEnv = { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = true;
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}),
}) as DOMRect;

describe('getLabelSizeHint — QLabel::sizeHint, not the label box', () => {
    // happy-dom has no layout, so give it one: 6px per character on a 13px line,
    // for any element, whatever box it sits in. That is enough to tell a hint
    // measured from the contents apart from one read off the label's geometry.
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const text = (this.textContent ?? '').replace(/​/g, '');
            return rect(0, 0, text.length * 6, 13);
        });
    });

    it('gives an empty label the size of one empty line, not its own 300x100 box', () => {
        const m = new LabelManager();
        m.create('empty', { x: 0, y: 0, width: 300, height: 100, fillBackground: true });
        expect(m.getSizeHint('empty')).toEqual({ width: 0, height: 13 });
    });

    it('measures the text, not the box, even once the label is on the page', () => {
        const m = new LabelManager();
        m.create('gl', { x: 0, y: 400, width: 300, height: 100, fillBackground: true });
        m.setHtml('gl', '<div style="font-size: 8pt; ">Hello world</div>');
        // The mounted label spans 300px; its echo <div> is a block as wide as it.
        const mounted = document.createElement('div');
        mounted.setAttribute('data-mudlet-label', 'gl');
        mounted.innerHTML = '<div class="label-doc"><div>Hello world</div></div>';
        document.body.appendChild(mounted);
        expect(m.getSizeHint('gl')).toEqual({ width: 66, height: 13 });
    });

    it('grows with longer text, so an autoWidth label can widen', () => {
        const m = new LabelManager();
        m.create('al', { x: 0, y: 200, width: 66, height: 13, fillBackground: true });
        m.setHtml('al', '<div>Hello world</div>');
        const first = m.getSizeHint('al')!;
        m.setHtml('al', '<div>Hello world, again</div>');
        const second = m.getSizeHint('al')!;
        expect(second.width).toBeGreaterThan(first.width);
        expect(second).toEqual({ width: 108, height: 13 });
    });
});

describe('a label sized from its hint never clips its text', () => {
    // Same 6px-per-character layout as above, so text width is known exactly.
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const text = (this.textContent ?? '').replace(/​/g, '');
            return rect(0, 0, text.length * 6, 13);
        });
        // The real label stylesheet, so the rendered insets are the shipped ones.
        const style = document.createElement('style');
        style.textContent = labelCss;
        document.head.appendChild(style);
    });
    afterEach(() => { document.head.innerHTML = ''; });

    const px = (v: string) => parseFloat(v) || 0;

    for (const [what, sheet] of [
        ['no stylesheet box', ''],
        ['stylesheet padding and border', 'padding: 5px; border: 2px solid red;'],
    ] as const) {
        it(`leaves the content box at least as big as the text (${what})`, () => {
            const m = new LabelManager();
            m.create('fit', { x: 0, y: 0, width: 300, height: 100, fillBackground: true });
            if (sheet) m.setStyleSheet('fit', sheet);
            const text = 'Hello world, again';
            m.setHtml('fit', `<div>${text}</div>`);
            const hint = m.getSizeHint('fit')!;
            m.resize('fit', hint.width, hint.height);  // Geyser adjustSize

            root = createRoot(container);
            act(() => root!.render(createElement(LabelOverlay, { manager: m, parent: 'main' })));
            const el = container.querySelector<HTMLElement>('[data-mudlet-label="fit"]')!;
            const doc = el.querySelector<HTMLElement>('.label-doc')!;
            const outer = getComputedStyle(el);
            const inner = getComputedStyle(doc);
            const contentWidth = px(el.style.width)
                - px(outer.paddingLeft) - px(outer.paddingRight)
                - px(outer.borderLeftWidth) - px(outer.borderRightWidth)
                - px(inner.paddingLeft) - px(inner.paddingRight);
            const contentHeight = px(el.style.height)
                - px(outer.paddingTop) - px(outer.paddingBottom)
                - px(outer.borderTopWidth) - px(outer.borderBottomWidth)
                - px(inner.paddingTop) - px(inner.paddingBottom);
            expect(text.length * 6).toBeLessThanOrEqual(contentWidth);
            expect(13).toBeLessThanOrEqual(contentHeight);
        });
    }
});

describe('label callbacks — a move pending for its frame is delivered before a press', () => {
    it('reports move, click, release for a pointer moved onto a label and clicked in one frame', () => {
        // A real frame queue, run by hand, so the deferred move is genuinely
        // still pending when the press arrives.
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
        vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => {}; });

        const order: string[] = [];
        const m = new LabelManager();
        m.create('btn', { x: 0, y: 0, width: 100, height: 60, fillBackground: true });
        m.setMouseMoveCallback('btn', () => order.push('move'));
        m.setClickCallback('btn', () => order.push('click'));
        m.setMouseUpCallback('btn', () => order.push('release'));

        root = createRoot(container);
        act(() => root!.render(createElement(LabelOverlay, { manager: m, parent: 'main' })));
        const el = container.querySelector('[data-mudlet-label="btn"]')!;
        expect(el).not.toBeNull();

        act(() => {
            el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 30 }));
            el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 30, button: 0 }));
            el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 50, clientY: 30, button: 0 }));
        });
        for (const f of frames.splice(0)) f(0);
        expect(order).toEqual(['move', 'click', 'release']);
    });
});

describe('docked user windows — geometry is the docked layout straight away', () => {
    /** Stands in for ContentLayout: React state fed by onWindowsChange. */
    function Layout({ manager }: { manager: WindowManager }) {
        const [windows, setWindows] = useState<ScriptWindowRenderData[]>([]);
        useEffect(() => {
            manager.onWindowsChange = ws => setWindows(ws);
            manager.initialize();
            return () => { manager.onWindowsChange = undefined; };
        }, [manager]);
        return createElement('div', null, windows.filter(w => w.docked).map(w =>
            createElement('div', { key: w.id, className: 'docked-panel', 'data-docked': w.id })));
    }

    it('commits the dock before settleLayout returns, as desktop docks synchronously', () => {
        const wm = new WindowManager();
        root = createRoot(container);
        act(() => root!.render(createElement(Layout, { manager: wm })));

        // What a script does: no act() around it, nothing awaited after it.
        (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = false;
        wm.open('uw2', { kind: 'text', title: 'uw2', dockingArea: 'right' });
        wm.settleLayout();
        expect(container.querySelector('[data-docked="uw2"]')).not.toBeNull();
    });

    it('reports a docked window\'s geometry from its dock, not its old floating rectangle', () => {
        const wm = new WindowManager();
        wm.open('uw3', { kind: 'text', title: 'uw3', x: 20, y: 20, width: 400, height: 300 });
        wm.dock('uw3', 'right');
        const frame = document.createElement('div');
        frame.className = 'docked-panel';
        frame.appendChild(wm.getOrCreatePortalTarget('uw3'));
        document.body.appendChild(frame);
        vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(1551, 19, 49, 981));
        expect(wm.getGeometry('uw3')).toEqual({ x: 1551, y: 19, width: 49, height: 981 });
        // Floating again, it is the stored rectangle once more.
        wm.undock('uw3');
        frame.remove();
        expect(wm.getGeometry('uw3')).toMatchObject({ x: 20, y: 20 });
    });
});
