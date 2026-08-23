import type React from 'react';

// Qt's QSS dialect overlaps with CSS but isn't identical. This translator
// converts the subset Mudlet scripts commonly emit (gradients, unitless
// lengths) into DOM-renderable CSS. Properties we don't recognize pass through
// untouched and end up applied verbatim — the browser silently drops anything
// it doesn't understand.

// Properties whose values are lengths, where Qt allows unitless numbers but
// the browser requires explicit units. Each numeric token without a unit gets
// "px" appended; tokens with a unit (px, %, em, …) are left alone.
const LENGTH_PROPS = new Set([
    'border-radius',
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-left-radius', 'border-bottom-right-radius',
    'border-width',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border',
    'border-top', 'border-right', 'border-bottom', 'border-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'top', 'left', 'right', 'bottom',
    'width', 'height',
    'min-width', 'min-height', 'max-width', 'max-height',
    'font-size', 'letter-spacing', 'word-spacing',
]);

// Parsing a Qt stylesheet (gradient / unit / selector handling) is pure in its
// source string, but it runs for every label on every overlay render — and
// during a Geyser split-resize drag the whole overlay re-renders many times a
// second while only geometry (not the stylesheet) changes. Memoize by source
// string so repeated renders reuse the parse instead of re-running the regex
// pipeline. Bounded so dynamically-generated stylesheets can't grow it without
// limit; the returned objects are treated as read-only by all callers, so it is
// safe to hand back a shared instance.
const CACHE_CAP = 1024;
function memoize<V>(cache: Map<string, V>, key: string, make: () => V): V {
    let hit = cache.get(key);
    if (hit === undefined) {
        hit = make();
        if (cache.size >= CACHE_CAP) cache.clear();
        cache.set(key, hit);
    }
    return hit;
}

const STYLE_CACHE = new Map<string, React.CSSProperties>();
export function cssTextToStyle(css: string): React.CSSProperties {
    return memoize(STYLE_CACHE, css, () => declarationsToStyle(stripRulesetBraces(css)));
}

// Parse a Qt-style stylesheet that mixes flat declarations and selector
// rulesets. Returns the flat declarations (everything in the base block or in a
// `QLabel { … }` rule) as inline style, plus a list of scoped rules keyed by
// CSS pseudo-class for state selectors like `QLabel::hover`, `QLabel:pressed`,
// etc. Caller is expected to inject scoped rules into a `<style>` element
// targeting the specific label via a unique selector prefix.
export interface QtMargin {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface CssParts {
    inline: React.CSSProperties;
    scoped: Array<{ pseudo: string; declarations: string }>;
    margin?: QtMargin;
}

const PARTS_CACHE = new Map<string, CssParts>();
export function cssTextToParts(css: string): CssParts {
    return memoize(PARTS_CACHE, css, () => cssTextToPartsUncached(css));
}

function cssTextToPartsUncached(css: string): CssParts {
    if (css.indexOf('{') < 0) {
        const { style, margin } = declarationsToStyleWithMargin(css);
        return { inline: style, scoped: [], margin };
    }
    const inlineDecls: string[] = [];
    const scoped: Array<{ pseudo: string; declarations: string }> = [];
    for (const rule of splitRulesets(css)) {
        const pseudo = qtSelectorToPseudo(rule.selector);
        if (pseudo === '') inlineDecls.push(rule.body);
        else if (pseudo !== null) scoped.push({ pseudo, declarations: rule.body });
        // Unknown selectors (other widget types, descendant rules) are dropped —
        // they wouldn't have applied to a QLabel in Mudlet either.
    }
    const { style, margin } = declarationsToStyleWithMargin(inlineDecls.join(';'));
    return { inline: style, scoped, margin };
}

// Translate a Qt selector ("QLabel", "QLabel:hover", "QLabel::hover",
// "QLabel:!hover", ":hover", "*") into the CSS pseudo-class suffix to apply.
// Empty string = no pseudo (applies as inline). null = drop the rule.
function qtSelectorToPseudo(sel: string): string | null {
    const trimmed = sel.trim();
    if (!trimmed) return null;
    if (trimmed === '*' || /^QLabel$/i.test(trimmed)) return '';
    // Strip optional widget-type prefix (e.g., QLabel:hover → :hover). We only
    // accept QLabel or no prefix; other widget types don't render here.
    const m = trimmed.match(/^(QLabel)?(:{1,2}!?[\w-]+)$/i);
    if (!m) return null;
    let pseudo = m[2];
    // Qt's `::state` is equivalent to `:state` for pseudo-classes; CSS requires
    // single colon. (Real pseudo-elements like `::before` aren't Qt states.)
    if (pseudo.startsWith('::')) pseudo = pseudo.slice(1);
    // Qt's `:!state` is the negation; map to CSS `:not(:state)`.
    if (pseudo.startsWith(':!')) pseudo = ':not(:' + pseudo.slice(2) + ')';
    // Map Qt-specific state names to their CSS equivalents.
    const QT_TO_CSS: Record<string, string> = {
        ':pressed': ':active',
        ':!pressed': ':not(:active)',
    };
    return QT_TO_CSS[pseudo] ?? pseudo;
}

// Apply Qt→CSS translations on a flat declaration block and return inline
// styles. Used for both the base block and `QLabel { … }` rule bodies.
function declarationsToStyle(css: string): React.CSSProperties {
    return declarationsToStyleWithMargin(css).style;
}

// Same as declarationsToStyle but also extracts Qt margin as geometry-inset
// data. Margin in Qt's QSS insets the visible area within the widget's
// geometry, but CSS margin on an absolutely-positioned div *offsets* the box —
// so we pull margin out of the inline style and hand it back as numbers so
// LabelOverlay can apply it as left/top/width/height adjustments.
function declarationsToStyleWithMargin(css: string): {
    style: React.CSSProperties;
    margin?: QtMargin;
} {
    const out: Record<string, string> = {};
    const margin: Partial<QtMargin> = {};
    for (const { key, val } of applyBorderImageBlockTransform(parseQtDeclarations(css))) {
        if (key === 'qproperty-alignment') {
            Object.assign(out, qtAlignmentToFlex(val));
            continue;
        }
        // qproperty-scaledContents is a Qt widget property, captured separately
        // (extractQtScaledContents) and applied to the background image at render
        // — it has no direct CSS declaration, so drop it here.
        if (key === 'qproperty-scaledcontents') continue;
        if (key === 'margin' || key === 'margin-top' || key === 'margin-right'
            || key === 'margin-bottom' || key === 'margin-left') {
            applyMarginDeclaration(margin, key, val);
            continue;
        }
        const [outKey, outVal] = translateDeclaration(key, val);
        const camel = outKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[camel] = outVal;
    }
    const fullMargin: QtMargin | undefined = (
        margin.top !== undefined || margin.right !== undefined
        || margin.bottom !== undefined || margin.left !== undefined
    ) ? {
        top: margin.top ?? 0,
        right: margin.right ?? 0,
        bottom: margin.bottom ?? 0,
        left: margin.left ?? 0,
    } : undefined;
    return { style: out as React.CSSProperties, margin: fullMargin };
}

// Parse a single margin declaration into the QtMargin accumulator. Handles
// shorthand (1–4 values) and the per-side `margin-top` etc. forms.
function applyMarginDeclaration(out: Partial<QtMargin>, key: string, val: string): void {
    if (key === 'margin') {
        const nums = val.split(/\s+/).map(parseMarginToken).filter((n): n is number => n !== null);
        if (nums.length === 1) {
            out.top = out.right = out.bottom = out.left = nums[0];
        } else if (nums.length === 2) {
            out.top = out.bottom = nums[0];
            out.left = out.right = nums[1];
        } else if (nums.length === 3) {
            out.top = nums[0];
            out.left = out.right = nums[1];
            out.bottom = nums[2];
        } else if (nums.length === 4) {
            [out.top, out.right, out.bottom, out.left] = nums;
        }
        return;
    }
    const n = parseMarginToken(val);
    if (n === null) return;
    const side = key.slice('margin-'.length) as keyof QtMargin;
    out[side] = n;
}

function parseMarginToken(tok: string): number | null {
    const m = tok.match(/^(-?\d+(?:\.\d+)?)(px)?$/);
    return m ? parseFloat(m[1]) : null;
}

// Translate a Qt-style stylesheet meant for a userwindow (`QWidget { … }`) into
// a single scoped CSS string targeting the panel viewport via `scope` (an
// attribute selector). Mudlet's `setUserWindowStyleSheet` styles the window
// widget — most commonly the `QWidget` selector with `padding`, `background-*`,
// etc. We translate Qt units / gradients and rewrite selectors so a script
// writing the QSS Mudlet expects gets the equivalent DOM effect (e.g. padding
// pushes the text console inward, while sibling labels can still span the full
// rect). Rules targeting other widget types are dropped — there's no per-child
// Qt hierarchy to address in this DOM.
export function userWindowQssToScopedCss(qss: string, scope: string): string {
    if (!qss.trim()) return '';
    const rules: string[] = [];
    if (qss.indexOf('{') < 0) {
        const decls = qtDeclarationsToCss(qss);
        return decls ? `${scope} { ${decls} }` : '';
    }
    for (const rule of splitRulesets(qss)) {
        const pseudo = qtWidgetSelectorToPseudo(rule.selector);
        if (pseudo === null) continue;
        const decls = qtDeclarationsToCss(rule.body);
        if (!decls) continue;
        rules.push(`${scope}${pseudo} { ${decls} }`);
    }
    return rules.join('\n');
}

// Translate Mudlet's `setCmdLineStyleSheet(name, qss)` body into scoped CSS
// targeting the per-window command-line `<input>` selected by `scope`. Mudlet
// scripts most commonly write `QPlainTextEdit { ... }` (the underlying Qt
// widget Mudlet uses) or `QWidget { ... }` / no selector / `*`. Pseudo states
// on those selectors (`:hover`, `:focus`) project to the same input. Rules
// targeting any other Qt widget type are dropped — there is no equivalent
// child widget in the DOM input.
export function cmdLineQssToScopedCss(qss: string, scope: string): string {
    if (!qss.trim()) return '';
    const rules: string[] = [];
    if (qss.indexOf('{') < 0) {
        const decls = qtDeclarationsToCss(qss);
        return decls ? `${scope} { ${decls} }` : '';
    }
    for (const rule of splitRulesets(qss)) {
        const pseudo = qtCmdLineSelectorToPseudo(rule.selector);
        if (pseudo === null) continue;
        const decls = qtDeclarationsToCss(rule.body);
        if (!decls) continue;
        rules.push(`${scope}${pseudo} { ${decls} }`);
    }
    return rules.join('\n');
}

// Sibling of qtWidgetSelectorToPseudo for the command-line case. Adds
// QPlainTextEdit / QLineEdit / QTextEdit to the set of selectors that resolve
// to the input itself.
function qtCmdLineSelectorToPseudo(sel: string): string | null {
    const trimmed = sel.trim();
    if (!trimmed) return '';
    if (trimmed === '*' || /^(QWidget|QPlainTextEdit|QLineEdit|QTextEdit)$/i.test(trimmed)) return '';
    const m = trimmed.match(/^(QWidget|QPlainTextEdit|QLineEdit|QTextEdit)?(:{1,2}!?[\w-]+)$/i);
    if (!m) return null;
    let pseudo = m[2];
    if (pseudo.startsWith('::')) pseudo = pseudo.slice(1);
    if (pseudo.startsWith(':!')) pseudo = ':not(:' + pseudo.slice(2) + ')';
    const QT_TO_CSS: Record<string, string> = {
        ':pressed': ':active',
        ':!pressed': ':not(:active)',
    };
    return QT_TO_CSS[pseudo] ?? pseudo;
}

// Sibling of qtSelectorToPseudo for the userwindow case: `QWidget`, `*`, or an
// empty (base-block) selector all map to the scope itself; state pseudos like
// `QWidget:hover` become scoped `:hover`. Anything else returns null and the
// caller drops the rule.
function qtWidgetSelectorToPseudo(sel: string): string | null {
    const trimmed = sel.trim();
    if (!trimmed) return '';
    if (trimmed === '*' || /^QWidget$/i.test(trimmed)) return '';
    const m = trimmed.match(/^(QWidget)?(:{1,2}!?[\w-]+)$/i);
    if (!m) return null;
    let pseudo = m[2];
    if (pseudo.startsWith('::')) pseudo = pseudo.slice(1);
    if (pseudo.startsWith(':!')) pseudo = ':not(:' + pseudo.slice(2) + ')';
    const QT_TO_CSS: Record<string, string> = {
        ':pressed': ':active',
        ':!pressed': ':not(:active)',
    };
    return QT_TO_CSS[pseudo] ?? pseudo;
}

// ── App/profile stylesheets: Qt objectName selectors ─────────────────────────
//
// `setAppStyleSheet` / `setProfileStyleSheet` install a QApplication-level
// stylesheet in Mudlet, so packages address individual Mudlet widgets by their
// Qt objectName — e.g. a package that embeds the mapper in its own layout does
//
//     QWidget#widget_panel { max-height: 0px; min-height: 0px; padding: 0px; }
//
// to collapse dlgMapper's control bar (`mapper.ui`, objectName `widget_panel`).
// That form is *syntactically* valid CSS — a `QWidget` type selector plus an id
// — so the browser parses it without complaint and it matches nothing, because
// no `<QWidget>` element exists. Qt also accepts the bare `#widget_panel` form.
//
// Themes go further and style whole widget *classes* — `QDockWidget { … }` for
// every user window, `QToolButton:hover { … }`, and so on.
//
// Two tables cover the two forms: {@link QT_OBJECT_NAMES} lists the Mudlet
// widgets that have a mudix DOM stand-in (each such node carries
// `data-qt-object="<objectName>"`), and {@link QT_TYPE_MAP} maps widget types and
// their subcontrols onto mudix selectors. {@link rewriteQtSelectors} applies both.
//
// The rewrite is deliberately surgical: only a `Q<Type>#name` prefix, a bare
// `#name` naming one of the widgets we expose, or a *mapped* widget type is
// touched. Anything else — an unmapped Qt type, a `.mudix-*` rule — passes
// through untouched, because app stylesheets are also mudix's documented
// brand-styling hook and already carry real CSS.

/** Qt objectNames (from Mudlet's `.ui` files) that mudix mirrors onto a DOM node
 *  via `data-qt-object`, so package stylesheets addressing them keep working.
 *  Reference these instead of writing the raw string at the render site. */
export const QT_OBJECT_NAMES = {
    /** dlgMapper's collapsible control bar — area picker, z-level buttons,
     *  options menu (`mapper.ui`: `widget_panel`). */
    mapperPanel: 'widget_panel',
    /** The arrow that shows/hides that bar (`mapper.ui`: `toolButton_togglePanel`). */
    mapperPanelToggle: 'toolButton_togglePanel',
    /** Area selector (`mapper.ui`: `comboBox_showArea`). */
    mapperAreaSelector: 'comboBox_showArea',
    /** Z-level up / down buttons (`mapper.ui`: `toolButton_shiftZup/down`). */
    mapperShiftZup: 'toolButton_shiftZup',
    mapperShiftZdown: 'toolButton_shiftZdown',
    /** The mapper's hamburger / options button (`mapper.ui`: `toolButton_mapperMenu`). */
    mapperMenu: 'toolButton_mapperMenu',
} as const;

const QT_OBJECT_NAME_SET: ReadonlySet<string> = new Set(Object.values(QT_OBJECT_NAMES));

interface QtTypeEntry {
    /** The element(s) standing in for the widget itself. */
    self: readonly string[];
    /** Qt subcontrols (`::title`, `::handle`) → the node(s) playing that part. */
    sub?: Readonly<Record<string, readonly string[]>>;
    /** Qt states whose DOM spelling is specific to this widget, *concatenated*
     *  onto each target — so a BEM modifier (`--active`) or an attribute
     *  (`[aria-pressed="true"]`) both work, and a target that doesn't follow the
     *  convention simply matches nothing. A state that is neither listed here nor
     *  in {@link QT_STATE_TO_CSS}/{@link QT_STATE_IGNORED} drops the rule rather
     *  than silently widening it (Qt's `:selected` painting *every* row would be
     *  worse than painting none). */
    states?: Readonly<Record<string, string>>;
    /** Targets are `::-webkit-scrollbar…` pseudo-elements: they need a host
     *  element in front, must be the last token in a descendant chain, and can't
     *  share a selector list with ordinary selectors (a browser without them
     *  drops the whole list). */
    pseudoElement?: true;
    /** Single-compound selectors for the element(s) this widget scrolls with —
     *  what a descendant scrollbar rule (`TConsole QScrollBar`) resolves to.
     *
     *  It has to be a single compound, not `ancestor descendant`: Chromium stops
     *  matching the scrollbar orientation pseudo-classes as soon as the selector
     *  contains a combinator, so `.output-container ::-webkit-scrollbar:vertical`
     *  silently paints nothing while `.output-wrapper::-webkit-scrollbar:vertical`
     *  works. A type without this can't host a scoped scrollbar rule, and one is
     *  left inert rather than widened to every scrollbar in the app. */
    scrollers?: readonly string[];
    /** Kept out of the `QWidget` catch-all. Either the widget paints itself in
     *  Mudlet (a blanket QWidget rule never reached it there either) or it's a
     *  browser pseudo-element that a blanket background/border would wreck. */
    selfPainted?: true;
}

// Shared entries, so the aliases below are the same object (and the QWidget
// union dedupes them for free).
const QT_DOCK_WIDGET: QtTypeEntry = {
    // Mudlet user windows are QDockWidgets, floating or docked. mudix renders
    // the two as separate components with parallel chrome.
    self: ['.script-window', '.docked-panel'],
    sub: {
        title: ['.script-window-titlebar', '.docked-panel-titlebar'],
        'close-button': ['.script-window-btn.close'],
        'float-button': ['.script-window-btn.popout'],
    },
};
// Mudlet's toggle buttons expose their state through Qt's `:checked`/`:on`;
// mudix's carry aria-pressed (see ButtonsBar), which concatenates onto every
// target the way a BEM modifier can't.
const QT_BUTTON_STATES = {
    checked: '[aria-pressed="true"]',
    on: '[aria-pressed="true"]',
    unchecked: '[aria-pressed="false"]',
    off: '[aria-pressed="false"]',
} as const;
const QT_TEXT_INPUT: QtTypeEntry = { self: ['.input', '.command-input', '.window-cmdline'] };
const QT_ITEM_VIEW: QtTypeEntry = {
    self: ['.map-area-dropdown-list', '.font-picker__list', '.qo-list', '.connection-list'],
    sub: { item: ['.map-area-dropdown-item', '.font-picker__item', '.qo-item', '.connection-card'] },
};
const QT_TREE_VIEW: QtTypeEntry = {
    self: ['.script-editor__items', '.vfs-tree'],
    sub: { item: ['.script-editor__item', '.vfs-row'] },
    states: { selected: '--selected' },
};
const QT_SPLITTER_HANDLES = ['.dock-edge-splitter', '.dock-panel-splitter', '.split-group-splitter'];

/**
 * Qt *widget-type* selectors mapped onto the mudix DOM. Mudlet themes style
 * whole widget classes rather than named instances — `QToolButton { … }` for
 * every toolbar button, `QDockWidget::title { … }` for user-window title bars —
 * so these rules are what a pasted Mudlet app stylesheet actually spends most of
 * its lines on.
 *
 * A type that isn't listed here is left alone: the selector stays in the sheet,
 * inert, exactly as it arrived. Extending coverage is a table entry, not new
 * code — and `QWidget` widens with it (see {@link qWidgetSelectors}).
 *
 * Mudlet's own widget classes (`TConsole`, `TCommandLine`, …) are in here too,
 * because Mudlet's docs teach the descendant form for narrowing a rule to the
 * game area: `TConsole QScrollBar:vertical { … }`.
 *
 * Deliberately absent, because mudix has no surface playing the part: `QStatusBar`
 * (no status bar — connection state lives in the toolbar) and `QMdiArea`.
 */
const QT_TYPE_MAP: Record<string, QtTypeEntry> = {
    // ── Windows, dialogs, docks ──────────────────────────────────────────────
    QMainWindow: {
        self: ['.app'],
        sub: { separator: QT_SPLITTER_HANDLES },
    },
    QDockWidget: QT_DOCK_WIDGET,
    TDockWidget: QT_DOCK_WIDGET,
    QDialog: { self: ['.modal', '.resizable-modal', '.confirm-dialog'] },
    QSplitter: { self: QT_SPLITTER_HANDLES, sub: { handle: QT_SPLITTER_HANDLES } },

    // ── Toolbars and buttons ─────────────────────────────────────────────────
    // Mudlet's main toolbar plus the user-defined button bars (TEasyButtonBar).
    QToolBar: {
        self: ['.mudix-toolbar', '.mudix-buttonbar', '.mudix-floating-toolbar', '.map-panel-toolbar'],
        sub: {
            separator: ['.toolbar-sep'],
            handle: ['.mudix-floating-toolbar__handle'],
        },
    },
    TEasyButtonBar: { self: ['.mudix-buttonbar', '.mudix-floating-toolbar'] },
    // Buttons *in* a bar are QToolButtons in Mudlet; the ones in dialogs are
    // QPushButtons. The descendant forms keep the two apart the way Qt's widget
    // tree does — and outrank the plain `.btn` rule on specificity, so a sheet
    // styling both lands the toolbar rule in the toolbar regardless of order.
    QToolButton: {
        self: ['.mudix-toolbar .btn', '.mudix-btn', '.toolbar-hamburger-btn', '.map-panel-toolbar .btn'],
        states: QT_BUTTON_STATES,
    },
    QPushButton: { self: ['.btn'], states: QT_BUTTON_STATES },
    QAbstractButton: { self: ['.btn', '.mudix-btn'], states: QT_BUTTON_STATES },
    QCheckBox: { self: ['input[type="checkbox"]', '.toggle'] },

    // ── Menus ────────────────────────────────────────────────────────────────
    // mudix has no menu bar; the hamburger is what plays that part.
    QMenuBar: { self: ['.toolbar-hamburger'], sub: { item: ['.toolbar-hamburger-btn'] } },
    QMenu: {
        self: ['.ctx-menu', '.toolbar-hamburger-menu', '.map-hamburger-menu', '.map-context-menu'],
        sub: {
            item: ['.ctx-menu__item', '.toolbar-hamburger-menu .btn', '.map-hamburger-item', '.map-context-menu-item'],
            separator: ['.ctx-menu__sep', '.map-hamburger-separator', '.map-context-menu-separator'],
            indicator: ['.ctx-menu__check', '.map-hamburger-check'],
        },
    },

    // ── Text entry ───────────────────────────────────────────────────────────
    QLineEdit: QT_TEXT_INPUT,
    QPlainTextEdit: QT_TEXT_INPUT,
    QTextEdit: QT_TEXT_INPUT,
    // Mudlet's command line is a QPlainTextEdit subclass.
    TCommandLine: { self: ['.command-input', '.window-cmdline'] },

    // ── Lists, trees, combos ─────────────────────────────────────────────────
    QComboBox: { self: ['select.input', '.script-editor__lang-select', '.map-area-dropdown-btn'] },
    QAbstractItemView: QT_ITEM_VIEW,
    QListView: QT_ITEM_VIEW,
    QListWidget: QT_ITEM_VIEW,
    QTreeView: QT_TREE_VIEW,
    QTreeWidget: QT_TREE_VIEW,
    QHeaderView: {
        self: ['.script-editor__list-header', '.vfs-sql-table thead'],
        sub: { section: ['.vfs-sql-table th'] },
    },

    // ── Tabs ─────────────────────────────────────────────────────────────────
    QTabWidget: { self: ['.tab-group-panel'], sub: { 'tab-bar': ['.tab-group-tabbar'] } },
    QTabBar: {
        self: ['.tab-group-tabbar', '.mobile-switcher'],
        sub: { tab: ['.tab-group-tab', '.mobile-switcher__tab'] },
        states: { selected: '--active' },
    },

    // ── Misc chrome ──────────────────────────────────────────────────────────
    QProgressBar: { self: ['.map-progress'], sub: { chunk: ['.map-progress-fill'] } },
    QToolTip: { self: ['.help-tip-popover'] },
    // Mudlet labels are QLabel (TLabel) — an app-level QLabel rule reached them
    // there too. Labels that set their own stylesheet render it as *inline*
    // style, which still wins, so only unstyled labels pick this up.
    QLabel: { self: ['.label'] },
    TLabel: { self: ['.label'] },

    // ── Scrollbars ───────────────────────────────────────────────────────────
    // The browser has no scrollbar element, only the WebKit/Blink pseudo-element
    // family, so this is where the mapping is loosest. Qt's `::up-arrow` /
    // `::down-arrow` are dropped: they're painted *inside* the buttons that
    // `::add-line` / `::sub-line` already claim, and there's no second knob to
    // give them. Firefox exposes only `scrollbar-color`/`-width`, so a themed
    // scrollbar is Chromium-only.
    QScrollBar: {
        pseudoElement: true,
        selfPainted: true,
        self: ['::-webkit-scrollbar'],
        sub: {
            handle: ['::-webkit-scrollbar-thumb'],
            groove: ['::-webkit-scrollbar-track'],
            'add-page': ['::-webkit-scrollbar-track-piece'],
            'sub-page': ['::-webkit-scrollbar-track-piece'],
            'add-line': ['::-webkit-scrollbar-button:increment'],
            'sub-line': ['::-webkit-scrollbar-button:decrement'],
        },
    },
    QScrollArea: {
        self: ['.output-container', '.docked-panel-content', '.script-window-content'],
        scrollers: ['.output-wrapper'],
        selfPainted: true,
    },

    // ── Mudlet's custom-painted widgets ──────────────────────────────────────
    // TConsole/TTextEdit paint themselves in Mudlet, so a blanket QWidget rule
    // never coloured the game text there — and mustn't here. Naming them
    // explicitly still works, which is exactly what the wiki's scrollbar recipe
    // (`TConsole QScrollBar:vertical`) relies on.
    // `.output-wrapper` is every console's scroller — the main one and every
    // miniconsole — which is exactly what Mudlet's `TConsole` covers too.
    TConsole: { self: ['.output-container'], scrollers: ['.output-wrapper'], selfPainted: true },
    TTextEdit: { self: ['.output-wrapper'], scrollers: ['.output-wrapper'], selfPainted: true },
    dlgMapper: { self: ['.map-panel'] },
};

/**
 * Elements a themed scrollbar must leave alone, appended to every host selector
 * a `QScrollBar` rule generates:
 *
 *  - `mudix-native-scrollbar` — surfaces that hide their scrollbar as part of
 *    their design (the tab strip, the mobile switcher, the settings tabs). Also
 *    the documented escape hatch for anything else.
 *  - `mudix-no-scrollbar` — a console the script *asked* to have no scrollbar
 *    (`disableScrollBar`). An explicit call outranks a theme, same as in Mudlet.
 *
 * Doubling as the host for a bare `QScrollBar` rule: a lone `*` would lose to
 * mudix's own `.output-wrapper::-webkit-scrollbar`, and this carries class-level
 * specificity of its own.
 */
const SCROLLBAR_OPT_OUT = ':not(.mudix-native-scrollbar):not(.mudix-no-scrollbar)';

/**
 * Declarations that hand scrollbar rendering back to the `::-webkit-scrollbar`
 * pseudo-elements. Chromium honours the *standard* `scrollbar-width` /
 * `scrollbar-color` in preference to them — set either one and the whole WebKit
 * pseudo-element family is ignored — and mudix sets both globally (`App.css`:
 * `* { scrollbar-width: thin }`). Without this a themed `QScrollBar` rule parses,
 * matches, and still paints nothing. Emitted once per sheet, for the hosts whose
 * scrollbars the sheet actually styles, so a stylesheet that says nothing about
 * scrollbars leaves mudix's own treatment alone.
 */
const SCROLLBAR_STANDARD_RESET = 'scrollbar-width: auto; scrollbar-color: auto';

/**
 * Prefix that gives a rewritten Qt rule authority over mudix's own CSS.
 *
 * The point of installing an app stylesheet is to *restyle the client*, and in
 * Qt it does: the QApplication sheet governs the widgets it names. Landing on
 * the right element isn't enough here — mudix's own rules often carry more
 * specificity than the class the type table maps to (`.mudix-btn:hover` beats a
 * bare `.mudix-btn`, `.map-level-dropdown .map-area-dropdown-btn` beats
 * `.map-area-dropdown-btn`), so a theme would land a base colour and then lose
 * every hover and every nested case.
 *
 * `:root:root` is a doubled pseudo-class on the html element: it matches exactly
 * what it matched before and adds two classes' worth of specificity, putting
 * every rewritten rule above anything mudix writes about the same element.
 * Deliberately *not* `!important` — that would also override inline style, and
 * inline style is how a widget's own stylesheet is applied (`setLabelStyleSheet`
 * on a Geyser label). Qt resolves that the same way round: the per-widget sheet
 * wins over the application one.
 *
 * Applied only to rules we rewrote. Plain `.mudix-*` CSS — the brand-styling
 * hook — passes through with the specificity its author gave it.
 */
const SPECIFICITY_BOOST = ':root:root';

function boostSelector(selector: string): string {
    return `${SPECIFICITY_BOOST} ${selector}`;
}

/** Extra surfaces that are "a widget" in Qt's sense but aren't a widget *type*
 *  any theme addresses by name — panels and containers that would be plain
 *  QWidgets in Mudlet's layout. */
const QWIDGET_EXTRA_SURFACES = [
    '.app-content',
    '.command-bar',
    '.map-panel',
    '.script-window-content',
    '.docked-panel-content',
    '.script-editor',
];

let qWidgetCache: readonly string[] | null = null;

/**
 * What `QWidget` means here. In Qt a type selector matches the class *and its
 * subclasses*, so `QWidget` — the root of the hierarchy — matches every widget
 * in the app; themes lean on that for a one-block base coat (`QWidget {
 * background: #26192f; color: white; }`). Keeping the same meaning, the union is
 * computed from the table: every mapped type is a QWidget, so a new entry widens
 * this for free.
 *
 * Two exclusions, both matching what Mudlet does rather than departing from it:
 * `selfPainted` widgets (the game text area draws itself, so a QWidget rule never
 * reached it in Mudlet either) and the scrollbar pseudo-elements (not real
 * elements; a blanket border/background makes a mess of them). Name those types
 * directly and they style fine.
 */
function qWidgetSelectors(): readonly string[] {
    if (qWidgetCache) return qWidgetCache;
    const seen = new Set<string>();
    for (const entry of Object.values(QT_TYPE_MAP)) {
        if (entry.pseudoElement || entry.selfPainted) continue;
        for (const sel of entry.self) seen.add(sel);
    }
    for (const sel of QWIDGET_EXTRA_SURFACES) seen.add(sel);
    qWidgetCache = [...seen];
    return qWidgetCache;
}

function lookupQtType(name: string): QtTypeEntry | undefined {
    if (name === 'QWidget') return { self: qWidgetSelectors() };
    return QT_TYPE_MAP[name];
}

// A Qt type selector token: `QDockWidget`, `QDockWidget::title`,
// `QDockWidget:hover`, `QTabBar::tab:top:selected` — a type, an optional
// subcontrol, then any number of pseudo-states. Lower-case starts are allowed
// for Mudlet's own class names (`dlgMapper`); the table lookup is what decides
// whether a token means anything.
const QT_TYPE_SELECTOR_RE = /^([A-Za-z_][A-Za-z0-9_]*)(::[\w-]+)?((?::{1,2}!?[\w-]+)*)$/;

/** Qt states with a direct CSS equivalent. */
const QT_STATE_TO_CSS: Record<string, string> = {
    hover: ':hover',
    pressed: ':active',
    focus: ':focus',
    disabled: ':disabled',
    enabled: ':enabled',
    checked: ':checked',
    unchecked: ':not(:checked)',
    first: ':first-child',
    last: ':last-child',
};

/** Qt states that carry no information here — they describe a position or a
 *  window property that is always true in mudix's fixed layout (a tab bar is
 *  always on top, the window is always the active one). Dropping the token keeps
 *  the rule; dropping the *rule* would lose styling the theme meant to apply. */
const QT_STATE_IGNORED = new Set([
    'top', 'bottom', 'left', 'right', 'middle', 'only-one',
    'active', 'window', 'closable', 'floatable', 'movable', 'flat', 'default',
    'next-selected', 'previous-selected', 'alternate', 'adjoins-item',
    'maximized', 'minimized',
]);

/**
 * Translate a Qt pseudo-state run (`:top:selected`, `::hover`, `:!pressed`) for
 * one widget type. Returns the CSS suffix, or null when a state carries meaning
 * we can't express — the caller then leaves the whole selector alone rather than
 * emit a rule that would apply too widely.
 */
function qtStateRunToCss(run: string, entry: QtTypeEntry): string | null {
    const tokens = run.match(/:{1,2}!?[\w-]+/g);
    if (!tokens) return '';
    let out = '';
    for (const token of tokens) {
        const bare = token.replace(/^:{1,2}/, '');
        const negated = bare.startsWith('!');
        const name = negated ? bare.slice(1) : bare;

        const custom = entry.states?.[name];
        if (custom !== undefined) {
            // A modifier class can't be negated into `:not(…)` — it isn't a
            // pseudo-class — so `:!selected` drops the rule instead.
            if (negated) return null;
            out += custom;
            continue;
        }
        // Orientation only distinguishes anything on a scrollbar (where WebKit
        // spells it the same way); elsewhere it's a fixed property of the layout.
        if (name === 'vertical' || name === 'horizontal') {
            if (entry.pseudoElement) out += negated ? `:not(:${name})` : `:${name}`;
            continue;
        }
        if (QT_STATE_IGNORED.has(name)) continue;
        const css = QT_STATE_TO_CSS[name];
        if (css === undefined) return null;
        out += negated ? (css.startsWith(':not(') ? css.slice(5, -1) : `:not(${css})`) : css;
    }
    return out;
}

interface ExpandedPart {
    selectors: string[];
    /** Selectors end in a `::-webkit-scrollbar…` pseudo-element and must be
     *  emitted as their own rule — see {@link QtTypeEntry.pseudoElement}. */
    scrollbar: boolean;
    /** For a scrollbar part, the element(s) owning those scrollbars — they need
     *  the standard scrollbar properties switched off, see
     *  {@link SCROLLBAR_STANDARD_RESET}. */
    hosts?: string[];
}

/**
 * Expand one comma-separated Qt type selector into DOM selectors, or null when
 * any part of it has no mudix stand-in. Descendant chains (`TConsole
 * QScrollBar::handle`) expand token by token, which is how Mudlet's docs tell
 * people to scope a rule to the game area.
 */
function expandQtTypePart(part: string): ExpandedPart | null {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0] === '') return null;
    let prefixes: string[] = [''];
    let scrollbar = false;
    let ancestor: QtTypeEntry | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const m = tokens[i].match(QT_TYPE_SELECTOR_RE);
        if (!m) return null;
        const entry = lookupQtType(m[1]);
        if (!entry) return null;
        // Qt spells pseudo-states with one *or two* colons, so a `::foo` that
        // isn't a known subcontrol gets a second reading as a state.
        const subName = m[2] ? m[2].slice(2) : '';
        let targets = subName ? entry.sub?.[subName] : entry.self;
        let stateRun = m[3] ?? '';
        if (subName && !targets) {
            targets = entry.self;
            stateRun = `:${subName}${stateRun}`;
        }
        if (!targets || targets.length === 0) return null;
        const states = qtStateRunToCss(stateRun, entry);
        if (states === null) return null;
        scrollbar = entry.pseudoElement === true;
        // A pseudo-element can only be the last thing in a chain.
        if (scrollbar && i !== tokens.length - 1) return null;
        if (scrollbar) {
            // A pseudo-element needs an element to hang off. `QScrollBar` on its
            // own means every scrollbar in the app; `TConsole QScrollBar` means
            // the ones that widget owns — and that has to resolve to a single
            // compound selector, so it comes from the ancestor's `scrollers`
            // rather than from a descendant combinator (see QtTypeEntry).
            const owners = ancestor ? ancestor.scrollers : [''];
            if (!owners || owners.length === 0) return null;
            const hosts = owners.map(o => `${o}${SCROLLBAR_OPT_OUT}`);
            const selectors: string[] = [];
            for (const host of hosts) {
                for (const target of targets) selectors.push(`${host}${target}${states}`);
            }
            return { selectors, scrollbar, hosts };
        }
        const next: string[] = [];
        for (const prefix of prefixes) {
            for (const target of targets) {
                const sel = `${target}${states}`;
                next.push(prefix === '' ? sel : `${prefix} ${sel}`);
            }
        }
        prefixes = next;
        ancestor = entry;
    }
    return { selectors: prefixes, scrollbar };
}

// `QWidget#name`, `QToolButton#name`, … — an unmistakably-Qt type prefix, so the
// id is safe to reinterpret as an objectName whatever it names.
const QT_TYPED_OBJECT_RE = /\bQ[A-Z][A-Za-z0-9_]*#([A-Za-z_][\w-]*)/g;
// Bare `#name` (Qt's other accepted form). Only rewritten for names we publish,
// so a genuine DOM id in a brand stylesheet is never hijacked.
const BARE_OBJECT_RE = /(^|[\s,>+~(])#([A-Za-z_][\w-]*)/g;
// Qt clips a widget to its geometry, so `max-height: 0` really does hide the
// widget *and its children*; the DOM keeps painting overflowing children unless
// told otherwise. Detected per-rule so `overflow: hidden` is only added where
// the stylesheet asked for a collapse.
const ZERO_MAX_SIZE_RE = /\bmax-(?:width|height)\s*:\s*0(?:\.0+)?(?:px)?\s*(?:;|$)/i;
// Mudlet's own widget classes don't start with `Q`, so the cheap "is there
// anything to do?" test needs them by name. Derived from the table so a new
// entry can't forget to update it.
const MUDLET_TYPE_RE = new RegExp(
    `\\b(?:${Object.keys(QT_TYPE_MAP).filter(k => !/^Q[A-Z]/.test(k)).join('|')})\\b`,
);

interface RewrittenSelector {
    /** Ordinary selectors, or the untouched original when nothing mapped. */
    standard: string;
    /** Scrollbar pseudo-element selectors, emitted as a rule of their own. */
    scrollbar: string;
    /** Elements owning the scrollbars this rule styles. */
    scrollbarHosts: string[];
    changed: boolean;
}

function rewriteSelectorText(selector: string): RewrittenSelector {
    // objectName forms first: they consume the `Q<Type>#name` prefix, so what
    // reaches the type pass below is a bare type selector or something we leave
    // alone.
    let out = selector.replace(QT_TYPED_OBJECT_RE, (_m, name: string) => `[data-qt-object="${cssEscape(name)}"]`);
    out = out.replace(BARE_OBJECT_RE, (m, lead: string, name: string) =>
        QT_OBJECT_NAME_SET.has(name) ? `${lead}[data-qt-object="${cssEscape(name)}"]` : m);
    const objectFormChanged = out !== selector;

    // Widget-type forms, per comma-separated part. When no part maps to
    // anything, leave the selector exactly as it was: an unmapped Qt type stays
    // inert in the sheet, and — because the caller keys off whether the selector
    // changed — its declarations are left alone too.
    // Surrounding whitespace is part of the sheet's formatting (and the space
    // before `{`), so only the inter-part spacing is normalized.
    const lead = out.match(/^\s*/)?.[0] ?? '';
    const tail = out.match(/\s*$/)?.[0] ?? '';
    const parts = out.split(',');
    const expanded = parts.map(expandQtTypePart);
    if (!expanded.some(e => e !== null)) {
        // An objectName rewrite still needs the authority boost — the DOM node it
        // found is one mudix styles itself.
        const standard = objectFormChanged
            ? lead + parts.map(p => boostSelector(p.trim())).join(', ') + tail
            : out;
        return { standard, scrollbar: '', scrollbarHosts: [], changed: objectFormChanged };
    }
    // Deduped: two Qt subcontrols can share one DOM stand-in (`::add-page` and
    // `::sub-page` are both the track piece), and repeating a selector in the
    // list changes nothing but the noise.
    const standard = new Set<string>();
    const scrollbar = new Set<string>();
    const scrollbarHosts: string[] = [];
    parts.forEach((part, i) => {
        const e = expanded[i];
        if (!e) { standard.add(part.trim()); return; }
        // Scrollbar selectors skip the boost: `:root:root` puts a descendant
        // combinator in front of the pseudo-element, and Chromium then stops
        // matching `:vertical` / `:horizontal` (see QtTypeEntry.scrollers). They
        // don't need it — SCROLLBAR_OPT_OUT already carries two classes' worth.
        if (e.scrollbar) for (const sel of e.selectors) scrollbar.add(sel);
        else for (const sel of e.selectors) standard.add(boostSelector(sel));
        if (e.hosts) scrollbarHosts.push(...e.hosts);
    });
    const join = (set: Set<string>) => (set.size ? lead + [...set].join(', ') + tail : '');
    return { standard: join(standard), scrollbar: join(scrollbar), scrollbarHosts, changed: true };
}

const COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * Rewrite the Qt selectors in an app/profile-level stylesheet — objectName forms
 * (`QWidget#widget_panel`) and mapped widget types (`QDockWidget::title`) — onto
 * the DOM they correspond to in mudix. Returns the input unchanged when it holds
 * no Qt selector at all, which is the common case for CSS written against
 * mudix's own `.mudix-*` classes.
 *
 * A rule whose selector we rewrote also gets its *declarations* translated
 * (`qtDeclarationsToCss`): that body was written for Qt, so it may carry
 * `QLinearGradient(…)`, Qt's 0–255 `rgba()` alpha, or unitless lengths. Rules we
 * left alone keep their declarations verbatim. Comments are stripped up front —
 * they're inert, and an unbalanced brace or stray `#` inside one would otherwise
 * confuse the scan.
 */
export function rewriteQtSelectors(qss: string): string {
    // A rule needs a '{'; a rewritable selector needs either a '#' (objectName
    // form) or a Qt widget-type name.
    if (!qss || qss.indexOf('{') < 0) return qss;
    if (qss.indexOf('#') < 0 && !/\bQ[A-Z]/.test(qss) && !MUDLET_TYPE_RE.test(qss)) return qss;
    // Both markers, not just the opener: COMMENT_RE scans forward for `*/`, so
    // with no closer present it rescans to end-of-string from every `/*`
    // (quadratic — 855ms on 160KB). A comment needs both, so this is exact.
    const src = qss.indexOf('/*') < 0 || qss.indexOf('*/') < 0 ? qss : qss.replace(COMMENT_RE, '');
    const parts: string[] = [];
    const scrollbarHosts = new Set<string>();
    let i = 0;
    let chunkStart = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '(') {
            const close = matchingClose(src, i);
            if (close < 0) break;
            i = close + 1;
            continue;
        }
        if (c === '{') {
            const selector = src.slice(chunkStart, i);
            const close = matchingBrace(src, i);
            const end = close < 0 ? src.length : close;
            const body = src.slice(i + 1, end);
            const rewritten = rewriteSelectorText(selector);
            if (!rewritten.changed) {
                parts.push(rewritten.standard, '{', body, close < 0 ? '' : '}');
            } else {
                // Qt clips a widget to its geometry, so a zero max-height really
                // does hide it and its children; the DOM needs telling.
                const clip = ZERO_MAX_SIZE_RE.test(body) ? '; overflow: hidden' : '';
                const outBody = ` ${qtDeclarationsToCss(body)}${clip} `;
                const tail = close < 0 ? '' : '}';
                // Scrollbar pseudo-elements go in a rule of their own: a browser
                // that doesn't know `::-webkit-scrollbar` discards the entire
                // selector list, which would take the ordinary selectors with it.
                const rules: string[] = [];
                if (rewritten.standard) rules.push(`${rewritten.standard}{${outBody}${tail}`);
                if (rewritten.scrollbar) rules.push(`${rewritten.scrollbar}{${outBody}${tail}`);
                parts.push(rules.join('\n'));
                for (const host of rewritten.scrollbarHosts) scrollbarHosts.add(host);
            }
            i = end + 1;
            chunkStart = i;
            continue;
        }
        i++;
    }
    parts.push(src.slice(chunkStart));
    const out = parts.join('');
    if (!scrollbarHosts.size) return out;
    return `${[...scrollbarHosts].join(', ')} { ${SCROLLBAR_STANDARD_RESET} }\n${out}`;
}

// CSS.escape polyfill for attribute selector values — IE/older Safari don't
// expose it, and window/label names can contain hyphens/spaces/quotes a script
// writer might choose. Cheap identifier-only fallback when CSS.escape is gone.
export function cssEscape(s: string): string {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return s.replace(/["\\\n\r]/g, '\\$&');
}

// Mirrors Mudlet's Host::setBackgroundColor for labels: rather than treating
// setColor/setBackgroundColor as independent of setStyleSheet, Mudlet patches
// the `background-color` declaration directly into whatever stylesheet is
// already on the label (regex-replacing every occurrence — base rule and any
// pseudo-state rules alike — or appending one if none exists). So whichever
// of setStyleSheet/setBackgroundColor was called most recently wins for that
// one property, while the rest of the stylesheet (border, radius, ...) stays
// intact. Packages commonly rely on this ordering (e.g. EMCO's tab switcher
// calls setStyleSheet then setColor to tint an otherwise-styled tab).
export function patchStyleSheetBackgroundColor(styleSheet: string, r: number, g: number, b: number, a: number): string {
    const decl = `background-color: rgba(${r}, ${g}, ${b}, ${a});`;
    // `selection-background-color` ENDS in "background-color" without being one:
    // matching it patched the selection colour and left the real background
    // untouched. The leading group pins the property to a declaration boundary.
    // Mudlet's own pattern (Host.cpp) is `background-color:[^;]*;` — the
    // terminating `;` is required there too, so a `;`-less stylesheet can never
    // match and we can skip the scan outright. Without that guard the value scan
    // restarts at every `background-color:` and runs to end-of-string each time.
    if (styleSheet.includes(';')) {
        const existing = /(^|[^-\w])background-color\s*:[^;]*;/gi;
        let found = false;
        const patched = styleSheet.replace(existing, (_m, lead: string) => { found = true; return lead + decl; });
        if (found) return patched;
    }
    const sep = styleSheet && !styleSheet.endsWith('\n') ? '\n' : '';
    return styleSheet + sep + decl;
}

// Translate a flat declaration block into a CSS declaration string (Qt → CSS
// for values like QLinearGradient and unitless lengths). Used to serialize a
// scoped pseudo-state ruleset body for injection into a `<style>` element.
// `important` appends `!important` to every declaration: scoped pseudo-state
// rules (`QLabel::hover`) must beat the base block, which the label renders as
// INLINE style — without `!important` a hover rule can never override it (Qt
// resolves this by ordinary rule order within one stylesheet).
export function qtDeclarationsToCss(css: string, important = false): string {
    const out: string[] = [];
    const bang = important ? ' !important' : '';
    for (const { key, val } of applyBorderImageBlockTransform(parseQtDeclarations(css))) {
        if (key === 'qproperty-alignment') {
            for (const [k, v] of Object.entries(qtAlignmentToFlex(val))) {
                out.push(`${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}: ${v}${bang}`);
            }
            continue;
        }
        // Widget property applied to the background image at render, not a CSS
        // declaration — see extractQtScaledContents / declarationsToStyleWithMargin.
        if (key === 'qproperty-scaledcontents') continue;
        const [outKey, outVal] = translateDeclaration(key, val);
        out.push(`${outKey}: ${outVal}${bang}`);
    }
    return out.join('; ');
}

// ── Qt border-image ───────────────────────────────────────────────────────────
//
// Qt QSS `border-image: <url> [<cuts>{1,4}] [(stretch|repeat|round){1,2}]`
// slices the image into nine cells and — unlike CSS — always paints the middle
// cell. When the cut values are omitted, Qt slices by the widget's *border
// widths* declared alongside (EleUI2 pairs `border-top: 85px solid transparent`
// with `border-image: url(UI_Window.png)` so the frame's title bar and corners
// stay at their native thickness while the middle stretches). With neither cuts
// nor border widths the whole image stretches across the widget — the classic
// Mudlet "background that scales with the label" idiom.
//
// Reproducing that needs block-level context, so this pass runs over the whole
// parsed declaration list:
//   • cuts (explicit, else border widths) → CSS border-image-slice + `fill`
//     (CSS omits the middle cell by default) with the border widths as
//     border-image-width;
//   • all-zero cuts → a stretched CSS background;
//   • the real borders are folded away into padding: Qt insets the content by
//     border + padding, and Qt allows *negative* padding (EleUI2 pulls the
//     title text up into the frame's title bar with `padding-top: -95px`) which
//     CSS drops entirely. Emitting the combined inset as clamped padding keeps
//     the text where Qt puts it, and CSS border-image paints fine without real
//     borders since border-image-width is explicit.
// Qt's parser tolerates stray tokens (scripts write CSS-isms like `fill`);
// unknown tokens are skipped the same way.

interface QtDeclaration { key: string; val: string }

// Qt-only declarations that place a subcontrol inside its widget (`::add-line`
// at the bottom of a scrollbar, and so on). The browser's scrollbar parts sit
// where the browser puts them, so there's nothing to translate these into —
// dropping them just keeps the emitted CSS free of dead declarations.
const QT_ONLY_PROPS = new Set([
    'subcontrol-position',
    'subcontrol-origin',
    'show-decoration-selected',
]);

function parseQtDeclarations(css: string): QtDeclaration[] {
    const out: QtDeclaration[] = [];
    for (const decl of splitDeclarations(css)) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const key = decl.slice(0, i).trim().toLowerCase();
        const val = stripOuterQuotes(decl.slice(i + 1).trim());
        if (!key || !val || QT_ONLY_PROPS.has(key)) continue;
        out.push({ key, val });
    }
    return out;
}

// Margin-style shorthand expansion (1–4 values → top right bottom left).
function expandBoxShorthand(vals: number[]): [number, number, number, number] {
    const [t, r = t, b = t, l = r] = vals;
    return [t, r, b, l];
}

const SIDE_INDEX: Record<string, number> = { top: 0, right: 1, bottom: 2, left: 3 };

function parseLengths(val: string): number[] {
    const out: number[] = [];
    for (const tok of val.split(/\s+/)) {
        const m = tok.match(/^(-?\d+(?:\.\d+)?)(?:px)?$/);
        if (m) out.push(parseFloat(m[1]));
    }
    return out;
}

// Border declarations that this pass consumes when a border-image is present.
// Widths feed the slice grid; style/color are consumed too — Qt replaces the
// border painting with the image, and a leftover `border-style: solid` would
// otherwise paint a browser-default 3px border.
const BORDER_SIDE_RE = /^border-(top|right|bottom|left)$/;
const BORDER_SIDE_WIDTH_RE = /^border-(top|right|bottom|left)-width$/;
const BORDER_CONSUMED_RE = /^border(-(top|right|bottom|left))?(-(style|color))?$/;
const PADDING_SIDE_RE = /^padding-(top|right|bottom|left)$/;

function applyBorderImageBlockTransform(decls: QtDeclaration[]): QtDeclaration[] {
    let biIndex = -1;
    for (let i = decls.length - 1; i >= 0; i--) {
        if (decls[i].key === 'border-image' && /\burl\(/i.test(decls[i].val)) { biIndex = i; break; }
    }
    if (biIndex < 0) return decls;

    const widths: [number, number, number, number] = [0, 0, 0, 0];
    const pads: [number, number, number, number] = [0, 0, 0, 0];
    let sawBorder = false;
    let sawPadding = false;
    const consumed = new Set<number>();

    decls.forEach((d, i) => {
        let m: RegExpMatchArray | null;
        if (d.key === 'border' || d.key === 'border-width') {
            const nums = parseLengths(d.val);
            if (nums.length) {
                const ex = d.key === 'border' ? [nums[0]] : nums;
                const [t, r, b, l] = expandBoxShorthand(ex);
                widths[0] = t; widths[1] = r; widths[2] = b; widths[3] = l;
                sawBorder = true;
            }
            consumed.add(i);
        } else if ((m = d.key.match(BORDER_SIDE_RE)) || (m = d.key.match(BORDER_SIDE_WIDTH_RE))) {
            const nums = parseLengths(d.val);
            if (nums.length) { widths[SIDE_INDEX[m[1]]] = nums[0]; sawBorder = true; }
            consumed.add(i);
        } else if (BORDER_CONSUMED_RE.test(d.key)) {
            consumed.add(i);
        } else if (d.key === 'padding') {
            const nums = parseLengths(d.val);
            if (nums.length) {
                const [t, r, b, l] = expandBoxShorthand(nums);
                pads[0] = t; pads[1] = r; pads[2] = b; pads[3] = l;
                sawPadding = true;
            }
            consumed.add(i);
        } else if ((m = d.key.match(PADDING_SIDE_RE))) {
            const nums = parseLengths(d.val);
            if (nums.length) { pads[SIDE_INDEX[m[1]]] = nums[0]; sawPadding = true; }
            consumed.add(i);
        }
    });
    consumed.add(biIndex);

    const out = decls.filter((_, i) => !consumed.has(i));

    // Qt insets the label's content by border + padding per side (padding may
    // be negative); CSS padding can't go below zero, so clamp.
    if (sawBorder || sawPadding) {
        const sides = ['top', 'right', 'bottom', 'left'];
        sides.forEach((side, i) => {
            out.push({ key: `padding-${side}`, val: `${Math.max(0, widths[i] + pads[i])}px` });
        });
    }

    // Parse the border-image value itself: url, optional cuts, repeat keywords.
    const val = decls[biIndex].val;
    const urlMatch = val.match(/\burl\(\s*(?:"[^"]*"|'[^']*'|[^)]*?)\s*\)/i);
    if (!urlMatch || urlMatch.index === undefined) return decls; // unreachable — biIndex required url()
    const url = urlMatch[0];
    const rest = val.slice(0, urlMatch.index) + val.slice(urlMatch.index + url.length);
    const cuts: number[] = [];
    const repeats: string[] = [];
    for (const tok of rest.trim().split(/\s+/)) {
        if (!tok) continue;
        if (/^\d+(?:\.\d+)?(?:px)?$/.test(tok)) cuts.push(parseFloat(tok));
        else if (/^(stretch|repeat|round|space)$/i.test(tok)) repeats.push(tok.toLowerCase());
    }

    const slice = cuts.length ? expandBoxShorthand(cuts) : widths;
    if (slice.every(c => c === 0)) {
        out.push({ key: 'background-image', val: url });
        out.push({ key: 'background-size', val: '100% 100%' });
        out.push({ key: 'background-repeat', val: 'no-repeat' });
        out.push({ key: 'background-origin', val: 'border-box' });
        return out;
    }
    const gridWidths = widths.some(w => w !== 0) ? widths : slice;
    const repeat = repeats.length ? repeats.join(' ') : 'stretch';
    out.push({
        key: 'border-image',
        val: `${url} ${slice.join(' ')} fill / ${gridWidths.map(w => `${w}px`).join(' ')} ${repeat}`,
    });
    return out;
}

// Shared Qt→CSS rewrites that aren't structural (alignment is structural and
// handled at the call site so it can emit multiple declarations).
function translateDeclaration(key: string, val: string): [string, string] {
    if (/QLinearGradient\s*\(/i.test(val)) val = translateLinearGradient(val);
    val = normalizeRgbaAlpha(val);
    // Qt accepts a brush (incl. gradients) for `background-color`; CSS only
    // allows a solid <color> there. Rename to `background` so gradients paint.
    if (key === 'background-color' && /-gradient\s*\(/.test(val)) key = 'background';
    if (LENGTH_PROPS.has(key)) val = ensurePxUnits(val);
    return [key, val];
}

// Qt's `rgba()` takes an 8-bit alpha (0–255, matching QColor), but CSS's legacy
// `rgba()` expects the 4th argument in 0–1 (a value outside that range is
// clamped, so `rgba(0,0,0,200)` paints fully opaque instead of ~78%). Mudlet
// QSS overwhelmingly uses the Qt convention, so any alpha > 1 is almost
// certainly an 0–255 value that needs rescaling to 0–1. We leave a fractional
// alpha (already CSS-style) and an alpha of exactly 0 or 1 untouched — those are
// unambiguous and identical under both conventions. Applied to whole values so
// `rgba()` stops inside a translated `linear-gradient(...)` are rescaled too.
function normalizeRgbaAlpha(val: string): string {
    if (val.indexOf('rgba') < 0) return val;
    return val.replace(
        /\brgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d*\.?\d+)\s*\)/gi,
        (full, r, g, b, a) => {
            const alpha = parseFloat(a);
            if (alpha <= 1) return full;
            const scaled = Math.min(1, alpha / 255);
            // Trim to 4 decimals and drop trailing zeros for a tidy value.
            return `rgba(${r}, ${g}, ${b}, ${parseFloat(scaled.toFixed(4))})`;
        },
    );
}

// Qt scripts often quote values that CSS expects bare — `background-color:
// 'red'`, `qproperty-alignment: 'AlignLeft | AlignTop'`. Qt's QSS parser is
// lenient and unwraps the quotes; the browser drops the declaration entirely
// when it sees the quoted form for a non-string value. We strip matching outer
// quotes so the value lands as a real color/keyword. (Values that legitimately
// need quotes in CSS — font-family lists with spaces, `content` strings — are
// extremely rare in the QSS scripts we translate, so the conservative trade-off
// is to always strip rather than maintain a property allowlist.)
function stripOuterQuotes(val: string): string {
    if (val.length < 2) return val;
    const first = val[0];
    const last = val[val.length - 1];
    if ((first === "'" || first === '"') && first === last) {
        return val.slice(1, -1).trim();
    }
    return val;
}

// Translate a Qt `qproperty-alignment` value (`AlignLeft | AlignVCenter`, etc.)
// into the CSS that produces the same effect on the `.label` flex container.
//
// Every Mudlet label is rich text — `TLabel` forces `Qt::RichText` in its
// constructor — so Qt lays it out through a QTextDocument, and the two axes are
// handled quite differently (see QLabelPrivate in qlabel.cpp):
//
//   • Vertical: `layoutRect()` is the *only* place the alignment moves the
//     content, offsetting the text box down for AlignVCenter/AlignBottom. Our
//     `.label` is `display: flex; flex-direction: column`, so that maps to
//     `justify-content` on the main (vertical) axis.
//
//   • Horizontal: Qt feeds the alignment into the document's *default text
//     option* (`ensureTextLayouted`: `opt.setAlignment(align)`), i.e. it sets
//     the default block alignment — which inner HTML (`<center>`,
//     `align="left"`) overrides — while `doc->setTextWidth(documentRect()
//     .width())` keeps the document spanning the *full* content width. So it
//     maps to `text-align` (inherited by the echoed HTML, overridable
//     per-block), NOT to shrinking/pinning the box via `align-items`; the
//     inner div must stay stretched to full width for `<center>` to centre.
export function qtAlignmentToFlex(val: string): Record<string, string> {
    const flags = val.split('|').map(s => s.trim().toLowerCase());
    const has = (name: string) => flags.includes(name.toLowerCase());
    const out: Record<string, string> = {};

    // Vertical → main axis (column direction) via justify-content.
    if (has('AlignCenter') || has('AlignVCenter')) out.justifyContent = 'center';
    else if (has('AlignBottom')) out.justifyContent = 'flex-end';
    else if (has('AlignTop')) out.justifyContent = 'flex-start';

    // Horizontal → the document's default block alignment via text-align.
    if (has('AlignCenter') || has('AlignHCenter')) out.textAlign = 'center';
    else if (has('AlignRight')) out.textAlign = 'right';
    else if (has('AlignLeft')) out.textAlign = 'left';

    return out;
}

// Pull the value of a `qproperty-alignment` declaration out of a Qt stylesheet
// (base block or a `QLabel { … }` rule), quote-stripped like the QSS parser
// does — or undefined when none is present. Qt applies qproperty-* declarations
// as *widget properties*: they persist across a later setStyleSheet that omits
// them (unlike ordinary style, which is fully replaced). LabelManager captures
// this so a restyle that drops the alignment keeps the last one that was set —
// e.g. Adjustable.Container installs `AlignLeft | AlignTop`, then a theme like
// EleUI2 replaces the whole sheet without an alignment and the title stays
// top-aligned. Last declaration wins, mirroring Qt's in-order application.
export function extractQtAlignment(css: string): string | undefined {
    const blocks = css.indexOf('{') < 0
        ? [css]
        : splitRulesets(css)
            .filter(r => r.selector.trim() === '' || /^QLabel$/i.test(r.selector.trim()))
            .map(r => r.body);
    let found: string | undefined;
    for (const block of blocks) {
        for (const { key, val } of parseQtDeclarations(block)) {
            if (key === 'qproperty-alignment') found = val;
        }
    }
    return found;
}

// Pull the value of a `qproperty-scaledContents` declaration out of a Qt
// stylesheet (base block or a `QLabel { … }` rule) as a boolean — or undefined
// when none is present, so a restyle that omits it leaves the last value in
// place. Like qproperty-alignment, Qt applies qproperty-* as *widget
// properties* that persist across later stylesheets. When true, Qt's
// QLabel::setScaledContents scales the pixmap (setBackgroundImage) to fill the
// whole label instead of painting it at native size. Last declaration wins.
export function extractQtScaledContents(css: string): boolean | undefined {
    const blocks = css.indexOf('{') < 0
        ? [css]
        : splitRulesets(css)
            .filter(r => r.selector.trim() === '' || /^QLabel$/i.test(r.selector.trim()))
            .map(r => r.body);
    let found: boolean | undefined;
    for (const block of blocks) {
        for (const { key, val } of parseQtDeclarations(block)) {
            if (key === 'qproperty-scaledcontents') {
                const v = val.trim().toLowerCase();
                found = v === 'true' || v === '1';
            }
        }
    }
    return found;
}

// Pull out base-level declarations from a stylesheet that may also have
// selector rulesets. Used by cssTextToStyle for back-compat callers that don't
// care about scoped state rules.
function stripRulesetBraces(css: string): string {
    if (css.indexOf('{') < 0) return css;
    const inline: string[] = [];
    for (const rule of splitRulesets(css)) {
        if (rule.selector === '' || /^QLabel$/i.test(rule.selector.trim())) {
            inline.push(rule.body);
        }
    }
    return inline.join(';');
}

// Walk a stylesheet of the form `[base decls;] selector { decls; } selector { … }`.
// Returns each piece as { selector, body }. Base-level declarations come back
// with selector === ''. Brace-aware so nested `()` in values (e.g. gradients)
// don't get confused for ruleset boundaries.
function splitRulesets(css: string): Array<{ selector: string; body: string }> {
    const out: Array<{ selector: string; body: string }> = [];
    let i = 0;
    let chunkStart = 0;
    while (i < css.length) {
        const c = css[i];
        if (c === '(') {
            const close = matchingClose(css, i);
            if (close < 0) break;
            i = close + 1;
            continue;
        }
        if (c === '{') {
            const selector = css.slice(chunkStart, i);
            const close = matchingBrace(css, i);
            const end = close < 0 ? css.length : close;
            out.push({ selector, body: css.slice(i + 1, end) });
            i = end + 1;
            chunkStart = i;
            continue;
        }
        i++;
    }
    if (chunkStart < css.length) {
        const tail = css.slice(chunkStart).trim();
        if (tail) out.push({ selector: '', body: tail });
    }
    return out;
}

function matchingBrace(s: string, openIdx: number): number {
    let depth = 1;
    for (let i = openIdx + 1; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// Paren-aware split on `;` so semicolons inside e.g. QLinearGradient() don't
// terminate a declaration. (Qt's gradient syntax doesn't use semicolons today,
// but this keeps us safe if Qt-style nested function values ever do.)
function splitDeclarations(css: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ';' && depth === 0) {
            out.push(css.slice(start, i));
            start = i + 1;
        }
    }
    if (start < css.length) out.push(css.slice(start));
    return out;
}

// QLinearGradient(x1: a, y1: b, x2: c, y2: d, stop: 0 color1, stop: 0.5 color2, …)
//   → linear-gradient(<angle>deg, color1 0%, color2 50%, …)
//
// Qt and CSS share a y-down coordinate frame, but CSS angles are measured from
// the positive Y axis going clockwise (0deg = to top, 90deg = to right, 180deg
// = to bottom, 270deg = to left). The direction vector (dx, dy) maps to angle
// atan2(dx, -dy).
function translateLinearGradient(val: string): string {
    const start = val.search(/QLinearGradient\s*\(/i);
    if (start < 0) return val;
    const openIdx = val.indexOf('(', start);
    const closeIdx = matchingClose(val, openIdx);
    if (closeIdx < 0) return val;

    const inner = val.slice(openIdx + 1, closeIdx);
    const parts = splitTopLevel(inner, ',').map(s => s.trim()).filter(Boolean);

    const coords: Record<string, number> = {};
    const stops: Array<[number, string]> = [];
    for (const part of parts) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const key = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (key === 'stop') {
            const m = value.match(/^([\d.]+)\s+(.+)$/);
            if (m) stops.push([parseFloat(m[1]), m[2].trim()]);
        } else if (key === 'x1' || key === 'y1' || key === 'x2' || key === 'y2') {
            const n = parseFloat(value);
            if (!Number.isNaN(n)) coords[key] = n;
        }
    }

    if (stops.length === 0) return val;

    const dx = (coords.x2 ?? 0) - (coords.x1 ?? 0);
    const dy = (coords.y2 ?? 1) - (coords.y1 ?? 0);
    let angle = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
    if (angle < 0) angle += 360;

    const stopStrs = stops.map(([off, color]) => `${color} ${Math.round(off * 100)}%`);
    const replacement = `linear-gradient(${angle}deg, ${stopStrs.join(', ')})`;
    return val.slice(0, start) + replacement + val.slice(closeIdx + 1);
}

function matchingClose(s: string, openIdx: number): number {
    let depth = 1;
    for (let i = openIdx + 1; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === sep && depth === 0) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    if (start <= s.length) out.push(s.slice(start));
    return out;
}

// Add "px" to any pure numeric token (e.g. "1 solid black" → "1px solid black",
// "7" → "7px"). Tokens with an existing unit/percent/identifier are untouched.
function ensurePxUnits(val: string): string {
    return val
        .split(/(\s+)/)
        .map(tok => (/^-?\d+(?:\.\d+)?$/.test(tok) ? tok + 'px' : tok))
        .join('');
}
