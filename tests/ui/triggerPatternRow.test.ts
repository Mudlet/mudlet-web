// The trigger pattern editor's per-type controls. Mudlet swaps the widget in a
// pattern row by type (dlgTriggerEditor.cpp:7196-7239): a line edit for the
// text kinds, two colour buttons for REGEX_COLOR_PATTERN, and a spin box for
// REGEX_LINE_SPACER. mudix rendered a *disabled, empty* text box for the
// spacer, so its count could never be set and the pattern was worthless.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel, retypePatternText } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';
import type { TriggerNode } from '../../src/storage/schema';

// React's act() needs this flag set on the global before the first render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'conn-pattern-row';

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

function seedTrigger(patterns: TriggerNode['patterns']) {
    useAppStore.setState({
        connectionTriggers: {
            [CONN]: [{
                id: 't1', name: 'qa-spacer', enabled: true, isGroup: false, parentId: null,
                language: 'lua', code: '', patterns,
                fireLength: 0, multipleMatches: false, multiline: true, delta: 0, isFilter: false,
            }],
        },
    } as never);
}

let container: HTMLDivElement;
let root: Root;

async function mountAndSelectTrigger() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(createElement(ConfirmProvider, null,
            createElement(ScriptEditorPanel as never, { connectionId: CONN, session: fakeSession, vfs: fakeVfs } as never)));
    });
    const nav = [...container.querySelectorAll('.script-editor__nav-btn')] as HTMLElement[];
    await act(async () => { nav.find(b => b.textContent?.includes('Triggers'))!.click(); });
    const item = container.querySelector('.script-editor__item') as HTMLElement;
    await act(async () => { item.click(); });
}

describe('trigger pattern row: line spacer', () => {
    beforeEach(() => { useAppStore.setState({ connectionTriggers: {} } as never); });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });

    it('renders a numeric count control, not a disabled text box', async () => {
        seedTrigger([{ type: 'lineSpacer', text: '3' }]);
        await mountAndSelectTrigger();

        const row = container.querySelector('.script-editor__pattern-row')!;
        const spin = row.querySelector('input[type="number"]') as HTMLInputElement | null;
        expect(spin).not.toBeNull();
        expect(spin!.disabled).toBe(false);
        expect(spin!.value).toBe('3');
        // The dead text box the spacer used to get is gone.
        expect(row.querySelector('input[type="text"]')).toBeNull();
    });

    it('writes the edited count back into the pattern and saves it', async () => {
        seedTrigger([{ type: 'lineSpacer', text: '0' }]);
        await mountAndSelectTrigger();

        const spin = container.querySelector('.script-editor__pattern-row input[type="number"]') as HTMLInputElement;
        await act(async () => {
            // React tracks the DOM value node, so a plain assignment before
            // dispatching would be swallowed as "no change".
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
                .set!.call(spin, '2');
            spin.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const save = [...container.querySelectorAll('.script-editor__actions button')]
            .find(b => (b.textContent ?? '').startsWith('Save')) as HTMLElement;
        await act(async () => { save.click(); });

        const stored = useAppStore.getState().connectionTriggers[CONN][0];
        expect(stored.patterns).toEqual([{ type: 'lineSpacer', text: '2' }]);
    });
});

describe('retypePatternText', () => {
    it('gives a fresh line spacer Mudlet\'s spin-box default of 0', () => {
        expect(retypePatternText('^some regex$', 'regex', 'lineSpacer')).toBe('0');
    });

    it('does not leave a stale regex behind in a spacer row', () => {
        expect(retypePatternText('^some regex$', 'regex', 'lineSpacer')).not.toContain('regex');
    });

    it('clears the count when a spacer row becomes a text pattern', () => {
        expect(retypePatternText('4', 'lineSpacer', 'regex')).toBe('');
    });

    it('still seeds and clears colour-trigger text', () => {
        expect(retypePatternText('^x$', 'regex', 'colorTrigger')).toBe('-1,-1');
        expect(retypePatternText('-1,-1', 'colorTrigger', 'substring')).toBe('');
    });

    it('leaves text alone between the plain text kinds', () => {
        expect(retypePatternText('^x$', 'regex', 'substring')).toBe('^x$');
    });
});
