import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptWindow } from '../../src/ui/layout/ScriptWindow';
import type { WindowManager } from '../../src/ui/windows/WindowManager';

// Click-to-front must not apply to bare mini-consoles — including the embedded
// Geyser mapper (`createMapper`, id `mapper`, marked as a mini-console).
//
// Those widgets share ONE flat per-viewport overlay stack with their parent's
// labels (see overlayLayerOrder.ts). WindowManager.bringToFront touches that
// registry, so raising the mapper on every pointerdown pushed it above every
// sibling label — panning or clicking the map made labels drawn on top of it
// disappear underneath. In Mudlet a mini-console is a plain child QWidget:
// interacting with it never raises it, only an explicit raiseWindow() does.
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

// ScriptWindow only reaches the manager for the content portal target and the
// top of the client area (0 here — no bars in this host).
const stubManager = () => ({
    getPortalTarget: () => null,
    clientAreaTop:   () => 0,
}) as unknown as WindowManager;

const baseProps = {
    id: 'mapper',
    title: 'Mapper',
    kind: 'map' as const,
    visible: true,
    x: 10, y: 10, width: 300, height: 200, zIndex: 3,
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

/** Render a ScriptWindow and return how many times onFocus fired for a
 *  pointerdown landing on the window body. */
function focusCallsOnBodyPointerDown(isMiniConsole: boolean): number {
    let calls = 0;
    act(() => {
        root.render(createElement(ScriptWindow, {
            ...baseProps,
            manager: stubManager(),
            isMiniConsole,
            onFocus: () => { calls++; },
        }));
    });
    const el = host.querySelector('.script-window') as HTMLElement;
    expect(el).toBeTruthy();
    // The panel's own content lives inside; a click anywhere in the body
    // bubbles to the window root, which is where the raise used to fire.
    const body = el.querySelector('.script-window-content') as HTMLElement;
    expect(body).toBeTruthy();
    act(() => {
        body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    return calls;
}

describe('ScriptWindow click-to-front', () => {
    it('does not raise a mini-console (embedded mapper) on pointerdown', () => {
        expect(focusCallsOnBodyPointerDown(true)).toBe(0);
    });

    it('still raises a regular floating window on pointerdown', () => {
        expect(focusCallsOnBodyPointerDown(false)).toBe(1);
    });

    it('renders a mini-console bare — no titlebar or resize handles to raise from', () => {
        act(() => {
            root.render(createElement(ScriptWindow, {
                ...baseProps,
                manager: stubManager(),
                isMiniConsole: true,
                onFocus: () => {},
            }));
        });
        expect(host.querySelector('.script-window-titlebar')).toBeNull();
        expect(host.querySelector('.script-window-resize-se')).toBeNull();
    });
});
