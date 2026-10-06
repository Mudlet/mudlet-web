import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandBar } from '../../src/ui/CommandBar';
import { CmdLineMenuRegistry } from '../../src/ui/CmdLineMenuRegistry';
import { useCmdLineSelection } from '../../src/ui/cmdline/useCmdLineSelection';

// Issue #342 on the main command line: Escape (item 7), focus at a password
// prompt (item 5) and the command given back after one (item 6).

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

interface Controls {
    /** The server takes (true) or gives back (false) ECHO, handing the line
     *  `restore` and the selection ProfileSession asks for. */
    echo?: (on: boolean, restore?: string, select?: 'all' | 'end') => void;
}

/** A CommandBar wired the way ProfileSession wires it, including the
 *  caret/selection requests ProfileSession makes through useCmdLineSelection. */
function mount(initial: string, controls: Controls = {}) {
    const sent: string[] = [];
    const Harness = () => {
        const [command, setCommand] = useState(initial);
        const [passwordMode, setPasswordMode] = useState(false);
        const [ref] = useState(() => ({ current: null as HTMLTextAreaElement | HTMLInputElement | null }));
        const request = useCmdLineSelection(ref, command);
        controls.echo = (on, restore = '', select = 'end') => {
            setPasswordMode(on);
            setCommand(on ? '' : restore);
            if (!on && restore) request(select, false);
        };
        return createElement(CommandBar, {
            command,
            onCommandChange: setCommand,
            passwordMode,
            commandInputRef: ref,
            onSubmit: () => { sent.push(command); },
            cmdLineMenu: new CmdLineMenuRegistry(),
        } as never);
    };
    act(() => { root.render(createElement(Harness)); });
    return sent;
}

const input = () => document.querySelector('.command-input') as HTMLTextAreaElement;

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => { input().dispatchEvent(e); });
    return e;
}

describe('Escape on the main command line (#342 item 7)', () => {
    it('selects the whole line, so the next key replaces it', () => {
        mount('abc');
        input().setSelectionRange(3, 3);
        expect(press('Escape').defaultPrevented).toBe(true);
        expect([input().selectionStart, input().selectionEnd]).toEqual([0, 3]);
    });
});

describe('a password prompt and focus (#342 item 5)', () => {
    it('does not pull focus away from another command line', () => {
        const controls: Controls = {};
        mount('', controls);
        const other = document.createElement('textarea');
        document.body.appendChild(other);
        other.focus();
        act(() => controls.echo!(true));
        expect(document.activeElement).toBe(other);
        act(() => controls.echo!(false));
        expect(document.activeElement).toBe(other);
    });

    it('still keeps the focus it had across the swap to the password field and back', () => {
        const controls: Controls = {};
        mount('', controls);
        input().focus();
        act(() => controls.echo!(true));
        expect(document.activeElement).toBe(input());
        act(() => controls.echo!(false));
        expect(document.activeElement).toBe(input());
    });
});

describe('the command given back after a password prompt (#342 item 6)', () => {
    it('comes back selected when it was selected, so typing replaces it', () => {
        const controls: Controls = {};
        mount('', controls);
        input().focus();
        act(() => controls.echo!(true));
        act(() => controls.echo!(false, 'connect bob', 'all'));
        expect(input().value).toBe('connect bob');
        expect([input().selectionStart, input().selectionEnd]).toEqual([0, 11]);
    });

    it('comes back with the caret at its end otherwise', () => {
        const controls: Controls = {};
        mount('', controls);
        input().focus();
        act(() => controls.echo!(true));
        act(() => controls.echo!(false, 'connect bob', 'end'));
        expect([input().selectionStart, input().selectionEnd]).toEqual([11, 11]);
    });
});
