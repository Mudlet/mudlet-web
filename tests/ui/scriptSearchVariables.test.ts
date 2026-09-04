// Issue #70 item 4: the editor's search never looked at variables. With
// `qaSearchVar = "FINDMEVAR"` sitting in the Variables tab, searching for
// either the name or the value returned nothing. Desktop offers "Include
// variables" and searches both (`searchVariables`, dlgTriggerEditor.cpp:2382).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptSearch } from '../../src/ui/windows/panels/ScriptSearch';
import { useAppStore } from '../../src/storage';
import type { LuaGlobalEntry } from '../../src/scripting/IScriptingRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'search-variables';

const GLOBALS: LuaGlobalEntry[] = [
    { name: 'qaSearchVar', valueType: 'string', saveable: true, value: 'FINDMEVAR' },
    { name: 'qaTable', valueType: 'table', saveable: true, isTable: true, children: [
        { name: 'nested', valueType: 'string', saveable: true, value: 'deep FINDMEVAR', keyKind: 'string' },
        { name: '3', valueType: 'number', saveable: true, value: '99', keyKind: 'number' },
    ] },
    { name: 'print', valueType: 'function', saveable: false, builtin: true },
];

let container: HTMLDivElement;
let root: Root;
let navigatedVariable: string[] = [];

async function mount() {
    navigatedVariable = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(createElement(ScriptSearch as never, {
            connectionId: CONN,
            scriptingEngineRef: { current: { listGlobals: () => GLOBALS } },
            onNavigate: () => {},
            onNavigateVariable: (name: string) => { navigatedVariable.push(name); },
        } as never));
    });
}

const toggle = (title: RegExp) =>
    [...container.querySelectorAll('.script-search__toggle')]
        .find(b => title.test((b as HTMLElement).title)) as HTMLElement;

async function type(text: string) {
    const input = container.querySelector('.script-search__input') as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The scan runs off a 140ms debounce.
    await act(async () => { await new Promise(r => setTimeout(r, 200)); });
}

const groupNames = () =>
    [...document.querySelectorAll('.script-search__group-head')]
        .map(h => h.querySelector('.script-search__group-name')?.textContent ?? '');

const groupTags = () =>
    [...document.querySelectorAll('.script-search__group-head')]
        .map(h => h.querySelector('.script-search__group-cat')?.textContent ?? '');

beforeEach(() => {
    useAppStore.setState({
        connectionScripts: { [CONN]: [] }, connectionAliases: { [CONN]: [] },
        connectionTriggers: { [CONN]: [] }, connectionTimers: { [CONN]: [] },
        connectionKeybindings: { [CONN]: [] }, connectionButtons: { [CONN]: [] },
    } as never);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
});

describe('include-variables search', () => {
    it('finds nothing until the option is on', async () => {
        await mount();
        await type('FINDMEVAR');
        expect(groupNames()).toEqual([]);
    });

    it('matches a variable by value once the option is on', async () => {
        await mount();
        await act(async () => { toggle(/Include variables/).click(); });
        await type('FINDMEVAR');

        expect(groupNames()).toEqual(['qaSearchVar', 'qaTable.nested']);
        expect(groupTags()).toEqual(['Variable', 'Variable']);
    });

    it('matches by name too, and writes a nested numeric key as Lua would', async () => {
        await mount();
        await act(async () => { toggle(/Include variables/).click(); });
        await type('qaTable');

        expect(groupNames()).toEqual(['qaTable', 'qaTable.nested', 'qaTable[3]']);
    });

    it('leaves the built-in namespace out of the results', async () => {
        await mount();
        await act(async () => { toggle(/Include variables/).click(); });
        await type('print');

        expect(groupNames()).toEqual([]);
    });

    it('sends the top-level name to the Variables tab when a hit is clicked', async () => {
        await mount();
        await act(async () => { toggle(/Include variables/).click(); });
        await type('FINDMEVAR');

        const hit = document.querySelectorAll('.script-search__occ')[1] as HTMLElement;
        await act(async () => { hit.click(); });

        expect(navigatedVariable).toEqual(['qaTable']);
    });

    it('composes with whole word', async () => {
        await mount();
        await act(async () => { toggle(/Include variables/).click(); });
        await act(async () => { toggle(/Whole word/).click(); });
        await type('deep');

        expect(groupNames()).toEqual(['qaTable.nested']);

        await type('dee');
        expect(groupNames()).toEqual([]);
    });
});
