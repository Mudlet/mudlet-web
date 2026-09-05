import { describe, it, expect } from 'vitest';
import { parseKeySequence, shortcutProblemMessage, MAX_STEPS } from '../../src/ui/commands/keySequence';

/** The steps, or the problem kind, so a case reads as one line. */
function steps(shortcut: string): string[] | string {
    const parsed = parseKeySequence(shortcut);
    return 'problem' in parsed ? parsed.problem.kind : parsed.steps;
}

describe('Qt key sequence parsing', () => {
    it('counts ordinary steps', () => {
        expect(steps('Ctrl+Alt+F1')).toEqual(['Ctrl+Alt+F1']);
        expect(steps('Ctrl+Alt+F1, Ctrl+Alt+F2')).toEqual(['Ctrl+Alt+F1', 'Ctrl+Alt+F2']);
    });

    it('takes exactly as many steps as Qt can hold', () => {
        expect(steps('Ctrl+Alt+F5, Ctrl+Alt+F6, Ctrl+Alt+F7, Ctrl+Alt+F8')).toHaveLength(MAX_STEPS);
    });

    it('refuses one step more, for its length', () => {
        expect(steps('Ctrl+Alt+F1, Ctrl+Alt+F2, Ctrl+Alt+F3, Ctrl+Alt+F4, Ctrl+Alt+F5')).toBe('length');
        expect(shortcutProblemMessage('Ctrl+Alt+F1, Ctrl+Alt+F2, Ctrl+Alt+F3, Ctrl+Alt+F4, Ctrl+Alt+F5'))
            .toContain('4');
    });

    // Qt steps over the separator and the one space after it and then stops, so
    // the list written by a loop is the steps it names and not one more.
    it('does not count a trailing separator as a step', () => {
        expect(steps('Ctrl+Alt+F1, Ctrl+Alt+F2, Ctrl+Alt+F3, Ctrl+Alt+F12, ')).toHaveLength(4);
    });

    // The two characters that are punctuation and keys at once.
    it('reads the plus key as one step, not as a joiner', () => {
        expect(steps('Ctrl++, Ctrl+Alt+F11')).toEqual(['Ctrl++', 'Ctrl+Alt+F11']);
        // and so an over-long sequence starting with it is still over-long
        expect(steps('Ctrl++, Ctrl+Alt+F1, Ctrl+Alt+F2, Ctrl+Alt+F3, Ctrl+Alt+F4')).toBe('length');
    });

    it('reads the comma key as one step, not as two of nothing', () => {
        expect(steps('Ctrl+,')).toEqual(['Ctrl+,']);
    });

    // Qt reads the doubled comma as the comma key followed by a separator, so
    // this is four steps and fits.
    it('tells the comma key from the separator at the limit', () => {
        expect(steps('Ctrl+,, Ctrl+Alt+F1, Ctrl+Alt+F2, Ctrl+Alt+F3')).toHaveLength(4);
    });

    // Qt parses an unreadable chunk into Key_unknown rather than dropping it,
    // so the sequence binds nothing and shows half-written in the menu.
    it('refuses a chunk it cannot read, wherever it sits', () => {
        expect(steps('Ctrl+Alt+F10, Ctrl+Shft+B')).toBe('key');
        expect(shortcutProblemMessage('Ctrl+Alt+F10, Ctrl+Shft+B')).toContain('Shft');
    });

    it('treats no shortcut as no steps rather than an error', () => {
        expect(steps('')).toEqual([]);
        expect(steps('   ')).toEqual([]);
        expect(shortcutProblemMessage('')).toBeNull();
    });
});
