import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FolderSymlink, Lock, Play, Plus } from 'lucide-react';
import { connectionDisplayAddr, type MudConnection } from '../../storage';
import { ActionMenu, type MenuAction } from './ActionMenu';
import { ProfileArt, profileIconUrl } from './ProfileArt';
import { formatLastPlayed } from './launcherModel';

/** What a profile tile or the banner can do, shared so both stay in step. */
export interface ProfileHandlers {
    connecting: boolean;
    connectingId: string | null;
    /** Profiles another tab holds open — one tab per profile (profileLock.ts),
     *  so these can't be connected or opened from here. */
    openIds: Set<string>;
    onConnect: (c: MudConnection) => void;
    onOpen: (c: MudConnection) => void;
    onEdit: (c: MudConnection) => void;
    onDuplicate: (c: MudConnection) => void;
    onDelete: (c: MudConnection) => void;
}

function busyTitle(c: MudConnection): string {
    return `${c.name} is already open in another tab`;
}

/** Edit and Delete stay available for a profile open elsewhere: they touch the
 *  connection record, not the locked profile storage. */
function menuActions(c: MudConnection, h: ProfileHandlers, withOpen: boolean): MenuAction[] {
    const elsewhere = h.openIds.has(c.id);
    return [
        ...(withOpen ? [{ label: 'Open offline', onSelect: () => h.onOpen(c), disabled: h.connecting || elsewhere }] : []),
        { label: 'Edit…', onSelect: () => h.onEdit(c), disabled: h.connecting },
        { label: 'Duplicate…', onSelect: () => h.onDuplicate(c), disabled: h.connecting },
        { label: 'Delete…', onSelect: () => h.onDelete(c), disabled: h.connecting, danger: true },
    ];
}

function LinkedBadge({ c }: { c: MudConnection }) {
    if (!c.mudletLinked) return null;
    return (
        <FolderSymlink size={14} className="launcher-linked" aria-label="Linked Mudlet folder">
            <title>Linked Mudlet folder — source of truth on disk</title>
        </FolderSymlink>
    );
}

function ElsewhereNote({ c }: { c: MudConnection }) {
    return (
        <span className="launcher-elsewhere" title={busyTitle(c)}>
            <Lock size={12} aria-hidden="true" />
            Open in another tab
        </span>
    );
}

/**
 * "Continue playing": the profile played most recently, large, with Connect
 * one click away. The logo sits in a fixed slot and Connect in its own column,
 * so a wide logo, a tiny one, or none at all never moves the button.
 */
export function LauncherHero({ connection: c, handlers: h }: { connection: MudConnection; handlers: ProfileHandlers }) {
    const icon = profileIconUrl(c);
    const elsewhere = h.openIds.has(c.id);
    const played = formatLastPlayed(c.lastConnectedAt);
    return (
        <section className="launcher-hero" aria-label={`Continue playing ${c.name}`}>
            <ProfileArt icon={icon} name={c.name} />
            <div className="launcher-hero__scrim" />
            <div className="launcher-hero__inner">
                <div className="launcher-hero__text">
                    <span className="launcher-kicker">{played ? 'Continue playing' : 'Ready to play'}</span>
                    <div className="launcher-hero__slot">
                        {icon
                            ? <img className="launcher-hero__logo" src={icon} alt={c.name} />
                            : <span className="launcher-hero__name">{c.name}</span>}
                    </div>
                    <span className="launcher-hero__meta">
                        {icon && <span className="launcher-hero__meta-name">{c.name}</span>}
                        <LinkedBadge c={c} />
                        <span>{connectionDisplayAddr(c)}</span>
                        {played && <span>{played}</span>}
                        {elsewhere && <ElsewhereNote c={c} />}
                    </span>
                </div>
                <div className="launcher-hero__actions">
                    <button
                        type="button"
                        className="launcher-connect launcher-connect--large"
                        onClick={() => h.onConnect(c)}
                        disabled={h.connecting || elsewhere}
                        title={elsewhere ? busyTitle(c) : undefined}
                        aria-label={`Connect to ${c.name}`}
                    >
                        <Play size={14} aria-hidden="true" fill="currentColor" />
                        {h.connectingId === c.id ? 'Connecting…' : 'Connect'}
                    </button>
                    <button
                        type="button"
                        className="launcher-ghost"
                        onClick={() => h.onOpen(c)}
                        disabled={h.connecting || elsewhere}
                        title={elsewhere ? busyTitle(c) : 'Open the profile without connecting'}
                        aria-label={`Open ${c.name} offline`}
                    >
                        Open offline
                    </button>
                    <ActionMenu label={`More actions for ${c.name}`} actions={menuActions(c, h, false)} />
                </div>
            </div>
        </section>
    );
}

/** The art and text of a profile tile — shared by the tile itself and the
 *  copy that follows the pointer while it is dragged. */
function TileFace({ connection: c, handlers: h }: { connection: MudConnection; handlers: ProfileHandlers }) {
    const icon = profileIconUrl(c);
    const elsewhere = h.openIds.has(c.id);
    const played = formatLastPlayed(c.lastConnectedAt);
    return (
        <>
            <span className="launcher-tile__art">
                <ProfileArt icon={icon} name={c.name} />
                {icon
                    ? <img className="launcher-tile__logo" src={icon} alt="" draggable={false} />
                    : <span className="launcher-tile__art-name">{c.name}</span>}
                {h.connectingId === c.id && <span className="launcher-tile__status">Connecting…</span>}
            </span>
            <span className="launcher-tile__body">
                <span className="launcher-tile__name">{c.name}<LinkedBadge c={c} /></span>
                <span className="launcher-tile__sub">
                    {elsewhere ? <ElsewhereNote c={c} /> : (played ?? connectionDisplayAddr(c))}
                </span>
            </span>
        </>
    );
}

interface ShelfProps {
    /** Profiles to show, in the player's own order (the banner's one excluded). */
    connections: MudConnection[];
    handlers: ProfileHandlers;
    editingId: string | null;
    onAddClick: () => void;
    /** The new order of the grid's profiles, after a drag or a Move entry. */
    onReorder: (orderedIds: string[]) => void;
    /** The Import menu, rendered in the section header. */
    importMenu: React.ReactNode;
}

interface DragState {
    id: string;
    grabDx: number;
    grabDy: number;
    width: number;
    height: number;
}

/**
 * The player's profiles, in the order they arrange them. Dragging a tile lifts
 * it into a copy that follows the pointer, opens a dashed gap where it would
 * land, and slides the other tiles over with a FLIP animation. A press that
 * doesn't travel is a plain click and connects, as before; a drag never does.
 * The ⋯ menu's Move entries do the same from the keyboard.
 */
export function ProfileShelf({ connections, handlers, editingId, onAddClick, onReorder, importMenu }: ShelfProps) {
    const [order, setOrder] = useState<string[]>(() => connections.map(c => c.id));
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const orderRef = useRef(order);
    const dragRef = useRef<DragState | null>(null);
    const cloneElRef = useRef<HTMLDivElement | null>(null);
    const cloneStartRef = useRef({ x: 0, y: 0 });
    const tileEls = useRef(new Map<string, HTMLLIElement>());
    const prevRects = useRef(new Map<string, DOMRect>());

    // Follow profiles added, removed or reordered elsewhere — but never mid-drag.
    useEffect(() => {
        if (draggingId) return;
        const next = connections.map(c => c.id);
        const prev = orderRef.current;
        if (next.length !== prev.length || next.some((v, i) => v !== prev[i])) {
            orderRef.current = next;
            setOrder(next);
        }
    }, [connections, draggingId]);

    // FLIP: after any render that moved tiles, start each from where it was
    // and let it glide to its new slot.
    useLayoutEffect(() => {
        const els = tileEls.current;
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
            if (old && (old.left !== rect.left || old.top !== rect.top)) {
                el.style.transform = `translate(${old.left - rect.left}px, ${old.top - rect.top}px)`;
            }
        });
        prevRects.current = next;
        const raf = requestAnimationFrame(() => {
            els.forEach((el, id) => {
                if (id === draggingId) return;
                el.style.transition = 'transform 200ms cubic-bezier(0.2, 0, 0, 1)';
                el.style.transform = '';
            });
        });
        return () => cancelAnimationFrame(raf);
    });

    const byId = new Map(connections.map(c => [c.id, c]));
    const ordered = order.map(id => byId.get(id)).filter((c): c is MudConnection => !!c);

    const setTileEl = (id: string) => (el: HTMLLIElement | null) => {
        if (el) tileEls.current.set(id, el);
        else tileEls.current.delete(id);
    };

    // The dragged tile takes the slot of whichever tile the pointer is over.
    // Hit-tested against the settled slot rects the FLIP pass recorded, not
    // elementFromPoint: mid-glide a displaced tile still covers its old slot,
    // and live hit-testing would bounce between the two.
    const updateTarget = (px: number, py: number) => {
        const id = dragRef.current?.id;
        if (!id) return;
        const cur = orderRef.current;
        let overId: string | null = null;
        for (const [tid, r] of prevRects.current) {
            if (px >= r.left && px < r.right && py >= r.top && py < r.bottom) { overId = tid; break; }
        }
        let next: string[] | null = null;
        if (overId && overId !== id) {
            next = cur.filter(x => x !== id);
            next.splice(cur.indexOf(overId), 0, id);
        } else if (!overId && (document.elementFromPoint(px, py) as HTMLElement | null)?.closest('.launcher-tile--add-slot')) {
            next = [...cur.filter(x => x !== id), id];
        }
        if (!next || next.every((v, i) => v === cur[i])) return;
        orderRef.current = next;
        setOrder(next);
    };

    const onTilePointerDown = (c: MudConnection) => (e: React.PointerEvent) => {
        if (e.button !== 0 || handlers.connecting) return;
        if ((e.target as HTMLElement).closest('.launcher-tile__more')) return;
        const el = tileEls.current.get(c.id);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const grabDx = e.clientX - rect.left, grabDy = e.clientY - rect.top;
        let started = false;

        const move = (ev: PointerEvent) => {
            if (!started) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
                started = true;
                dragRef.current = { id: c.id, grabDx, grabDy, width: rect.width, height: rect.height };
                cloneStartRef.current = { x: ev.clientX, y: ev.clientY };
                document.body.classList.add('launcher-sorting');
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
        const end = (commit: boolean) => () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onCancel);
            if (!started) return;
            document.body.classList.remove('launcher-sorting');
            dragRef.current = null;
            setDraggingId(null);
            // The release lands on the tile's own button: swallow that one
            // click, or every drag would end by connecting.
            const swallow = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
            window.addEventListener('click', swallow, { capture: true, once: true });
            setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
            if (commit) onReorder(orderRef.current);
            else { orderRef.current = connections.map(x => x.id); setOrder(orderRef.current); }
        };
        const onUp = end(true);
        const onCancel = end(false);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
    };

    const moveBy = (c: MudConnection, delta: -1 | 1) => {
        const cur = orderRef.current;
        const from = cur.indexOf(c.id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= cur.length) return;
        const next = [...cur];
        [next[from], next[to]] = [next[to], next[from]];
        orderRef.current = next;
        setOrder(next);
        onReorder(next);
    };

    const dragging = draggingId ? byId.get(draggingId) : undefined;

    return (
        <section className="launcher-section" aria-labelledby="launcher-profiles-title">
            <div className="launcher-section__header">
                <h2 className="launcher-section__title" id="launcher-profiles-title">Your profiles</h2>
                <div className="launcher-section__tools">{importMenu}</div>
            </div>
            <ul className="launcher-grid">
                {ordered.map((c, i) => {
                    const isDragged = c.id === draggingId;
                    const elsewhere = handlers.openIds.has(c.id);
                    const played = formatLastPlayed(c.lastConnectedAt);
                    return (
                        <li
                            key={c.id}
                            ref={setTileEl(c.id)}
                            className={'launcher-tile launcher-tile--profile'
                                + (isDragged ? ' launcher-tile--placeholder' : '')
                                + (elsewhere ? ' launcher-tile--elsewhere' : '')
                                + (editingId === c.id ? ' launcher-tile--editing' : '')}
                            style={isDragged && dragRef.current ? { height: dragRef.current.height } : undefined}
                            onPointerDown={onTilePointerDown(c)}
                        >
                            {!isDragged && (
                                <>
                                    <button
                                        type="button"
                                        className="launcher-tile__main"
                                        onClick={() => handlers.onConnect(c)}
                                        disabled={handlers.connecting || elsewhere}
                                        title={elsewhere ? busyTitle(c) : `Connect to ${c.name} — drag to reorder`}
                                        aria-label={`Connect to ${c.name}${played ? `, last played ${played}` : ''}`}
                                    >
                                        <TileFace connection={c} handlers={handlers} />
                                    </button>
                                    <ActionMenu
                                        className="launcher-tile__more"
                                        label={`More actions for ${c.name}`}
                                        actions={[
                                            ...menuActions(c, handlers, true),
                                            { label: 'Move earlier', onSelect: () => moveBy(c, -1), disabled: i === 0 },
                                            { label: 'Move later', onSelect: () => moveBy(c, 1), disabled: i === ordered.length - 1 },
                                        ]}
                                    />
                                </>
                            )}
                        </li>
                    );
                })}
                <li className="launcher-tile launcher-tile--add-slot">
                    <button
                        type="button"
                        className="launcher-tile__add"
                        onClick={onAddClick}
                        disabled={handlers.connecting}
                    >
                        <Plus size={22} aria-hidden="true" />
                        New profile
                    </button>
                </li>
            </ul>
            {dragging && dragRef.current && (
                <div
                    ref={cloneElRef}
                    className="launcher-tile launcher-tile--clone"
                    aria-hidden="true"
                    style={{
                        left: cloneStartRef.current.x - dragRef.current.grabDx,
                        top: cloneStartRef.current.y - dragRef.current.grabDy,
                        width: dragRef.current.width,
                        height: dragRef.current.height,
                    }}
                >
                    <span className="launcher-tile__main"><TileFace connection={dragging} handlers={handlers} /></span>
                </div>
            )}
        </section>
    );
}
