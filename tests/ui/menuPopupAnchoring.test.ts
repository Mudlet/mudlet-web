import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MenuBar } from '../../src/ui/menu/MenuBar';
import { placePopup, inPopupSurface } from '../../src/ui/menu/anchoredPopup';
import type { MenuNode, TopMenu } from '../../src/ui/menu/menuModel';

// Issue #145. The menu bar used to outrank the floating-window layer purely so
// its dropdowns — absolutely positioned INSIDE the bar, and so capped by the
// bar's own stacking context — would clear a floating window. The cost was that
// the bar then swallowed every click on a window drawn in its strip.
//
// The dropdowns are portaled to <body> and placed against their title instead,
// which is what a Qt menu is: its own top-level window. The bar can then drop
// back below the windows, and a window over the bar stays clickable.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

describe('placePopup', () => {
    const anchor = { left: 100, top: 10, right: 160, bottom: 30 };
    const size = { width: 200, height: 120 };
    const viewport = { width: 1000, height: 800 };

    it('hangs below the anchor, aligned on its left edge', () => {
        expect(placePopup(anchor, size, viewport)).toEqual({ left: 100, top: 34 });
    });

    it('aligns on the right edge when asked (the hamburger)', () => {
        const wide = { left: 400, top: 10, right: 600, bottom: 30 };
        expect(placePopup(wide, size, viewport, 'end')).toEqual({ left: 400, top: 34 });
    });

    it('flips to the other edge rather than running off the right', () => {
        // A title near the right of the bar: left-aligned it would overrun, so
        // it hangs the other way — what .menu-list--flipped used to do in CSS.
        const late = { left: 900, top: 10, right: 960, bottom: 30 };
        expect(placePopup(late, size, viewport).left).toBe(760);
    });

    it('flips above the anchor when there is no room below', () => {
        const low = { left: 100, top: 700, right: 160, bottom: 760 };
        expect(placePopup(low, size, viewport).top).toBe(576);
    });

    it('clamps into the viewport when neither side fits', () => {
        // Narrower than the menu: flipping cannot help, so it is pinned to the
        // margin rather than left half off-screen with unreachable entries.
        const tiny = { width: 150, height: 800 };
        const { left, top } = placePopup(anchor, size, tiny);
        expect(left).toBe(4);
        expect(top).toBe(34);
    });
});

describe('inPopupSurface', () => {
    let root: HTMLDivElement;
    let inside: HTMLButtonElement;
    let popup: HTMLDivElement;
    let entry: HTMLButtonElement;
    let elsewhere: HTMLDivElement;

    beforeEach(() => {
        root = document.createElement('div');
        inside = document.createElement('button');
        root.appendChild(inside);
        // What the portal produces: a menu that is no longer a descendant of
        // the control that owns it.
        popup = document.createElement('div');
        popup.setAttribute('data-anchored-popup', '');
        entry = document.createElement('button');
        popup.appendChild(entry);
        elsewhere = document.createElement('div');
        document.body.append(root, popup, elsewhere);
    });

    afterEach(() => {
        for (const el of [root, popup, elsewhere]) el.remove();
    });

    it('counts the control itself', () => {
        expect(inPopupSurface(root, inside)).toBe(true);
    });

    it('counts a menu portaled out of it — otherwise the entry never fires', () => {
        // The dismiss handler runs on pointerdown. Reporting the entry as
        // "outside" would unmount the menu before its click reached it.
        expect(inPopupSurface(root, entry)).toBe(true);
    });

    it('still reports a genuine outside click', () => {
        expect(inPopupSurface(root, elsewhere)).toBe(false);
        expect(inPopupSurface(root, null)).toBe(false);
    });
});

describe('MenuBar dropdowns', () => {
    let host: HTMLDivElement;
    let root: Root;
    let ran: string[];

    const action = (id: string, label: string): MenuNode =>
        ({ kind: 'action', id, label, run: () => ran.push(id) });

    const menus: TopMenu[] = [
        { id: 'games', label: 'Games', items: [action('connect', 'Connect')] },
        { id: 'help', label: 'Help', items: [action('docs', 'Docs')] },
    ];

    const title = (id: string) =>
        host.querySelector<HTMLElement>(`.menu-title[data-menu="${id}"]`)!;
    const list = () => document.querySelector<HTMLElement>('.menu-list');

    beforeEach(() => {
        ran = [];
        host = document.createElement('div');
        // The bar's own stacking context: exactly what used to trap the menu.
        host.style.position = 'relative';
        host.style.zIndex = '40';
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => { root.render(createElement(MenuBar, { menus })); });
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('renders no list until a title is clicked', () => {
        expect(list()).toBeNull();
    });

    it('portals the open dropdown to <body>, out of the bar it hangs from', () => {
        act(() => { title('games').click(); });

        const el = list()!;
        expect(el).not.toBeNull();
        expect(el.parentElement).toBe(document.body);
        expect(host.contains(el)).toBe(false);
        // Placed rather than positioned in CSS, so nothing about the bar's
        // geometry or overflow can clip it.
        expect(el.style.position).toBe('fixed');
        expect(el.classList.contains('menu-list--anchored')).toBe(true);
    });

    it('marks the portaled list as part of the bar for outside-click dismissal', () => {
        act(() => { title('games').click(); });

        const el = list()!;
        expect(el.hasAttribute('data-anchored-popup')).toBe(true);
        // The bar's own document listener must read it as inside…
        act(() => { el.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(list()).not.toBeNull();
        // …and an entry must still run when clicked.
        act(() => { el.querySelector<HTMLElement>('.menu-item')!.click(); });
        expect(ran).toEqual(['connect']);
        expect(list()).toBeNull();
    });

    it('closes on a pointerdown that really is outside', () => {
        act(() => { title('games').click(); });
        expect(list()).not.toBeNull();

        act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(list()).toBeNull();
    });

    it('switches to another menu without leaving a second list behind', () => {
        act(() => { title('games').click(); });
        act(() => { title('help').click(); });

        const el = list()!;
        expect(el.parentElement).toBe(document.body);
        expect(el.textContent).toContain('Docs');
        // One portal per open menu — a stale one would keep painting over the
        // client with nothing to dismiss it.
        expect(document.querySelectorAll('.menu-list')).toHaveLength(1);
    });
});
