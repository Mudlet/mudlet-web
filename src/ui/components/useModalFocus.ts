import { useEffect, useRef } from 'react';

/**
 * Modal focus management — the keyboard/AT behaviour Qt gives Mudlet's dialogs
 * for free but the DOM does not: move focus into the dialog on open, trap Tab
 * inside it, close on Escape, and restore focus to the opener on close.
 *
 * Pair with `role="dialog"`/`aria-modal="true"` on the same element (which tells
 * a screen reader to ignore the background). Attach the returned ref to the
 * dialog's root element:
 *
 *   const ref = useModalFocus<HTMLDivElement>(onClose);
 *   return <div className="modal" role="dialog" aria-modal="true" ref={ref}>…</div>;
 */

// Tab-order candidates. [tabindex="-1"] is programmatically focusable but not a
// Tab stop, so it's excluded from the cycle.
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Visible (Tab-reachable) focusable descendants of `container`, in DOM order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        // offsetParent is null for display:none elements (and fixed ones, but
        // dialogs aren't position:fixed descendants here) — skip hidden controls.
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Where a Tab/Shift+Tab should send focus to keep it inside the dialog, or null
 * to let the browser move focus normally (the common case, mid-list). Wraps at
 * the ends and pulls focus back in if it has escaped the dialog. Pure — the
 * caller reads the return and focuses it. Exported for testing.
 */
export function focusTrapTarget(
    items: HTMLElement[],
    active: HTMLElement | null,
    shiftKey: boolean,
): HTMLElement | null {
    if (items.length === 0) return null;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = active != null && items.includes(active);
    if (shiftKey) {
        // Backward from the first (or from outside) wraps to the last.
        return !inside || active === first ? last : null;
    }
    // Forward from the last (or from outside) wraps to the first.
    return !inside || active === last ? first : null;
}

export interface ModalFocusOptions {
    /** Move focus into the dialog on open. Default true. Set false when the
     *  modal manages its own initial focus (e.g. a specific field or button). */
    autoFocus?: boolean;
    /** Close on Escape via `onClose`. Default true. Set false when the modal has
     *  its own Escape handling (then `onClose` may be omitted). Read live on
     *  every key, so it may vary over the dialog's life — a dialog can hand
     *  Escape to an inner editor for exactly as long as that editor is open
     *  (the file browser's inline rename does) without the trap being torn
     *  down and re-armed, which would re-grab focus. */
    closeOnEscape?: boolean;
    /** Gate for a dialog whose node is not in the DOM on the first render — a
     *  portal whose container is only known after a layout effect, say. The
     *  setup below runs once, off a null ref, and refs don't re-render, so
     *  without this the trap, the Escape handler and the focus restore are all
     *  silently skipped (issue #49). Flip it true in the render that mounts the
     *  dialog node. One-way: flipping it back to false counts as a close and
     *  restores focus to the opener. Default true (node present immediately). */
    ready?: boolean;
    /** Where focus should land on close, instead of the opener. Use when the
     *  dialog was raised by the game rather than by a click, so "the opener" is
     *  either nothing or a control that has since gone away — the GMCP login
     *  popup hands focus to the command line this way. Falls back to the opener
     *  when it returns null. */
    restoreFocusTo?: () => HTMLElement | null | undefined;
}

export function useModalFocus<T extends HTMLElement = HTMLDivElement>(
    onClose?: () => void,
    opts: ModalFocusOptions = {},
): React.RefObject<T | null> {
    const { autoFocus = true, closeOnEscape = true, ready = true, restoreFocusTo } = opts;
    const ref = useRef<T | null>(null);
    // Keep the latest onClose without re-running the setup effect (which would
    // re-grab focus on every parent render).
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
    const restoreRef = useRef(restoreFocusTo);
    useEffect(() => { restoreRef.current = restoreFocusTo; }, [restoreFocusTo]);
    const closeOnEscapeRef = useRef(closeOnEscape);
    useEffect(() => { closeOnEscapeRef.current = closeOnEscape; }, [closeOnEscape]);

    useEffect(() => {
        if (!ready) return;
        const node = ref.current;
        if (!node) return;
        const opener = document.activeElement as HTMLElement | null;

        // Move focus in: first focusable control, else the dialog itself (made
        // programmatically focusable so the screen reader lands on it). Skip when
        // something inside already holds focus — a child (e.g. a code editor) may
        // have autofocused itself, and stealing that back would be wrong.
        if (autoFocus && !node.contains(document.activeElement)) {
            const initial = focusableWithin(node)[0] ?? node;
            if (initial === node && !node.hasAttribute('tabindex')) node.tabIndex = -1;
            initial.focus();
        }

        const onKeyDown = (e: KeyboardEvent) => {
            if (closeOnEscapeRef.current && e.key === 'Escape') {
                e.stopPropagation();
                onCloseRef.current?.();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = focusableWithin(node);
            const target = focusTrapTarget(items, document.activeElement as HTMLElement | null, e.shiftKey);
            if (items.length === 0) { e.preventDefault(); node.focus(); return; }
            if (target) { e.preventDefault(); target.focus(); }
        };
        node.addEventListener('keydown', onKeyDown);

        return () => {
            node.removeEventListener('keydown', onKeyDown);
            // Restore focus: the caller's explicit target, else the opener if
            // it's still in the document.
            const target = restoreRef.current?.()
                ?? (opener && document.contains(opener) ? opener : null);
            target?.focus();
        };
    }, [ready]);

    return ref;
}
