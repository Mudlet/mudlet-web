import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

interface ContextMenuProps {
    x: number;
    y: number;
    onClose: () => void;
    /** Accessible name for the menu, e.g. "Output actions". */
    label?: string;
    /** Override for popups that are not lists of commands — the script editor's
     *  colour picker is a grid of swatches, and calling that a menu when it holds
     *  no menuitem misdescribes it. */
    role?: 'menu' | 'group';
    /** Where to hand focus back on close, when that is not the element the menu
     *  was opened from. The output console needs this: a right-click focuses the
     *  console (it is a tab stop), but the player types into the command line, so
     *  returning focus to the opener would send their next keystroke nowhere. */
    returnFocusTo?: () => HTMLElement | null | undefined;
    children: React.ReactNode;
}

/** Entries a keyboard can land on: the enabled `.ctx-menu__item`s, in DOM order.
 *  Greyed-out entries (Copy with no selection, say) are skipped — they are still
 *  in the menu's a11y tree, just not stops in the arrow-key cycle. */
function enabledItems(root: HTMLElement | null): HTMLElement[] {
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('.ctx-menu__item:not([disabled])'));
}

/**
 * Where an arrow/Home/End press should move within a menu of `count` entries,
 * given the currently focused index (-1 when focus is outside). Returns null for
 * keys the menu doesn't handle. Wraps at both ends. Pure — exported for testing.
 */
export function nextMenuIndex(count: number, current: number, key: string): number | null {
    if (count === 0) return null;
    switch (key) {
        case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count;
        case 'ArrowUp':   return current <= 0 ? count - 1 : current - 1;
        case 'Home':      return 0;
        case 'End':       return count - 1;
        default:          return null;
    }
}

export function ContextMenu({ x, y, onClose, label = 'Context menu', role = 'menu', returnFocusTo, children }: ContextMenuProps) {
    const ref = useRef<HTMLDivElement>(null);

    // ARIA roles are stamped on here rather than written at each call site. The
    // menu takes arbitrary children and six components build ~38 entries between
    // them; one pass keeps them consistent and cannot drift as entries are added.
    // Re-run every render because several menus rebuild their entries in place.
    useLayoutEffect(() => {
        const root = ref.current;
        if (!root) return;
        for (const el of root.querySelectorAll<HTMLElement>('.ctx-menu__item')) {
            el.setAttribute('role', 'menuitem');
            // Roving focus: the menu itself is the Tab stop, arrows move within.
            el.tabIndex = -1;
        }
        for (const el of root.querySelectorAll<HTMLElement>('.ctx-menu__sep')) {
            el.setAttribute('role', 'separator');
        }
    });

    // Read at unmount, so the mount effect below can stay a mount/unmount pair
    // while still seeing the current callback.
    const returnFocusRef = useRef(returnFocusTo);
    returnFocusRef.current = returnFocusTo;

    // Opening a menu must move focus into it, or a screen reader gets no
    // indication anything happened; closing it must hand focus back to whatever
    // opened it (usually the command line).
    //
    // Focusing the first entry is safe for the document selection — a selection
    // survives focus moving to a button — but handing focus back may not be:
    // focusing a text field collapses the page selection in Chrome, which would
    // silently undo the selection the entry just acted on ("Select all" being the
    // whole point). So carry the selection across the restore; re-applying it
    // once the field holds focus sticks.
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        enabledItems(ref.current)[0]?.focus();
        return () => {
            const target = returnFocusRef.current?.()
                ?? (opener?.isConnected ? opener : null);
            if (!target) return;
            const sel = window.getSelection();
            const saved = sel && !sel.isCollapsed
                ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i).cloneRange())
                : [];
            target.focus();
            if (saved.length === 0) return;
            const after = window.getSelection();
            if (!after || (after.rangeCount > 0 && !after.isCollapsed)) return;
            after.removeAllRanges();
            for (const range of saved) after.addRange(range);
        };
    }, []);

    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (!ref.current?.contains(e.target as Node)) onClose();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            // Escape and Tab both dismiss; the unmount effect above returns focus
            // to the opener, so Tab resumes the page's tab order from there.
            if (e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                onClose();
                return;
            }
            const items = enabledItems(ref.current);
            const next = nextMenuIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.key);
            if (next === null) return;
            e.preventDefault();
            items[next].focus();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose]);

    return createPortal(
        <div
            ref={ref}
            className="ctx-menu"
            role={role}
            aria-label={label}
            style={{ left: x, top: y }}
            onContextMenu={e => e.preventDefault()}
        >
            {children}
        </div>,
        document.body,
    );
}
