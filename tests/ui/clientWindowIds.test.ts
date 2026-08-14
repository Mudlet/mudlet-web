import { describe, it, expect } from 'vitest';
import { WindowManager } from '../../src/ui/windows/WindowManager';
import {
    MAP_WIDGET_ID, MAPPER_WIDGET_ID, mapViewWindowId, migrateClientWindowHints,
} from '../../src/ui/windows/types';

// Windows the client owns sit in their own id namespace, because `open()` reuses
// an existing id whatever its kind: without the split, a script calling
// openUserWindow("map") — or a MUD declaring an MXP <FRAME map> — takes over the
// toolbar's mapper, and the two then silently break each other.

describe('client-owned window ids', () => {
    it('cannot be produced by a script or an MXP frame name', () => {
        // Lua passes a bare name through and MXP frame names are restricted to
        // alphanumerics, `_` and `-`, so neither can contain the separator.
        for (const id of [MAP_WIDGET_ID, MAPPER_WIDGET_ID, mapViewWindowId(1)]) {
            expect(id).toContain(':');
            expect(/^[a-zA-Z0-9_-]+$/.test(id)).toBe(false);
        }
    });

    it('keeps a script window called "map" separate from the map widget', () => {
        const wm = new WindowManager();
        wm.open(MAP_WIDGET_ID, { kind: 'map', title: 'Map' });
        wm.open('map', { kind: 'text', title: 'map' });

        expect(wm.has(MAP_WIDGET_ID)).toBe(true);
        expect(wm.has('map')).toBe(true);
        // The script's window is a text console, not the mapper reused under a
        // second name — that is what made writes to it silently no-op.
        expect(wm.getGeometry('map')).not.toBeNull();

        // …and closing the script's window leaves the mapper standing.
        wm.close('map');
        expect(wm.has('map')).toBe(false);
        expect(wm.has(MAP_WIDGET_ID)).toBe(true);
    });

    it('keeps a script window called "mapper" separate from the embedded mapper', () => {
        const wm = new WindowManager();
        wm.open(MAPPER_WIDGET_ID, { kind: 'map', title: 'Mapper' });
        wm.open('mapper', { kind: 'text', title: 'mapper' });
        wm.close('mapper');
        expect(wm.has(MAPPER_WIDGET_ID)).toBe(true);
    });
});

describe('migrateClientWindowHints', () => {
    it('carries a pre-prefix map hint over, so a saved layout survives', () => {
        const hint = { docked: 'right' as const, width: 400, height: 300, autoOpen: true };
        const out = migrateClientWindowHints({ map: hint, Chat: { width: 100 } });
        expect(out[MAP_WIDGET_ID]).toEqual(hint);
        expect(out.map).toBeUndefined();
        expect(out.Chat).toEqual({ width: 100 });
    });

    it('leaves a script window named "map" alone once the widget has its own hint', () => {
        const widget = { width: 400 };
        const script = { width: 100 };
        const out = migrateClientWindowHints({ map: script, [MAP_WIDGET_ID]: widget });
        expect(out[MAP_WIDGET_ID]).toEqual(widget);
        expect(out.map).toEqual(script);
    });

    it('is a no-op when there is nothing to migrate', () => {
        const hints = { Chat: { width: 100 } };
        expect(migrateClientWindowHints(hints)).toBe(hints);
    });
});
