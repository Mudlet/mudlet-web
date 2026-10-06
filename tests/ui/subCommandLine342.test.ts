import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandLineManager } from '../../src/ui/cmdline/CommandLineManager';
import { CommandLineOverlay } from '../../src/ui/cmdline/CommandLineOverlay';
import { WindowCmdLine } from '../../src/ui/windows/panels/WindowCmdLine';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import { DEFAULT_CMD_LINE_HOST, type CmdLineHost } from '../../src/ui/cmdline/subCommandLine';

// Issue #342 items 4 and 5: a createCommandLine line and a miniconsole's own
// line are full TCommandLines on desktop — history, Tab, "auto clear" off,
// Shift+Enter, and no action while the server masks input for a password.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
});

interface Settings { autoClear: boolean; remoteEcho: boolean; words: string[] }

function hostFor(settings: Settings): CmdLineHost {
    return {
        ...DEFAULT_CMD_LINE_HOST,
        autoClear: () => settings.autoClear,
        remoteEcho: () => settings.remoteEcho,
        completionWords: () => settings.words,
    };
}

/** Mounts a command line of the given kind; returns its textarea, what its
 *  action was called with, and a reader for getCmdLine. */
function mount(kind: 'overlay' | 'console', settings: Settings) {
    const calls: Array<{ text: string; line: string }> = [];
    let read: () => string;
    if (kind === 'overlay') {
        const manager = new CommandLineManager();
        manager.cmdLineHost = hostFor(settings);
        manager.create('cl1', { x: 0, y: 0, width: 100, height: 20 });
        manager.setAction('cl1', text => calls.push({ text, line: manager.getValue('cl1') }));
        read = () => manager.getValue('cl1');
        act(() => { root.render(createElement(CommandLineOverlay, { manager, parent: 'main' })); });
    } else {
        const manager = new WindowManager();
        manager.cmdLineHost = hostFor(settings);
        manager.open('mc1', { kind: 'text', title: 'mc1' });
        manager.enableCommandLine('mc1');
        manager.setCmdLineAction('mc1', text => calls.push({ text, line: manager.getCmdLineValue('mc1') }));
        read = () => manager.getCmdLineValue('mc1');
        act(() => { root.render(createElement(WindowCmdLine, { id: 'mc1', manager })); });
    }
    const el = () => container.querySelector('textarea') as HTMLTextAreaElement;
    return { el, calls, read: () => read() };
}

function type(el: HTMLTextAreaElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => { el.dispatchEvent(e); });
    return e;
}

describe.each(['overlay', 'console'] as const)('a %s command line (#342 item 4)', kind => {
    it('recalls its history with Up, and Enter sends the recalled text', () => {
        const { el, calls } = mount(kind, { autoClear: true, remoteEcho: false, words: [] });
        type(el(), 'hist1'); press(el(), 'Enter');
        type(el(), 'hist2'); press(el(), 'Enter');
        expect(el().value).toBe('');
        expect(press(el(), 'ArrowUp').defaultPrevented).toBe(true);
        expect(el().value).toBe('hist2');
        press(el(), 'ArrowUp');
        expect(el().value).toBe('hist1');
        press(el(), 'ArrowDown');
        press(el(), 'Enter');
        expect(calls.map(c => c.text)).toEqual(['hist1', 'hist2', 'hist2']);
    });

    it('completes with Tab, and keeps the Tab', () => {
        const { el, calls } = mount(kind, { autoClear: true, remoteEcho: false, words: ['zqcase', 'ZQCASE'] });
        type(el(), 'zqc');
        expect(press(el(), 'Tab').defaultPrevented).toBe(true);
        expect(el().value).toBe('ZQCASE');
        press(el(), 'Enter');
        expect(calls.map(c => c.text)).toEqual(['ZQCASE']);
    });

    it('lets Tab out of an empty line', () => {
        const { el } = mount(kind, { autoClear: true, remoteEcho: false, words: ['zqcase'] });
        expect(press(el(), 'Tab').defaultPrevented).toBe(false);
    });

    it('keeps the text, selected, when "auto clear" is off', () => {
        const { el, calls } = mount(kind, { autoClear: false, remoteEcho: false, words: [] });
        type(el(), 'keep1');
        press(el(), 'Enter');
        expect(calls.map(c => c.text)).toEqual(['keep1']);
        expect(el().value).toBe('keep1');
        expect([el().selectionStart, el().selectionEnd]).toEqual([0, 5]);
    });

    it('stages lines with Shift+Enter and runs the action once per line', () => {
        const { el, calls, read } = mount(kind, { autoClear: false, remoteEcho: false, words: [] });
        type(el(), 'm1');
        press(el(), 'Enter', { shiftKey: true });
        expect(el().value).toBe('m1\n');
        type(el(), 'm1\nm2');
        press(el(), 'Enter');
        expect(calls).toEqual([
            { text: 'm1', line: 'm1\nm2' },
            { text: 'm2', line: 'm1\nm2' },
        ]);
        expect(read()).toBe('m1\nm2');
    });

    it('selects everything on Escape', () => {
        const { el } = mount(kind, { autoClear: true, remoteEcho: false, words: [] });
        type(el(), 'abc');
        el().setSelectionRange(3, 3);
        press(el(), 'Escape');
        expect([el().selectionStart, el().selectionEnd]).toEqual([0, 3]);
    });
});

describe.each(['overlay', 'console'] as const)('a %s command line at a password prompt (#342 item 5)', kind => {
    it('runs no action while the server masks input, and runs it again after', () => {
        const settings = { autoClear: true, remoteEcho: true, words: [] };
        const { el, calls } = mount(kind, settings);
        type(el(), 'pw1');
        press(el(), 'Enter');
        expect(calls).toEqual([]);
        settings.remoteEcho = false;
        type(el(), 'after1');
        press(el(), 'Enter');
        expect(calls.map(c => c.text)).toEqual(['after1']);
    });

    it('keeps nothing typed under the prompt in its history', () => {
        const settings = { autoClear: true, remoteEcho: true, words: [] };
        const { el } = mount(kind, settings);
        type(el(), 'secret');
        press(el(), 'Enter');
        settings.remoteEcho = false;
        press(el(), 'ArrowUp');
        expect(el().value).toBe('');
    });
});
