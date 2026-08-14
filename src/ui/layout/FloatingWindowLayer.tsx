import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DragState, ScriptWindowRenderData } from '../windows/types';
import type { WindowManager } from '../windows/WindowManager';
import { ScriptWindow } from './ScriptWindow';

interface FloatingWindowLayerProps {
    windows: ScriptWindowRenderData[];
    manager: WindowManager;
    onDragStateChange: (ds: DragState | null) => void;
    onTitlebarContextMenu: (e: React.MouseEvent) => void;
}

export function FloatingWindowLayer({ windows, manager, onDragStateChange, onTitlebarContextMenu }: FloatingWindowLayerProps) {
    const floating = windows.filter(w => !w.docked);

    // `zIndexOverride` is set for nested windows: their stacking order must
    // compare directly against sibling labels/cmd-lines/scroll boxes under
    // the same parent (see overlayLayerOrder.ts), not just other windows —
    // so it replaces `w.zIndex` (a global, windows-only counter) instead of
    // being layered under a wrapper-level z-index.
    const renderWindow = (w: ScriptWindowRenderData, zIndexOverride?: number) => w.visible && (
        <ScriptWindow
            key={w.id}
            {...w}
            zIndex={zIndexOverride ?? w.zIndex}
            manager={manager}
            isMiniConsole={manager.isMiniConsole(w.id)}
            lockFloating={w.lockFloating}
            frameTabs={w.frameTabs}
            isMxpFrame={w.isMxpFrame}
            onFocus={()           => manager.bringToFront(w.id)}
            onMoved={(x, y)       => manager.setPosition(w.id, x, y)}
            onResized={(ww, h)    => manager.setSize(w.id, ww, h)}
            onDock={(side, idx, stackTargetId, splitTargetId, splitBefore) =>
                stackTargetId  ? manager.tabIntoGroup(w.id, stackTargetId)
                : splitTargetId ? manager.splitIntoGroup(w.id, splitTargetId, splitBefore ?? false)
                : manager.dock(w.id, side, idx)
            }
            onDragStateChange={onDragStateChange}
            onTitlebarContextMenu={onTitlebarContextMenu}
            onHide={()            => manager.hide(w.id)}
        />
    );

    // Mudlet createMiniConsole(parent, name, ...) nests the miniconsole inside
    // a parent userwindow. We portal those into the parent's viewport so their
    // (x, y) are interpreted relative to the parent, and they follow parent
    // moves/resizes for free. Main-parented miniconsoles portal into the main
    // output viewport so (0, 0) lands at the top of the gameplay area —
    // otherwise they'd render against `position: fixed` document coordinates
    // and overlap the app toolbar. Regular floating windows (no parent) still
    // render into the document-wide floating root so they can be dragged
    // freely across the viewport.
    const rootWindows: ScriptWindowRenderData[] = [];
    const nestedByParent = new Map<string, ScriptWindowRenderData[]>();
    const resolveParent = (w: ScriptWindowRenderData): { id: string; el: HTMLElement } | null => {
        const isMC = manager.isMiniConsole(w.id);
        const parent = w.parent;
        // Explicit userwindow parent, or an unparented mini-console (nests under
        // 'main'). Either way it portals into that viewport's overlay host — the
        // same stacking context its labels/cmd-lines/scroll-boxes live in — so
        // this window's z-index compares directly against theirs. See
        // WindowManager.getOverlayHost.
        const id = (parent && parent !== 'main') ? parent : (isMC ? 'main' : null);
        if (id === null) return null;
        const el = manager.getOverlayHost(id);
        return el ? { id, el } : null;
    };
    for (const w of floating) {
        const resolved = resolveParent(w);
        if (resolved) {
            const list = nestedByParent.get(resolved.id) ?? [];
            list.push(w);
            nestedByParent.set(resolved.id, list);
        } else {
            rootWindows.push(w);
        }
    }

    // The nested wrapper's z-index is shared with its parent's labels / cmd
    // lines / scroll boxes (see overlayLayerOrder.ts) so an embedded mapper
    // or mini-console can out-rank a sibling label — e.g. via Geyser's
    // raiseWindow("mapper") — instead of always painting beneath it. Re-render
    // when any currently-nested parent's order changes.
    const nestedParentIds = [...nestedByParent.keys()];
    const [, setTick] = useState(0);
    useEffect(() => {
        if (nestedParentIds.length === 0) return;
        const unsubs = nestedParentIds.map(id => manager.overlayZ.subscribe(id, () => setTick(t => t + 1)));
        return () => { for (const u of unsubs) u(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manager, nestedParentIds.join(',')]);

    return (
        <>
            {createPortal(
                <div className="floating-window-root">
                    {rootWindows.map(renderWindow)}
                </div>,
                document.body,
            )}
            {[...nestedByParent.entries()].map(([parent, list]) => {
                const target = manager.getOverlayHost(parent)!;
                // No zIndex on the wrapper itself — a positioned element only
                // needs an explicit z-index to start its own stacking context,
                // and this wrapper must NOT start one: each nested window's
                // own z-index (below) has to compare directly against this
                // parent's label/cmd-line/scroll-box siblings, which live in
                // their own separately-portaled wrapper (see LabelOverlay
                // etc.) — trapping them all under one block z-index here is
                // exactly the bug this per-widget ranking replaces.
                return createPortal(
                    <div className="floating-window-root floating-window-root--nested">
                        {list.map(w => renderWindow(w, manager.overlayZ.getZ(parent, 'windows', w.id)))}
                    </div>,
                    target,
                    `nested:${parent}`,
                );
            })}
        </>
    );
}
