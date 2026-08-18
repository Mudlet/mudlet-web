import type { MapRenderer } from 'mudlet-map-renderer';
import { MapStore } from './MapStore';

/**
 * Map-view zoom: the two units it comes in, and the policy for opening an area.
 *
 * Two different numbers are both called "zoom", and mixing them is what made
 * maps open absurdly far in or out:
 *
 *  - **renderer zoom** — a scale multiplier; `camera.getScale() === BASE_SCALE *
 *    zoom` is the pixels drawn per map unit. Bigger = zoomed in. A pure renderer
 *    concept that only means anything paired with the current viewport size.
 *  - **Mudlet zoom** — how many map units the *shorter* viewport edge spans
 *    (T2DMap's `xyzoom`: 3 → 3 rooms across, 100 → ~100). Bigger = zoomed *out*.
 *    This is what `getMapZoom`/`setMapZoom` speak and what gets persisted into
 *    the map file, because it survives the panel being a different size in a
 *    later session.
 *
 * Everything outside the renderer is in Mudlet units; {@link toMudletZoom} and
 * {@link toRendererZoom} convert at that boundary.
 */

/** Mudlet's hard floor for the 2D map zoom (T2DMap `csmMinXYZoom`): the shorter
 *  viewport edge may never span fewer than this many map units, i.e. you can't
 *  zoom in any closer. Mirrored so wheel/pinch zoom obeys the same limit. */
export const MUDLET_MIN_MAP_ZOOM = MapStore.MIN_MAP_ZOOM;

/** Mudlet's `T2DMap::csmDefaultXYZoom` — what an area opens at when it has no
 *  remembered zoom of its own. */
export const MUDLET_DEFAULT_MAP_ZOOM = MapStore.DEFAULT_MAP_ZOOM;

/** How far past "the whole area exactly fills the panel" the user may keep
 *  zooming out. The renderer's `fitToMapBounds` ends with `minZoom = zoom`, so
 *  every `fitArea()` pins the zoom-out floor to that exact fit — the wheel then
 *  stops dead with the area flush against the panel edges, and there's no way
 *  to pull back for context or to see where an area sits relative to its
 *  surroundings. Relaxing the floor afterwards restores that headroom. */
export const ZOOM_OUT_HEADROOM = 4;

/**
 * The renderer's current view expressed in Mudlet units, or null when the camera
 * has no usable size yet.
 *
 * A panel that hasn't been laid out reports 0×0, and a "zoom" derived from that
 * is meaningless — persisting one is exactly how an area got stuck at a few
 * pixels per room on every subsequent open.
 */
export function toMudletZoom(renderer: MapRenderer): number | null {
    const cam = renderer.camera;
    const shorter = Math.min(cam.width, cam.height);
    const scale = cam.getScale(); // pixels per map unit
    if (shorter <= 0 || scale <= 0) return null;
    return shorter / scale;
}

/**
 * The renderer zoom that makes `mudletZoom` map units span the shorter viewport
 * edge, or null when the camera isn't sized (see {@link toMudletZoom}) or the
 * request isn't a positive number.
 */
export function toRendererZoom(renderer: MapRenderer, mudletZoom: number): number | null {
    const cam = renderer.camera;
    const shorter = Math.min(cam.width, cam.height);
    if (shorter <= 0 || !Number.isFinite(mudletZoom) || mudletZoom <= 0) return null;
    // Recover the renderer's pixels-per-unit-at-zoom-1 from the live camera
    // (getScale() === base * rendererZoom) rather than hardcoding the library's
    // BASE_SCALE constant, then solve for the rendererZoom that makes
    // `mudletZoom` map units fill the shorter edge.
    const curZoom = renderer.getZoom();
    const base = curZoom > 0 ? cam.getScale() / curZoom : 75;
    const z = shorter / (base * mudletZoom);
    return Number.isFinite(z) && z > 0 ? z : null;
}

/** Fit the area, then relax the floor the fit just pinned (see
 *  {@link ZOOM_OUT_HEADROOM}). Use everywhere instead of `renderer.fitArea()`. */
export function fitAreaWithHeadroom(renderer: MapRenderer): void {
    renderer.fitArea();
    renderer.minZoom = renderer.minZoom / ZOOM_OUT_HEADROOM;
}

/**
 * Open an area at its remembered zoom, or at Mudlet's default when it has none,
 * with a zoom-out floor derived from the area's actual extent.
 *
 * The fit runs first, but only for the floor it leaves behind — it is the only
 * thing that derives one from how big the area actually is. The camera's own
 * default floor is a fixed 0.05 with no relation to map size: on any map larger
 * than the viewport that sits far *above* the zoom needed to see the whole thing,
 * so opening without fitting first leaves the wheel pinned at a floor from which
 * the map can never be framed.
 *
 * The fit deliberately does NOT survive as the opening view. Mudlet never fits an
 * area to the widget — T2DMap opens at `TArea::mLast2DMapZoom`, defaulting to
 * `csmDefaultXYZoom`. Fitting produced both halves of a reported bug: a four-room
 * area fitted to roughly one room per screen (the fit of a 1×1-unit extent is
 * already past Mudlet's zoom-in limit), while a city-sized area fitted to rooms a
 * few pixels wide. A fixed unit count is scale-free and gives both the same
 * legible room size.
 */
export function applyAreaZoom(renderer: MapRenderer, savedZoom: number | null | undefined): void {
    fitAreaWithHeadroom(renderer);
    const mudletZoom = Math.max(savedZoom ?? MUDLET_DEFAULT_MAP_ZOOM, MUDLET_MIN_MAP_ZOOM);
    const rendererZoom = toRendererZoom(renderer, mudletZoom);
    // No usable viewport yet: leave the fit in place and let the caller's resize
    // re-apply redo this once the panel has real dimensions.
    if (rendererZoom == null) return;
    // Keep whichever floor is more permissive. For a big area that's the fit
    // (you can frame the whole thing and then some); for a small one the fit is
    // *above* the zoom we're opening at — a four-room area fits in far less than
    // 20 units — which would leave the wheel pinned at the opening view with no
    // zoom-out travel at all. Deriving the floor from the opening zoom too gives
    // the same headroom either way.
    renderer.minZoom = Math.min(renderer.minZoom, rendererZoom / ZOOM_OUT_HEADROOM);
    renderer.setZoom(rendererZoom);
}
