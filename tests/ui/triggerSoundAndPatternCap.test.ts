// Two of the script-editor gaps in issue #70.
//
// 1. Trigger sound had no control anywhere in the trigger pane. The model, the
//    round-trip and the playback all landed earlier (#42 / PR #84) — TTrigger::
//    execute plays the file ahead of the command and the script — so the only
//    thing a user could do with a sound trigger was lose it by opening a
//    package and saving it back. Desktop: checkable groupBox_soundTrigger +
//    lineEdit_soundFile + toolButton_clearSoundFile (ui/triggers_main_area.ui:
//    316, :360).
//
// 8. Pattern rows had no cap and could all be removed: 61 rows was reachable,
//    and clearing every row left a trigger with no way to add one back. Desktop
//    stops at 50 (mVisiblePatternCount < 50, dlgTriggerEditor.cpp:7394) and
//    always keeps a row in view.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';
import type { TriggerNode } from '../../src/storage/schema';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'conn-sound-cap';

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

function seedTrigger(over: Partial<TriggerNode> = {}) {
    useAppStore.setState({
        connectionTriggers: {
            [CONN]: [{
                id: 't1', name: 'qa-sound', enabled: true, isGroup: false, parentId: null,
                language: 'lua', code: '', patterns: [{ type: 'substring', text: 'hello' }],
                fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
                ...over,
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

/** The card whose caption is `label`. */
function card(label: string): HTMLElement {
    const found = [...container.querySelectorAll('.script-editor__trigger-card')]
        .find(c => c.querySelector('.script-editor__trigger-card-label')?.textContent?.includes(label));
    if (!found) throw new Error(`no trigger card captioned "${label}"`);
    return found as HTMLElement;
}

const soundInput = () => card('Play sound').querySelector('.script-editor__sound-file') as HTMLInputElement;
const soundSwitch = () => card('Play sound').querySelector('input[type="checkbox"]') as HTMLInputElement;

async function setValue(el: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function save() {
    const btn = [...container.querySelectorAll('.script-editor__actions button')]
        .find(b => (b.textContent ?? '').startsWith('Save')) as HTMLElement;
    await act(async () => { btn.click(); });
}

const saved = (): TriggerNode => useAppStore.getState().connectionTriggers[CONN][0];

describe('trigger sound control', () => {
    beforeEach(() => { useAppStore.setState({ connectionTriggers: {} } as never); });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });

    it('loads an existing sound trigger into the control', async () => {
        seedTrigger({ soundTrigger: true, soundFile: 'sounds/ding.wav' } as Partial<TriggerNode>);
        await mountAndSelectTrigger();

        expect(soundSwitch().checked).toBe(true);
        expect(soundInput().value).toBe('sounds/ding.wav');
    });

    it('greys the path out until the switch is on, as the checkable group box does', async () => {
        seedTrigger();
        await mountAndSelectTrigger();

        expect(soundSwitch().checked).toBe(false);
        expect(soundInput().disabled).toBe(true);

        await act(async () => { soundSwitch().click(); });
        expect(soundInput().disabled).toBe(false);
    });

    it('saves the switch and the path onto the trigger', async () => {
        seedTrigger();
        await mountAndSelectTrigger();

        await act(async () => { soundSwitch().click(); });
        await setValue(soundInput(), 'media/alert.ogg');
        await save();

        expect(saved().soundTrigger).toBe(true);
        expect(saved().soundFile).toBe('media/alert.ogg');
    });

    it('leaves both unset on a trigger that has no sound, rather than storing empties', async () => {
        // So a trigger that never had a sound round-trips as one.
        seedTrigger();
        await mountAndSelectTrigger();
        await setValue(container.querySelector('.script-editor__name') as HTMLInputElement, 'renamed');
        await save();

        expect(saved().soundTrigger).toBeUndefined();
        expect(saved().soundFile).toBeUndefined();
    });

    it('clears the path without turning the trigger off', async () => {
        // Desktop's toolButton_clearSoundFile clears the line edit only.
        seedTrigger({ soundTrigger: true, soundFile: 'sounds/ding.wav' } as Partial<TriggerNode>);
        await mountAndSelectTrigger();

        const clear = [...card('Play sound').querySelectorAll('button')]
            .find(b => b.textContent?.includes('Clear')) as HTMLElement;
        await act(async () => { clear.click(); });

        expect(soundInput().value).toBe('');
        expect(soundSwitch().checked).toBe(true);
    });
});

describe('trigger pattern rows', () => {
    beforeEach(() => { useAppStore.setState({ connectionTriggers: {} } as never); });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });

    const addButton = () => container.querySelector('.script-editor__pattern-add') as HTMLButtonElement;
    const rows = () => container.querySelectorAll('.script-editor__pattern-row');

    it('stops adding rows at the 50 desktop can display', async () => {
        seedTrigger({ patterns: Array.from({ length: 49 }, (_, i) => ({ type: 'substring' as const, text: `p${i}` })) });
        await mountAndSelectTrigger();

        expect(addButton().disabled).toBe(false);
        await act(async () => { addButton().click(); });

        expect(rows()).toHaveLength(50);
        expect(addButton().disabled).toBe(true);
    });

    it('keeps one row rather than letting the last be removed', async () => {
        seedTrigger({ patterns: [{ type: 'substring', text: 'only one' }] });
        await mountAndSelectTrigger();

        const remove = container.querySelector('.script-editor__pattern-remove') as HTMLButtonElement;
        await act(async () => { remove.click(); });

        // Emptied, not deleted — which is what "remove" means on the last row
        // in desktop's editor too.
        expect(rows()).toHaveLength(1);
        const text = container.querySelector('.script-editor__pattern-row input[type="text"]') as HTMLInputElement;
        expect(text.value).toBe('');
    });

    it('still removes an ordinary row when there is more than one', async () => {
        seedTrigger({ patterns: [{ type: 'substring', text: 'first' }, { type: 'substring', text: 'second' }] });
        await mountAndSelectTrigger();

        const remove = container.querySelectorAll('.script-editor__pattern-remove')[0] as HTMLButtonElement;
        await act(async () => { remove.click(); });

        expect(rows()).toHaveLength(1);
        const text = container.querySelector('.script-editor__pattern-row input[type="text"]') as HTMLInputElement;
        expect(text.value).toBe('second');
    });
});

// A toolbar location desktop cannot render is an export hazard, not a cosmetic
// one: `TAction::mLocation` 1 ("bottom") is dead in Mudlet — ActionUnit places
// 0, 2, 3 and 4 and never 1 (ActionUnit.cpp:234-246) — so a profile saved on it
// carries a bar desktop silently never draws, and a folder linked with a Mudlet
// install writes that on every save. mudix can render it, so it is not removed
// from the model; it is just never offered as a new choice.
describe('toolbar location choices', () => {
    beforeEach(() => { useAppStore.setState({ connectionButtons: {} } as never); });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
    });

    function seedToolbar(location: string) {
        useAppStore.setState({
            connectionButtons: {
                [CONN]: [{
                    id: 'b1', name: 'qa-bar', enabled: true, isGroup: true, parentId: null,
                    language: 'lua', code: '', location, orientation: 'horizontal', columns: 0,
                }],
            },
        } as never);
    }

    async function mountAndSelectToolbar() {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root.render(createElement(ConfirmProvider, null,
                createElement(ScriptEditorPanel as never, { connectionId: CONN, session: fakeSession, vfs: fakeVfs } as never)));
        });
        const nav = [...container.querySelectorAll('.script-editor__nav-btn')] as HTMLElement[];
        await act(async () => { nav.find(b => b.textContent?.includes('Buttons'))!.click(); });
        const item = container.querySelector('.script-editor__item') as HTMLElement;
        await act(async () => { item.click(); });
    }

    /** The location select's option values, in order. */
    const options = (): string[] => {
        const selects = [...container.querySelectorAll('select.script-editor__lang-select')] as HTMLSelectElement[];
        const loc = selects.find(sel => [...sel.options].some(o => o.value === 'top'));
        if (!loc) throw new Error('no location select found');
        return [...loc.options].map(o => o.value);
    };

    it('does not offer bottom for an ordinary toolbar', async () => {
        seedToolbar('top');
        await mountAndSelectToolbar();
        expect(options()).toEqual(['top', 'left', 'right', 'floating']);
    });

    it('offers exactly the four dock areas desktop renders', async () => {
        seedToolbar('floating');
        await mountAndSelectToolbar();
        // Mudlet's comboBox_action_bar_location: Top / Left / Right / Floating.
        expect(options()).not.toContain('bottom');
    });

    it('still shows bottom for a toolbar that already carries it', async () => {
        // An imported profile has to read back honestly and be movable off,
        // rather than silently displaying as "Top".
        seedToolbar('bottom');
        await mountAndSelectToolbar();
        expect(options()).toContain('bottom');
    });
});
