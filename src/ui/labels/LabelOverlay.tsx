import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { LabelManager, LabelMouseEvent, LabelState, LabelWheelEvent } from './LabelManager';
import type { MoviePlayer } from './gifMovie';
import { cssTextToParts, qtDeclarationsToCss, qtAlignmentToFlex, cssEscape } from './qtCss';
import { labelLinkHref } from './labelLinks';
import './LabelOverlay.css';

// Mudlet reports `event.button` as a Qt button *name string* (not an int) — see
// TLuaInterpreter `csmMouseButtons`. Geyser packages branch on these literals
// (`if event.button == "LeftButton"`), so we must hand Lua the same strings.
// DOM `e.button` is 0/1/2/3/4 for left/middle/right/back/forward.
const BUTTON_DOM_TO_MUDLET: Record<number, string> = {
    0: 'LeftButton', 1: 'MidButton', 2: 'RightButton', 3: 'BackButton', 4: 'ForwardButton',
};

// Mudlet's Qt `button()` is only the pressed/released button for
// press/release/click/double-click; for move/enter/leave it is Qt::NoButton.
// DOM move/enter/leave report `e.button === 0`, which we must not mistake for a
// left click — report "NoButton" there to match Mudlet. Exported pure so the
// DOM→Mudlet mapping (the part packages depend on) is unit-testable.
export function domButtonToMudlet(type: string, domButton: number): string {
    if (type === 'mousemove' || type === 'pointermove'
        || type === 'mouseenter' || type === 'mouseleave') return 'NoButton';
    return BUTTON_DOM_TO_MUDLET[domButton] ?? 'NoButton';
}

/** Escape a value for use inside a double-quoted CSS string (an attribute
 *  selector's value). Not `cssEscape` — that produces an *identifier* escape,
 *  which over-escapes almost every character of a URI. */
function cssStringLiteral(s: string): string {
    return s.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\A ').replace(/\r/g, '');
}

function buildMouseEvent(e: React.MouseEvent<HTMLDivElement>): LabelMouseEvent {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
        button:  domButtonToMudlet(e.type, e.button),
        x:       Math.round(e.clientX - rect.left),
        y:       Math.round(e.clientY - rect.top),
        globalX: Math.round(e.clientX),
        globalY: Math.round(e.clientY),
        alt:     e.altKey,
        ctrl:    e.ctrlKey,
        shift:   e.shiftKey,
        meta:    e.metaKey,
    };
}

function buildWheelEvent(e: React.WheelEvent<HTMLDivElement>): LabelWheelEvent {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
        button:  'NoButton',
        x:       Math.round(e.clientX - rect.left),
        y:       Math.round(e.clientY - rect.top),
        globalX: Math.round(e.clientX),
        globalY: Math.round(e.clientY),
        alt:     e.altKey,
        ctrl:    e.ctrlKey,
        shift:   e.shiftKey,
        meta:    e.metaKey,
        angleDelta: { x: -e.deltaX, y: -e.deltaY },
    };
}

interface LabelOverlayProps {
    manager: LabelManager;
    parent: string;
}

export function LabelOverlay({ manager, parent }: LabelOverlayProps) {
    const [labels, setLabels] = useState<LabelState[]>(() => manager.list(parent));
    useEffect(() => manager.subscribe(parent, setLabels), [manager, parent]);
    // Each label's own z-index (below) is shared with this parent's nested
    // windows / cmd lines / scroll boxes (see overlayLayerOrder.ts) instead
    // of the whole wrapper carrying one block z-index, so raiseWindow/
    // lowerWindow on any of them can genuinely interleave per-widget,
    // matching Mudlet's single Qt widget stack. Re-render on any touch under
    // this parent so those per-label ordinals stay current.
    const [, setLayerTick] = useState(0);
    useEffect(() => manager.overlayZ.subscribe(parent, () => setLayerTick(t => t + 1)), [manager, parent]);
    if (labels.length === 0) return null;
    return (
        <div className="label-overlay">
            {labels.map(l => (
                <Label
                    key={l.name}
                    l={l}
                    manager={manager}
                    zIndex={manager.overlayZ.getZ(parent, 'labels', l.name)}
                />
            ))}
        </div>
    );
}

function Label({ l, manager, zIndex }: { l: LabelState; manager: LabelManager; zIndex: number }) {
    // Latest-callback ref so re-renders during a hover/drag don't lose pointer
    // state; the Mudlet API replaces callbacks live and we want the next event
    // to land on the new fn even if React hasn't re-mounted us yet.
    const ref = useRef(l);
    ref.current = l;

    // Coalesce high-frequency pointermove into one dispatch per animation frame.
    // A drag fires pointermove at the display's refresh rate (120Hz+), and each
    // event runs the label's (often expensive) Lua move callback — e.g. Geyser
    // pane-drag repositions a whole widget subtree. Running that per event makes
    // dragging stutter; running it once per frame is visually identical and is
    // what Qt does (it compresses pending mouse-move events). `pending` holds the
    // latest already-built event so the frame uses the freshest position.
    const moveState = useRef<{ raf: number | null; pending: LabelMouseEvent | null }>({ raf: null, pending: null });
    useEffect(() => () => {
        if (moveState.current.raf !== null && typeof cancelAnimationFrame !== 'undefined') {
            cancelAnimationFrame(moveState.current.raf);
        }
    }, []);

    // Manage a single <style> element per label for Qt pseudo-state rules
    // (`QLabel:hover`, etc.). Inline styles can't express these, and `<style
    // scoped>` was deprecated — so inject into <head>, scoped via the label's
    // data-attribute selector.
    useEffect(() => {
        if (!l.styleSheet) return;
        const parts = cssTextToParts(l.styleSheet);
        if (parts.scoped.length === 0) return;
        const id = `mudix-label-stylesheet--${l.name}`;
        let el = document.getElementById(id) as HTMLStyleElement | null;
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        const sel = `[data-mudix-label="${cssEscape(l.name)}"]`;
        // !important: the base block lands as INLINE style on the label div,
        // and inline always beats a <style> rule — a hover rule setting e.g.
        // background-image would silently lose to the base `background`. In Qt
        // the pseudo-state rule wins by ordinary stylesheet order.
        el.textContent = parts.scoped
            .map(r => `${sel}${r.pseudo} { ${qtDeclarationsToCss(r.declarations, true)} }`)
            .join('\n');
        return () => { document.getElementById(id)?.remove(); };
    }, [l.styleSheet, l.name]);

    // Mudlet setLinkStyle: color/underline the <a> links in the label's HTML.
    // Scoped via the same data-attribute selector as the stylesheet block.
    const linkStyle = l.linkStyle;
    // Visited links are tracked by us (LabelManager.activateLink), not the
    // browser: `:visited` only matches real navigation history, so it never
    // fires for the send:/prompt: pseudo-schemes label links use. Emit an
    // explicit `a[href="…"]` rule per visited link alongside it. Flattened to a
    // string so the effect has a stable dependency — the Set is mutated in
    // place, so its identity wouldn't change when a link is visited.
    const visitedKey = l.visitedLinks ? [...l.visitedLinks].join('\n') : '';
    useEffect(() => {
        if (!linkStyle) return;
        const id = `mudix-label-linkstyle--${l.name}`;
        let el = document.getElementById(id) as HTMLStyleElement | null;
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        const sel = `[data-mudix-label="${cssEscape(l.name)}"] a`;
        const decl: string[] = [`text-decoration: ${linkStyle.underline ? 'underline' : 'none'}`];
        if (linkStyle.color) decl.push(`color: ${linkStyle.color}`);
        const rules = [`${sel} { ${decl.join('; ')} }`];
        if (linkStyle.visitedColor) {
            rules.push(`${sel}:visited { color: ${linkStyle.visitedColor} }`);
            // An attribute selector outranks the bare `sel` rule above, so the
            // visited color wins without !important.
            for (const href of visitedKey ? visitedKey.split('\n') : []) {
                rules.push(`${sel}[href="${cssStringLiteral(href)}"] { color: ${linkStyle.visitedColor} }`);
            }
        }
        el.textContent = rules.join('\n');
        return () => { document.getElementById(id)?.remove(); };
    }, [linkStyle, l.name, visitedKey]);

    if (!l.visible) return null;

    let left = l.x, top = l.y, width = l.width, height = l.height;
    // Qt: once a stylesheet is set, the widget's palette/autoFillBackground are
    // ignored — the QSS governs background entirely, defaulting to transparent
    // when no `background-*` is declared. So skip the fillBackground/setColor
    // fallback whenever a stylesheet is present, otherwise an unrelated CSS
    // (e.g. `border: 0`) would leave a stale white fill hiding the parent
    // label's texture (matches Mudlet's QLabel + QSS behaviour).
    let inlineFromStylesheet: React.CSSProperties | undefined;
    if (l.styleSheet) {
        const parts = cssTextToParts(l.styleSheet);
        inlineFromStylesheet = parts.inline;
        // Qt's margin insets the visible widget area within its geometry; on
        // absolutely-positioned DOM elements, CSS margin instead offsets the
        // box, collapsing gaps between adjacent labels (e.g. gauges that share
        // an edge). Consume the margin into geometry so the visible rect
        // shrinks the way Mudlet renders it.
        if (parts.margin) {
            const m = parts.margin;
            left += m.left;
            top += m.top;
            width = Math.max(0, width - m.left - m.right);
            height = Math.max(0, height - m.top - m.bottom);
        }
    }

    const style: React.CSSProperties = {
        left, top, width, height,
        pointerEvents: l.clickThrough ? 'none' : 'auto',
        cursor: l.cursor ?? (l.onClick ? 'pointer' : undefined),
        zIndex,
    };
    // The widget font (setFont on the label), applied before the stylesheet so
    // a QSS `font-family` still overrides it — that is the Qt precedence, where
    // a stylesheet beats a widget's own QFont.
    if (l.fontFamily) {
        style.fontFamily = l.fontFamily;
    }
    if (inlineFromStylesheet) {
        Object.assign(style, inlineFromStylesheet);
    } else if (l.fillBackground) {
        const bg = l.backgroundColor;
        style.background = bg
            ? `rgba(${bg.r},${bg.g},${bg.b},${bg.a / 255})`
            : '#fff';
    }
    // Sticky Qt alignment (qproperty-alignment) overrides the `.label` default
    // (Qt::AlignLeft | Qt::AlignVCenter, encoded in LabelOverlay.css). Applied
    // after the stylesheet inline so it wins over the base rule; when the live
    // stylesheet still carries the qproperty-alignment this is the same value
    // it already produced, so re-applying is idempotent. Kept as a widget
    // property (LabelManager) rather than parsed from styleSheet so it survives
    // a restyle that drops it — see setStyleSheet.
    if (l.alignment) {
        Object.assign(style, qtAlignmentToFlex(l.alignment));
    }
    // Sticky Qt wordWrap (qproperty-wordWrap): the opt-in to wrapping. The
    // `.label` rule is nowrap, matching QLabel's default (see LabelOverlay.css),
    // so only the `true` case needs a declaration.
    if (l.wordWrap) {
        style.whiteSpace = 'normal';
    }
    // Layer setBackgroundImage on top so it shows over the fillBackground color
    // (and ignores it when a stylesheet already painted the background).
    if (l.backgroundImage) {
        const url = l.backgroundImage.url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        style.backgroundImage = `url("${url}")`;
        style.backgroundRepeat = 'no-repeat';
        if (l.scaledContents) {
            // Qt's setScaledContents(true) (via `qproperty-scaledContents`)
            // stretches the pixmap to fill the whole label, ignoring its native
            // size and aspect ratio — `background-size: 100% 100%` matches that.
            style.backgroundSize = '100% 100%';
        } else {
            // Mudlet's setBackgroundImage is QLabel::setPixmap() under the hood:
            // the image paints at its native size, left-aligned and vertically
            // centered (QLabel's default alignment), clipped by the label rather
            // than scaled to fit it. CSS defaults to top-left, so pin vcenter
            // explicitly. Raster images already have a CSS intrinsic size and
            // render native-size automatically; `width`/`height` (SVGs resolved
            // async — see backgroundImageSize.ts) forces the same for formats
            // that would otherwise stretch to fill the label.
            style.backgroundPosition = 'left center';
            if (l.backgroundImage.width != null && l.backgroundImage.height != null) {
                style.backgroundSize = `${l.backgroundImage.width}px ${l.backgroundImage.height}px`;
            }
        }
    }

    // Mudlet semantics (TLabel): the click callback fires on mouse PRESS
    // (mousePressEvent), and Qt grabs the mouse from press until release so the
    // move/release callbacks keep firing even when the cursor leaves the widget.
    // We mirror both with pointer events: fire onClick on pointerdown, and when
    // the label is drag-capable (has a move or release callback) capture the
    // pointer so onPointerMove/onPointerUp track outside the label's bounds.
    // Without this, dragging a Geyser pane titlebar stutters and stops the
    // instant the cursor leaves the titlebar.
    const dragCapable = !!(l.onMouseMove || l.onMouseUp);
    const hasPress = !!(l.onClick || l.onMouseDown) || dragCapable;
    const onPointerDown = hasPress
        ? (e: React.PointerEvent<HTMLDivElement>) => {
            // A press on an <a href> belongs to the link, not the label: Qt's
            // QLabel consumes it and TLabel returns before running the click
            // callback (TLabel::mousePressEvent). Skipping capture too, so a
            // drag-capable label doesn't swallow the click that follows.
            if (labelLinkHref(e.target) !== null) return;
            if (dragCapable) {
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
            }
            ref.current.onMouseDown?.(buildMouseEvent(e));
            ref.current.onClick?.(buildMouseEvent(e));
        }
        : undefined;

    const flushMove = () => {
        const st = moveState.current;
        st.raf = null;
        const ev = st.pending;
        st.pending = null;
        if (ev) ref.current.onMouseMove?.(ev);
    };
    const onPointerMove = l.onMouseMove
        ? (e: React.PointerEvent<HTMLDivElement>) => {
            // rAF unavailable (SSR/tests) → dispatch synchronously.
            if (typeof requestAnimationFrame === 'undefined') {
                ref.current.onMouseMove?.(buildMouseEvent(e));
                return;
            }
            moveState.current.pending = buildMouseEvent(e);
            if (moveState.current.raf === null) {
                moveState.current.raf = requestAnimationFrame(flushMove);
            }
        }
        : undefined;
    const onPointerUp = l.onMouseUp
        ? (e: React.PointerEvent<HTMLDivElement>) => {
            // Release over a link is the link's, matching the same guard in
            // TLabel::mouseReleaseEvent.
            if (labelLinkHref(e.target) !== null) return;
            // Flush any frame-pending move first so the release sees the final
            // drag position (e.g. the insertion target picked on the last move),
            // then drop the scheduled frame.
            const st = moveState.current;
            if (st.raf !== null && typeof cancelAnimationFrame !== 'undefined') {
                cancelAnimationFrame(st.raf);
                st.raf = null;
            }
            if (st.pending) { const ev = st.pending; st.pending = null; ref.current.onMouseMove?.(ev); }
            ref.current.onMouseUp?.(buildMouseEvent(e));
        }
        : undefined;

    // Mudlet's TLabel connects QLabel::linkActivated, so an <a href> echoed
    // into a label drives the game: `send:` fires a command, `prompt:` stages
    // one, http(s) opens a tab, and a scheme-less href runs as Lua (see
    // labelLinks.ts). The default must always be prevented — the pseudo-schemes
    // aren't navigable, and a real http link would replace the whole app.
    const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const href = labelLinkHref(e.target);
        if (href === null) return;
        e.preventDefault();
        manager.activateLink(ref.current.name, href);
    };

    // Mudlet labels are Qt widgets — a right-click is delivered to the label's
    // own callback (see the RightButton branch in Adjustable.Container:onClick),
    // never to a native context menu. In the browser the default contextmenu
    // would pop up on top of, and obscure, the widget's own right-click menu
    // (issue #7). Suppress it on interactive labels so only the Geyser menu shows.
    // Skipped for non-interactive labels so plain text/link labels keep the
    // native menu (copy / open-link).
    const onContextMenu = hasPress
        ? (e: React.MouseEvent<HTMLDivElement>) => e.preventDefault()
        : undefined;

    // A movie (setMovie) replaces the html content, like QLabel. The canvas
    // sits left-aligned / vertically centered (QLabel's default pixmap
    // alignment) and is clipped to the label's geometry.
    const movie = l.movie;
    if (movie) {
        style.display = 'flex';
        style.alignItems = 'center';
        style.justifyContent = 'flex-start';
        style.overflow = 'hidden';
    }

    return (
        <div
            className="label"
            style={style}
            data-mudix-label={l.name}
            title={l.tooltip}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onDoubleClick={l.onDoubleClick && (e => ref.current.onDoubleClick?.(buildMouseEvent(e)))}
            onMouseEnter={l.onMouseEnter && (e => ref.current.onMouseEnter?.(buildMouseEvent(e)))}
            onMouseLeave={l.onMouseLeave && (e => ref.current.onMouseLeave?.(buildMouseEvent(e)))}
            onWheel={l.onWheel && (e => ref.current.onWheel?.(buildWheelEvent(e)))}
        >
            {movie
                ? <MovieCanvas player={movie} />
                // Qt lays label rich text out in a QTextDocument whose default
                // documentMargin is 4px, *inside* the QSS padding — every
                // Mudlet label:echo() renders with that inset. The wrapper
                // carries it so a stylesheet padding (applied inline on the
                // outer div) adds to it instead of replacing it.
                : <div className="label-doc" dangerouslySetInnerHTML={{ __html: l.html }} />}
        </div>
    );
}

/** The <canvas> a MoviePlayer paints GIF frames onto. The drawing buffer is
 *  always the GIF's native size (putImageData ignores CSS scaling); the
 *  player's scale mode only changes the CSS box. */
function MovieCanvas({ player }: { player: MoviePlayer }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        player.attach(ref.current);
        return () => player.attach(null);
    }, [player]);
    const scale = player.scale;
    const style: React.CSSProperties = scale.mode === 'auto'
        ? { width: '100%', height: '100%' }
        : scale.mode === 'fixed'
            ? { width: scale.width, height: scale.height }
            : {};
    return <canvas ref={ref} width={player.gif.width} height={player.gif.height} style={style} />;
}

