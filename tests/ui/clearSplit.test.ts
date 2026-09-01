import { describe, it, expect, beforeEach } from 'vitest';
import { isClearSplitClick, matchClearSplitKey } from '../../src/ui/output/clearSplit';

beforeEach(() => {
    document.body.replaceChildren();
});

/** Dispatches a keydown at `target` so the predicate sees a real event.target,
 *  and reports what it made of it. */
function pressOn(target: HTMLElement, init: KeyboardEventInit): boolean {
    document.body.appendChild(target);
    let matched = false;
    const onKey = (e: Event) => { matched = matchClearSplitKey(e as KeyboardEvent); };
    document.addEventListener('keydown', onKey, true);
    target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    document.removeEventListener('keydown', onKey, true);
    return matched;
}

function commandLine(): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    el.className = 'command-input';
    return el;
}

describe('matchClearSplitKey', () => {
    it('matches Ctrl+Enter and Cmd+Enter from the command line', () => {
        expect(pressOn(commandLine(), { key: 'Enter', ctrlKey: true })).toBe(true);
        expect(pressOn(commandLine(), { key: 'Enter', metaKey: true })).toBe(true);
    });

    it('leaves the newline-staging combinations alone', () => {
        expect(pressOn(commandLine(), { key: 'Enter' })).toBe(false);
        expect(pressOn(commandLine(), { key: 'Enter', shiftKey: true })).toBe(false);
        expect(pressOn(commandLine(), { key: 'Enter', altKey: true })).toBe(false);
        expect(pressOn(commandLine(), { key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(false);
    });

    it('ignores other keys', () => {
        expect(pressOn(commandLine(), { key: 'f', ctrlKey: true })).toBe(false);
    });

    it('leaves editors that own their own Ctrl+Enter alone', () => {
        const editor = document.createElement('div');
        editor.contentEditable = 'true';
        expect(pressOn(editor, { key: 'Enter', ctrlKey: true })).toBe(false);

        const otherTextarea = document.createElement('textarea');
        expect(pressOn(otherTextarea, { key: 'Enter', ctrlKey: true })).toBe(false);
    });

    it('still fires when focus sits outside any input', () => {
        expect(pressOn(document.createElement('div'), { key: 'Enter', ctrlKey: true })).toBe(true);
    });
});

describe('isClearSplitClick', () => {
    it('is the middle button only', () => {
        expect(isClearSplitClick({ button: 1 })).toBe(true);
        expect(isClearSplitClick({ button: 0 })).toBe(false);
        expect(isClearSplitClick({ button: 2 })).toBe(false);
    });
});
