// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { classifyPress, domButtonToMudlet, domButtonsToMudlet } from '../../src/ui/labels/LabelOverlay';

// Mudlet reports `event.button` to label callbacks as a Qt button NAME string
// (csmMouseButtons in TLuaInterpreter), not an int. Geyser packages branch on
// these literals (`if event.button == "LeftButton"`), so the DOM→Mudlet mapping
// must produce the exact strings. Regression for the bug where Muxlet's
// titlebar/split/drag buttons did nothing because Mudlet Web passed integers.
describe('domButtonToMudlet', () => {
    it('maps DOM button codes to Mudlet button-name strings on press/click', () => {
        expect(domButtonToMudlet('click', 0)).toBe('LeftButton');
        expect(domButtonToMudlet('mousedown', 0)).toBe('LeftButton');
        expect(domButtonToMudlet('mouseup', 2)).toBe('RightButton');
        expect(domButtonToMudlet('dblclick', 1)).toBe('MidButton');
        expect(domButtonToMudlet('mousedown', 3)).toBe('BackButton');
        expect(domButtonToMudlet('mousedown', 4)).toBe('ForwardButton');
    });

    it('reports NoButton for move/enter/leave (Qt button() is NoButton there)', () => {
        expect(domButtonToMudlet('mousemove', 0)).toBe('NoButton');
        expect(domButtonToMudlet('pointermove', -1)).toBe('NoButton');
        expect(domButtonToMudlet('mouseenter', 0)).toBe('NoButton');
        expect(domButtonToMudlet('mouseleave', 0)).toBe('NoButton');
    });

    it('maps pointerdown/pointerup (used for press + captured drag release)', () => {
        expect(domButtonToMudlet('pointerdown', 0)).toBe('LeftButton');
        expect(domButtonToMudlet('pointerup', 0)).toBe('LeftButton');
        expect(domButtonToMudlet('pointerdown', 2)).toBe('RightButton');
    });

    it('falls back to NoButton for unknown button codes', () => {
        expect(domButtonToMudlet('click', 9)).toBe('NoButton');
    });
});

describe('domButtonsToMudlet', () => {
    it('lists held buttons in Qt bit order', () => {
        expect(domButtonsToMudlet(0)).toEqual([]);
        expect(domButtonsToMudlet(1)).toEqual(['LeftButton']);
        expect(domButtonsToMudlet(1 | 2 | 4)).toEqual(['LeftButton', 'RightButton', 'MidButton']);
        expect(domButtonsToMudlet(8 | 16)).toEqual(['BackButton', 'ForwardButton']);
    });
});

// Qt delivers the second press of a double-click as mouseDoubleClickEvent
// instead of a press, so desktop's sequence is click, release, double-click,
// release — the click callback runs once, not twice (issue #186).
describe('classifyPress', () => {
    it('uses the click count when the browser supplies one', () => {
        expect(classifyPress(1, 0, 0, null).double).toBe(false);
        expect(classifyPress(2, 0, 0, null).double).toBe(true);
        // The press after a double-click is an ordinary press again.
        expect(classifyPress(3, 0, 0, null).double).toBe(false);
        expect(classifyPress(4, 0, 0, null).double).toBe(true);
    });

    it('falls back to timing when detail is 0', () => {
        const first = classifyPress(0, 0, 1000, null);
        expect(first.double).toBe(false);
        const second = classifyPress(0, 0, 1200, first);
        expect(second.double).toBe(true);
        expect(classifyPress(0, 0, 1300, second).double).toBe(false);
        // Too slow, or a different button: two single presses.
        expect(classifyPress(0, 0, 2000, first).double).toBe(false);
        expect(classifyPress(0, 2, 1200, first).double).toBe(false);
    });
});
