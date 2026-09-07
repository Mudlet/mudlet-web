import { describe, it, expect } from 'vitest';
import { clickMadeSelection } from '../../src/ui/output/selectionGesture';

// Clicking the console hands focus back to the command line, and focusing a text
// field collapses the page selection — so the click that just *made* a selection
// has to be left alone. The console used to ask "is anything selected?", but
// Chrome does not collapse a selection until the tick after the click that lands
// inside it, so a plain click on selected text still answered yes: the selection
// went away and the focus never arrived, and the player had to click twice.

const click = (over: Partial<Parameters<typeof clickMadeSelection>[0]> = {}) =>
    ({ detail: 1, shiftKey: false, clientX: 100, clientY: 100, ...over });

const downAt = (x = 100, y = 100) => ({ x, y });

describe('clickMadeSelection', () => {
    it('lets a plain click through when nothing is selected', () => {
        expect(clickMadeSelection(click(), downAt(), '')).toBe(false);
    });

    it('lets a plain click on top of a selection through — it is about to clear it', () => {
        expect(clickMadeSelection(click(), downAt(), 'a rusty key')).toBe(false);
    });

    it('holds off on the click that ends a selection drag', () => {
        expect(clickMadeSelection(click({ clientX: 300 }), downAt(), 'a rusty key')).toBe(true);
    });

    it('holds off on a double- or triple-click, which select without moving', () => {
        expect(clickMadeSelection(click({ detail: 2 }), downAt(), 'rusty')).toBe(true);
        expect(clickMadeSelection(click({ detail: 3 }), downAt(), 'a rusty key')).toBe(true);
    });

    it('holds off on a shift-click, which extends the selection', () => {
        expect(clickMadeSelection(click({ shiftKey: true }), downAt(), 'a rusty key')).toBe(true);
    });

    it('forgives an unsteady hand — a few pixels is still a click', () => {
        expect(clickMadeSelection(click({ clientX: 102, clientY: 102 }), downAt(), 'a rusty key')).toBe(false);
    });

    // Dragging across empty console space selects nothing, and focus should
    // still come back: it is a click by any measure the player cares about.
    it('lets a drag that selected nothing through', () => {
        expect(clickMadeSelection(click({ clientX: 400 }), downAt(), '')).toBe(false);
    });

    it('treats a click with no press behind it as a plain one', () => {
        expect(clickMadeSelection(click(), null, 'a rusty key')).toBe(false);
    });
});
