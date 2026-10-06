// Key binding drift measured against the Mudlet PTB (mudlet-web#340) — the
// parts that live in the DOM. The matching itself is pinned in
// tests/mud/keyBindingDrift340.test.ts.
//
//  2. Desktop XML's Key_Up|Keypad imports as a Keypad key and exports back.
//  3. The command line does not reserve numpad keys: a Keypad+Enter binding
//     fires instead of sending, and numpad Enter with no binding still sends.
//  6. A binding on one of the client's own shortcuts runs instead of the
//     shortcut (Ctrl+F's find bar, Ctrl+Shift+P's quick-open) — except a menu
//     accelerator (Alt+K), which desktop resolves before the binding.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { commandLineReservesKey, listenForKeybindings } from '../../src/mud/keybindings/keyEventTarget';
import { claimedByAppShortcut, useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { parseMudletXml } from '../../src/import/mudletXmlImport';
import { serializeMudletXml } from '../../src/import/mudletXmlExport';
import type { KeyNode } from '../../src/storage/schema';

const KEYPAD = 0x20000000, SHIFT = 0x02000000;
const KEY_UP = 0x01000013, KEY_EXCLAM = 0x21;

const keydown = (code: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });

describe('mudlet-web#340 item 3 — the command line and the numpad', () => {
    it('reserves Return but not numpad Enter', () => {
        expect(commandLineReservesKey(keydown('Enter', { key: 'Enter' }))).toBe(true);
        expect(commandLineReservesKey(keydown('NumpadEnter', { key: 'Enter', location: 3 }))).toBe(false);
    });

    it('still reserves plain Up on a Mac, where Qt calls the arrows keypad keys', () => {
        const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
        Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
        try {
            expect(commandLineReservesKey(keydown('ArrowUp', { key: 'ArrowUp' }))).toBe(true);
        } finally {
            if (original) Object.defineProperty(navigator, 'platform', original);
            else delete (navigator as { platform?: string }).platform;
        }
    });

    it('reserves Up but not NumLock-off numpad 8, 2 or 9', () => {
        expect(commandLineReservesKey(keydown('ArrowUp', { key: 'ArrowUp' }))).toBe(true);
        expect(commandLineReservesKey(keydown('Numpad8', { key: 'ArrowUp', location: 3 }))).toBe(false);
        expect(commandLineReservesKey(keydown('Numpad2', { key: 'ArrowDown', location: 3 }))).toBe(false);
        expect(commandLineReservesKey(keydown('Numpad9', { key: 'PageUp', location: 3 }))).toBe(false);
    });

    describe('typing into the command line', () => {
        let input: HTMLTextAreaElement;
        let reached: string[];
        let stop: () => void;
        beforeEach(() => {
            document.body.replaceChildren();
            input = document.createElement('textarea');
            input.className = 'command-input';
            document.body.appendChild(input);
            reached = [];
            input.addEventListener('keydown', e => reached.push((e as KeyboardEvent).code));
        });
        afterEach(() => stop());

        it('a Keypad-Enter binding takes numpad Enter, so the command is not sent', () => {
            stop = listenForKeybindings(document, e => e.code === 'NumpadEnter');
            const e = keydown('NumpadEnter', { key: 'Enter', location: 3 });
            input.dispatchEvent(e);
            expect(e.defaultPrevented).toBe(true);
            expect(reached).toEqual([]);
        });

        it('with no binding, numpad Enter still reaches the command line', () => {
            stop = listenForKeybindings(document, () => false);
            input.dispatchEvent(keydown('NumpadEnter', { key: 'Enter', location: 3 }));
            expect(reached).toEqual(['NumpadEnter']);
        });
    });
});

describe('mudlet-web#340 item 6 — bindings and the client\'s shortcuts', () => {
    let input: HTMLTextAreaElement;
    let opened: string[];
    let stop: () => void;
    const appCapture: ((e: KeyboardEvent) => void)[] = [];

    /** One of the client's own document-capture shortcuts, registered BEFORE
     *  the keybinding listener — the order that let both run. */
    const appShortcut = (name: string, matches: (e: KeyboardEvent) => boolean) => {
        const fn = (e: KeyboardEvent) => {
            if (!matches(e)) return;
            e.preventDefault();
            e.stopPropagation();
            opened.push(name);
        };
        appCapture.push(fn);
        document.addEventListener('keydown', fn, true);
    };

    beforeEach(() => {
        document.body.replaceChildren();
        input = document.createElement('textarea');
        input.className = 'command-input';
        document.body.appendChild(input);
        opened = [];
    });
    afterEach(() => {
        stop?.();
        for (const fn of appCapture.splice(0)) document.removeEventListener('keydown', fn, true);
    });

    it('a Ctrl+F binding runs and the find bar does not open', () => {
        appShortcut('find', e => e.ctrlKey && e.code === 'KeyF');
        const fired: string[] = [];
        stop = listenForKeybindings(document, e => {
            if (e.ctrlKey && e.code === 'KeyF') { fired.push('flee'); return true; }
            return false;
        });
        const e = keydown('KeyF', { key: 'f', ctrlKey: true });
        input.dispatchEvent(e);
        expect(fired).toEqual(['flee']);
        expect(opened).toEqual([]);
    });

    it('a Ctrl+Shift+P binding runs and the quick-open palette does not', () => {
        appShortcut('quickOpen', e => e.ctrlKey && e.shiftKey && e.code === 'KeyP');
        stop = listenForKeybindings(document, e => e.ctrlKey && e.shiftKey && e.code === 'KeyP');
        input.dispatchEvent(keydown('KeyP', { key: 'P', ctrlKey: true, shiftKey: true }));
        expect(opened).toEqual([]);
    });

    it('with no binding on the key, the shortcut still opens', () => {
        appShortcut('find', e => e.ctrlKey && e.code === 'KeyF');
        stop = listenForKeybindings(document, () => false);
        input.dispatchEvent(keydown('KeyF', { key: 'f', ctrlKey: true }));
        expect(opened).toEqual(['find']);
    });

    describe('a menu accelerator wins over the binding', () => {
        let root: Root;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

        beforeEach(() => {
            const host = document.createElement('div');
            document.body.appendChild(host);
            root = createRoot(host);
        });
        afterEach(() => act(() => root.unmount()));

        const mount = (bindings: { shortcut: string; run: () => void }[]) => {
            const Probe = () => { useKeyboardShortcuts(bindings); return null; };
            act(() => { root.render(createElement(Probe)); });
        };

        it.each([
            ['Alt+K', 'KeyK', { altKey: true }],
            ['Ctrl+Alt+T', 'KeyT', { ctrlKey: true, altKey: true }],
        ])('%s runs the action and not the binding', (shortcut, code, mods) => {
            mount([{ shortcut, run: () => opened.push(shortcut) }]);
            const offered: string[] = [];
            stop = listenForKeybindings(document, e => { offered.push(e.code); return true; }, claimedByAppShortcut);
            input.dispatchEvent(keydown(code, mods));
            expect(opened).toEqual([shortcut]);
            expect(offered).toEqual([]);
        });

        it('a key no accelerator holds still reaches the binding', () => {
            mount([{ shortcut: 'Alt+K', run: () => opened.push('mute') }]);
            const offered: string[] = [];
            stop = listenForKeybindings(document, e => { offered.push(e.code); return true; }, claimedByAppShortcut);
            input.dispatchEvent(keydown('KeyJ', { altKey: true }));
            expect(offered).toEqual(['KeyJ']);
            expect(opened).toEqual([]);
        });
    });
});

describe('mudlet-web#340 items 2 and 4 — Mudlet XML keeps the Qt key', () => {
    const xmlKey = (keyCode: number, keyModifier: number) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE MudletPackage><MudletPackage version="1.001"><KeyPackage>
<Key isActive="yes" isFolder="no"><name>k</name><packageName></packageName><script></script>
<command></command><keyCode>${keyCode}</keyCode><keyModifier>${keyModifier}</keyModifier></Key>
</KeyPackage></MudletPackage>`;
    const EMPTY = { scripts: [], aliases: [], triggers: [], timers: [], keys: [] as KeyNode[], buttons: [] };
    const roundTrip = (keyCode: number, keyModifier: number) => {
        const [k] = parseMudletXml(xmlKey(keyCode, keyModifier)).keys;
        const xml = serializeMudletXml({ ...EMPTY, keys: [k] } as never);
        return { k, xml };
    };

    it('Key_Up|Keypad imports as a Keypad key and exports unchanged', () => {
        const { k, xml } = roundTrip(KEY_UP, KEYPAD);
        expect(k).toMatchObject({ key: 'ArrowUp', modifiers: ['keypad'], qtKey: KEY_UP });
        expect(xml).toContain(`<keyCode>${KEY_UP}</keyCode>`);
        expect(xml).toContain(`<keyModifier>${KEYPAD}</keyModifier>`);
    });

    it('Key_Exclam|Shift exports as Key_Exclam, not Key_1', () => {
        const { k, xml } = roundTrip(KEY_EXCLAM, SHIFT);
        expect(k).toMatchObject({ key: 'Digit1', modifiers: ['shift'], qtKey: KEY_EXCLAM });
        expect(xml).toContain(`<keyCode>${KEY_EXCLAM}</keyCode>`);
    });

    it('AZERTY Key_Eacute imports bound by its character and exports unchanged', () => {
        const { k, xml } = roundTrip(0xc9, 0);
        expect(k).toMatchObject({ key: '', qtKey: 0xc9 });
        expect(xml).toContain('<keyCode>201</keyCode>');
        expect(parseMudletXml(xmlKey(0xc9, 0)).warnings ?? []).toEqual([]);
    });

    it('numpad Enter exports with the Keypad bit, as Qt reports it', () => {
        const { xml } = roundTrip(0x01000005, KEYPAD);
        expect(xml).toContain(`<keyModifier>${KEYPAD}</keyModifier>`);
    });
});
