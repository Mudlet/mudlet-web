/**
 * Mudlet's Editor option "Show Line/Paragraphs", as the checkbox is named:
 * a visible mark where each line of the script ends.
 *
 * Desktop currently under-delivers on its own label. `slot_changeShowLineFeeds\
 * AndParagraphs` (dlgProfilePreferences.cpp:4073) sets edbee's
 * `useLineSeparator`, which rules a faint horizontal line under each row, and
 * the method's comment says so: the marks the option is named for "may in the
 * future" arrive. The tooltip in `profile_preferences.ui:1746` still promises
 * them — "show line and paragraph ends with visible marks as well as
 * whitespace" — so that is what this draws, next to `highlightWhitespace()`'s
 * dots and arrows, which is where the tooltip puts it.
 *
 * CodeMirror has no built-in for this (`highlightWhitespace` covers spaces and
 * tabs only), so it is a decoration: a zero-width widget at every line end,
 * with the last line marked differently because it has no line feed after it.
 */

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

/** Pilcrow for a line that ends in a line feed; the last line of the document
 *  has none, so it gets the end-of-text mark instead. Both are drawn by the
 *  same widget class so a document edit that turns one into the other replaces
 *  the DOM node (`eq` compares the glyph). */
const PARAGRAPH_MARK = '¶';
const END_OF_TEXT_MARK = '␄';

class LineEndWidget extends WidgetType {
    constructor(private readonly mark: string) { super(); }

    override eq(other: LineEndWidget) { return other.mark === this.mark; }

    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-lineParagraphMark';
        span.textContent = this.mark;
        // The mark is an annotation on the text, not text: keeping it out of the
        // accessibility tree stops a screen reader reading "pilcrow" at the end
        // of every line, and `user-select: none` (below) keeps it out of a copy.
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    /** No editing position of its own — the caret walks past it to the next
     *  line, as it would with no widget there at all. */
    override ignoreEvent() { return false; }
}

const paragraphDeco = Decoration.widget({ widget: new LineEndWidget(PARAGRAPH_MARK), side: 1 });
const endOfTextDeco = Decoration.widget({ widget: new LineEndWidget(END_OF_TEXT_MARK), side: 1 });

/**
 * Marks only the lines in the viewport — a 10,000-line script would otherwise
 * build 10,000 widgets to show the twenty that are on screen.
 *
 * `viewport` rather than `visibleRanges`: the two agree for this editor (a
 * plain Lua document with nothing folded or replaced), and `visibleRanges` comes
 * back empty on an empty document, which would leave the end-of-text mark
 * missing until the first keystroke put it there.
 */
function marksFor(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const lastLine = view.state.doc.lines;
    const { from, to } = view.viewport;
    let pos = from;
    while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        builder.add(line.to, line.to, line.number === lastLine ? endOfTextDeco : paragraphDeco);
        pos = line.to + 1;
    }
    return builder.finish();
}

const markPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) { this.decorations = marksFor(view); }

    update(update: ViewUpdate) {
        // `viewportChanged` covers scrolling; `docChanged` covers a line being
        // split or joined, which moves every mark after it.
        if (update.docChanged || update.viewportChanged) {
            this.decorations = marksFor(update.view);
        }
    }
}, {
    decorations: v => v.decorations,
});

/** Dimmed like `highlightWhitespace`'s own dots, and unselectable so the marks
 *  never land in copied code. */
const markTheme = EditorView.baseTheme({
    '.cm-lineParagraphMark': {
        color: 'var(--text-dim, #888)',
        opacity: '0.55',
        userSelect: 'none',
        pointerEvents: 'none',
    },
});

/** The extension behind the "Show Line/Paragraphs" toggle. */
export function showLineParagraphs() {
    return [markPlugin, markTheme];
}
