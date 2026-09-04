import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResizableModal } from '../../src/ui/ResizableModal';

// The keyboard contract every ResizableModal-based dialog claims by carrying
// `aria-modal="true"`: focus moves in on open, Tab and Shift+Tab stay inside,
// Escape closes, and focus goes back to whatever opened it.
//
// It used to claim all four and honour none (issue #49). The dialog is rendered
// through a portal whose container is only known after a layout effect, so on
// the first render there was no node for useModalFocus's ref to point at; its
// setup effect bailed on the null ref and — refs not being state — never ran
// again once the portal mounted. The hook was fine, the wiring was not.
//
// (JSX is avoided so the file stays a plain .test.ts, matching the include glob.)

let host: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;

interface Props {
    onClose?: () => void;
    closeOnEscape?: boolean;
    children?: ReactNode;
}

const render = ({ onClose = () => {}, closeOnEscape, children }: Props = {}) =>
    act(() => {
        root.render(createElement(ResizableModal, {
            title: 'Logs',
            onClose,
            closeOnEscape,
            defaultW: 400,
            defaultH: 300,
            children: children ?? [
                createElement('button', { key: 'a' }, 'first'),
                createElement('button', { key: 'b' }, 'last'),
            ],
        }));
    });

const dialog = () => document.querySelector<HTMLElement>('.resizable-modal')!;
const buttons = () => Array.from(dialog().querySelectorAll('button'));

const press = (key: string, shiftKey = false) =>
    act(() => {
        (document.activeElement ?? document.body).dispatchEvent(
            new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
        );
    });

beforeEach(() => {
    // Something outside the dialog holding focus, standing in for the command
    // line in the issue's repro — it is what focus must leave and come back to.
    opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    opener.remove();
});

describe('ResizableModal keyboard contract', () => {
    it('moves focus into the dialog on open', () => {
        render();

        // Previously activeElement stayed on the opener, outside the dialog.
        expect(document.activeElement).not.toBe(opener);
        expect(dialog().contains(document.activeElement)).toBe(true);
        // First Tab stop in DOM order is the header's close button.
        expect((document.activeElement as HTMLElement).className).toContain('modal-close');
    });

    it('wraps Tab from the last control back to the first', () => {
        render();

        const items = buttons();
        items[items.length - 1].focus();
        press('Tab');

        expect(document.activeElement).toBe(items[0]);
        expect(dialog().contains(document.activeElement)).toBe(true);
    });

    it('wraps Shift+Tab from the first control back to the last', () => {
        render();

        const items = buttons();
        items[0].focus();
        press('Tab', true);

        // The repro walked out to the output wrapper and then the toolbar.
        expect(document.activeElement).toBe(items[items.length - 1]);
        expect(dialog().contains(document.activeElement)).toBe(true);
    });

    it('closes on Escape', () => {
        const onClose = vi.fn();
        render({ onClose });

        press('Escape');

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('leaves Escape alone when the dialog hosts an editor that wants it', () => {
        // The script and map editors opt out: Escape is spent on leaving key
        // capture / closing a find bar, as it is in Mudlet's dlgTriggerEditor.
        const onClose = vi.fn();
        render({ onClose, closeOnEscape: false });

        press('Escape');

        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector('.resizable-modal')).not.toBeNull();
    });

    it('leaves a child that autofocused itself alone', () => {
        // The help, docs, package-export and repository modals autofocus their
        // own search/name field; the trap must not yank focus to the ✕ button.
        render({ children: createElement('input', { autoFocus: true, className: 'search' }) });

        expect((document.activeElement as HTMLElement).className).toBe('search');
    });

    it('restores focus to the opener when it closes', () => {
        render();
        expect(document.activeElement).not.toBe(opener);

        act(() => { root.render(null); });

        expect(document.activeElement).toBe(opener);
    });

    it('closes when the header ✕ is used, and still restores focus', () => {
        const onClose = vi.fn();
        render({ onClose });

        act(() => {
            dialog().querySelector<HTMLButtonElement>('.modal-close')!.click();
        });
        expect(onClose).toHaveBeenCalledTimes(1);

        act(() => { root.render(null); });
        expect(document.activeElement).toBe(opener);
    });
});

describe('ResizableModal Escape during a move', () => {
    const mouse = (type: string, clientX: number, target: EventTarget) =>
        act(() => {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0 }));
        });

    it('abandons an in-flight drag instead of closing, and snaps back', () => {
        const onClose = vi.fn();
        render({ onClose });

        const header = dialog().querySelector<HTMLElement>('.resizable-modal__header')!;
        const before = dialog().style.left;

        mouse('mousedown', 0, header);
        mouse('mousemove', 60, window);
        expect(dialog().style.left).not.toBe(before);

        press('Escape');

        expect(dialog().style.left).toBe(before);
        // The first Escape belongs to the gesture, not to the dialog.
        expect(onClose).not.toHaveBeenCalled();
    });

    it('closes on the next Escape, once the drag is over', () => {
        const onClose = vi.fn();
        render({ onClose });

        const header = dialog().querySelector<HTMLElement>('.resizable-modal__header')!;
        mouse('mousedown', 0, header);
        mouse('mousemove', 60, window);
        press('Escape');
        press('Escape');

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not save bounds for a cancelled drag', () => {
        const onBoundsChange = vi.fn();
        act(() => {
            root.render(createElement(ResizableModal, {
                title: 'Logs',
                onClose: () => {},
                onBoundsChange,
                defaultW: 400,
                defaultH: 300,
                children: createElement('button', null, 'first'),
            }));
        });

        const header = dialog().querySelector<HTMLElement>('.resizable-modal__header')!;
        mouse('mousedown', 0, header);
        mouse('mousemove', 60, window);
        press('Escape');
        // The mouse-up that ends a real drag still arrives; it must not commit
        // the abandoned position (its listener is gone).
        mouse('mouseup', 60, window);

        expect(onBoundsChange).not.toHaveBeenCalled();
    });
});
