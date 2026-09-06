/**
 * Placing a popup against the control that opened it.
 *
 * In Qt a menu is its own top-level window: it is placed at a screen position
 * and paints over everything, and nothing about the widget that opened it can
 * trap it. The web has no such thing — a dropdown written inside the bar that
 * owns it is stuck in that bar's stacking context, which is what forced the
 * menu bar above the floating windows and cost every click on a window drawn
 * in its strip (issue #145).
 *
 * So the popups portal to `<body>` and are placed here instead, against the
 * rect of their anchor. Same idea as ResizableModal's portal, one step further:
 * the modal only needed to escape, a menu also has to land somewhere.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export interface AnchorRect { left: number; top: number; right: number; bottom: number }
export interface PopupSize { width: number; height: number }
export interface ViewportSize { width: number; height: number }
export interface Placement { left: number; top: number }

/** Which of the popup's edges lines up with the same edge of its anchor. */
export type PopupAlign = 'start' | 'end';

/** Gap between the anchor and the popup, and the smallest gap kept to the
 *  viewport edge. Both match what the stylesheet used to hard-code. */
const GAP = 4;
const MARGIN = 4;

/**
 * Where a popup of `size` goes when hung off `anchor` inside `viewport`.
 *
 * Below the anchor by default, flipping above it when there is no room; aligned
 * on the `align` edge, flipping to the other one when it would overrun. Always
 * clamped into the viewport afterwards, because on a small enough window a
 * popup overruns whichever way it is flipped and a menu half off the screen is
 * a menu with entries nobody can reach.
 *
 * Pure, and in viewport coordinates — the popup is `position: fixed`.
 */
export function placePopup(
    anchor: AnchorRect,
    size: PopupSize,
    viewport: ViewportSize,
    align: PopupAlign = 'start',
): Placement {
    const startLeft = anchor.left;
    const endLeft = anchor.right - size.width;
    let left = align === 'start' ? startLeft : endLeft;
    if (left + size.width > viewport.width - MARGIN) {
        left = align === 'start' ? endLeft : startLeft;
    }
    left = Math.max(MARGIN, Math.min(left, viewport.width - MARGIN - size.width));

    let top = anchor.bottom + GAP;
    if (top + size.height > viewport.height - MARGIN) {
        const above = anchor.top - GAP - size.height;
        if (above >= MARGIN) top = above;
    }
    top = Math.max(MARGIN, top);

    return { left, top };
}

/**
 * Live placement for a portaled popup: null until it has been measured, so the
 * caller can keep it out of sight for the one frame before it knows where it
 * goes. Re-measures on resize and on any scroll (capture phase — the anchor may
 * ride inside a scroller that is not the document).
 *
 * `deps` re-runs the measurement when the popup's own contents change size.
 */
export function useAnchoredPopup(
    anchor: HTMLElement | null | undefined,
    popupRef: RefObject<HTMLElement | null>,
    align: PopupAlign = 'start',
    deps: unknown = null,
): Placement | null {
    const [placement, setPlacement] = useState<Placement | null>(null);

    useLayoutEffect(() => {
        const popup = popupRef.current;
        if (!anchor || !popup) return;
        const view = anchor.ownerDocument.defaultView ?? window;
        const place = () => {
            const next = placePopup(
                anchor.getBoundingClientRect(),
                { width: popup.offsetWidth, height: popup.offsetHeight },
                { width: view.innerWidth, height: view.innerHeight },
                align,
            );
            // Same place as last time is not a state change. `deps` is usually
            // the caller's item array, rebuilt on every render of the surface
            // that owns the menu, so this effect re-runs often; handing back a
            // fresh object each time would re-render the popup for nothing.
            setPlacement(prev => (prev && prev.left === next.left && prev.top === next.top) ? prev : next);
        };
        place();
        view.addEventListener('resize', place);
        view.addEventListener('scroll', place, true);
        return () => {
            view.removeEventListener('resize', place);
            view.removeEventListener('scroll', place, true);
        };
    }, [anchor, popupRef, align, deps]);

    return placement;
}

/**
 * Style for a portaled popup, before and after it has been measured.
 *
 * Rendered hidden rather than not at all: it has to be in the document for its
 * size to be measurable, and `useAnchoredPopup` measures in a layout effect, so
 * the unplaced frame never reaches the screen.
 */
export function anchoredStyle(placement: Placement | null): React.CSSProperties {
    return placement
        ? { position: 'fixed', left: placement.left, top: placement.top }
        : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };
}

/**
 * Did a pointer event land on the control or on a popup it opened?
 *
 * The dismiss-on-outside-click handlers used to answer this with
 * `root.contains(target)`. A portaled popup is no longer a descendant of the
 * control that owns it, so containment alone now reports every click on the
 * menu's own entries as "outside" — the menu would unmount on pointerdown and
 * the entry's click never fire.
 */
export function inPopupSurface(root: HTMLElement | null | undefined, target: EventTarget | null): boolean {
    const el = target as Element | null;
    if (!el || typeof el.closest !== 'function') return false;
    return Boolean(root?.contains(el)) || el.closest('[data-anchored-popup]') !== null;
}
