import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../storage';
import { clampFillerOffset, isEffectivelyEnabled, type ButtonLocation, type ButtonNode } from '../../storage/schema';
import type { ScriptingEngine } from '../../scripting/ScriptingEngine';
import type { ProfileVFS } from '../../scripting/vfs/ProfileVFS';
import { cssTextToStyle } from '../labels/qtCss';
import './ButtonsBar.css';

const ICON_MIME: Record<string, string> = {
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    svg:  'image/svg+xml',
    bmp:  'image/bmp',
    ico:  'image/x-icon',
};

const EMPTY: ButtonNode[] = [];

interface ToolbarStripProps {
    side: ButtonLocation;
    toolbars: ButtonNode[];
    allButtons: ButtonNode[];
    engineRef: RefObject<ScriptingEngine | null>;
    vfs: ProfileVFS | null;
    onStateChange: (id: string, next: boolean) => void;
}

interface ButtonViewProps {
    button: ButtonNode;
    engineRef: RefObject<ScriptingEngine | null>;
    vfs: ProfileVFS | null;
    onStateChange: (id: string, next: boolean) => void;
}

function resolveIconUrl(vfs: ProfileVFS | null, iconPath: string): string | null {
    if (!vfs || !iconPath) return null;
    // Try a few likely locations: absolute, relative to profile root.
    const candidates = iconPath.startsWith('/')
        ? [iconPath]
        : [`${vfs.profilePath}/${iconPath}`, iconPath];
    for (const path of candidates) {
        try {
            if (!vfs.exists(path)) continue;
            const bytes = vfs.readBinaryFile(path);
            const ext = iconPath.split('.').pop()?.toLowerCase() ?? '';
            const mime = ICON_MIME[ext] ?? 'application/octet-stream';
            return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        } catch {
            // Try the next candidate.
        }
    }
    return null;
}

function ButtonView({ button, engineRef, vfs, onStateChange }: ButtonViewProps) {
    const [iconUrl, setIconUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!button.icon) { setIconUrl(null); return; }
        const url = resolveIconUrl(vfs, button.icon);
        setIconUrl(url);
        return () => { if (url) URL.revokeObjectURL(url); };
    }, [vfs, button.icon]);

    const handleClick = () => {
        const next = button.isPushDown ? !button.buttonState : true;
        engineRef.current?.executeButton(button, next);
        if (button.isPushDown) onStateChange(button.id, next);
    };

    const pressed = button.isPushDown && button.buttonState;
    // Mudlet paints a rotated button by turning the whole control
    // (TFlipButton::paintEvent): index 1 rotates the painter +90° (content reads
    // downwards), index 2 rotates it -90° (content reads upwards). Both transpose
    // the button's size hint, which `writing-mode: vertical-rl` reproduces for
    // free — the icon needs its own turn on top, since writing mode only turns text.
    const rotClass = button.rotation === 1 ? 'mudix-btn--rot-cw'
        : button.rotation === 2 ? 'mudix-btn--rot-ccw'
        : '';
    const cls = [
        'mudix-btn',
        pressed ? 'mudix-btn--pressed' : '',
        button.isPushDown ? 'mudix-btn--toggle' : '',
        rotClass,
    ].filter(Boolean).join(' ');

    // Mudlet setButtonStyleSheet stores a Qt-style stylesheet on the node;
    // convert to inline React style here. Only the flat-declarations subset is
    // applied — pseudo-state selectors (`:hover`, `:pressed`) drop through.
    const sheet = button.styleSheet
        ? cssTextToStyle(button.styleSheet)
        : undefined;

    return (
        <button
            type="button"
            className={cls}
            title={button.tooltip || button.name}
            aria-pressed={button.isPushDown ? pressed : undefined}
            onClick={handleClick}
            style={sheet}
        >
            {iconUrl
                ? <img className="mudix-btn__icon" src={iconUrl} alt="" />
                : <span className="mudix-btn__label">{button.name}</span>}
        </button>
    );
}

function leavesOf(toolbar: ButtonNode, allButtons: ButtonNode[]): ButtonNode[] {
    return allButtons.filter(b =>
        b.parentId === toolbar.id && !b.isGroup && isEffectivelyEnabled(b, allButtons),
    );
}

function renderToolbarGroup(
    toolbar: ButtonNode,
    leaves: ButtonNode[],
    engineRef: RefObject<ScriptingEngine | null>,
    vfs: ProfileVFS | null,
    onStateChange: (id: string, next: boolean) => void,
): React.ReactNode {
    if (leaves.length === 0) return null;
    const cols = toolbar.columns ?? 0;
    const useGrid = cols > 0;
    // Mudlet's filler widget: `mButtonFillerOffset` blank cells held at (0, 0)
    // before the first button (TToolBar::finalize / TEasyButtonBar::finalize,
    // Mudlet #9332). Only ever placed when the toolbar actually wraps — desktop
    // disables the spin box below 2 rows/columns.
    // Clamped the same way the editor clamps on save, so a profile written
    // elsewhere with an offset >= its row count can't spill the grid into
    // implicit tracks and push every button out of the layout.
    const filler = clampFillerOffset(toolbar.fillerOffset ?? 0, cols);
    const tbCls = useGrid
        ? `mudix-buttonbar mudix-buttonbar--grid mudix-buttonbar--${toolbar.orientation}`
        : `mudix-buttonbar mudix-buttonbar--${toolbar.orientation}`;
    // Mudlet's buttonColumn = cross-axis cell count, so the role flips:
    //   horizontal toolbar → N rows, buttons fill column-by-column
    //   vertical toolbar   → N columns, buttons fill row-by-row
    const gridStyle: React.CSSProperties | undefined = useGrid
        ? toolbar.orientation === 'horizontal'
            ? { gridTemplateRows: `repeat(${cols}, auto)`, gridAutoFlow: 'column' }
            : { gridTemplateColumns: `repeat(${cols}, minmax(0, auto))` }
        : undefined;
    // A toolbar's own <css>, applied the way desktop applies it to the TToolBar
    // widget. Merged under the grid geometry so a stylesheet cannot break the
    // layout the row/column setting asked for.
    const sheet = toolbar.styleSheet ? cssTextToStyle(toolbar.styleSheet) : undefined;
    return (
        <div className={tbCls} style={{ ...sheet, ...gridStyle }} title={toolbar.name}>
            {filler > 0 && (
                <div
                    className="mudix-buttonbar__filler"
                    aria-hidden="true"
                    style={toolbar.orientation === 'horizontal'
                        ? { gridRow: `span ${filler}` }
                        : { gridColumn: `span ${filler}` }}
                />
            )}
            {leaves.map(b => (
                <ButtonView
                    key={b.id}
                    button={b}
                    engineRef={engineRef}
                    vfs={vfs}
                    onStateChange={onStateChange}
                />
            ))}
        </div>
    );
}

function ToolbarStrip({ side, toolbars, allButtons, engineRef, vfs, onStateChange }: ToolbarStripProps) {
    if (toolbars.length === 0) return null;
    const cls = `mudix-toolbar-strip mudix-toolbar-strip--${side}`;
    return (
        <div className={cls}>
            {toolbars.map(toolbar => (
                <Fragment key={toolbar.id}>
                    {renderToolbarGroup(toolbar, leavesOf(toolbar, allButtons), engineRef, vfs, onStateChange)}
                </Fragment>
            ))}
        </div>
    );
}

// Default off-edge inset for floating toolbars whose geometry hasn't been
// persisted yet (or got nuked to (0, 0) on Mudlet import).
const FLOATING_DEFAULT_X = 24;
const FLOATING_DEFAULT_Y = 24;

/**
 * Clamp a position so at least `EDGE_MARGIN` of the toolbar stays inside the
 * viewport — protects against window-resize / stale-coords cases where the
 * persisted (posX, posY) would put the chrome fully offscreen.
 */
const EDGE_MARGIN = 32;
function clampToViewport(
    pos: { x: number; y: number },
    el: HTMLElement | null,
): { x: number; y: number } {
    const w = el?.offsetWidth  ?? 80;
    const h = el?.offsetHeight ?? 32;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minX = EDGE_MARGIN - w;
    const minY = 0;
    const maxX = Math.max(minX, vw - EDGE_MARGIN);
    const maxY = Math.max(minY, vh - h);
    return {
        x: Math.max(minX, Math.min(maxX, pos.x)),
        y: Math.max(minY, Math.min(maxY, pos.y)),
    };
}

interface FloatingToolbarProps {
    toolbar: ButtonNode;
    children: React.ReactNode;
    onPositionChange: (x: number, y: number) => void;
}

function FloatingToolbar({ toolbar, children, onPositionChange }: FloatingToolbarProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
        x: toolbar.posX ?? FLOATING_DEFAULT_X,
        y: toolbar.posY ?? FLOATING_DEFAULT_Y,
    }));
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

    // Sync to external pos changes and clamp into viewport. Skip while a drag
    // is in flight so a concurrent store update doesn't yank the toolbar back.
    useLayoutEffect(() => {
        if (dragRef.current) return;
        setPos(clampToViewport(
            { x: toolbar.posX ?? FLOATING_DEFAULT_X, y: toolbar.posY ?? FLOATING_DEFAULT_Y },
            ref.current,
        ));
    }, [toolbar.posX, toolbar.posY]);

    useEffect(() => {
        const onResize = () => setPos(prev => clampToViewport(prev, ref.current));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        setPos(clampToViewport(
            { x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) },
            ref.current,
        ));
    };
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        dragRef.current = null;
        onPositionChange(pos.x, pos.y);
    };

    return (
        <div ref={ref} className="mudix-floating-toolbar" style={{ left: pos.x, top: pos.y }}>
            <div
                className="mudix-floating-toolbar__handle"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                title={`Drag to move "${toolbar.name}"`}
            >
                <span className="mudix-floating-toolbar__handle-label">{toolbar.name}</span>
            </div>
            {children}
        </div>
    );
}

interface FloatingToolbarsLayerProps {
    toolbars: ButtonNode[];
    allButtons: ButtonNode[];
    engineRef: RefObject<ScriptingEngine | null>;
    vfs: ProfileVFS | null;
    onStateChange: (id: string, next: boolean) => void;
    onPositionChange: (id: string, x: number, y: number) => void;
}

function FloatingToolbarsLayer({
    toolbars, allButtons, engineRef, vfs, onStateChange, onPositionChange,
}: FloatingToolbarsLayerProps) {
    const renderable = useMemo(
        () => toolbars
            .map(t => ({ toolbar: t, leaves: leavesOf(t, allButtons) }))
            .filter(({ leaves }) => leaves.length > 0),
        [toolbars, allButtons],
    );
    if (renderable.length === 0) return null;
    return createPortal(
        <div className="mudix-floating-toolbars-root">
            {renderable.map(({ toolbar, leaves }) => (
                <FloatingToolbar
                    key={toolbar.id}
                    toolbar={toolbar}
                    onPositionChange={(x, y) => onPositionChange(toolbar.id, x, y)}
                >
                    {renderToolbarGroup(toolbar, leaves, engineRef, vfs, onStateChange)}
                </FloatingToolbar>
            ))}
        </div>,
        document.body,
    );
}

interface ButtonsLayerProps {
    connectionId: string;
    engineRef: RefObject<ScriptingEngine | null>;
    vfs: ProfileVFS | null;
}

/**
 * Returns the four edge strips of toolbars (top/bottom/left/right). The caller
 * places each strip in the appropriate spot inside ContentLayout.
 */
export function useButtonStrips({ connectionId, engineRef, vfs }: ButtonsLayerProps) {
    const buttons = useAppStore(s => connectionId ? (s.connectionButtons[connectionId] ?? EMPTY) : EMPTY);
    const updateButton = useAppStore(s => s.updateButton);

    const onStateChange = (id: string, next: boolean) => {
        updateButton(connectionId, id, { buttonState: next });
    };

    const onPositionChange = (id: string, x: number, y: number) => {
        updateButton(connectionId, id, { posX: Math.round(x), posY: Math.round(y) });
    };

    const enabledToolbars = useMemo(
        () => buttons.filter(b => b.isGroup && isEffectivelyEnabled(b, buttons)),
        [buttons],
    );

    const byLocation = (loc: ButtonLocation) => enabledToolbars.filter(t => t.location === loc);

    const strip = (side: ButtonLocation) => (
        <ToolbarStrip
            side={side}
            toolbars={byLocation(side)}
            allButtons={buttons}
            engineRef={engineRef}
            vfs={vfs}
            onStateChange={onStateChange}
        />
    );

    const floating = (
        <FloatingToolbarsLayer
            toolbars={byLocation('floating')}
            allButtons={buttons}
            engineRef={engineRef}
            vfs={vfs}
            onStateChange={onStateChange}
            onPositionChange={onPositionChange}
        />
    );

    return {
        top:      strip('top'),
        bottom:   strip('bottom'),
        left:     strip('left'),
        right:    strip('right'),
        floating,
    };
}
