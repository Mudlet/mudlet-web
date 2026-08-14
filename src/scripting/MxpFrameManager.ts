/**
 * MXP `<FRAME>` window layout — a port of Mudlet 4.21's `TMxpFrameManager`
 * (src/TMxpFrameManager.cpp).
 *
 * MXP lets a server carve the client window into named sub-windows and then
 * redirect text into them with `<DEST>`. Mudlet lays those out itself rather
 * than handing them to the OS window manager: internal frames are tiled against
 * the edges of the main console, each one shrinking the console's usable area
 * by adding to a set of "MXP borders", and frames declared inside an open
 * `<DEST>` nest inside that destination frame instead. `TITLE` gives a frame a
 * tab header, and `DOCK`+`ALIGN=CLIENT` (a CMUD extension, not MXP 1.0) adds a
 * frame as another tab of an existing one.
 *
 * This class owns the same bookkeeping — the frame records, the accumulated
 * borders, the parent/child hierarchy and the tab groups — and drives the UI
 * through {@link MxpFrameHost} so the geometry is testable without a DOM.
 * mudix maps a frame's console onto a mini-console (an overlay panel with
 * script-controlled geometry); the tab strip is window chrome rendered by
 * ScriptWindow, and child frames nest by portalling into the parent panel's
 * viewport, so their coordinates are parent-relative.
 */

import type { MxpTabPage } from '../ui/windows/types';

/** Height in px of a frame's tab strip. Must match `.mxp-frame-tabs` in ScriptWindow.css. */
export const MXP_TAB_BAR_HEIGHT = 24;

/** Extra px given to a frame sized in character cells, covering the console's
 *  own padding and border so the requested cell count really is visible. */
const CHAR_SIZE_SLACK = 8;

/** Mudlet's `TMxpFrameManager::MAX_FRAMES` — a runaway-server backstop. */
const MAX_FRAMES = 20;

/** Mudlet's `validateFrameName` charset. A frame name doubles as a window id. */
const VALID_FRAME_NAME = /^[a-zA-Z0-9_-]+$/;

/** Pixel insets carved out of the main console by edge-aligned frames. */
export interface MxpBorders { top: number; right: number; bottom: number; left: number }

/** Rectangle, in main-viewport coordinates, that top-level frames tile inside. */
export interface MxpArea { x: number; y: number; width: number; height: number }

/** Everything the layout needs from the app. Implemented by ScriptingAPI. */
export interface MxpFrameHost {
    /** The region top-level frames may tile in: the main window minus whatever
     *  `setBorder*` has reserved. A GUI package that docks itself to an edge
     *  (Geyser's `Adjustable.Container{attached=…}`) reserves its strip that
     *  way, and a server laying out frames must not tile over it. MXP's own
     *  borders are excluded — the manager tracks those itself. */
    consoleArea(): MxpArea;
    /** Character cell `[width, height]` in px for the main output font, backing `Nc` sizes. */
    charCellSize(): [number, number];
    /** Create (or reposition) a frame's console. `parent` nests it inside that
     *  frame's viewport, making x/y parent-relative. */
    placeFrameConsole(name: string, x: number, y: number, width: number, height: number, parent?: string): void;
    /** Open an `EXTERNAL` frame as a free-floating window with its own titlebar. */
    openExternalFrame(name: string, title: string, width: number, height: number): void;
    destroyFrameConsole(name: string): void;
    showFrameConsole(name: string): void;
    raiseFrameConsole(name: string): void;
    setFrameScrolling(name: string, enabled: boolean): void;
    /** Install/replace a frame's tab strip. An empty `pages` list removes it. */
    setFrameTabs(name: string, pages: MxpTabPage[], active: string): void;
    /** Publish the accumulated borders so the main console shrinks around the frames. */
    setMxpBorders(borders: MxpBorders): void;
}

interface MxpFrame {
    name: string;
    title: string;
    /** TITLE was given explicitly — the only thing that earns a tab header. */
    hasExplicitTitle: boolean;
    isInternal: boolean;
    /** Lower-cased ALIGN: `left` | `right` | `top` | `bottom` | `client`. */
    align: string;
    /** Raw geometry specs, kept verbatim so borders can be recomputed on close. */
    width: string;
    height: string;
    left: string;
    top: string;
    scrolling: boolean;
    /** FLOATING — borderless, no tab header (still an *internal* frame). */
    floating: boolean;
    /** DOCK — name of the frame this one should become a tab of. */
    dockFrame: string;
    parent: MxpFrame | null;
    children: MxpFrame[];
    /** Laid-out rect, in the parent's viewport space (or the main window's). */
    rect: { x: number; y: number; width: number; height: number };
    /** Chrome eaten by this frame's own tab strip, 0 when headerless. */
    tabBarHeight: number;
    /** Tab strip contents, first entry being this frame's own console. Empty = no strip. */
    tabs: string[];
    /** Frame whose page the strip currently shows. */
    activeTab: string;
    /** Height already consumed by `ALIGN=TOP` children — Mudlet's VBox stacking. */
    usedHeight: number;
    /** Border this frame claimed from the main console, so closing it gives back
     *  exactly what it took. (Mudlet re-derives the size from the raw spec on
     *  close, which reads percentages against a different container than the
     *  layout did and so hands back the wrong number.) */
    claimedBorder: { side: keyof MxpBorders; px: number } | null;
}

const NO_BORDERS: MxpBorders = { top: 0, right: 0, bottom: 0, left: 0 };

export class MxpFrameManager {
    private readonly frames = new Map<string, MxpFrame>();
    private borders: MxpBorders = { ...NO_BORDERS };

    constructor(private readonly host: MxpFrameHost) {}

    /**
     * `<FRAME name …>`. `dest` is the `<DEST>` frame open at the time the tag
     * was parsed, which nests this frame inside it. Returns false when the tag
     * could not be honoured (bad name, frame budget exhausted) — Mudlet renders
     * the raw tag text in that case.
     */
    createFrame(name: string, attrs: Record<string, string>, dest?: string): boolean {
        if (!VALID_FRAME_NAME.test(name)) return false;

        // Parsed before allocating anything: close/focus never build a frame.
        const action = (attrs.ACTION ?? 'open').toLowerCase();
        if (action === 'close') return this.closeFrame(name);
        if (action === 'focus') return this.focusFrame(name);

        // action=open on a live frame only re-shows it. Per CMUD 2.30 it must
        // NOT re-run layout: the geometry may have been adjusted since, and
        // status frames re-announce themselves constantly.
        if (this.frames.has(name)) return this.showFrame(name);
        if (this.frames.size >= MAX_FRAMES) return false;

        const frame: MxpFrame = {
            name,
            title: attrs.TITLE ?? name,
            hasExplicitTitle: attrs.TITLE !== undefined,
            // INTERNAL is the default: only an explicit EXTERNAL opts out.
            isInternal: attrs.INTERNAL !== undefined || attrs.EXTERNAL === undefined,
            align: (attrs.ALIGN ?? 'left').toLowerCase(),
            width: attrs.WIDTH ?? '25%',
            height: attrs.HEIGHT ?? '25%',
            left: attrs.LEFT ?? '',
            top: attrs.TOP ?? '',
            scrolling: (attrs.SCROLLING ?? 'yes').toLowerCase() !== 'no',
            floating: attrs.FLOATING !== undefined,
            dockFrame: attrs.DOCK ?? '',
            parent: null,
            children: [],
            rect: { x: 0, y: 0, width: 0, height: 0 },
            tabBarHeight: 0,
            tabs: [],
            activeTab: name,
            usedHeight: 0,
            claimedBorder: null,
        };

        this.frames.set(name, frame);
        if (!frame.isInternal) {
            this.layoutExternalFrame(frame);
        } else if (frame.dockFrame !== '' && frame.align === 'client') {
            this.layoutTabFrame(frame);
        } else {
            this.layoutInternalFrame(frame, dest ? this.frames.get(dest) ?? null : null);
        }
        if (!frame.scrolling) this.host.setFrameScrolling(name, false);
        return true;
    }

    /** `ACTION=close`. Closing an unknown frame succeeds — it is already closed,
     *  and reporting failure would leak the raw tag into the output. */
    closeFrame(name: string): boolean {
        const frame = this.frames.get(name);
        if (!frame) return true;

        // Children are consoles of their own; they cannot outlive the frame
        // whose viewport they render inside.
        for (const child of [...frame.children]) this.closeFrame(child.name);

        const parent = frame.parent;
        if (parent) {
            parent.children = parent.children.filter(c => c !== frame);
            if (parent.tabs.includes(name)) {
                parent.tabs = parent.tabs.filter(t => t !== name);
                this.publishTabs(parent);
            }
        }
        frame.parent = null;
        this.frames.delete(name);
        this.host.destroyFrameConsole(name);
        // Reclaim the space an edge-aligned frame was holding.
        this.recalculateBorders();
        return true;
    }

    /** `ACTION=focus` — raise an existing frame. False when there is none. */
    focusFrame(name: string): boolean {
        if (!this.frames.has(name)) return false;
        this.host.raiseFrameConsole(name);
        this.selectTabFor(name);
        return true;
    }

    /** `ACTION=open` on a frame that already exists: show and raise, no re-layout. */
    showFrame(name: string): boolean {
        if (!this.frames.has(name)) return false;
        this.host.showFrameConsole(name);
        this.host.raiseFrameConsole(name);
        this.selectTabFor(name);
        return true;
    }

    /** MXP frames do not survive a reconnect — Mudlet's `resetAllFrames`. */
    resetAllFrames(): void {
        for (const name of [...this.frames.keys()]) {
            this.frames.delete(name);
            this.host.destroyFrameConsole(name);
        }
        this.borders = { ...NO_BORDERS };
        this.host.setMxpBorders(this.getBorders());
    }

    has(name: string): boolean {
        return this.frames.has(name);
    }

    frameNames(): string[] {
        return [...this.frames.keys()];
    }

    /** Current MXP borders. Exposed for tests and for the initial UI read. */
    getBorders(): MxpBorders {
        return { ...this.borders };
    }

    // ── Layout ────────────────────────────────────────────────────────────────

    /**
     * The common case: a frame tiled against an edge of the main console, or —
     * when declared inside an open `<DEST>` — stacked inside that frame.
     */
    private layoutInternalFrame(frame: MxpFrame, parent: MxpFrame | null): void {
        const area = this.host.consoleArea();

        // Container the frame is measured and positioned against. Nested frames
        // work in their parent's viewport coordinates, so the origin is (0, 0)
        // plus whatever earlier ALIGN=TOP siblings already consumed.
        let containerX: number, containerY: number, containerW: number, containerH: number;
        if (parent) {
            const [pw, ph] = this.contentSize(parent);
            containerX = 0;
            containerY = parent.usedHeight;
            containerW = pw;
            containerH = Math.max(0, ph - parent.usedHeight);
        } else {
            containerX = area.x + this.borders.left;
            containerY = area.y + this.borders.top;
            containerW = Math.max(0, area.width - this.borders.left - this.borders.right);
            containerH = Math.max(0, area.height - this.borders.top - this.borders.bottom);
        }

        let width = this.calcSize(frame.width, containerW, false);
        let height = this.calcSize(frame.height, containerH, true);
        // "100%" of a nested container means "whatever is left", not the
        // container's original height.
        if (parent && frame.height.trim() === '100%') height = containerH;

        const isCharWidth = /c$/i.test(frame.width.trim());
        const isCharHeight = /c$/i.test(frame.height.trim());
        const wantsHeader = !frame.floating && frame.hasExplicitTitle;

        // Minimums, so a frame the server sized badly is still visible.
        if (width < 50) width = 100;
        if (height < 20 && !isCharHeight) height = 50;
        if (isCharHeight) {
            const minHeight = wantsHeader ? MXP_TAB_BAR_HEIGHT + 30 : 30;
            if (height < minHeight) height = minHeight;
            // A character height names how many *text rows* the server wants, so
            // the tab strip is added on top of them rather than eating into them.
            if (wantsHeader) height += MXP_TAB_BAR_HEIGHT;
        }
        // A character count is a promise that that many cells are *visible*, so
        // pay for the console's own padding and border out of the frame rather
        // than out of the last row (Mudlet adds the same slack). One row short
        // is what turns a fits-exactly status frame into a scrolling one.
        if (isCharWidth) width += CHAR_SIZE_SLACK;
        if (isCharHeight) height += CHAR_SIZE_SLACK;

        let x = containerX;
        let y = containerY;

        if (parent) {
            // Inside a parent: left/right hug a side and run the full remaining
            // height; top/bottom span the width and stack vertically.
            if (frame.align === 'right') {
                x = containerW - width;
                height = containerH;
            } else if (frame.align === 'top') {
                width = containerW;
                parent.usedHeight += height;
            } else if (frame.align === 'bottom') {
                y = Math.max(containerY, containerY + containerH - height);
                width = containerW;
            } else {
                height = containerH;
            }
        } else if (frame.left !== '' || frame.top !== '') {
            // Absolute LEFT/TOP wins over ALIGN, and does not claim any border:
            // the frame floats over the console instead of shrinking it. Still
            // measured from the console area's corner, not the raw window, so it
            // stays out of a GUI package's reserved strip like every other frame.
            if (frame.left !== '') {
                const px = this.calcSize(frame.left, area.width, false);
                if (px > 0) x = area.x + px;
            }
            if (frame.top !== '') {
                const px = this.calcSize(frame.top, area.height, true);
                if (px > 0) y = area.y + px;
            }
        } else if (frame.align === 'left') {
            x = area.x + this.borders.left;
            y = area.y;
            height = area.height;
            frame.claimedBorder = { side: 'left', px: width };
            this.borders.left += width;
        } else if (frame.align === 'right') {
            x = area.x + area.width - this.borders.right - width;
            y = area.y;
            height = area.height;
            frame.claimedBorder = { side: 'right', px: width };
            this.borders.right += width;
        } else if (frame.align === 'top') {
            x = area.x + this.borders.left;
            y = area.y + this.borders.top;
            width = area.width - this.borders.left - this.borders.right;
            frame.claimedBorder = { side: 'top', px: height };
            this.borders.top += height;
        } else if (frame.align === 'bottom') {
            x = area.x + this.borders.left;
            y = area.y + area.height - this.borders.bottom - height;
            width = area.width - this.borders.left - this.borders.right;
            frame.claimedBorder = { side: 'bottom', px: height };
            this.borders.bottom += height;
        }
        if (!parent) this.host.setMxpBorders(this.getBorders());

        // A very short frame has no room for a header, however the server asked.
        const showHeader = wantsHeader && (height >= 50 || isCharHeight);
        frame.tabBarHeight = showHeader ? MXP_TAB_BAR_HEIGHT : 0;
        frame.rect = { x, y, width, height };
        if (parent) {
            frame.parent = parent;
            parent.children.push(frame);
        }

        this.host.placeFrameConsole(frame.name, x, y, width, height, parent?.name);
        if (showHeader) {
            frame.tabs = [frame.name];
            this.publishTabs(frame);
        }
    }

    /** `EXTERNAL` — a window of its own. The browser has no OS child windows,
     *  so this becomes a free-floating panel with a real titlebar. */
    private layoutExternalFrame(frame: MxpFrame): void {
        const area = this.host.consoleArea();
        const width = Math.max(150, this.calcSize(frame.width, area.width, false));
        const height = Math.max(80, this.calcSize(frame.height, area.height, true));
        frame.rect = { x: 0, y: 0, width, height };
        this.host.openExternalFrame(frame.name, frame.title, width, height);
    }

    /** `DOCK=other ALIGN=CLIENT` — join `other`'s tab strip as another page. */
    private layoutTabFrame(frame: MxpFrame): void {
        const parent = this.frames.get(frame.dockFrame);
        // Docking into a frame that never opened: fall back to a normal frame
        // rather than dropping the window entirely.
        if (!parent || !parent.isInternal) {
            this.layoutInternalFrame(frame, null);
            return;
        }

        // The target may have been opened without a TITLE and so have no strip
        // yet; give it one now, with its own console as the first page.
        if (parent.tabs.length === 0) {
            parent.tabs = [parent.name];
            parent.tabBarHeight = MXP_TAB_BAR_HEIGHT;
        }

        const [width, height] = this.contentSize(parent);
        frame.rect = { x: 0, y: 0, width, height };
        frame.parent = parent;
        parent.children.push(frame);
        parent.tabs.push(frame.name);

        this.host.placeFrameConsole(frame.name, 0, 0, width, height, parent.name);
        // Mudlet selects the first docked child, on the grounds that a frame
        // used as a tab host rarely has content of its own; later tabs are added
        // in the background so an arriving tab never steals what you are reading.
        this.publishTabs(parent, parent.children.length === 1 ? frame.name : undefined);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Usable area inside a frame, i.e. its rect minus its own tab strip. */
    private contentSize(frame: MxpFrame): [number, number] {
        return [frame.rect.width, Math.max(0, frame.rect.height - frame.tabBarHeight)];
    }

    /** Push a frame's strip to the UI. `active` switches the visible page;
     *  omitting it keeps whichever page is showing, so a tab arriving or closing
     *  never yanks the reader off the one they were watching. */
    private publishTabs(frame: MxpFrame, active?: string): void {
        if (frame.tabs.length === 0) {
            this.host.setFrameTabs(frame.name, [], frame.name);
            return;
        }
        if (active !== undefined) frame.activeTab = active;
        if (!frame.tabs.includes(frame.activeTab)) frame.activeTab = frame.tabs[0];
        const pages = frame.tabs.map(id => ({ id, title: this.frames.get(id)?.title ?? id }));
        this.host.setFrameTabs(frame.name, pages, frame.activeTab);
    }

    /** Bring `name` to the front of whichever tab strip holds it, if any. */
    private selectTabFor(name: string): void {
        const frame = this.frames.get(name);
        if (!frame) return;
        const host = frame.parent && frame.parent.tabs.includes(name) ? frame.parent
                   : frame.tabs.includes(name) ? frame
                   : null;
        if (host) this.publishTabs(host, name);
    }

    /**
     * `WIDTH`/`HEIGHT`/`LEFT`/`TOP` accept `40c` (character cells), `25%` of the
     * container, or `350px`/`350` (pixels). Anything unparseable is 0, matching
     * Mudlet — the caller's minimums then take over.
     */
    private calcSize(spec: string, container: number, isHeight: boolean): number {
        const trimmed = spec.trim();
        if (trimmed === '') return 0;

        if (/c$/i.test(trimmed)) {
            const chars = parseInt(trimmed.slice(0, -1), 10);
            if (!Number.isFinite(chars) || chars <= 0) return 0;
            const [cw, ch] = this.host.charCellSize();
            return Math.round(chars * (isHeight ? ch : cw));
        }

        if (trimmed.endsWith('%')) {
            const percent = parseInt(trimmed.slice(0, -1), 10);
            // Mudlet rejects >100%: a frame larger than its container is far
            // more likely a server bug than an intent.
            if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return 0;
            return Math.round((container * percent) / 100);
        }

        const px = parseInt(/px$/i.test(trimmed) ? trimmed.slice(0, -2) : trimmed, 10);
        return Number.isFinite(px) && px > 0 ? px : 0;
    }

    /**
     * Rebuild the borders from the frames that are left. Called after a close so
     * the main console reclaims the space; surviving frames keep the geometry
     * they were given (Mudlet does not re-tile them either).
     */
    private recalculateBorders(): void {
        const next: MxpBorders = { ...NO_BORDERS };
        // Nested and absolutely-positioned frames never claimed a border, so
        // they carry no claim and drop out here.
        for (const frame of this.frames.values()) {
            if (frame.claimedBorder) next[frame.claimedBorder.side] += frame.claimedBorder.px;
        }
        this.borders = next;
        this.host.setMxpBorders(this.getBorders());
    }
}
