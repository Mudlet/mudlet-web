// Regressions found reviewing PR #125, covered so they stay fixed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { VariablesView, renameHiddenPaths } from '../../src/ui/windows/panels/VariablesView';
import { clampFillerOffset } from '../../src/storage/schema';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';
import type { AliasNode } from '../../src/storage/schema';
import type { LuaGlobalEntry, VariableEdit } from '../../src/scripting/IScriptingRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seq = 0;
const nextConn = (p: string) => `${p}-${++seq}`;

const fakeVfs = {
    profilePath: '/profiles/test',
    exists: () => false,
    readBinaryFile: () => new Uint8Array(),
    flush: async () => {},
};
const fakeSession = { scriptLog: [] as unknown[], clearScriptLog: () => {}, promptMarkerSeen: false, events: { on: () => () => {} } };

let container: HTMLDivElement;
let root: Root | null = null;

async function unmount() {
    if (!root) return;
    const r = root; root = null;
    await act(async () => { r.unmount(); });
    container.remove();
}
afterEach(unmount);

// (collectSubtree/cloneSubtree root ordering is covered in editorClipboard.test.ts)

// ── The renderer clamps fillerOffset the same way the editor does ────────────

describe('clampFillerOffset', () => {
    it('caps at one less than the row count', () => {
        expect(clampFillerOffset(9, 3)).toBe(2);
    });

    it('is zero for a toolbar that does not wrap', () => {
        expect(clampFillerOffset(2, 1)).toBe(0);
        expect(clampFillerOffset(2, 0)).toBe(0);
    });

    it('refuses nonsense', () => {
        expect(clampFillerOffset(NaN, 4)).toBe(0);
        expect(clampFillerOffset(-3, 4)).toBe(0);
        expect(clampFillerOffset(1.9, 4)).toBe(1);
    });
});

// ── Hidden paths follow a rename ─────────────────────────────────────────────

describe('renameHiddenPaths', () => {
    it('moves the renamed entry', () => {
        expect(renameHiddenPaths(['foo'], 'foo', 'bar')).toEqual(['bar']);
    });

    it('moves everything nested under it', () => {
        expect(renameHiddenPaths(['foo.a', 'foo[2]', 'other'], 'foo', 'bar'))
            .toEqual(['bar.a', 'bar[2]', 'other']);
    });

    it('does not capture a name that merely starts the same', () => {
        expect(renameHiddenPaths(['fooTwo'], 'foo', 'bar')).toBe(null);
    });

    it('returns null when nothing referred to the old path', () => {
        expect(renameHiddenPaths(['other'], 'foo', 'bar')).toBe(null);
    });
});

// ── Variables view ───────────────────────────────────────────────────────────

describe('VariablesView review fixes', () => {
    const CONN = 'review-vars';
    let edits: VariableEdit[];

    async function mountVars(globals: LuaGlobalEntry[], focus?: { name: string; revision: number }) {
        edits = [];
        const engine = { listGlobals: () => globals, editVariable: (e: VariableEdit) => { edits.push(e); return null; } };
        const consumed: number[] = [];
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(createElement(ConfirmProvider, null,
                createElement(VariablesView as never, {
                    connectionId: CONN,
                    scriptingEngineRef: { current: engine },
                    focus: focus ?? null,
                    onFocusConsumed: () => consumed.push(1),
                } as never)));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        return consumed;
    }

    const names = () => [...container.querySelectorAll('.variables__row')]
        .map(r => r.querySelector('.variables__name')?.textContent ?? '');
    const error = () => container.querySelector('.variables__error')?.textContent ?? null;

    async function clickHeader(label: string) {
        const btn = [...container.querySelectorAll('.script-editor__error-log-header button')]
            .find(b => b.textContent?.trim() === label) as HTMLElement;
        await act(async () => { btn.click(); });
    }

    async function setValue(el: HTMLInputElement, value: string) {
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    const draft = () => container.querySelector('.variables__row--draft') as HTMLElement;

    beforeEach(() => {
        useAppStore.setState({ connectionVariables: { [CONN]: { saveList: [], values: [], hidden: [] } } } as never);
    });

    it('refuses to create over a global that already exists', async () => {
        await mountVars([{ name: 'myTable', valueType: 'table', saveable: true, isTable: true }]);
        await clickHeader('+ New');
        await setValue(draft().querySelector('.variables__draft-name') as HTMLInputElement, 'myTable');
        await act(async () => { (draft().querySelector('button') as HTMLElement).click(); });

        expect(edits).toEqual([]);
        expect(error()).toContain('already exists');
    });

    it('still allows editing that same global in place', async () => {
        await mountVars([{ name: 'myVar', valueType: 'string', saveable: true, value: 'old' }]);
        const edit = [...container.querySelectorAll('.variables__action')]
            .find(b => /Edit name/.test((b as HTMLElement).title)) as HTMLElement;
        await act(async () => { edit.click(); });
        await act(async () => { (draft().querySelector('button') as HTMLElement).click(); });

        expect(edits).toEqual([
            { op: 'set', path: [{ key: 'myVar', kind: 'string' }], valueType: 'string', value: 'old' },
        ]);
    });

    it('reveals a hidden variable a search result points at', async () => {
        useAppStore.setState({ connectionVariables: { [CONN]: { saveList: [], values: [], hidden: ['secret'] } } } as never);
        await mountVars(
            [{ name: 'secret', valueType: 'string', saveable: true, value: 'FINDME' }],
            { name: 'secret', revision: 1 },
        );
        // Without the reveal this landed on "no globals match the filter".
        expect(names()).toEqual(['secret']);
    });

    it('reports the focus consumed, so a stale one cannot re-apply on remount', async () => {
        const consumed = await mountVars(
            [{ name: 'shown', valueType: 'string', saveable: true }],
            { name: 'shown', revision: 1 },
        );
        expect(consumed).toEqual([1]);
    });

    it('carries hidden paths across a rename', async () => {
        useAppStore.setState({
            connectionVariables: { [CONN]: { saveList: [], values: [], hidden: ['foo', 'foo.inner'] } },
        } as never);
        await mountVars([{ name: 'foo', valueType: 'string', saveable: true, value: 'v' }]);

        const toggle = [...container.querySelectorAll('.variables__toggle')]
            .find(l => l.textContent?.includes('Show hidden'))!.querySelector('input') as HTMLInputElement;
        await act(async () => { toggle.click(); });
        const edit = [...container.querySelectorAll('.variables__action')]
            .find(b => /Edit name/.test((b as HTMLElement).title)) as HTMLElement;
        await act(async () => { edit.click(); });
        await setValue(draft().querySelector('.variables__draft-name') as HTMLInputElement, 'bar');
        await act(async () => { (draft().querySelector('button') as HTMLElement).click(); });

        // 'foo' left behind would silently hide the next variable called 'foo'.
        expect(useAppStore.getState().connectionVariables[CONN].hidden).toEqual(['bar', 'bar.inner']);
    });
});

// ── Panel: copy takes typed edits, and paste is undoable ────────────────────

describe('ScriptEditorPanel review fixes', () => {
    async function mountPanel(connectionId: string) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(createElement(ConfirmProvider, null,
                createElement(ScriptEditorPanel as never,
                    { connectionId, session: fakeSession, vfs: fakeVfs } as never)));
        });
        const nav = [...container.querySelectorAll('.script-editor__nav-btn')] as HTMLElement[];
        await act(async () => { nav.find(b => b.textContent?.includes('Aliases'))!.click(); });
    }

    function seedAlias(conn: string) {
        useAppStore.setState({
            connectionAliases: {
                [conn]: [{
                    id: 'a1', name: 'qa', enabled: true, isGroup: false, parentId: null,
                    language: 'lua', code: '', pattern: '^x$', command: 'old',
                } as AliasNode],
            },
        } as never);
    }

    const rows = () => [...container.querySelectorAll('.script-editor__item')] as HTMLElement[];
    const stored = (conn: string) => useAppStore.getState().connectionAliases[conn];

    async function contextMenu(name: string) {
        const el = rows().find(r => r.textContent?.includes(name))!;
        await act(async () => {
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
        });
        return [...document.querySelectorAll('.ctx-menu__item')] as HTMLElement[];
    }

    async function clickMenu(entries: HTMLElement[], text: string) {
        const btn = entries.find(b => b.textContent?.trim().startsWith(text))!;
        await act(async () => { btn.click(); });
    }

    it('duplicates what is typed, not the last-saved version', async () => {
        const conn = nextConn('review-panel');
        seedAlias(conn);
        await mountPanel(conn);
        await act(async () => { rows()[0].click(); });

        const command = [...container.querySelectorAll('.script-editor__pattern')][1] as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(command, 'typed');
            command.dispatchEvent(new Event('input', { bubbles: true }));
        });

        await clickMenu(await contextMenu('qa'), 'Duplicate');

        // Both the original and the copy carry what was on screen.
        expect(stored(conn).map(a => a.command)).toEqual(['typed', 'typed']);
    });

    it('undoes a paste rather than reaching past it to an older delete', async () => {
        const conn = nextConn('review-panel');
        useAppStore.setState({
            connectionAliases: {
                [conn]: [
                    { id: 'a1', name: 'keep', enabled: true, isGroup: false, parentId: null, language: 'lua', code: '', pattern: '^a$', command: 'a' },
                    { id: 'a2', name: 'doomed', enabled: true, isGroup: false, parentId: null, language: 'lua', code: '', pattern: '^b$', command: 'b' },
                ] as AliasNode[],
            },
        } as never);
        await mountPanel(conn);

        await clickMenu(await contextMenu('doomed'), 'Delete');
        expect(stored(conn).map(a => a.name)).toEqual(['keep']);

        await clickMenu(await contextMenu('keep'), 'Copy');
        await clickMenu(await contextMenu('keep'), 'Paste');
        expect(stored(conn).map(a => a.name)).toEqual(['keep', 'keep (copy)']);

        const panel = container.querySelector('.script-editor') as HTMLElement;
        await act(async () => {
            panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        });

        // The paste goes; the deleted alias stays deleted until a second undo.
        expect(stored(conn).map(a => a.name)).toEqual(['keep']);

        await act(async () => {
            panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        });
        expect(stored(conn).map(a => a.name)).toEqual(['keep', 'doomed']);
    });

    it('redoes a paste it undid', async () => {
        const conn = nextConn('review-panel');
        seedAlias(conn);
        await mountPanel(conn);

        await clickMenu(await contextMenu('qa'), 'Duplicate');
        expect(stored(conn)).toHaveLength(2);

        const panel = container.querySelector('.script-editor') as HTMLElement;
        await act(async () => {
            panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        });
        expect(stored(conn)).toHaveLength(1);

        await act(async () => {
            panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
        });
        expect(stored(conn).map(a => a.name)).toEqual(['qa', 'qa (copy)']);
    });
});
