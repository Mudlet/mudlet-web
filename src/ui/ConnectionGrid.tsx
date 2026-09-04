import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FolderSymlink, Lock, Trash2 } from 'lucide-react';
import { Button } from './components';
import { connectionDisplayAddr, type MudConnection } from '../storage';
import { gameIconUrl } from '../mud/games/gameIcons';
import { findGameForConnection } from '../mud/games/gameLinks';

/** Deterministic background color for a profile's name tile — same name always
 *  yields the same hue, so each profile gets a stable, distinct color. */
function avatarColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360} 42% 38%)`;
}

/** Shared canvas 2D context for measuring text width when fitting a name into
 *  the icon tile. Created lazily, reused across calls. */
let measureCtx: CanvasRenderingContext2D | null = null;

/** Largest font (px) at which `name` fits the tile on one line — mirrors
 *  Mudlet's customIcon(), which starts large and shrinks to a floor until the
 *  profile name fits the 120×30 box. */
function fitNameFontSize(name: string): number {
    const MAX = 18, MIN = 7, MAX_W = 110; // tile is 120px wide, minus padding
    if (typeof document === 'undefined') return 12;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return 12;
    for (let size = MAX; size > MIN; size--) {
        measureCtx.font = `600 ${size}px sans-serif`;
        if (measureCtx.measureText(name).width <= MAX_W) return size;
    }
    return MIN;
}

/** Mudlet-style profile icon. Renders the custom icon when one is set
 *  (setProfileIcon), otherwise a colored tile with the profile name — matching
 *  Mudlet's behaviour of drawing the name onto profiles without an icon. */
function ProfileAvatar({ connection }: { connection: MudConnection }) {
    const name = connection.name;
    // A profile made from the bundled catalogue keeps its game's logo without
    // storing one: the icon field holds a data URI (setProfileIcon), and copying
    // a 100 KB logo into localStorage per profile to draw what the app already
    // ships would be a poor trade. Resolved from the whole record rather than
    // the name alone, so a second "Achaea (2)" — or one the player renamed, or
    // typed in by hand — is recognised by its host too. A custom icon wins.
    const src = connection.icon ?? gameIconUrl(findGameForConnection(connection) ?? undefined);
    if (src) {
        return <img className="connection-avatar" src={src} alt="" aria-hidden="true" />;
    }
    const label = name || '?';
    return (
        <span
            className="connection-avatar connection-avatar--name"
            style={{ backgroundColor: avatarColor(name) }}
            aria-hidden="true"
        >
            <span className="connection-avatar-text" style={{ fontSize: `${fitNameFontSize(label)}px` }}>
                {label}
            </span>
        </span>
    );
}

interface Props {
    connections: MudConnection[];
    connecting: boolean;
    connectingId: string | null;
    editingId: string | null;
    /** Ids already open in another browser tab — one tab per profile, so these
     *  can't be opened here until that tab releases them. */
    openIds: Set<string>;
    onConnect: (c: MudConnection) => void;
    onOpen: (c: MudConnection) => void;
    onEdit: (c: MudConnection) => void;
    onDelete: (c: MudConnection) => void;
    onReorder: (orderedIds: string[]) => void;
    onAddClick: () => void;
}

interface DragState {
    id: string;
    grabDx: number;
    grabDy: number;
    width: number;
    height: number;
}

/** Draggable, animated grid of profile cards. Reordering lifts the dragged tile
 *  into a floating clone, opens a dashed placeholder at the target slot, and
 *  slides the remaining tiles into their new positions with a FLIP animation. */
export function ConnectionGrid({
    connections, connecting, connectingId, editingId, openIds,
    onConnect, onOpen, onEdit, onDelete, onReorder, onAddClick,
}: Props) {
    const [order, setOrder] = useState<string[]>(() => connections.map(c => c.id));
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const orderRef = useRef(order);
    const dragRef = useRef<DragState | null>(null);
    const cloneElRef = useRef<HTMLDivElement | null>(null);
    const cloneStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    // Live element + last-known layout position of each tile, for FLIP.
    const tileEls = useRef<Map<string, HTMLDivElement>>(new Map());
    const prevRects = useRef<Map<string, DOMRect>>(new Map());

    // Keep the local order in sync when profiles are added/removed elsewhere,
    // preserving the current arrangement and never while a drag is in flight.
    useEffect(() => {
        if (draggingId) return;
        const ids = connections.map(c => c.id);
        const idSet = new Set(ids);
        const prev = orderRef.current;
        const kept = prev.filter(id => idSet.has(id));
        const added = ids.filter(id => !prev.includes(id));
        const next = [...kept, ...added];
        if (next.length !== prev.length || next.some((v, i) => v !== prev[i])) {
            orderRef.current = next;
            setOrder(next);
        }
    }, [connections, draggingId]);

    // FLIP: after any layout-changing render, invert each tile to its previous
    // spot then release it so the browser tweens the transform to zero.
    useLayoutEffect(() => {
        const els = tileEls.current;
        // Clear any in-flight transforms first so we measure true layout, even
        // mid-animation (rapid reorders would otherwise read a moving rect).
        els.forEach((el, id) => {
            if (id === draggingId) return;
            el.style.transition = 'none';
            el.style.transform = '';
        });
        const next = new Map<string, DOMRect>();
        els.forEach((el, id) => {
            const rect = el.getBoundingClientRect();
            next.set(id, rect);
            if (id === draggingId) return;
            const old = prevRects.current.get(id);
            if (old) {
                const dx = old.left - rect.left;
                const dy = old.top - rect.top;
                if (dx || dy) el.style.transform = `translate(${dx}px, ${dy}px)`;
            }
        });
        prevRects.current = next;
        requestAnimationFrame(() => {
            els.forEach((el, id) => {
                if (id === draggingId) return;
                el.style.transition =
                    'transform 200ms cubic-bezier(0.2, 0, 0, 1), border-color 0.15s, box-shadow 0.15s';
                el.style.transform = '';
            });
        });
    });

    const byId = new Map(connections.map(c => [c.id, c]));
    const ordered = order.map(id => byId.get(id)).filter((c): c is MudConnection => !!c);

    const setTileEl = (id: string) => (el: HTMLDivElement | null) => {
        if (el) tileEls.current.set(id, el);
        else tileEls.current.delete(id);
    };

    // Reorder so the dragged id takes the slot of whichever tile the pointer is
    // over (the hovered tile and everything between shift toward the vacated
    // slot). Stable with uniform tiles: after the move the pointer rests on the
    // dragged tile's own slot, so hovering there is a no-op.
    //
    // Targets are resolved against the true layout slot rects (prevRects, which
    // the FLIP effect refreshes with transforms cleared after every reorder) —
    // NOT elementFromPoint. Mid-tween a displaced tile still visually covers
    // its old slot, so live hit-testing would re-hit it and oscillate.
    const updateTarget = (px: number, py: number) => {
        const id = dragRef.current?.id;
        if (!id) return;
        const cur = orderRef.current;
        let next: string[] | null = null;
        let overId: string | null = null;
        for (const [tid, r] of prevRects.current) {
            if (px >= r.left && px < r.right && py >= r.top && py < r.bottom) {
                overId = tid;
                break;
            }
        }
        if (overId === id) return;
        if (overId) {
            const from = cur.indexOf(id);
            const to = cur.indexOf(overId);
            if (from < 0 || to < 0) return;
            const moved = [...cur];
            moved.splice(from, 1);
            moved.splice(to, 0, id);
            next = moved;
        } else if ((document.elementFromPoint(px, py) as HTMLElement | null)?.closest('.connection-tile--add')) {
            // Dropped past the last profile — send it to the end.
            const without = cur.filter(x => x !== id);
            without.push(id);
            next = without;
        }
        if (!next) return;
        if (next.length === cur.length && next.every((v, i) => v === cur[i])) return;
        orderRef.current = next;
        setOrder(next);
    };

    const onTilePointerDown = (c: MudConnection) => (e: React.PointerEvent) => {
        if (e.button !== 0 || connecting) return;
        // Let the action buttons handle their own clicks.
        if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
        const el = tileEls.current.get(c.id);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const grabDx = e.clientX - rect.left;
        const grabDy = e.clientY - rect.top;
        let started = false;

        const move = (ev: PointerEvent) => {
            if (!started) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
                started = true;
                dragRef.current = { id: c.id, grabDx, grabDy, width: rect.width, height: rect.height };
                cloneStartRef.current = { x: ev.clientX, y: ev.clientY };
                document.body.classList.add('is-sorting');
                setDraggingId(c.id);
            }
            ev.preventDefault();
            const clone = cloneElRef.current, ds = dragRef.current;
            if (clone && ds) {
                clone.style.left = `${ev.clientX - ds.grabDx}px`;
                clone.style.top = `${ev.clientY - ds.grabDy}px`;
            }
            updateTarget(ev.clientX, ev.clientY);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (started) {
                document.body.classList.remove('is-sorting');
                dragRef.current = null;
                setDraggingId(null);
                onReorder(orderRef.current);
            }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // A profile open in another tab can't be opened here (one tab per profile —
    // see profileLock.ts), so say so on the tile and take its actions out of
    // reach rather than letting the click land on the "waiting for the other
    // tab" screen. Edit/Delete stay enabled: they touch the connection record in
    // localStorage, not the locked profile storage.
    const tileInner = (c: MudConnection) => {
        const elsewhere = openIds.has(c.id);
        const busyTitle = `${c.name} is already open in another tab`;
        return (
            <>
                <div className="connection-tile__header">
                    <ProfileAvatar connection={c} />
                    <Button
                        variant="primary"
                        className="connection-tile__connect"
                        onClick={() => onConnect(c)}
                        disabled={connecting || elsewhere}
                        title={elsewhere ? busyTitle : undefined}
                    >
                        {connectingId === c.id ? 'Connecting…' : 'Connect'}
                    </Button>
                </div>
                <div className="connection-tile__body">
                    <span className="connection-name connection-tile__name">
                        {c.name}
                        {c.mudletLinked && (
                            <FolderSymlink size={13} style={{ opacity: 0.65, flexShrink: 0 }} aria-label="Linked Mudlet folder">
                                <title>Linked Mudlet folder — source of truth on disk</title>
                            </FolderSymlink>
                        )}
                    </span>
                    <span className="connection-addr">{connectionDisplayAddr(c)}</span>
                    {elsewhere && (
                        <span className="connection-tile__elsewhere" title={busyTitle}>
                            <Lock size={11} aria-hidden="true" />
                            Already open in another tab
                        </span>
                    )}
                </div>
                <div className="connection-tile__actions">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onOpen(c)}
                        disabled={connecting || elsewhere}
                        title={elsewhere ? busyTitle : 'Open profile offline'}
                    >
                        Open
                    </Button>
                    <span className="connection-tile__actions-spacer" />
                    <Button variant="icon" size="sm" onClick={() => onEdit(c)} disabled={connecting} aria-label="Edit connection" title="Edit">
                        ✎
                    </Button>
                    <Button variant="icon" size="sm" onClick={() => onDelete(c)} disabled={connecting} aria-label="Delete connection" title="Delete">
                        <Trash2 size={14} />
                    </Button>
                </div>
            </>
        );
    };

    const dragging = draggingId ? byId.get(draggingId) : undefined;

    return (
        <div className="connection-grid" role="list">
            {ordered.map(c => {
                const isDragged = c.id === draggingId;
                return (
                    <div
                        key={c.id}
                        role="listitem"
                        data-sortable-id={c.id}
                        ref={setTileEl(c.id)}
                        className={
                            'connection-tile' +
                            (isDragged ? ' connection-tile--placeholder' : '') +
                            (openIds.has(c.id) ? ' connection-tile--elsewhere' : '') +
                            (editingId === c.id ? ' connection-card--editing' : '')
                        }
                        style={isDragged && dragRef.current ? { height: dragRef.current.height } : undefined}
                        onPointerDown={onTilePointerDown(c)}
                    >
                        {isDragged ? null : tileInner(c)}
                    </div>
                );
            })}
            <button
                type="button"
                className="connection-tile connection-tile--add"
                onClick={onAddClick}
                disabled={connecting}
            >
                <span className="connection-tile__add-plus" aria-hidden="true">+</span>
                <span className="connection-tile__add-label">Add connection</span>
            </button>

            {dragging && dragRef.current && (
                <div
                    ref={cloneElRef}
                    className="connection-tile connection-tile--clone"
                    style={{
                        left: cloneStartRef.current.x - dragRef.current.grabDx,
                        top: cloneStartRef.current.y - dragRef.current.grabDy,
                        width: dragRef.current.width,
                        height: dragRef.current.height,
                    }}
                >
                    {tileInner(dragging)}
                </div>
            )}
        </div>
    );
}
