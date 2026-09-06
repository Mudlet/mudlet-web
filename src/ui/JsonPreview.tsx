import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Pencil } from 'lucide-react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { json } from '@codemirror/lang-json';
import { CodeEditorPreview } from './CodeEditorPreview';
import { mudixCmTheme, paletteCompartment, paletteFor } from './codemirror/theme';
import { optionsCompartment, optionExtensions } from './codemirror/options';
import { useEffectiveTheme, useEditorSettings } from '../storage';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';

interface Props {
    content: string;
    filename: string;
    path: string;
    vfs: ProfileVFS;
    onDirtyChange?: (dirty: boolean) => void;
    onSaved?: () => void;
    gotoLine?: { line: number; revision: number } | null;
}

type Mode = 'rendered' | 'edit';

type Pretty =
    | { kind: 'ok'; text: string }
    | { kind: 'error'; message: string };

function prettyPrint(raw: string): Pretty {
    if (raw.trim() === '') return { kind: 'ok', text: '' };
    try {
        return { kind: 'ok', text: JSON.stringify(JSON.parse(raw), null, 2) };
    } catch (e) {
        return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
}

function JsonReadOnlyView({ text }: { text: string }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const theme = useEffectiveTheme();
    const editorOptions = useEditorSettings();
    const optionsRef = useRef(editorOptions);
    optionsRef.current = editorOptions;

    useEffect(() => {
        if (!hostRef.current) return;
        const view = new EditorView({
            state: EditorState.create({
                doc: text,
                extensions: [
                    // Read-only, but still searchable: a pretty-printed map or
                    // package manifest is exactly the kind of document you open
                    // in order to find one key in it.
                    search({ top: true }),
                    highlightSelectionMatches(),
                    lineNumbers(),
                    bracketMatching(),
                    json(),
                    paletteCompartment.of(paletteFor(theme, optionsRef.current.theme)),
                    // No autocomplete here — this is JSON, and read-only besides.
                    optionsCompartment.of(optionExtensions(optionsRef.current, false)),
                    keymap.of(searchKeymap),
                    EditorState.readOnly.of(true),
                    EditorView.editable.of(false),
                    mudixCmTheme,
                ],
            }),
            parent: hostRef.current,
        });
        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
        // theme and options are handled separately; rebuild only on a new doc
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [text]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: paletteCompartment.reconfigure(paletteFor(theme, optionsRef.current.theme)),
        });
    }, [theme, editorOptions.theme]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: optionsCompartment.reconfigure(optionExtensions(optionsRef.current, false)),
        });
    }, [
        editorOptions.autocomplete,
        editorOptions.showWhitespace,
        editorOptions.showLineParagraphs,
        editorOptions.showControlChars,
    ]);

    return <div ref={hostRef} className="vfs-json__view" />;
}

export function JsonPreview({ content, filename, path, vfs, onDirtyChange, onSaved, gotoLine }: Props) {
    const [mode, setMode] = useState<Mode>('rendered');

    const pretty = useMemo(
        () => (mode === 'rendered' ? prettyPrint(content) : null),
        [content, mode],
    );

    if (mode === 'edit') {
        return (
            <div className="vfs-json vfs-json--edit">
                <CodeEditorPreview
                    content={content}
                    filename={filename}
                    path={path}
                    vfs={vfs}
                    onDirtyChange={onDirtyChange}
                    onSaved={onSaved}
                    gotoLine={gotoLine}
                />
                <button
                    type="button"
                    className="vfs-json__mode-toggle"
                    onClick={() => setMode('rendered')}
                    title="Show pretty-printed JSON"
                >
                    <Eye size={12} />
                    <span>Preview</span>
                </button>
            </div>
        );
    }

    return (
        <div className="vfs-json">
            <div className="vfs-editor__toolbar">
                <span className="vfs-editor__filename" title={path}>{filename}</span>
                <div className="vfs-editor__actions">
                    <button
                        type="button"
                        className="vfs-editor__btn"
                        onClick={() => setMode('edit')}
                        title="Edit source"
                    >
                        <Pencil size={12} />
                        <span>Edit</span>
                    </button>
                </div>
            </div>
            {pretty?.kind === 'error' ? (
                <div className="vfs-json__body vfs-json__body--invalid">
                    <div className="vfs-preview-error">
                        <span className="vfs-preview-error-label">Invalid JSON</span>
                        <span>{pretty.message}</span>
                    </div>
                    <pre className="vfs-json__raw">{content}</pre>
                </div>
            ) : (
                <JsonReadOnlyView text={pretty?.text ?? ''} />
            )}
        </div>
    );
}
