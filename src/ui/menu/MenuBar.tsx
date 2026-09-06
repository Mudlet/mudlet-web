/**
 * The client's menu bar — Mudlet's second place for a command, and the only one
 * a package's `menuPath` can lead to.
 *
 * It behaves the way a desktop menu bar does rather than the way a row of
 * dropdown buttons does: one click opens the bar, and while it is open, moving
 * the pointer across the other titles switches menus without another click.
 * That difference is the whole reason this is not six independent popovers.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nextMenuIndex } from '../components/ContextMenu';
import { anchoredStyle, inPopupSurface, useAnchoredPopup } from './anchoredPopup';
import type { MenuNode, MenuSubmenu, TopMenu } from './menuModel';
import './MenuBar.css';

/** The entries of ONE list — not those of its submenus, which handle their own
 *  keys. `:scope >` is what keeps a flyout's entries out of its parent's cycle. */
function ownItems(list: HTMLElement | null): HTMLElement[] {
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLElement>(':scope > .menu-item:not([disabled])'));
}

interface MenuListProps {
    items: MenuNode[];
    /** Dismiss the whole bar — what running an entry does. */
    onCloseAll: () => void;
    /** Dismiss this list only, handing focus back to whatever opened it.
     *  Absent on a top-level dropdown, where Escape belongs to the bar. */
    onCloseSelf?: () => void;
    /** Put focus on the first entry — set when the list was opened from the
     *  keyboard. A list opened by pointer leaves focus alone, as Qt does. */
    autoFocus?: boolean;
    /** A flyout opens beside its parent entry; a dropdown under its title. */
    flyout?: boolean;
    /**
     * The control this list drops from — a menu title, a split button. Given
     * one, the list is portaled to that element's document body and placed
     * against its rect, the way Qt opens a menu as its own top-level window.
     * Without it (a flyout, which opens inside a list that is already portaled)
     * the list stays where it is written and positions itself in CSS.
     */
    anchor?: HTMLElement | null;
}

export function MenuList({ items, onCloseAll, onCloseSelf, autoFocus, flyout, anchor }: MenuListProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [openSub, setOpenSub] = useState<string | null>(null);
    /** Whether the open submenu was opened from the keyboard, so it knows
     *  whether to take focus. */
    const [subFromKey, setSubFromKey] = useState(false);
    const [flipped, setFlipped] = useState(false);

    useEffect(() => {
        if (autoFocus) ownItems(ref.current)[0]?.focus();
    }, [autoFocus]);

    // A menu running off the right edge of the window is a menu with entries
    // nobody can read. Measured rather than guessed: how far along the bar a
    // menu sits depends on the titles before it, and a package chooses those.
    // Anchored lists do their own measuring in placePopup, which flips and
    // clamps in both axes; this is the flyout's version of the same thing.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || anchor) return;
        const rect = el.getBoundingClientRect();
        setFlipped(rect.right > window.innerWidth - 4);
    }, [items, anchor]);

    const placement = useAnchoredPopup(anchor, ref, 'start', items);

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const entries = ownItems(ref.current);
        const index = entries.indexOf(document.activeElement as HTMLElement);
        const next = nextMenuIndex(entries.length, index, e.key);
        if (next !== null) {
            e.preventDefault();
            e.stopPropagation();
            entries[next]?.focus();
            return;
        }
        if (e.key === 'Escape' && onCloseSelf) {
            // Only a flyout stops here. Escape in a dropdown reaches the bar,
            // which closes the whole thing and returns focus to the title.
            e.preventDefault();
            e.stopPropagation();
            onCloseSelf();
        }
    };

    const listClass = [
        'menu-list',
        anchor ? 'menu-list--anchored' : flyout ? 'menu-list--flyout' : 'menu-list--dropdown',
        flipped ? 'menu-list--flipped' : '',
    ].filter(Boolean).join(' ');

    const list = (
        <div
            ref={ref}
            className={listClass}
            role="menu"
            onKeyDown={onKeyDown}
            // Marks this subtree as part of the control that opened it, for the
            // dismiss-on-outside-click handlers — see inPopupSurface.
            data-anchored-popup={anchor ? '' : undefined}
            style={anchor ? anchoredStyle(placement) : undefined}
        >
            {items.map(node => {
                if (node.kind === 'separator') {
                    return <div key={node.id} className="menu-sep" role="separator" />;
                }
                if (node.kind === 'submenu') {
                    return (
                        <SubmenuItem
                            key={node.id}
                            node={node}
                            open={openSub === node.id}
                            fromKeyboard={subFromKey}
                            onOpen={byKeyboard => { setSubFromKey(byKeyboard); setOpenSub(node.id); }}
                            onCloseSelf={() => setOpenSub(null)}
                            onCloseAll={onCloseAll}
                        />
                    );
                }
                return (
                    <button
                        key={node.id}
                        type="button"
                        className={`menu-item${node.checked ? ' menu-item--checked' : ''}`}
                        // A checkable entry is a checkbox item; a plain one is
                        // not, and calling it unchecked is a state a screen
                        // reader would announce on every pass.
                        role={node.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                        aria-checked={node.checked === undefined ? undefined : node.checked}
                        tabIndex={-1}
                        disabled={node.disabled}
                        // Qt gives a menu Qt::NoFocus, so picking an entry does
                        // not take the keyboard away from the command line.
                        onMouseDown={e => e.preventDefault()}
                        // Crossing a plain entry shuts whatever flyout is open,
                        // the same way it does on a desktop menu.
                        onPointerEnter={() => setOpenSub(null)}
                        onClick={() => { onCloseAll(); node.run(); }}
                    >
                        <span className="menu-item__tick" aria-hidden="true">{node.checked ? '✓' : ''}</span>
                        {/* A package gives a path, a host app or a brand gives
                            a node. Both land in the same box, which is what
                            sizes them — the string form is not trusted to be a
                            working image, and a broken one leaves the label on
                            its own rather than a torn image box. */}
                        {node.icon !== undefined && node.icon !== '' && (
                            <span className="menu-item__icon" aria-hidden="true">
                                {typeof node.icon === 'string'
                                    ? <img src={node.icon} alt="" />
                                    : node.icon}
                            </span>
                        )}
                        <span className="menu-item__label">{node.label}</span>
                        {node.shortcut && <span className="menu-item__key">{node.shortcut}</span>}
                    </button>
                );
            })}
        </div>
    );

    // Portaled out of whatever declared it, into its own document's body — a
    // popped-out panel keeps its menus, as ResizableModal does.
    return anchor ? createPortal(list, anchor.ownerDocument.body) : list;
}

interface SubmenuItemProps {
    node: MenuSubmenu;
    open: boolean;
    fromKeyboard: boolean;
    onOpen: (byKeyboard: boolean) => void;
    onCloseSelf: () => void;
    onCloseAll: () => void;
}

function SubmenuItem({ node, open, fromKeyboard, onOpen, onCloseSelf, onCloseAll }: SubmenuItemProps) {
    const ref = useRef<HTMLDivElement>(null);

    return (
        <div className="menu-sub" ref={ref} onPointerEnter={() => onOpen(false)}>
            <button
                type="button"
                className="menu-item menu-item--sub"
                role="menuitem"
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={open}
                onMouseDown={e => e.preventDefault()}
                onClick={() => onOpen(false)}
                onKeyDown={e => {
                    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onOpen(true);
                    }
                }}
            >
                <span className="menu-item__tick" aria-hidden="true" />
                <span className="menu-item__label">{node.label}</span>
                <span className="menu-item__arrow" aria-hidden="true">›</span>
            </button>
            {open && (
                <MenuList
                    items={node.items}
                    flyout
                    autoFocus={fromKeyboard}
                    onCloseAll={onCloseAll}
                    onCloseSelf={() => {
                        onCloseSelf();
                        ref.current?.querySelector<HTMLElement>(':scope > .menu-item')?.focus();
                    }}
                />
            )}
        </div>
    );
}

interface MenuBarProps {
    menus: TopMenu[];
    /** Accessible name for the bar. */
    label?: string;
}

export function MenuBar({ menus, label = 'Main menu' }: MenuBarProps) {
    const [open, setOpen] = useState<string | null>(null);
    const [fromKeyboard, setFromKeyboard] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    // Each title's wrapper, so the open dropdown can be placed against it once
    // it no longer hangs inside it. Filled at mount, read at render.
    const titleRefs = useRef(new Map<string, HTMLDivElement>());

    useEffect(() => {
        if (!open) return;
        const onDocPointer = (e: PointerEvent) => {
            if (!inPopupSurface(rootRef.current, e.target)) setOpen(null);
        };
        document.addEventListener('pointerdown', onDocPointer);
        return () => document.removeEventListener('pointerdown', onDocPointer);
    }, [open]);

    const focusTitle = (id: string) => {
        rootRef.current?.querySelector<HTMLElement>(`.menu-title[data-menu="${id}"]`)?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            if (!open) return;
            e.preventDefault();
            const id = open;
            setOpen(null);
            focusTitle(id);
            return;
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        // Left/right walk the bar whether or not a menu is open, and when one
        // is, the open menu walks with the focus — that is what makes a menu
        // bar navigable without the pointer.
        const bar = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.menu-title') ?? []);
        if (bar.length === 0) return;
        const opened = bar.findIndex(el => el.dataset.menu === open);
        const focused = bar.indexOf(document.activeElement as HTMLElement);
        const from = opened >= 0 ? opened : focused;
        if (from < 0) return;
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const target = bar[(from + delta + bar.length) % bar.length];
        target.focus();
        if (open) {
            setFromKeyboard(true);
            setOpen(target.dataset.menu ?? null);
        }
    };

    return (
        <div
            className="mudix-menubar"
            role="menubar"
            aria-label={label}
            ref={rootRef}
            onKeyDown={onKeyDown}
        >
            {menus.map(menu => (
                <div
                    className="menu-root"
                    key={menu.id}
                    ref={el => {
                        if (el) titleRefs.current.set(menu.id, el);
                        else titleRefs.current.delete(menu.id);
                    }}
                >
                    <button
                        type="button"
                        className={`menu-title${open === menu.id ? ' menu-title--open' : ''}`}
                        data-menu={menu.id}
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={open === menu.id}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => {
                            setFromKeyboard(false);
                            setOpen(id => (id === menu.id ? null : menu.id));
                        }}
                        // Hover switches menus only once the bar is open. A bar
                        // that opened on hover alone would fire every time the
                        // pointer crossed it on the way to the output.
                        onPointerEnter={() => {
                            if (!open) return;
                            setFromKeyboard(false);
                            setOpen(menu.id);
                        }}
                        onKeyDown={e => {
                            if (e.key !== 'ArrowDown' && e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            setFromKeyboard(true);
                            setOpen(menu.id);
                        }}
                    >
                        {menu.label}
                    </button>
                    {open === menu.id && (
                        <MenuList
                            items={menu.items}
                            anchor={titleRefs.current.get(menu.id) ?? null}
                            autoFocus={fromKeyboard}
                            onCloseAll={() => setOpen(null)}
                        />
                    )}
                </div>
            ))}
        </div>
    );
}
