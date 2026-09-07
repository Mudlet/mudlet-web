import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { DockSide, DragState, ScriptWindowRenderData } from '../windows/types';
import type { WindowManager } from '../windows/WindowManager';
import { detectDock } from './dockDetect';

const DRAG_THRESHOLD = 5;

interface TabGroupPanelProps {
    side: DockSide;
    panels: ScriptWindowRenderData[];
    activeId: string;
    manager: WindowManager;
    onDragStateChange: (ds: DragState | null) => void;
    onTitlebarContextMenu: (e: React.MouseEvent) => void;
}

export function TabGroupPanel({ side, panels, activeId, manager, onDragStateChange, onTitlebarContextMenu }: TabGroupPanelProps) {
    const sorted = [...panels].sort((a, b) => (a.tabOrder ?? 0) - (b.tabOrder ?? 0));

    return (
        <div className={`tab-group-panel tab-group-panel--${side}`}>
            {sorted.length > 1 && (
                <div className="tab-group-tabbar mudlet-native-scrollbar" onContextMenu={onTitlebarContextMenu}>
                    {sorted.map(p => (
                        <TabItem
                            key={p.id}
                            panel={p}
                            isActive={p.id === activeId}
                            manager={manager}
                            onDragStateChange={onDragStateChange}
                            onActivate={() => manager.setActiveTab(p.id)}
                            onClose={() => manager.hide(p.id)}
                        />
                    ))}
                </div>
            )}
            <TabContent id={activeId} manager={manager} />
        </div>
    );
}

// ── Individual tab ────────────────────────────────────────────────────────────

interface TabItemProps {
    panel: ScriptWindowRenderData;
    isActive: boolean;
    manager: WindowManager;
    onDragStateChange: (ds: DragState | null) => void;
    onActivate: () => void;
    onClose: () => void;
}

function TabItem({ panel, isActive, manager, onDragStateChange, onActivate, onClose }: TabItemProps) {
    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        if ((e.target as Element).closest('.script-window-btn')) return;
        e.preventDefault();
        onActivate();

        const startX = e.clientX;
        const startY = e.clientY;
        const groupEl = (e.currentTarget as HTMLElement).closest<HTMLElement>('.tab-group-panel');
        const panelRect = groupEl?.getBoundingClientRect();
        const offsetX = panelRect ? e.clientX - panelRect.left : 50;
        const offsetY = panelRect ? e.clientY - panelRect.top  : 14;

        let hasDragged = false;
        let floatingEl: HTMLElement | null = null;
        let lastX = 0;
        let lastY = 0;
        let lastClientX = startX;
        let lastClientY = startY;
        let potentialDock: DockSide | null = null;
        let potentialSlot = 0;
        let potentialStackTarget: string | undefined;
        let potentialSplitTarget: string | undefined;
        let potentialSplitBefore: boolean | undefined;

        const updateDockState = (shiftHeld: boolean, clientX: number, clientY: number) => {
            if (!hasDragged || !floatingEl) return;
            const { side, slotIndex, stackTargetId, splitTargetId, splitBefore } = shiftHeld
                ? { side: null, slotIndex: 0, stackTargetId: undefined, splitTargetId: undefined, splitBefore: undefined }
                : detectDock(clientX, clientY);

            if (side !== potentialDock || slotIndex !== potentialSlot || stackTargetId !== potentialStackTarget || splitTargetId !== potentialSplitTarget) {
                potentialDock        = side;
                potentialSlot        = slotIndex;
                potentialStackTarget = stackTargetId;
                potentialSplitTarget = splitTargetId;
                potentialSplitBefore = splitBefore;
                manager.setPosition(panel.id, lastX, lastY);
                onDragStateChange(side
                    ? { panelId: panel.id, potentialDock: side, insertSlotIndex: slotIndex, stackTargetId, splitTargetId, splitBefore }
                    : null);
            }
        };

        const onMove = (ev: PointerEvent) => {
            lastClientX = ev.clientX;
            lastClientY = ev.clientY;

            if (!hasDragged) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= DRAG_THRESHOLD) return;
                hasDragged = true;

                const visualW = groupEl?.offsetWidth;
                const visualH = groupEl?.offsetHeight;
                flushSync(() => {
                    manager.undock(panel.id, visualW, visualH, panelRect?.left, panelRect?.top);
                });

                floatingEl = document.querySelector<HTMLElement>(`[data-window-id="${panel.id}"]`);
                if (floatingEl) {
                    lastX = floatingEl.offsetLeft;
                    lastY = floatingEl.offsetTop;
                }
                return;
            }

            if (!floatingEl) return;
            lastX = ev.clientX - offsetX;
            lastY = ev.clientY - offsetY;
            floatingEl.style.left = `${lastX}px`;
            floatingEl.style.top  = `${lastY}px`;

            updateDockState(ev.shiftKey, ev.clientX, ev.clientY);
        };

        const onKeyChange = (ev: KeyboardEvent) => {
            if (ev.key !== 'Shift') return;
            updateDockState(ev.type === 'keydown', lastClientX, lastClientY);
        };

        const onUp = () => {
            onDragStateChange(null);
            if (hasDragged) {
                if (potentialDock !== null) {
                    if (potentialStackTarget) {
                        manager.tabIntoGroup(panel.id, potentialStackTarget);
                    } else if (potentialSplitTarget) {
                        manager.splitIntoGroup(panel.id, potentialSplitTarget, potentialSplitBefore ?? false);
                    } else {
                        manager.dock(panel.id, potentialDock, potentialSlot);
                    }
                } else if (floatingEl) {
                    manager.setPosition(panel.id, lastX, lastY);
                }
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

    return (
        <div
            className={`tab-group-tab${isActive ? ' tab-group-tab--active' : ''}`}
            onPointerDown={handlePointerDown}
        >
            <span className="tab-group-tab-title">{panel.title}</span>
            <button
                className="script-window-btn close"
                title="Close"
                onClick={e => { e.stopPropagation(); onClose(); }}
            >×</button>
        </div>
    );
}

// ── Portal-attached content for the active tab ────────────────────────────────

interface TabContentProps {
    id: string;
    manager: WindowManager;
}

function TabContent({ id, manager }: TabContentProps) {
    const contentRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const slot   = contentRef.current;
        const target = manager.getPortalTarget(id);
        if (!slot || !target) return;
        slot.appendChild(target);
        return () => {
            if (target.parentNode === slot) slot.removeChild(target);
        };
    }, [manager, id]);

    return <div className="docked-panel-content" ref={contentRef} />;
}
