import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptWindow } from '../../src/ui/layout/ScriptWindow';
import { WindowManager } from '../../src/ui/windows/WindowManager';

// A floating window may not be drawn into the top bar's strip. The bar paints
// above the floating layer — it has to, or the menus it drops over the output
// get painted through — so a titlebar up there takes no clicks at all: the
// window can no longer be dragged, hidden or closed. Opening the map on a
// profile whose saved position was near the top did exactly that.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

const CLIENT_TOP = 71;

/** ScriptWindow reaches the manager for the portal target and the client top. */
const stubManager = (clientAreaTop = CLIENT_TOP) => ({
    getPortalTarget: () => null,
    clientAreaTop:   () => clientAreaTop,
}) as unknown as WindowManager;

const baseProps = {
    id: 'sys:map',
    title: 'Map',
    kind: 'map' as const,
    visible: true,
    x: 800, y: 20, width: 700, height: 400, zIndex: 3,
    onFocus: () => {},
    onMoved: () => {},
    onResized: () => {},
    onDock: () => {},
    onDragStateChange: () => {},
    onTitlebarContextMenu: () => {},
    onHide: () => {},
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
});

type Props = Parameters<typeof ScriptWindow>[0];

function render(props: Partial<Props> & Pick<Props, 'manager'>): HTMLElement {
    act(() => {
        root.render(createElement(ScriptWindow, { ...baseProps, ...props }));
    });
    return host.querySelector('.script-window') as HTMLElement;
}

describe('floating windows stay inside the client area', () => {
    it('draws a window saved under the top bar at the top of the client area', () => {
        expect(render({ manager: stubManager() }).style.top).toBe(`${CLIENT_TOP}px`);
    });

    it('leaves a window already below the bars where it is', () => {
        expect(render({ manager: stubManager(), y: 300 }).style.top).toBe('300px');
    });

    it('uses the whole viewport when the client has no bars', () => {
        expect(render({ manager: stubManager(0) }).style.top).toBe('20px');
    });

    it('does not clamp a nested window — its y is parent-relative', () => {
        // Mini-consoles and embedded mappers portal into a parent viewport that
        // already sits below the bars, so (0, 0) there is not the viewport's.
        expect(render({ manager: stubManager(), nested: true }).style.top).toBe('20px');
    });

    it('holds a drag at the bar instead of letting the titlebar under it', () => {
        let moved: [number, number] | null = null;
        const el = render({ manager: stubManager(), y: 300, onMoved: (x: number, y: number) => { moved = [x, y]; } });
        const titlebar = el.querySelector('.script-window-titlebar') as HTMLElement;

        // Grab the titlebar and drag well past the top of the viewport.
        act(() => {
            titlebar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900, clientY: 310 }));
            document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 900, clientY: 0 }));
            document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        });

        expect(moved).not.toBeNull();
        expect(moved![1]).toBe(CLIENT_TOP);
    });
});

describe('WindowManager.clientAreaTop', () => {
    it('is 0 until the client area registers, so nothing clamps in a bare host', () => {
        expect(new WindowManager().clientAreaTop()).toBe(0);
    });

    it('reports the registered element\'s top edge', () => {
        const wm = new WindowManager();
        wm.registerClientArea({ getBoundingClientRect: () => ({ top: CLIENT_TOP }) } as unknown as HTMLElement);
        expect(wm.clientAreaTop()).toBe(CLIENT_TOP);
    });
});
