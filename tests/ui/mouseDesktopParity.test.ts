// Mouse behaviour checked against Mudlet desktop (issue #352): links run on the
// press, between the window's press and release events; a label hands the
// presses and releases it has no callback for to its window; addMouseEvent
// entries carry the console's selection and appear in every console's menu.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import { LabelManager } from '../../src/ui/labels/LabelManager';
import { LabelOverlay } from '../../src/ui/labels/LabelOverlay';
import { MouseEventRegistry, mouseEventMenuItems } from '../../src/ui/MouseEventRegistry';
import { elementBuffers } from '../../src/ui/output/OutputRenderer';
import { selectionBounds } from '../../src/ui/output/outputCopy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    window.getSelection()?.removeAllRanges();
});

const mouse = (type: string, init: MouseEventInit = {}) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });

/** A main console viewport registered with a WindowManager whose raised
 *  events land in `log`, holding one line with a link that logs `link`. */
function mainWithLink() {
    const log: string[] = [];
    const wm = new WindowManager();
    wm.onRaiseEvent = (event, args) => {
        if (event === 'sysWindowMousePressEvent') log.push(`press|${args.join('|')}`);
        if (event === 'sysWindowMouseReleaseEvent') log.push(`rel|${args.join('|')}`);
    };
    const viewport = document.createElement('div');
    document.body.appendChild(viewport);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const buf = new AnsiAwareBuffer('go north now');
    buf.setHyperlink([3, 8], { onClick: () => log.push('link') });
    viewport.appendChild(buf.toDom());
    wm.registerMainViewport(viewport);
    const link = viewport.querySelector<HTMLElement>('[data-output-clickable]')!;
    return { log, wm, viewport, link, outside };
}

describe('links run on the press, as TTextEdit::mousePressEvent does', () => {
    it('raises press, runs the link, then raises release', () => {
        const { log, link } = mainWithLink();
        link.dispatchEvent(mouse('mousedown', { detail: 1 }));
        link.dispatchEvent(mouse('mouseup', { detail: 1 }));
        link.dispatchEvent(mouse('click', { detail: 1 }));
        expect(log.map(l => l.split('|')[0])).toEqual(['press', 'link', 'rel']);
    });

    it('still runs the link when the press drags off and is released elsewhere', () => {
        const { log, link, outside } = mainWithLink();
        link.dispatchEvent(mouse('mousedown', { detail: 1 }));
        outside.dispatchEvent(mouse('mouseup', { detail: 1 }));
        // The release belongs to the window that took the press (Qt's grab).
        expect(log.map(l => l.split('|')[0])).toEqual(['press', 'link', 'rel']);
        expect(log[2].endsWith('|main')).toBe(true);
    });

    it('does not run again on the second press of a double-click', () => {
        const { log, link } = mainWithLink();
        link.dispatchEvent(mouse('mousedown', { detail: 1 }));
        link.dispatchEvent(mouse('mouseup', { detail: 1 }));
        link.dispatchEvent(mouse('mousedown', { detail: 2 }));
        link.dispatchEvent(mouse('mouseup', { detail: 2 }));
        expect(log.filter(l => l === 'link')).toHaveLength(1);
    });

    it('runs on keyboard activation (a click with no press)', () => {
        const { log, link } = mainWithLink();
        link.click();
        expect(log).toEqual(['link']);
    });

    it('a press elsewhere then release over the link does not run it', () => {
        const { log, viewport, link } = mainWithLink();
        viewport.dispatchEvent(mouse('mousedown', { detail: 1 }));
        link.dispatchEvent(mouse('mouseup', { detail: 1 }));
        expect(log).not.toContain('link');
    });
});

describe('labels hand unhandled presses and releases to their window', () => {
    function mountLabels(setup: (m: LabelManager) => void) {
        const log: string[] = [];
        const wm = new WindowManager();
        wm.onRaiseEvent = (event, args) => {
            if (event === 'sysWindowMousePressEvent') log.push(`press|${args.join('|')}`);
            if (event === 'sysWindowMouseReleaseEvent') log.push(`rel|${args.join('|')}`);
        };
        const labels = new LabelManager();
        labels.onUnhandledMouse = (kind, parent, e) => wm.raiseUnhandledMouse(kind, parent, e);
        // The overlay host is a sibling of the main viewport, as in OutputArea.
        const viewport = document.createElement('div');
        const host = document.createElement('div');
        document.body.append(viewport, host);
        wm.registerMainViewport(viewport);
        setup(labels);
        root = createRoot(host);
        act(() => root!.render(createElement(LabelOverlay, { manager: labels, parent: 'main' })));
        const press = (name: string, x: number, y: number) => {
            const el = host.querySelector(`[data-mudlet-label="${name}"]`)!;
            act(() => {
                el.dispatchEvent(mouse('pointerdown', { clientX: x, clientY: y, detail: 1 }));
                el.dispatchEvent(mouse('mousedown', { clientX: x, clientY: y, detail: 1 }));
                el.dispatchEvent(mouse('pointerup', { clientX: x, clientY: y, detail: 1 }));
                el.dispatchEvent(mouse('mouseup', { clientX: x, clientY: y, detail: 1 }));
            });
        };
        return { log, press };
    }

    it('a click callback takes the press; the release goes to main', () => {
        const { log, press } = mountLabels(m => {
            m.create('LA', { x: 100, y: 100, width: 100, height: 100, fillBackground: false });
            m.setClickCallback('LA', () => log.push('LAclick'));
        });
        press('LA', 150, 150);
        expect(log).toEqual(['LAclick', 'rel|1|150|150|main']);
    });

    it('a label with no callbacks passes both on', () => {
        const { log, press } = mountLabels(m => {
            m.create('LB', { x: 400, y: 100, width: 100, height: 100, fillBackground: false });
        });
        press('LB', 450, 150);
        expect(log).toEqual(['press|1|450|150|main', 'rel|1|450|150|main']);
    });

    it('a release callback takes the release; the press goes to main', () => {
        const { log, press } = mountLabels(m => {
            m.create('LC', { x: 700, y: 100, width: 100, height: 100, fillBackground: false });
            m.setMouseUpCallback('LC', () => log.push('LCrel'));
        });
        press('LC', 750, 150);
        expect(log).toEqual(['press|1|750|150|main', 'LCrel']);
    });

    it('a label inside a user window does not also raise the window\'s own events', () => {
        const log: string[] = [];
        const wm = new WindowManager();
        wm.onRaiseEvent = (event, args) => log.push(`${event}|${args.join('|')}`);
        const labels = new LabelManager();
        labels.onUnhandledMouse = (kind, parent, e) => wm.raiseUnhandledMouse(kind, parent, e);
        const viewport = document.createElement('div');
        document.body.appendChild(viewport);
        wm.registerViewport('uw', viewport);
        labels.create('L', { x: 0, y: 0, width: 50, height: 50, fillBackground: false, parent: 'uw' });
        labels.setClickCallback('L', () => log.push('click'));
        root = createRoot(viewport);
        act(() => root!.render(createElement(LabelOverlay, { manager: labels, parent: 'uw' })));
        const el = viewport.querySelector('[data-mudlet-label="L"]')!;
        act(() => {
            el.dispatchEvent(mouse('pointerdown', { detail: 1 }));
            el.dispatchEvent(mouse('mousedown', { detail: 1 }));
        });
        expect(log.filter(l => l.startsWith('sysWindowMousePressEvent'))).toEqual([]);
        expect(log).toContain('click');
    });
});

describe('addMouseEvent entries carry the console and its selection', () => {
    function addLine(container: HTMLElement, text: string): HTMLElement {
        const el = document.createElement('div');
        el.className = 'output-msg';
        el.innerHTML = `<div class="output-msg-text"><span class="output-msg-content">${text}</span></div>`;
        container.appendChild(el);
        elementBuffers.set(el, new AnsiAwareBuffer(text));
        return el;
    }

    it('reports the first and last selected characters, lines counted from 0', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const l1 = addLine(container, 'first line');
        const l2 = addLine(container, 'second line');
        const range = document.createRange();
        range.setStart(l1.querySelector('.output-msg-content')!.firstChild!, 0);
        range.setEnd(l2.querySelector('.output-msg-content')!.firstChild!, 6);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        expect(selectionBounds(container)).toEqual({ startX: 0, startY: 0, endX: 5, endY: 1 });
    });

    it('is all zero with nothing selected', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        addLine(container, 'text');
        expect(selectionBounds(container)).toEqual({ startX: 0, startY: 0, endX: 0, endY: 0 });
    });

    it('builds menu items for any console, dispatching that console\'s name', () => {
        const registry = new MouseEventRegistry();
        const raised: unknown[][] = [];
        registry.setDispatcher((event, args) => raised.push([event, ...args]));
        registry.add('zz_one', 'myMouseEv', 'Probe One', 'tip');
        const items = mouseEventMenuItems(registry, 'MC', { startX: 0, startY: 0, endX: 0, endY: 0 });
        expect(items.map(i => i.label)).toEqual(['Probe One']);
        items[0].onClick();
        expect(raised).toEqual([['myMouseEv', 'zz_one', 'MC', 0, 0, 0, 0]]);
    });
});
