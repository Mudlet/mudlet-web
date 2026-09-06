// A pinned editor theme has to pin the whole editor, not only its syntax
// colours: "Atom One Light" under a dark app theme used to leave light keywords
// on a near-black background, which is not what picking a light theme means.
// paletteFor() answers with the chrome tokens as well, so this checks what the
// editor's root actually resolves --bg to.
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { paletteFor } from '../../src/ui/codemirror/theme';

let view: EditorView | null = null;

function mount(appTheme: string, editorTheme: 'app' | 'dark' | 'light'): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({
        state: EditorState.create({ doc: 'local x = 1', extensions: [paletteFor(appTheme, editorTheme)] }),
        parent,
    });
    return view;
}

const cssVar = (v: EditorView, name: string) =>
    getComputedStyle(v.dom).getPropertyValue(name).trim();

afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = '';
});

describe('editor palette', () => {
    it('pins a light editor under a dark app theme', () => {
        const v = mount('dark', 'light');
        expect(cssVar(v, '--bg')).toBe('#f0f0f0');
        expect(cssVar(v, '--text')).toBe('#1a1a1a');
        // Native bits inside the editor (find-panel fields, scrollbars) follow
        // the scheme, not the document's.
        expect(cssVar(v, 'color-scheme')).toBe('light');
    });

    it('pins a dark editor under a light app theme', () => {
        const v = mount('light', 'dark');
        expect(cssVar(v, '--bg')).toBe('#090909');
        expect(cssVar(v, '--text')).toBe('#d4d4d4');
        expect(cssVar(v, 'color-scheme')).toBe('dark');
    });

    it('declares no chrome of its own when the theme follows the app', () => {
        // Nothing to override means the page's own vars stand — including a
        // brand theme's surface colours, which the two stock palettes would
        // otherwise flatten.
        const v = mount('dark', 'app');
        expect(cssVar(v, '--bg')).toBe('');
        expect(cssVar(v, '--text')).toBe('');
    });

    it('never declares --accent, so a pinned editor keeps the app accent', () => {
        const v = mount('dark', 'light');
        expect(cssVar(v, '--bg')).toBe('#f0f0f0');
        expect(cssVar(v, '--accent')).toBe('');
    });
});
