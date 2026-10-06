// mudlet-web#379 item 4 — `f3SearchEnabled` against the Mudlet PTB. With
// tempKey(F3) and tempKey(F4) set and the setting on, desktop's F3 drives the
// buffer search instead of the key binding (a QShortcut, resolved before the
// command line offers the key to the key unit), typed text still reaches the
// command line, and F4 still fires. Web fired the F3 binding, and the find bar
// it opened took focus — and with it the typing and every other binding.
// The wire-side items of the issue are in
// tests/mud/connection/configEffectDrift379.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OutputArea } from '../../src/ui/output/OutputArea';
import { MudSession } from '../../src/mud/MudSession';
import { ConnectionIdContext } from '../../src/storage/hooks';
import { useAppStore } from '../../src/storage/appStore';
import { listenForKeybindings } from '../../src/mud/keybindings/keyEventTarget';
import { claimedByAppShortcut } from '../../src/hooks/useKeyboardShortcuts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN = 'f3-search-drift-379';

let root: Root;
let session: MudSession;
let input: HTMLTextAreaElement;
let fired: string[];
let stopKeys: () => void;

function mount(f3SearchEnabled: boolean): void {
    useAppStore.setState(s => ({
        connectionProfile: { ...s.connectionProfile, [CONN]: { config: { f3SearchEnabled } } },
    }));
    act(() => {
        root.render(createElement(ConnectionIdContext.Provider, { value: CONN },
            createElement(OutputArea, { session, commandInputRef: { current: input } })));
    });
}

function setF3Search(on: boolean): void {
    act(() => {
        useAppStore.setState(s => ({
            connectionProfile: { ...s.connectionProfile, [CONN]: { config: { f3SearchEnabled: on } } },
        }));
    });
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...init });
    act(() => { (document.activeElement ?? document.body).dispatchEvent(e); });
    return e;
}

const searchBar = () => document.querySelector('.output-search');

beforeEach(() => {
    document.body.replaceChildren();
    const host = document.createElement('div');
    document.body.appendChild(host);
    input = document.createElement('textarea');
    input.className = 'command-input';
    document.body.appendChild(input);
    input.focus();
    root = createRoot(host);
    session = new MudSession();
    fired = [];
    // The profile's tempKey(F3) and tempKey(F4), wired as ProfileSession wires
    // the key unit: yielding to whatever the client's own shortcuts hold.
    stopKeys = listenForKeybindings(document, e => {
        if (e.key !== 'F3' && e.key !== 'F4') return false;
        fired.push(e.key);
        return true;
    }, claimedByAppShortcut);
});

afterEach(() => {
    stopKeys();
    act(() => root.unmount());
    session.destroy();
    useAppStore.setState(s => {
        const { [CONN]: _drop, ...rest } = s.connectionProfile;
        return { connectionProfile: rest };
    });
});

describe('mudlet-web#379 item 4 — f3SearchEnabled', () => {
    it('on: F3 drives the search, not the key binding, and focus stays on the command line', () => {
        mount(true);
        const e = press('F3');
        expect(fired).toEqual([]);
        expect(e.defaultPrevented).toBe(true);
        expect(searchBar()).not.toBeNull();
        expect(document.activeElement).toBe(input);
    });

    it('on: F4 still fires afterwards, and F3 still does not', () => {
        mount(true);
        press('F3');
        press('F4');
        press('F3');
        press('F3', { shiftKey: true });
        expect(fired).toEqual(['F4']);
        expect(document.activeElement).toBe(input);
    });

    it('off: F3 is the key binding\'s, and no find bar opens', () => {
        mount(false);
        press('F3');
        expect(fired).toEqual(['F3']);
        expect(searchBar()).toBeNull();
    });

    it('turned off again, F3 goes back to the key binding', () => {
        mount(true);
        press('F3');
        expect(fired).toEqual([]);
        setF3Search(false);
        // The bar F3 opened is still up; with the setting off the binding
        // wins the key again, as before #379.
        press('F3');
        expect(fired).toEqual(['F3']);
    });

    it('Ctrl+F still moves focus into the find box', () => {
        mount(true);
        press('f', { code: 'KeyF', ctrlKey: true });
        expect(document.activeElement?.classList.contains('output-search__input')).toBe(true);
    });
});
