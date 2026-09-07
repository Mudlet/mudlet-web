import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextMenu, nextMenuIndex } from '../../src/ui/components/ContextMenu';
import { OutputContextMenu } from '../../src/ui/output/OutputContextMenu';

// The right-click menu used to be an anonymous div of anonymous buttons that
// took no focus when it opened, so a screen reader gave no sign anything had
// happened. These lock in the menu semantics and the keyboard contract.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
});

const menuEl = () => document.querySelector('.ctx-menu')!;
const items = () => Array.from(document.querySelectorAll('.ctx-menu__item'));

function renderMenu(children: unknown, props: Record<string, unknown> = {}) {
    act(() => {
        root.render(createElement(
            ContextMenu,
            { x: 10, y: 20, onClose: () => {}, ...props } as never,
            children as never,
        ));
    });
}

/** Three plain entries, the middle one disabled. */
const threeItems = () => [
    createElement('button', { key: 'a', className: 'ctx-menu__item' }, 'One'),
    createElement('button', { key: 'b', className: 'ctx-menu__item', disabled: true }, 'Two'),
    createElement('div', { key: 's', className: 'ctx-menu__sep' }),
    createElement('button', { key: 'c', className: 'ctx-menu__item' }, 'Three'),
];

describe('nextMenuIndex', () => {
    it('has nowhere to go in an empty menu', () => {
        for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
            expect(nextMenuIndex(0, -1, key)).toBeNull();
        }
    });

    it('enters at the first entry from outside, in either direction', () => {
        expect(nextMenuIndex(3, -1, 'ArrowDown')).toBe(0);
        expect(nextMenuIndex(3, -1, 'ArrowUp')).toBe(2);
    });

    it('wraps at both ends', () => {
        expect(nextMenuIndex(3, 2, 'ArrowDown')).toBe(0);
        expect(nextMenuIndex(3, 0, 'ArrowUp')).toBe(2);
    });

    it('steps one at a time in the middle', () => {
        expect(nextMenuIndex(3, 1, 'ArrowDown')).toBe(2);
        expect(nextMenuIndex(3, 1, 'ArrowUp')).toBe(0);
    });

    it('jumps to the ends with Home and End', () => {
        expect(nextMenuIndex(3, 1, 'Home')).toBe(0);
        expect(nextMenuIndex(3, 1, 'End')).toBe(2);
    });

    it('ignores keys the menu does not own', () => {
        expect(nextMenuIndex(3, 1, 'a')).toBeNull();
        expect(nextMenuIndex(3, 1, 'PageDown')).toBeNull();
    });
});

describe('ContextMenu semantics', () => {
    it('is a named menu of menuitems', () => {
        renderMenu(threeItems(), { label: 'Output actions' });
        expect(menuEl().getAttribute('role')).toBe('menu');
        expect(menuEl().getAttribute('aria-label')).toBe('Output actions');
        expect(items().map(el => el.getAttribute('role'))).toEqual(['menuitem', 'menuitem', 'menuitem']);
        expect(document.querySelector('.ctx-menu__sep')!.getAttribute('role')).toBe('separator');
    });

    it('carries a fallback name so it is never an anonymous popup', () => {
        renderMenu(threeItems());
        expect(menuEl().getAttribute('aria-label')).toBe('Context menu');
    });

    it('describes a swatch grid as a group rather than a menu', () => {
        renderMenu(createElement('div', null, 'swatches'), { role: 'group', label: 'Foreground colour' });
        expect(menuEl().getAttribute('role')).toBe('group');
    });

    it('stamps roles onto entries every consumer renders, including the real output menu', () => {
        act(() => {
            root.render(createElement(OutputContextMenu, {
                x: 0, y: 0,
                hasSelection: true,
                hasContent: true,
                onSelectAll: () => {}, onCopy: () => {}, onCopyHtml: () => {}, onCopyImage: () => {},
                searchEngine: 'Google', onSearchOnline: () => {},
                onClose: () => {},
            } as never));
        });
        expect(menuEl().getAttribute('aria-label')).toBe('Output actions');
        expect(items().length).toBeGreaterThan(0);
        expect(items().every(el => el.getAttribute('role') === 'menuitem')).toBe(true);
    });
});

describe('ContextMenu focus', () => {
    it('moves focus to the first entry when it opens', () => {
        renderMenu(threeItems());
        expect(document.activeElement).toBe(items()[0]);
    });

    it('makes entries roving stops, not Tab stops', () => {
        renderMenu(threeItems());
        expect(items().map(el => (el as HTMLElement).tabIndex)).toEqual([-1, -1, -1]);
    });

    it('hands focus back to whatever opened it', () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();

        renderMenu(threeItems());
        expect(document.activeElement).not.toBe(opener);

        act(() => root.unmount());
        expect(document.activeElement).toBe(opener);

        // Re-armed for the shared afterEach.
        root = createRoot(container);
    });

    it('hands focus to returnFocusTo instead, when one is given', () => {
        const opener = document.createElement('button');
        const elsewhere = document.createElement('button');
        document.body.append(opener, elsewhere);
        opener.focus();

        renderMenu(threeItems(), { returnFocusTo: () => elsewhere });
        act(() => root.unmount());
        expect(document.activeElement).toBe(elsewhere);

        root = createRoot(container);
    });

    it('falls back to the opener when returnFocusTo has no target', () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();

        // What the console passes on a touch phone, where focusing the command
        // line would summon a keyboard over what the player was reading.
        renderMenu(threeItems(), { returnFocusTo: () => null });
        act(() => root.unmount());
        expect(document.activeElement).toBe(opener);

        root = createRoot(container);
    });

    // The console's copy entries act on the page selection, and the command line
    // it hands focus back to is a text field — focusing one collapses the
    // selection in Chrome, which silently undid the "Select all" that had just
    // run. happy-dom does not model that collapse, so the target models it here.
    it('carries the selection across the focus handover', () => {
        const text = document.createElement('div');
        text.textContent = 'selected output';
        const field = document.createElement('textarea');
        document.body.append(text, field);
        const collapsesSelection = () => {
            HTMLElement.prototype.focus.call(field);
            window.getSelection()!.removeAllRanges();
        };

        const range = document.createRange();
        range.selectNodeContents(text);
        window.getSelection()!.addRange(range);

        renderMenu(threeItems(), { returnFocusTo: () => ({ focus: collapsesSelection }) });
        act(() => root.unmount());

        expect(document.activeElement).toBe(field);
        expect(window.getSelection()!.toString()).toBe('selected output');

        root = createRoot(container);
    });

    it('skips disabled entries when arrowing', () => {
        renderMenu(threeItems());
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
        // Entry two is disabled, so ArrowDown from the first lands on the third.
        expect(document.activeElement).toBe(items()[2]);
    });

    it('closes on Escape and on Tab', () => {
        for (const key of ['Escape', 'Tab']) {
            let closed = false;
            renderMenu(threeItems(), { onClose: () => { closed = true; } });
            act(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            });
            expect(closed, `${key} should dismiss the menu`).toBe(true);
        }
    });
});
