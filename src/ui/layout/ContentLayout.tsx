import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MudSession } from '../../mud/MudSession';
import type { DockSide, DragState, ScriptWindowRenderData } from '../windows/types';
import type { WindowManager } from '../windows/WindowManager';
import { OutputArea } from '../output/OutputArea';
import { DockArea } from './DockArea';
import { MobileLayout } from './MobileLayout';
import { FloatingWindowLayer } from './FloatingWindowLayer';
import { PopoutWindow } from './PopoutWindow';
import { WindowContextMenu } from './WindowContextMenu';
import { TextPanel } from '../windows/panels/TextPanel';
import { HtmlPanel } from '../windows/panels/HtmlPanel';
import { MapPanel } from '../windows/panels/MapPanel';
import { useButtonStrips } from '../buttons/ButtonsBar';
import type { ScriptingEngine } from '../../scripting/ScriptingEngine';
import type { ProfileVFS } from '../../scripting/vfs/ProfileVFS';
import { DEFAULT_STICKY_LINES } from '../../hooks/useOutput';
import { useViewportMode } from '../../hooks/useViewportMode';
import './ScriptWindow.css';

interface ContentLayoutProps {
    session: MudSession;
    manager: WindowManager;
    connectionId: string;
    stickyLines?: number;
    commandInputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
    commandBar?: React.ReactNode;
    contextMenuHandlerRef?: React.RefObject<((e: React.MouseEvent) => void) | null>;
    /** Live ref so button clicks reach the engine even though the ref is set after initial render. */
    scriptingEngineRef?: React.RefObject<ScriptingEngine | null>;
    vfs?: ProfileVFS | null;
}

const NULL_ENGINE_REF: React.RefObject<ScriptingEngine | null> = { current: null };

export function ContentLayout({
    session, manager, connectionId,
    stickyLines = DEFAULT_STICKY_LINES,
    commandInputRef,
    commandBar,
    contextMenuHandlerRef,
    scriptingEngineRef,
    vfs = null,
}: ContentLayoutProps) {
    const [windows,     setWindows]     = useState<ScriptWindowRenderData[]>([]);
    const [dockExtents, setDockExtents] = useState<Record<DockSide, number>>({
        left: 300, right: 300, top: 200, bottom: 200,
    });
    const [dragState,   setDragState]   = useState<DragState | null>(null);
    const [menuPos,     setMenuPos]     = useState<{ x: number; y: number } | null>(null);
    const isMobile = useViewportMode() === 'mobile';

    // The main console lives here for the lifetime of this component and is
    // adopted by whichever layout branch is on screen. See ViewportSlot.
    const outputHostRef = useRef<HTMLDivElement | null>(null);
    if (!outputHostRef.current) {
        outputHostRef.current = document.createElement("div");
        outputHostRef.current.className = "main-viewport";
    }
    const outputHost = outputHostRef.current;

    const handleTitlebarContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setMenuPos({ x: e.clientX, y: e.clientY });
    }, []);

    const handlerRef = useRef(handleTitlebarContextMenu);
    handlerRef.current = handleTitlebarContextMenu;
    useEffect(() => {
        if (contextMenuHandlerRef) {
            contextMenuHandlerRef.current = handlerRef.current;
            return () => { contextMenuHandlerRef.current = null; };
        }
    }, [contextMenuHandlerRef]);

    useEffect(() => {
        manager.onWindowsChange = (ws, extents) => {
            setWindows(ws);
            setDockExtents(extents);
        };
        // Deliver any windows that were opened before we subscribed (e.g. autoOpen
        // windows created by setWindowHints before ContentLayout mounted).
        manager.initialize();
        return () => { manager.onWindowsChange = undefined; };
    }, [manager]);

    const handleSetExtent = (side: DockSide, n: number) => {
        manager.setDockExtent(side, n);
        setDockExtents(prev => ({ ...prev, [side]: n }));
    };

    const dockAreaProps = { manager, dragState, onSetExtent: handleSetExtent, onDragStateChange: setDragState, onTitlebarContextMenu: handleTitlebarContextMenu };

    // Popped-out panels are rendered into their own browser window by
    // PopoutWindow, so they must be excluded from the in-app dock/float layout
    // (the content-pool createPortal below still renders them — only their
    // portal-target div lives in the other window).
    const laidOut    = windows.filter(w => !w.poppedOut);
    const poppedOut  = windows.filter(w => w.poppedOut && w.visible);

    const hasLeft   = laidOut.some(w => w.docked === 'left'   && w.visible);
    const hasRight  = laidOut.some(w => w.docked === 'right'  && w.visible);
    const hasTop    = laidOut.some(w => w.docked === 'top'    && w.visible);
    const hasBottom = laidOut.some(w => w.docked === 'bottom' && w.visible);

    // Show a DockArea when panels are present OR when drag is hovering over that side
    const showLeft   = hasLeft   || dragState?.potentialDock === 'left';
    const showRight  = hasRight  || dragState?.potentialDock === 'right';
    const showTop    = hasTop    || dragState?.potentialDock === 'top';
    const showBottom = hasBottom || dragState?.potentialDock === 'bottom';

    const buttonStrips = useButtonStrips({ connectionId, engineRef: scriptingEngineRef ?? NULL_ENGINE_REF, vfs });

    // Content pool — one panel component per open window, mounted once for its
    // lifetime. Each renders into a stable portal-target div that the layout
    // (dock slots / floating frames on desktop, the mobile switcher on phones)
    // physically moves around without ever unmounting the component. Shared by
    // both the desktop and mobile branches so panel state survives a rotate.
    const contentPool = windows.map(w => createPortal(
        w.kind === 'text' ? <TextPanel id={w.id} title={w.title} manager={manager} labels={session.labels} cmdLines={session.cmdLines} scrollBoxes={session.scrollBoxes} fontSize={w.fontSize} fontFamily={w.fontFamily} lineHeight={w.lineHeight} wrapAt={w.wrapAt} wrapIndent={w.wrapIndent} wrapHangingIndent={w.wrapHangingIndent} backgroundColor={w.backgroundColor} backgroundImage={w.backgroundImage} cmdLineEnabled={w.cmdLineEnabled} cmdLineStyleSheet={w.cmdLineStyleSheet} cmdLineValue={w.cmdLineValue} cmdLineValueSeq={w.cmdLineValueSeq} />
      : w.kind === 'html' ? <HtmlPanel id={w.id} manager={manager} labels={session.labels} cmdLines={session.cmdLines} scrollBoxes={session.scrollBoxes} backgroundColor={w.backgroundColor} backgroundImage={w.backgroundImage} cmdLineEnabled={w.cmdLineEnabled} cmdLineStyleSheet={w.cmdLineStyleSheet} cmdLineValue={w.cmdLineValue} cmdLineValueSeq={w.cmdLineValueSeq} />
      : <MapPanel id={w.id} manager={manager} connectionId={connectionId} vfs={vfs} />,
        manager.getOrCreatePortalTarget(w.id),
        w.id,
    ));

    // Mounted once, portalled into the detached host above, and never
    // re-created by a branch switch.
    const outputPool = createPortal(
        <OutputArea session={session} stickyLines={stickyLines} commandInputRef={commandInputRef} mxpBorders={manager.getMxpBorders()} />,
        outputHost,
    );

    // outputPool sits outside the branch and first in both trees, so React sees
    // the same element in the same slot whichever layout is rendered and keeps
    // OutputArea mounted across a breakpoint crossing. Inside the branches it
    // was two different portals in two different trees, which remounts.
    if (isMobile) {
        return (
            <>
            {outputPool}
            <div className="content-layout">
                <MobileLayout
                    session={session}
                    manager={manager}
                    outputHost={outputHost}
                    windows={laidOut}
                    stickyLines={stickyLines}
                    commandInputRef={commandInputRef}
                    commandBar={commandBar}
                />
                {contentPool}
            </div>
            </>
        );
    }

    return (
        <>
        {outputPool}
        <div className="content-layout">
            {buttonStrips.top}
            {showTop && (
                <DockArea side="top" windows={laidOut} extent={dockExtents.top} {...dockAreaProps} />
            )}

            <div className="content-middle-row">
                {buttonStrips.left}
                {showLeft && (
                    <DockArea side="left" windows={laidOut} extent={dockExtents.left} {...dockAreaProps} />
                )}

                <ViewportSlot host={outputHost} />

                {showRight && (
                    <DockArea side="right" windows={laidOut} extent={dockExtents.right} {...dockAreaProps} />
                )}
                {buttonStrips.right}
            </div>

            {commandBar}

            {showBottom && (
                <DockArea side="bottom" windows={laidOut} extent={dockExtents.bottom} {...dockAreaProps} />
            )}
            {buttonStrips.bottom}

            {/* Floating windows live in a position:fixed portal — completely independent of dock layout */}
            <FloatingWindowLayer
                windows={laidOut}
                manager={manager}
                onDragStateChange={setDragState}
                onTitlebarContextMenu={handleTitlebarContextMenu}
            />

            {buttonStrips.floating}

            {/* Panels detached into their own browser window. Each keeps its
                createPortal entry in the content pool below (component stays
                mounted); PopoutWindow only relocates the portal-target div. */}
            {poppedOut.map(w => (
                <PopoutWindow
                    key={w.id}
                    id={w.id}
                    title={w.title}
                    width={w.width}
                    height={w.height}
                    manager={manager}
                    onClosed={() => manager.popIn(w.id)}
                />
            ))}

            {menuPos && (
                <WindowContextMenu
                    windows={windows}
                    manager={manager}
                    x={menuPos.x}
                    y={menuPos.y}
                    onClose={() => setMenuPos(null)}
                />
            )}

            {contentPool}
        </div>
        </>
    );
}

/**
 * Holds the main console's DOM while a layout branch is on screen, and hands it
 * back when that branch goes away.
 *
 * The console is mounted once, for the lifetime of ContentLayout, into a
 * detached host div; the desktop tree and the phone tree each adopt that div
 * rather than rendering an OutputArea of their own. Crossing the phone
 * breakpoint therefore *moves* the console instead of destroying it.
 *
 * This is the same trick the content pool below uses for panels, and it is not
 * a refinement: OutputArea's renderer appends lines imperatively into the
 * wrapper it was handed at setup, and only ever appends *new* ones. Remounting
 * it handed the renderer a fresh empty wrapper, so every line already on screen
 * vanished while Console.history still held all of them — one resize across
 * 600px emptied a session's scrollback with no way to bring it back.
 *
 * display:contents on the slot keeps the host in the parent's layout, so
 * .main-viewport still measures and flexes exactly as it did before.
 */
export function ViewportSlot({ host, hidden }: { host: HTMLDivElement; hidden?: boolean }) {
    const slotRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const slot = slotRef.current;
        if (!slot) return;
        slot.appendChild(host);
        return () => { if (host.parentNode === slot) slot.removeChild(host); };
    }, [host]);

    useLayoutEffect(() => {
        host.style.display = hidden ? 'none' : '';
    }, [host, hidden]);

    return <div className="main-viewport-slot" ref={slotRef} />;
}
