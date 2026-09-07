// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { domButtonToMudlet } from '../../src/ui/labels/LabelOverlay';

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
