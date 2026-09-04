// Leaving an item in the script editor used to throw away whatever had been
// typed into it: the [selectedId, category] effect reloaded every edit field
// from the newly selected item without writing the outgoing one back, and
// closing the editor unmounted the panel with the same result.
//
// Mudlet has no unsaved-changes concept — a selection change saves the outgoing
// item first (dlgTriggerEditor::slot_triggerSelected, dlgTriggerEditor.cpp:
// 7703-7709) on top of its per-property autosaves — so mudix commits too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';

// React's act() needs this flag set on the global before the first render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'conn-autocommit';

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
let mounted = false;

async function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
    await act(async () => {
        root.render(createElement(ConfirmProvider, null,
            createElement(ScriptEditorPanel as never, { connectionId: CONN, session: fakeSession, vfs: fakeVfs } as never)));
    });
}

async function unmount() {
    if (!mounted) return;
    mounted = false;
    await act(async () => { root.unmount(); });
    container.remove();
}

async function openCategory(label: string) {
    const nav = [...container.querySelectorAll('.script-editor__nav-btn')] as HTMLElement[];
    await act(async () => { nav.find(b => b.textContent?.includes(label))!.click(); });
}

async function selectItem(name: string) {
    const item = ([...container.querySelectorAll('.script-editor__item')] as HTMLElement[])
        .find(el => el.textContent?.includes(name))!;
    await act(async () => { item.click(); });
}

/** Type into a controlled input the way React expects: the DOM value node is
 *  tracked, so a plain assignment would be swallowed as "no change". */
async function typeInto(el: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

const triggerNode = (id: string, name: string) => ({
    id, name, enabled: true, isGroup: false, parentId: null, language: 'lua',
    code: `echo("${name}")`, patterns: [{ type: 'substring', text: name }],
    fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
});

describe('script editor auto-commit', () => {
    beforeEach(() => {
        useAppStore.setState({
            connectionTriggers: { [CONN]: [triggerNode('t1', 'qa-sub'), triggerNode('t2', 'qa-sol')] },
            connectionAliases: { [CONN]: [
                { id: 'a1', name: 'qa-alias', enabled: true, isGroup: false, parentId: null,
                  language: 'lua', code: '', pattern: '^hi$', command: 'hello' },
            ] },
        } as never);
    });
    afterEach(unmount);

    it('keeps a rename when the selection moves to another item', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');
        await typeInto(container.querySelector('.script-editor__name') as HTMLInputElement, 'qa-sub-EDITED');

        await selectItem('qa-sol');

        const t1 = useAppStore.getState().connectionTriggers[CONN].find(t => t.id === 't1')!;
        expect(t1.name).toBe('qa-sub-EDITED');
    });

    it('does not smear the outgoing item\'s edits onto the newly selected one', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');
        await typeInto(container.querySelector('.script-editor__name') as HTMLInputElement, 'qa-sub-EDITED');
        await selectItem('qa-sol');

        const t2 = useAppStore.getState().connectionTriggers[CONN].find(t => t.id === 't2')!;
        expect(t2.name).toBe('qa-sol');
        // ...and the name field now shows the item that is actually selected.
        expect((container.querySelector('.script-editor__name') as HTMLInputElement).value).toBe('qa-sol');
    });

    it('keeps a bulk pattern edit across a selection change', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');
        const add = [...container.querySelectorAll('.script-editor__pattern-add')][0] as HTMLElement;
        await act(async () => { add.click(); });
        await act(async () => { add.click(); });

        await selectItem('qa-sol');

        const t1 = useAppStore.getState().connectionTriggers[CONN].find(t => t.id === 't1')!;
        expect(t1.patterns).toHaveLength(3);
    });

    it('keeps an edit when the editor is closed', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');
        await typeInto(container.querySelector('.script-editor__name') as HTMLInputElement, 'qa-sub-CLOSED');

        await unmount();

        const t1 = useAppStore.getState().connectionTriggers[CONN].find(t => t.id === 't1')!;
        expect(t1.name).toBe('qa-sub-CLOSED');
    });

    it('keeps an edit when the category changes', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');
        await typeInto(container.querySelector('.script-editor__name') as HTMLInputElement, 'qa-sub-XCAT');

        await openCategory('Aliases');

        const t1 = useAppStore.getState().connectionTriggers[CONN].find(t => t.id === 't1')!;
        expect(t1.name).toBe('qa-sub-XCAT');
        // The alias that was never touched is left exactly as it was.
        expect(useAppStore.getState().connectionAliases[CONN][0].name).toBe('qa-alias');
    });

    it('leaves untouched items alone when nothing was edited', async () => {
        await mount();
        await openCategory('Triggers');
        const before = useAppStore.getState().connectionTriggers[CONN]
            .map(t => ({ name: t.name, code: t.code, patterns: t.patterns }));

        await selectItem('qa-sub');
        await selectItem('qa-sol');
        await selectItem('qa-sub');

        expect(useAppStore.getState().connectionTriggers[CONN]
            .map(t => ({ name: t.name, code: t.code, patterns: t.patterns }))).toEqual(before);
    });
});
