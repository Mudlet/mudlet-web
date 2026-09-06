// The Editor preference page's display options are shared by every CodeMirror
// surface in the app — the script editor, the file browser's editor, its JSON
// viewer — so they live in one module the three build from. This covers what
// that module puts in the editor, including the one thing that is *not*
// uniform: Lua completion, which only a Lua document gets.
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { startCompletion } from '@codemirror/autocomplete';
import { EDITOR_OPTION_DEFAULTS, optionExtensions, type EditorOptions } from '../../src/ui/codemirror/options';

let view: EditorView | null = null;

function mount(patch: Partial<EditorOptions>, lua: boolean, doc = 'a  b\tc'): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const opts: EditorOptions = { ...EDITOR_OPTION_DEFAULTS, ...patch };
    view = new EditorView({
        state: EditorState.create({ doc, extensions: optionExtensions(opts, lua) }),
        parent,
    });
    return view;
}

afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = '';
});

describe('editor display options', () => {
    it('marks spaces and tabs only when Show Spaces/Tabs is on', () => {
        expect(mount({ showWhitespace: false }, false).dom.querySelectorAll('.cm-highlightSpace').length).toBe(0);
        view!.destroy();
        expect(mount({ showWhitespace: true }, false).dom.querySelectorAll('.cm-highlightSpace').length).toBeGreaterThan(0);
    });

    it('marks line ends only when Show Line/Paragraphs is on', () => {
        expect(mount({ showLineParagraphs: false }, false, 'one\ntwo').dom.querySelectorAll('.cm-lineParagraphMark').length).toBe(0);
        view!.destroy();
        expect(mount({ showLineParagraphs: true }, false, 'one\ntwo').dom.querySelectorAll('.cm-lineParagraphMark').length).toBeGreaterThan(0);
    });

    it('offers Lua completion in a Lua document, on demand even when autocomplete is off', () => {
        // Off means "don't volunteer while I type", not "no completion" — the
        // extension stays mounted so Ctrl+Space still works.
        expect(startCompletion(mount({ autocomplete: false }, true, 'ce'))).toBe(true);
    });

    it('does not mount completion for a non-Lua document', () => {
        // A JSON or plain-text file in the file browser has no business
        // suggesting Mudlet's function list.
        expect(startCompletion(mount({ autocomplete: true }, false, 'ce'))).toBe(false);
    });
});
