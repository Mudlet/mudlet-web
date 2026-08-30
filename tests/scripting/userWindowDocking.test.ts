// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ScriptWindowRenderData } from '../../src/ui/windows/types';

// Mudlet's Host::openWindow takes the docking area BOTH as a single letter and
// spelled out, and applies it on every call — not only the one that creates the
// dock widget. Geyser leans on both halves: a UserWindow constructor passes
// `dockPosition = "left"` verbatim, and `setDockPosition("left")` re-opens an
// already-open window purely to move it. mudix understood neither, so every
// package asking for a left dock (the Discworld Companion's character column,
// for one) got its panels stacked on the right instead.

describe('openUserWindow — docking areas', () => {
    let rt: TestRuntime;
    let latest: ScriptWindowRenderData[] = [];

    beforeAll(async () => {
        rt = await createTestRuntime();
        rt.session.windows.onWindowsChange = ws => { latest = ws; };
    });
    afterAll(() => rt.dispose());

    const dockOf = (id: string) => latest.find(w => w.id === id)?.docked;

    it('accepts the spelled-out side Geyser passes, not just the letter', () => {
        rt.run('openUserWindow("dw_left", false, true, "left")');
        expect(dockOf('dw_left')).toBe('left');
        rt.run('openUserWindow("dw_top", false, true, "t")');
        expect(dockOf('dw_top')).toBe('top');
    });

    it('re-docks a window that is already open, and floats it for "floating"', () => {
        rt.run('openUserWindow("dw_move", false, true, "right")');
        expect(dockOf('dw_move')).toBe('right');
        rt.run('openUserWindow("dw_move", false, true, "left")');
        expect(dockOf('dw_move')).toBe('left');
        rt.run('openUserWindow("dw_move", false, true, "floating")');
        expect(dockOf('dw_move')).toBeUndefined();
    });

    it('leaves placement alone when no area is given', () => {
        rt.run('openUserWindow("dw_keep", false, true, "left")');
        rt.run('openUserWindow("dw_keep")');
        expect(dockOf('dw_keep')).toBe('left');
    });

    it('docks a new window on the right when no area and no saved layout say otherwise', () => {
        rt.run('openUserWindow("dw_new")');
        expect(dockOf('dw_new')).toBe('right');
    });

    it('Geyser.UserWindow:setDockPosition moves an open window', () => {
        rt.run('gw = Geyser.UserWindow:new({name = "gw_dock", docked = true, dockPosition = "right"})');
        expect(dockOf('gw_dock')).toBe('right');
        rt.run('gw:setDockPosition("left")');
        expect(dockOf('gw_dock')).toBe('left');
    });
});
