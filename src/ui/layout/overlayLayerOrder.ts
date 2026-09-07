/**
 * Flat per-viewport z-order for every kind of overlay content: nested windows /
 * mini-consoles (including the embedded mapper), labels, overlay command lines,
 * and scroll boxes. This is the Mudlet Web analogue of Mudlet's Qt widget stack.
 *
 * ## Why flat (and not a container tree)
 *
 * In real Mudlet, `raiseWindow`/`lowerWindow` operate on ONE flat stack per
 * console/userwindow. Geyser containers (Adjustable.Container, VBox/HBox, a
 * flyout menu, a gauge's labels) are pure Lua geometry helpers — they never
 * reparent the real QWidgets, which all stay siblings of the console. So
 * `raise` brings a widget to the front of EVERY widget in that window, and
 * z-order is simply most-recently-raised-wins, flat, per real viewport.
 * (An earlier version of this file modelled Geyser containers as a real tree
 * and ranked by a pre-order walk; that diverged from Mudlet — it buried a
 * freshly-raised widget beneath its container's stale position — and is why
 * an opened config menu rendered *under* a sibling mapper. Flat is correct.)
 *
 * Correct z-order alone is not enough: every overlay leaf must also render into
 * the SAME CSS stacking context for these ranks to take visual effect. Mudlet Web
 * ensures that by rendering all four overlay kinds under one wrapper per
 * viewport (`.main-overlay-root` for main; the panel viewport for a userwindow)
 * whose descendants' inline z-indices all compete directly. See
 * FloatingWindowLayer / OutputArea — the nested-window layer is portaled into
 * that same wrapper, NOT a separate sibling, precisely so a window's z and a
 * label's z compare in one context.
 *
 * ## Bounded ranks
 *
 * `getZ` returns a small ordinal (0..N-1 among the widgets under one viewport),
 * NOT the raw monotonic `order`. The `order` keys grow unboundedly over a
 * session (every raise/lower, including the ones Geyser fires on each reflow,
 * bumps one), and feeding that straight into a CSS z-index risks it eventually
 * exceeding fixed "always on top" bands elsewhere (e.g. the map's right-click
 * menu at z:1000 — which regressed exactly this way once). Ranking into a range
 * bounded by the live widget count keeps the output far below any such band.
 */
export type OverlayLayerKind = 'windows' | 'labels' | 'cmdlines' | 'scrollboxes';

// Fallback ordering for a widget queried before it was ever registered
// (defensive — normally every widget is touched at creation). Keeps the
// historical "windows below labels below cmdlines below scrollboxes" default.
const BASE_RANK: Record<OverlayLayerKind, number> = {
    windows: 0,
    labels: 1,
    cmdlines: 2,
    scrollboxes: 3,
};

const KIND_COUNT = Object.keys(BASE_RANK).length;

type Listener = () => void;

interface TrackedWidget {
    kind: OverlayLayerKind;
    id: string;
    /** Front-to-back key: larger = more front. Bumped positive by touch,
     *  negative by sink. */
    order: number;
    /** Bounded ordinal (0..N-1) recomputed lazily when the parent is dirty. */
    rank: number;
}

export class OverlayLayerOrder {
    private seq = 0;
    private negSeq = 0;
    // parentId -> "kind\0id" -> tracked widget
    private widgets = new Map<string, Map<string, TrackedWidget>>();
    private listeners = new Map<string, Set<Listener>>();
    /** Viewports whose widgets' `rank` fields are stale and must be re-sorted
     *  on the next getZ(). Only the viewport actually mutated is marked, so a
     *  reflow storm under one window never re-sorts the others, and a drag —
     *  which re-renders via move()'s notify() but never mutates this registry —
     *  leaves every parent clean, so getZ() is a plain field read per widget. */
    private dirty = new Set<string>();

    private static widgetKey(kind: OverlayLayerKind, id: string): string {
        return `${kind}\0${id}`;
    }

    private upsert(parentId: string, kind: OverlayLayerKind, id: string): TrackedWidget {
        let m = this.widgets.get(parentId);
        if (!m) { m = new Map(); this.widgets.set(parentId, m); }
        const key = OverlayLayerOrder.widgetKey(kind, id);
        let w = m.get(key);
        if (!w) { w = { kind, id, order: 0, rank: 0 }; m.set(key, w); }
        return w;
    }

    /** A widget was created / reparented / raised under `parentId` — bring it
     *  to the front of that viewport's flat stack. */
    touch(parentId: string, kind: OverlayLayerKind, id: string): void {
        this.upsert(parentId, kind, id).order = ++this.seq;
        this.dirty.add(parentId);
        this.emit(parentId);
    }

    /** A widget was lowered under `parentId` (lowerWindow / lowerLabel) — drop
     *  it below every other widget in that viewport's stack. */
    sink(parentId: string, kind: OverlayLayerKind, id: string): void {
        this.upsert(parentId, kind, id).order = --this.negSeq;
        this.dirty.add(parentId);
        this.emit(parentId);
    }

    /** Stop tracking a destroyed widget, so a later widget re-using the same
     *  id starts fresh and dead entries don't accumulate. */
    forget(parentId: string, kind: OverlayLayerKind, id: string): void {
        const m = this.widgets.get(parentId);
        if (m?.delete(OverlayLayerOrder.widgetKey(kind, id))) {
            this.dirty.add(parentId);
            this.emit(parentId);
        }
    }

    private emit(parentId: string): void {
        for (const fn of this.listeners.get(parentId) ?? []) fn();
    }

    /** Front-to-back rank (0 = back) for one widget under `parentId`, ranked
     *  among every widget of any kind in that viewport by most-recent raise.
     *  Re-sorts the viewport's widgets only when it's dirty; otherwise this is
     *  a couple of Map lookups plus a field read. */
    getZ(parentId: string, kind: OverlayLayerKind, id: string): number {
        const m = this.widgets.get(parentId);
        if (this.dirty.delete(parentId) && m) {
            let i = 0;
            for (const w of [...m.values()].sort((a, b) => a.order - b.order)) w.rank = i++;
        }
        const w = m?.get(OverlayLayerOrder.widgetKey(kind, id));
        if (w) return w.rank;
        // Never registered (defensive): below every registered widget, ordered
        // among other unregistered kinds by their historical default band.
        return BASE_RANK[kind] - KIND_COUNT;
    }

    /** Re-render trigger for a viewport's overlay wrapper components. */
    subscribe(parentId: string, cb: Listener): () => void {
        let set = this.listeners.get(parentId);
        if (!set) { set = new Set(); this.listeners.set(parentId, set); }
        set.add(cb);
        return () => {
            set!.delete(cb);
            if (set!.size === 0) this.listeners.delete(parentId);
        };
    }
}
