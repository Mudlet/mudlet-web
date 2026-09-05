import { describe, it, expect } from 'vitest';
import { trimWordSelection } from '../../src/ui/output/wordSelection';

describe('trimWordSelection', () => {
    it('leaves the selection alone when no characters are listed', () => {
        expect(trimWordSelection('"Ancalagon"', 0, 11, '')).toEqual({ start: 0, end: 11 });
    });

    it('trims the quotes a game wraps a name in', () => {
        // The browser selected «"Ancalagon"»; the click was on the name.
        const text = '"Ancalagon"';
        expect(trimWordSelection(text, 0, 11, '"', 4)).toEqual({ start: 1, end: 10 });
        expect(text.slice(1, 10)).toBe('Ancalagon');
    });

    it('keeps the run the click landed in when a stop sits mid-selection', () => {
        const text = 'north-east';
        // Clicking "north" keeps "north"; clicking "east" keeps "east".
        expect(trimWordSelection(text, 0, 10, '-', 2)).toEqual({ start: 0, end: 5 });
        expect(trimWordSelection(text, 0, 10, '-', 7)).toEqual({ start: 6, end: 10 });
    });

    it('never widens the browser selection', () => {
        const text = 'aaa bbb ccc';
        const { start, end } = trimWordSelection(text, 4, 7, '-', 5);
        expect(start).toBeGreaterThanOrEqual(4);
        expect(end).toBeLessThanOrEqual(7);
    });

    it('leaves a click that landed on a stop character alone', () => {
        // Nothing to keep — collapsing to an empty selection would read as a
        // double-click that did nothing at all.
        expect(trimWordSelection('a-b', 0, 3, '-', 1)).toEqual({ start: 0, end: 3 });
    });

    it('handles an empty or inverted range', () => {
        expect(trimWordSelection('abc', 2, 2, '-')).toEqual({ start: 2, end: 2 });
        expect(trimWordSelection('abc', 3, 1, '-')).toEqual({ start: 3, end: 1 });
    });

    it('clamps an anchor that sits past the end of the selection', () => {
        // Clamped to the last character in range, which here is the closing
        // quote — a stop, so the selection is left as the browser made it.
        // Defensive only: the DOM path never passes an anchor of its own.
        expect(trimWordSelection('"abc"', 0, 5, '"', 99)).toEqual({ start: 0, end: 5 });
        // Clamped onto an ordinary character, it trims as usual.
        expect(trimWordSelection('"abc', 0, 4, '"', 99)).toEqual({ start: 1, end: 4 });
    });

    it('treats every listed character as a stop', () => {
        expect(trimWordSelection("<<'hi'>>", 0, 8, "<>'", 3)).toEqual({ start: 3, end: 5 });
    });
});
