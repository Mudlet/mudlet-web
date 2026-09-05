import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandBar } from '../../src/ui/CommandBar';
import { historyStorageKey } from '../../src/ui/commandHistory';
import { CmdLineMenuRegistry } from '../../src/ui/CmdLineMenuRegistry';

// Tab completion and Up/Down history recall rewrite the input in place. Nothing
// about that is announced by the browser, so desktop Mudlet says the proposal
// out loud (mudlet::self()->announce) and so must we — otherwise a screen-reader
// user presses Tab and has no idea what landed in the box.
//
// The same handler is the only thing standing between the user and a keyboard
// trap: forward Tab used to be swallowed unconditionally, leaving Shift+Tab as
// the sole, undiscoverable way out of the command line.

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

/** Renders a CommandBar wired to its own state, the way ProfileSession does. */
function mount(initial = '', props: Record<string, unknown> = {}) {
    const Harness = () => {
        const [command, setCommand] = useState(initial);
        const ref = { current: null as HTMLTextAreaElement | null };
        return createElement(CommandBar, {
            command,
            onCommandChange: setCommand,
            commandInputRef: ref,
            onSubmit: () => {},
            cmdLineMenu: new CmdLineMenuRegistry(),
            ...props,
        } as never);
    };
    act(() => { root.render(createElement(Harness)); });
}

const input = () => document.querySelector('.command-input') as HTMLTextAreaElement;
const liveRegion = () => document.querySelector('[aria-live="polite"]') as HTMLElement;
const announced = () => liveRegion().textContent;

/** Dispatches a real key event so `defaultPrevented` reports what the handler did. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => { input().dispatchEvent(e); });
    return e;
}

describe('command line live region', () => {
    it('exists and starts empty', () => {
        mount();
        expect(liveRegion()).toBeTruthy();
        expect(liveRegion().getAttribute('aria-relevant')).toBe('additions');
        expect(announced()).toBe('');
    });

    it('announces the completed word, not the whole rewritten line', () => {
        mount('slay ch', { suggestions: ['chameleon'] });
        press('Tab');
        expect(input().value).toBe('slay chameleon');
        // Mudlet announces `proposal` alone (TCommandLine.cpp:1132).
        expect(announced()).toBe('chameleon');
    });

    it('announces each word as the cycle advances', () => {
        mount('ch', { suggestions: ['chameleon', 'cathedral', 'chalice'] });
        press('Tab');
        press('Tab');
        expect(announced()).toContain('chalice');
        expect(input().value).toBe('chalice');
    });

    it('re-announces a repeated word by replacing the node, not the text', () => {
        // One candidate: pressing Tab twice proposes the same word both times.
        // Setting identical text mutates nothing, so nothing would be announced —
        // it has to be a new node each time, and only ever one of them.
        mount('ch', { suggestions: ['chameleon'] });
        press('Tab');
        const first = liveRegion().firstElementChild;
        press('Tab');
        expect(liveRegion().childElementCount).toBe(1);
        expect(liveRegion().firstElementChild).not.toBe(first);
        expect(announced()).toBe('chameleon');
    });

    it('announces a recalled history entry', () => {
        localStorage.setItem(historyStorageKey(null), JSON.stringify(['kill rat', 'look']));
        mount();
        press('ArrowUp');
        expect(input().value).toBe('kill rat');
        expect(announced()).toContain('kill rat');
    });
});

describe('command line Tab is escapable', () => {
    it('consumes Tab when it actually completes something', () => {
        mount('ch', { suggestions: ['chameleon'] });
        expect(press('Tab').defaultPrevented).toBe(true);
    });

    it('lets Tab move focus out of an empty command line', () => {
        mount('');
        expect(press('Tab').defaultPrevented).toBe(false);
    });

    it('lets Tab move focus out after a trailing space', () => {
        mount('say ', { suggestions: ['chameleon'] });
        expect(press('Tab').defaultPrevented).toBe(false);
    });

    it('lets Tab move focus out when the word has no completions', () => {
        mount('zzz', { suggestions: ['chameleon'] });
        expect(press('Tab').defaultPrevented).toBe(false);
        expect(input().value).toBe('zzz');
    });

    it('documents the behaviour on the input itself', () => {
        mount();
        const hintId = input().getAttribute('aria-describedby')!;
        expect(hintId).toBeTruthy();
        expect(document.getElementById(hintId)!.textContent).toMatch(/Tab moves on to the next control/);
    });
});
