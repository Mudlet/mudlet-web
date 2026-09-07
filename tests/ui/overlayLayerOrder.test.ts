// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { OverlayLayerOrder } from '../../src/ui/layout/overlayLayerOrder';

// OverlayLayerOrder is a FLAT per-viewport z-order registry — the Mudlet Web
// analogue of Mudlet's Qt widget stack, where raiseWindow/lowerWindow bring a
// widget to the front/back of ALL widgets in a real console/userwindow (Geyser
// containers are Lua geometry helpers, not Qt parents, so there is no per-
// container z containment). Every widget kind — windows/mini-consoles, labels,
// command lines, scroll boxes — ranks together by most-recent raise.
describe('OverlayLayerOrder', () => {
    it('ranks untouched kinds by their historical default band (windows < labels < cmdlines < scrollboxes)', () => {
        const order = new OverlayLayerOrder();
        expect(order.getZ('main', 'windows', 'mapper')).toBeLessThan(order.getZ('main', 'labels', 'frame'));
        expect(order.getZ('main', 'labels', 'frame')).toBeLessThan(order.getZ('main', 'cmdlines', 'cl'));
        expect(order.getZ('main', 'cmdlines', 'cl')).toBeLessThan(order.getZ('main', 'scrollboxes', 'sb'));
    });

    it('a later-created label does not bury an earlier-created, never-touched-again window', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'windows', 'mapper'); // created first
        order.touch('main', 'labels', 'frame');    // created after
        expect(order.getZ('main', 'labels', 'frame')).toBeGreaterThan(order.getZ('main', 'windows', 'mapper'));
    });

    it('raising the window after sibling labels puts it back on top', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'windows', 'mapper');
        order.touch('main', 'labels', 'frame1');
        order.touch('main', 'labels', 'frame2');
        order.touch('main', 'windows', 'mapper'); // raiseWindow("mapper")
        const mapperZ = order.getZ('main', 'windows', 'mapper');
        expect(mapperZ).toBeGreaterThan(order.getZ('main', 'labels', 'frame1'));
        expect(mapperZ).toBeGreaterThan(order.getZ('main', 'labels', 'frame2'));
    });

    // Regression for the real EleUI2 bug: an opened config menu (a burst of
    // labels raised to the front) must paint ABOVE a mapper mini-console that
    // was created earlier and never re-raised. Flat ordering gives exactly
    // this; the earlier container-tree model wrongly buried the freshly-raised
    // menu beneath the mapper's own stack position.
    it('a freshly-raised burst of labels outranks an earlier, un-re-raised window (config menu over the map)', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'windows', 'mapper');            // map created early
        const menu = ['cfg1', 'cfg2', 'cfg3', 'cfg4', 'cfg5'];
        menu.forEach(n => order.touch('main', 'labels', n)); // config menu opened → each item raised
        const mapZ = order.getZ('main', 'windows', 'mapper');
        for (const n of menu) expect(order.getZ('main', 'labels', n)).toBeGreaterThan(mapZ);
    });

    it('a mini-console never explicitly raised stays below a label created after it (EMCO tab body under its own tab chrome)', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'windows', 'chatTabConsole');
        order.touch('main', 'labels', 'chatTabButton');
        expect(order.getZ('main', 'windows', 'chatTabConsole'))
            .toBeLessThan(order.getZ('main', 'labels', 'chatTabButton'));
    });

    it('one window can out-rank one label while a sibling window stays below a different label (true interleaving)', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'windows', 'winA');
        order.touch('main', 'labels', 'labelX');
        order.touch('main', 'windows', 'winB');
        order.touch('main', 'labels', 'labelY');
        const zWinA = order.getZ('main', 'windows', 'winA');
        const zLabelX = order.getZ('main', 'labels', 'labelX');
        const zWinB = order.getZ('main', 'windows', 'winB');
        const zLabelY = order.getZ('main', 'labels', 'labelY');
        expect(zWinA).toBeLessThan(zLabelX);
        expect(zLabelX).toBeLessThan(zWinB);
        expect(zWinB).toBeLessThan(zLabelY);
    });

    it('sink() lowers a widget below its siblings (lowerWindow / lowerLabel)', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'labels', 'a');
        order.touch('main', 'labels', 'b');
        order.touch('main', 'labels', 'c'); // c on top (newest)
        expect(order.getZ('main', 'labels', 'c')).toBeGreaterThan(order.getZ('main', 'labels', 'a'));
        order.sink('main', 'labels', 'c'); // lowerWindow("c")
        expect(order.getZ('main', 'labels', 'c')).toBeLessThan(order.getZ('main', 'labels', 'a'));
        expect(order.getZ('main', 'labels', 'c')).toBeLessThan(order.getZ('main', 'labels', 'b'));
    });

    it('forget() drops a destroyed widget back to the untouched fallback band', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'windows', 'mapper');
        order.touch('main', 'labels', 'frame');
        expect(order.getZ('main', 'labels', 'frame')).toBeGreaterThan(order.getZ('main', 'windows', 'mapper'));
        order.forget('main', 'labels', 'frame');
        expect(order.getZ('main', 'labels', 'frame')).toBeLessThan(order.getZ('main', 'windows', 'mapper'));
    });

    it('different parents are tracked independently', () => {
        const order = new OverlayLayerOrder();
        order.touch('main', 'labels', 'frame');
        order.touch('other', 'windows', 'mapper');
        expect(order.getZ('main', 'windows', 'mapper')).toBeLessThan(order.getZ('main', 'labels', 'frame'));
    });

    it('subscribe fires on touch and forget, and unsubscribe stops further notifications', () => {
        const order = new OverlayLayerOrder();
        let calls = 0;
        const unsub = order.subscribe('main', () => { calls++; });
        order.touch('main', 'windows', 'mapper');
        expect(calls).toBe(1);
        order.forget('main', 'windows', 'mapper');
        expect(calls).toBe(2);
        unsub();
        order.touch('main', 'windows', 'mapper');
        expect(calls).toBe(2);
    });

    // Regression: getZ() is queried once per widget on every render of a
    // viewport's overlay, and a real UI (EleUI2: ~300 label/window nodes under
    // 'main') re-renders continuously while a label is dragged — via move()'s
    // notify(), which never touches this registry. So within one drag gesture
    // the ranking never mutates and every getZ() after the first must be a
    // cache hit, not a fresh sort.
    it('getZ() stays cheap across many repeated queries with no intervening mutation (drag re-render)', () => {
        const order = new OverlayLayerOrder();
        const WIDGET_COUNT = 400;
        for (let i = 0; i < WIDGET_COUNT; i++) order.touch('main', 'labels', `label${i}`);
        for (let i = 0; i < WIDGET_COUNT; i++) order.getZ('main', 'labels', `label${i}`); // prime cache
        const start = performance.now();
        for (let frame = 0; frame < 30; frame++) {
            for (let i = 0; i < WIDGET_COUNT; i++) order.getZ('main', 'labels', `label${i}`);
        }
        const elapsedMs = performance.now() - start;
        expect(elapsedMs).toBeLessThan(200);
    });
});
