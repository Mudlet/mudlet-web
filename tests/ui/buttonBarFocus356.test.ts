// mudlet-web#356, the bar's side:
// - after a click the command line has focus again, as desktop's
//   TAction::execute ends with setFocusOnHostActiveCommandLine;
// - a toolbar's style sheet cascades onto its buttons under their own sheet,
//   as Qt cascades a sheet set on the toolbar widget.
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useButtonStrips } from '../../src/ui/buttons/ButtonsBar';
import { useAppStore } from '../../src/storage';
import type { ButtonNode } from '../../src/storage/schema';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'buttonbar-focus-356';

function button(p: Partial<ButtonNode>): ButtonNode {
    return {
        id: 'b', name: 'B', enabled: true, isGroup: false, parentId: null,
        code: '', language: 'lua', orientation: 'horizontal', location: 'top',
        columns: 0, isPushDown: false, buttonState: false, ...p,
    };
}

let container: HTMLDivElement;
let input: HTMLInputElement;
let root: Root;
let clicked: string[];

async function render(buttons: ButtonNode[], onExecute?: () => void) {
    useAppStore.setState({ connectionButtons: { [CONN]: buttons } } as never);
    clicked = [];
    const engineRef = {
        current: {
            executeButton: (b: ButtonNode) => { clicked.push(b.name); onExecute?.(); },
        } as never,
    };
    input = document.createElement('input');
    document.body.appendChild(input);
    const commandInputRef = { current: input };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function Harness() {
        return useButtonStrips({ connectionId: CONN, engineRef, vfs: null, commandInputRef }).top;
    }
    await act(async () => { root.render(createElement(Harness)); });
}

const btn = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('.mudlet-btn')].find(b => b.textContent === label)!;

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    input.remove();
    useAppStore.setState({ connectionButtons: {} } as never);
});

const BAR = [
    button({ id: 'bar', name: 'bar', isGroup: true }),
    button({ id: 'b1', name: 'one', parentId: 'bar' }),
    button({ id: 'pb', name: 'PB', parentId: 'bar', isPushDown: true }),
];

describe('focus after a button click', () => {
    it('goes back to the command line', async () => {
        await render(BAR);
        const b = btn('one');
        b.focus();
        await act(async () => { b.click(); });
        expect(clicked).toEqual(['one']);
        expect(document.activeElement).toBe(input);

        const pb = btn('PB');
        pb.focus();
        await act(async () => { pb.click(); });
        expect(document.activeElement).toBe(input);
    });

    it('stays where the button script put it', async () => {
        const other = document.createElement('textarea');
        document.body.appendChild(other);
        try {
            await render(BAR, () => other.focus());
            const b = btn('one');
            b.focus();
            await act(async () => { b.click(); });
            expect(document.activeElement).toBe(other);
        } finally {
            other.remove();
        }
    });
});

describe('a toolbar style sheet', () => {
    it('restyles every button on it, under the button\'s own sheet', async () => {
        await render([
            button({ id: 'bar', name: 'bar', isGroup: true, styleSheet: 'color: red; background-color: black;' }),
            button({ id: 'b1', name: 'one', parentId: 'bar' }),
            button({ id: 'b2', name: 'two', parentId: 'bar', styleSheet: 'color: blue;' }),
        ]);
        expect(btn('one').style.color).toBe('red');
        expect(btn('one').style.backgroundColor).toBe('black');
        expect(btn('two').style.color).toBe('blue');
        expect(btn('two').style.backgroundColor).toBe('black');
    });
});
