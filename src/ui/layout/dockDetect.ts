import type { DockSide } from '../windows/types';

const EMPTY_DOCK_ZONE = 80;

/**
 * 5-zone drop detection per slot.
 *
 * For a horizontal dock area (top/bottom):
 *   ┌────────────────────────────────┐
 *   │        SPLIT ABOVE 25%         │
 *   ├────┬──────────────────────┬────┤
 *   │bef │      tab stack       │aft │  (middle 50% cross-axis)
 *   │20% │      center 60%      │20% │
 *   ├────┴──────────────────────┴────┤
 *   │        SPLIT BELOW 25%         │
 *   └────────────────────────────────┘
 *
 * Ghost-slot hysteresis: when the cursor is inside the ghost slot that appears
 * on a before/after drop, we merge the ghost + adjacent real panel into one
 * bounding box for zone detection.  This keeps the center/split zones reachable
 * without having to drag all the way across the ghost to reach the shifted panel.
 */
export function detectDock(mx: number, my: number): {
    side: DockSide | null;
    slotIndex: number;
    stackTargetId?: string;
    splitTargetId?: string;
    splitBefore?: boolean;
} {
    // ── Bottom dock is special ─────────────────────────────────────────────────
    // It lives *below* the command bar in the content-layout column, so when it
    // pops in at its extent the middle row shrinks and .main-viewport's bottom
    // edge jumps up. Using that moving edge for activation but the (low) dock
    // area's own bottom edge for the empty-dock re-check is asymmetric: the
    // cursor that triggered activation sits near the dock's TOP, >EMPTY_DOCK_ZONE
    // from its bottom, so it deactivates → viewport grows back → reactivates →
    // flicker. Anchor instead to the command bar's top: once the cursor reaches
    // the input-bar level (or anywhere below it) bottom activates, and because
    // the bar moves *up* with the dock the active zone only grows — stable
    // hysteresis, no oscillation.
    const commandBar = document.querySelector<HTMLElement>('.command-bar');
    if (commandBar) {
        const cr = commandBar.getBoundingClientRect();
        if (mx >= cr.left && mx <= cr.right && my >= cr.top) {
            const bottomDock = document.querySelector<HTMLElement>('.dock-area-bottom');
            if (bottomDock) {
                const br = bottomDock.getBoundingClientRect();
                const inDock = mx >= br.left && mx <= br.right && my >= br.top && my <= br.bottom;
                const hasRealPanels = !!bottomDock.querySelector('.dock-panel-slot:not(.dock-panel-slot--preview)');
                if (inDock && hasRealPanels) {
                    return { side: 'bottom', ...slotDropInfo(bottomDock, 'bottom', mx, my) };
                }
            }
            return { side: 'bottom', slotIndex: 0 };
        }
    }

    for (const side of ['left', 'right', 'top'] as DockSide[]) {
        const el = document.querySelector<HTMLElement>(`.dock-area-${side}`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (mx < r.left || mx > r.right || my < r.top || my > r.bottom) continue;

        // If the dock area is empty (only a preview ghost, no real panels), apply the
        // same EMPTY_DOCK_ZONE constraint used for activation, so deactivation is symmetric.
        const hasRealPanels = !!el.querySelector('.dock-panel-slot:not(.dock-panel-slot--preview)');
        if (!hasRealPanels) {
            const inZone =
                side === 'left'   ? mx - r.left   < EMPTY_DOCK_ZONE :
                side === 'right'  ? r.right  - mx < EMPTY_DOCK_ZONE :
                /* top */           my - r.top    < EMPTY_DOCK_ZONE;
            if (!inZone) continue;
            return { side, slotIndex: 0 };
        }

        const info = slotDropInfo(el, side, mx, my);
        return { side, ...info };
    }
    const vp = document.querySelector<HTMLElement>('.main-viewport');
    if (vp) {
        const r = vp.getBoundingClientRect();
        // The activation band is the strip *inside* the viewport's edge, not the
        // half-plane beyond it: `my - r.top < EMPTY_DOCK_ZONE` is true for every y
        // above the viewport too, which is the whole top bar. A titlebar dragged
        // up there therefore armed the top dock — and that state cannot survive
        // its own preview. The ghost dock area opens at the viewport's old top
        // edge, so on the next move the cursor is above `.dock-area-top` (the loop
        // above bails), and `.dock-area-top` now exists so this fallback is
        // skipped as well → null → ghost gone → viewport grows back → armed again.
        // Flicker for as long as the pointer sits in the bar.
        //
        // Requiring the cursor to be inside the viewport makes activation and
        // deactivation measure the same edge, and matches Mudlet: a titlebar held
        // over the toolbar is outside the client area, so docking is not live
        // there at all and the window simply stays floating.
        const inside = mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
        // Bottom side is handled above, anchored to the command bar.
        if (inside && !document.querySelector('.dock-area-left')   && mx - r.left   < EMPTY_DOCK_ZONE) return { side: 'left',   slotIndex: 0 };
        if (inside && !document.querySelector('.dock-area-right')  && r.right  - mx < EMPTY_DOCK_ZONE) return { side: 'right',  slotIndex: 0 };
        if (inside && !document.querySelector('.dock-area-top')    && my - r.top    < EMPTY_DOCK_ZONE) return { side: 'top',    slotIndex: 0 };
    }
    return { side: null, slotIndex: 0 };
}

type DropInfo = {
    slotIndex: number;
    stackTargetId?: string;
    splitTargetId?: string;
    splitBefore?: boolean;
};

function zones(relX: number, relY: number, horizontal: boolean, targetId: string | undefined, slotIndex: number): DropInfo | null {
    const crossRel   = horizontal ? relY : relX;
    const primaryRel = horizontal ? relX : relY;
    // Primary-axis edges are checked first so they span the full cross-axis width.
    // This gives corners to positional-insert, not to cross-axis split — the corner
    // of a left-dock panel is "above/below" territory, not "split left/right".
    if (primaryRel < 0.2 || primaryRel > 0.8) return null; // fall through to midpoint
    if (crossRel < 0.25) return { slotIndex, splitTargetId: targetId, splitBefore: true };
    if (crossRel > 0.75) return { slotIndex, splitTargetId: targetId, splitBefore: false };
    return { slotIndex, stackTargetId: targetId };
}

function slotDropInfo(dockEl: HTMLElement, side: DockSide, mx: number, my: number): DropInfo {
    const realSlots = dockEl.querySelectorAll<HTMLElement>('.dock-panel-slot:not(.dock-panel-slot--preview)');
    const allSlots  = Array.from(dockEl.querySelectorAll<HTMLElement>('.dock-panel-slot'));
    const horizontal = side === 'top' || side === 'bottom';

    // ── Ghost-slot hysteresis ──────────────────────────────────────────────────
    // When the cursor is inside an outer positional-insert ghost, merge the ghost
    // and the adjacent real panel into one bounding box for zone detection.  This
    // keeps the center/split zones reachable — without the merge, the panel has
    // shifted far enough that the user must drag well past the ghost to reach it.
    for (let j = 0; j < allSlots.length; j++) {
        if (!allSlots[j].classList.contains('dock-panel-slot--preview')) continue;
        // Inner split-preview ghosts live inside a real slot; handled separately below.
        if (allSlots[j].closest('.dock-panel-slot:not(.dock-panel-slot--preview)')) continue;
        const gr = allSlots[j].getBoundingClientRect();
        if (mx < gr.left || mx > gr.right || my < gr.top || my > gr.bottom) continue;

        let insertIdx = 0;
        for (let k = 0; k < j; k++) {
            if (!allSlots[k].classList.contains('dock-panel-slot--preview')) insertIdx++;
        }

        // Find the adjacent real slot directly after the ghost to merge with.
        let adj: HTMLElement | null = null;
        for (let k = j + 1; k < allSlots.length; k++) {
            if (!allSlots[k].classList.contains('dock-panel-slot--preview')) { adj = allSlots[k]; break; }
        }
        if (adj) {
            const ar = adj.getBoundingClientRect();
            const mL = horizontal ? Math.min(gr.left, ar.left) : gr.left;
            const mR = horizontal ? Math.max(gr.right, ar.right) : gr.right;
            const mT = horizontal ? gr.top : Math.min(gr.top, ar.top);
            const mB = horizontal ? gr.bottom : Math.max(gr.bottom, ar.bottom);
            const relX = (mx - mL) / ((mR - mL) || 1);
            const relY = (my - mT) / ((mB - mT) || 1);
            // Only zone-detect once the cursor has crossed into the adjacent panel's half.
            // If we zone-detect inside the ghost's own half (primaryRel near 0), the center
            // zone fires → stackTargetId → ghost disappears → panel shifts back → cursor is
            // at the panel's primary edge → null → slotIndex → ghost reappears → oscillation.
            const primaryRel  = horizontal ? relX : relY;
            const ghostPrim   = horizontal ? (gr.right - gr.left) : (gr.bottom - gr.top);
            const mergedPrim  = horizontal ? (mR - mL) : (mB - mT);
            if (primaryRel >= ghostPrim / mergedPrim) {
                const hit = zones(relX, relY, horizontal, adj.getAttribute('data-dock-panel') ?? undefined, insertIdx);
                if (hit) return hit;
            }
        }
        return { slotIndex: insertIdx };
    }

    // ── Pass 1: real-slot zone detection ──────────────────────────────────────
    for (let i = 0; i < realSlots.length; i++) {
        const r = realSlots[i].getBoundingClientRect();
        if (mx < r.left || mx > r.right || my < r.top || my > r.bottom) continue;

        // Hysteresis for inner split-group preview ghosts: merge the ghost with the
        // adjacent split member so the center/split zones remain reachable without
        // requiring the user to drag past the ghost to reach the shifted sub-panel.
        for (const ghost of realSlots[i].querySelectorAll<HTMLElement>('.split-group-slot--preview[data-split-target]')) {
            const gr = ghost.getBoundingClientRect();
            if (mx < gr.left || mx > gr.right || my < gr.top || my > gr.bottom) continue;

            // Inner split groups stack along the cross-axis of the dock.
            const innerH = !horizontal;
            let adj: Element | null = ghost.nextElementSibling;
            while (adj && !adj.matches('[data-split-panel]')) adj = adj.nextElementSibling;
            if (adj) {
                const adjEl = adj as HTMLElement;
                const ar = adjEl.getBoundingClientRect();
                const mL = innerH ? Math.min(gr.left, ar.left) : gr.left;
                const mR = innerH ? Math.max(gr.right, ar.right) : gr.right;
                const mT = innerH ? gr.top : Math.min(gr.top, ar.top);
                const mB = innerH ? gr.bottom : Math.max(gr.bottom, ar.bottom);
                const relX = (mx - mL) / ((mR - mL) || 1);
                const relY = (my - mT) / ((mB - mT) || 1);
                const primaryRel = innerH ? relX : relY;
                const ghostPrim  = innerH ? (gr.right - gr.left) : (gr.bottom - gr.top);
                const mergedPrim = innerH ? (mR - mL) : (mB - mT);
                if (primaryRel >= ghostPrim / mergedPrim) {
                    const hit = zones(relX, relY, horizontal, adjEl.getAttribute('data-split-panel') ?? undefined, i);
                    if (hit) return hit;
                }
            }
            return {
                slotIndex:     i,
                splitTargetId: ghost.getAttribute('data-split-target') ?? undefined,
                splitBefore:   ghost.getAttribute('data-split-before') === 'true',
            };
        }

        // For split group slots, resolve zone detection to the specific sub-panel under
        // the cursor. Without this, the zone rect and tid are always for the outer slot,
        // so stacking onto the right panel reports the first panel as the target.
        let zoneRect = r;
        let tid = realSlots[i].getAttribute('data-dock-panel') ?? undefined;
        let foundSub = false;
        const subPanels = Array.from(realSlots[i].querySelectorAll<HTMLElement>('.split-group-slot[data-split-panel]'));
        for (const sub of subPanels) {
            const sr = sub.getBoundingClientRect();
            if (mx >= sr.left && mx <= sr.right && my >= sr.top && my <= sr.bottom) {
                zoneRect = sr;
                tid = sub.getAttribute('data-split-panel') ?? tid;
                foundSub = true;
                break;
            }
        }
        // If the cursor is between sub-panels (over the splitter strip), fall directly
        // to split-between rather than letting the outer-slot zone detection fire,
        // which would incorrectly target the first panel with a stack drop.
        if (!foundSub && subPanels.length > 1) {
            const innerHoriz = !horizontal; // split group direction is cross-axis of dock
            for (let k = 0; k < subPanels.length - 1; k++) {
                const aR = subPanels[k].getBoundingClientRect();
                const bR = subPanels[k + 1].getBoundingClientRect();
                const inGap = innerHoriz
                    ? (mx >= aR.right && mx <= bR.left)
                    : (my >= aR.bottom && my <= bR.top);
                if (inGap) {
                    return { slotIndex: i, splitTargetId: subPanels[k].getAttribute('data-split-panel') ?? undefined, splitBefore: false };
                }
            }
        }

        const relX = (mx - zoneRect.left) / ((zoneRect.right  - zoneRect.left) || 1);
        const relY = (my - zoneRect.top)  / ((zoneRect.bottom - zoneRect.top)  || 1);
        const hit  = zones(relX, relY, horizontal, tid, i);
        if (hit) return hit;
        break; // edge zone → midpoint
    }

    // ── Pass 2: midpoint before/after (ghost-stable) ──────────────────────────
    const primary = horizontal ? mx : my;
    for (let i = 0; i < realSlots.length; i++) {
        const r   = realSlots[i].getBoundingClientRect();
        const mid = horizontal ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2;
        if (primary < mid) return { slotIndex: i };
    }
    return { slotIndex: realSlots.length };
}
