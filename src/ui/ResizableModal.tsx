import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModalBounds } from '../storage/schema';
import { useModalFocus } from './components/useModalFocus';
import { useViewportMode } from '../hooks/useViewportMode';

type ResizeDir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const DIRS: ResizeDir[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

interface ResizableModalProps {
    title: string;
    onClose: () => void;
    savedBounds?: ModalBounds | null;
    onBoundsChange?: (bounds: ModalBounds) => void;
    minW?: number;
    minH?: number;
    defaultW: number;
    defaultH: number;
    headerExtra?: React.ReactNode;
    className?: string;
    bodyClassName?: string;
    /**
     * Escape closes the dialog. Default true — desktop Mudlet builds this class
     * of window as a `QDialog` (`dlgPackageManager`, `dlgModuleManager`,
     * `dlgPackageExporter`, `dlgProfilePreferences`), and a QDialog rejects on
     * Escape for free.
     *
     * Pass false for the editor-hosting modals, whose desktop counterparts are
     * `QMainWindow`s precisely so Escape stays available to what is inside them:
     * `dlgTriggerEditor` (Mudlet `src/dlgTriggerEditor.h:104`) spends Escape on
     * leaving key-grab mode (`src/dlgTriggerEditor.cpp:12527`), and `dlgNotepad`
     * (`src/dlgNotepad.h:42`) on closing its find bar (`dlgNotepad.cpp:651`) —
     * the same jobs Escape has in ScriptEditorPanel's key capture, LuaEditor and
     * ScriptSearch. May vary over the dialog's life; see `ModalFocusOptions`.
     */
    closeOnEscape?: boolean;
    children: React.ReactNode;
}

export function ResizableModal({
    title,
    onClose,
    savedBounds,
    onBoundsChange,
    minW = 200,
    minH = 150,
    defaultW,
    defaultH,
    headerExtra,
    className,
    bodyClassName,
    closeOnEscape = true,
    children,
}: ResizableModalProps) {
    const [bounds, setBounds] = useState<ModalBounds>(() => savedBounds ?? {
        x: Math.max(0, (window.innerWidth  - defaultW) / 2),
        y: Math.max(0, (window.innerHeight - defaultH) / 2),
        width:  defaultW,
        height: defaultH,
    });

    const boundsRef = useRef(bounds);
    boundsRef.current = bounds;

    // Phones: the @media (≤600px) rules fullscreen this modal and we drop the
    // drag/resize affordances (touch can't use them and a stray drag would save
    // off-screen bounds). Tablets: keep a windowed modal but clamp it so an
    // oversized default (e.g. a 900px editor) can't open partly off-screen.
    const viewport = useViewportMode();
    const isMobile = viewport === 'mobile';
    const interactive = !isMobile;

    const geom = viewport === 'tablet'
        ? clampToViewport(bounds)
        : { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height };

    // The modal renders into its document's <body> rather than wherever it was
    // declared. `position: fixed` escapes layout but NOT its ancestors' stacking
    // contexts, and several of these modals are declared inside a panel — the
    // map editor from MapPanel, the package modals from the script editor. A
    // panel sits under `.script-window` (inline z-index) or `.main-overlay-root`
    // (z:30), each its own stacking context, so the modal's z:40 was ranked only
    // against that panel's siblings and any label/window above the panel painted
    // straight over it. At body level the z:40 band applies as written: above
    // overlays (30) and floating windows (35), below `.modal` (51).
    //
    // Resolved from the anchor's ownerDocument, not the global `document`: a
    // popped-out panel's DOM lives in a child window while its React tree stays
    // here (see PopoutWindow), so a hardcoded `document.body` would yank the
    // modal into the wrong window.
    const anchorRef = useRef<HTMLSpanElement>(null);
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => {
        setPortalTarget(anchorRef.current?.ownerDocument.body ?? null);
    }, []);

    // Focus-in on open, Tab trap, Escape and focus restore for every modal built
    // on this wrapper — what Qt gives desktop Mudlet's dialogs for free.
    //
    // `ready` is load-bearing, not decoration: the dialog lives in the portal
    // above, so `portalTarget` is null on the first render and there is no node
    // for the hook's ref to point at. Without a dependency that flips when the
    // portal mounts, the hook's setup ran once against `ref.current === null`,
    // bailed, and never ran again — carrying `aria-modal="true"` while leaving
    // focus outside and Escape dead. See issue #49.
    const ref = useModalFocus<HTMLDivElement>(onClose, {
        autoFocus: true,
        closeOnEscape,
        ready: portalTarget !== null,
    });

    const commit = () => onBoundsChange?.(boundsRef.current);

    // Tear down an in-flight gesture if the modal unmounts under it — the parent
    // can close the dialog at any time, and the mouse-up that would have cleaned
    // up lands on `window` regardless. Without this its listeners leak and
    // `commit()` fires a bounds save after the component is gone.
    const endGestureRef = useRef<(() => void) | null>(null);
    useEffect(() => () => endGestureRef.current?.(), []);

    /**
     * Shared plumbing for the header drag and the eight resize handles: track
     * the pointer on `window` (so the gesture survives the cursor leaving the
     * modal), commit the bounds on mouse-up, and abandon it on Escape, snapping
     * back to the bounds the gesture started from.
     *
     * Mudlet has nothing to copy here — its dialogs are moved by the window
     * manager, which swallows Escape during a title-bar drag and cancels the
     * move, so Qt never sees the key. That is the behaviour reproduced: the
     * listener is capture-phase on `window` so it settles before the dialog's
     * own Escape-to-close, and the first Escape cancels the move while only a
     * second one closes the dialog.
     */
    const beginGesture = (onMove: (e: MouseEvent) => void) => {
        const origin = boundsRef.current;
        const end = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('keydown', onKey, true);
            endGestureRef.current = null;
        };
        const onUp = () => { end(); commit(); };
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key !== 'Escape') return;
            ke.preventDefault();
            ke.stopPropagation();
            end();
            boundsRef.current = origin;
            setBounds(origin);
        };
        endGestureRef.current = end;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('keydown', onKey, true);
    };

    const handleDragDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        const { x: ox, y: oy } = boundsRef.current;
        const sx = e.clientX, sy = e.clientY;

        beginGesture((me: MouseEvent) => {
            const next = { ...boundsRef.current, x: ox + me.clientX - sx, y: oy + me.clientY - sy };
            boundsRef.current = next;
            setBounds(next);
        });
    };

    const handleResizeDown = (e: React.MouseEvent, dir: ResizeDir) => {
        e.preventDefault();
        e.stopPropagation();
        const { x: ox, y: oy, width: ow, height: oh } = boundsRef.current;
        const sx = e.clientX, sy = e.clientY;

        beginGesture((me: MouseEvent) => {
            const dx = me.clientX - sx, dy = me.clientY - sy;
            let nx = ox, ny = oy, nw = ow, nh = oh;
            if (dir.includes('e')) nw = Math.max(minW, ow + dx);
            if (dir.includes('s')) nh = Math.max(minH, oh + dy);
            if (dir.includes('w')) { nw = Math.max(minW, ow - dx); nx = ox + ow - nw; }
            if (dir.includes('n')) { nh = Math.max(minH, oh - dy); ny = oy + oh - nh; }
            const next = { x: nx, y: ny, width: nw, height: nh };
            boundsRef.current = next;
            setBounds(next);
        });
    };

    const modal = (
        <div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`resizable-modal${className ? ` ${className}` : ''}`}
            style={geom}
        >
            <div className="resizable-modal__header" onMouseDown={interactive ? handleDragDown : undefined}>
                <span className="resizable-modal__title">{title}</span>
                <div className="resizable-modal__header-actions">
                    {headerExtra}
                    <button className="modal-close" onClick={onClose} type="button" aria-label="Close">✕</button>
                </div>
            </div>
            <div className={`resizable-modal__body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
                {children}
            </div>
            {interactive && DIRS.map(dir => (
                <div
                    key={dir}
                    className={`resizable-modal__resize resizable-modal__resize--${dir}`}
                    onMouseDown={e => handleResizeDown(e, dir)}
                />
            ))}
        </div>
    );

    // The anchor stays where the modal was declared purely to name the document
    // to portal into; it is display:none and never painted.
    return (
        <>
            <span ref={anchorRef} hidden />
            {portalTarget && createPortal(modal, portalTarget)}
        </>
    );
}

// Keep a modal fully on-screen at tablet widths: shrink it to fit the viewport
// (with a small margin) and pull it back inside the edges if its saved/centered
// origin would overflow.
function clampToViewport(b: ModalBounds): { left: number; top: number; width: number; height: number } {
    const maxW = window.innerWidth  * 0.96;
    const maxH = window.innerHeight * 0.96;
    const width  = Math.min(b.width,  maxW);
    const height = Math.min(b.height, maxH);
    const left = Math.min(Math.max(0, b.x), Math.max(0, window.innerWidth  - width));
    const top  = Math.min(Math.max(0, b.y), Math.max(0, window.innerHeight - height));
    return { left, top, width, height };
}
