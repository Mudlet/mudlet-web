import { describe, it, expect, beforeEach } from 'vitest';
import { commandLineReservesKey, isTextEntryTarget, listenForKeybindings } from '../../src/mud/keybindings/keyEventTarget';

beforeEach(() => { document.body.replaceChildren(); });

function make(tag: string, className = ''): HTMLElement {
    const el = document.createElement(tag);
    if (className) el.className = className;
    document.body.appendChild(el);
    return el;
}

describe('isTextEntryTarget', () => {
    it('lets the command line through — it is a textarea that holds focus all session', () => {
        // Regression: guarding on tagName === 'TEXTAREA' disabled every
        // keybinding once the command bar became multi-line.
        expect(isTextEntryTarget(make('textarea', 'command-input command-input--multiline input'))).toBe(false);
    });

    it('lets the password-mode command line through too (an <input>)', () => {
        expect(isTextEntryTarget(make('input', 'command-input'))).toBe(false);
    });

    it('keeps keys inside other textareas and inputs', () => {
        expect(isTextEntryTarget(make('textarea', 'script-editor-notes'))).toBe(true);
        expect(isTextEntryTarget(make('input', 'search-box'))).toBe(true);
    });

    it('keeps keys inside contentEditable code editors', () => {
        const cm = make('div', 'cm-content');
        cm.contentEditable = 'true';
        // happy-dom does not derive isContentEditable from the attribute.
        Object.defineProperty(cm, 'isContentEditable', { value: true });
        expect(isTextEntryTarget(cm)).toBe(true);
    });

    it('passes plain elements and a null target through', () => {
        expect(isTextEntryTarget(make('div', 'output-wrapper'))).toBe(false);
        expect(isTextEntryTarget(null)).toBe(false);
    });
});

describe('listenForKeybindings (mudlet-web#180)', () => {
    /** A command line whose own handler records what reached it, standing in
     *  for CommandBar's React onKeyDown. */
    const setup = (bound: (e: KeyboardEvent) => boolean) => {
        const el = make('textarea', 'command-input');
        const reachedCommandLine: string[] = [];
        const offered: string[] = [];
        el.addEventListener('keydown', e => reachedCommandLine.push((e as KeyboardEvent).key));
        const stop = listenForKeybindings(document, e => { offered.push(e.key); return bound(e); });
        const press = (key: string, init: KeyboardEventInit = {}) => {
            const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
            el.dispatchEvent(e);
            return e;
        };
        return { press, reachedCommandLine, offered, stop };
    };

    it('lets a binding consume a key before the command line acts on it', () => {
        const t = setup(e => e.key === 'Enter' && e.altKey);
        const e = t.press('Enter', { altKey: true });
        expect(e.defaultPrevented).toBe(true);
        // Bound Alt+Return used to stage a newline too, and the next Enter then
        // sent an empty command.
        expect(t.reachedCommandLine).toEqual([]);
        t.stop();
    });

    it('passes an unbound key on to the command line', () => {
        const t = setup(() => false);
        t.press('Enter', { altKey: true });
        expect(t.reachedCommandLine).toEqual(['Enter']);
        t.stop();
    });

    it('never offers the keys the command line reserves', () => {
        const t = setup(() => true);
        for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'PageUp', 'PageDown', 'Tab']) t.press(key);
        t.press('Enter', { shiftKey: true });
        t.press('Enter', { ctrlKey: true });
        t.press('ArrowUp', { ctrlKey: true });
        expect(t.offered).toEqual([]);
        expect(t.reachedCommandLine).toHaveLength(10);
        // The same keys with other modifiers are the bindings' to take.
        t.press('ArrowUp', { altKey: true });
        t.press('Escape', { shiftKey: true });
        expect(t.offered).toEqual(['ArrowUp', 'Escape']);
        t.stop();
    });

    it('still fires bindings from outside any text field', () => {
        const t = setup(() => true);
        const div = make('div', 'output-wrapper');
        const e = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
        div.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
        expect(t.offered).toEqual(['ArrowUp']);
        t.stop();
    });
});

describe('commandLineReservesKey', () => {
    const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, ...init });
    it('matches TCommandLine::event', () => {
        expect(commandLineReservesKey(key('Enter'))).toBe(true);
        expect(commandLineReservesKey(key('Enter', { altKey: true }))).toBe(false);
        expect(commandLineReservesKey(key('ArrowDown', { shiftKey: true }))).toBe(false);
        expect(commandLineReservesKey(key('Backspace', { ctrlKey: true }))).toBe(true);
        expect(commandLineReservesKey(key('F5'))).toBe(false);
        expect(commandLineReservesKey(key('a'))).toBe(false);
    });
});
