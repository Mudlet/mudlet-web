// Issue #70 items 5 and 6, on the rendering side.
//
// 5. A rotated button was drawn upright — Mudlet turns the whole control
//    (TFlipButton::paintEvent: index 1 rotates the painter +90°, index 2 -90°)
//    and transposes its size hint. The toolbar's filler offset held blank cells
//    before the first button (TToolBar::finalize, Mudlet #9332) and had no
//    equivalent here at all.
// 6. Toolbar stylesheets were stored and never applied. Desktop hands
//    `plainTextEdit_action_css` to the real widget; mudix applied it to
//    buttons but not to the bar they sit on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useButtonStrips } from '../../src/ui/buttons/ButtonsBar';
import { useAppStore } from '../../src/storage';
import type { ButtonNode } from '../../src/storage/schema';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'buttonbar-render';
const engineRef = { current: null };

function button(p: Partial<ButtonNode>): ButtonNode {
    return {
        id: 'b', name: 'B', enabled: true, isGroup: false, parentId: null,
        code: '', language: 'lua', orientation: 'horizontal', location: 'top',
        columns: 0, isPushDown: false, buttonState: false, ...p,
    };
}

/** Renders the top strip for whatever is in the store. */
function Harness() {
    const strips = useButtonStrips({ connectionId: CONN, engineRef, vfs: null });
    return strips.top;
}

let container: HTMLDivElement;
let root: Root;

async function render(buttons: ButtonNode[]) {
    useAppStore.setState({ connectionButtons: { [CONN]: buttons } } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(Harness)); });
}

const btn = (name: string) =>
    [...container.querySelectorAll('.mudix-btn')].find(b => b.textContent === name) as HTMLElement;
const bar = () => container.querySelector('.mudix-buttonbar') as HTMLElement;
const filler = () => container.querySelector('.mudix-buttonbar__filler') as HTMLElement | null;

beforeEach(() => { useAppStore.setState({ connectionButtons: {} } as never); });
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
});

describe('button rotation', () => {
    it('leaves an unrotated button alone', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true }),
            button({ id: 'b1', name: 'plain', parentId: 'bar' }),
        ]);
        expect(btn('plain').className).not.toMatch(/rot-/);
    });

    it('turns index 1 the way desktop paints it — clockwise, text reading down', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true }),
            button({ id: 'b1', name: 'left', parentId: 'bar', rotation: 1 }),
        ]);
        expect(btn('left').className).toContain('mudix-btn--rot-cw');
    });

    it('turns index 2 the other way', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true }),
            button({ id: 'b1', name: 'right', parentId: 'bar', rotation: 2 }),
        ]);
        expect(btn('right').className).toContain('mudix-btn--rot-ccw');
    });
});

describe('toolbar filler offset', () => {
    it('holds the offset cells before the first button', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true, columns: 3, fillerOffset: 2 }),
            button({ id: 'b1', name: 'one', parentId: 'bar' }),
        ]);
        // A horizontal bar wraps into rows, so the filler spans rows.
        expect(filler()!.style.gridRow).toBe('span 2');
        expect(bar().firstElementChild).toBe(filler());
    });

    it('spans columns instead on a vertical toolbar', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true, orientation: 'vertical', columns: 3, fillerOffset: 1 }),
            button({ id: 'b1', name: 'one', parentId: 'bar' }),
        ]);
        expect(filler()!.style.gridColumn).toBe('span 1');
    });

    it('places none when there is no offset', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true, columns: 3 }),
            button({ id: 'b1', name: 'one', parentId: 'bar' }),
        ]);
        expect(filler()).toBe(null);
    });

    it('places none on an unwrapped toolbar, where desktop disables the control', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true, columns: 0, fillerOffset: 2 }),
            button({ id: 'b1', name: 'one', parentId: 'bar' }),
        ]);
        expect(filler()).toBe(null);
    });
});

describe('toolbar stylesheet', () => {
    it('applies the toolbar\'s own css to the bar', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true, styleSheet: 'background-color: rgb(1, 2, 3);' }),
            button({ id: 'b1', name: 'one', parentId: 'bar' }),
        ]);
        expect(bar().style.backgroundColor).toBe('rgb(1, 2, 3)');
    });

    it('does not let a stylesheet displace the grid the row count asked for', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true, columns: 2, styleSheet: 'grid-auto-flow: row; color: rgb(9, 9, 9);' }),
            button({ id: 'b1', name: 'one', parentId: 'bar' }),
        ]);
        expect(bar().style.color).toBe('rgb(9, 9, 9)');
        expect(bar().style.gridAutoFlow).toBe('column');
    });

    it('still applies a button\'s own css', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true }),
            button({ id: 'b1', name: 'one', parentId: 'bar', styleSheet: 'color: rgb(4, 5, 6);' }),
        ]);
        expect(btn('one').style.color).toBe('rgb(4, 5, 6)');
    });
});
