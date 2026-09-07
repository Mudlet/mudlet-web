import type {
    CircleShape,
    MapState,
    RadialGradient,
    SceneOverlay,
    SceneOverlayContext,
    Shape,
    ViewportBounds,
} from 'mudlet-map-renderer';
import type {MapStore, RoomHighlight} from './MapStore';
import type {MudletMapReader} from './MudletMapReader';

/**
 * Mudlet-style room highlight overlay. Registered with the renderer via
 * `addSceneOverlay`, so it's engine-agnostic and also appears in SVG/PNG
 * exports.
 *
 * Mudlet (T2DMap::drawRoom) draws each highlight as a `QRadialGradient`
 * ellipse with radius `highlightRadius * roomWidth / 2`, stops at offset 0
 * for `color2 = (r2,g2,b2,a2)` and offset 0.85 for `color1 = (r1,g1,b1,a1)`,
 * and a transparent pen. So the *inner* colour is r2/g2/b2/a2 and the
 * *outer* colour is r1/g1/b1/a1 — the API parameter order is counter to the
 * usual intuition. There's no transparent stop at offset 1.0, so the disc
 * has a flat color1 outer ring rather than fading to nothing.
 *
 * The renderer's built-in `renderHighlight(id, color)` takes a single solid
 * colour and discards the gradient — this overlay replaces it so scripts
 * that pass real (r1,g1,b1, r2,g2,b2, a1, a2, radius) tuples render the way
 * Mudlet draws them.
 */
const OUTER_STOP = 0.85;

export class MudletHighlightOverlay implements SceneOverlay {
    private ctx?: SceneOverlayContext;
    private mapStoreUnsub?: () => void;
    private areaHandler?: () => void;

    constructor(
        private readonly mapStore: MapStore,
        private readonly reader: MudletMapReader,
    ) {}

    attach(ctx: SceneOverlayContext): void {
        this.ctx = ctx;
        // Use the dedicated highlight channel so highlightRoom / unHighlightRoom
        // calls don't drag MudletMapReader and MapPanel.syncFromStore through a
        // full snapshot rebuild on every script-driven update (the per-move
        // speedwalk hot path). Area / level switches still flow through
        // MapState's 'area' event for the area-filtering reset.
        this.mapStoreUnsub = this.mapStore.subscribeHighlights(() => ctx.invalidate());
        this.areaHandler = () => ctx.invalidate();
        ctx.state.events.on('area', this.areaHandler);
    }

    detach(): void {
        this.mapStoreUnsub?.();
        if (this.areaHandler && this.ctx) {
            this.ctx.state.events.off('area', this.areaHandler);
        }
        this.ctx = undefined;
    }

    /** Force a re-render from outside. The renderer's `refresh()` doesn't
     *  emit any state event we listen to, but a change to settings.roomSize
     *  moves every highlight circle's radius. */
    refresh(): void {
        this.ctx?.invalidate();
    }

    render(state: MapState, _bounds: ViewportBounds): Shape[] | void {
        const {currentArea, currentZIndex} = state;
        if (currentArea === undefined || currentZIndex === undefined) return;
        const shapes: Shape[] = [];
        for (const [roomId, hl] of this.mapStore.getRoomHighlights()) {
            const room = this.reader.getRoom(roomId);
            if (!room || room.area !== currentArea || room.z !== currentZIndex) continue;
            // Highlight radius is in world/grid units, not in render-room
            // units — radius=1 means "as big as a 1×1 grid cell" regardless
            // of the user's settings.roomSize. radius=3 spans three cells.
            const radiusFactor = hl.radius > 0 ? hl.radius : 1;
            const radius = radiusFactor / 2;
            shapes.push({
                type: 'circle',
                cx: room.x,
                cy: room.y,
                radius,
                paint: {fill: buildGradient(room.x, room.y, radius, hl)},
            } satisfies CircleShape);
        }
        return shapes;
    }
}

function buildGradient(cx: number, cy: number, r: number, hl: RoomHighlight): RadialGradient {
    return {
        type: 'radial',
        cx,
        cy,
        r,
        stops: [
            // Inner: color2 (r2,g2,b2,a2) at offset 0.
            {offset: 0, color: `rgba(${hl.r2}, ${hl.g2}, ${hl.b2}, ${(hl.a2 / 255).toFixed(3)})`},
            // Outer: color1 (r1,g1,b1,a1) at 0.85; Qt extrapolates flat to 1.0.
            {offset: OUTER_STOP, color: `rgba(${hl.r1}, ${hl.g1}, ${hl.b1}, ${(hl.a1 / 255).toFixed(3)})`},
        ],
    };
}
