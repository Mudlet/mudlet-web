// mudlet-web#192: a button, toolbar or menu whose Lua will not compile is
// inactive, and desktop's toolbar builders (TToolBar/TEasyButtonBar::
// addActionButtons, ActionUnit::constructToolbar) leave inactive ones off —
// a toolbar with every button on it. The engine publishes which will not
// compile to inactiveButtons; this is the bar's side of it.
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useButtonStrips } from '../../src/ui/buttons/ButtonsBar';
import { inactiveButtons } from '../../src/ui/buttons/inactiveButtons';
import { useAppStore } from '../../src/storage';
import type { ButtonNode } from '../../src/storage/schema';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'buttonbar-inactive';
const engineRef = { current: null };

function button(p: Partial<ButtonNode>): ButtonNode {
    return {
        id: 'b', name: 'B', enabled: true, isGroup: false, parentId: null,
        code: '', language: 'lua', orientation: 'horizontal', location: 'top',
        columns: 0, isPushDown: false, buttonState: false, ...p,
    };
}

const BUTTONS = [
    button({ id: 'bar', name: 'bar', isGroup: true }),
    button({ id: 'b1', name: 'one', parentId: 'bar' }),
    button({ id: 'b2', name: 'two', parentId: 'bar' }),
];

function Harness() {
    return useButtonStrips({ connectionId: CONN, engineRef, vfs: null }).top;
}

let container: HTMLDivElement;
let root: Root;

async function render() {
    useAppStore.setState({ connectionButtons: { [CONN]: BUTTONS } } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(Harness)); });
}

const labels = () => [...container.querySelectorAll('.mudlet-btn')].map(b => b.textContent);

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    inactiveButtons.clear(CONN);
    useAppStore.setState({ connectionButtons: {} } as never);
});

describe('buttons that will not compile', () => {
    it('leaves a broken button off, and puts it back once it compiles', async () => {
        await render();
        expect(labels()).toEqual(['one', 'two']);

        await act(async () => { inactiveButtons.set(CONN, new Set(['b1'])); });
        expect(labels()).toEqual(['two']);

        await act(async () => { inactiveButtons.clear(CONN); });
        expect(labels()).toEqual(['one', 'two']);
    });

    it('leaves a broken toolbar off with its buttons', async () => {
        await render();
        await act(async () => { inactiveButtons.set(CONN, new Set(['bar'])); });
        expect(container.querySelector('.mudlet-buttonbar')).toBeNull();
    });
});
