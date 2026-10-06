import { describe, it, expect } from 'vitest';
import { TabCompletionCycle, tabCompletionMatches, tabCompletionPool, TAB_COMPLETION_LINES } from '../../src/ui/tabCompletion';
import { Console } from '../../src/mud/text/Console';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

// Issue #342 items 1 and 2: Tab completion measured against desktop's
// TCommandLine::handleTabCompletion.

const complete = (typed: string, pool: string[]) => {
    const found = tabCompletionMatches(typed, pool);
    return found ? found.userWords + found.matches[0] : typed;
};

describe('which words a Tab offers (#342 item 1)', () => {
    // Desktop needs at least one more word character straight after what was
    // typed (`^<typed>\w+`), so a hyphen, an apostrophe or a space ends it.
    const suggestions = tabCompletionPool([], ['zq-thing', "zqo'brien", 'zqx ray']);

    it.each([
        ['zq', 'zqx ray'],
        ['zqo', 'zqo'],
        ['zqx', 'zqx'],
    ])('%s + Tab sends %s', (typed, sent) => {
        expect(complete(typed, suggestions)).toBe(sent);
    });

    it('matches ignoring case, and completes only the last word', () => {
        expect(complete('look ZQ', ['zqcase'])).toBe('look zqcase');
    });

    it('does nothing on an empty line or after a space', () => {
        expect(tabCompletionMatches('', ['zqcase'])).toBeNull();
        expect(tabCompletionMatches('zq ', ['zqcase'])).toBeNull();
    });
});

describe('where the words come from (#342 item 2)', () => {
    it('keeps spellings that differ only in case apart, newest first', () => {
        const pool = tabCompletionPool(['zqold', 'zqcase ZQCASE']);
        const cycle = new TabCompletionCycle();
        const first = cycle.step('zqc', 1, () => pool)!;
        expect(first.text).toBe('ZQCASE');
        expect(cycle.step(first.text, 1, () => pool)!.text).toBe('zqcase');
    });

    it('stops at the last candidate instead of wrapping, and Shift+Tab steps back', () => {
        const pool = ['zqa', 'zqb'];
        const cycle = new TabCompletionCycle();
        let text = cycle.step('zq', 1, () => pool)!.text;
        expect(text).toBe('zqb');
        text = cycle.step(text, 1, () => pool)!.text;
        expect(text).toBe('zqa');
        text = cycle.step(text, 1, () => pool)!.text;
        expect(text).toBe('zqa');
        expect(cycle.step(text, -1, () => pool)!.text).toBe('zqb');
    });

    it('starts over from what was typed after an edit', () => {
        const pool = ['zqa', 'zqb', 'zqbb'];
        const cycle = new TabCompletionCycle();
        cycle.step('zq', 1, () => pool);
        expect(cycle.step('zqb', 1, () => pool)!.text).toBe('zqbb');
    });

    it('reads only the last 500 lines of the main console', () => {
        const main = new Console();
        const add = (text: string) => main.appendLine(new AnsiAwareBuffer(text));
        add('zqold');
        for (let i = 0; i < 600; i++) add('-');
        add('zqcase ZQCASE');
        const lines = main.getEndLines(TAB_COMPLETION_LINES);
        expect(lines.length).toBeLessThanOrEqual(TAB_COMPLETION_LINES);
        const pool = tabCompletionPool(lines);
        expect(complete('zqo', pool)).toBe('zqo');
        expect(complete('zqc', pool)).toBe('ZQCASE');
    });

    it('offers nothing a clearWindow() wiped', () => {
        const main = new Console();
        main.appendLine(new AnsiAwareBuffer('zqclr'));
        expect(complete('zqc', tabCompletionPool(main.getEndLines(TAB_COMPLETION_LINES)))).toBe('zqclr');
        main.clear();
        expect(complete('zqc', tabCompletionPool(main.getEndLines(TAB_COMPLETION_LINES)))).toBe('zqc');
    });

    it('strikes blacklisted words out of the buffer and the suggestions alike, ignoring case', () => {
        const pool = tabCompletionPool(['zqblack zqkeep'], ['ZQBLACKER'], ['ZQBLACK', 'zqblacker']);
        expect(pool).toEqual(['zqkeep']);
    });
});
