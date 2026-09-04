import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { tags as t } from '@lezer/highlight';
import { isLightTheme } from '../../branding';

// Chrome (background, gutter, autocomplete, scrollbar) using app CSS vars so
// the editor adopts the active theme. Syntax highlighting is swapped via the
// shared highlightCompartment below.
export const mudixCmTheme = EditorView.theme({
    '&': {
        height: '100%',
        fontSize: '13px',
        fontFamily: 'var(--font-mono)',
        background: 'var(--bg)',
        color: 'var(--text)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.6',
        overflow: 'auto',
    },
    '.cm-content': {
        caretColor: 'var(--accent)',
        padding: '10px 0',
    },
    '.cm-line': { padding: '0 12px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--accent-glow)',
    },
    '.cm-gutters': {
        background: 'var(--bg-input)',
        borderRight: '1px solid var(--border)',
        color: 'var(--text-dim)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 10px 0 6px',
        minWidth: '36px',
    },
    '.cm-activeLine': { backgroundColor: 'var(--hover-bg)' },
    '.cm-activeLineGutter': {
        backgroundColor: 'var(--hover-bg-strong)',
        color: 'var(--text)',
    },
    '.cm-matchingBracket': {
        background: 'var(--accent-glow)',
        outline: '1px solid var(--accent-focus)',
    },
    '.cm-tooltip': {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-float)',
        color: 'var(--text)',
    },
    '.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        maxHeight: '220px',
    },
    '.cm-tooltip-autocomplete > ul > li': {
        padding: '3px 10px',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        background: 'var(--accent)',
        color: 'var(--btn-primary-text)',
    },
    '.cm-completionDetail': {
        color: 'var(--text-dim)',
        fontStyle: 'normal',
        marginLeft: '8px',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': {
        color: 'var(--btn-primary-text)',
        opacity: '0.75',
    },
    '.cm-completionInfo': {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '6px 10px',
        color: 'var(--text-dim)',
        fontSize: '11px',
        maxWidth: '320px',
    },
    // Find/replace panel (@codemirror/search). Styled here rather than in a
    // stylesheet so it follows the same CSS vars as the rest of the chrome.
    '.cm-panels': {
        background: 'var(--bg-surface)',
        color: 'var(--text)',
        borderColor: 'var(--border)',
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-panel.cm-search': {
        padding: '6px 8px',
        fontFamily: 'var(--font-ui)',
        fontSize: '12px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px',
    },
    '.cm-panel.cm-search label': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        color: 'var(--text-dim)',
        fontSize: '11px',
    },
    '.cm-panel.cm-search input[type=checkbox]': { accentColor: 'var(--accent)' },
    '.cm-panel.cm-search input[type=text], .cm-textfield': {
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        color: 'var(--text)',
        padding: '3px 6px',
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
    },
    '.cm-panel.cm-search input[type=text]:focus, .cm-textfield:focus': {
        outline: 'none',
        borderColor: 'var(--accent-focus, var(--accent))',
    },
    '.cm-button': {
        background: 'var(--bg-input)',
        backgroundImage: 'none',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        color: 'var(--text)',
        padding: '3px 8px',
        fontSize: '11px',
        cursor: 'pointer',
    },
    '.cm-button:hover': { background: 'var(--hover-bg-strong)' },
    '.cm-button:active': { backgroundImage: 'none' },
    '.cm-panel.cm-search [name=close]': {
        color: 'var(--text-dim)',
        cursor: 'pointer',
        fontSize: '15px',
        padding: '0 4px',
    },
    '.cm-searchMatch': { background: 'var(--accent-glow)' },
    '.cm-searchMatch.cm-searchMatch-selected': {
        background: 'var(--accent)',
        color: 'var(--btn-primary-text)',
    },
    '.cm-selectionMatch': { background: 'var(--hover-bg-strong)' },
    '.cm-scroller::-webkit-scrollbar': { width: '6px', height: '6px' },
    '.cm-scroller::-webkit-scrollbar-track': { background: 'transparent' },
    '.cm-scroller::-webkit-scrollbar-thumb': {
        background: 'var(--border)',
        borderRadius: '3px',
    },
});

// Atom One Light palette — paired with oneDarkHighlightStyle for dark mode.
const oneLightHighlightStyle = HighlightStyle.define([
    { tag: t.keyword, color: '#a626a4' },
    { tag: [t.deleted, t.character, t.propertyName, t.macroName], color: '#e45649' },
    { tag: [t.function(t.variableName), t.labelName], color: '#4078f2' },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#986801' },
    { tag: [t.definition(t.name), t.separator], color: '#383a42' },
    { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#c18401' },
    { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#0184bc' },
    { tag: [t.meta, t.comment], color: '#a0a1a7', fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, color: '#0184bc', textDecoration: 'underline' },
    { tag: t.heading, fontWeight: 'bold', color: '#a626a4' },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#986801' },
    { tag: [t.processingInstruction, t.string, t.inserted], color: '#50a14f' },
    { tag: t.invalid, color: '#e45649' },
]);

// Shared across editors — a Compartment is a stable key, not state, so reuse
// is safe across multiple EditorState instances.
export const highlightCompartment = new Compartment();

/**
 * Mudlet's Editor → Theme, as far as it makes sense here. Desktop downloads a
 * catalogue from colorsublime; mudix ships the two palettes it already has and
 * lets you pin one, which is the part of that feature people actually use — a
 * dark editor under a light app theme, or the reverse.
 *
 * `app` is the default and keeps the old behaviour exactly.
 */
export type EditorTheme = 'app' | 'dark' | 'light';

export const EDITOR_THEME_CHOICES: { value: EditorTheme; label: string }[] = [
    { value: 'app',   label: 'Follow app theme' },
    { value: 'dark',  label: 'Atom One Dark' },
    { value: 'light', label: 'Atom One Light' },
];

/** @param theme the app theme, consulted only when `editorTheme` is 'app'. */
export function highlightFor(theme: string, editorTheme: EditorTheme = 'app'): ReturnType<typeof syntaxHighlighting> {
    const light = editorTheme === 'app' ? isLightTheme(theme) : editorTheme === 'light';
    return light
        ? syntaxHighlighting(oneLightHighlightStyle)
        : syntaxHighlighting(oneDarkHighlightStyle);
}
