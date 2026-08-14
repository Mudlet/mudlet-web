import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MudSession } from '../../mud/MudSession';
import type { ScriptWindowRenderData } from '../windows/types';
import type { WindowManager } from '../windows/WindowManager';
import { OutputArea } from '../output/OutputArea';

interface MobileLayoutProps {
    session: MudSession;
    manager: WindowManager;
    /** Already filtered to non-popped-out windows by ContentLayout. */
    windows: ScriptWindowRenderData[];
    stickyLines?: number;
    commandInputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
    commandBar?: React.ReactNode;
}

const MAIN_VIEW = '__main__';

/**
 * Phone layout: a single column showing one view at a time — the main MUD
 * output or one script panel — flipped via a bottom switcher bar. The desktop
 * dock/float chrome (drag, splitters, floating frames) is bypassed entirely;
 * panel *content* is reused untouched by re-parenting the same stable
 * portal-target divs WindowManager already maintains (same trick as the
 * desktop TabGroupPanel), so panels stay live in the background.
 */
export function MobileLayout({ session, manager, windows, stickyLines, commandInputRef, commandBar }: MobileLayoutProps) {
    // Selectable panels: visible, top-level (child miniconsoles render inside
    // their parent panel, not as standalone views).
    const panels = windows.filter(w => w.visible && (!w.parent || w.parent === 'main'));

    const [activeView, setActiveView] = useState<string>(MAIN_VIEW);

    // If the active panel is closed/hidden/undocked-away, fall back to the main
    // output so we never strand the user on an empty slot.
    useEffect(() => {
        if (activeView !== MAIN_VIEW && !panels.some(p => p.id === activeView)) {
            setActiveView(MAIN_VIEW);
        }
    }, [activeView, panels]);

    const activePanelId = activeView === MAIN_VIEW ? null : activeView;

    return (
        <div className="mobile-layout">
            <div className="mobile-layout__views">
                {/* Output stays mounted (kept receiving data + scrollback) and is
                    just hidden when a panel is foregrounded. */}
                <div
                    className="main-viewport"
                    style={activePanelId ? { display: 'none' } : undefined}
                >
                    <OutputArea session={session} stickyLines={stickyLines} commandInputRef={commandInputRef} mxpBorders={manager.getMxpBorders()} />
                </div>

                {activePanelId && (
                    <MobilePanelSlot key={activePanelId} id={activePanelId} manager={manager} />
                )}
            </div>

            {panels.length > 0 && (
                <nav className="mobile-switcher mudix-native-scrollbar" role="tablist" aria-label="Panels">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeView === MAIN_VIEW}
                        className={`mobile-switcher__tab${activeView === MAIN_VIEW ? ' mobile-switcher__tab--active' : ''}`}
                        onClick={() => setActiveView(MAIN_VIEW)}
                    >
                        Main
                    </button>
                    {panels.map(p => (
                        <button
                            key={p.id}
                            type="button"
                            role="tab"
                            aria-selected={activeView === p.id}
                            className={`mobile-switcher__tab${activeView === p.id ? ' mobile-switcher__tab--active' : ''}`}
                            onClick={() => setActiveView(p.id)}
                            title={p.title}
                        >
                            {p.title}
                        </button>
                    ))}
                </nav>
            )}

            {commandBar}
        </div>
    );
}

// Re-parents the panel's stable portal-target div into the visible slot while
// this view is active, and returns it to the content pool on switch-away.
function MobilePanelSlot({ id, manager }: { id: string; manager: WindowManager }) {
    const contentRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const slot = contentRef.current;
        const target = manager.getPortalTarget(id);
        if (!slot || !target) return;
        slot.appendChild(target);
        return () => {
            if (target.parentNode === slot) slot.removeChild(target);
        };
    }, [manager, id]);

    return <div className="mobile-panel-slot docked-panel-content" ref={contentRef} />;
}
