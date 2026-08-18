import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapRenderer, createSettings } from 'mudlet-map-renderer';
import type { AreaExitClickEventDetail, LodEventDetail, RoomClickEventDetail, RoomContextMenuEventDetail, RoomLens } from 'mudlet-map-renderer';
import type { WindowManager, MapControl, MapLoadProgress } from '../WindowManager';
import type { MapEventEntry, MapInfoResult, MapInfoContributor, MapStore } from '../../../map/MapStore';
import { MudixMapReader } from '../../../map/MudixMapReader';
import {
    MUDLET_MIN_MAP_ZOOM, applyAreaZoom, fitAreaWithHeadroom, toMudletZoom, toRendererZoom,
} from '../../../map/mapZoom';
import { applyMapperSettings, exportAreaImage } from '../../../map/mapImageExport';
import { MudletHighlightOverlay } from '../../../map/MudletHighlightOverlay';
import { MapSelectionOverlay } from '../../../map/MapSelectionOverlay';
import { useAppStore, selectProfileField, MAP_INFO_BG_DEFAULT, type MapperSettings, type MapInfoBgColor } from '../../../storage';
import { MapEditorModal } from '../../MapEditorModal';
import { useFileSource, type PickedFile } from '../../components';
import type { ProfileVFS } from '../../../scripting/vfs/ProfileVFS';
import { QT_OBJECT_NAMES } from '../../labels/qtCss';


type MapStatus = 'loading' | 'empty' | 'ready' | 'error';

/** Center the 2D view when an area is opened without the player in it. Mudlet
 *  (T2DMap::switchArea) centers on the room nearest the centroid of the most-
 *  populated z-level — never the bounding-box midpoint, which can sit on empty
 *  space for sparse / L-shaped areas. We mirror that via MapStore and center on
 *  that room. Falls back to the bbox midpoint (then origin) only when the area
 *  has no rooms to anchor on. */
function centerOnArea(renderer: MapRenderer, mapStore: MapStore): void {
    const areaId = renderer.state.currentArea;
    const centerRoom = areaId != null
        ? mapStore.getAreaCenterRoomId(areaId, renderer.state.currentZIndex)
        : null;
    if (centerRoom != null) {
        renderer.centerOn(centerRoom);
        return;
    }
    const b = renderer.getAreaBounds();
    if (b) renderer.camera.panToMapPoint((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    else renderer.camera.panToMapPoint(0, 0);
}

/** Open an area for the first time: apply its saved zoom (or Mudlet's default
 *  when it has none — see {@link applyAreaZoom}), then center on the current
 *  room. Mudlet loads the map centered on the player
 *  room — or, with no known location, a fallback room it paints the marker on
 *  anyway (room 1, T2DMap::paintEvent / switchArea). When that marker room is in
 *  this area we center on it; otherwise on the area centroid via
 *  {@link centerOnArea}. Shared by the first sync and the late layout re-apply. */
/**
 * Push the panel's real pixel size into the renderer's camera, and report
 * whether the camera now has a usable one.
 *
 * The library sizes its Konva stage from a ResizeObserver of its own, but the
 * *camera* — which every zoom and fit calculation reads — is only updated when
 * the container emits a `resize` event, so the panel has to say so. Skipping
 * that leaves a camera reporting 0x0 while the map draws at full size, and
 * every fit computed against it collapses to the `Math.max(1, width)` floor
 * inside `computeFitZoom`: a zoom-out limit thousands of map units wide, and a
 * garbage opening view.
 */
function syncCameraSize(renderer: MapRenderer, el: HTMLElement | null): boolean {
    if (el && el.clientWidth > 0 && el.clientHeight > 0) el.dispatchEvent(new Event('resize'));
    return toMudletZoom(renderer) != null;
}

function applyInitialView(renderer: MapRenderer, mapStore: MapStore, areaId: number): void {
    applyAreaZoom(renderer, mapStore.getAreaZoom(areaId));
    const markerRoom = mapStore.getPlayerRoom() ?? mapStore.getFallbackRoomId();
    if (markerRoom != null && mapStore.getRoomArea(markerRoom) === areaId) {
        renderer.centerOn(markerRoom, true);
    } else {
        centerOnArea(renderer, mapStore);
    }
}

interface MapPanelProps {
    id: string;
    manager: WindowManager;
    connectionId: string;
    /** Lets "Load map…" read a .dat/.xml the profile already holds. */
    vfs?: ProfileVFS | null;
}

export function MapPanel({ id, manager, connectionId, vfs = null }: MapPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<MapRenderer | null>(null);
    const readerRef = useRef<MudixMapReader | null>(null);
    const highlightOverlayRef = useRef<MudletHighlightOverlay | null>(null);
    const selectionOverlayRef = useRef<MapSelectionOverlay | null>(null);
    const prevWidthRef = useRef<number>(0);
    const needsFitRef = useRef<boolean>(false);
    // Tracks the MapStore.hiddenVersion last applied to the renderer so the
    // store-change subscription can force a renderer.refresh() when the only
    // thing that changed was the hidden-room set — syncFromStore's
    // sceneUnchanged guard would otherwise skip the redraw.
    const lastHiddenVersionRef = useRef<number>(0);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const levelDropdownRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<MapStatus>('loading');
    const [errorMsg, setErrorMsg] = useState('');
    // Latest level-of-detail decision from the renderer. Null until the first
    // scene build, and only surfaced in the UI once detail is actually being
    // dropped — see the `lod` subscription below.
    const [lod, setLod] = useState<LodEventDetail | null>(null);
    // Streamed map-load progress, published by WindowManager. Null when no load
    // is running.
    const [loadProgress, setLoadProgress] = useState<MapLoadProgress | null>(null);
    const [areas, setAreas] = useState<Array<{ id: number; name: string }>>([]);
    const [currentArea, setCurrentArea] = useState<number | null>(null);
    const [levels, setLevels] = useState<number[]>([]);
    const [currentLevel, setCurrentLevel] = useState<number>(0);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [levelDropdownOpen, setLevelDropdownOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        roomId: number;
        // Whether the cursor was over a real room when the menu opened. False
        // for a right-click on empty map space, where roomId falls back to the
        // selection center (or -1) and room-specific built-ins are suppressed.
        hasRoom: boolean;
        items: MapEventEntry[];
    } | null>(null);
    const [mapInfos, setMapInfos] = useState<MapInfoResult[]>([]);
    const [editorOpen, setEditorOpen] = useState(false);
    // The GMCP Client.Map (MMP) map URL — gates the "download map from game"
    // affordances, like Mudlet's mapper Download button (dlgMapper::canDownload).
    const [mmpMapUrl, setMmpMapUrl] = useState(() => manager.mmpMapLocation);
    // Snapshot of the registered map-info contributors (built-in "Short"/"Full"
    // plus any script-registered ones) backing the hamburger-menu toggle list.
    const [infoContributors, setInfoContributors] = useState<MapInfoContributor[]>([]);
    const [infoOverlaysOpen, setInfoOverlaysOpen] = useState(false);
    // Which side the "Map info overlays" flyout opens toward. Mudlet's submenus
    // prefer the right and flip to the left when the widget sits too close to
    // the screen edge for the flyout to fit — decided per-open in openInfoFlyout.
    const [flyoutSide, setFlyoutSide] = useState<'right' | 'left'>('right');
    // The flyout is portaled to <body> with position:fixed so it isn't clipped
    // by the map panel's bounds — these are its viewport-anchored coordinates,
    // computed per-open from the row's rect (see openInfoFlyout).
    const [flyoutStyle, setFlyoutStyle] = useState<React.CSSProperties>({});
    const flyoutItemRef = useRef<HTMLDivElement>(null);
    const flyoutListRef = useRef<HTMLDivElement>(null);
    // Closing the flyout is deferred so the mouse can cross the gap from the row
    // to the portaled list (which isn't a DOM descendant) without it vanishing.
    const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Refs mirror the latest area/level so callbacks captured at mount time
    // can see the current selection (state values would be stale captures).
    const currentAreaRef = useRef<number | null>(null);
    const currentLevelRef = useRef<number>(0);
    currentAreaRef.current = currentArea;
    currentLevelRef.current = currentLevel;

    // User-tunable renderer settings (Mapper tab). Subscribing here re-renders
    // the panel whenever a field changes; the reactive effect below copies the
    // values onto the live renderer.settings. The ref lets the renderer-init
    // effect read the current value without taking `mapper` as a dependency
    // (which would tear down the renderer on every Mapper-tab edit).
    const mapper = useAppStore(s => selectProfileField(s, connectionId, 'mapper'));
    // Resolved as a CSS string in the selector so Zustand's Object.is check
    // compares by value (no spurious re-render when an unrelated config changes).
    const mapInfoBg = useAppStore(s => {
        const c = (s.connectionProfile[connectionId]?.config?.mapInfoColor as MapInfoBgColor | undefined)
            ?? MAP_INFO_BG_DEFAULT;
        return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
    });
    const connectionName = useAppStore(s => s.connections.find(c => c.id === connectionId)?.name ?? 'map');
    const mapperRef = useRef(mapper);
    mapperRef.current = mapper;

    // Mudlet's Host::mShowPanel — whether the control bar is up. Toggled by the
    // collapse arrow below and by setConfig("mapperPanelVisible", …); shared by
    // every map panel of this profile, as in Mudlet (one host-level flag).
    // Undefined = shown, matching Mudlet's default.
    const panelVisible = useAppStore(s => selectProfileField(s, connectionId, 'mapperPanelVisible')) ?? true;
    const togglePanel = useCallback(() => {
        useAppStore.getState().patchConnectionProfile(connectionId, { mapperPanelVisible: !panelVisible });
    }, [connectionId, panelVisible]);

    // Read a saved per-area view directly from the store. Always reads live so
    // a write done moments earlier (flushSave on area switch) is visible.
    const getSavedView = useCallback(
        (areaId: number) =>
            useAppStore.getState().connectionProfile[connectionId]?.mapViewStates?.[areaId],
        [connectionId],
    );

    // Persist the current area's view: zoom into the map file (per-area
    // userData) and the last-viewed z-level into the profile. We don't debounce
    // here — the zoom write is in-memory (MapStore.setAreaZoom doesn't notify),
    // and the persist-storage adapter already coalesces the level write into a
    // single localStorage write (with a pagehide flush).
    const saveViewState = useCallback(() => {
        const renderer = rendererRef.current;
        const areaId = currentAreaRef.current;
        if (!renderer || areaId == null) return;
        // Zoom is map data — persist it into the map file (per-area userData), the
        // same way Mudlet does. Pan is no longer remembered (areas open centered
        // on the area's middle). Only the last-viewed z-level stays in the
        // profile. When the zoom actually changes (vs. a pure pan), schedule a
        // debounced background save so it survives a reload — the encode runs in
        // a worker, so frequent saves don't block the main thread.
        //
        // Stored in Mudlet units (see toMudletZoom) so it restores to the same
        // view even when the panel is a different size next session, and so it
        // means the same thing as the value getMapZoom/setMapZoom read and write
        // through this very slot. Null while the panel has no laid-out size —
        // there is no view worth recording yet, and writing one would pin the
        // area to a garbage zoom on every future open.
        const zoom = toMudletZoom(renderer);
        if (zoom != null) {
            const prevZoom = manager.mapStore.getAreaZoom(areaId);
            manager.mapStore.setAreaZoom(areaId, zoom);
            if (prevZoom == null || Math.abs(prevZoom - zoom) > 1e-6) manager.scheduleMapSave();
        }
        const store = useAppStore.getState();
        const existing = store.connectionProfile[connectionId]?.mapViewStates ?? {};
        store.patchConnectionProfile(connectionId, {
            mapViewStates: {
                ...existing,
                [areaId]: { level: currentLevelRef.current },
            },
            mapLastAreaId: areaId,
        });
    }, [connectionId, manager]);
    // Stable handle to saveViewState for the renderer-init effect's camera
    // listener. That effect must construct the renderer EXACTLY ONCE per
    // connection; if it listed saveViewState in its deps, a changed
    // saveViewState identity (e.g. connectionId/manager re-injection after a
    // layout restore) would tear the renderer down and rebuild an empty one
    // without re-running the separate sync effect — leaving a black map.
    const saveViewStateRef = useRef(saveViewState);
    saveViewStateRef.current = saveViewState;

    // The renderer's player marker isn't gated by area/z — its onPositionChanged
    // runs after every drawArea and re-draws the marker at the player room's
    // (x, y) on whatever canvas is currently displayed, so viewing a different
    // area shows the marker in the wrong place. Gate it here: refresh the
    // marker only when the displayed area+level contains the player room,
    // otherwise clear it. clearPosition wipes positionRoomId but the next
    // sync call (after a manual switch back, or a centerview) restores it.

    // Re-evaluate every enabled registerMapInfo contributor. Cheap when no
    // contributors are registered (most profiles); contributors are pure-Lua
    // and the dispatcher pcalls each so a broken one can't take the panel
    // down. roomId is the selection's center when there is one (matches
    // Mudlet — Mudlet passes the selection center to the callback), falling
    // back to the player's current room when nothing is selected.
    const recomputeMapInfos = useCallback(() => {
        const areaId = currentAreaRef.current;
        if (areaId == null) {
            setMapInfos(prev => (prev.length === 0 ? prev : []));
            return;
        }
        // Mirror the position marker's room choice (syncPositionMarker):
        // selection center → real player room → display-only fallback room
        // (room 1 / lowest id). Without the fallback the overlay is blank at
        // startup — before any centerview sets the player room — even though
        // the marker is already painted on the fallback room. We keep the
        // data-layer getPlayerRoom() strict (Mudlet parity) and only relax the
        // view here so the info block always describes the marked room.
        const center = manager.mapStore.getSelectionCenter();
        const playerRoomId = manager.mapStore.getPlayerRoom();
        const focusRoomId = center ?? playerRoomId ?? manager.mapStore.getFallbackRoomId();
        // getRoomArea is undefined for a room that no longer exists; fall back
        // to the displayed area so the info panel keeps rendering.
        const focusRoomArea = (focusRoomId != null
            ? manager.mapStore.getRoomArea(focusRoomId)
            : areaId) ?? areaId;
        const next = manager.mapStore.evaluateMapInfos(
            focusRoomId,
            manager.mapStore.getMapSelectionSize(),
            focusRoomArea === -1 ? areaId : focusRoomArea,
            areaId,
        );
        // Avoid a state churn (and downstream re-render) when nothing changed.
        // Compare cheaply by text+style — contributor identity is implicit in
        // insertion order, which is stable.
        setMapInfos(prev => {
            if (prev.length !== next.length) return next;
            for (let i = 0; i < next.length; i++) {
                const a = prev[i], b = next[i];
                if (a.label !== b.label || a.text !== b.text
                    || a.isBold !== b.isBold || a.isItalic !== b.isItalic
                    || a.color?.r !== b.color?.r || a.color?.g !== b.color?.g || a.color?.b !== b.color?.b) {
                    return next;
                }
            }
            return prev;
        });
    }, [manager]);

    const syncPositionMarker = useCallback((areaId: number, level: number) => {
        const renderer = rendererRef.current;
        const reader = readerRef.current;
        if (!renderer || !reader) return;
        // Mudlet's T2DMap draws a marker even with no saved location, falling
        // back to a room for display only (see MapStore.getFallbackRoomId).
        // Mirror that: prefer the real player room, else the fallback (room 1).
        const markerRoomId = manager.mapStore.getPlayerRoom()
            ?? manager.mapStore.getFallbackRoomId();
        if (markerRoomId == null) {
            renderer.clearPosition();
            return;
        }
        const room = reader.getRoom(markerRoomId);
        if (room && room.area === areaId && room.z === level) {
            renderer.updatePositionMarker(markerRoomId);
        } else {
            renderer.clearPosition();
        }
    }, [manager]);

    // Apply the opening view as soon as the panel has a laid-out size, retrying
    // across frames until it does.
    //
    // Everything about the opening view is derived from the viewport's shorter
    // edge, so it cannot be computed before the panel is laid out. The container
    // ResizeObserver below is the usual signal, but it is not a reliable one on
    // its own: a floating map window can take its single observed entry while
    // still 0x0 (the observer is attached from an effect that runs before the
    // window has been positioned) and never report again, which used to leave
    // the camera stuck at 0x0 for the life of the panel — map drawn at full size
    // over a camera that thinks it is a pixel wide. Polling a bounded number of
    // frames costs nothing once it lands on the first or second one, and does
    // not depend on which resize notification arrives.
    const initialViewFrameRef = useRef<number | null>(null);
    const applyInitialViewWhenSized = useCallback((areaId: number) => {
        if (initialViewFrameRef.current != null) cancelAnimationFrame(initialViewFrameRef.current);
        let attempts = 0;
        const tick = () => {
            initialViewFrameRef.current = null;
            const renderer = rendererRef.current;
            if (!renderer) return;
            if (syncCameraSize(renderer, containerRef.current)) {
                applyInitialView(renderer, manager.mapStore, areaId);
                return;
            }
            // ~2s at 60fps. A panel still unsized by then is closed, collapsed,
            // or on a hidden tab — the ResizeObserver picks it up if it ever
            // does appear.
            if (++attempts < 120) initialViewFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
    }, [manager]);
    useEffect(() => () => {
        if (initialViewFrameRef.current != null) cancelAnimationFrame(initialViewFrameRef.current);
    }, []);

    // Refresh the live reader from MapStore and pick an area/level to display.
    // Used both on initial sync and on every store-change tick. Returns true
    // when the renderer was driven to a ready state; false when the store is
    // still empty (overlay stays up).
    const syncFromStore = useCallback((opts?: { keepArea?: number; keepLevel?: number; fresh?: boolean }): boolean => {
        const reader = readerRef.current;
        const renderer = rendererRef.current;
        if (!reader || !renderer) return false;
        reader.refresh();

        const areaList = reader.getAreas()
            .map(a => ({ id: a.getAreaId(), name: a.getAreaName() }))
            .sort((a, b) => a.name.localeCompare(b.name));
        setAreas(areaList);

        if (areaList.length === 0) {
            setStatus('empty');
            return false;
        }

        // On first sync, restore the area the user was last viewing (and
        // that area's saved view). Subsequent calls keep whatever area the
        // user is currently in. Explicit hints (centerview from script) win.
        const profile = useAppStore.getState().connectionProfile[connectionId];
        const lastAreaId = profile?.mapLastAreaId;
        // Mudlet loads the map centered on the current room's area — the real
        // player room when known, else a fallback room it shows the marker on
        // anyway (room 1, see MapStore.getFallbackRoomId). That position takes
        // priority over the last-viewed area on first open: opening on "wherever
        // you last looked" while a marker sits in another area is exactly the bug
        // being fixed. The marker room is always set for a non-empty map, so
        // lastAreaId only matters as a deeper fallback.
        const markerRoomId = manager.mapStore.getPlayerRoom()
            ?? manager.mapStore.getFallbackRoomId();
        const markerArea = markerRoomId != null ? manager.mapStore.getRoomArea(markerRoomId) : -1;
        const markerAreaValid = markerArea !== -1 && areaList.some(a => a.id === markerArea);
        // `fresh` (a full map (re)load) ignores the stale displayed area so the
        // player position drives the area choice — Mudlet re-centers on the
        // current room after loadMap, it doesn't keep the pre-load view.
        // A secondary map view (createMapView) is pinned to the area it was
        // opened for — following the player is the primary mapper's job, and
        // the whole point of a second view is watching somewhere else.
        const viewArea = manager.mapViewAreaFor(id);
        const keepArea = viewArea
            ?? opts?.keepArea
            ?? (opts?.fresh ? undefined : currentAreaRef.current)
            ?? (markerAreaValid ? markerArea : undefined)
            ?? (needsFitRef.current ? undefined : lastAreaId);
        const restoredArea = keepArea != null && areaList.some(a => a.id === keepArea)
            ? keepArea
            : areaList[0].id;
        const areaLevels = reader.getArea(restoredArea).getZLevels().sort((a, b) => a - b);
        const savedForArea = needsFitRef.current ? undefined : getSavedView(restoredArea);
        // Opening on the marker room's area → prefer that room's own z-level so
        // the marker is on the level we show (Mudlet sets mMapCenterZ to room z).
        const markerZ = markerRoomId != null && markerArea === restoredArea
            ? manager.mapStore.getRoomCoordinates(markerRoomId)?.[2]
            : undefined;
        const keepLevel = opts?.keepLevel
            ?? (!opts?.fresh && currentAreaRef.current != null ? currentLevelRef.current : (markerZ ?? savedForArea?.level));
        const restoredLevel =
            keepLevel != null && areaLevels.includes(keepLevel) ? keepLevel
            : areaLevels.includes(0) ? 0 : (areaLevels[0] ?? 0);
        setLevels(areaLevels);
        setCurrentLevel(restoredLevel);
        setCurrentArea(restoredArea);
        // Update the mirrors synchronously too. The render-time `ref = state`
        // assignment hasn't happened yet (setState is queued), so anything
        // that runs before the next render — notably the ResizeObserver
        // re-apply branch that fires from a queued layout pass — would
        // otherwise see stale (often null) values and fall through to fitArea,
        // clobbering the view we just restored.
        currentAreaRef.current = restoredArea;
        currentLevelRef.current = restoredLevel;
        // Keep a secondary view's registry entry in step with what it actually
        // shows, so getMapViewInfo reports the live state and not just the
        // values createMapView seeded it with.
        manager.noteMapViewState(id, { areaId: restoredArea, zLevel: restoredLevel });
        // drawArea → state.setArea unconditionally re-emits 'area', forcing a
        // full scene rebuild (createExits is ~280ms on the Arkadia map) even
        // when the displayed area is identical. At boot syncFromStore fires
        // from several triggers — the map-load subscribe handler, the
        // registerMapLoadCallback, and the deferred idle build — so without a
        // guard the same scene is built two or three times. Skip the rebuild
        // when area + level + the reader's area instance/version all match what
        // the renderer last drew, mirroring the guard MapState.setPosition
        // already applies (instance identity catches a MudixMapReader inner
        // rebuild; version catches an in-place markDirty).
        const targetArea = reader.getArea(restoredArea);
        const st = renderer.state;
        const sceneUnchanged =
            st.currentArea === restoredArea &&
            st.currentZIndex === restoredLevel &&
            st.currentAreaInstance === targetArea &&
            st.currentAreaVersion === targetArea.getVersion();
        if (!sceneUnchanged) {
            renderer.drawArea(restoredArea, restoredLevel);
        } else if (manager.mapStore.getHiddenVersion() !== lastHiddenVersionRef.current) {
            // Same area/level, but the lens's hidden-room snapshot moved —
            // force a rebuild so newly-hidden rooms drop out (and previously-
            // hidden ones reappear). renderer.refresh() re-reads the lens
            // version on the next scene build.
            renderer.refresh();
        }
        lastHiddenVersionRef.current = manager.mapStore.getHiddenVersion();
        syncPositionMarker(restoredArea, restoredLevel);
        recomputeMapInfos();
        // Only fit/center on the first successful render; afterwards preserve the
        // user's live zoom and pan.
        if (!needsFitRef.current) {
            needsFitRef.current = true;
            applyInitialViewWhenSized(restoredArea);
        }
        setStatus('ready');
        return true;
    }, [connectionId, getSavedView, syncPositionMarker, recomputeMapInfos]);

    // Construct the renderer + live reader exactly once. Subsequent store
    // mutations flow through `reader.refresh()` + `renderer.drawArea(...)` —
    // the Konva stage and event listeners stay alive across map reloads.
    useEffect(() => {
        if (!containerRef.current) return;
        // A fresh renderer hasn't been positioned yet, so the next syncFromStore
        // must run its first-fit (zoom + center on the player). needsFitRef is a
        // ref that survives this effect re-running, so without resetting it a
        // rebuilt renderer (manager/session swap — a layout restore in prod, or
        // StrictMode's synthetic session swap in dev) would inherit the previous
        // renderer's "already fitted" flag and open uncentered at (0,0).
        needsFitRef.current = false;
        setLod(null);
        const reader = new MudixMapReader(manager.mapStore);
        readerRef.current = reader;
        const settings = createSettings();
        settings.areaName = false;
        settings.highlightCurrentRoom = false;
        settings.instantMapMove = true;
        applyMapperSettings(settings, mapperRef.current);
        const renderer = new MapRenderer(reader, settings, containerRef.current);
        renderer.centerOnResize = false;
        rendererRef.current = renderer;

        // Hidden-room lens: Mudlet's setRoomHidden(roomID, true) makes a room
        // (and any exit landing on it) disappear from the viewing-mode map.
        // The MapStore side-table is the source of truth; the renderer asks
        // the lens on every scene build, and its getVersion() tracks the
        // store's hiddenVersion counter so the renderer's lens-output cache
        // is invalidated whenever the set actually changes. Editing mode
        // (Mudlet's edit overlay) shows hidden rooms — match that by skipping
        // the filter when mapMode is 'editing'.
        const hiddenLens: RoomLens = {
            isVisible: (room) => {
                if (manager.mapStore.getMapMode() === 'editing') return true;
                return !manager.mapStore.isRoomHidden(room.id);
            },
            // Default treatment for an exit with one hidden endpoint is "stub"
            // (a short stub leaving the visible side), which would leave dangling
            // stubs pointing at every hidden room. Mudlet's setRoomHidden makes
            // both the room AND its exits disappear, so return "hidden" instead
            // when either endpoint is hidden in viewing mode.
            getExitTreatment: (_exit, a, b) => {
                if (manager.mapStore.getMapMode() === 'editing') return 'full';
                const aHidden = manager.mapStore.isRoomHidden(a.id);
                const bHidden = manager.mapStore.isRoomHidden(b.id);
                if (aHidden || bHidden) return 'hidden';
                return 'full';
            },
            getVersion: () => manager.mapStore.getHiddenVersion(),
        };
        renderer.setLens(hiddenLens);
        lastHiddenVersionRef.current = manager.mapStore.getHiddenVersion();

        // Mudlet-style highlights (radial gradient with both colours + alphas).
        // The overlay self-subscribes to MapStore mutations and area-change
        // events via its SceneOverlayContext; the renderer disposes it via
        // renderer.destroy(). Engine-agnostic, so it also appears in exports.
        const highlightOverlay = new MudletHighlightOverlay(manager.mapStore, reader);
        renderer.addSceneOverlay('mudlet-highlights', highlightOverlay);
        highlightOverlayRef.current = highlightOverlay;

        // Map-room selection ring overlay backing Mudlet's getMapSelection /
        // clearMapSelection. Self-subscribes to the dedicated selection
        // channel; renderer.destroy() detaches it.
        const selectionOverlay = new MapSelectionOverlay(manager.mapStore, reader);
        renderer.addSceneOverlay('mudix-selection', selectionOverlay);
        selectionOverlayRef.current = selectionOverlay;

        const mapContainer = containerRef.current;

        // Mudlet selection model: plain left-click on a room replaces the
        // selection (room becomes the center); ctrl/cmd-click toggles
        // membership without affecting the center beyond center-fallback when
        // the prior center is removed. Clicking on empty space clears.
        //
        // KeyboardEvent state isn't carried by the renderer's typed event, so
        // a capture-phase mousedown listener snapshots the modifier state
        // before the renderer's bubble-phase handler dispatches.
        let lastClickWithModifier = false;
        const onClickCapture = (e: MouseEvent) => {
            lastClickWithModifier = e.ctrlKey || e.metaKey || e.shiftKey;
        };
        mapContainer?.addEventListener('mousedown', onClickCapture, { capture: true });
        // Double-clicking a room walks there (Mudlet T2DMap::mouseDoubleClickEvent
        // → initiateSpeedWalk). The renderer has no double-click event of its own
        // and the native `dblclick` carries no room id, so remember what the last
        // click resolved to — the renderer emits roomclick/areaexitclick/mapclick
        // on mouseup, i.e. before the dblclick that follows the second one. A
        // click that resolved to nothing (mapclick) clears the target, so a miss
        // on the second click can't walk to the first click's room.
        let lastClickTarget: number | null = null;
        renderer.backend.events.on('roomclick', (detail: RoomClickEventDetail) => {
            lastClickTarget = detail.roomId;
            if (lastClickWithModifier) {
                manager.mapStore.toggleMapRoomSelection(detail.roomId);
            } else {
                manager.mapStore.selectMapRoom(detail.roomId);
            }
        });
        // Mudlet also speedwalks on a double-clicked out-of-area exit marker,
        // targeting the room it leads to in the other area.
        renderer.backend.events.on('areaexitclick', (detail: AreaExitClickEventDetail) => {
            lastClickTarget = detail.targetRoomId;
        });
        renderer.backend.events.on('mapclick', () => {
            lastClickTarget = null;
            manager.mapStore.clearMapSelection();
        });
        // Mudlet ignores a double-click carrying any other button, and mudix
        // additionally ignores the modifier chords that mean "extend selection".
        const onDoubleClick = (e: MouseEvent) => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (lastClickTarget == null) return;
            manager.startSpeedWalk(lastClickTarget);
        };
        mapContainer?.addEventListener('dblclick', onDoubleClick);

        // Submenus registered via addMapMenu are pure containers (no event);
        // surface them as event-shaped nodes so addMapEvent entries whose
        // `parent` names a menu nest under them. Menus first, then events.
        const buildMapMenuItems = (): MapEventEntry[] => {
            const menuNodes: MapEventEntry[] = manager.mapStore.getMapMenus().map(m => ({
                uniqueName: m.name,
                eventName: '',
                parent: m.parent,
                displayName: m.displayName,
                args: [],
            }));
            return [...menuNodes, ...manager.mapStore.getMapEvents()];
        };

        renderer.backend.events.on('roomcontextmenu', (detail: RoomContextMenuEventDetail) => {
            const rect = containerRef.current?.getBoundingClientRect();
            setContextMenu({
                x: (rect?.left ?? 0) + detail.position.x,
                y: (rect?.top ?? 0) + detail.position.y,
                roomId: detail.roomId,
                hasRoom: true,
                items: buildMapMenuItems(),
            });
        });

        // Right-click on empty map space (not a room). The renderer's own
        // contextmenu listener only preventDefault()s + emits roomcontextmenu
        // when the cursor is over a room; on empty space it leaves the event
        // alone, so the browser's native menu would show. Mudlet surfaces the
        // map's addMapMenu/addMapEvent entries on a right-click anywhere on the
        // 2D map, so mirror that. This listener is on the same element as the
        // renderer's and is registered after it, so it runs second — bail when
        // the renderer already claimed the event (a room hit set defaultPrevented).
        const onMapContextMenu = (e: MouseEvent) => {
            if (e.defaultPrevented) return;
            const items = buildMapMenuItems();
            // Always suppress the native menu over the map canvas, even when no
            // custom entries are registered (nothing to show then — the menu
            // component renders null without a room or items).
            e.preventDefault();
            if (items.length === 0) return;
            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                // No room under the cursor: fall back to the current selection
                // center so dispatched events still target a sensible room
                // (Mudlet operates on the selection here), else -1 = none.
                roomId: manager.mapStore.getSelectionCenter() ?? -1,
                hasRoom: false,
                items,
            });
        };
        mapContainer?.addEventListener('contextmenu', onMapContextMenu);

        // Mudlet `sysMapWindowMousePressEvent(button, x, y)` — fired on every
        // mouse press inside the map widget. Mudlet's button mapping mirrors
        // sysWindowMousePressEvent (1=left, 2=right, 3=middle).
        const onMapMouseDown = (e: MouseEvent) => {
            const rect = mapContainer?.getBoundingClientRect();
            const x = Math.round(e.clientX - (rect?.left ?? 0));
            const y = Math.round(e.clientY - (rect?.top ?? 0));
            const button = e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 3 : 0;
            manager.onRaiseEvent?.('sysMapWindowMousePressEvent', [button, x, y]);
        };
        mapContainer?.addEventListener('mousedown', onMapMouseDown);

        // Persist zoom/pan back to the profile whenever the camera moves.
        // Skipped until syncFromStore has applied saved/initial state so the
        // initial fitArea / restored-zoom doesn't trample a still-loading save.
        const onCameraChange = () => { if (needsFitRef.current) saveViewStateRef.current(); };
        renderer.camera.on('change', onCameraChange);

        // Enforce Mudlet's zoom-in ceiling: the shorter viewport edge may never
        // span fewer than MUDLET_MIN_MAP_ZOOM map units. The renderer's camera
        // only clamps a zoom-out floor (minZoom), so wheel/pinch could otherwise
        // zoom in indefinitely. Mudlet additionally does NOT pan the view on a
        // wheel tick that is fully clamped (T2DMap only shifts the center inside
        // its "zoom actually changed" branch), whereas the renderer's wheel
        // handler always pans toward the cursor first — so a naive zoom clamp
        // leaves the map drifting cursor-ward without zooming.
        //
        // To match Mudlet we snapshot the camera in a capture-phase wheel
        // listener (it runs before the renderer's bubble listener on the canvas
        // element), then, in the synchronous 'zoom' event, redo the zoom from
        // that snapshot clamped to the cap. zoomToPoint reproduces the
        // cursor-focal pan for the part of the delta that fits under the cap and
        // applies zero pan once already at the limit. All of this runs before
        // the backend's rAF repaint, so no drifted/over-zoomed frame is painted.
        const panelEl = containerRef.current.parentElement;
        let wheelSnap: { zoom: number; x: number; y: number; sx: number; sy: number } | null = null;
        const onWheelCapture = (e: WheelEvent) => {
            const cam = renderer.camera;
            const rect = containerRef.current?.getBoundingClientRect();
            wheelSnap = {
                zoom: cam.zoom,
                x: cam.position.x,
                y: cam.position.y,
                sx: e.clientX - (rect?.left ?? 0),
                sy: e.clientY - (rect?.top ?? 0),
            };
        };
        panelEl?.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });

        const onZoom = () => {
            const cam = renderer.camera;
            const maxRendererZoom = toRendererZoom(renderer, MUDLET_MIN_MAP_ZOOM);
            if (maxRendererZoom == null) { wheelSnap = null; return; }
            if (renderer.getZoom() <= maxRendererZoom) { wheelSnap = null; return; }
            if (wheelSnap) {
                // Rewind to the pre-tick transform, then redo the zoom clamped
                // to the cap about the cursor: this pans only for the part of
                // the requested delta that stays within the limit, and not at
                // all once the snapshot was already at the cap.
                cam.zoom = wheelSnap.zoom;
                cam.position = { x: wheelSnap.x, y: wheelSnap.y };
                if (!cam.zoomToPoint(maxRendererZoom, wheelSnap.sx, wheelSnap.sy)) {
                    // Already at the cap: zoom is unchanged so zoomToPoint did
                    // not repaint, but the renderer's pre-clamp wheel pan has
                    // already pushed the Konva stage off. Force a viewport
                    // re-apply from the restored (pre-tick) center so the stage
                    // doesn't keep rendering the drifted transform.
                    const b = cam.getViewportBounds();
                    cam.panToMapPoint((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
                }
                wheelSnap = null;
            } else {
                // Non-wheel path (touch pinch): clamp about the viewport center.
                renderer.zoomToCenter(maxRendererZoom);
            }
        };
        renderer.events.on('zoom', onZoom);

        // Level-of-detail: the renderer re-decides on every scene build, so
        // dedupe before touching React state — mode and hit-test availability
        // only flip at a threshold crossing, and planeRoomCount only when the
        // drawn plane changes, so this settles instead of firing per pan frame.
        const onLod = (detail: LodEventDetail) => {
            setLod(prev =>
                prev
                && prev.mode === detail.mode
                && prev.hitTestActive === detail.hitTestActive
                && prev.planeRoomCount === detail.planeRoomCount
                    ? prev
                    : detail);
        };
        renderer.events.on('lod', onLod);

        return () => {
            renderer.events.off('lod', onLod);
            renderer.events.off('zoom', onZoom);
            panelEl?.removeEventListener('wheel', onWheelCapture, { capture: true });
            mapContainer?.removeEventListener('mousedown', onMapMouseDown);
            mapContainer?.removeEventListener('contextmenu', onMapContextMenu);
            mapContainer?.removeEventListener('dblclick', onDoubleClick);
            mapContainer?.removeEventListener('mousedown', onClickCapture, { capture: true });
            renderer.camera.off('change', onCameraChange);
            renderer.destroy();
            rendererRef.current = null;
            readerRef.current = null;
            highlightOverlayRef.current = null;
            selectionOverlayRef.current = null;
        };
        // Only `manager` (the connection) may rebuild the renderer. saveViewState
        // is reached through saveViewStateRef so its identity churn no longer
        // tears the renderer down (which would leave an un-synced black map).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manager]);

    // Forward Mapper-tab edits onto the live renderer.settings. The settings
    // object is shared and mutable, but the renderer caches some derived
    // state per scene build, so size/shape/color changes only show up after
    // refresh(); backgroundColor lives on the container element and is
    // updated separately via updateBackground().
    useEffect(() => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        applyMapperSettings(renderer.settings, mapper);
        renderer.refresh();
        renderer.updateBackground();
        // The position marker is an overlay, not part of the room scene, so
        // refresh() alone leaves it drawn with the previous playerMarker style.
        renderer.refreshCurrentRoomOverlay();
    }, [mapper]);

    // Boot path: ScriptingEngine and this panel both call bootstrapMap; the
    // manager dedupes to a single IndexedDB fetch + parse. Once it resolves
    // (or fails) we sync from the now-populated MapStore.
    //
    // The first sync runs drawArea, whose createExits step is one of the
    // single biggest main-thread blocks during boot (~140ms+). We yield with
    // requestIdleCallback (fallback: rAF + setTimeout) so the browser paints
    // the rest of the UI first, then build the map scene — this keeps the
    // map's first-paint cost from delaying LCP.
    useEffect(() => {
        let cancelled = false;
        let idleHandle: ReturnType<typeof setTimeout> | number | null = null;
        setStatus('loading');
        const runSync = () => {
            if (cancelled) return;
            try { syncFromStore(); }
            catch (e) {
                setErrorMsg(e instanceof Error ? e.message : String(e));
                setStatus('error');
            }
        };
        const scheduleAfterPaint = (cb: () => void) => {
            const rIC = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
            if (typeof rIC === 'function') {
                idleHandle = rIC(cb, { timeout: 300 });
            } else {
                // Double-yield: rAF fires *before* the next paint, so chain a
                // task to land after the paint commits.
                requestAnimationFrame(() => { idleHandle = setTimeout(cb, 0); });
            }
        };
        manager.bootstrapMap().then(() => {
            if (cancelled) return;
            scheduleAfterPaint(runSync);
        });
        return () => {
            cancelled = true;
            const cIC = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
            if (idleHandle != null) {
                if (typeof cIC === 'function') cIC(idleHandle as number);
                else clearTimeout(idleHandle as ReturnType<typeof setTimeout>);
            }
        };
    }, [manager, syncFromStore]);

    // Close dropdown on outside click
    useEffect(() => {
        if (!dropdownOpen) return;
        const onDown = (e: MouseEvent) => {
            if (!dropdownRef.current?.contains(e.target as Node)) setDropdownOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [dropdownOpen]);

    // Close z-level dropdown on outside click
    useEffect(() => {
        if (!levelDropdownOpen) return;
        const onDown = (e: MouseEvent) => {
            if (!levelDropdownRef.current?.contains(e.target as Node)) setLevelDropdownOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [levelDropdownOpen]);

    // Close hamburger menu on outside click
    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            // The overlays flyout is portaled to <body>, so it's outside menuRef
            // — exempt it too or clicking a checkbox would close the whole menu.
            if (menuRef.current?.contains(target) || flyoutListRef.current?.contains(target)) return;
            setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [menuOpen]);

    // Close map context menu on outside click or scroll/resize
    useEffect(() => {
        if (!contextMenu) return;
        const onDown = (e: MouseEvent) => {
            const root = document.getElementById('mudix-map-context-menu');
            if (root && !root.contains(e.target as Node)) setContextMenu(null);
        };
        const onClose = () => setContextMenu(null);
        document.addEventListener('mousedown', onDown);
        window.addEventListener('resize', onClose);
        window.addEventListener('blur', onClose);
        return () => {
            document.removeEventListener('mousedown', onDown);
            window.removeEventListener('resize', onClose);
            window.removeEventListener('blur', onClose);
        };
    }, [contextMenu]);

    // Divs don't fire "resize" natively; the renderer needs it to update canvas size.
    // After the canvas resizes, scale zoom proportionally to preserve visible world bounds
    // (same behavior as Mudlet: bigger window = zoom in, smaller = zoom out).
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const newWidth = entries[0].contentRect.width;
            const renderer = rendererRef.current;
            if (renderer && prevWidthRef.current > 0 && newWidth > 0) {
                const scale = newWidth / prevWidthRef.current;
                const zoom = renderer.getZoom();
                const bounds = renderer.getViewportBounds();
                const cx = (bounds.minX + bounds.maxX) / 2;
                const cy = (bounds.minY + bounds.maxY) / 2;
                el.dispatchEvent(new Event('resize'));
                renderer.setZoom(zoom * scale);
                renderer.camera.panToMapPoint(cx, cy);
            } else {
                el.dispatchEvent(new Event('resize'));
                // First time the canvas reaches non-zero width: re-apply the
                // initial view. syncFromStore may have already drawn the area
                // while the container was 0×0, which makes fit/zoom math useless
                // — redo it now that we have real dimensions. Don't flip
                // needsFitRef back to false: a later store mutation could then
                // trigger another saved-state restore and wipe the user's live
                // zoom.
                if (renderer && newWidth > 0 && needsFitRef.current) {
                    const areaId = currentAreaRef.current;
                    if (areaId != null) applyInitialView(renderer, manager.mapStore, areaId);
                    else fitAreaWithHeadroom(renderer);
                }
            }
            prevWidthRef.current = newWidth;
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [manager]);

    // Area/level changes don't always move the camera (e.g. level cycling via
    // ▲▼ buttons just redraws the same viewport), so the camera-change handler
    // would miss them. Gate on needsFitRef so we don't save before the first
    // sync has settled on real values.
    useEffect(() => {
        if (!needsFitRef.current || currentArea == null) return;
        saveViewState();
    }, [currentArea, currentLevel, saveViewState]);

    // Subscribe to MapStore changes (script-built rooms, binary load, etc.).
    // Each tick: refresh the live reader's snapshot, then ask the renderer to
    // redraw the current area. The Konva stage stays alive across all updates.
    useEffect(() => {
        const unsub = manager.mapStore.subscribe(() => {
            try { syncFromStore(); }
            catch (e) {
                setErrorMsg(e instanceof Error ? e.message : String(e));
                setStatus('error');
            }
        });
        return unsub;
    }, [manager, syncFromStore]);

    // Keep the hamburger-menu contributor list in sync. register/kill/enable/
    // disableMapInfo all fire the store's main notify, so this rides the same
    // channel. Snapshot on mount too so the built-ins show before any mutation.
    useEffect(() => {
        const update = () => setInfoContributors(manager.mapStore.getMapInfoContributors());
        update();
        return manager.mapStore.subscribe(update);
    }, [manager]);

    // Toggle a single contributor on/off. enable/disableMapInfo notify the
    // store, which re-snapshots the list above and re-runs recomputeMapInfos via
    // the main subscribe, so the overlay and the checkboxes both update.
    const toggleInfoContributor = useCallback((label: string, enabled: boolean) => {
        if (enabled) manager.mapStore.disableMapInfo(label);
        else manager.mapStore.enableMapInfo(label);
    }, [manager]);

    // "None": turn every enabled contributor off in one click.
    const disableAllInfoContributors = useCallback(() => {
        for (const c of manager.mapStore.getMapInfoContributors()) {
            if (c.enabled) manager.mapStore.disableMapInfo(c.label);
        }
    }, [manager]);

    // Open the flyout, anchoring it to the row in viewport coordinates so the
    // body-portaled list lands in the right place. We pick a side/vertical and
    // anchor with left/right + top/bottom (rather than a fixed size) so the
    // browser still measures the real box: prefer the right (Mudlet's default),
    // flip left when the submenu would overflow the right viewport edge — i.e.
    // the map widget is docked against the right of the screen; anchor the top
    // to the row and extend down by default, rolling up (anchoring the bottom)
    // when the estimated height would run past the bottom edge. The estimates
    // only steer the flip decision — actual placement is exact.
    const FLYOUT_EST_WIDTH = 150;
    const FLYOUT_ROW_HEIGHT = 30;
    const FLYOUT_PADDING = 10;
    const openInfoFlyout = useCallback(() => {
        if (flyoutCloseTimer.current) { clearTimeout(flyoutCloseTimer.current); flyoutCloseTimer.current = null; }
        const rect = flyoutItemRef.current?.getBoundingClientRect();
        if (rect) {
            const style: React.CSSProperties = { position: 'fixed' };
            // Horizontal: butt the list against the row's right edge, or its
            // left edge (anchored via `right`) when there's no room on the right.
            if (rect.right + FLYOUT_EST_WIDTH > window.innerWidth) {
                setFlyoutSide('left');
                style.right = window.innerWidth - rect.left;
            } else {
                setFlyoutSide('right');
                style.left = rect.right;
            }
            // Vertical: +1 row for the "None" entry; the list top sits ~5px above
            // the row, so measure the overflow from there.
            const estHeight = (infoContributors.length + 1) * FLYOUT_ROW_HEIGHT + FLYOUT_PADDING;
            if (rect.top - 5 + estHeight > window.innerHeight) {
                style.bottom = window.innerHeight - rect.bottom - 5; // roll up
            } else {
                style.top = rect.top - 5;
            }
            setFlyoutStyle(style);
        }
        setInfoOverlaysOpen(true);
    }, [infoContributors.length]);

    // Defer the close so moving from the row onto the portaled list (a non-
    // descendant in the DOM, so it triggers the row's mouseleave) doesn't shut
    // it. Re-entering either the row or the list cancels the pending close.
    const scheduleFlyoutClose = useCallback(() => {
        if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
        flyoutCloseTimer.current = setTimeout(() => setInfoOverlaysOpen(false), 120);
    }, []);
    const cancelFlyoutClose = useCallback(() => {
        if (flyoutCloseTimer.current) { clearTimeout(flyoutCloseTimer.current); flyoutCloseTimer.current = null; }
    }, []);
    useEffect(() => () => { if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current); }, []);

    // Collapse the flyout whenever the parent menu closes so it doesn't pop back
    // up (without a hover) the next time the menu is opened.
    useEffect(() => { if (!menuOpen) setInfoOverlaysOpen(false); }, [menuOpen]);

    // Selection ride its own subscribe channel so the paint-only overlay
    // doesn't drag MudixMapReader through a snapshot rebuild on every click.
    // registerMapInfo contributors still receive the selection size/center in
    // their args, so re-evaluate them when the selection changes.
    useEffect(() => {
        return manager.mapStore.subscribeSelection(() => {
            recomputeMapInfos();
        });
    }, [manager, recomputeMapInfos]);

    // Lua loadMap() routes through WindowManager → MapStore. The store's notify
    // will trigger the subscribe handler above; this callback only needs to
    // report whether the renderer reached a ready state.
    // Streamed loads publish per-batch progress here. Subscribing fires once
    // immediately, so a panel opened while the cold-start bootstrap is still
    // running picks the bar up mid-flight instead of showing a bare spinner.
    useEffect(() => manager.subscribeMapLoadProgress(setLoadProgress), [manager]);

    useEffect(() => {
        manager.registerMapLoadCallback(() => {
            // loadMap replaces the whole map. Mudlet re-centers on the current
            // room afterward, so drop the one-time fit latch and re-derive the
            // area/level/center from the (re-restored) player position rather
            // than keeping the pre-load view — otherwise a boot-time reload (e.g.
            // a package that loadMap()s its own .dat) leaves us at the area
            // default (0,0) instead of on the player.
            needsFitRef.current = false;
            return syncFromStore({ fresh: true });
        });
        return () => manager.unregisterMapLoadCallback();
    }, [manager, syncFromStore]);

    // centerview: switch to the room's area/level, mark player position, and center.
    // The callback is stored in a ref so it always captures the latest renderer state.
    const centerViewImplRef = useRef<(roomId: number) => void>(() => {});
    centerViewImplRef.current = useCallback((roomId: number) => {
        const renderer = rendererRef.current;
        const reader = readerRef.current;
        if (!renderer || !reader) return;
        // WindowManager.centerView already rejected unknown room ids before
        // notifying us, so room should resolve. Guard anyway: getRoom returns
        // undefined (it does not throw) for a missing id, and reading .area off
        // undefined would throw inside this renderer callback.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let room: any;
        try { room = reader.getRoom(roomId); } catch { return; }
        if (!room) return;
        const areaId: number = room.area;
        const zLevel: number = room.z;
        let area;
        try { area = reader.getArea(areaId); } catch { return; }
        if (!area) return;
        const areaLevels = area.getZLevels().sort((a, b) => a - b);
        // Crossing into another area — persist the new last-area pointer up
        // front so a reload before the new area's first camera-change save
        // still returns to it. centerview itself keeps the current zoom
        // (mapper-script semantics: follow the player without rescaling).
        const prevArea = currentAreaRef.current;
        if (prevArea !== areaId) {
            useAppStore.getState().patchConnectionProfile(connectionId, { mapLastAreaId: areaId });
            // Mudlet `sysMapAreaChanged(newAreaID, prevAreaID)`.
            manager.onRaiseEvent?.('sysMapAreaChanged', [areaId, prevArea ?? -1]);
        }
        setLevels(areaLevels);
        setCurrentLevel(zLevel);
        setCurrentArea(areaId);
        currentAreaRef.current = areaId;
        currentLevelRef.current = zLevel;
        setDropdownOpen(false);
        // setPosition() internally calls setArea() only when area/z (or the
        // area instance/version) actually change, then emits 'position'. On
        // same-area moves — the speedwalk path — this skips the 'area' event
        // and therefore the full refresh()/syncPaths/sceneOverlay rebuild
        // that drawArea would have forced. Cross-area moves still refresh.
        renderer.setPosition(roomId, true);
        recomputeMapInfos();
    }, [connectionId, manager, recomputeMapInfos]);

    useEffect(() => {
        const handler = (roomId: number) => centerViewImplRef.current(roomId);
        manager.registerMapCallback(id, handler);
        return () => manager.unregisterMapCallback(id);
    }, [id, manager]);

    // Lua getMapZoom/setMapZoom/updateMap reach the renderer through here. The
    // impl is held in a ref so the registered control always sees the latest
    // renderer/syncFromStore without re-registering on every render. setZoom
    // re-centers + repaints the same way the resize handler does (the renderer
    // repaints on a camera move, not on setZoom alone).
    //
    // Zoom crosses this boundary in Mudlet units — see map/mapZoom.ts for what
    // that means and why.
    const mapControlImplRef = useRef<MapControl>({ getZoom: () => null, setZoom: () => {}, redraw: () => {}, exportArea: () => null });
    mapControlImplRef.current = {
        getZoom: () => {
            const renderer = rendererRef.current;
            return renderer ? toMudletZoom(renderer) : null;
        },
        setZoom: (zoom: number) => {
            const renderer = rendererRef.current;
            if (!renderer) return;
            const rendererZoom = toRendererZoom(renderer, zoom);
            if (rendererZoom == null) return;
            // fitArea pins camera.minZoom to the fit zoom, which would clamp a
            // zoom-out request; lower the floor so an explicit setMapZoom is
            // honored (and the user can wheel back out that far afterwards).
            if (rendererZoom < renderer.minZoom) renderer.minZoom = rendererZoom;
            const bounds = renderer.getViewportBounds();
            const cx = (bounds.minX + bounds.maxX) / 2;
            const cy = (bounds.minY + bounds.maxY) / 2;
            renderer.setZoom(rendererZoom);
            renderer.camera.panToMapPoint(cx, cy);
        },
        redraw: () => {
            try { syncFromStore(); }
            catch (e) {
                setErrorMsg(e instanceof Error ? e.message : String(e));
                setStatus('error');
            }
        },
        // Mudlet `exportAreaImage` — rasterize an area to PNG bytes without
        // disturbing the visible map. The whole render is standalone (see
        // mapImageExport); the panel only forwards its current Mapper settings.
        exportArea: (areaId: number, zLevel?: number): Uint8Array | null =>
            exportAreaImage(manager.mapStore, mapperRef.current, areaId, zLevel),
    };
    useEffect(() => {
        const ctrl: MapControl = {
            getZoom: () => mapControlImplRef.current.getZoom(),
            setZoom: (z) => mapControlImplRef.current.setZoom(z),
            redraw: () => mapControlImplRef.current.redraw(),
            exportArea: (areaId, zLevel) => mapControlImplRef.current.exportArea(areaId, zLevel),
        };
        manager.registerMapControl(id, ctrl);
        return () => manager.unregisterMapControl(id);
    }, [id, manager]);

    // Track the game-announced map URL — Client.Map can arrive any time after
    // mount, and the download affordances should appear when it does (Mudlet's
    // dlgMapper listens to signal_mmpMapLocationChanged for the same purpose).
    useEffect(() => {
        setMmpMapUrl(manager.mmpMapLocation);
        manager.onMmpMapLocationChanged = setMmpMapUrl;
        return () => { manager.onMmpMapLocationChanged = undefined; };
    }, [manager]);

    const handleMapFile = useCallback(async (picked: PickedFile[]) => {
        const file = picked[0]?.file;
        if (!file) return;
        setStatus('loading');
        try {
            // Routes through WindowManager: persists to IndexedDB, parses into
            // MapStore, raises sysMapLoadEvent, and the store's notify drives
            // the panel back to status='ready' via the subscribe handler.
            // `.xml` files take the IRE-style XML importer, like Mudlet.
            //
            // The binary path is the streamed/async one: a big .dat parsed
            // synchronously freezes the window for the whole load, which is both
            // the worst moment to be unresponsive and the one case where the
            // progress bar below would have something to say.
            const ok = file.name.toLowerCase().endsWith('.xml')
                ? manager.loadMapXml(await file.text())
                : await manager.loadMapAsync(await file.arrayBuffer());
            if (!ok) {
                setErrorMsg('Failed to parse map file');
                setStatus('error');
            }
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err));
            setStatus('error');
        }
    }, [manager]);

    // Maps often arrive inside a package or get downloaded into the profile, so
    // "Load map…" offers the profile's own files alongside a local upload.
    const mapSource = useFileSource({
        vfs,
        accept: '.dat,.xml',
        pickerTitle: 'Load map from profile files',
        onPick: handleMapFile,
        onError: msg => { setErrorMsg(msg); setStatus('error'); },
    });

    const selectArea = useCallback((id: number) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        // Persist the new mapLastAreaId immediately so a tab close before the
        // new area's first camera-change save fires still restores to it.
        const prevArea = currentAreaRef.current;
        if (prevArea !== id) {
            useAppStore.getState().patchConnectionProfile(connectionId, { mapLastAreaId: id });
            // Mudlet `sysMapAreaChanged(newAreaID, prevAreaID)`.
            manager.onRaiseEvent?.('sysMapAreaChanged', [id, prevArea ?? -1]);
        }
        const areaLevels = readerRef.current?.getArea(id).getZLevels().sort((a, b) => a - b) ?? [0];
        const saved = getSavedView(id);
        const level = saved && areaLevels.includes(saved.level)
            ? saved.level
            : areaLevels.includes(0) ? 0 : (areaLevels[0] ?? 0);
        setLevels(areaLevels);
        setCurrentLevel(level);
        setCurrentArea(id);
        currentAreaRef.current = id;
        currentLevelRef.current = level;
        setDropdownOpen(false);
        renderer.drawArea(id, level);
        syncPositionMarker(id, level);
        const savedZoom = manager.mapStore.getAreaZoom(id);
        applyAreaZoom(renderer, savedZoom);
        // Fitting already frames the area; only a restored zoom needs an
        // explicit re-center on top of it.
        if (savedZoom != null) centerOnArea(renderer, manager.mapStore);
        recomputeMapInfos();
    }, [getSavedView, connectionId, manager, syncPositionMarker, recomputeMapInfos]);

    // Switch to a specific z-level in the current area (direct selection from
    // the level dropdown). Mirrors the level-stepper path but jumps to an
    // absolute level rather than stepping. Uses the area ref + an explicit
    // null check so area id 0 isn't treated as "no area".
    const selectLevel = useCallback((level: number) => {
        const renderer = rendererRef.current;
        const area = currentAreaRef.current;
        if (!renderer || area == null) return;
        setCurrentLevel(level);
        currentLevelRef.current = level;
        setLevelDropdownOpen(false);
        renderer.drawArea(area, level);
        syncPositionMarker(area, level);
        recomputeMapInfos();
    }, [syncPositionMarker, recomputeMapInfos]);

    const handleLevelChange = useCallback((delta: number) => {
        if (!rendererRef.current || currentArea == null) return;
        const idx = levels.indexOf(currentLevel);
        const nextIdx = idx + delta;
        if (nextIdx < 0 || nextIdx >= levels.length) return;
        const nextLevel = levels[nextIdx];
        setCurrentLevel(nextLevel);
        rendererRef.current.drawArea(currentArea, nextLevel);
        syncPositionMarker(currentArea, nextLevel);
        recomputeMapInfos();
    }, [currentArea, currentLevel, levels, syncPositionMarker, recomputeMapInfos]);

    const currentAreaName = areas.find(a => a.id === currentArea)?.name ?? '';

    // Only the room-streaming phase has a real denominator to fill against.
    const determinateProgress = loadProgress?.phase === 'rooms' && loadProgress.total > 0;

    // Tell the user when the renderer is dropping detail on a dense plane —
    // without this, exits vanishing (or clicks no longer selecting a room) at a
    // zoom threshold reads as a bug rather than a deliberate trade.
    const lodNotice = (() => {
        if (!lod) return null;
        const rooms = `${lod.planeRoomCount.toLocaleString()} rooms on this level`;
        if (lod.mode === 'raster') {
            return { label: 'Overview — zoom in for detail', detail: `${rooms}: drawn as a pixel overview. Zoom in to restore full detail and room picking.` };
        }
        if (lod.mode === 'roomsOnly') {
            return { label: 'Exits hidden — zoom in for detail', detail: `${rooms}: exit lines are skipped at this zoom. Zoom in to draw them.` };
        }
        if (!lod.hitTestActive) {
            return { label: 'Room picking off — zoom in', detail: `${rooms}: the hit-test index is skipped at this zoom, so clicks and hover don't resolve to a room. Zoom in to restore it.` };
        }
        return null;
    })();

    // Mudlet's dlgMapper collapse arrow (mapper.ui: toolButton_togglePanel).
    // Lives at the right end of the control bar, and the bar itself stays
    // mounted when collapsed (as a bare strip holding just the arrow) so the
    // arrow doesn't jump as the bar's contents come and go. That does mean a
    // package stylesheet hiding `widget_panel` takes the arrow with it —
    // deliberate: a hidden bar shouldn't leave a control floating on the map.
    const panelToggle = (
        <button
            className="map-panel-toggle"
            data-qt-object={QT_OBJECT_NAMES.mapperPanelToggle}
            onClick={togglePanel}
            title={panelVisible ? 'Hide map controls' : 'Show map controls'}
            aria-label={panelVisible ? 'Hide map controls' : 'Show map controls'}
        >{panelVisible ? '▾' : '▴'}</button>
    );

    return (
        <div className="map-panel">
            <div ref={containerRef} className="map-canvas-container" />
            {mapInfos.length > 0 && (
                <div className="map-info" style={{ background: mapInfoBg }}>
                    {mapInfos.map(info => (
                        <div
                            key={info.label}
                            className="map-info-entry"
                            style={{
                                fontWeight: info.isBold ? 700 : undefined,
                                fontStyle: info.isItalic ? 'italic' : undefined,
                                color: info.color ? `rgb(${info.color.r}, ${info.color.g}, ${info.color.b})` : undefined,
                            }}
                        >
                            {info.text}
                        </div>
                    ))}
                </div>
            )}
            {lodNotice && (
                <div className="map-lod-badge" title={lodNotice.detail}>{lodNotice.label}</div>
            )}
            {mapSource.elements}
            <div
                className={`map-panel-toolbar${panelVisible ? '' : ' map-panel-toolbar--collapsed'}`}
                data-qt-object={QT_OBJECT_NAMES.mapperPanel}
            >
            {panelVisible && (<>
                {status === 'ready' && areas.length > 1 && (
                    <div className="map-area-dropdown" ref={dropdownRef} data-qt-object={QT_OBJECT_NAMES.mapperAreaSelector}>
                        <button
                            className="map-area-dropdown-btn"
                            onClick={() => setDropdownOpen(v => !v)}
                        >
                            <span className="map-area-dropdown-label">{currentAreaName}</span>
                            <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
                                <path d="M0 0l4 5 4-5z" fill="currentColor" />
                            </svg>
                        </button>
                        {dropdownOpen && (
                            <div className="map-area-dropdown-list">
                                {areas.map(a => (
                                    <div
                                        key={a.id}
                                        className={`map-area-dropdown-item${a.id === currentArea ? ' map-area-dropdown-item--active' : ''}`}
                                        onMouseDown={() => selectArea(a.id)}
                                    >
                                        {a.name}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {status === 'ready' && levels.length > 1 && (
                    <div className="map-level-controls">
                        <button
                            className="btn btn--secondary btn--sm"
                            data-qt-object={QT_OBJECT_NAMES.mapperShiftZup}
                            onClick={() => handleLevelChange(1)}
                            disabled={levels.indexOf(currentLevel) >= levels.length - 1}
                            title="Level up"
                        >▲</button>
                        <div className="map-area-dropdown map-level-dropdown" ref={levelDropdownRef}>
                            <button
                                className="map-area-dropdown-btn"
                                onClick={() => setLevelDropdownOpen(v => !v)}
                                title="Z-level"
                            >
                                <span className="map-area-dropdown-label">{`Z ${currentLevel}`}</span>
                                <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
                                    <path d="M0 0l4 5 4-5z" fill="currentColor" />
                                </svg>
                            </button>
                            {levelDropdownOpen && (
                                <div className="map-area-dropdown-list">
                                    {[...levels].sort((a, b) => b - a).map(l => (
                                        <div
                                            key={l}
                                            className={`map-area-dropdown-item${l === currentLevel ? ' map-area-dropdown-item--active' : ''}`}
                                            onMouseDown={() => selectLevel(l)}
                                        >
                                            {`Z ${l}`}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button
                            className="btn btn--secondary btn--sm"
                            data-qt-object={QT_OBJECT_NAMES.mapperShiftZdown}
                            onClick={() => handleLevelChange(-1)}
                            disabled={levels.indexOf(currentLevel) <= 0}
                            title="Level down"
                        >▼</button>
                    </div>
                )}
                <div className="map-hamburger" ref={menuRef}>
                    <button
                        className="map-hamburger-btn"
                        data-qt-object={QT_OBJECT_NAMES.mapperMenu}
                        onClick={() => setMenuOpen(v => !v)}
                        title="Map options"
                    >
                        <span /><span /><span />
                    </button>
                    {menuOpen && (
                        <div className="map-hamburger-menu">
                            <button
                                className="map-hamburger-item"
                                onMouseDown={e => { setMenuOpen(false); mapSource.open(e.currentTarget); }}
                            >
                                Load map…
                            </button>
                            {mmpMapUrl && (
                                <button
                                    className="map-hamburger-item"
                                    onMouseDown={() => { setMenuOpen(false); manager.onDownloadMap?.(); }}
                                >
                                    Download map from game
                                </button>
                            )}
                            <button
                                className="map-hamburger-item"
                                onMouseDown={() => { setMenuOpen(false); setEditorOpen(true); }}
                            >
                                Edit map…
                            </button>
                            <div className="map-hamburger-separator" />
                            <div
                                ref={flyoutItemRef}
                                className="map-hamburger-flyout"
                                onMouseEnter={openInfoFlyout}
                                onMouseLeave={scheduleFlyoutClose}
                            >
                                <div className="map-hamburger-item map-hamburger-item--expand">
                                    <span>Map info overlays</span>
                                    <span className="map-hamburger-chevron">{flyoutSide === 'left' ? '◂' : '▸'}</span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </>
            )}
            {panelToggle}
            </div>
            {menuOpen && infoOverlaysOpen && createPortal(
                <div
                    ref={flyoutListRef}
                    className="map-hamburger-sublist"
                    style={flyoutStyle}
                    onMouseEnter={cancelFlyoutClose}
                    onMouseLeave={scheduleFlyoutClose}
                >
                    <label
                        className="map-hamburger-check"
                        onMouseDown={(e) => { e.preventDefault(); disableAllInfoContributors(); }}
                    >
                        <input type="checkbox" readOnly checked={infoContributors.every(c => !c.enabled)} />
                        <span>None</span>
                    </label>
                    {infoContributors.map(c => (
                        <label
                            key={c.label}
                            className="map-hamburger-check"
                            onMouseDown={(e) => { e.preventDefault(); toggleInfoContributor(c.label, c.enabled); }}
                        >
                            <input type="checkbox" readOnly checked={c.enabled} />
                            <span>{c.label}</span>
                        </label>
                    ))}
                </div>,
                document.body,
            )}
            {status === 'loading' && (
                <div className="map-overlay">
                    <span>{loadProgress?.phase === 'building' ? 'Drawing map…' : 'Loading map…'}</span>
                    {loadProgress && (
                        // Determinate only while rooms are streaming and the
                        // header has told us how many to expect. Before the
                        // header, and again once the renderer takes over (whose
                        // progress we can't see into), the bar sweeps instead of
                        // parking at a number that has stopped moving.
                        <div
                            className={`map-progress${determinateProgress ? '' : ' map-progress--indeterminate'}`}
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={determinateProgress ? loadProgress.total : undefined}
                            aria-valuenow={determinateProgress ? loadProgress.loaded : undefined}
                            aria-label="Map load progress"
                        >
                            <div
                                className="map-progress-fill"
                                style={determinateProgress
                                    ? { width: `${Math.min(100, (loadProgress.loaded / loadProgress.total) * 100)}%` }
                                    : undefined}
                            />
                        </div>
                    )}
                    {loadProgress && loadProgress.total > 0 && (
                        <span className="map-overlay-hint">
                            {loadProgress.phase === 'building'
                                ? `${loadProgress.total.toLocaleString()} rooms loaded — drawing`
                                : `${loadProgress.loaded.toLocaleString()} / ${loadProgress.total.toLocaleString()} rooms`}
                        </span>
                    )}
                </div>
            )}
            {status === 'empty' && (
                <div className="map-overlay">
                    <button className="map-load-btn" onClick={e => mapSource.open(e.currentTarget)}>
                        Load Mudlet Map
                    </button>
                    {mmpMapUrl && (
                        <button className="map-load-btn" onClick={() => manager.onDownloadMap?.()}>
                            Download map from game
                        </button>
                    )}
                    <span className="map-overlay-hint">…or run your mapper script to add rooms</span>
                </div>
            )}
            {status === 'error' && (
                <div className="map-overlay map-overlay-error">
                    <span>Failed to load map: {errorMsg}</span>
                    <button className="map-load-btn" onClick={e => mapSource.open(e.currentTarget)}>
                        Try another file
                    </button>
                </div>
            )}
            {contextMenu && createPortal(
                <MapContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    roomId={contextMenu.roomId}
                    items={contextMenu.items}
                    builtinItems={contextMenu.hasRoom ? [
                        {
                            label: 'Set player location',
                            onClick: () => {
                                // Mudlet `sysManualLocationSetEvent(roomID)` —
                                // fires when the user pins the player room via
                                // the map's right-click action.
                                manager.onRaiseEvent?.('sysManualLocationSetEvent', [contextMenu.roomId]);
                                // Go through the shared store (setPlayerRoom +
                                // fan-out to every panel's centerView callback),
                                // not just this panel's local view: pinning the
                                // player room must update getPlayerRoom() so the
                                // map-info overlay has a room to describe and any
                                // other open map panel follows. Calling the local
                                // centerViewImpl alone left the store stale, so a
                                // later notify() (e.g. toggling map info) snapped
                                // the marker back to the previous player room.
                                manager.centerView(contextMenu.roomId);
                                setContextMenu(null);
                            },
                        },
                    ] : []}
                    onClose={() => setContextMenu(null)}
                    onSelect={(uniqueName) => {
                        manager.mapStore.dispatchMapEvent(uniqueName, contextMenu.roomId);
                        setContextMenu(null);
                    }}
                />,
                document.body,
            )}
            {editorOpen && (
                <MapEditorModal
                    connectionId={connectionId}
                    connectionName={connectionName}
                    manager={manager}
                    onClose={() => setEditorOpen(false)}
                />
            )}
        </div>
    );
}

// Right-click menu for the map. Items with `parent` referencing another item's
// uniqueName nest as submenus that open on hover. Clicking a leaf dispatches
// the registered Lua event via mapStore.dispatchMapEvent.
interface MapContextMenuBuiltin {
    label: string;
    onClick: () => void;
}

interface MapContextMenuProps {
    x: number;
    y: number;
    roomId: number;
    items: MapEventEntry[];
    /** Client-provided items rendered above user entries, separated by a divider. */
    builtinItems: MapContextMenuBuiltin[];
    onSelect: (uniqueName: string) => void;
    onClose: () => void;
}

function MapContextMenu({ x, y, items, builtinItems, onSelect }: MapContextMenuProps) {
    const childrenByParent = new Map<string | null, MapEventEntry[]>();
    for (const item of items) {
        const key = item.parent ?? null;
        const arr = childrenByParent.get(key) ?? [];
        arr.push(item);
        childrenByParent.set(key, arr);
    }
    const topLevel = childrenByParent.get(null) ?? [];
    if (topLevel.length === 0 && builtinItems.length === 0) return null;

    return (
        <div
            id="mudix-map-context-menu"
            className="map-context-menu"
            style={{ left: x, top: y }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {builtinItems.map((builtin, i) => (
                <div
                    key={`builtin-${i}`}
                    className="map-context-menu-item"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        builtin.onClick();
                    }}
                >
                    <span className="map-context-menu-label">{builtin.label}</span>
                </div>
            ))}
            {builtinItems.length > 0 && topLevel.length > 0 && (
                <div className="map-context-menu-separator" />
            )}
            {topLevel.map(item => (
                <MapContextMenuItem
                    key={item.uniqueName}
                    item={item}
                    childrenByParent={childrenByParent}
                    onSelect={onSelect}
                />
            ))}
        </div>
    );
}

interface MapContextMenuItemProps {
    item: MapEventEntry;
    childrenByParent: Map<string | null, MapEventEntry[]>;
    onSelect: (uniqueName: string) => void;
}

function MapContextMenuItem({ item, childrenByParent, onSelect }: MapContextMenuItemProps) {
    const [submenuOpen, setSubmenuOpen] = useState(false);
    const children = childrenByParent.get(item.uniqueName) ?? [];
    const hasChildren = children.length > 0;

    return (
        <div
            className="map-context-menu-item"
            onMouseEnter={() => hasChildren && setSubmenuOpen(true)}
            onMouseLeave={() => hasChildren && setSubmenuOpen(false)}
            onMouseDown={(e) => {
                e.stopPropagation();
                onSelect(item.uniqueName);
            }}
        >
            <span className="map-context-menu-label">{item.displayName}</span>
            {hasChildren && <span className="map-context-menu-arrow">▶</span>}
            {hasChildren && submenuOpen && (
                <div className="map-context-menu map-context-menu--submenu">
                    {children.map(child => (
                        <MapContextMenuItem
                            key={child.uniqueName}
                            item={child}
                            childrenByParent={childrenByParent}
                            onSelect={onSelect}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
