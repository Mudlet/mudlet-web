// The remaining script-editor gaps from issue #70, driven through the panel.
//
//  5. Button rotation (comboBox_action_button_rotation) and the toolbar's
//     offset-to-first-button spin box had no control at all.
//  7. An alias whose command matches its own pattern saved without a word, and
//     only the runtime's 25-level guard told the user afterwards. Desktop
//     refuses the save (`aliasSubstitutionLoops`, dlgTriggerEditor.cpp:6269).
//  9. The `prompt` pattern type showed an empty disabled box with no label;
//     desktop shows "match on the prompt line", greyed with a tooltip when the
//     game sends no Go-Ahead (dlgTriggerEditor.cpp:7222-7235).
// 10. Tree expansion and selection were thrown away when the editor closed.
// 11. There was no copy, paste or duplicate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';
import type { AliasNode, ButtonNode, TriggerNode } from '../../src/storage/schema';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The panel remembers each profile's open tab, expanded groups and selection
// for the life of the session (that is what item 10 is), so every test gets its
// own connection id rather than inheriting the previous one's tree.
let seq = 0;
const nextConn = (prefix: string) => `${prefix}-${++seq}`;

const fakeVfs = {
    profilePath: '/profiles/test',
    exists: () => false,
    readBinaryFile: () => new Uint8Array(),
    flush: async () => {},
};

/** A session whose GA latch and prompt subscribers the test drives. */
function makeSession(promptMarkerSeen = false) {
    const subs: Record<string, Array<() => void>> = {};
    return {
        scriptLog: [] as unknown[],
        clearScriptLog: () => {},
        promptMarkerSeen,
        events: {
            on: (name: string, fn: () => void) => {
                (subs[name] ??= []).push(fn);
                return () => { subs[name] = (subs[name] ?? []).filter(f => f !== fn); };
            },
        },
        emit: (name: string) => { for (const fn of [...(subs[name] ?? [])]) fn(); },
    };
}

let container: HTMLDivElement;
let root: Root | null = null;
let session = makeSession();

async function mount(connectionId: string) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(createElement(ConfirmProvider, null,
            createElement(ScriptEditorPanel as never, { connectionId, session, vfs: fakeVfs } as never)));
    });
}

async function unmount() {
    if (!root) return;
    const r = root;
    root = null;
    await act(async () => { r.unmount(); });
    container.remove();
}

async function openTab(label: string) {
    const nav = [...container.querySelectorAll('.script-editor__nav-btn')] as HTMLElement[];
    await act(async () => { nav.find(b => b.textContent?.includes(label))!.click(); });
}

const items = () => [...container.querySelectorAll('.script-editor__item')] as HTMLElement[];

function row(name: string): HTMLElement {
    const found = items().find(el => el.textContent?.includes(name));
    if (!found) throw new Error(`no tree row named "${name}" in [${items().map(i => i.textContent).join(', ')}]`);
    return found;
}

async function selectItem(name: string) {
    const el = row(name);
    await act(async () => { el.click(); });
}

async function expandGroup(name: string) {
    const el = row(name);
    await act(async () => { (el.querySelector('.script-editor__item-expand') as HTMLElement).click(); });
}

async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
}

async function save() {
    const btn = [...container.querySelectorAll('.script-editor__actions button')]
        .find(b => (b.textContent ?? '').startsWith('Save')) as HTMLElement;
    await act(async () => { btn.click(); });
}

/** Right-click a tree row and return the context menu entries. */
async function contextMenu(name: string): Promise<HTMLElement[]> {
    const el = row(name);
    await act(async () => {
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    return [...document.querySelectorAll('.ctx-menu__item')] as HTMLElement[];
}

async function paneContextMenu(): Promise<HTMLElement[]> {
    const pane = container.querySelector('.script-editor__items') as HTMLElement;
    await act(async () => {
        pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    return [...document.querySelectorAll('.ctx-menu__item')] as HTMLElement[];
}

async function clickMenu(entries: HTMLElement[], text: string) {
    const btn = entries.find(b => b.textContent?.trim().startsWith(text));
    if (!btn) throw new Error(`no context-menu entry starting "${text}" in [${entries.map(e => e.textContent?.trim()).join(', ')}]`);
    await act(async () => { btn.click(); });
}

beforeEach(() => {
    session = makeSession();
    useAppStore.setState({
        connectionTriggers: {}, connectionAliases: {}, connectionButtons: {},
        connectionScripts: {}, connectionTimers: {}, connectionKeybindings: {},
    } as never);
});
afterEach(unmount);

// ── 9. Prompt pattern label ──────────────────────────────────────────────────

describe('prompt pattern type', () => {
    function seedPromptTrigger(conn: string) {
        useAppStore.setState({
            connectionTriggers: {
                [conn]: [{
                    id: 't1', name: 'qa-prompt', enabled: true, isGroup: false, parentId: null,
                    language: 'lua', code: '', patterns: [{ type: 'prompt', text: '' }],
                    fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
                } as TriggerNode],
            },
        } as never);
    }

    const note = () => container.querySelector('.script-editor__pattern-note') as HTMLElement | null;

    async function openPromptTrigger(conn: string) {
        seedPromptTrigger(conn);
        await mount(conn);
        await openTab('Triggers');
        await selectItem('qa-prompt');
    }

    it('explains itself, greyed, when the game has never sent a Go-Ahead', async () => {
        await openPromptTrigger(nextConn('gaps-prompt'));

        expect(note()!.textContent).toBe('match on the prompt line (disabled)');
        expect(note()!.className).toContain('script-editor__pattern-note--disabled');
        expect(note()!.title).toMatch(/Go-Ahead/);
        // It replaces the empty disabled box the row used to be.
        expect(container.querySelector('.script-editor__pattern-text')).toBe(null);
    });

    it('un-greys as soon as a prompt marker arrives', async () => {
        await openPromptTrigger(nextConn('gaps-prompt'));

        await act(async () => { session.emit('prompt'); });

        expect(note()!.textContent).toBe('match on the prompt line');
        expect(note()!.className).not.toContain('--disabled');
        expect(note()!.title).toBe('');
    });

    it('starts un-greyed on a session that has already latched', async () => {
        session = makeSession(true);
        await openPromptTrigger(nextConn('gaps-prompt'));

        expect(note()!.textContent).toBe('match on the prompt line');
    });
});

// ── 7. Alias self-loop ───────────────────────────────────────────────────────

describe('alias self-loop warning', () => {
    async function openAlias(conn: string, pattern: string, command: string) {
        useAppStore.setState({
            connectionAliases: {
                [conn]: [{
                    id: 'a1', name: 'qa-loop', enabled: true, isGroup: false, parentId: null,
                    language: 'lua', code: '', pattern, command,
                } as AliasNode],
            },
        } as never);
        await mount(conn);
        await openTab('Aliases');
        await selectItem('qa-loop');
    }

    const warning = () => container.querySelector('.script-editor__inline-warning');

    it('flags a command that matches its own pattern', async () => {
        await openAlias(nextConn('gaps-alias'), '^qaloop$', 'qaloop');

        expect(warning()!.textContent).toContain('infinite loop');
        expect(warning()!.textContent).toContain('qa-loop');
    });

    it('stays quiet for an alias that sends something else', async () => {
        await openAlias(nextConn('gaps-alias'), '^qaloop$', 'look');

        expect(warning()).toBe(null);
    });

    it('appears and clears as the command is edited', async () => {
        await openAlias(nextConn('gaps-alias'), '^gold$', 'score');
        expect(warning()).toBe(null);

        const commandInput = [...container.querySelectorAll('.script-editor__pattern')][1] as HTMLInputElement;
        await setValue(commandInput, 'gold');
        expect(warning()).not.toBe(null);

        await setValue(commandInput, 'gold coins');
        // '^gold$' no longer matches, so the warning goes.
        expect(warning()).toBe(null);
    });

    it('still saves — the runtime guard is what stops the damage', async () => {
        const conn = nextConn('gaps-alias');
        await openAlias(conn, '^qaloop$', 'qaloop');
        await save();

        expect(useAppStore.getState().connectionAliases[conn][0].command).toBe('qaloop');
    });
});

// ── 5. Button rotation and toolbar offset ────────────────────────────────────

describe('button rotation and toolbar offset', () => {
    function seedToolbar(conn: string, over: Partial<ButtonNode> = {}, buttonOver: Partial<ButtonNode> = {}) {
        useAppStore.setState({
            connectionButtons: {
                [conn]: [
                    {
                        id: 'bar', name: 'qa-bar', enabled: true, isGroup: true, parentId: null,
                        language: 'lua', code: '', orientation: 'horizontal', location: 'top',
                        columns: 3, isPushDown: false, buttonState: false, ...over,
                    } as ButtonNode,
                    {
                        id: 'btn', name: 'qa-btn', enabled: true, isGroup: false, parentId: 'bar',
                        language: 'lua', code: '', orientation: 'horizontal', location: 'top',
                        columns: 0, isPushDown: false, buttonState: false, ...buttonOver,
                    } as ButtonNode,
                ],
            },
        } as never);
    }

    const selects = () => [...container.querySelectorAll('.script-editor__lang-select')] as HTMLSelectElement[];
    const numbers = () => [...container.querySelectorAll('.script-editor__time-part')] as HTMLInputElement[];
    const rotationSelect = () => selects().find(s => [...s.options].some(o => o.textContent === 'no rotation'))!;
    const saved = (conn: string, id: string) =>
        useAppStore.getState().connectionButtons[conn].find(b => b.id === id)!;

    async function openButton(conn: string) {
        await mount(conn);
        await openTab('Buttons');
        await expandGroup('qa-bar');
        await selectItem('qa-btn');
    }

    async function openToolbar(conn: string) {
        await mount(conn);
        await openTab('Buttons');
        await selectItem('qa-bar');
    }

    it('offers the three rotations desktop offers, and saves the index', async () => {
        const conn = nextConn('gaps-buttons');
        seedToolbar(conn);
        await openButton(conn);

        expect([...rotationSelect().options].map(o => o.textContent))
            .toEqual(['no rotation', '90° rotation to the left', '90° rotation to the right']);

        await setValue(rotationSelect(), '2');
        await save();
        expect(saved(conn, 'btn').rotation).toBe(2);
    });

    it('loads a saved rotation back into the control', async () => {
        const conn = nextConn('gaps-buttons');
        seedToolbar(conn, {}, { rotation: 1 });
        await openButton(conn);

        expect(rotationSelect().value).toBe('1');
    });

    it('saves the toolbar offset and caps it below the row count', async () => {
        const conn = nextConn('gaps-buttons');
        seedToolbar(conn, { columns: 3 });
        await openToolbar(conn);

        const offset = numbers()[1];
        expect(offset.disabled).toBe(false);
        await setValue(offset, '9');
        // One less than the number of rows is the most desktop allows.
        expect(numbers()[1].value).toBe('2');
        await save();
        expect(saved(conn, 'bar').fillerOffset).toBe(2);
    });

    it('disables the offset for a toolbar with fewer than two rows', async () => {
        const conn = nextConn('gaps-buttons');
        seedToolbar(conn, { columns: 1 });
        await openToolbar(conn);

        expect(numbers()[1].disabled).toBe(true);
    });

    it('drops an offset that no longer fits when the toolbar shrinks', async () => {
        const conn = nextConn('gaps-buttons');
        seedToolbar(conn, { columns: 4, fillerOffset: 3 });
        await openToolbar(conn);

        await setValue(numbers()[0], '1');
        await save();
        expect(saved(conn, 'bar').fillerOffset).toBeUndefined();
    });
});

// ── 11. Copy / paste / duplicate ─────────────────────────────────────────────

describe('copy, paste and duplicate', () => {
    function seedTriggers(conn: string) {
        useAppStore.setState({
            connectionTriggers: {
                ...useAppStore.getState().connectionTriggers,
                [conn]: [
                    { id: 'g1', name: 'group-one', enabled: true, isGroup: true, parentId: null, language: 'lua', code: '', patterns: [], fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false },
                    { id: 't1', name: 'child', enabled: true, isGroup: false, parentId: 'g1', language: 'lua', code: 'echo("hi")', patterns: [{ type: 'substring', text: 'hi' }], fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false },
                    { id: 't2', name: 'loner', enabled: true, isGroup: false, parentId: null, language: 'lua', code: '', patterns: [], fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false },
                ] as TriggerNode[],
            },
        } as never);
    }

    const stored = (conn: string) => useAppStore.getState().connectionTriggers[conn];

    it('duplicates an item and its subtree right after the original', async () => {
        const conn = nextConn('gaps-clipboard');
        seedTriggers(conn);
        await mount(conn);
        await openTab('Triggers');
        await clickMenu(await contextMenu('group-one'), 'Duplicate');

        expect(stored(conn).map(t => t.name)).toEqual(['group-one', 'child', 'group-one (copy)', 'child', 'loner']);
        // The copy is a copy: fresh ids, its own subtree, same code.
        const copy = stored(conn)[2];
        const copiedChild = stored(conn)[3];
        expect(copy.id).not.toBe('g1');
        expect(copiedChild.parentId).toBe(copy.id);
        expect(copiedChild.code).toBe('echo("hi")');
    });

    it('offers Paste only once something has been copied, and only in its own category', async () => {
        const conn = nextConn('gaps-clipboard');
        seedTriggers(conn);
        await mount(conn);
        await openTab('Triggers');

        expect((await contextMenu('loner')).some(b => b.textContent?.includes('Paste'))).toBe(false);
        await clickMenu(await contextMenu('loner'), 'Copy');
        expect((await contextMenu('loner')).some(b => b.textContent?.includes('Paste'))).toBe(true);

        await openTab('Aliases');
        expect((await paneContextMenu()).some(b => b.textContent?.includes('Paste'))).toBe(false);
    });

    it('pastes as the sibling after the target', async () => {
        const conn = nextConn('gaps-clipboard');
        seedTriggers(conn);
        await mount(conn);
        await openTab('Triggers');
        await expandGroup('group-one');
        await clickMenu(await contextMenu('loner'), 'Copy');
        await clickMenu(await contextMenu('child'), 'Paste');

        // "child" sits inside group-one, so the paste lands inside it too.
        const pasted = stored(conn).find(t => t.name === 'loner' && t.id !== 't2')!;
        expect(pasted.parentId).toBe('g1');
        expect(stored(conn).map(t => t.name)).toEqual(['group-one', 'child', 'loner', 'loner']);
    });

    it('carries the clipboard between profiles', async () => {
        const conn = nextConn('gaps-clipboard');
        seedTriggers(conn);
        await mount(conn);
        await openTab('Triggers');
        await clickMenu(await contextMenu('loner'), 'Copy');
        await unmount();

        const other = nextConn('gaps-clipboard');
        useAppStore.setState({
            connectionTriggers: {
                ...useAppStore.getState().connectionTriggers,
                [other]: [{ id: 'x1', name: 'elsewhere', enabled: true, isGroup: false, parentId: null, language: 'lua', code: '', patterns: [], fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false }] as TriggerNode[],
            },
        } as never);
        await mount(other);
        await openTab('Triggers');
        await clickMenu(await contextMenu('elsewhere'), 'Paste');

        expect(useAppStore.getState().connectionTriggers[other].map(t => t.name)).toEqual(['elsewhere', 'loner']);
    });
});

// ── 10. Tree expansion and selection survive the editor closing ──────────────

describe('tree state', () => {
    function seedNested(conn: string) {
        useAppStore.setState({
            connectionTriggers: {
                [conn]: [
                    { id: 'g1', name: 'outer', enabled: true, isGroup: true, parentId: null, language: 'lua', code: '', patterns: [], fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false },
                    { id: 't1', name: 'nested', enabled: true, isGroup: false, parentId: 'g1', language: 'lua', code: '', patterns: [], fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false },
                ] as TriggerNode[],
            },
            connectionAliases: {
                [conn]: [{ id: 'a1', name: 'an-alias', enabled: true, isGroup: false, parentId: null, language: 'lua', code: '', pattern: '^x$', command: 'y' } as AliasNode],
            },
        } as never);
    }

    const selectedName = () =>
        (container.querySelector('.script-editor__item--selected') as HTMLElement | null)?.textContent ?? null;

    it('keeps the open group, the selection and the tab across a close and reopen', async () => {
        const conn = nextConn('gaps-tree');
        seedNested(conn);
        await mount(conn);
        await openTab('Triggers');
        await expandGroup('outer');
        await selectItem('nested');
        expect(items().length).toBe(2);
        await unmount();

        await mount(conn);
        // The Triggers tab is still the one showing, the group is still open and
        // the nested item is still selected — no clicks needed.
        expect(items().length).toBe(2);
        expect(selectedName()).toContain('nested');
    });

    it('keeps each category tree separate', async () => {
        const conn = nextConn('gaps-tree');
        seedNested(conn);
        await mount(conn);
        await openTab('Triggers');
        await expandGroup('outer');
        await selectItem('nested');

        await openTab('Aliases');
        expect(selectedName()).toBe(null);
        await selectItem('an-alias');

        await openTab('Triggers');
        expect(selectedName()).toContain('nested');
        expect(items().length).toBe(2);

        await openTab('Aliases');
        expect(selectedName()).toContain('an-alias');
    });

    it('starts a profile it has never opened on Scripts, with nothing selected', async () => {
        const conn = nextConn('gaps-tree');
        seedNested(conn);
        await mount(conn);

        expect(container.querySelector('.script-editor__nav-btn--active')!.textContent).toContain('Scripts');
        expect(selectedName()).toBe(null);
    });
});
