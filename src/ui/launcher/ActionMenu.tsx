import { useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { ContextMenu } from '../components';

export interface MenuAction {
    label: string;
    onSelect: () => void;
    disabled?: boolean;
    danger?: boolean;
}

interface Props {
    /** Accessible name of the trigger, e.g. "More actions for Achaea". */
    label: string;
    actions: MenuAction[];
    className?: string;
    disabled?: boolean;
    /** Visible trigger content; defaults to a bare ⋯ icon. */
    children?: React.ReactNode;
}

const MENU_WIDTH = 230;

/** A "⋯" button that opens a small menu of actions below it, right-aligned
 *  to the button so it never runs off the edge of a tile or the banner. */
export function ActionMenu({ label, actions, className, disabled, children }: Props) {
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    // The menu closes itself on any pointerdown outside it — including on this
    // button, just before its click. Without remembering that, a second click
    // meant to close the menu would close it and then reopen it at once.
    const closedAt = useRef(0);
    const close = () => { closedAt.current = performance.now(); setPos(null); };

    const open = () => {
        const r = btnRef.current?.getBoundingClientRect();
        if (!r) return;
        setPos({ x: Math.max(8, r.right - MENU_WIDTH), y: r.bottom + 4 });
    };

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className={[children ? 'launcher-ghost' : 'launcher-more', className].filter(Boolean).join(' ')}
                aria-label={children ? undefined : label}
                aria-haspopup="menu"
                aria-expanded={pos !== null}
                disabled={disabled}
                onClick={e => {
                    e.stopPropagation();
                    if (pos) close();
                    else if (performance.now() - closedAt.current > 300) open();
                }}
            >
                {children ?? <MoreHorizontal size={18} aria-hidden="true" />}
            </button>
            {pos && (
                <ContextMenu x={pos.x} y={pos.y} onClose={close} label={label} className="launcher-menu">
                    {actions.map(a => (
                        <button
                            key={a.label}
                            type="button"
                            className={`ctx-menu__item${a.danger ? ' ctx-menu__item--danger' : ''}`}
                            disabled={a.disabled}
                            onClick={() => { close(); a.onSelect(); }}
                        >
                            {a.label}
                        </button>
                    ))}
                </ContextMenu>
            )}
        </>
    );
}
