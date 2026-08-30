import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScrollBoxOverlay } from '../../src/ui/scrollbox/ScrollBoxOverlay';
import { ScrollBoxManager } from '../../src/ui/scrollbox/ScrollBoxManager';
import { LabelManager } from '../../src/ui/labels/LabelManager';
import { CommandLineManager } from '../../src/ui/cmdline/CommandLineManager';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import { OverlayLayerOrder } from '../../src/ui/layout/overlayLayerOrder';

// Geyser.ScrollBox makes itself the `windowname` of everything created inside
// it (GeyserScrollBox.lua: `me.windowname = me.name`), so a mini-console in a
// scroll box reaches WindowManager with the BOX's name as its parent. Without
// an overlay host under that name FloatingWindowLayer.resolveParent found
// nothing and fell back to a root floating window — the Discworld Companion's
// left dock painted its four section consoles over the main output at document
// coordinates while their frames/titles stayed behind in the docked panel.
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

let host: HTMLDivElement;
let root: Root;
let boxes: ScrollBoxManager;
let labels: LabelManager;
let cmdLines: CommandLineManager;
let windows: WindowManager;

const render = (parent = 'main') =>
    act(() => {
        root.render(createElement(ScrollBoxOverlay, { manager: boxes, labels, cmdLines, windows, parent }));
    });

beforeEach(() => {
    const order = new OverlayLayerOrder();
    boxes = new ScrollBoxManager(order);
    labels = new LabelManager(order);
    cmdLines = new CommandLineManager(order);
    windows = new WindowManager(order);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('ScrollBoxOverlay — nested windows', () => {
    it('registers its scroll content as the overlay host for its own name', () => {
        boxes.create('sb', { x: 0, y: 0, width: 200, height: 300 });
        render();
        const content = host.querySelector('[data-mudix-scrollbox="sb"] .scrollbox-content');
        expect(content).not.toBeNull();
        expect(windows.getOverlayHost('sb')).toBe(content);
    });

    it('drops the host again when the box is destroyed', () => {
        boxes.create('sb', { x: 0, y: 0, width: 200, height: 300 });
        render();
        expect(windows.getOverlayHost('sb')).not.toBeNull();
        act(() => { boxes.destroy('sb'); });
        expect(windows.getOverlayHost('sb')).toBeNull();
    });

    it('keeps hosting a hidden box so its windows hide with it instead of escaping', () => {
        boxes.create('sb', { x: 0, y: 0, width: 200, height: 300 });
        render();
        act(() => { boxes.hide('sb'); });
        const box = host.querySelector('[data-mudix-scrollbox="sb"]') as HTMLElement;
        expect(box.style.display).toBe('none');
        expect(windows.getOverlayHost('sb')).not.toBeNull();
    });

    it('grows the scroll content to cover windows nested in the box', () => {
        boxes.create('sb', { x: 0, y: 0, width: 200, height: 100 });
        render();
        act(() => {
            windows.open('con', { kind: 'text', title: 'con', autoDock: false, ignoreHint: true, parent: 'sb' });
            windows.markAsMiniConsole('con');
            windows.setPosition('con', 10, 400);
            windows.setSize('con', 150, 80);
        });
        const box = host.querySelector('[data-mudix-scrollbox="sb"]') as HTMLElement;
        const content = host.querySelector('.scrollbox-content') as HTMLElement;
        expect(box.style.overflowY).toBe('auto');
        expect(content.style.height).toBe('480px');
    });
});
