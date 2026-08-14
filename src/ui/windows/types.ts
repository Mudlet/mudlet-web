export type PanelKind = 'output' | 'text' | 'html' | 'map';

export type DockSide = 'left' | 'right' | 'top' | 'bottom';

export interface DragState {
    panelId: string;
    potentialDock: DockSide | null;
    insertSlotIndex: number | null;
    /** Center zone drop — creates/joins a tab group. */
    stackTargetId?: string;
    /** Cross-axis edge drop — creates/joins a split group (vertical stack in horizontal dock). */
    splitTargetId?: string;
    /** true = insert before target in cross-axis; false = after. */
    splitBefore?: boolean;
}

/** One page of an MXP `<FRAME>` tab strip. `id` is the frame whose console the
 *  tab shows — the host frame itself for the first page, a `DOCK`ed child
 *  otherwise. See MxpFrameManager. */
export interface MxpTabPage { id: string; title: string }

export interface WindowOpenOptions {
    title?: string;
    kind?: 'text' | 'html' | 'map';
    position?: 'right' | 'left' | 'above' | 'below';
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    activate?: boolean;
    autoOpen?: boolean;
    docked?: DockSide;
    dockOrder?: number;
    dockFlex?: number;
    dockGroup?: string;
    tabOrder?: number;
    isActiveTab?: boolean;
    splitGroup?: string;
    splitOrder?: number;
    splitFlex?: number;
    /** If true, window is restored in hidden state. */
    hidden?: boolean;
    /** If false, skip restoring the saved hint (Mudlet restoreLayout=false). */
    ignoreHint?: boolean;
    /** If false, force floating regardless of dockingArea (Mudlet autoDock=false). */
    autoDock?: boolean;
    /** If true, the user cannot drag this window into a dock slot. Set
     *  automatically when openUserWindow(name, _, autoDock=false) is called,
     *  mirroring Mudlet's "autoDock=false locks the window floating" behaviour. */
    lockFloating?: boolean;
    /** Dock side to use when no saved hint exists (Mudlet dockingArea). "main" = floating. */
    dockingArea?: string;
    /** Output font size in pixels (Mudlet setFontSize). */
    fontSize?: number;
    /** Output font family override (Mudlet setFont). */
    fontFamily?: string;
    /** Rendered row height in px, overriding the stylesheet's line-height. Set
     *  for MXP frames so a box of N rows really holds N rows. See
     *  WindowManager.setLineHeight. */
    lineHeight?: number;
    /** Character-column wrap width (Mudlet setWindowWrap). 0/undefined disables. */
    wrapAt?: number;
    /** Indent (in characters) of newline-started lines (Mudlet setWindowWrapIndent). */
    wrapIndent?: number;
    /** Indent (in characters) of wrapped continuation lines (Mudlet setWindowWrapHangingIndent). */
    wrapHangingIndent?: number;
    /** Window background fill (Mudlet setBackgroundColor). rgba 0..255. */
    backgroundColor?: { r: number; g: number; b: number; a: number };
    /** Mudlet setBackgroundImage. `url` is a resolved href for modes 1-3 or the
     *  raw stylesheet body for mode 4 (style). `mode` mirrors `mudlet.BgImageMode`:
     *  1=border (stretched), 2=center, 3=tile, 4=style. */
    backgroundImage?: { url: string; mode: number };
    /** For miniconsoles, the parent userwindow id ('main' or another userwindow's
     *  name). When set to a non-main parent, the miniconsole is rendered inside
     *  that parent's viewport at parent-relative (x, y) coordinates. */
    parent?: string;
}

export interface WindowHandle {
    readonly id: string;
    readonly kind: PanelKind;
    readonly element: HTMLElement;
    write(text: string): void;
    clear(): void;
    setTitle(title: string): void;
    focus(): void;
    close(): void;
}

export interface ScriptWindowRenderData {
    id: string;
    title: string;
    kind: 'text' | 'html' | 'map';
    visible: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    docked?: DockSide;
    dockOrder?: number;
    dockFlex?: number;
    dockGroup?: string;
    tabOrder?: number;
    isActiveTab?: boolean;
    splitGroup?: string;
    splitOrder?: number;
    splitFlex?: number;
    fontSize?: number;
    fontFamily?: string;
    /** See WindowOpenOptions.lineHeight. */
    lineHeight?: number;
    wrapAt?: number;
    wrapIndent?: number;
    wrapHangingIndent?: number;
    backgroundColor?: { r: number; g: number; b: number; a: number };
    backgroundImage?: { url: string; mode: number };
    /** For miniconsoles created with a parent userwindow — see WindowOpenOptions.parent. */
    parent?: string;
    /** When true, drag-to-dock is disabled for this floating window. See
     *  WindowOpenOptions.lockFloating. */
    lockFloating?: boolean;
    /** When true, the panel is detached into a separate browser window. Its
     *  portal-target div is appended into that window's document instead of a
     *  dock slot / floating frame; the component never unmounts (scrollback and
     *  live registrations survive). Closing the popout window pops it back in.
     *  This is transient runtime state — it is not persisted to the saved hint,
     *  so a reload restores the panel to its prior docked/floating position
     *  (re-opening a popup without a user gesture would be blocked anyway). */
    poppedOut?: boolean;
    /** Mudlet enableCommandLine(name) — when true, the panel renders a single-line
     *  input below the output area. Enter fires the registered cmd-line action;
     *  if none, the text is sent to the MUD via the main connection. */
    cmdLineEnabled?: boolean;
    /** Mudlet setCmdLineStyleSheet(name, qss) — Qt QSS for the per-window input.
     *  Translated through cmdLineQssToScopedCss at render time. */
    cmdLineStyleSheet?: string;
    /** Mudlet clearCmdLine / printCmdLine seed value. Drives the input's value
     *  one-shot on change so React stays in sync with script writes. */
    cmdLineValue?: string;
    /** Bumped each time cmdLineValue is written by script, so identical writes
     *  still trigger React's seed effect (otherwise printCmdLine('x') after a
     *  user types 'x' would do nothing). */
    cmdLineValueSeq?: number;
    /** MXP `<FRAME TITLE=…>` tab strip rendered as this window's chrome. Absent
     *  for every other window; set only by MxpFrameManager. */
    frameTabs?: { pages: MxpTabPage[]; active: string };
    /** True for a console backing an MXP `<FRAME>` — draws the frame border. */
    isMxpFrame?: boolean;
}
