import {
    cssEscape, extractQtAlignment, extractQtScaledContents, extractQtWordWrap,
    patchStyleSheetBackgroundColor,
} from './qtCss';
import type { MoviePlayer } from './gifMovie';
import { OverlayLayerOrder } from '../layout/overlayLayerOrder';

export interface LabelCreateOptions {
    /** Parent window id ('main' for main viewport). Defaults to 'main'. */
    parent?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Whether to draw the label's background fill. */
    fillBackground: boolean;
    /** Whether clicks pass through to whatever is underneath. */
    clickThrough?: boolean;
}

export interface LabelState {
    name: string;
    parent: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fillBackground: boolean;
    clickThrough: boolean;
    visible: boolean;
    /** Inner HTML content set via echo()/setLabelText. */
    html: string;
    /** rgba 0..255 channels; alpha defaults to 255 when set via setBackgroundColor. */
    backgroundColor?: { r: number; g: number; b: number; a: number };
    /** Mudlet setBackgroundImage(labelName, imageLocation) — resolved CSS URL.
     *  Labels have no `mode` (unlike consoles): Mudlet just calls
     *  `QLabel::setPixmap()`, which paints the image at its native pixel size
     *  (no scaling), left-aligned and vertically centered, clipped to the
     *  label's geometry. `width`/`height` are the image's resolved intrinsic
     *  size (filled in asynchronously for SVGs, which otherwise have no CSS
     *  intrinsic size — see backgroundImageSize.ts); until resolved, or for
     *  formats CSS already sizes natively, they're left unset. */
    backgroundImage?: { url: string; width?: number; height?: number };
    /** Qt-style CSS string set via setLabelStyleSheet; parsed at render time. */
    styleSheet?: string;
    /** Family set via `setFont(labelName, family)` — the widget font, which in
     *  Qt is a property of the QLabel itself and so is kept here rather than
     *  folded into `styleSheet`. A stylesheet `font-family` still wins over it
     *  at render, as QSS wins over a widget font in Qt. Always stored as the
     *  font database spells it (ScriptingAPI.resolveFontFamily), because
     *  Geyser.Label:setFont reads it straight back through getFont(). */
    fontFamily?: string;
    /** Sticky Qt `alignment` widget property, captured from a
     *  `qproperty-alignment` declaration in any setStyleSheet call. In Qt,
     *  qproperty-* declarations set the widget property permanently — a later
     *  setStyleSheet that omits it does NOT revert it (ordinary style is
     *  replaced wholesale, but the property sticks). So we track it separately
     *  from `styleSheet` and re-apply it at render. Raw Qt value, e.g.
     *  "AlignLeft | AlignTop"; translated by qtAlignmentToFlex at render. */
    alignment?: string;
    /** Sticky Qt `scaledContents` widget property, captured from a
     *  `qproperty-scaledContents` declaration in any setStyleSheet call. When
     *  true, Qt's QLabel::setScaledContents scales the pixmap
     *  (setBackgroundImage) to fill the entire label instead of painting it at
     *  native size; LabelOverlay maps that to `background-size: 100% 100%`. Like
     *  `alignment`, it's a widget property that persists across a later
     *  stylesheet that omits it. */
    scaledContents?: boolean;
    /** Sticky Qt `wordWrap` widget property, captured from a
     *  `qproperty-wordWrap` declaration in any setStyleSheet call. QLabel
     *  defaults it to false (and TLabel never sets it), which is why label text
     *  in Mudlet runs past the widget edge and gets clipped instead of wrapping
     *  — LabelOverlay renders that as `white-space: nowrap`, and this property
     *  as `normal`. Sticky across a later stylesheet that omits it, like
     *  `alignment` and `scaledContents`. */
    wordWrap?: boolean;
    /** Mudlet setLinkStyle(labelName, linkColor, linkVisitedColor, underline) —
     *  styling for `<a>` links inside the label's HTML. Cleared by
     *  resetLinkStyle. Colors are any CSS color string (empty = leave default). */
    linkStyle?: { color?: string; visitedColor?: string; underline: boolean };
    /** Hrefs clicked in this label, tracked so `linkStyle.visitedColor` can be
     *  applied explicitly — CSS `:visited` only ever matches real browser
     *  history, so it never fires for the `send:`/`prompt:` pseudo-schemes label
     *  links use. Mirrors Mudlet's `TLabel::mVisitedLinks`, which exists for the
     *  same reason (Qt won't style them either). Only populated while a visited
     *  color is set, as Mudlet does. */
    visitedLinks?: Set<string>;
    /** Click handler installed by setLabelClickCallback. The event table mirrors
     *  Mudlet's `mudlet.mouse_button` shape: `{button, x, y, alt, ctrl, shift, meta}`. */
    onClick?: (event: LabelMouseEvent) => void;
    /** Pointer down (Mudlet release callback fires on mouseup; press is implicit). */
    onMouseDown?: (event: LabelMouseEvent) => void;
    /** Pointer up — Mudlet setLabelReleaseCallback. */
    onMouseUp?: (event: LabelMouseEvent) => void;
    /** Double-click — Mudlet setLabelDoubleClickCallback. */
    onDoubleClick?: (event: LabelMouseEvent) => void;
    /** Pointer move — Mudlet setLabelMoveCallback. */
    onMouseMove?: (event: LabelMouseEvent) => void;
    /** Wheel — Mudlet setLabelWheelCallback. event.angleDelta carries the scroll. */
    onWheel?: (event: LabelWheelEvent) => void;
    /** Pointer enter — Mudlet setLabelOnEnter. */
    onMouseEnter?: (event: LabelMouseEvent) => void;
    /** Pointer leave — Mudlet setLabelOnLeave. */
    onMouseLeave?: (event: LabelMouseEvent) => void;
    /** Tooltip text rendered via the title attribute. */
    tooltip?: string;
    /** CSS cursor value (e.g. 'pointer', 'crosshair', 'none'). */
    cursor?: string;
    /** Animated GIF player installed by Mudlet's setMovie. Rendered as a
     *  <canvas> instead of the html content (QLabel shows one or the other). */
    movie?: MoviePlayer;
}

/** Event payload for label mouse callbacks. `button` is the Qt button *name*
 *  Mudlet reports ("LeftButton" / "RightButton" / "MidButton" / "NoButton" / …),
 *  so ported Geyser scripts that branch on `event.button == "LeftButton"` work. */
export interface LabelMouseEvent {
    button: string;
    x: number;
    y: number;
    globalX: number;
    globalY: number;
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
}

export interface LabelWheelEvent extends LabelMouseEvent {
    /** Mudlet exposes wheel deltas via `angleDelta.x` / `angleDelta.y` (Qt naming). */
    angleDelta: { x: number; y: number };
}

type Listener = (labels: LabelState[]) => void;

/** Runs the action behind an `<a href>` clicked inside a label — installed by
 *  ScriptingAPI, which owns the send/prompt/openUrl/Lua machinery the schemes
 *  map onto (see {@link LabelManager.setLinkActivator}). */
type LinkActivator = (href: string) => void;

// Lua callers can pass nil or percentage strings ("12.5%") through createLabel /
// moveWindow / resizeWindow — `Number(...)` then yields NaN, which React would
// emit as `left: NaN` and warn about. Coerce non-finite inputs to 0 so the
// label still renders (matches Mudlet's int-cast behaviour) instead of
// poisoning the inline style.
/**
 * Mudlet's `TLabel::setText` link-styling pass: every `<a href=…>` in the text a
 * label is given gets an inline `style` carrying the colours `setLinkStyle`
 * asked for, because QTextDocument reads neither the widget stylesheet nor the
 * palette for link colours. The DOM does honour a stylesheet — LabelOverlay
 * injects one — but `getLabelText` answers with the styled text, so the pass has
 * to happen here as well as there.
 *
 * The pattern is Mudlet's, deliberately strict (lowercase tag, href first, no
 * spacing around `=`): that is the shape Mudlet's own HTML generation produces.
 * The separator is `\s+`, so an anchor whose attributes start on the next line
 * is styled like any other.
 */
const ANCHOR_RE = /<a\s+href=(["'][^"']*["'])([^>]*)>/g;

function styleAnchors(
    html: string,
    style: { color?: string; visitedColor?: string; underline: boolean } | undefined,
    visited: Set<string> | undefined,
): string {
    if (!style || (!style.color && !style.visitedColor)) return html;
    return html.replace(ANCHOR_RE, (whole, hrefPart: string, otherAttrs: string) => {
        const url = hrefPart.slice(1, -1);
        const decls: string[] = [];
        if (visited?.has(url) && style.visitedColor) decls.push(`color: ${style.visitedColor};`);
        else if (style.color) decls.push(`color: ${style.color};`);
        if (!style.underline) decls.push('text-decoration: none;');
        if (decls.length === 0) return whole;
        // An anchor that already carries a style attribute has it REPLACED, not
        // merged — Mudlet keeps the simple case simple and says so.
        const rest = otherAttrs.replace(/style=(["'][^"']*["'])/g, '');
        return `<a href=${hrefPart} style="${decls.join(' ')}"${rest}>`;
    });
}

function safeCoord(n: number): number {
    return Number.isFinite(n) ? n : 0;
}

/**
 * Natural size of a label's HTML, measured off-screen.
 *
 * Backs getSizeHint when the label has no element in the document — a script
 * that creates a label and asks for its hint in one chunk runs entirely before
 * React paints. The probe is absolutely positioned with no width, so it
 * shrink-to-fits its content, which is exactly what a size hint is. Any font
 * declarations from the label's own stylesheet are applied so the metrics match
 * what will actually be drawn.
 *
 * Null when there is nothing to measure or no DOM at all.
 */
function measureHtmlContent(html: string, styleSheet?: string): { width: number; height: number } | null {
    if (typeof document === 'undefined' || !document.body || !html) return null;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;'
        // nowrap for the same reason the rendered label carries it: QLabel's
        // wordWrap is off, so the size a label "wants" is its text on one line
        // (broken only where the HTML breaks it), not the text folded to fit.
        + 'visibility:hidden;width:auto;height:auto;white-space:nowrap;';
    for (const prop of ['font-family', 'font-size', 'font-weight', 'font-style'] as const) {
        const found = styleSheet?.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'i'));
        if (found) probe.style.setProperty(prop, found[1].trim());
    }
    // The 4px QTextDocument margin every label:echo() renders with (see the
    // .label-doc wrapper in LabelOverlay) belongs in the hint too.
    probe.innerHTML = `<div style="margin:4px">${html}</div>`;
    document.body.appendChild(probe);
    try {
        const rect = probe.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    } finally {
        probe.remove();
    }
}

/**
 * Run `fn` on the next animation frame, falling back to a macrotask where
 * rAF doesn't exist (tests, SSR). Deliberately not a microtask: notifications
 * can cascade — a listener may resize a label and notify again — and the
 * browser drains the whole microtask queue before yielding, so a
 * self-retriggering flush would freeze the tab outright. Both of these yield.
 */
const scheduleFlush: (fn: () => void) => void =
    typeof requestAnimationFrame === 'function'
        ? (fn) => { requestAnimationFrame(() => fn()); }
        : (fn) => { setTimeout(fn, 0); };

export class LabelManager {
    private readonly labels = new Map<string, LabelState>();
    // Labels bucketed by parent, insertion-ordered within each bucket (which is
    // the render/z order list() has always produced). Kept in sync at the four
    // mutation points — create, destroy, setParent, clearAll — so list() costs
    // O(labels in that parent) instead of O(all labels). A Geyser reflow calls
    // list() once per moved widget, so the old full scan made one layout pass
    // quadratic in the total label count.
    private readonly byParent = new Map<string, Map<string, LabelState>>();
    private readonly listeners = new Map<string, Set<Listener>>();
    private linkActivator: LinkActivator | null = null;

    private indexAdd(lbl: LabelState): void {
        let bucket = this.byParent.get(lbl.parent);
        if (!bucket) { bucket = new Map(); this.byParent.set(lbl.parent, bucket); }
        bucket.set(lbl.name, lbl);
    }

    private indexRemove(parent: string, name: string): void {
        const bucket = this.byParent.get(parent);
        if (!bucket) return;
        bucket.delete(name);
        if (bucket.size === 0) this.byParent.delete(parent);
    }

    // Public so LabelOverlay (and other overlay components sharing this
    // registry via the other managers) can read/subscribe to the wrapper
    // layer's z-index — see overlayLayerOrder.ts.
    constructor(readonly overlayZ: OverlayLayerOrder = new OverlayLayerOrder()) {}

    /** Returns true if a new label was created. Mudlet's createLabel returns
     *  false when a label with the same name already exists. */
    create(name: string, opts: LabelCreateOptions): boolean {
        if (this.labels.has(name)) return false;
        const parent = opts.parent ?? 'main';
        const state: LabelState = {
            name, parent,
            x: safeCoord(opts.x), y: safeCoord(opts.y),
            width: safeCoord(opts.width), height: safeCoord(opts.height),
            fillBackground: opts.fillBackground,
            clickThrough: opts.clickThrough ?? false,
            visible: true,
            html: '',
            // Mudlet's TLabel starts on rgb(32, 32, 32) whatever fillBackground
            // says — the flag decides whether the fill is painted, not what
            // colour it is, and getBackgroundColor reports the colour either way.
            backgroundColor: { r: 32, g: 32, b: 32, a: 255 },
        };
        this.labels.set(name, state);
        this.indexAdd(state);
        this.overlayZ.touch(parent, 'labels', name);
        this.notify(parent);
        return true;
    }

    has(name: string): boolean {
        return this.labels.has(name);
    }

    /** Read-only handle on a label's stored state, for the geometry/visibility/
     *  text getters (getWindowGeometry, windowVisible, getLabelText). */
    get(name: string): Readonly<LabelState> | undefined {
        return this.labels.get(name);
    }

    destroy(name: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.movie?.stop();
        this.labels.delete(name);
        this.indexRemove(lbl.parent, name);
        this.overlayZ.forget(lbl.parent, 'labels', name);
        this.notify(lbl.parent);
        return true;
    }

    move(name: string, x: number, y: number): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        const nx = safeCoord(x), ny = safeCoord(y);
        // Skip the notify (and its overlay re-render) when nothing moved. Geyser
        // reflows re-issue moveWindow for every widget in a subtree, so closing a
        // pane — which repositions multiple sibling panes via _notifyAllReposition
        // — moves many widgets to the coordinates they already hold. Each of those
        // no-ops would otherwise rebuild the label list and re-render the overlay.
        if (lbl.x === nx && lbl.y === ny) return true;
        lbl.x = nx; lbl.y = ny;
        this.notify(lbl.parent);
        return true;
    }

    resize(name: string, width: number, height: number): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        const nw = safeCoord(width), nh = safeCoord(height);
        if (lbl.width === nw && lbl.height === nh) return true;
        lbl.width = nw; lbl.height = nh;
        this.notify(lbl.parent);
        return true;
    }

    /** Mudlet setWindow — reparent a label into another window's overlay
     *  ('main', a userwindow / miniconsole id, or a scroll box name). Both
     *  the old and the new parent's overlays re-render. */
    setParent(name: string, parent: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        if (lbl.parent !== parent) {
            const old = lbl.parent;
            this.indexRemove(old, name);
            lbl.parent = parent;
            this.indexAdd(lbl);
            this.overlayZ.forget(old, 'labels', name);
            this.overlayZ.touch(parent, 'labels', name);
            this.notify(old);
            this.notify(parent);
        }
        return true;
    }

    /** Mudlet `getLabelSizeHint(name)` → the label's preferred `{width,height}`.
     *  Mudlet returns the QLabel sizeHint (the size its content wants); the
     *  browser analogue is the rendered node's content extent
     *  (`scrollWidth`/`scrollHeight`), read off the `data-mudix-label` element.
     *  Falls back to the configured geometry when the label isn't in the DOM
     *  yet (hidden, or rendered before mount). null when no such label. */
    getSizeHint(name: string): { width: number; height: number } | null {
        const lbl = this.labels.get(name);
        if (!lbl) return null;
        if (typeof document !== 'undefined') {
            const el = document.querySelector(
                `[data-mudix-label="${cssEscape(name)}"]`,
            ) as HTMLElement | null;
            if (el) {
                // Qt's sizeHint is what the widget *wants*, so it has to be able
                // to come out smaller than the widget currently is. scrollWidth
                // can't: it is the box width whenever the content is narrower,
                // which made every hint exactly the label's own size. A Range
                // over the contents measures the laid-out text itself.
                // Range over the *inline* content: `.label-doc` is a block, so
                // ranging over the outer element just re-measures the box. Its
                // children are the text and spans echo() produced, whose client
                // rects are the actual laid-out extent.
                const doc = el.querySelector('.label-doc');
                const range = document.createRange();
                range.selectNodeContents(doc ?? el);
                const rect = range.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    // Padding and border belong to the hint — Qt includes the
                    // widget's own chrome around the content it sizes for.
                    const style = getComputedStyle(el);
                    const pad = (...vals: string[]): number =>
                        vals.reduce((n, v) => n + (parseFloat(v) || 0), 0);
                    return {
                        width: Math.ceil(rect.width + pad(
                            style.paddingLeft, style.paddingRight,
                            style.borderLeftWidth, style.borderRightWidth)),
                        height: Math.ceil(rect.height + pad(
                            style.paddingTop, style.paddingBottom,
                            style.borderTopWidth, style.borderBottomWidth)),
                    };
                }
                return { width: el.scrollWidth, height: el.scrollHeight };
            }
            // No mounted element: a label created and measured inside one
            // synchronous script chunk hasn't been through React yet. Falling
            // back to the label's own size would make the hint meaningless — it
            // would always report exactly the box we were asked to size — so
            // measure the same HTML in a detached, unconstrained probe instead.
            const measured = measureHtmlContent(lbl.html, lbl.styleSheet);
            if (measured) return measured;
        }
        return { width: lbl.width, height: lbl.height };
    }

    show(name: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        if (!lbl.visible) { lbl.visible = true; this.notify(lbl.parent); }
        return true;
    }

    hide(name: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        if (lbl.visible) { lbl.visible = false; this.notify(lbl.parent); }
        return true;
    }

    setHtml(name: string, html: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        // QLabel shows one content at a time — setText replaces a running
        // movie, so echo()/setLabelText after setMovie drops the animation.
        if (lbl.movie) { lbl.movie.stop(); lbl.movie = undefined; }
        lbl.html = styleAnchors(html, lbl.linkStyle, lbl.visitedLinks);
        this.notify(lbl.parent);
        return true;
    }

    /** Mudlet setMovie — install (or replace) the label's GIF player. */
    setMovie(name: string, player: MoviePlayer): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.movie?.stop();
        lbl.movie = player;
        this.notify(lbl.parent);
        return true;
    }

    getMovie(name: string): MoviePlayer | null {
        return this.labels.get(name)?.movie ?? null;
    }

    /** Mudlet's `getProfileStats().gifs`: how many labels carry a movie, and
     *  how many of those are actually running. Deleting a label takes its movie
     *  out of both counts, since the label is where a movie lives. */
    movieStats(): { total: number; active: number } {
        let total = 0, active = 0;
        for (const lbl of this.labels.values()) {
            if (!lbl.movie) continue;
            total++;
            if (lbl.movie.isPlaying) active++;
        }
        return { total, active };
    }

    /** Mudlet scaleMovie — autoscale tracks the label size (CSS 100%);
     *  autoscale=false freezes the scale at the label's current geometry.
     *  False when the label has no movie (matches Mudlet's warning case). */
    setMovieScale(name: string, autoscale: boolean): boolean {
        const lbl = this.labels.get(name);
        if (!lbl?.movie) return false;
        lbl.movie.scale = autoscale
            ? { mode: 'auto' }
            : { mode: 'fixed', width: lbl.width, height: lbl.height };
        this.notify(lbl.parent);
        return true;
    }

    setBackgroundColor(name: string, r: number, g: number, b: number, a = 255): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        // Matches Mudlet: a stylesheet already on the label isn't replaced or
        // ignored — the background-color declaration inside it is patched in
        // place (see patchStyleSheetBackgroundColor). Only fall back to the
        // plain fill color when there's no stylesheet to patch.
        if (lbl.styleSheet) {
            lbl.styleSheet = patchStyleSheetBackgroundColor(lbl.styleSheet, r, g, b, a);
        }
        // Recorded either way, not just on the no-stylesheet branch: this field
        // is what getBackgroundColor answers with, and a label that happened to
        // carry a stylesheet used to report the colour it had *before* the call.
        lbl.backgroundColor = { r, g, b, a };
        // Mudlet implicitly enables fill when the user sets a bg color.
        lbl.fillBackground = true;
        this.notify(lbl.parent);
        return true;
    }

    getBackgroundColor(name: string): { r: number; g: number; b: number; a: number } | null {
        return this.labels.get(name)?.backgroundColor ?? null;
    }

    setBackgroundImage(name: string, url: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.backgroundImage = { url };
        this.notify(lbl.parent);
        return true;
    }

    /** Fills in the intrinsic pixel size resolved asynchronously for `url`
     *  (see backgroundImageSize.ts). No-ops if the label's image has since
     *  changed away from `url` (stale resolution racing a newer call). */
    setBackgroundImageSize(name: string, url: string, width: number, height: number): boolean {
        const lbl = this.labels.get(name);
        if (!lbl?.backgroundImage || lbl.backgroundImage.url !== url) return false;
        lbl.backgroundImage = { url, width, height };
        this.notify(lbl.parent);
        return true;
    }

    resetBackgroundImage(name: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.backgroundImage = undefined;
        this.notify(lbl.parent);
        return true;
    }

    /** Mudlet `setFont(labelName, family)` on a label. An empty family clears
     *  the override, leaving the label on whatever it inherits. */
    setFont(name: string, family: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.fontFamily = family && family.trim() ? family : undefined;
        this.notify(lbl.parent);
        return true;
    }

    /** The label's own font family, or null when there is no such label.
     *  An existing label with no override reads as "" — the same "nothing set"
     *  answer a window with no override gives. */
    getFont(name: string): string | null {
        const lbl = this.labels.get(name);
        if (!lbl) return null;
        return lbl.fontFamily ?? '';
    }

    setStyleSheet(name: string, css: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.styleSheet = css;
        // qproperty-alignment is a Qt widget property, not transient style: once
        // set it sticks even when a later stylesheet omits it. Capture it here so
        // a restyle that drops the alignment keeps the previous one (an absent
        // declaration leaves lbl.alignment untouched).
        const align = extractQtAlignment(css);
        if (align !== undefined) lbl.alignment = align;
        // qproperty-scaledContents is likewise a sticky widget property.
        const scaled = extractQtScaledContents(css);
        if (scaled !== undefined) lbl.scaledContents = scaled;
        // ...as is qproperty-wordWrap, the opt-in to wrapping label text.
        const wrap = extractQtWordWrap(css);
        if (wrap !== undefined) lbl.wordWrap = wrap;
        this.notify(lbl.parent);
        return true;
    }

    /** Mudlet `setLinkStyle(labelName, linkColor, linkVisitedColor, underline)`. */
    setLinkStyle(name: string, color: string, visitedColor: string, underline: boolean): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.linkStyle = {
            color: color || undefined,
            visitedColor: visitedColor || undefined,
            underline,
        };
        this.notify(lbl.parent);
        return true;
    }

    /**
     * Install the handler that runs a clicked label link (`<a href="send:…">`).
     * The manager itself has no scripting access, so LabelOverlay routes clicks
     * here and ScriptingAPI supplies the behaviour.
     */
    setLinkActivator(fn: LinkActivator | null): void {
        this.linkActivator = fn;
    }

    /**
     * A link inside `name`'s rich text was clicked. Records it as visited (when
     * a visited color is configured) and runs the activator — Mudlet's
     * `TLabel::slot_linkActivated`, which does the same two things in the same
     * order.
     */
    activateLink(name: string, href: string): void {
        const lbl = this.labels.get(name);
        if (lbl?.linkStyle?.visitedColor && !lbl.visitedLinks?.has(href)) {
            (lbl.visitedLinks ??= new Set()).add(href);
            this.notify(lbl.parent);
        }
        this.linkActivator?.(href);
    }

    /** Mudlet `resetLinkStyle(labelName)` — drop any setLinkStyle override. */
    resetLinkStyle(name: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.linkStyle = undefined;
        this.notify(lbl.parent);
        return true;
    }

    /** Mudlet `getLabelStyleSheet(name)` — the Qt-style CSS last set via
     *  {@link setStyleSheet}, or `""` when none is set. Returns `undefined`
     *  when the label doesn't exist so the caller can distinguish that case. */
    getStyleSheet(name: string): string | undefined {
        const lbl = this.labels.get(name);
        if (!lbl) return undefined;
        return lbl.styleSheet ?? '';
    }

    setClickCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.onClick = fn;
        this.notify(lbl.parent);
        return true;
    }

    setMouseUpCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.onMouseUp = fn;
        this.notify(lbl.parent);
        return true;
    }

    setDoubleClickCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.onDoubleClick = fn;
        this.notify(lbl.parent);
        return true;
    }

    setMouseMoveCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.onMouseMove = fn;
        this.notify(lbl.parent);
        return true;
    }

    setWheelCallback(name: string, fn: ((e: LabelWheelEvent) => void) | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.onWheel = fn;
        this.notify(lbl.parent);
        return true;
    }

    setMouseEnterCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.onMouseEnter = fn;
        this.notify(lbl.parent);
        return true;
    }

    setMouseLeaveCallback(name: string, fn: ((e: LabelMouseEvent) => void) | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.onMouseLeave = fn;
        this.notify(lbl.parent);
        return true;
    }

    setTooltip(name: string, text: string | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.tooltip = text && text.length > 0 ? text : undefined;
        this.notify(lbl.parent);
        return true;
    }

    setClickThrough(name: string, value: boolean): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        if (lbl.clickThrough !== value) {
            lbl.clickThrough = value;
            this.notify(lbl.parent);
        }
        return true;
    }

    setCursor(name: string, cursor: string | undefined): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        lbl.cursor = cursor;
        this.notify(lbl.parent);
        return true;
    }

    raise(name: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        this.overlayZ.touch(lbl.parent, 'labels', name);
        this.notify(lbl.parent);
        return true;
    }

    lower(name: string): boolean {
        const lbl = this.labels.get(name);
        if (!lbl) return false;
        this.overlayZ.sink(lbl.parent, 'labels', name);
        this.notify(lbl.parent);
        return true;
    }

    list(parent: string): LabelState[] {
        const bucket = this.byParent.get(parent);
        return bucket ? [...bucket.values()] : [];
    }

    subscribe(parent: string, fn: Listener): () => void {
        let set = this.listeners.get(parent);
        if (!set) { set = new Set(); this.listeners.set(parent, set); }
        set.add(fn);
        fn(this.list(parent));
        return () => {
            set!.delete(fn);
            if (set!.size === 0) this.listeners.delete(parent);
        };
    }

    clearAll(): void {
        const parents = new Set<string>();
        for (const l of this.labels.values()) {
            parents.add(l.parent);
            l.movie?.stop();
        }
        this.labels.clear();
        this.byParent.clear();
        for (const p of parents) this.notify(p);
    }

    /**
     * Mark a parent's overlay dirty, flushed once on the next frame.
     *
     * A Geyser reflow re-issues moveWindow/resizeWindow for every widget in a
     * subtree (Geyser.Container:reposition recurses into every child), and
     * f2ce-tools' table resize walks every row and cell the same way. Notifying
     * synchronously per call meant one overlay re-render per widget — hundreds
     * of renders for a single layout pass. Qt has no equivalent cost, which is
     * why the same package stays smooth in desktop Mudlet.
     *
     * The whole cascade is synchronous, so it collapses into one flush per
     * parent afterwards. Listeners only ever saw the final state anyway — the
     * intermediate values were never painted, being on the same blocked task.
     * subscribe() keeps its synchronous first call so mounts stay immediate.
     */
    private dirty: Set<string> | null = null;
    private flushScheduled = false;

    private notify(parent: string): void {
        if (!this.listeners.has(parent)) return;
        (this.dirty ??= new Set()).add(parent);
        if (this.flushScheduled) return;
        this.flushScheduled = true;
        scheduleFlush(() => {
            this.flushScheduled = false;
            const parents = this.dirty;
            this.dirty = null;
            if (!parents) return;
            for (const p of parents) this.flushParent(p);
        });
    }

    /** Immediate, uncoalesced notification for one parent. */
    private flushParent(parent: string): void {
        const set = this.listeners.get(parent);
        if (!set) return;
        const list = this.list(parent);
        for (const fn of set) fn(list);
    }
}
