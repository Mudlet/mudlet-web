/**
 * Qt's `QToolButton::MenuButtonPopup` — a button with an arrow beside it.
 *
 * Mudlet's toolbar uses it for the things that are one action most of the time
 * and a short list of related ones occasionally: Connect (with Disconnect and
 * Close profile behind the arrow), Mute, the package managers. Pressing the
 * button half runs the default action; pressing the arrow half opens the rest.
 * The two halves are separate controls on purpose — a player reaching for
 * Connect should never open a menu by accident.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components';
import { inPopupSurface } from './anchoredPopup';
import { MenuList } from './MenuBar';
import type { MenuNode } from './menuModel';

interface SplitButtonProps {
    /** The default action's face — icon and label, as any other toolbar button. */
    children: ReactNode;
    title?: string;
    /** The default action: what the button half does. */
    onClick: () => void;
    /** Drawn pressed, for a default action that is a state rather than a verb
     *  (Mudlet's Mute button is its "Mute all media" action, checkable). */
    checked?: boolean;
    /** Everything behind the arrow, including the default action itself — Qt
     *  lists it there too, and a menu missing the thing the button does reads
     *  as if the button were something else. */
    items: MenuNode[];
    /** Accessible name for the arrow half, e.g. "Connection actions". */
    menuLabel: string;
    /**
     * Lay the whole thing out as siblings instead: the default action, then
     * each entry as its own full-width button. For the hamburger, where a popup
     * inside a popup is not a menu anyone can drive.
     */
    stacked?: boolean;
    /** Run after any of these actions — the hamburger closes itself with it.
     *  Stacked layout only; the popup closes on its own. */
    onAnyAction?: () => void;
}

export function SplitButton({
    children, title, onClick, checked, items, menuLabel, stacked, onAnyAction,
}: SplitButtonProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDocPointer = (e: PointerEvent) => {
            if (!inPopupSurface(rootRef.current, e.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onDocPointer);
        return () => document.removeEventListener('pointerdown', onDocPointer);
    }, [open]);

    const run = (fn: () => void) => () => { setOpen(false); onAnyAction?.(); fn(); };

    if (stacked) {
        return (
            <>
                <Button variant="ghost" title={title} aria-pressed={checked} onClick={run(onClick)}>
                    {children}
                </Button>
                {items.map(node => {
                    if (node.kind === 'separator') {
                        return <span key={node.id} className="toolbar-sep" aria-hidden="true" />;
                    }
                    // A submenu has no flat form; nothing on the toolbar builds
                    // one, and inventing an indented list here would be a layout
                    // nobody has asked for.
                    if (node.kind === 'submenu') return null;
                    return (
                        <Button
                            key={node.id}
                            variant="ghost"
                            disabled={node.disabled}
                            aria-pressed={node.checked}
                            onClick={run(node.run)}
                        >
                            {node.checked ? '✓ ' : ''}{node.label}
                        </Button>
                    );
                })}
            </>
        );
    }

    return (
        <div className="split-button" ref={rootRef}>
            <Button
                variant="ghost"
                className="split-button__main"
                title={title}
                aria-pressed={checked}
                // Qt gives a toolbar button Qt::NoFocus: clicking one must not
                // take the keyboard away from the command line.
                onMouseDown={e => e.preventDefault()}
                onClick={run(onClick)}
            >
                {children}
            </Button>
            <button
                type="button"
                className="split-button__arrow"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={menuLabel}
                onMouseDown={e => e.preventDefault()}
                onClick={() => setOpen(v => !v)}
            >
                {/* Drawn rather than typed. A triangle glyph (▾) is centred on
                    the font's math axis, not on its em box, so it rides a pixel
                    or two above the middle of the button beside it — visible as
                    soon as the two sit in one outline. An SVG box has no such
                    opinion and the flex centring lands it exactly. */}
                <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                    <path
                        d="M1.5 3 4 5.5 6.5 3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </button>
            {/* MenuList closes before it runs an entry, which is what
                `onCloseAll` is; the entries need no wrapping of their own.
                Anchored to the pair rather than to the arrow, so it lines up
                with the button's left edge the way Qt's does. */}
            {open && <MenuList items={items} anchor={rootRef.current} onCloseAll={() => setOpen(false)} />}
        </div>
    );
}
