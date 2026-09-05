// Issue #128 item 2: desktop's Editor option "Show Line/Paragraphs", the one
// row of that page mudix had no equivalent of. CodeMirror has no built-in for
// it — `highlightWhitespace()` covers spaces and tabs only — so it is a
// decoration, and this covers what it puts on screen.
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { showLineParagraphs } from '../../src/ui/codemirror/lineParagraphMarks';

let view: EditorView | null = null;

function mount(doc: string, withMarks = true): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({
        state: EditorState.create({ doc, extensions: withMarks ? showLineParagraphs() : [] }),
        parent,
    });
    return view;
}

const marks = (v: EditorView) =>
    [...v.dom.querySelectorAll('.cm-lineParagraphMark')].map(el => el.textContent);

afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = '';
});

describe('showLineParagraphs', () => {
    it('draws nothing when the extension is not mounted', () => {
        expect(marks(mount('one\ntwo', false))).toEqual([]);
    });

    it('marks every line end, and the end of the document differently', () => {
        // The last line has no line feed after it, so a pilcrow there would be
        // claiming a break that is not in the document.
        expect(marks(mount('one\ntwo\nthree'))).toEqual(['¶', '¶', '␄']);
    });

    it('marks a single-line document as the end of the text', () => {
        expect(marks(mount('one'))).toEqual(['␄']);
    });

    it('marks an empty document once', () => {
        expect(marks(mount(''))).toEqual(['␄']);
    });

    // A blank line between two others is exactly what the option is for: it is
    // invisible without a mark, and indistinguishable from a line of spaces.
    it('marks a blank line', () => {
        expect(marks(mount('one\n\ntwo'))).toEqual(['¶', '¶', '␄']);
    });

    it('follows an edit that adds a line', () => {
        const v = mount('one');
        expect(marks(v)).toEqual(['␄']);
        v.dispatch({ changes: { from: 3, insert: '\ntwo' } });
        expect(marks(v)).toEqual(['¶', '␄']);
    });

    // The marks are an annotation on the text, not text: they must never land
    // in a copy, and a screen reader must not read "pilcrow" at every line end.
    it('keeps its marks out of the document, the selection and the a11y tree', () => {
        const v = mount('one\ntwo');
        expect(v.state.doc.toString()).toBe('one\ntwo');
        const el = v.dom.querySelector('.cm-lineParagraphMark') as HTMLElement;
        expect(el.getAttribute('aria-hidden')).toBe('true');
    });
});
