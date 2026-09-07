import { Compartment, type Extension } from '@codemirror/state';
import { highlightWhitespace, highlightSpecialChars } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import { luaCompletionSource } from '../../scripting/lua/luaCompletions';
import { showLineParagraphs } from './lineParagraphMarks';

/** Mudlet's Editor preference page, which Mudlet Web had no equivalent of: the
 *  display options and autocomplete were hard-coded on. Held in a compartment
 *  so a change reconfigures the live editor instead of remounting it, which is
 *  what the theme swap alongside it already does.
 *
 *  Every CodeMirror surface in the app shares these — the script editor and
 *  the file browser's editor and JSON viewer. "Show Spaces/Tabs" that only
 *  applied to one of the three would be a setting you have to remember the
 *  scope of; `useEditorSettings()` is the single source for all of them. */
export interface EditorOptions {
    /** "Autocomplete Lua functions in code editor". */
    autocomplete: boolean;
    /** "Show Spaces/Tabs" — dots for runs of spaces, arrows for tabs. */
    showWhitespace: boolean;
    /** "Show Line/Paragraphs" — a ¶ where each line ends. */
    showLineParagraphs: boolean;
    /** "Show invisible Unicode control characters". */
    showControlChars: boolean;
    /** "Theme" — the editor palette, pinned or following the app's. */
    theme: 'app' | 'dark' | 'light';
}

export const EDITOR_OPTION_DEFAULTS: EditorOptions = {
    autocomplete: true,
    showWhitespace: false,
    showLineParagraphs: false,
    showControlChars: false,
    theme: 'app',
};

export const optionsCompartment = new Compartment();

/**
 * The display options as extensions.
 *
 * @param lua whether to offer Lua completion — true for the script editor and
 *            for a `.lua` file opened from the file browser, false for the
 *            JSON, XML and plain-text documents the same editor also serves,
 *            where Mudlet's function list is noise.
 */
export function optionExtensions(opts: EditorOptions, lua: boolean): Extension[] {
    return [
        // Always mounted where it applies at all, because the extension is also
        // what binds Ctrl+Space. The switch is whether it volunteers: off means
        // no popup while you type, but the list is still one keystroke away —
        // which is what desktop's "Autocomplete Lua functions in code editor"
        // is really about, and strictly better than losing completion
        // altogether.
        lua
            ? autocompletion({ override: [luaCompletionSource], activateOnTyping: opts.autocomplete })
            : [],
        opts.showWhitespace ? highlightWhitespace() : [],
        // Desktop's tooltip files this with the whitespace marks ("as well as
        // whitespace"), and so does the option order on its page.
        opts.showLineParagraphs ? showLineParagraphs() : [],
        // CodeMirror hides control characters behind a placeholder widget by
        // default anyway; this makes them visible as their Unicode name rather
        // than a bare dot, which is the point of Mudlet's checkbox — spotting a
        // stray U+200B a game or a paste left in a script.
        opts.showControlChars ? highlightSpecialChars() : [],
    ];
}
