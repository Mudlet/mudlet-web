// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createSettings } from 'mudlet-map-renderer';
import { applyMapperSettings } from '../../src/map/mapImageExport';
import { PLAYER_MARKER_DEFAULTS } from '../../src/storage/schema';

describe('applyMapperSettings — player marker', () => {
    it('leaves the renderer defaults alone when nothing is set', () => {
        const settings = createSettings();
        const before = { ...settings.playerMarker };
        applyMapperSettings(settings, { roomShape: 'circle' });
        expect(settings.playerMarker).toEqual(before);
    });

    it('mirrors the renderer defaults so the Settings modal shows real values', () => {
        const { playerMarker } = createSettings();
        expect({
            strokeColor: playerMarker.strokeColor,
            strokeAlpha: playerMarker.strokeAlpha,
            fillColor: playerMarker.fillColor,
            fillAlpha: playerMarker.fillAlpha,
            strokeWidth: playerMarker.strokeWidth,
            sizeFactor: playerMarker.sizeFactor,
            dashEnabled: playerMarker.dashEnabled,
            matchRoomShape: playerMarker.matchRoomShape,
            dashLength: playerMarker.dash?.[0],
            dashGap: playerMarker.dash?.[1],
        }).toEqual(PLAYER_MARKER_DEFAULTS);
    });

    it('forwards every field the UI can set', () => {
        const settings = createSettings();
        applyMapperSettings(settings, {
            playerMarker: {
                strokeColor: '#ff0000', strokeAlpha: 0.5,
                fillColor: '#0000ff', fillAlpha: 0.25,
                strokeWidth: 0.2, sizeFactor: 2.5,
                dashEnabled: false, matchRoomShape: true,
                dashLength: 0.1, dashGap: 0.3,
            },
        });
        expect(settings.playerMarker).toEqual({
            strokeColor: '#ff0000', strokeAlpha: 0.5,
            fillColor: '#0000ff', fillAlpha: 0.25,
            strokeWidth: 0.2, sizeFactor: 2.5,
            dashEnabled: false, matchRoomShape: true,
            dash: [0.1, 0.3],
        });
    });

    it('keeps untouched fields on the renderer default', () => {
        const settings = createSettings();
        applyMapperSettings(settings, { playerMarker: { sizeFactor: 1.2 } });
        expect(settings.playerMarker.sizeFactor).toBe(1.2);
        expect(settings.playerMarker.strokeColor).toBe(PLAYER_MARKER_DEFAULTS.strokeColor);
        expect(settings.playerMarker.dash).toEqual([
            PLAYER_MARKER_DEFAULTS.dashLength,
            PLAYER_MARKER_DEFAULTS.dashGap,
        ]);
    });

    // The two dash halves patch independently in the Settings modal, so a
    // profile can carry only one of them; the other has to fall back rather
    // than land as `undefined` inside the renderer's dash array.
    it('completes a half-set dash pair from the defaults', () => {
        const settings = createSettings();
        applyMapperSettings(settings, { playerMarker: { dashGap: 0.4 } });
        expect(settings.playerMarker.dash).toEqual([PLAYER_MARKER_DEFAULTS.dashLength, 0.4]);
    });

    // applyMapperSettings runs against a *live* renderer's settings on every
    // profile change, so it must not hand two renderers the same nested object.
    it('does not share the marker object between renderers', () => {
        const a = createSettings();
        const b = createSettings();
        applyMapperSettings(a, { playerMarker: { sizeFactor: 2 } });
        applyMapperSettings(b, { playerMarker: { sizeFactor: 3 } });
        expect(a.playerMarker.sizeFactor).toBe(2);
        expect(b.playerMarker.sizeFactor).toBe(3);
    });
});
