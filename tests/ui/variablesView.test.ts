// Issue #70 item 3, on the view side: every Variables row exposed exactly one
// control — the save-across-sessions checkbox — with no create, rename, retype,
// edit, hide or delete. Desktop has all six (ui/vars_main_area.ui:73, :105,
// :142, :165 plus dlgTriggerEditor::addVar :5211).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VariablesView, dropHiddenPaths } from '../../src/ui/windows/panels/VariablesView';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';
import type { LuaGlobalEntry, VariableEdit } from '../../src/scripting/IScriptingRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'variables-view';

/** A stand-in engine: records the edits it is handed and answers listGlobals
 *  from a tree the test controls. */
function makeEngine(globals: LuaGlobalEntry[], refuseWith: string | null = null) {
    const edits: VariableEdit[] = [];
    return {
        edits,
        globals,
        listGlobals: () => globals,
        editVariable: (edit: VariableEdit) => { edits.push(edit); return refuseWith; },
    };
}

let container: HTMLDivElement;
let root: Root;
let engine: ReturnType<typeof makeEngine>;
/** How many times the view has reported a focus request applied. */
let consumed = 0;

async function render(props: Record<string, unknown>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(createElement(ConfirmProvider, null,
            createElement(VariablesView as never, {
                connectionId: CONN,
                scriptingEngineRef: { current: engine },
                onFocusConsumed: () => { consumed++; },
                ...props,
            } as never)));
    });
    // The _G walk is deferred a tick behind the loader.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function mount(globals: LuaGlobalEntry[], opts: { refuseWith?: string; showHidden?: boolean } = {}) {
    engine = makeEngine(globals, opts.refuseWith ?? null);
    await render({});
    if (opts.showHidden) {
        const toggle = [...container.querySelectorAll('.variables__toggle')]
            .find(l => l.textContent?.includes('Show hidden'))!.querySelector('input') as HTMLInputElement;
        await act(async () => { toggle.click(); });
    }
}

async function mountWithFocus(globals: LuaGlobalEntry[], focus: { name: string; revision: number }) {
    engine = makeEngine(globals);
    await render({ focus });
}

const rows = () => [...container.querySelectorAll('.variables__row')] as HTMLElement[];
const names = () => rows().map(r => r.querySelector('.variables__name')?.textContent ?? '');

function row(name: string): HTMLElement {
    const found = rows().find(r => r.querySelector('.variables__name')?.textContent === name);
    if (!found) throw new Error(`no row named "${name}" in [${names().join(', ')}]`);
    return found;
}

async function clickAction(name: string, title: RegExp) {
    const btn = [...row(name).querySelectorAll('.variables__action')]
        .find(b => title.test((b as HTMLElement).title)) as HTMLElement;
    if (!btn) throw new Error(`no action matching ${title} on "${name}"`);
    await act(async () => { btn.click(); });
}

async function click(el: Element) {
    await act(async () => { (el as HTMLElement).click(); });
}

async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
}

const draft = () => container.querySelector('.variables__row--draft') as HTMLElement;
const draftName = () => draft().querySelector('.variables__draft-name') as HTMLInputElement;
const draftValue = () => draft().querySelector('.variables__draft-value') as HTMLInputElement;
const draftSelects = () => [...draft().querySelectorAll('.variables__draft-select')] as HTMLSelectElement[];

async function clickHeader(label: string) {
    const btn = [...container.querySelectorAll('.script-editor__error-log-header button')]
        .find(b => b.textContent?.trim() === label) as HTMLElement;
    if (!btn) throw new Error(`no header button "${label}"`);
    await act(async () => { btn.click(); });
}

/** Accept whatever confirm dialog is on screen. */
async function confirmDialog(label: string) {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
    if (!btn) throw new Error(`no dialog button "${label}"`);
    await act(async () => { btn.click(); });
}

const G = (over: Partial<LuaGlobalEntry> & { name: string }): LuaGlobalEntry =>
    ({ valueType: 'string', saveable: true, ...over });

beforeEach(() => {
    consumed = 0;
    useAppStore.setState({ connectionVariables: { [CONN]: { saveList: [], values: [], hidden: [] } } } as never);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
});

describe('creating a variable', () => {
    it('sends a set with the chosen name, key type and value type', async () => {
        await mount([]);
        await clickHeader('+ New');

        await setValue(draftName(), 'qaNew');
        const [keyType, valueType] = draftSelects();
        expect([...keyType.options].map(o => o.value)).toEqual(['string', 'number']);
        expect([...valueType.options].map(o => o.value)).toEqual(['string', 'number', 'boolean', 'table']);
        await setValue(valueType, 'number');
        await setValue(draftValue(), '42');
        await click(draft().querySelector('button')!);

        expect(engine.edits).toEqual([
            { op: 'set', path: [{ key: 'qaNew', kind: 'string' }], valueType: 'number', value: '42' },
        ]);
    });

    it('creates inside the selected table', async () => {
        await mount([G({ name: 'qaTable', valueType: 'table', isTable: true, children: [G({ name: 'inner', keyKind: 'string' })] })]);
        await click(row('qaTable'));
        await clickHeader('+ New');

        await setValue(draftName(), 'added');
        await click(draft().querySelector('button')!);

        expect(engine.edits[0]).toMatchObject({
            path: [{ key: 'qaTable', kind: 'string' }, { key: 'added', kind: 'string' }],
        });
    });

    it('refuses an empty name without troubling the runtime', async () => {
        await mount([]);
        await clickHeader('+ New');
        await click(draft().querySelector('button')!);

        expect(engine.edits).toEqual([]);
        expect(container.querySelector('.variables__error')!.textContent).toContain('needs a name');
    });

    it('surfaces a refusal from the runtime and keeps the draft open', async () => {
        await mount([], { refuseWith: '"seven" is not a number' });
        await clickHeader('+ New');
        await setValue(draftName(), 'qaNum');
        await click(draft().querySelector('button')!);

        expect(container.querySelector('.variables__error')!.textContent).toBe('"seven" is not a number');
        expect(draft()).not.toBe(null);
    });
});

describe('editing an existing variable', () => {
    it('loads the row into the form and writes the new value back', async () => {
        await mount([G({ name: 'qaVar', value: 'old' })]);
        await clickAction('qaVar', /Edit name/);

        expect(draftName().value).toBe('qaVar');
        expect(draftValue().value).toBe('old');
        await setValue(draftValue(), 'new');
        await click(draft().querySelector('button')!);

        expect(engine.edits).toEqual([
            { op: 'set', path: [{ key: 'qaVar', kind: 'string' }], valueType: 'string', value: 'new' },
        ]);
    });

    it('renames with a move before the value is written, so the old key goes', async () => {
        await mount([G({ name: 'qaOld', value: 'v' })]);
        await clickAction('qaOld', /Edit name/);
        await setValue(draftName(), 'qaNew');
        await click(draft().querySelector('button')!);

        expect(engine.edits[0]).toEqual({
            op: 'move', path: [{ key: 'qaOld', kind: 'string' }], to: { key: 'qaNew', kind: 'string' },
        });
        expect(engine.edits[1]).toMatchObject({ op: 'set', path: [{ key: 'qaNew', kind: 'string' }] });
    });

    it('carries the save flag over to the new name', async () => {
        useAppStore.setState({ connectionVariables: { [CONN]: { saveList: ['qaOld'], values: [], hidden: [] } } } as never);
        await mount([G({ name: 'qaOld', value: 'v' })]);
        await clickAction('qaOld', /Edit name/);
        await setValue(draftName(), 'qaNew');
        await click(draft().querySelector('button')!);

        expect(useAppStore.getState().connectionVariables[CONN].saveList).toEqual(['qaNew']);
    });

    it('leaves a function alone — desktop greys those too', async () => {
        await mount([G({ name: 'qaFn', valueType: 'function', saveable: false })]);
        const edit = [...row('qaFn').querySelectorAll('.variables__action')]
            .find(b => /cannot be edited/.test((b as HTMLElement).title)) as HTMLButtonElement;
        expect(edit.disabled).toBe(true);
    });
});

describe('deleting a variable', () => {
    it('asks first, then sets it to nil and drops it from the save list', async () => {
        useAppStore.setState({ connectionVariables: { [CONN]: { saveList: ['qaGone'], values: [], hidden: [] } } } as never);
        await mount([G({ name: 'qaGone' })]);

        await clickAction('qaGone', /Set to nil/);
        await confirmDialog('Delete');

        expect(engine.edits).toEqual([{ op: 'delete', path: [{ key: 'qaGone', kind: 'string' }] }]);
        expect(useAppStore.getState().connectionVariables[CONN].saveList).toEqual([]);
    });

    it('does nothing when the confirm is dismissed', async () => {
        await mount([G({ name: 'qaGone' })]);
        await clickAction('qaGone', /Set to nil/);
        await confirmDialog('Cancel');

        expect(engine.edits).toEqual([]);
    });
});

describe('hiding a variable', () => {
    it('takes it out of the list and remembers it on the profile', async () => {
        await mount([G({ name: 'qaShown' }), G({ name: 'qaHide' })]);
        expect(names()).toEqual(['qaHide', 'qaShown']);

        await clickAction('qaHide', /Hide this variable/);

        expect(useAppStore.getState().connectionVariables[CONN].hidden).toEqual(['qaHide']);
        expect(names()).toEqual(['qaShown']);
    });

    it('brings hidden rows back under "Show hidden", marked as such', async () => {
        useAppStore.setState({ connectionVariables: { [CONN]: { saveList: [], values: [], hidden: ['qaHide'] } } } as never);
        await mount([G({ name: 'qaShown' }), G({ name: 'qaHide' })]);
        expect(names()).toEqual(['qaShown']);

        const toggle = [...container.querySelectorAll('.variables__toggle')]
            .find(l => l.textContent?.includes('Show hidden'))!.querySelector('input') as HTMLInputElement;
        await act(async () => { toggle.click(); });

        expect(names()).toEqual(['qaHide', 'qaShown']);
        expect(row('qaHide').className).toContain('variables__row--hidden');
    });
});

describe('search focus', () => {
    it('filters to the global a search result asked for', async () => {
        await mountWithFocus([G({ name: 'qaOne' }), G({ name: 'qaTwo' })], { name: 'qaTwo', revision: 1 });

        expect(names()).toEqual(['qaTwo']);
    });
});

describe('save-across-sessions checkbox', () => {
    it('still works, and is offered only at the top level', async () => {
        await mount([G({ name: 'qaTbl', valueType: 'table', isTable: true, children: [G({ name: 'inner', keyKind: 'string' })] })]);
        await click(row('qaTbl').querySelector('.variables__chevron')!);

        const boxes = (name: string) => row(name).querySelectorAll('input[type="checkbox"]');
        expect(boxes('qaTbl')).toHaveLength(1);
        expect(boxes('inner')).toHaveLength(0);

        await click(boxes('qaTbl')[0]);
        expect(useAppStore.getState().connectionVariables[CONN].saveList).toEqual(['qaTbl']);
    });
});

// ── Review follow-up: hidden paths that the dedicated suite does not cover ───
// (renameHiddenPaths, the create-collision refusal and the focus handling all
// live in editorReviewFixes.test.ts.)

describe('dropHiddenPaths', () => {
    it('removes the entry and its descendants, leaving unrelated names alone', () => {
        expect(dropHiddenPaths(['a', 'a.b', 'a[3]', 'aTwo', 'b'], 'a')).toEqual(['aTwo', 'b']);
    });

    it('returns null when nothing matched, so the caller can skip the write', () => {
        expect(dropHiddenPaths(['x', 'y'], 'a')).toBe(null);
    });
});

describe('deleting a variable clears its hidden paths', () => {
    it('drops the entry and anything hidden underneath it', async () => {
        useAppStore.setState({
            connectionVariables: { [CONN]: { saveList: [], values: [], hidden: ['qaTbl', 'qaTbl.inner', 'other'] } },
        } as never);
        await mount([G({ name: 'qaTbl', valueType: 'table', isTable: true })], { showHidden: true });

        await clickAction('qaTbl', /Set to nil/);
        await confirmDialog('Delete');

        // Left behind, 'qaTbl.inner' would silently hide whatever is next given
        // that name.
        expect(useAppStore.getState().connectionVariables[CONN].hidden).toEqual(['other']);
    });
});
