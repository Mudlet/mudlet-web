import type {
    CircleShape,
    MapState,
    SceneOverlay,
    SceneOverlayContext,
    Shape,
    ViewportBounds,
} from 'mudlet-map-renderer';
import type {MapStore} from './MapStore';
import type {MudletMapReader} from './MudletMapReader';

/**
 * Map-room selection overlay backing Mudlet `getMapSelection` /
 * `clearMapSelection`. Selected rooms get a translucent yellow ring; the
 * selection's center room (the most recently single-clicked room, also what
 * Mudlet returns as `.center`) gets a thicker, brighter ring on top.
 *
 * Mudlet doesn't expose the exact pen colours scripts can rely on, so the
 * palette is tuned to read clearly over the existing room-fill / highlight
 * stack without depending on profile background colour.
 */
const SELECTION_COLOR = '#ffee55';
const SELECTION_CENTER_COLOR = '#ffffff';
const SELECTION_ALPHA = 0.9;
// Ring sits just outside the room footprint so the underlying room glyph
// (symbol / env colour) stays readable.
const SELECTION_RING_FACTOR = 0.85;
const SELECTION_CENTER_RING_FACTOR = 1.05;

export class MapSelectionOverlay implements SceneOverlay {
    private ctx?: SceneOverlayContext;
    private mapStoreUnsub?: () => void;
    private areaHandler?: () => void;

    constructor(
        private readonly mapStore: MapStore,
        private readonly reader: MudletMapReader,
    ) {}

    attach(ctx: SceneOverlayContext): void {
        this.ctx = ctx;
        // Selection rides its own subscribe channel so single-click repaints
        // don't drag MudletMapReader through a snapshot rebuild on every click.
        this.mapStoreUnsub = this.mapStore.subscribeSelection(() => ctx.invalidate());
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

    render(state: MapState, _bounds: ViewportBounds): Shape[] | void {
        const {currentArea, currentZIndex} = state;
        if (currentArea === undefined || currentZIndex === undefined) return;
        const center = this.mapStore.getSelectionCenter();
        const shapes: Shape[] = [];
        const ringRadius = SELECTION_RING_FACTOR / 2;
        const centerRingRadius = SELECTION_CENTER_RING_FACTOR / 2;
        for (const id of this.collectSelected()) {
            const room = this.reader.getRoom(id);
            if (!room || room.area !== currentArea || room.z !== currentZIndex) continue;
            shapes.push({
                type: 'circle',
                cx: room.x,
                cy: room.y,
                radius: ringRadius,
                paint: {
                    stroke: SELECTION_COLOR,
                    strokeWidth: 0.08,
                    alpha: SELECTION_ALPHA,
                },
            } satisfies CircleShape);
            if (id === center) {
                shapes.push({
                    type: 'circle',
                    cx: room.x,
                    cy: room.y,
                    radius: centerRingRadius,
                    paint: {
                        stroke: SELECTION_CENTER_COLOR,
                        strokeWidth: 0.05,
                        alpha: SELECTION_ALPHA,
                        dash: [0.15, 0.1],
                        dashEnabled: true,
                    },
                } satisfies CircleShape);
            }
        }
        return shapes;
    }

    private collectSelected(): number[] {
        return this.mapStore.getMapSelection().rooms;
    }
}
