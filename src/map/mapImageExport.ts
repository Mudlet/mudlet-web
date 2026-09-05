import { MapRenderer, createSettings, PngBytesExporter } from 'mudlet-map-renderer';
import type { RoomLens, Settings as MapRendererSettings } from 'mudlet-map-renderer';
import { MudixMapReader } from './MudixMapReader';
import type { MapStore } from './MapStore';
// Pulled straight from the schema module rather than the ../storage barrel:
// the barrel also re-exports the Zustand store, and this file is loaded by the
// headless export path where dragging that in would be a needless cycle risk.
import { PLAYER_MARKER_DEFAULTS, symbolFontSource, type MapperSettings } from '../storage/schema';

/**
 * One profile-supplied font family as a CSS string literal, safe to concatenate
 * into a `font-family` list.
 *
 * The backslash must be escaped *before* the quote, and escaping the quote
 * alone is worse than not escaping at all. Take a family ending in a single
 * backslash: quote-only escaping emits `'Foo\'`, whose closing quote is now
 * itself escaped, so the literal never terminates and the rest of the
 * declaration is swallowed as string content. Doubling the backslash first
 * gives `'Foo\\'`, which closes properly around one literal backslash.
 * (CodeQL alert 23 caught the original, which escaped only the quote.)
 *
 * Line terminators cannot appear in a CSS string at all, escaped or not, so
 * they are dropped rather than encoded. The value reaches the renderer's canvas
 * `font` shorthand today, where a malformed string merely fails to parse — but
 * it is a profile field a package can set through the mapper settings, and the
 * next consumer might be a stylesheet.
 */
export function cssFontFamilyLiteral(family: string): string {
    const escaped = family
        .replace(/[\r\n\f]/g, '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
    return `'${escaped}'`;
}

/** The bundled room-symbol font. Mudlet's default too, and the reason it has one:
 *  a generic family picks a different glyph shape per operating system, so the
 *  same map looks different on each machine. */
export const BUNDLED_SYMBOL_FONT = 'Bitstream Vera Sans Mono';

/**
 * The CSS `font-family` room symbols are drawn with — the profile's chosen font
 * first, the bundled one behind it, so a family this device does not have still
 * lands somewhere sensible.
 *
 * One function because three places have to agree on the answer: the renderer,
 * the map image export that configures it, and the symbol-usage report, which
 * would be lying if it drew a symbol in a different font from the map.
 */
export function mapSymbolFontStack(mapper: MapperSettings | undefined): string {
    const font = symbolFontSource(mapper?.symbolFont);
    return font
        ? `${cssFontFamilyLiteral(font.family)}, '${BUNDLED_SYMBOL_FONT}', sans-serif`
        : `'${BUNDLED_SYMBOL_FONT}', sans-serif`;
}

/**
 * Copy user-set fields from MapperSettings onto a live renderer settings
 * object. Anything left undefined in `mapper` is intentionally not touched
 * so the renderer's own createSettings() defaults stay in effect.
 */
export function applyMapperSettings(target: MapRendererSettings, mapper: MapperSettings | undefined): void {
    // Mudlet's 2D map renders on an OPAQUE BLACK background (the renderer's own
    // default). Honour that rather than a transparent canvas: transparency made
    // the map composite over whatever was behind it, so a map opened into a user
    // window showed the page/window through it. A user-picked colour in the
    // Mapper tab still wins.
    target.backgroundColor = mapper?.backgroundColor ?? '#000000';
    // Mudlet draws room symbols (and, in mudix, the area-name header) with
    // `mMapSymbolFont` — bundled "Bitstream Vera Sans Mono" by default, and
    // changeable from its Mapper page ("2D Map Room Symbol Font"). That default
    // matters: the renderer's own is a generic 'sans-serif', which picks a
    // different glyph shape per-OS for Unicode room-symbol characters. A
    // profile that has chosen a font wins, and keeps the bundled one as the
    // fallback so an unavailable family still lands somewhere sensible.
    target.fontFamily = mapSymbolFontStack(mapper);
    // Level-of-detail: on unless the user turns it off. The renderer defaults it
    // off for back-compat, but every tier only engages above ~12k rooms on the
    // drawn plane — a density where the full vector scene costs seconds per
    // rebuild. Budgets fall through to the renderer's own defaults when unset.
    target.lodEnabled = mapper?.lodEnabled ?? true;
    if (mapper?.lodRoomBudget !== undefined) target.lodRoomBudget = mapper.lodRoomBudget;
    if (mapper?.lodExitBudget !== undefined) target.lodExitBudget = mapper.lodExitBudget;
    // The hit-test budget is measured against the rooms a plane materialises,
    // which for MudixMapReader (viewport-virtualized) is the visible slice —
    // so it behaves as designed: picking drops out only while enough rooms are
    // on screen to make the index expensive, and zooming in brings it back.
    if (mapper?.lodHitTestBudget !== undefined) target.lodHitTestBudget = mapper.lodHitTestBudget;
    if (!mapper) return;
    if (mapper.roomSize !== undefined) target.roomSize = mapper.roomSize;
    if (mapper.roomShape !== undefined) target.roomShape = mapper.roomShape;
    if (mapper.borders !== undefined) target.borders = mapper.borders;
    if (mapper.lineWidth !== undefined) target.lineWidth = mapper.lineWidth;
    if (mapper.lineColor !== undefined) target.lineColor = mapper.lineColor;
    if (mapper.gridEnabled !== undefined) target.gridEnabled = mapper.gridEnabled;
    if (mapper.gridColor !== undefined) target.gridColor = mapper.gridColor;
    if (mapper.gridLineWidth !== undefined) target.gridLineWidth = mapper.gridLineWidth;

    // playerMarker is a nested object rather than a flat key, so copy it before
    // writing: createSettings() hands out a fresh one per renderer, but this
    // function also runs against a live renderer's settings on every profile
    // change, and replacing the object wholesale keeps that assignment atomic.
    const pm = mapper.playerMarker;
    if (pm) {
        const marker = { ...target.playerMarker };
        if (pm.strokeColor !== undefined) marker.strokeColor = pm.strokeColor;
        if (pm.strokeAlpha !== undefined) marker.strokeAlpha = pm.strokeAlpha;
        if (pm.fillColor !== undefined) marker.fillColor = pm.fillColor;
        if (pm.fillAlpha !== undefined) marker.fillAlpha = pm.fillAlpha;
        if (pm.strokeWidth !== undefined) marker.strokeWidth = pm.strokeWidth;
        if (pm.sizeFactor !== undefined) marker.sizeFactor = pm.sizeFactor;
        if (pm.dashEnabled !== undefined) marker.dashEnabled = pm.dashEnabled;
        if (pm.matchRoomShape !== undefined) marker.matchRoomShape = pm.matchRoomShape;
        // The two halves patch independently in the UI, so rebuild the pair
        // whenever either is set and let the other fall back to the default.
        if (pm.dashLength !== undefined || pm.dashGap !== undefined) {
            marker.dash = [
                pm.dashLength ?? PLAYER_MARKER_DEFAULTS.dashLength,
                pm.dashGap ?? PLAYER_MARKER_DEFAULTS.dashGap,
            ];
        }
        target.playerMarker = marker;
    }
}

/**
 * Mudlet `exportAreaImage` — render one area (optionally a single z-level) to
 * PNG bytes. Returns null when the area is unknown or the render fails.
 *
 * Deliberately standalone: the export builds its own reader, settings and
 * off-screen container, so it never touches — or needs — a mounted map panel.
 * The live panel's reader is scoped to the camera's viewport (that is what
 * keeps big maps fast), so an export driven through it would contain only the
 * rooms currently on screen; and requiring a panel would make the API
 * unreachable from a script that runs before React has mounted one. (Mudlet
 * does require its mapper open, but that is a Qt artefact of where its
 * renderer lives, not part of the API's meaning.)
 *
 * The off-screen container only exists to give the Konva backend real
 * dimensions so getAreaBounds can resolve an aspect ratio.
 */
export function exportAreaImage(
    mapStore: MapStore,
    mapper: MapperSettings | undefined,
    areaId: number,
    zLevel?: number,
): Uint8Array | null {
    // Ask the store first: MudixMapReader synthesises an empty area rather than
    // failing for an id it doesn't know, which would export a blank PNG instead
    // of reporting the bad areaID.
    if (!mapStore.hasArea(areaId)) return null;
    const reader = new MudixMapReader(mapStore);
    let area;
    try { area = reader.getArea(areaId); } catch { return null; }
    if (!area) return null;
    const levels = area.getZLevels().slice().sort((a, b) => a - b);
    const z = (zLevel != null && levels.includes(zLevel))
        ? zLevel
        : levels.includes(0) ? 0 : (levels[0] ?? 0);
    const offscreen = document.createElement('div');
    offscreen.style.cssText = 'position:fixed;left:-100000px;top:0;width:1200px;height:900px;pointer-events:none;';
    document.body.appendChild(offscreen);
    const settings = createSettings();
    settings.areaName = false;
    settings.highlightCurrentRoom = false;
    applyMapperSettings(settings, mapper);
    // An export is a one-shot render of the whole area at a fixed size, not an
    // interactive scene — always draw it at full vector detail rather than
    // handing back a raster overview of a dense plane.
    settings.lodEnabled = false;
    const headless = new MapRenderer(reader, settings, offscreen);
    try {
        // Mirror viewing-mode hidden-room filtering so the export matches what
        // the on-screen map shows (editing mode reveals all rooms).
        const exportLens: RoomLens = {
            isVisible: (room) =>
                mapStore.getMapMode() === 'editing' || !mapStore.isRoomHidden(room.id),
            getExitTreatment: (_exit, a, b) => {
                if (mapStore.getMapMode() === 'editing') return 'full';
                return (mapStore.isRoomHidden(a.id) || mapStore.isRoomHidden(b.id)) ? 'hidden' : 'full';
            },
            getVersion: () => mapStore.getHiddenVersion(),
        };
        headless.setLens(exportLens);
        headless.drawArea(areaId, z);
        // Mudlet renders at a fixed 2.0x zoom; the exporter fits the whole area
        // into width×height, so this picks a resolution-per-map-unit and an
        // aspect ratio from the area bounds, clamped to a sane max.
        const b = headless.getAreaBounds();
        const PX_PER_UNIT = 48;
        const PAD = 3;
        const spanX = b ? Math.max(1, b.maxX - b.minX) : 12;
        const spanY = b ? Math.max(1, b.maxY - b.minY) : 12;
        const width = Math.min(8192, Math.max(128, Math.round((spanX + PAD * 2) * PX_PER_UNIT)));
        const height = Math.min(8192, Math.max(128, Math.round((spanY + PAD * 2) * PX_PER_UNIT)));
        return headless.export(new PngBytesExporter({ width, height, padding: PAD })) ?? null;
    } catch (err) {
        console.warn('[mapImageExport] exportAreaImage failed:', err);
        return null;
    } finally {
        headless.destroy();
        offscreen.remove();
    }
}
