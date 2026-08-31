import { describe, it, expect } from 'vitest';
import {
    cssTextToStyle,
    cssTextToParts,
    qtDeclarationsToCss,
    qtAlignmentToFlex,
    extractQtAlignment,
    extractQtScaledContents,
    extractQtWordWrap,
    userWindowQssToScopedCss,
    patchStyleSheetBackgroundColor,
    rewriteQtSelectors,
    QT_OBJECT_NAMES,
} from '../../src/ui/labels/qtCss';

// App/profile stylesheets: packages address Mudlet widgets by Qt objectName
// (`QWidget#widget_panel`) and themes style whole widget types (`QDockWidget`).
// Both parse as valid CSS but match nothing in the DOM, so they're redirected
// onto our `data-qt-object` hooks / mudix classes. Anything we don't recognise
// must pass through untouched — app stylesheets double as mudix's `.mudix-*`
// brand-styling surface.
describe('qtCss Qt selector rewrite', () => {
    it('redirects a Q<Type>#objectName selector onto the data-qt-object hook', () => {
        const out = rewriteQtSelectors('QWidget#widget_panel { padding: 0px; }');
        expect(out).toBe(':root:root [data-qt-object="widget_panel"] { padding: 0px }');
    });

    it('adds overflow clipping for a zero max-height collapse (Qt clips, CSS does not)', () => {
        // The real-world case: a package embedding the mapper in its own layout
        // collapses dlgMapper's control bar. Without overflow:hidden the DOM
        // keeps painting the overflowing buttons over the map.
        const out = rewriteQtSelectors(
            'QWidget#widget_panel { max-height: 0px; min-height: 0px; padding: 0px; border: none; }',
        );
        expect(out).toContain('[data-qt-object="widget_panel"]');
        expect(out).toContain('overflow: hidden');
        expect(out).toContain('max-height: 0px');
    });

    it('rewrites the bare #objectName form for names we publish, and only those', () => {
        // Qt's unitless `0` also picks up a unit on the way through.
        expect(rewriteQtSelectors(`#${QT_OBJECT_NAMES.mapperPanel} { padding: 0; }`))
            .toBe(':root:root [data-qt-object="widget_panel"] { padding: 0px }');
        // A genuine DOM id in a brand stylesheet must not be hijacked.
        expect(rewriteQtSelectors('#some-real-dom-id { padding: 0; }'))
            .toBe('#some-real-dom-id { padding: 0; }');
    });

    it('carries pseudo-states and compound selectors through the rewrite', () => {
        expect(rewriteQtSelectors('QToolButton#toolButton_mapperMenu:hover { color: red; }'))
            .toBe(':root:root [data-qt-object="toolButton_mapperMenu"]:hover { color: red }');
        expect(rewriteQtSelectors('QWidget#widget_panel, QToolButton#toolButton_togglePanel { padding: 0px; }'))
            .toBe(':root:root [data-qt-object="widget_panel"], :root:root [data-qt-object="toolButton_togglePanel"] { padding: 0px }');
    });

    it('maps QDockWidget (Mudlet user windows) onto both floating and docked chrome', () => {
        expect(rewriteQtSelectors('QDockWidget { background: #26192f; }'))
            .toBe(':root:root .script-window, :root:root .docked-panel { background: #26192f }');
        // Subcontrols land on the DOM node playing that part…
        expect(rewriteQtSelectors('QDockWidget::title { padding: 4px; }'))
            .toBe(':root:root .script-window-titlebar, :root:root .docked-panel-titlebar { padding: 4px }');
        // …and Qt pseudo-states distribute across every expansion, with
        // Qt-only spellings translated (`:pressed` → `:active`).
        expect(rewriteQtSelectors('QDockWidget:hover { color: red; }'))
            .toBe(':root:root .script-window:hover, :root:root .docked-panel:hover { color: red }');
        expect(rewriteQtSelectors('QDockWidget::close-button:pressed { color: red; }'))
            .toBe(':root:root .script-window-btn.close:active { color: red }');
    });

    it('translates Qt-only declaration values in rules it rewrote', () => {
        // Qt's rgba() alpha is 0–255; CSS wants 0–1.
        expect(rewriteQtSelectors('QDockWidget { background-color: rgba(20,20,20,230); }'))
            .toContain('rgba(20, 20, 20, 0.902)');
        // Unitless lengths are legal in Qt, not in CSS.
        expect(rewriteQtSelectors('QDockWidget { border-radius: 5; }'))
            .toContain('border-radius: 5px');
    });

    it('leaves an unmapped Qt widget type alone rather than guessing', () => {
        // mudix has no status bar, so the rule stays inert rather than landing
        // on whichever surface looks vaguely similar.
        expect(rewriteQtSelectors('QStatusBar { background: #b8731b; }'))
            .toBe('QStatusBar { background: #b8731b; }');
        expect(rewriteQtSelectors('QCalendarWidget::item { color: red; }'))
            .toBe('QCalendarWidget::item { color: red; }');
    });

    it('maps the widget types a pasted Mudlet theme actually uses', () => {
        expect(rewriteQtSelectors('QMainWindow { background: #26192f; }'))
            .toBe(':root:root .app { background: #26192f }');
        // Toolbar buttons are QToolButtons in Mudlet, dialog buttons are
        // QPushButtons — the descendant form keeps them apart the way Qt's
        // widget tree does.
        expect(rewriteQtSelectors('QToolButton:hover { background-color: grey; }'))
            .toBe(':root:root .mudix-toolbar .btn:hover, :root:root .mudix-btn:hover, '
                + ':root:root .toolbar-hamburger-btn:hover, '
                + ':root:root .map-panel-toolbar .btn:hover { background-color: grey }');
        expect(rewriteQtSelectors('QTreeView { color: white; }'))
            .toBe(':root:root .script-editor__items, :root:root .vfs-tree { color: white }');
        // A tab's `:selected` has no CSS pseudo — it's a modifier class.
        expect(rewriteQtSelectors('QTabBar::tab:top:selected { color: red; }'))
            .toBe(':root:root .tab-group-tab--active, :root:root .mobile-switcher__tab--active { color: red }');
        // …and `:top` is dropped rather than dropping the rule: mudix's tab bar
        // is always on top, so the state carries no information.
        expect(rewriteQtSelectors('QTabBar::tab:top { color: red; }'))
            .toBe(':root:root .tab-group-tab, :root:root .mobile-switcher__tab { color: red }');
    });

    it('drops a rule whose state would otherwise widen it', () => {
        // `:selected` on a list has no modifier class to hang off. Applying it
        // to every row would be worse than leaving the rule inert.
        expect(rewriteQtSelectors('QListView::item:selected { color: red; }'))
            .toBe('QListView::item:selected { color: red; }');
        expect(rewriteQtSelectors('QTreeView::item:has-children { color: red; }'))
            .toBe('QTreeView::item:has-children { color: red; }');
    });

    it('gives QWidget the meaning it has in Qt — every widget', () => {
        // A Qt type selector matches the class *and its subclasses*, and
        // QWidget is the root of the hierarchy, so themes use it for a base
        // coat. The union is computed from the type table.
        const out = rewriteQtSelectors('QWidget { background: #26192f; color: white; }');
        expect(out).toContain(':root:root .app,');
        expect(out).toContain(':root:root .mudix-toolbar,');
        expect(out).toContain(':root:root .script-window,');
        expect(out).toContain(':root:root .command-bar');
        expect(out).toContain('background: #26192f; color: white');
        // The game text area paints itself in Mudlet, so a blanket rule never
        // reached it there — and mustn't repaint the MUD output here.
        expect(out).not.toContain('.output-wrapper');
        // Scrollbars are pseudo-elements, not elements; a blanket border would
        // wreck them, and they'd take the whole selector list down with them in
        // a browser that doesn't know `::-webkit-scrollbar`.
        expect(out).not.toContain('scrollbar');
    });

    it('maps QScrollBar onto the WebKit scrollbar pseudo-elements', () => {
        const rules = (qss: string) => rewriteQtSelectors(qss).trim().split('\n');
        // No `:root:root` boost here: it would put a descendant combinator in
        // front of the pseudo-element, and Chromium then stops matching
        // `:vertical`. The `:not()` pair already carries the specificity needed
        // to outrank mudix's own per-element scrollbar CSS.
        const HOST = ':not(.mudix-native-scrollbar):not(.mudix-no-scrollbar)';
        // Chromium ignores the ::-webkit-scrollbar family entirely once the
        // standard scrollbar-width/-color are set — and App.css sets both
        // globally — so a themed scrollbar needs them switched off first.
        expect(rules('QScrollBar:vertical { width: 15px; }')).toEqual([
            `${HOST} { scrollbar-width: auto; scrollbar-color: auto }`,
            `${HOST}::-webkit-scrollbar:vertical { width: 15px }`,
        ]);
        expect(rules('QScrollBar::handle:vertical { background: white; }')[1])
            .toBe(`${HOST}::-webkit-scrollbar-thumb:vertical { background: white }`);
        // Qt's subcontrol positioning has no DOM analogue and is dropped.
        expect(rules('QScrollBar::add-line { subcontrol-position: bottom; height: 15px; }')[1])
            .toBe(`${HOST}::-webkit-scrollbar-button:increment { height: 15px }`);
        // Two Qt subcontrols, one DOM stand-in — emitted once.
        expect(rules('QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: none; }')[1])
            .toBe(`${HOST}::-webkit-scrollbar-track-piece:vertical { background: none }`);
        // A sheet that says nothing about scrollbars leaves mudix's own alone.
        expect(rewriteQtSelectors('QDockWidget { background: #111; }'))
            .not.toContain('scrollbar-width');
    });

    it('scopes a scrollbar rule to a Mudlet widget the way the wiki recipe does', () => {
        // `TConsole QScrollBar:vertical` is how Mudlet's docs tell people to
        // theme only the game area's scrollbar. It resolves to the console's
        // *scroller* as a single compound — `.output-container ::-webkit-…` would
        // put a combinator in front of the pseudo-element and Chromium would stop
        // matching `:vertical` entirely.
        const scroller = '.output-wrapper:not(.mudix-native-scrollbar):not(.mudix-no-scrollbar)';
        expect(rewriteQtSelectors('TConsole QScrollBar:vertical { width: 15px; }').trim().split('\n')).toEqual([
            `${scroller} { scrollbar-width: auto; scrollbar-color: auto }`,
            `${scroller}::-webkit-scrollbar:vertical { width: 15px }`,
        ]);
        // A widget with no scroller of its own can't host a scoped rule, and it
        // stays inert rather than widening to every scrollbar in the app.
        expect(rewriteQtSelectors('QMenu QScrollBar:vertical { width: 15px; }'))
            .toBe('QMenu QScrollBar:vertical { width: 15px; }');
    });

    it('keeps scrollbar pseudo-elements out of an ordinary selector list', () => {
        // One unknown selector invalidates an entire CSS selector list, so a
        // rule naming both kinds has to become two rules.
        const lines = rewriteQtSelectors('QDockWidget, QScrollBar { background: #111; }').trim().split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[1]).toBe(':root:root .script-window, :root:root .docked-panel { background: #111 }');
        expect(lines[2]).toBe(':not(.mudix-native-scrollbar):not(.mudix-no-scrollbar)'
            + '::-webkit-scrollbar { background: #111 }');
    });

    it('outranks mudix\'s own CSS for the elements it lands on', () => {
        // Landing on the right element isn't enough — mudix's own rules often
        // carry more specificity than the class the table maps to. The boost is
        // specificity, not !important: inline style (how a widget's own
        // stylesheet is applied) still wins, exactly as in Qt.
        expect(rewriteQtSelectors('QToolButton { color: red; }'))
            .toContain(':root:root .mudix-btn');
        expect(rewriteQtSelectors('QToolButton { color: red; }'))
            .not.toContain('!important');
    });

    it('leaves CSS with no Qt selector byte-identical', () => {
        const css = '.mudix-toolbar { background: #222; }\n.mudix-output a:hover { color: #8cf; }';
        expect(rewriteQtSelectors(css)).toBe(css);
        // Untouched rules keep their own semantics — no overflow fix-up.
        const zero = '.mudix-thing { max-height: 0px; }';
        expect(rewriteQtSelectors(zero)).toBe(zero);
        expect(rewriteQtSelectors('')).toBe('');
    });

    it('does not mistake a # inside a declaration value for a selector', () => {
        expect(rewriteQtSelectors('QWidget#widget_panel { background: #26192f; color: #e5ae69; }'))
            .toBe(':root:root [data-qt-object="widget_panel"] { background: #26192f; color: #e5ae69 }');
    });

    it('strips comments, which real Mudlet themes are full of', () => {
        // A commented-out declaration must not survive as a broken one — the
        // declaration splitter would otherwise emit `/*font-size: 13px` verbatim.
        const out = rewriteQtSelectors('QDockWidget { /*font-size: 13px;*/ color: #e5ae69; }');
        expect(out).not.toContain('font-size');
        expect(out).toContain('color: #e5ae69');
    });
});

describe('qtCss rgba alpha normalization', () => {
    it('rescales Qt 0–255 alpha to CSS 0–1 on a solid background-color', () => {
        // background-color stays `background` only for gradients; a flat color
        // keeps its key but the alpha must be rescaled (200/255 ≈ 0.7843).
        const style = cssTextToStyle('background-color: rgba(0,0,0,200)') as Record<string, string>;
        expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0.7843)');
    });

    it('rescales alpha on border-color (Qt convention)', () => {
        const style = cssTextToStyle('border-color: rgba(0,0,0,140)') as Record<string, string>;
        expect(style.borderColor).toBe('rgba(0, 0, 0, 0.549)');
    });

    it('leaves a CSS-style fractional alpha untouched', () => {
        const style = cssTextToStyle('background-color: rgba(10,20,30,0.5)') as Record<string, string>;
        expect(style.backgroundColor).toBe('rgba(10,20,30,0.5)');
    });

    it('leaves alpha 0 (fully transparent) and 1 untouched', () => {
        expect((cssTextToStyle('background-color: rgba(1,2,3,0)') as Record<string, string>).backgroundColor)
            .toBe('rgba(1,2,3,0)');
        expect((cssTextToStyle('background-color: rgba(1,2,3,1)') as Record<string, string>).backgroundColor)
            .toBe('rgba(1,2,3,1)');
    });

    it('rescales alpha inside a translated linear gradient (MS-GUI gauge front)', () => {
        const qss = 'background-color: QLinearGradient(x1: 0, y1: 0, x2: 0, y2: 1,'
            + 'stop:0 rgba(160,240,250,180), stop:1 rgba(60,180,210,180))';
        const style = cssTextToStyle(qss) as Record<string, string>;
        // Gradient → CSS `background`; both stops rescaled (180/255 ≈ 0.7059).
        expect(style.background).toContain('linear-gradient');
        expect(style.background).toContain('rgba(160, 240, 250, 0.7059)');
        expect(style.background).toContain('rgba(60, 180, 210, 0.7059)');
        expect(style.background).not.toContain(',180)');
    });

    it('preserves a fully-transparent stop in a gradient (MS-GUI food gauge back)', () => {
        const qss = 'background-color: QLinearGradient(x1: 0, y1: 0, x2: 1, y2: 0,'
            + 'stop:0 rgba(250,250,250,0), stop:.5 rgba(250,250,250,80))';
        const style = cssTextToStyle(qss) as Record<string, string>;
        expect(style.background).toContain('rgba(250,250,250,0)');
        expect(style.background).toContain('rgba(250, 250, 250, 0.3137)'); // 80/255
    });

    it('rescales alpha in scoped pseudo-state declarations too', () => {
        const css = qtDeclarationsToCss('background-color: rgba(255,0,0,128)');
        expect(css).toBe('background-color: rgba(255, 0, 0, 0.502)');
    });

    it('rescales alpha through the userwindow QSS path', () => {
        const out = userWindowQssToScopedCss('QWidget { background-color: rgba(20,20,20,230) }', '.scope');
        expect(out).toContain('rgba(20, 20, 20, 0.902)');
    });

    it('handles cssTextToParts inline declarations', () => {
        const { inline } = cssTextToParts('background-color: rgba(0,0,0,200); color: white');
        expect((inline as Record<string, string>).backgroundColor).toBe('rgba(0, 0, 0, 0.7843)');
    });
});

describe('qtCss Qt border-image translation', () => {
    // Qt (and Mudlet packages) use `border-image: url(x)` with no cuts as a
    // "background that scales with the widget" idiom — EleUI2 paints all its
    // window chrome this way. CSS border-image with no slice paints nothing.
    it('translates the no-cut form to a stretched background', () => {
        const style = cssTextToStyle(
            'border-image: url(/__vfs/abc/EleUI2/imgs/UI_BG.png) round',
        ) as Record<string, string>;
        expect(style.backgroundImage).toBe('url(/__vfs/abc/EleUI2/imgs/UI_BG.png)');
        expect(style.backgroundSize).toBe('100% 100%');
        expect(style.backgroundRepeat).toBe('no-repeat');
        expect(style.backgroundOrigin).toBe('border-box');
        expect(style.borderImage).toBeUndefined();
    });

    it('skips stray tokens the way Qt does (EleUI2 writes a CSS-ism "fill")', () => {
        const style = cssTextToStyle(
            'border-image: url(/__vfs/abc/imgs/UI_Window.png) fill',
        ) as Record<string, string>;
        expect(style.backgroundImage).toBe('url(/__vfs/abc/imgs/UI_Window.png)');
        expect(style.backgroundSize).toBe('100% 100%');
    });

    it('translates explicit cuts to a CSS 9-slice border-image with fill', () => {
        const style = cssTextToStyle(
            'border-image: url(frame.png) 4 8 4 8 stretch stretch',
        ) as Record<string, string>;
        expect(style.borderImage).toBe('url(frame.png) 4 8 4 8 fill / 4px 8px 4px 8px stretch stretch');
        expect(style.backgroundImage).toBeUndefined();
    });

    it('expands a single cut value margin-style and defaults repeat to stretch', () => {
        const style = cssTextToStyle('border-image: url(frame.png) 6') as Record<string, string>;
        expect(style.borderImage).toBe('url(frame.png) 6 6 6 6 fill / 6px 6px 6px 6px stretch');
    });

    it('all-zero cuts behave like the no-cut stretch idiom', () => {
        const style = cssTextToStyle('border-image: url(bg.png) 0 0 0 0') as Record<string, string>;
        expect(style.backgroundImage).toBe('url(bg.png)');
        expect(style.backgroundSize).toBe('100% 100%');
    });

    it('passes a border-image without a url() through untouched', () => {
        const style = cssTextToStyle('border-image: none') as Record<string, string>;
        expect(style.borderImage).toBe('none');
    });

    it('translates inside scoped pseudo-state declarations (qtDeclarationsToCss)', () => {
        const css = qtDeclarationsToCss('border-image: url(hover.png)');
        expect(css).toContain('background-image: url(hover.png)');
        expect(css).toContain('background-size: 100% 100%');
    });

    it('slices by the border widths declared in the same block (EleUI2 window frame)', () => {
        // The real stylesheet EleUI2 puts on Adjustable.Container's adjLabel:
        // Qt slices the frame image by the border widths so the title bar and
        // corners keep their native thickness, and the negative padding pulls
        // the title text up into the frame's title-bar zone.
        const { inline } = cssTextToParts(
            'border-top: 85px solid transparent;border-bottom:50px;border-left:115px;'
            + 'border-right:115px;border-image: url(/__vfs/abc/EleUI2/imgs/UI_Window.png) fill;'
            + 'padding-top:-95px;',
        );
        const style = inline as Record<string, string>;
        expect(style.borderImage).toBe(
            'url(/__vfs/abc/EleUI2/imgs/UI_Window.png) 85 115 50 115 fill / 85px 115px 50px 115px stretch',
        );
        expect(style.backgroundImage).toBeUndefined();
        // Real borders are folded into content-inset padding; the negative
        // Qt padding is combined and clamped (85 − 95 → 0).
        expect(style.borderTop).toBeUndefined();
        expect(style.paddingTop).toBe('0px');
        expect(style.paddingRight).toBe('115px');
        expect(style.paddingBottom).toBe('50px');
        expect(style.paddingLeft).toBe('115px');
    });

    it('handles the EleUI2 config-frame style (uniform border, round repeat)', () => {
        const { inline } = cssTextToParts(
            'border: 25px solid transparent;border-image: url(/__vfs/abc/EleUI2/imgs/UI_BG.png) round;'
            + 'padding-top:-20px;',
        );
        const style = inline as Record<string, string>;
        expect(style.borderImage).toBe(
            'url(/__vfs/abc/EleUI2/imgs/UI_BG.png) 25 25 25 25 fill / 25px 25px 25px 25px round',
        );
        expect(style.paddingTop).toBe('5px'); // 25 − 20
        expect(style.paddingRight).toBe('25px');
    });

    it('consumes a bare border-style so no phantom browser border paints', () => {
        const { inline } = cssTextToParts(
            'border-style: solid; border-image: url(bg.png)',
        );
        const style = inline as Record<string, string>;
        expect(style.borderStyle).toBeUndefined();
        expect(style.backgroundImage).toBe('url(bg.png)');
    });

    it('leaves border declarations alone when there is no border-image', () => {
        const { inline } = cssTextToParts('border: 2px solid red; padding-top: -5px');
        const style = inline as Record<string, string>;
        expect(style.border).toBe('2px solid red');
        expect(style.paddingTop).toBe('-5px'); // dropped by the browser, as before
    });

    it('marks scoped pseudo-state declarations !important so they beat the inline base', () => {
        // EleUI2's config rows: base block paints a transparent background as
        // inline style; the ::hover rule adds the FF7 finger cursor image and
        // must override it.
        const css = qtDeclarationsToCss(
            'background-image : url("/__vfs/abc/EleUI2/imgs/FF7Cursor.png"); background-repeat:no-repeat;'
            + 'background-position:left center;',
            true,
        );
        expect(css).toContain('background-image: url("/__vfs/abc/EleUI2/imgs/FF7Cursor.png") !important');
        expect(css).toContain('background-repeat: no-repeat !important');
        expect(css).toContain('background-position: left center !important');
    });
});

describe('patchStyleSheetBackgroundColor', () => {
    it('replaces an existing background-color declaration in place, keeping the rest of the rule', () => {
        // EleUI2's EMCO tab switcher: setStyleSheet(activeTabCSS) paints a dark
        // red background with a gold border, then setColor(activeTabBGColor)
        // (green by default) is expected to retint just the background — as
        // real Mudlet's Host::setBackgroundColor does via an in-place regex
        // patch — not get silently dropped in favor of the stylesheet.
        const css = [
            'QLabel{',
            'background-color: #4d0000;',
            'border-style: outset;',
            'border-color: "#996600";',
            '}',
        ].join('\n');
        const patched = patchStyleSheetBackgroundColor(css, 0, 180, 0, 255);
        expect(patched).toContain('background-color: rgba(0, 180, 0, 255);');
        expect(patched).not.toContain('#4d0000');
        expect(patched).toContain('border-style: outset;');
        expect(patched).toContain('border-color: "#996600";');
    });

    it('patches every occurrence, including pseudo-state rules', () => {
        const css = 'QLabel{background-color: #4d0000;} QLabel::hover{background-color: #b30000;}';
        const patched = patchStyleSheetBackgroundColor(css, 0, 180, 0, 255);
        const matches = patched.match(/background-color: rgba\(0, 180, 0, 255\);/g) ?? [];
        expect(matches.length).toBe(2);
    });

    it('appends the declaration when the stylesheet has no background-color', () => {
        const patched = patchStyleSheetBackgroundColor('border-style: outset;', 10, 20, 30, 255);
        expect(patched).toBe('border-style: outset;\nbackground-color: rgba(10, 20, 30, 255);');
    });

    it('appends onto an empty stylesheet', () => {
        expect(patchStyleSheetBackgroundColor('', 1, 2, 3, 255)).toBe('background-color: rgba(1, 2, 3, 255);');
    });
});

describe('qtAlignmentToFlex', () => {
    // Mudlet labels are always rich text, so Qt maps the vertical flag to a box
    // offset (→ justify-content) and the horizontal flag to the document's
    // default block alignment (→ text-align, overridable by inner <center>).
    it('maps vertical flags to justify-content on the column axis', () => {
        expect(qtAlignmentToFlex('AlignTop')).toEqual({ justifyContent: 'flex-start' });
        expect(qtAlignmentToFlex('AlignVCenter')).toEqual({ justifyContent: 'center' });
        expect(qtAlignmentToFlex('AlignBottom')).toEqual({ justifyContent: 'flex-end' });
    });

    it('maps horizontal flags to text-align, never to align-items (keeps the doc full-width)', () => {
        expect(qtAlignmentToFlex('AlignLeft')).toEqual({ textAlign: 'left' });
        expect(qtAlignmentToFlex('AlignHCenter')).toEqual({ textAlign: 'center' });
        expect(qtAlignmentToFlex('AlignRight')).toEqual({ textAlign: 'right' });
        // No align-items in any output — an explicit horizontal anchor must not
        // shrink the inner div, or an inner <center> could no longer centre.
        for (const v of ['AlignLeft', 'AlignRight', 'AlignHCenter', 'AlignCenter']) {
            expect(qtAlignmentToFlex(v).alignItems).toBeUndefined();
        }
    });

    it('handles the combined AlignLeft | AlignTop and AlignCenter forms', () => {
        expect(qtAlignmentToFlex('AlignLeft | AlignTop')).toEqual({
            justifyContent: 'flex-start', textAlign: 'left',
        });
        // AlignCenter is HCenter | VCenter.
        expect(qtAlignmentToFlex('AlignCenter')).toEqual({
            justifyContent: 'center', textAlign: 'center',
        });
    });
});

describe('extractQtAlignment', () => {
    it('reads a quote-stripped value from a base-block declaration', () => {
        expect(extractQtAlignment("border: 0; qproperty-alignment: 'AlignLeft | AlignTop';"))
            .toBe('AlignLeft | AlignTop');
    });

    it('reads it from a QLabel { … } ruleset', () => {
        expect(extractQtAlignment('QLabel { qproperty-alignment: AlignCenter; }'))
            .toBe('AlignCenter');
    });

    it('returns undefined when the stylesheet has no alignment', () => {
        expect(extractQtAlignment('border-image: url(bg.png); padding-top: -95px;'))
            .toBeUndefined();
    });

    it('takes the last declaration when several are present (Qt in-order)', () => {
        expect(extractQtAlignment('qproperty-alignment: AlignTop; qproperty-alignment: AlignBottom;'))
            .toBe('AlignBottom');
    });
});

describe('extractQtScaledContents', () => {
    it('reads true from a base-block declaration', () => {
        expect(extractQtScaledContents('padding: 6px; qproperty-scaledContents: true;')).toBe(true);
    });

    it('reads it from a QLabel { … } ruleset', () => {
        expect(extractQtScaledContents('QLabel { qproperty-scaledContents: true; }')).toBe(true);
    });

    it('reads false explicitly', () => {
        expect(extractQtScaledContents('qproperty-scaledContents: false;')).toBe(false);
    });

    it('accepts the quoted / 1 / 0 forms', () => {
        expect(extractQtScaledContents("qproperty-scaledContents: 'true';")).toBe(true);
        expect(extractQtScaledContents('qproperty-scaledContents: 1;')).toBe(true);
        expect(extractQtScaledContents('qproperty-scaledContents: 0;')).toBe(false);
    });

    it('returns undefined when the stylesheet has no scaledContents', () => {
        expect(extractQtScaledContents('border: 0; padding: 6px;')).toBeUndefined();
    });

    it('takes the last declaration when several are present (Qt in-order)', () => {
        expect(extractQtScaledContents('qproperty-scaledContents: true; qproperty-scaledContents: false;'))
            .toBe(false);
    });

    it('is not emitted as a stray CSS property on the inline style', () => {
        const style = cssTextToStyle('padding: 6px; qproperty-scaledContents: true;') as Record<string, string>;
        expect(style.qpropertyScaledContents).toBeUndefined();
        expect(style.padding).toBe('6px');
    });
});

// QLabel::wordWrap is off by default (and TLabel never sets it), which is why
// Mudlet clips over-long label text at the widget edge instead of folding it
// onto a second line. `qproperty-wordWrap: true` is the only way a stylesheet
// asks for the other behaviour, and LabelOverlay renders it as white-space.
describe('extractQtWordWrap', () => {
    it('reads true from a base-block declaration', () => {
        expect(extractQtWordWrap('padding-left: 10px; qproperty-wordWrap: true;')).toBe(true);
    });

    it('reads it from a QLabel { … } ruleset', () => {
        expect(extractQtWordWrap('QLabel { qproperty-wordWrap: true; }')).toBe(true);
    });

    it('accepts the quoted / 1 / 0 forms', () => {
        expect(extractQtWordWrap("qproperty-wordWrap: 'true';")).toBe(true);
        expect(extractQtWordWrap('qproperty-wordWrap: 1;')).toBe(true);
        expect(extractQtWordWrap('qproperty-wordWrap: 0;')).toBe(false);
    });

    it('returns undefined when the stylesheet has no wordWrap', () => {
        expect(extractQtWordWrap('border: 0; padding: 6px;')).toBeUndefined();
    });

    it('takes the last declaration when several are present (Qt in-order)', () => {
        expect(extractQtWordWrap('qproperty-wordWrap: true; qproperty-wordWrap: false;'))
            .toBe(false);
    });

    it('is not emitted as a stray CSS property on the inline style or a scoped rule', () => {
        const style = cssTextToStyle('padding: 6px; qproperty-wordWrap: true;') as Record<string, string>;
        expect(style.qpropertyWordWrap).toBeUndefined();
        expect(style.padding).toBe('6px');
        expect(qtDeclarationsToCss('padding: 6px; qproperty-wordWrap: true;'))
            .toBe('padding: 6px');
    });
});

// Qt leaves an unnamed border brush unset and paints nothing; CSS falls back to
// `currentColor` and paints one in the label's text colour. StickMUD's GUI
// declares style+width with no colour on its training tabs and font-size
// buttons, which Mudlet renders flat and we drew as a white 1px box.
describe('qtCss Qt border-color default', () => {
    it('makes a border with no colour transparent (StickMUD training tabs)', () => {
        const style = cssTextToStyle(
            'background-color: rgba(0,0,0,255); border-style: solid;'
            + ' border-width: 1px; text-align: center;',
        ) as Record<string, string>;
        expect(style.borderColor).toBe('transparent');
        // The border still occupies its width, exactly as it does in Qt.
        expect(style.borderWidth).toBe('1px');
        expect(style.borderStyle).toBe('solid');
    });

    it('leaves an explicitly coloured border alone', () => {
        const style = cssTextToStyle(
            'border-style: solid; border-color: #31363b; border-width: 1px;',
        ) as Record<string, string>;
        expect(style.borderColor).toBe('#31363b');
    });

    it('leaves a shorthand that carries its own colour alone', () => {
        const style = cssTextToStyle('border: 1px solid #32323f;') as Record<string, string>;
        expect(style.borderColor).toBeUndefined();
        expect(style.border).toBe('1px solid #32323f');
    });

    it('defaults a shorthand that omits the colour', () => {
        const style = cssTextToStyle('border: 1px solid;') as Record<string, string>;
        expect(style.borderColor).toBe('transparent');
    });

    it('recognises a named colour in the shorthand', () => {
        const style = cssTextToStyle('border: 2px dashed red;') as Record<string, string>;
        expect(style.borderColor).toBeUndefined();
    });

    it('recognises a functional colour in the shorthand', () => {
        const style = cssTextToStyle(
            'border: 2px solid rgba(80, 80, 90, 255);',
        ) as Record<string, string>;
        expect(style.borderColor).toBeUndefined();
    });

    it('leaves a block with no painting border style untouched', () => {
        // `border-width` alone paints nothing in CSS or Qt — style defaults to
        // `none` in both — so there is nothing to defuse.
        const style = cssTextToStyle('border-width: 1px;') as Record<string, string>;
        expect(style.borderColor).toBeUndefined();
    });

    it('leaves `border: none` untouched', () => {
        const style = cssTextToStyle('border: none;') as Record<string, string>;
        expect(style.borderColor).toBeUndefined();
    });

    it('defuses the border in a scoped pseudo-state rule too', () => {
        const css = qtDeclarationsToCss('border-style: solid; border-width: 1px;');
        expect(css).toContain('border-color: transparent');
    });

    it('does not touch a border-image block, whose borders are consumed', () => {
        const style = cssTextToStyle(
            'border-top: 85px solid transparent; border-image: url(frame.png) fill;',
        ) as Record<string, string>;
        expect(style.borderColor).toBeUndefined();
    });
});
