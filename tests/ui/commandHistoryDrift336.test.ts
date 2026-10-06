import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandBar } from '../../src/ui/CommandBar';
import { CmdLineMenuRegistry } from '../../src/ui/CmdLineMenuRegistry';
import { ConnectionIdContext } from '../../src/storage/hooks';
import { useAppStore } from '../../src/storage/appStore';

// Command-line history measured against the Mudlet PTB (mudlet-web#336), with
// desktop's sent commands as the expectation:
//  2. With "auto clear input line" off, the history position sits on the
//     command just sent, so Up goes to the one before it, not the same again.
//  3. Down on the draft slot with typed text files the text in history and
//     clears the line (TCommandLine::historyMove).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'history-drift-336';

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
    useAppStore.setState(s => {
        const { [CONN]: _drop, ...rest } = s.connectionProfile;
        return { connectionProfile: rest };
    });
});

/** The command line as ProfileSession drives it: Enter sends the box, then
 *  clears it or — auto-clear off — leaves it there, selected. */
function mount(autoClearInput: boolean) {
    useAppStore.setState(s => ({ connectionProfile: { ...s.connectionProfile, [CONN]: { autoClearInput } } }));
    let afterSend: (() => void) | null = null;
    const Harness = () => {
        const [command, setCommand] = useState('');
        const ref = { current: null as HTMLTextAreaElement | null };
        return createElement(ConnectionIdContext.Provider, { value: CONN },
            createElement(CommandBar, {
                command,
                onCommandChange: setCommand,
                commandInputRef: ref,
                onSubmit: () => {
                    sent.push(command);
                    if (autoClearInput) setCommand('');
                    else afterSend = () => input().select();
                },
                cmdLineMenu: new CmdLineMenuRegistry(),
            } as never));
    };
    act(() => { root.render(createElement(Harness)); });
    return {
        flush: () => { afterSend?.(); afterSend = null; },
    };
}

const input = () => document.querySelector('.command-input') as HTMLTextAreaElement;

let harness: ReturnType<typeof mount>;

function press(key: string): void {
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    if (key === 'Enter') harness.flush();
}

function type(text: string): void {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    input().setSelectionRange(text.length, text.length);
}

function enter(text: string): void {
    type(text);
    press('Enter');
}

describe('mudlet-web#336 — command history parity with desktop', () => {
    it('auto-clear off: Up after Enter goes to the previous command, Down to an empty line', () => {
        harness = mount(false);
        enter('aa');
        enter('bb');
        enter('cc');
        press('ArrowUp'); press('Enter');
        press('ArrowDown'); press('Enter');
        press('ArrowUp'); press('ArrowUp'); press('Enter');
        expect(sent).toEqual(['aa', 'bb', 'cc', 'bb', '', 'cc']);
    });

    it('auto-clear on: Up after Enter still recalls the command just sent', () => {
        harness = mount(true);
        enter('aa');
        enter('bb');
        press('ArrowUp'); press('Enter');
        expect(sent).toEqual(['aa', 'bb', 'bb']);
    });

    it('auto-clear on: Down with typed text puts it in history and clears the line', () => {
        harness = mount(true);
        enter('aa');
        type('draft1');
        press('ArrowDown');
        expect(input().value).toBe('');
        press('Enter');
        press('ArrowUp'); press('Enter');
        expect(sent).toEqual(['aa', '', 'draft1']);
    });

    it('auto-clear off, empty history: Down with typed text still files it', () => {
        harness = mount(false);
        type('draft0');
        press('ArrowDown');
        press('Enter');
        press('ArrowUp'); press('Enter');
        expect(sent).toEqual(['', 'draft0']);
    });

    it('Down on an empty line, or while walking history, does not file anything', () => {
        harness = mount(true);
        enter('aa');
        press('ArrowDown');
        expect(input().value).toBe('');
        press('ArrowUp');
        expect(input().value).toBe('aa');
        press('ArrowDown');
        expect(input().value).toBe('');
        press('ArrowUp'); press('ArrowUp');
        expect(input().value).toBe('aa');
    });
});
