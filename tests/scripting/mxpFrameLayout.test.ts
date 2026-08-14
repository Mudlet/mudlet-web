// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { MxpFrameManager, MXP_TAB_BAR_HEIGHT, type MxpFrameHost, type MxpBorders } from '../../src/scripting/MxpFrameManager';
import type { MxpTabPage } from '../../src/ui/windows/types';

interface Placement { x: number; y: number; width: number; height: number; parent?: string }

/** Records what the layout asked the UI to do, so the geometry can be asserted
 *  without a DOM. Console area 1000x600 at the origin unless `area` overrides
 *  it (a GUI package reserving an edge strip via setBorder*); cell 10x20. */
function makeHost(area = { x: 0, y: 0, width: 1000, height: 600 }) {
    const placed = new Map<string, Placement>();
    const tabs = new Map<string, { pages: MxpTabPage[]; active: string }>();
    const external: { name: string; title: string; width: number; height: number }[] = [];
    const destroyed: string[] = [];
    const shown: string[] = [];
    const raised: string[] = [];
    const scrolling = new Map<string, boolean>();
    let borders: MxpBorders = { top: 0, right: 0, bottom: 0, left: 0 };

    const host: MxpFrameHost = {
        consoleArea: () => area,
        charCellSize: () => [10, 20],
        placeFrameConsole: (name, x, y, width, height, parent) => {
            placed.set(name, { x, y, width, height, parent });
        },
        openExternalFrame: (name, title, width, height) => { external.push({ name, title, width, height }); },
        destroyFrameConsole: (name) => { destroyed.push(name); placed.delete(name); },
        showFrameConsole: (name) => { shown.push(name); },
        raiseFrameConsole: (name) => { raised.push(name); },
        setFrameScrolling: (name, enabled) => { scrolling.set(name, enabled); },
        setFrameTabs: (name, pages, active) => {
            if (pages.length === 0) tabs.delete(name);
            else tabs.set(name, { pages, active });
        },
        setMxpBorders: (b) => { borders = b; },
    };
    return { host, placed, tabs, external, destroyed, shown, raised, scrolling, getBorders: () => borders };
}

describe('MxpFrameManager — edge tiling', () => {
    let h: ReturnType<typeof makeHost>;
    let mgr: MxpFrameManager;
    beforeEach(() => { h = makeHost(); mgr = new MxpFrameManager(h.host); });

    it('defaults to a left-aligned quarter-width frame spanning the full height', () => {
        expect(mgr.createFrame('Status', { NAME: 'Status' })).toBe(true);
        // WIDTH/HEIGHT default to 25%, ALIGN to left — so 25% of 1000 wide, full height.
        expect(h.placed.get('Status')).toEqual({ x: 0, y: 0, width: 250, height: 600, parent: undefined });
        expect(h.getBorders()).toEqual({ top: 0, right: 0, bottom: 0, left: 250 });
    });

    it('tiles a second left frame beside the first instead of stacking it at x=0', () => {
        mgr.createFrame('A', { NAME: 'A', ALIGN: 'left', WIDTH: '200' });
        mgr.createFrame('B', { NAME: 'B', ALIGN: 'left', WIDTH: '150' });
        expect(h.placed.get('A')?.x).toBe(0);
        expect(h.placed.get('B')?.x).toBe(200);
        expect(h.getBorders().left).toBe(350);
    });

    it('lays a top frame in the space the left frame did not claim', () => {
        mgr.createFrame('Side', { NAME: 'Side', ALIGN: 'left', WIDTH: '200' });
        mgr.createFrame('Bar', { NAME: 'Bar', ALIGN: 'top', HEIGHT: '40' });
        expect(h.placed.get('Bar')).toMatchObject({ x: 200, y: 0, width: 800, height: 40 });
        expect(h.getBorders()).toEqual({ top: 40, right: 0, bottom: 0, left: 200 });
    });

    it('anchors right and bottom frames to their edges', () => {
        mgr.createFrame('R', { NAME: 'R', ALIGN: 'right', WIDTH: '100' });
        mgr.createFrame('B', { NAME: 'B', ALIGN: 'bottom', HEIGHT: '50' });
        expect(h.placed.get('R')).toMatchObject({ x: 900, y: 0, width: 100, height: 600 });
        expect(h.placed.get('B')).toMatchObject({ x: 0, y: 550, width: 900, height: 50 });
        expect(h.getBorders()).toEqual({ top: 0, right: 100, bottom: 50, left: 0 });
    });

    it('honours LEFT/TOP over ALIGN and claims no border for such a frame', () => {
        mgr.createFrame('Float', { NAME: 'Float', ALIGN: 'left', LEFT: '300', TOP: '40', WIDTH: '120', HEIGHT: '80' });
        expect(h.placed.get('Float')).toMatchObject({ x: 300, y: 40, width: 120, height: 80 });
        expect(h.getBorders()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    it('resolves percentage, pixel and character geometry specs', () => {
        mgr.createFrame('Pct', { NAME: 'Pct', ALIGN: 'top', HEIGHT: '10%' });          // 10% of 600
        mgr.createFrame('Px', { NAME: 'Px', ALIGN: 'top', HEIGHT: '35px' });
        mgr.createFrame('Ch', { NAME: 'Ch', ALIGN: 'top', HEIGHT: '3c' });             // 3 rows x 20px row height + slack
        expect(h.placed.get('Pct')?.height).toBe(60);
        expect(h.placed.get('Px')?.height).toBe(35);
        expect(h.placed.get('Ch')?.height).toBe(68);
    });

    it('gives the space back when an edge frame closes', () => {
        mgr.createFrame('A', { NAME: 'A', ALIGN: 'left', WIDTH: '200' });
        mgr.createFrame('B', { NAME: 'B', ALIGN: 'left', WIDTH: '150' });
        mgr.createFrame('A', { NAME: 'A', ACTION: 'close' });
        expect(h.destroyed).toContain('A');
        expect(h.getBorders().left).toBe(150);
        expect(mgr.frameNames()).toEqual(['B']);
    });

    it('re-shows an existing frame on ACTION=open without moving it', () => {
        mgr.createFrame('A', { NAME: 'A', ALIGN: 'left', WIDTH: '200' });
        const before = { ...h.placed.get('A')! };
        expect(mgr.createFrame('A', { NAME: 'A', ALIGN: 'right', WIDTH: '500' })).toBe(true);
        expect(h.placed.get('A')).toEqual(before);
        expect(h.shown).toEqual(['A']);
        expect(h.getBorders().left).toBe(200);
    });

    it('raises on ACTION=focus and reports failure for an unknown frame', () => {
        mgr.createFrame('A', { NAME: 'A' });
        expect(mgr.createFrame('A', { NAME: 'A', ACTION: 'focus' })).toBe(true);
        expect(h.raised).toContain('A');
        expect(mgr.createFrame('Ghost', { NAME: 'Ghost', ACTION: 'focus' })).toBe(false);
    });

    it('closing a frame that never opened is a success, not a stray tag', () => {
        expect(mgr.createFrame('Nope', { NAME: 'Nope', ACTION: 'close' })).toBe(true);
    });

    it('rejects an invalid frame name and caps the number of frames', () => {
        expect(mgr.createFrame('bad name!', { NAME: 'bad name!' })).toBe(false);
        for (let i = 0; i < 20; i++) mgr.createFrame(`F${i}`, { NAME: `F${i}`, LEFT: '1', TOP: '1' });
        expect(mgr.createFrame('F20', { NAME: 'F20' })).toBe(false);
    });

    it('drops every frame and border on reset', () => {
        mgr.createFrame('A', { NAME: 'A', ALIGN: 'left' });
        mgr.createFrame('B', { NAME: 'B', ALIGN: 'top' });
        mgr.resetAllFrames();
        expect(mgr.frameNames()).toEqual([]);
        expect(h.destroyed).toEqual(expect.arrayContaining(['A', 'B']));
        expect(h.getBorders()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    it('turns SCROLLING=no into a tail-locked console', () => {
        mgr.createFrame('Status', { NAME: 'Status', SCROLLING: 'no' });
        expect(h.scrolling.get('Status')).toBe(false);
        mgr.createFrame('Chat', { NAME: 'Chat', ALIGN: 'right' });
        expect(h.scrolling.has('Chat')).toBe(false);
    });

    // A GUI package docked to an edge (Geyser Adjustable.Container{attached=…})
    // reserves its strip with setBorderRight and friends. Frames tile in what is
    // left, or a server's right-hand frame lands on top of the package's panel.
    it('keeps out of the strip a GUI package reserved with setBorder*', () => {
        const h2 = makeHost({ x: 40, y: 20, width: 700, height: 560 }); // 260px reserved right, 20 top, 40 left
        const mgr2 = new MxpFrameManager(h2.host);
        mgr2.createFrame('Side', { NAME: 'Side', ALIGN: 'RIGHT', WIDTH: '120' });
        mgr2.createFrame('Bar', { NAME: 'Bar', ALIGN: 'TOP', HEIGHT: '40' });
        mgr2.createFrame('Abs', { NAME: 'Abs', LEFT: '10', TOP: '10', WIDTH: '80', HEIGHT: '60' });
        // Right edge of the area is 40 + 700 = 740, not the window's 1000.
        expect(h2.placed.get('Side')).toMatchObject({ x: 620, y: 20, width: 120, height: 560 });
        expect(h2.placed.get('Bar')).toMatchObject({ x: 40, y: 20, width: 580 });
        expect(h2.placed.get('Abs')).toMatchObject({ x: 50, y: 30 });
    });

    it('opens an EXTERNAL frame as its own window rather than tiling it', () => {
        mgr.createFrame('Chat', { NAME: 'Chat', EXTERNAL: 'true', TITLE: 'Chat log', WIDTH: '300', HEIGHT: '200' });
        expect(h.external).toEqual([{ name: 'Chat', title: 'Chat log', width: 300, height: 200 }]);
        expect(h.placed.has('Chat')).toBe(false);
        expect(h.getBorders()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });
});

describe('MxpFrameManager — nesting inside <DEST>', () => {
    let h: ReturnType<typeof makeHost>;
    let mgr: MxpFrameManager;
    beforeEach(() => { h = makeHost(); mgr = new MxpFrameManager(h.host); });

    it('subdivides the destination frame instead of the main window', () => {
        mgr.createFrame('Col', { NAME: 'Col', ALIGN: 'left', WIDTH: '200' });
        mgr.createFrame('Map', { NAME: 'Map', ALIGN: 'top', HEIGHT: '150' }, 'Col');
        mgr.createFrame('Room', { NAME: 'Room', ALIGN: 'top', HEIGHT: '100' }, 'Col');
        // Both are parent-relative and stack: the second starts where the first ended.
        expect(h.placed.get('Map')).toEqual({ x: 0, y: 0, width: 200, height: 150, parent: 'Col' });
        expect(h.placed.get('Room')).toEqual({ x: 0, y: 150, width: 200, height: 100, parent: 'Col' });
        // Nested frames take nothing from the main console.
        expect(h.getBorders()).toEqual({ top: 0, right: 0, bottom: 0, left: 200 });
    });

    it('reads 100% inside a parent as the space still free', () => {
        mgr.createFrame('Col', { NAME: 'Col', ALIGN: 'left', WIDTH: '200' });
        mgr.createFrame('Head', { NAME: 'Head', ALIGN: 'top', HEIGHT: '150' }, 'Col');
        mgr.createFrame('Rest', { NAME: 'Rest', ALIGN: 'top', HEIGHT: '100%' }, 'Col');
        expect(h.placed.get('Rest')).toMatchObject({ y: 150, height: 450 });
    });

    it('closes nested children along with their parent', () => {
        mgr.createFrame('Col', { NAME: 'Col', ALIGN: 'left', WIDTH: '200' });
        mgr.createFrame('Map', { NAME: 'Map', ALIGN: 'top', HEIGHT: '150' }, 'Col');
        mgr.createFrame('Col', { NAME: 'Col', ACTION: 'close' });
        expect(mgr.frameNames()).toEqual([]);
        expect(h.destroyed).toEqual(expect.arrayContaining(['Map', 'Col']));
    });

    it('falls back to the main window when the DEST frame is unknown', () => {
        mgr.createFrame('Orphan', { NAME: 'Orphan', ALIGN: 'left', WIDTH: '200' }, 'Missing');
        expect(h.placed.get('Orphan')?.parent).toBeUndefined();
        expect(h.getBorders().left).toBe(200);
    });
});

describe('MxpFrameManager — titles and tabs', () => {
    let h: ReturnType<typeof makeHost>;
    let mgr: MxpFrameManager;
    beforeEach(() => { h = makeHost(); mgr = new MxpFrameManager(h.host); });

    it('gives a TITLEd frame a header and reserves its height', () => {
        mgr.createFrame('Chat', { NAME: 'Chat', ALIGN: 'top', HEIGHT: '100', TITLE: 'Channels' });
        expect(h.tabs.get('Chat')).toEqual({ pages: [{ id: 'Chat', title: 'Channels' }], active: 'Chat' });
        // A child fills what is left inside the frame, below the strip.
        mgr.createFrame('Sub', { NAME: 'Sub', ALIGN: 'top', HEIGHT: '100%' }, 'Chat');
        expect(h.placed.get('Sub')?.height).toBe(100 - MXP_TAB_BAR_HEIGHT);
    });

    it('leaves an untitled or FLOATING frame headerless', () => {
        mgr.createFrame('Bare', { NAME: 'Bare', ALIGN: 'top', HEIGHT: '100' });
        mgr.createFrame('Free', { NAME: 'Free', ALIGN: 'top', HEIGHT: '100', TITLE: 'x', FLOATING: 'true' });
        expect(h.tabs.has('Bare')).toBe(false);
        expect(h.tabs.has('Free')).toBe(false);
    });

    // The tab strip and the console's padding come out of the frame, never out
    // of the rows the server asked for — a 3c frame still shows three rows.
    it('adds a character-height title bar on top of the requested rows', () => {
        mgr.createFrame('Rows', { NAME: 'Rows', ALIGN: 'top', HEIGHT: '3c', TITLE: 'Rows' });
        expect(h.placed.get('Rows')?.height).toBe(3 * 20 + MXP_TAB_BAR_HEIGHT + 8);
    });

    it('docks ALIGN=CLIENT frames into the target frame as extra tabs', () => {
        mgr.createFrame('Chat', { NAME: 'Chat', ALIGN: 'top', HEIGHT: '120', TITLE: 'Channels' });
        mgr.createFrame('Room', { NAME: 'Room', ALIGN: 'client', DOCK: 'Chat', TITLE: 'Room' });
        mgr.createFrame('Tells', { NAME: 'Tells', ALIGN: 'client', DOCK: 'Chat', TITLE: 'Tells' });

        expect(h.tabs.get('Chat')).toEqual({
            pages: [
                { id: 'Chat', title: 'Channels' },
                { id: 'Room', title: 'Room' },
                { id: 'Tells', title: 'Tells' },
            ],
            // The first docked tab is selected; later ones arrive in the background.
            active: 'Room',
        });
        // Tab pages render inside the host frame, below its strip.
        expect(h.placed.get('Room')).toEqual({ x: 0, y: 0, width: 1000, height: 120 - MXP_TAB_BAR_HEIGHT, parent: 'Chat' });
        // A docked tab is not an edge frame — it claims no border of its own.
        expect(h.getBorders()).toEqual({ top: 120, right: 0, bottom: 0, left: 0 });
    });

    it('gives an untitled dock target a strip so it can host tabs', () => {
        mgr.createFrame('Host', { NAME: 'Host', ALIGN: 'top', HEIGHT: '120' });
        mgr.createFrame('Room', { NAME: 'Room', ALIGN: 'client', DOCK: 'Host', TITLE: 'Room' });
        expect(h.tabs.get('Host')?.pages.map(p => p.id)).toEqual(['Host', 'Room']);
    });

    it('drops a closed tab from its host strip', () => {
        mgr.createFrame('Chat', { NAME: 'Chat', ALIGN: 'top', HEIGHT: '120', TITLE: 'Channels' });
        mgr.createFrame('Room', { NAME: 'Room', ALIGN: 'client', DOCK: 'Chat', TITLE: 'Room' });
        mgr.createFrame('Room', { NAME: 'Room', ACTION: 'close' });
        expect(h.tabs.get('Chat')?.pages.map(p => p.id)).toEqual(['Chat']);
        expect(h.destroyed).toContain('Room');
    });

    it('brings a tab to the front when its frame is re-opened or focused', () => {
        mgr.createFrame('Chat', { NAME: 'Chat', ALIGN: 'top', HEIGHT: '120', TITLE: 'Channels' });
        mgr.createFrame('Room', { NAME: 'Room', ALIGN: 'client', DOCK: 'Chat', TITLE: 'Room' });
        mgr.createFrame('Tells', { NAME: 'Tells', ALIGN: 'client', DOCK: 'Chat', TITLE: 'Tells' });
        expect(h.tabs.get('Chat')?.active).toBe('Room');
        mgr.createFrame('Tells', { NAME: 'Tells', ACTION: 'focus' });
        expect(h.tabs.get('Chat')?.active).toBe('Tells');
    });

    it('lays a DOCK frame out normally when the target does not exist', () => {
        mgr.createFrame('Room', { NAME: 'Room', ALIGN: 'client', DOCK: 'Nothing', WIDTH: '200' });
        expect(h.placed.get('Room')?.parent).toBeUndefined();
        expect(h.tabs.size).toBe(0);
    });
});
