import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandBar } from '../../src/ui/CommandBar';
import { CmdLineMenuRegistry } from '../../src/ui/CmdLineMenuRegistry';
import { historyStorageKey } from '../../src/ui/commandHistory';
import { cmdLineCommands, cmdLinePlainText } from '../../src/ui/cmdline/plainText';
import { SubCommandLine, DEFAULT_CMD_LINE_HOST } from '../../src/ui/cmdline/subCommandLine';

// Issue #375: the command line measured against desktop Mudlet's TCommandLine.
// Desktop reads the box with toPlainText(), and its password box is the same
// multi-line text edit, only masked.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NBSP = ' ';
const LS = ' ';
const PS = ' ';

describe('item 1: the box is sent as plain text', () => {
    it('sends a non-breaking space as a space', () => {
        expect(cmdLineCommands(`pg${NBSP}x`)).toEqual(['pg x']);
    });

    it('splits at U+2028 and U+2029 as at a newline', () => {
        expect(cmdLineCommands(`ph${LS}x`)).toEqual(['ph', 'x']);
        expect(cmdLineCommands(`pi${PS}x`)).toEqual(['pi', 'x']);
        expect(cmdLineCommands('a\nb')).toEqual(['a', 'b']);
    });

    it('keeps every offset where it was', () => {
        const raw = `a${NBSP}b${LS}c${PS}d`;
        expect(cmdLinePlainText(raw)).toHaveLength(raw.length);
    });

    it('does the same for a named command line', () => {
        const line = new SubCommandLine('cl1');
        expect(line.enter(`pg${NBSP}x${LS}y`, DEFAULT_CMD_LINE_HOST).commands).toEqual(['pg x', 'y']);
        expect(line.history).toEqual(['pg x\ny']);
    });
});

let container: HTMLElement;
let root: Root;
let sent: string[];

beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
});

afterEach(() => {
    act(() => root.unmount());
    localStorage.clear();
});

/** A CommandBar whose Enter records the commands ProfileSession would send. */
function mount(passwordMode: boolean) {
    const Harness = () => {
        const [command, setCommand] = useState('');
        const ref = { current: null as HTMLTextAreaElement | HTMLInputElement | null };
        return createElement(CommandBar, {
            command,
            onCommandChange: setCommand,
            passwordMode,
            commandInputRef: ref,
            onSubmit: () => { sent.push(...cmdLineCommands(command)); setCommand(''); },
            cmdLineMenu: new CmdLineMenuRegistry(),
        } as never);
    };
    act(() => { root.render(createElement(Harness)); });
}

const field = () => document.querySelector('.command-input') as HTMLInputElement | HTMLTextAreaElement;

function press(key: string, init: KeyboardEventInit = {}): void {
    act(() => { field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
}

function type(text: string): void {
    const el = field();
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    act(() => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    el.setSelectionRange(el.value.length, el.value.length);
}

function paste(text: string): Event {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
    act(() => { field().dispatchEvent(e); });
    return e;
}

describe('item 1: history keeps what was sent', () => {
    it('records the plain text', () => {
        mount(false);
        type(`pg${NBSP}x`);
        press('Enter');
        expect(sent).toEqual(['pg x']);
        expect(JSON.parse(localStorage.getItem(historyStorageKey(null)) ?? '[]')).toEqual(['pg x']);
    });
});

describe('item 2: a password box is multi-line', () => {
    it('is still a masked field', () => {
        mount(true);
        expect(field()).toBeInstanceOf(HTMLInputElement);
        expect(field().getAttribute('type')).toBe('password');
    });

    it('keeps the line break in a pasted password and sends each line', () => {
        mount(true);
        const e = paste('pw1\npw2');
        expect(e.defaultPrevented).toBe(true);
        // Shown with the line feed stood in for, so the masked field keeps it.
        expect(field().value).toBe('pw1pw2');
        press('Enter');
        expect(sent).toEqual(['pw1', 'pw2']);
    });

    it('reads CRLF and a lone CR in a paste as line feeds', () => {
        mount(true);
        paste('a\r\nb\rc');
        press('Enter');
        expect(sent).toEqual(['a', 'b', 'c']);
    });

    it('leaves a paste without line breaks to the browser', () => {
        mount(true);
        expect(paste('secret').defaultPrevented).toBe(false);
    });

    it('stages a newline on Shift+Enter instead of sending', () => {
        mount(true);
        type('pa');
        press('Enter', { shiftKey: true });
        expect(sent).toEqual([]);
        expect(field().value).toBe('pa');
        type('papb');
        press('Enter');
        expect(sent).toEqual(['pa', 'pb']);
    });

    it('never records a password in history', () => {
        mount(true);
        paste('pw1\npw2');
        press('Enter');
        expect(JSON.parse(localStorage.getItem(historyStorageKey(null)) ?? '[]')).toEqual([]);
    });
});
