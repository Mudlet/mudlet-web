// mudlet-web#452 items 1 and 2: what a trigger made in the editor starts as.
//
//  1. A new trigger's pattern, and each one "+ Add pattern" adds, was a regex,
//     so `[OOC]` or `(glowing) sword` typed into it never matched as written.
//     Desktop starts a pattern row as substring (dlgTriggerEditor REGEX_SUBSTRING).
//  2. Ticking Highlight on a new trigger painted nothing: the FG/BG boxes
//     started unticked, so no colours were saved. Desktop's TTrigger starts
//     with red on yellow, and ticking the master switch uses them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScriptEditorPanel } from '../../src/ui/windows/panels/ScriptEditorPanel';
import { ConfirmProvider } from '../../src/ui/components';
import { useAppStore } from '../../src/storage';
import { isColorizing, type TriggerNode } from '../../src/storage/schema';

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


async function save() {
    const btn = [...container.querySelectorAll('.script-editor__actions button')]
        .find(b => (b.textContent ?? '').startsWith('Save')) as HTMLElement;
    await act(async () => { btn.click(); });
}


const triggers = (conn: string): TriggerNode[] =>
    (useAppStore.getState().connectionTriggers as Record<string, TriggerNode[]>)[conn] ?? [];

async function newTrigger(conn: string): Promise<TriggerNode> {
    await mount(conn);
    await openTab('Triggers');
    const btn = [...container.querySelectorAll('.script-editor__list-header button')]
        .find(b => b.textContent === '+ New') as HTMLElement;
    await act(async () => { btn.click(); });
    const made = triggers(conn);
    expect(made).toHaveLength(1);
    return made[0];
}

/** The Highlight card's checkboxes: master, FG, BG. */
function highlightBoxes(): HTMLInputElement[] {
    const label = [...container.querySelectorAll('.script-editor__trigger-card-label--toggle')]
        .find(l => l.textContent?.includes('Highlight'))!;
    const card = label.closest('.script-editor__trigger-card')!;
    return [...card.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
}

beforeEach(() => {
    session = makeSession();
    useAppStore.setState({ connectionTriggers: {} } as never);
});
afterEach(unmount);

describe('a new trigger\'s patterns', () => {
    it('start as substring, like desktop\'s', async () => {
        const t = await newTrigger(nextConn('new452'));
        expect(t.patterns).toEqual([{ text: '', type: 'substring' }]);
    });

    it('are added as substring by "+ Add pattern"', async () => {
        const conn = nextConn('new452');
        await newTrigger(conn);
        const add = [...container.querySelectorAll('button')]
            .find(b => b.textContent?.includes('Add pattern')) as HTMLElement;
        await act(async () => { add.click(); });
        await save();
        expect(triggers(conn)[0].patterns.map(p => p.type)).toEqual(['substring', 'substring']);
    });
});

describe('a new trigger\'s highlight', () => {
    it('starts off, with desktop\'s red on yellow ready', async () => {
        const t = await newTrigger(nextConn('new452'));
        expect(isColorizing(t)).toBe(false);
        expect(t.highlight).toEqual({ fg: '#ff0000', bg: '#ffff00' });
        const [master, fg, bg] = highlightBoxes();
        expect(master.checked).toBe(false);
        expect(fg.checked).toBe(true);
        expect(bg.checked).toBe(true);
    });

    it('paints red on yellow once Highlight alone is ticked', async () => {
        const conn = nextConn('new452');
        await newTrigger(conn);
        await act(async () => { highlightBoxes()[0].click(); });
        await save();
        const t = triggers(conn)[0];
        // What TriggerEngine checks before it paints a match.
        expect(isColorizing(t)).toBe(true);
        expect(t.highlight).toEqual({ fg: '#ff0000', bg: '#ffff00' });
    });
});
