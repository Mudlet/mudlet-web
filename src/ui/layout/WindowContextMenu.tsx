import { ContextMenu } from '../components';
import type { ScriptWindowRenderData } from '../windows/types';
import type { WindowManager } from '../windows/WindowManager';

interface WindowContextMenuProps {
    windows: ScriptWindowRenderData[];
    manager: WindowManager;
    x: number;
    y: number;
    onClose: () => void;
}

export function WindowContextMenu({ windows, manager, x, y, onClose }: WindowContextMenuProps) {
    // Real user windows only — what Mudlet's equivalent menu lists. A
    // mini-console is a script-placed child widget, not something the user
    // opened and can meaningfully close: Geyser's MiniConsoles (a GUI package
    // has a dozen), an embedded mapper, and every MXP <FRAME> pane the server
    // declares. Listing those buries the two or three real windows and offers
    // toggles that a script or the server immediately undoes.
    const sorted = windows
        .filter(w => !manager.isMiniConsole(w.id))
        .sort((a, b) => a.title.localeCompare(b.title));

    return (
        <ContextMenu x={x} y={y} onClose={onClose}>
            {sorted.length === 0
                ? <div className="ctx-menu__empty">No windows</div>
                : sorted.map(w => (
                    // The whole row is the checkbox's label, so clicking the
                    // title toggles the window too — the title is the part
                    // that's actually easy to hit.
                    <label
                        key={w.id}
                        className="ctx-menu__item"
                        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                    >
                        <input
                            type="checkbox"
                            checked={w.visible}
                            onChange={() => w.visible ? manager.hide(w.id) : manager.show(w.id)}
                            style={{ cursor: 'pointer', flexShrink: 0, accentColor: 'var(--accent)' }}
                        />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
                    </label>
                ))
            }
        </ContextMenu>
    );
}
