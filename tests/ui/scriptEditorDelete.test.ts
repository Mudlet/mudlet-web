// Deleting an editor item was instant, unconfirmed and unrecoverable: no
// dialog, no toast, no undo, and deleting a group took its whole subtree with
// it just as silently.
//
// Mudlet deletes on the spot too — it never asks — but every delete path builds
// an EditorDeleteItemCommand and pushes it onto the editor's undo stack
// (dlgTriggerEditor.cpp:3714 for triggers, :3089/:3237/:3441/:3575/:3848 for
// the other five views), bound to QKeySequence::Undo (:461). This is that
// model ported: the item stack, Ctrl+Z, and a five-second undo offer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { captureDeletion, describeDeletion, pushBounded, EDITOR_UNDO_LIMIT } from '../../src/ui/windows/panels/editorUndo';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';

// React's act() needs this flag set on the global before the first render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'conn-delete';

const fakeSession = {
    scriptLog: [] as unknown[],
    events: { on: () => () => {} },
    clearScriptLog: () => {},
};
const fakeVfs = {
    profilePath: `/profiles/${CONN}`,
    exists: () => false,
    readBinaryFile: () => new Uint8Array(),
    flush: async () => {},
};

let container: HTMLDivElement;
let root: Root;

async function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(createElement(ConfirmProvider, null,
            createElement(ScriptEditorPanel as never, { connectionId: CONN, session: fakeSession, vfs: fakeVfs } as never)));
    });
    const nav = [...container.querySelectorAll('.script-editor__nav-btn')] as HTMLElement[];
    await act(async () => { nav.find(b => b.textContent?.includes('Triggers'))!.click(); });
}

async function selectItem(name: string) {
    const item = ([...container.querySelectorAll('.script-editor__item')] as HTMLElement[])
        .find(el => el.textContent?.includes(name))!;
    await act(async () => { item.click(); });
}

async function clickDelete() {
    const btn = ([...container.querySelectorAll('.script-editor__actions button')] as HTMLElement[])
        .find(b => b.textContent === 'Delete')!;
    await act(async () => { btn.click(); });
}

const toast = () => container.querySelector('.script-editor__undo-toast');

async function clickToastUndo() {
    await act(async () => {
        (toast()!.querySelector('.script-editor__undo-toast-action') as HTMLElement).click();
    });
}

/** Ctrl+Z on the panel root — where the event lands when the code pane
 *  declined it or was never focused. */
async function pressUndoShortcut(shift = false) {
    const el = container.querySelector('.script-editor') as HTMLElement;
    await act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: shift, bubbles: true }));
    });
}

const triggerIds = () => useAppStore.getState().connectionTriggers[CONN].map(t => t.id);

const leaf = (id: string, name: string, parentId: string | null = null) => ({
    id, name, enabled: true, isGroup: false, parentId, language: 'lua',
    code: '', patterns: [{ type: 'substring', text: name }],
    fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
});
const group = (id: string, name: string, parentId: string | null = null) => ({
    ...leaf(id, name, parentId), isGroup: true, patterns: [],
});

describe('script editor delete is recoverable', () => {
    beforeEach(() => {
        useAppStore.setState({
            connectionTriggers: { [CONN]: [
                leaf('t1', 'qa-sub'),
                group('g1', 'qa-group'),
                leaf('t2', 'qa-child', 'g1'),
                leaf('t3', 'qa-branch', 'g1'),
                leaf('t4', 'qa-deep', 't3'),
                leaf('t5', 'qa-last'),
            ] },
        } as never);
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });

    it('deletes at once, as desktop does — no dialog in the way', async () => {
        await mount();
        await selectItem('qa-sub');
        await clickDelete();

        expect(container.querySelector('[role="alertdialog"]')).toBeNull();
        expect(triggerIds()).not.toContain('t1');
    });

    it('offers an undo naming what went', async () => {
        await mount();
        await selectItem('qa-sub');
        await clickDelete();

        expect(toast()).not.toBeNull();
        expect(toast()!.textContent).toContain('delete trigger "qa-sub"');
    });

    it('restores the item at the position it was deleted from', async () => {
        await mount();
        await selectItem('qa-sub');
        await clickDelete();
        await clickToastUndo();

        expect(triggerIds()).toEqual(['t1', 'g1', 't2', 't3', 't4', 't5']);
    });

    it('restores a whole group subtree, links intact', async () => {
        await mount();
        await selectItem('qa-group');
        await clickDelete();
        expect(triggerIds()).toEqual(['t1', 't5']);
        // Desktop counts the captured descendants too, not just the picked item.
        expect(toast()!.textContent).toContain('delete 4 triggers');

        await clickToastUndo();
        expect(triggerIds()).toEqual(['t1', 'g1', 't2', 't3', 't4', 't5']);
        const byId = new Map(useAppStore.getState().connectionTriggers[CONN].map(t => [t.id, t]));
        expect(byId.get('t2')!.parentId).toBe('g1');
        expect(byId.get('t4')!.parentId).toBe('t3');
    });

    it('undoes with Ctrl+Z', async () => {
        await mount();
        await selectItem('qa-sub');
        await clickDelete();
        await pressUndoShortcut();

        expect(triggerIds()).toEqual(['t1', 'g1', 't2', 't3', 't4', 't5']);
        expect(toast()).toBeNull();
    });

    it('redoes with Ctrl+Shift+Z, taking the subtree again', async () => {
        await mount();
        await selectItem('qa-group');
        await clickDelete();
        await pressUndoShortcut();
        expect(triggerIds()).toEqual(['t1', 'g1', 't2', 't3', 't4', 't5']);

        await pressUndoShortcut(true);
        expect(triggerIds()).toEqual(['t1', 't5']);
    });

    it('unwinds several deletes in reverse order', async () => {
        await mount();
        await selectItem('qa-sub');
        await clickDelete();
        await selectItem('qa-last');
        await clickDelete();
        expect(triggerIds()).toEqual(['g1', 't2', 't3', 't4']);

        await pressUndoShortcut();
        expect(triggerIds()).toEqual(['g1', 't2', 't3', 't4', 't5']);
        await pressUndoShortcut();
        expect(triggerIds()).toEqual(['t1', 'g1', 't2', 't3', 't4', 't5']);
    });

    it('leaves a text field\'s own undo alone', async () => {
        await mount();
        await selectItem('qa-sub');
        await clickDelete();
        await selectItem('qa-last');

        // Desktop's window-scoped QAction would take Ctrl+Z off a QLineEdit
        // too; here the field keeps its native undo and the item stack is not
        // touched.
        const name = container.querySelector('.script-editor__name') as HTMLInputElement;
        await act(async () => {
            name.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        });
        expect(triggerIds()).not.toContain('t1');
    });

    it('lets Ctrl+Z through from the code pane once its own history is spent', async () => {
        await mount();
        await selectItem('qa-sub');
        await clickDelete();
        // Select something so the code editor is mounted and focusable. Its own
        // history is empty, so CodeMirror declines the key and the item stack
        // gets it — `slot_smartUndo`'s order, not focus.
        await selectItem('qa-last');

        const pane = container.querySelector('.cm-content') as HTMLElement;
        expect(pane).not.toBeNull();
        await act(async () => {
            pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        });
        expect(triggerIds()).toContain('t1');
    });

    it('drops the undo offer after five seconds', async () => {
        vi.useFakeTimers();
        try {
            await mount();
            await selectItem('qa-sub');
            await clickDelete();
            expect(toast()).not.toBeNull();

            await act(async () => { vi.advanceTimersByTime(5000); });
            expect(toast()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('editorUndo helpers', () => {
    const items = [
        { id: 'a', parentId: null, name: 'a' },
        { id: 'g', parentId: null, name: 'g' },
        { id: 'c', parentId: 'g', name: 'c' },
        { id: 'd', parentId: 'c', name: 'd' },
    ];

    it('captures the item, its descendants and their indices', () => {
        expect(captureDeletion(items, 'g')).toEqual([
            { index: 1, node: items[1] },
            { index: 2, node: items[2] },
            { index: 3, node: items[3] },
        ]);
    });

    it('captures a leaf on its own', () => {
        expect(captureDeletion(items, 'a')).toEqual([{ index: 0, node: items[0] }]);
    });

    it('finds a child stored before its parent', () => {
        const reversed = [...items].reverse();
        expect(captureDeletion(reversed, 'g').map(e => e.node.id).sort()).toEqual(['c', 'd', 'g']);
    });

    it('labels a single deletion the way the undo menu does', () => {
        expect(describeDeletion('triggers', [{ node: { name: 'qa-sub' } }])).toBe('delete trigger "qa-sub"');
        expect(describeDeletion('keys', [{ node: { name: 'k' } }])).toBe('delete key "k"');
    });

    it('labels a multi-item deletion by count', () => {
        expect(describeDeletion('aliases', [{ node: { name: 'x' } }, { node: { name: 'y' } }])).toBe('delete 2 aliases');
    });

    it('holds the stack at Mudlet\'s 50-command limit', () => {
        let stack: number[] = [];
        for (let i = 0; i < EDITOR_UNDO_LIMIT + 10; i++) stack = pushBounded(stack, i);
        expect(stack).toHaveLength(EDITOR_UNDO_LIMIT);
        expect(stack[0]).toBe(10);
        expect(stack[stack.length - 1]).toBe(EDITOR_UNDO_LIMIT + 9);
    });
});
