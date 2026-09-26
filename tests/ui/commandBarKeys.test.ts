import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandBar } from '../../src/ui/CommandBar';
import { historyStorageKey } from '../../src/ui/commandHistory';
import { CmdLineMenuRegistry } from '../../src/ui/CmdLineMenuRegistry';

// Command-line key handling measured against desktop Mudlet's TCommandLine
// (mudlet-web#180): Up/Down with text typed searches history by prefix, only
// Shift/Alt+Return stage a newline, and Ctrl+Up/Down leave history alone.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    localStorage.clear();
});

function mount(initial = '') {
    const Harness = () => {
        const [command, setCommand] = useState(initial);
        const ref = { current: null as HTMLTextAreaElement | null };
        return createElement(CommandBar, {
            command,
            onCommandChange: setCommand,
            commandInputRef: ref,
            onSubmit: () => {},
            cmdLineMenu: new CmdLineMenuRegistry(),
        } as never);
    };
    act(() => { root.render(createElement(Harness)); });
}

const input = () => document.querySelector('.command-input') as HTMLTextAreaElement;

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => { input().dispatchEvent(e); });
    return e;
}

/** Newest first, as useCommandHistory stores it. */
const seedHistory = (items: string[]) =>
    localStorage.setItem(historyStorageKey(null), JSON.stringify(items));

describe('history prefix search (TCommandLine::handleAutoCompletion)', () => {
    it('recalls the newest entry starting with what was typed, not the newest entry', () => {
        seedHistory(['look', 'kill rat', 'say hello']);
        mount('k');
        input().setSelectionRange(1, 1);
        expect(press('ArrowUp').defaultPrevented).toBe(true);
        expect(input().value).toBe('kill rat');
        // The completed tail comes back selected; the typed prefix does not.
        expect([input().selectionStart, input().selectionEnd]).toEqual([1, 8]);
    });

    it('steps to older matches, and back to the bare prefix when they run out', () => {
        seedHistory(['kick door', 'kill rat', 'look']);
        mount('k');
        input().setSelectionRange(1, 1);
        press('ArrowUp');
        expect(input().value).toBe('kick door');
        press('ArrowUp');
        expect(input().value).toBe('kill rat');
        press('ArrowDown');
        expect(input().value).toBe('kick door');
        press('ArrowUp');
        press('ArrowUp');
        expect(input().value).toBe('k');
    });

    it('stays on the oldest match, selected, when Up is pressed past it', () => {
        seedHistory(['look', 'kill rat']);
        mount('k');
        input().setSelectionRange(1, 1);
        press('ArrowUp');
        press('ArrowUp');
        expect(input().value).toBe('kill rat');
        expect([input().selectionStart, input().selectionEnd]).toEqual([1, 8]);
    });

    it('walks history in order when the line is empty or wholly selected', () => {
        seedHistory(['look', 'kill rat']);
        mount('');
        press('ArrowUp');
        expect(input().value).toBe('look');
        // Highlight history (on by default, as on desktop) selects the recall,
        // so the next Up is a plain step rather than a prefix search.
        expect([input().selectionStart, input().selectionEnd]).toEqual([0, 4]);
        press('ArrowUp');
        expect(input().value).toBe('kill rat');
    });

    it('leaves history alone on Ctrl+Up — desktop only moves the caret', () => {
        seedHistory(['look']);
        mount('');
        press('ArrowUp', { ctrlKey: true });
        expect(input().value).toBe('');
    });
});

describe('modified Return', () => {
    it('stages a newline on Shift+Return and Alt+Return', () => {
        mount('north');
        input().setSelectionRange(5, 5);
        press('Enter', { shiftKey: true });
        expect(input().value).toBe('north\n');
        press('Enter', { altKey: true });
        expect(input().value).toBe('north\n\n');
    });

    it('does not on Ctrl/Cmd+Return, which is clearSplit on desktop', () => {
        mount('north');
        input().setSelectionRange(5, 5);
        expect(press('Enter', { ctrlKey: true }).defaultPrevented).toBe(true);
        press('Enter', { metaKey: true });
        expect(input().value).toBe('north');
    });
});
