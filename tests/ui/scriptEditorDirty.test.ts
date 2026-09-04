// The script editor's Save button doubles as the dirty indicator: "Saved" /
// "Run" at rest, "Save" / "Save & Run" when there is unsaved work. It was stuck
// on the unsaved label for every item, because LuaEditor's value-sync effect
// pushes the newly selected item's code into the CodeMirror document, and that
// document replacement reached the update listener as if the user had typed it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';

// React's act() needs this flag set on the global before the first render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'conn-dirty';

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

/** The label on the primary action button — the editor's dirty indicator. */
function saveLabel(): string {
    const btns = [...container.querySelectorAll('.script-editor__actions button')] as HTMLElement[];
    return btns[btns.length - 1].textContent ?? '';
}

describe('script editor dirty indicator', () => {
    beforeEach(() => {
        useAppStore.setState({
            connectionTriggers: { [CONN]: [
                { id: 't1', name: 'qa-sub', enabled: true, isGroup: false, parentId: null, language: 'lua',
                  code: 'echo("one")', patterns: [{ type: 'substring', text: 'one' }],
                  fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false },
                { id: 't2', name: 'qa-sol', enabled: true, isGroup: false, parentId: null, language: 'lua',
                  code: 'echo("two")', patterns: [{ type: 'startOfLine', text: 'two' }],
                  fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false },
            ] },
            connectionScripts: { [CONN]: [
                { id: 's1', name: 'qa-script', enabled: true, isGroup: false, parentId: null,
                  language: 'lua', code: 'local x = 1', eventHandlers: [] },
            ] },
        } as never);
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });

    it('rests at "Saved" when a trigger is merely selected', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');
        expect(saveLabel()).toBe('Saved');
    });

    it('stays at rest when the selection moves to another item', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');
        await selectItem('qa-sol');
        expect(saveLabel()).toBe('Saved');
    });

    it('rests at "Run" for a saved script', async () => {
        await mount();
        await openCategory('Scripts');
        await selectItem('qa-script');
        expect(saveLabel()).toBe('Run');
    });

    it('turns to "Save" as soon as something is actually edited', async () => {
        await mount();
        await openCategory('Triggers');
        await selectItem('qa-sub');

        const name = container.querySelector('.script-editor__name') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
                .set!.call(name, 'qa-sub-EDITED');
            name.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(saveLabel()).toBe('Save');
    });

    it('marks a brand-new empty script dirty so its template can be saved', async () => {
        useAppStore.setState({
            connectionScripts: { [CONN]: [
                { id: 's2', name: 'fresh', enabled: true, isGroup: false, parentId: null,
                  language: 'lua', code: '', eventHandlers: [] },
            ] },
        } as never);
        await mount();
        await openCategory('Scripts');
        await selectItem('fresh');
        expect(saveLabel()).toBe('Save & Run');
    });
});
