import { useEffect, useRef } from 'react';
import { MapRenderer, MapReader, createSettings } from 'mudlet-map-renderer';
import { applyMapperSettings } from '../map/mapImageExport';
import { MAPPER_DEFAULTS, PLAYER_MARKER_DEFAULTS, type MapperSettings } from '../storage';

// Same trick MudixMapReader uses: the renderer's `MapData.*` types live in a
// global namespace the package doesn't re-export by name, so derive the shapes
// from MapReader's constructor instead of naming them.
type PreviewMap = ConstructorParameters<typeof MapReader>[0];
type PreviewEnvs = ConstructorParameters<typeof MapReader>[1];
type PreviewArea = PreviewMap[number];
type PreviewRoom = PreviewArea['rooms'][number];

/** The room the marker is pinned to — the centre of the plus below. */
const PREVIEW_ROOM_ID = 1;

/** One env, one neutral grey. A preview is not a real map, and a saturated
 *  room colour would fight whatever marker colour the user is picking. */
const PREVIEW_ENV = 1;
const PREVIEW_ENVS = [{ envId: PREVIEW_ENV, colors: [125, 125, 125] }] as PreviewEnvs;

/** Rooms carry far more fields than a preview needs, and the renderer only
 *  reads the geometry/exit/appearance ones. Fill the rest with empty values so
 *  the object is structurally a room rather than a cast over a hole. */
function previewRoom(id: number, x: number, y: number, exits: Record<string, number>): PreviewRoom {
    return {
        id, area: 1, areaId: '1', x, y, z: 0,
        weight: 1, roomChar: '', name: '',
        userData: {}, customLines: {}, stubs: [], hash: '',
        env: PREVIEW_ENV,
        // MapData types `exits` as a total Record over all twelve directions,
        // but the renderer only tests truthiness per key (and MapStore itself
        // omits absent exits), so a partial object is the real-world shape.
        exits: exits as PreviewRoom['exits'],
        doors: {}, specialExits: {},
    };
}

/** A plus: one centre room to carry the marker, four neighbours so exit lines
 *  are visible in the preview and the marker's size reads against real
 *  spacing. */
const PREVIEW_MAP: PreviewMap = [{
    areaName: 'Preview',
    areaId: '1',
    labels: [],
    rooms: [
        previewRoom(1, 0, 0, { north: 2, south: 3, east: 4, west: 5 }),
        previewRoom(2, 0, 1, { south: 1 }),
        previewRoom(3, 0, -1, { north: 1 }),
        previewRoom(4, 1, 0, { west: 1 }),
        previewRoom(5, -1, 0, { east: 1 }),
    ],
}];

/** Breathing room around the framed scene, in pixels. */
const FRAME_PADDING_PX = 10;

/** Distance from the centre room to the far edge of a neighbour, in map units,
 *  before room size is added — the plus reaches one room in each direction. */
const PREVIEW_REACH = 2;

/**
 * Zoom and centre the stub map so it fills the preview box.
 *
 * Deliberately not `renderer.fitArea()`: that pads the fitted bounds by a
 * fixed 4 world units, which is proportionate for a real area and swamps a
 * five-room one — the plus ends up at roughly 40% of the box, too small to
 * judge a dash pattern by.
 */
function framePreview(renderer: MapRenderer, container: HTMLDivElement, mapper: MapperSettings | undefined) {
    const box = Math.min(container.clientWidth, container.clientHeight);
    if (box <= 0) return;
    const roomSize = mapper?.roomSize ?? MAPPER_DEFAULTS.roomSize;
    const sizeFactor = mapper?.playerMarker?.sizeFactor ?? PLAYER_MARKER_DEFAULTS.sizeFactor;
    // The outermost thing drawn is either a neighbour room or the marker on the
    // centre one, whichever reaches further — at a big sizeFactor the marker
    // wins, and framing on the rooms alone would clip it.
    const span = Math.max(PREVIEW_REACH + roomSize, roomSize * sizeFactor);
    const camera = renderer.camera;
    // BASE_SCALE — pixels per world unit at zoom 1 — isn't re-exported from the
    // package root, so read it off the camera instead of hardcoding it.
    const baseScale = camera.zoom > 0 ? camera.getScale() / camera.zoom : 75;
    renderer.setZoom(Math.max(box - FRAME_PADDING_PX * 2, 1) / (span * baseScale));
    renderer.centerOn(PREVIEW_ROOM_ID, true);
}

interface PlayerMarkerPreviewProps {
    /** The profile's live mapper settings — the preview honours all of them
     *  (room shape/size, borders, exit colour, background, grid), not just the
     *  marker, so what it shows is what the map will look like. */
    mapper: MapperSettings | undefined;
}

/**
 * Live preview of the player-position marker, rendered by the *actual*
 * `MapRenderer` against a five-room stub map.
 *
 * Deliberately not a hand-drawn SVG mock: the marker's geometry (size relative
 * to `roomSize`, dash phase, the rect/circle switch driven by `matchRoomShape`
 * + `roomShape`, the rounded-rectangle corner radius) all lives in the
 * renderer, and a reimplementation here would drift silently the first time
 * the library changes it. Konva is already in the bundle for MapPanel, so this
 * costs a stage, not a chunk.
 */
export function PlayerMarkerPreview({ mapper }: PlayerMarkerPreviewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<MapRenderer | null>(null);
    // Held in a ref so the construction effect can read the current settings
    // without listing `mapper` as a dependency (which would rebuild the stage
    // on every slider tick).
    const mapperRef = useRef(mapper);
    mapperRef.current = mapper;
    /** The box size the renderer has been told about, so the catch-up below
     *  fires on a real change rather than on every render. */
    const syncedSizeRef = useRef('');

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const settings = createSettings();
        settings.areaName = false;
        // The marker here is driven explicitly via updatePositionMarker; the
        // renderer's own current-room highlight is a separate overlay that
        // MapPanel also leaves off.
        settings.highlightCurrentRoom = false;
        settings.instantMapMove = true;
        applyMapperSettings(settings, mapperRef.current);
        let renderer: MapRenderer;
        try {
            renderer = new MapRenderer(new MapReader(PREVIEW_MAP, PREVIEW_ENVS), settings, container);
        } catch {
            // A preview is never worth taking the Settings modal down over.
            return;
        }
        rendererRef.current = renderer;
        renderer.drawArea(1, 0);
        renderer.updatePositionMarker(PREVIEW_ROOM_ID);
        framePreview(renderer, container, mapperRef.current);
        return () => {
            rendererRef.current = null;
            renderer.destroy();
        };
    }, []);

    // The settings dialog mounts every card and hides the ones that are not on
    // the page being shown, so the preview is normally built into a 0×0
    // container and only gets a size when the Mapper page is opened — by which
    // time the Konva stage has been sized to nothing and framePreview()'s
    // `box <= 0` bail has left the scene unframed, i.e. a blank box.
    //
    // Both are fixed by the `resize` the renderer listens for on its container,
    // which is what sizes the stage and the camera the zoom math reads. The
    // dialog re-renders whenever the page it shows changes, so catching up here
    // is enough, and is a good deal more predictable than a ResizeObserver on an
    // element that spends most of its life with no box at all.
    // Deliberately no dependency list: this runs after every render, which is
    // when the box may have gained or changed size, and does nothing unless it
    // actually did.
    useEffect(() => {
        const container = containerRef.current;
        const renderer = rendererRef.current;
        if (!container || !renderer) return;
        const size = `${container.clientWidth}x${container.clientHeight}`;
        if (container.clientWidth <= 0 || container.clientHeight <= 0 || size === syncedSizeRef.current) return;
        syncedSizeRef.current = size;
        container.dispatchEvent(new Event('resize'));
        framePreview(renderer, container, mapperRef.current);
    });

    useEffect(() => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        applyMapperSettings(renderer.settings, mapper);
        renderer.refresh();
        renderer.updateBackground();
        // The marker is an overlay rather than part of the room scene, so
        // refresh() alone would leave it drawn in the previous style.
        renderer.refreshCurrentRoomOverlay();
        // Room size and marker size both change how much world the scene
        // covers, so re-frame rather than letting it grow out of the box.
        if (containerRef.current) framePreview(renderer, containerRef.current, mapper);
    }, [mapper]);

    return (
        <div
            className="marker-preview"
            ref={containerRef}
            role="img"
            aria-label="Preview of the player marker on a sample map"
        />
    );
}
