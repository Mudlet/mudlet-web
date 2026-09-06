import { describe, it, expect, afterEach } from 'vitest';
import { detectDock } from '../../src/ui/layout/dockDetect';

// A floating window may be dragged over the top bar — it paints there like a
// Mudlet top-level window does. What must NOT happen is the top dock arming
// from up there: the ghost dock area opens at the viewport's top edge, which
// puts the cursor *above* the newly-created `.dock-area-top`, so the very next
// move disarms it, the viewport grows back, and it arms again. Flicker.
//
// Mudlet's rule is the one pinned here: the toolbar strip is outside the client
// area, docking is not live there, the window stays floating.

const TOPBAR_H  = 71;   // two-row top bar (menu row + button row)
const VIEWPORT  = { left: 0, right: 1000, top: TOPBAR_H, bottom: 700 };

function rect(el: HTMLElement, r: { left: number; right: number; top: number; bottom: number }) {
    el.getBoundingClientRect = () => ({
        ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => ({}),
    }) as DOMRect;
}

/** The layout with no docks open: just the main viewport under the top bar. */
function mountViewport(top = VIEWPORT.top) {
    const vp = document.createElement('div');
    vp.className = 'main-viewport';
    rect(vp, { ...VIEWPORT, top });
    document.body.appendChild(vp);
    return vp;
}

/** The preview state: the ghost dock area has opened at the viewport's old top
 *  edge, pushing the viewport down by its extent. */
function mountTopPreview(extent = 200) {
    const dock = document.createElement('div');
    dock.className = 'dock-area-top';
    rect(dock, { left: VIEWPORT.left, right: VIEWPORT.right, top: VIEWPORT.top, bottom: VIEWPORT.top + extent });
    const ghost = document.createElement('div');
    ghost.className = 'dock-panel-slot dock-panel-slot--preview';
    dock.appendChild(ghost);
    document.body.appendChild(dock);
    return dock;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('detectDock over the top bar', () => {
    it('does not arm the top dock while the cursor is in the top bar strip', () => {
        mountViewport();
        expect(detectDock(500, 20).side).toBeNull();
        expect(detectDock(500, TOPBAR_H - 1).side).toBeNull();
    });

    it('still arms the top dock just inside the viewport', () => {
        mountViewport();
        expect(detectDock(500, TOPBAR_H + 1).side).toBe('top');
    });

    it('stays disarmed once the preview has opened — no arm/disarm oscillation', () => {
        // Frame 1: cursor in the bar, nothing armed.
        mountViewport();
        expect(detectDock(500, 20).side).toBeNull();

        // Frame 2: had it armed, this is the layout it would have produced.
        // The cursor sits above the ghost dock, so detection says "no dock" —
        // which is what removes the ghost and starts the flicker loop.
        document.body.innerHTML = '';
        mountTopPreview();
        mountViewport(VIEWPORT.top + 200);
        expect(detectDock(500, 20).side).toBeNull();

        // Frame 3: back to frame 1's layout. Re-arming here is the flicker;
        // it must stay null.
        document.body.innerHTML = '';
        mountViewport();
        expect(detectDock(500, 20).side).toBeNull();
    });

    it('does not arm left/right from outside the viewport either', () => {
        mountViewport();
        expect(detectDock(10, 20).side).toBeNull();          // top-left, in the bar
        expect(detectDock(990, 20).side).toBeNull();         // top-right, in the bar
        expect(detectDock(10, 300).side).toBe('left');       // inside → still works
        expect(detectDock(990, 300).side).toBe('right');
    });
});
