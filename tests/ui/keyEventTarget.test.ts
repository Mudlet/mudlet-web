import { describe, it, expect, beforeEach } from 'vitest';
import { isTextEntryTarget } from '../../src/mud/keybindings/keyEventTarget';

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
