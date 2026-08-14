import { useLayoutEffect, useRef } from 'react';
import type { DockSide, DragState, MxpTabPage } from '../windows/types';
import type { WindowManager } from '../windows/WindowManager';
import { detectDock } from './dockDetect';

interface ScriptWindowProps {
    id: string;
    title: string;
    kind: 'text' | 'html' | 'map';
    visible: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    manager: WindowManager;
    /** Miniconsoles render bare: no titlebar, no border, no drag, no resize.
     *  Position and size are script-controlled. */
    isMiniConsole?: boolean;
    /** When true, dragging the titlebar still moves the window but never
     *  enters a dock zone — mirrors Mudlet's openUserWindow(..., autoDock=false). */
    lockFloating?: boolean;
    /** MXP `<FRAME TITLE=…>` tab strip drawn above the content. The first page
     *  is this window's own console; the rest are `DOCK`ed frames nested inside
     *  its viewport. See MxpFrameManager. */
    frameTabs?: { pages: MxpTabPage[]; active: string };
    /** Console backing an MXP `<FRAME>` — outlines it, like Mudlet does. */
    isMxpFrame?: boolean;
    onFocus:            () => void;
    onMoved:            (x: number, y: number) => void;
    onResized:          (w: number, h: number) => void;
    onDock: (side: DockSide, slotIndex: number, stackTargetId?: string, splitTargetId?: string, splitBefore?: boolean) => void;
    onDragStateChange:       (ds: DragState | null) => void;
    onTitlebarContextMenu:   (e: React.MouseEvent) => void;
    onHide:                  () => void;
}

export function ScriptWindow({
    id, title, visible,
    x, y, width, height, zIndex,
    manager, isMiniConsole, lockFloating, frameTabs, isMxpFrame,
    onFocus, onMoved, onResized, onDock, onDragStateChange, onTitlebarContextMenu, onHide,
}: ScriptWindowProps) {
    const windowRef  = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    // Attach the window's persistent portal-target div into our content slot.
    // useLayoutEffect runs before paint — no flash, and the panel's useEffect
    // (renderer setup) fires after attachment so layout measurements are correct.
    useLayoutEffect(() => {
        const slot   = contentRef.current;
        const target = manager.getPortalTarget(id);
        if (!slot || !target) return;
        slot.appendChild(target);
        return () => {
            if (target.parentNode === slot) slot.removeChild(target);
        };
    }, [manager, id]);

    // ── Title bar drag ────────────────────────────────────────────────────────

    const handleTitlebarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        if ((e.target as Element).closest('.script-window-btn')) return;
        e.preventDefault();
        onFocus();

        const el = windowRef.current;
        if (!el) return;

        // Offset of the click within the window (container is position:fixed inset:0
        // so offsetLeft === viewport X, same coordinate space as clientX).
        const startOffsetX = e.clientX - el.offsetLeft;
        const startOffsetY = e.clientY - el.offsetTop;
        let lastX = el.offsetLeft;
        let lastY = el.offsetTop;
        let lastClientX = e.clientX;
        let lastClientY = e.clientY;
        let potentialDock: DockSide | null = null;
        let potentialSlot = 0;
        let potentialStackTarget: string | undefined;
        let potentialSplitTarget: string | undefined;
        let potentialSplitBefore: boolean | undefined;

        const updateDockState = (shiftHeld: boolean, clientX: number, clientY: number) => {
            // lockFloating windows (Mudlet autoDock=false) never enter a dock
            // zone — same shape as shift-suppressed drags. Holding shift while
            // dragging is still useful for unlocked windows to drag past a
            // dock band without it activating.
            const { side, slotIndex, stackTargetId, splitTargetId, splitBefore } = (shiftHeld || lockFloating)
                ? { side: null, slotIndex: 0, stackTargetId: undefined, splitTargetId: undefined, splitBefore: undefined }
                : detectDock(clientX, clientY);

            if (side !== potentialDock || slotIndex !== potentialSlot || stackTargetId !== potentialStackTarget || splitTargetId !== potentialSplitTarget) {
                potentialDock        = side;
                potentialSlot        = slotIndex;
                potentialStackTarget = stackTargetId;
                potentialSplitTarget = splitTargetId;
                potentialSplitBefore = splitBefore;
                onMoved(lastX, lastY);
                onDragStateChange(side
                    ? { panelId: id, potentialDock: side, insertSlotIndex: slotIndex, stackTargetId, splitTargetId, splitBefore }
                    : null);
            }
        };

        const onMove = (ev: PointerEvent) => {
            lastClientX = ev.clientX;
            lastClientY = ev.clientY;
            lastX = ev.clientX - startOffsetX;
            lastY = ev.clientY - startOffsetY;

            // Direct DOM update every frame for smooth drag.
            el.style.left = `${lastX}px`;
            el.style.top  = `${lastY}px`;

            updateDockState(ev.shiftKey, ev.clientX, ev.clientY);
        };

        const onKeyChange = (ev: KeyboardEvent) => {
            if (ev.key !== 'Shift') return;
            updateDockState(ev.type === 'keydown', lastClientX, lastClientY);
        };

        const onUp = () => {
            onDragStateChange(null);
            if (potentialDock !== null) {
                onDock(potentialDock, potentialSlot, potentialStackTarget, potentialSplitTarget, potentialSplitBefore);
            } else {
                onMoved(lastX, lastY);
            }
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('keydown', onKeyChange);
            document.removeEventListener('keyup', onKeyChange);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('keydown', onKeyChange);
        document.addEventListener('keyup', onKeyChange);
    };

    // ── Edge / corner resize ──────────────────────────────────────────────────

    const makeResizeHandler = (dir: string) => (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onFocus();

        const el = windowRef.current;
        if (!el) return;

        const startX    = e.clientX;
        const startY    = e.clientY;
        const startW    = el.offsetWidth;
        const startH    = el.offsetHeight;
        const startLeft = el.offsetLeft;
        const startTop  = el.offsetTop;
        let lastW = startW, lastH = startH, lastLeft = startLeft, lastTop = startTop;

        const onMove = (ev: PointerEvent) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;

            if (dir.includes('e')) lastW = Math.max(150, startW + dx);
            if (dir.includes('w')) {
                const newW = Math.max(150, startW - dx);
                lastLeft = startLeft + startW - newW;
                lastW = newW;
            }
            if (dir.includes('s')) lastH = Math.max(80, startH + dy);
            if (dir.includes('n')) {
                const newH = Math.max(80, startH - dy);
                lastTop = startTop + startH - newH;
                lastH = newH;
            }

            el.style.width  = `${lastW}px`;
            el.style.height = `${lastH}px`;
            el.style.left   = `${lastLeft}px`;
            el.style.top    = `${lastTop}px`;
        };

        const onUp = () => {
            onResized(lastW, lastH);
            if (dir.includes('w') || dir.includes('n')) onMoved(lastLeft, lastTop);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup',  onUp);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup',  onUp);
    };

    return (
        <div
            ref={windowRef}
            className={`script-window${isMiniConsole ? ' script-window--miniconsole' : ''}${isMxpFrame ? ' script-window--mxp-frame' : ''}`}
            data-window-id={id}
            style={{ left: x, top: y, width, height, zIndex, display: visible ? 'flex' : 'none' }}
            // Click-to-front applies to real windows only. A mini-console (and
            // the embedded Geyser mapper, which is one) is a bare child widget
            // with no chrome — in Mudlet, clicking or dragging inside such a
            // QWidget never raises it; only an explicit raiseWindow() does.
            // Firing onFocus here instead pushed it to the front of the flat
            // per-viewport overlay stack it shares with the parent's labels
            // (see overlayLayerOrder.ts), so panning the map made every label
            // drawn on top of it vanish underneath.
            onPointerDown={isMiniConsole ? undefined : onFocus}
        >
            {!isMiniConsole && (
                <div className="script-window-titlebar" onPointerDown={handleTitlebarPointerDown} onContextMenu={onTitlebarContextMenu}>
                    <span className="script-window-title">{title}</span>
                    <button className="script-window-btn popout" title="Pop out to a separate window" onClick={() => manager.popOut(id)}>⧉</button>
                    <button className="script-window-btn close" title="Close" onClick={onHide}>×</button>
                </div>
            )}
            {frameTabs && (
                <div className="mxp-frame-tabs" role="tablist">
                    {frameTabs.pages.map(page => (
                        <button
                            key={page.id}
                            type="button"
                            role="tab"
                            aria-selected={page.id === frameTabs.active}
                            className={`mxp-frame-tab${page.id === frameTabs.active ? ' active' : ''}`}
                            onClick={() => manager.selectFrameTab(id, page.id)}
                        >
                            {page.title}
                        </button>
                    ))}
                </div>
            )}
            <div className="script-window-content" ref={contentRef} />
            {!isMiniConsole && (['n','s','e','w','ne','nw','se','sw'] as const).map(dir => (
                <div key={dir} className={`script-window-resize-${dir}`} onPointerDown={makeResizeHandler(dir)} />
            ))}
        </div>
    );
}
