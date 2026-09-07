import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, bracketMatching, indentUnit } from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { json } from '@codemirror/lang-json';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { xml, html } from '@codemirror/legacy-modes/mode/xml';
import { Save, Undo2 } from 'lucide-react';
import { mudletCmTheme, paletteCompartment, paletteFor } from './codemirror/theme';
import { optionsCompartment, optionExtensions } from './codemirror/options';
import { luaHover, luaHoverTheme } from './codemirror/luaHover';
import { useEffectiveTheme, useEditorSettings } from '../storage';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';

function fileExt(filename: string): string {
    const i = filename.lastIndexOf('.');
    return i >= 0 ? filename.substring(i + 1).toLowerCase() : '';
}

export const EDITABLE_EXTENSIONS = new Set([
    'lua',
    'json',
    'txt', 'md', 'log', 'csv',
    'xml', 'html', 'htm',
]);

function pickLanguage(filename: string): Extension | null {
    switch (fileExt(filename)) {
        case 'lua': return StreamLanguage.define(lua);
        case 'json': return json();
        case 'xml': return StreamLanguage.define(xml);
        case 'html':
        case 'htm': return StreamLanguage.define(html);
        default: return null;
    }
}

function isLuaFile(filename: string): boolean {
    return fileExt(filename) === 'lua';
}

interface Props {
    content: string;
    filename: string;
    path: string;
    vfs: ProfileVFS;
    onDirtyChange?: (dirty: boolean) => void;
    onSaved?: () => void;
    /** Jump request. Bump `revision` to re-trigger on the same line. */
    gotoLine?: { line: number; revision: number } | null;
    /** Extra controls rendered inside the toolbar actions area (left of Revert/Save). */
    toolbarExtra?: React.ReactNode;
}

export function CodeEditorPreview({ content, filename, path, vfs, onDirtyChange, onSaved, gotoLine, toolbarExtra }: Props) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const originalRef = useRef(content);

    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const theme = useEffectiveTheme();
    // The same Editor preferences the script editor obeys: a file opened here is
    // opened in that editor, not in a lesser one that happens to share its keys.
    const editorOptions = useEditorSettings();
    const optionsRef = useRef(editorOptions);
    optionsRef.current = editorOptions;

    // Latest-callback refs so the editor keymap closure stays stable.
    const onDirtyRef = useRef(onDirtyChange);
    onDirtyRef.current = onDirtyChange;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    const setDirtyBoth = useCallback((d: boolean) => {
        setDirty(prev => {
            if (prev !== d) onDirtyRef.current?.(d);
            return d;
        });
    }, []);

    const save = useCallback(async () => {
        const view = viewRef.current;
        if (!view || saving) return;
        const text = view.state.doc.toString();
        setSaving(true);
        try {
            vfs.writeFile(path, text);
            await vfs.flush(); // push to disk for folder-linked mounts
            originalRef.current = text;
            setDirtyBoth(false);
            setSaveError(null);
            onSavedRef.current?.();
        } catch (e) {
            setSaveError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }, [vfs, path, saving, setDirtyBoth]);

    const revert = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: originalRef.current },
        });
        setDirtyBoth(false);
    }, [setDirtyBoth]);

    const saveRef = useRef(save);
    saveRef.current = save;

    // Tracks which gotoLine revision the *current* view instance already
    // consumed. Reset whenever the view is rebuilt (path change or
    // StrictMode's mount/unmount/remount) so the jump re-fires against the
    // fresh view; otherwise the dedupe would skip the visible view's jump
    // after StrictMode tore down the first one.
    const lastJumpRevisionRef = useRef<number | null>(null);

    // Build & destroy the editor when the file path changes — every selection
    // is treated as a fresh document so dirty state can't leak across files.
    useEffect(() => {
        if (!hostRef.current) return;

        const langExt = pickLanguage(filename);
        const isLua = isLuaFile(filename);
        const view = new EditorView({
            state: EditorState.create({
                doc: content,
                extensions: [
                    history(),
                    search({ top: true }),
                    highlightSelectionMatches(),
                    lineNumbers(),
                    highlightActiveLine(),
                    highlightActiveLineGutter(),
                    bracketMatching(),
                    closeBrackets(),
                    indentUnit.of('  '),
                    ...(langExt ? [langExt] : []),
                    paletteCompartment.of(paletteFor(theme, optionsRef.current.theme)),
                    optionsCompartment.of(optionExtensions(optionsRef.current, isLua)),
                    // Mudlet's own functions are what a .lua file in a profile is
                    // made of, so the tooltip that explains them belongs here too.
                    ...(isLua ? [luaHover, luaHoverTheme] : []),
                    keymap.of([
                        {
                            key: 'Mod-s',
                            preventDefault: true,
                            run: () => { void saveRef.current(); return true; },
                        },
                        indentWithTab,
                        // Ahead of defaultKeymap so the find bindings win over
                        // the default single-line commands.
                        ...searchKeymap,
                        ...defaultKeymap,
                        ...historyKeymap,
                    ]),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) {
                            const text = update.state.doc.toString();
                            setDirtyBoth(text !== originalRef.current);
                        }
                    }),
                    mudletCmTheme,
                ],
            }),
            parent: hostRef.current,
        });

        viewRef.current = view;
        originalRef.current = content;
        setDirtyBoth(false);
        setSaveError(null);

        return () => {
            view.destroy();
            viewRef.current = null;
            lastJumpRevisionRef.current = null;
        };
        // theme changes are handled separately; re-init only on file switch
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    // Swap the palette on a theme change without rebuilding the view. Both the
    // app theme and the editor's own are dependencies: the first only matters
    // while the editor follows it, but re-pinning is itself a repaint.
    useEffect(() => {
        viewRef.current?.dispatch({
            effects: paletteCompartment.reconfigure(paletteFor(theme, optionsRef.current.theme)),
        });
    }, [theme, editorOptions.theme]);

    // Same for the display options. Depends on the individual values rather
    // than the object so a re-render that rebuilds an equal object does not
    // reconfigure the editor for nothing.
    useEffect(() => {
        viewRef.current?.dispatch({
            effects: optionsCompartment.reconfigure(
                optionExtensions(optionsRef.current, isLuaFile(filename)),
            ),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        filename,
        editorOptions.autocomplete,
        editorOptions.showWhitespace,
        editorOptions.showLineParagraphs,
        editorOptions.showControlChars,
    ]);

    // Apply jump requests from the parent (error-log hyperlinks). Tied to
    // `revision` so the same line can be re-jumped after the user scrolls
    // away. Clamps to the doc range and focuses the editor so the cursor
    // lands where the user can immediately start typing.
    useEffect(() => {
        const view = viewRef.current;
        if (!view || !gotoLine) return;
        if (gotoLine.revision === lastJumpRevisionRef.current) return;
        const total = view.state.doc.lines;
        if (total === 0) return;
        const line = Math.min(Math.max(1, gotoLine.line), total);
        const info = view.state.doc.line(line);
        view.dispatch({
            selection: { anchor: info.from },
            scrollIntoView: true,
        });
        view.focus();
        lastJumpRevisionRef.current = gotoLine.revision;
    }, [gotoLine, content]);

    return (
        <div className="vfs-editor">
            <div className="vfs-editor__toolbar">
                <span className="vfs-editor__filename" title={path}>
                    {filename}
                    {dirty && <span className="vfs-editor__dirty" aria-label="Unsaved changes">●</span>}
                </span>
                <div className="vfs-editor__actions">
                    {toolbarExtra}
                    <button
                        type="button"
                        className="vfs-editor__btn"
                        disabled={!dirty || saving}
                        onClick={revert}
                        title="Discard unsaved changes"
                    >
                        <Undo2 size={12} />
                        <span>Revert</span>
                    </button>
                    <button
                        type="button"
                        className="vfs-editor__btn vfs-editor__btn--primary"
                        disabled={!dirty || saving}
                        onClick={() => { void save(); }}
                        title="Save (Ctrl/Cmd+S)"
                    >
                        <Save size={12} />
                        <span>{saving ? 'Saving…' : 'Save'}</span>
                    </button>
                </div>
            </div>
            {saveError && (
                <div className="vfs-editor__error" role="alert">
                    Save failed: {saveError}
                </div>
            )}
            <div ref={hostRef} className="vfs-editor__host" />
        </div>
    );
}
