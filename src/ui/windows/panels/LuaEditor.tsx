import { useEffect, useRef, useState, useMemo } from 'react';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage, indentUnit, bracketMatching } from '@codemirror/language';
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { useEffectiveTheme } from '../../../storage';
import { luaCompletionSource, HOVER_MAP, REFERENCE_GROUPS } from '../../../scripting/lua/luaCompletions';
import { mudixCmTheme, highlightCompartment, highlightFor } from '../../codemirror/theme';

// Lua-specific hover tooltip styling — bolted on top of the shared chrome.
const luaHoverTheme = EditorView.theme({
    '.cm-lua-hover': {
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        maxWidth: '360px',
    },
    '.cm-lua-hover__header': {
        display: 'flex',
        alignItems: 'baseline',
        gap: '2px',
        flexWrap: 'wrap',
    },
    '.cm-lua-hover__name': {
        color: 'var(--accent)',
        fontWeight: '500',
    },
    '.cm-lua-hover__sig': {
        color: 'var(--text-dim)',
    },
    '.cm-lua-hover__info': {
        marginTop: '5px',
        color: 'var(--text-dim)',
        fontSize: '11px',
        lineHeight: '1.5',
    },
});

// ── Hover tooltip ─────────────────────────────────────────────────────────────

const luaHover = hoverTooltip((view, pos) => {
    const word = view.state.wordAt(pos);
    if (!word) return null;

    const label = view.state.sliceDoc(word.from, word.to);
    if (!label || !/^[a-zA-Z_]/.test(label)) return null;

    // Walk left to pick up any dotted namespace prefix (e.g. "mudix.windows.")
    const lookback = view.state.sliceDoc(Math.max(0, word.from - 60), word.from);
    const prefixMatch = lookback.match(/([\w.]+\.)$/);
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const fullName = prefix + label;

    // Most-specific match first, then bare label as fallback
    const entry = HOVER_MAP.get(fullName) ?? HOVER_MAP.get(label);
    if (!entry) return null;

    const infoText = typeof entry.info === 'string' ? entry.info : null;
    if (!entry.detail && !infoText) return null;

    return {
        pos: word.from,
        end: word.to,
        above: true,
        arrow: true,
        create() {
            const dom = document.createElement('div');
            dom.className = 'cm-lua-hover';

            const header = document.createElement('div');
            header.className = 'cm-lua-hover__header';

            const nameEl = document.createElement('span');
            nameEl.className = 'cm-lua-hover__name';
            nameEl.textContent = fullName;
            header.appendChild(nameEl);

            if (entry.detail) {
                const sigEl = document.createElement('span');
                sigEl.className = 'cm-lua-hover__sig';
                sigEl.textContent = entry.detail;
                header.appendChild(sigEl);
            }

            dom.appendChild(header);

            if (infoText) {
                const infoEl = document.createElement('div');
                infoEl.className = 'cm-lua-hover__info';
                infoEl.textContent = infoText;
                dom.appendChild(infoEl);
            }

            return { dom };
        },
    };
});

// ── Extensions ────────────────────────────────────────────────────────────────

/** Marks the transaction that pushes a new `value` prop into the document, so
 *  the update listener can tell it apart from an edit the user made. */
const valueSync = Annotation.define<true>();

function buildExtensions(onChangeFn: () => void, onSaveFn: () => void, theme: string) {
    return [
        history(),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        closeBrackets(),
        indentUnit.of('  '),
        StreamLanguage.define(lua),
        highlightCompartment.of(highlightFor(theme)),
        autocompletion({ override: [luaCompletionSource], activateOnTyping: true }),
        luaHover,
        keymap.of([
            { key: 'Mod-s',     preventDefault: true, run: () => { onSaveFn(); return true; } },
            { key: 'Mod-Enter', preventDefault: true, run: () => { onSaveFn(); return true; } },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
        ]),
        EditorView.updateListener.of(update => {
            // Only a real edit counts as a change. Replacing the document to
            // adopt a new `value` prop is the parent telling us what the doc
            // already is — reporting that back as an edit is how selecting an
            // item in the script editor used to mark it dirty on sight.
            if (!update.docChanged) return;
            if (update.transactions.some(tr => tr.annotation(valueSync))) return;
            onChangeFn();
        }),
        mudixCmTheme,
        luaHoverTheme,
    ];
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
    value: string;
    onChange: (value: string) => void;
    /** Invoked when the user hits Ctrl/Cmd+S or Ctrl/Cmd+Enter inside the editor. */
    onSave?: () => void;
    /** Jump request from the parent (e.g. error log click). Bump `revision` to
     *  re-trigger a jump even when `line` is unchanged. */
    gotoLine?: { line: number; revision: number } | null;
}

export function LuaEditor({ value, onChange, onSave, gotoLine }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorHostRef = useRef<HTMLDivElement>(null);
    const viewRef      = useRef<EditorView | null>(null);
    const onChangeRef  = useRef(onChange);
    onChangeRef.current = onChange;
    const onSaveRef    = useRef(onSave);
    onSaveRef.current  = onSave;
    const theme = useEffectiveTheme();
    const themeRef = useRef(theme);
    themeRef.current = theme;

    const [refOpen, setRefOpen] = useState(false);

    useEffect(() => {
        if (!editorHostRef.current) return;

        const view = new EditorView({
            state: EditorState.create({
                doc: value,
                extensions: buildExtensions(() => {
                    onChangeRef.current(viewRef.current!.state.doc.toString());
                }, () => {
                    onSaveRef.current?.();
                }, themeRef.current),
            }),
            parent: editorHostRef.current,
        });

        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Swap syntax highlighting when the theme changes; preserves doc + scroll.
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
            effects: highlightCompartment.reconfigure(highlightFor(theme)),
        });
    }, [theme]);

    // Combined value-sync + goto.
    //
    // These have to run in one effect because of the cross-script jump flow:
    // when the user clicks → for an entity that's not currently selected, the
    // parent updates `selectedId` first; only on the *next* render does its
    // [selectedId, category] effect run and call setEditCode with the entity's
    // code. That's a render delay where this editor sees the new `gotoLine`
    // prop with the OLD (or empty, on fresh mount) `value`. If goto runs in a
    // separate effect — even deferred via RAF — it lands in the wrong doc and
    // the subsequent value-sync resets the selection.
    //
    // Instead: every render where either `value` or `gotoLine` changes, we sync
    // the value (if needed), then attempt the goto. We only "consume" the jump
    // revision once the doc has actually loaded content, so when the right
    // value finally lands on a later render we re-fire and apply the goto then.
    const lastConsumedJumpRevisionRef = useRef<number | null>(null);
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;

        const current = view.state.doc.toString();
        if (current !== value) {
            view.dispatch({
                changes: { from: 0, to: current.length, insert: value },
                selection: { anchor: 0 },
                annotations: valueSync.of(true),
            });
        }

        if (!gotoLine) return;
        if (gotoLine.revision === lastConsumedJumpRevisionRef.current) return;

        // Wait for the parent to push real content before consuming. An empty
        // doc with `gotoLine.line > 1` is the cross-script-mount case described
        // above — we'll re-fire when value-sync above brings in the new code.
        const docLen = view.state.doc.length;
        if (docLen === 0 && gotoLine.line > 1) return;

        const total = view.state.doc.lines;
        const line = Math.min(Math.max(1, gotoLine.line), total);
        const lineInfo = view.state.doc.line(line);
        view.dispatch({
            selection: { anchor: lineInfo.from },
            scrollIntoView: true,
        });
        view.focus();
        lastConsumedJumpRevisionRef.current = gotoLine.revision;
    }, [value, gotoLine]);

    const insertAtCursor = (text: string) => {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
        });
        view.focus();
    };

    return (
        <div ref={containerRef} className="lua-editor">
            <div ref={editorHostRef} className="lua-editor__host" />
            <button
                type="button"
                className="lua-editor__help-btn"
                onClick={() => setRefOpen(o => !o)}
                title="Function reference"
                aria-label="Function reference"
                aria-expanded={refOpen}
            >
                ?
            </button>
            {refOpen && (
                <LuaReferencePanel
                    onClose={() => setRefOpen(false)}
                    onInsert={name => { insertAtCursor(name); setRefOpen(false); }}
                />
            )}
        </div>
    );
}

// ── Reference panel ───────────────────────────────────────────────────────────
// Lists every entry from REFERENCE_GROUPS in a searchable, grouped view.
// Clicking an entry inserts its dotted name at the editor cursor.

interface RefPanelProps {
    onClose: () => void;
    onInsert: (insertText: string) => void;
}

function LuaReferencePanel({ onClose, onInsert }: RefPanelProps) {
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        // capture so we beat any inner stopPropagation on the editor
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return REFERENCE_GROUPS;
        return REFERENCE_GROUPS
            .map(g => ({
                ...g,
                entries: g.entries.filter(e => {
                    const full = (g.prefix + e.label).toLowerCase();
                    if (full.includes(q)) return true;
                    if (typeof e.detail === 'string' && e.detail.toLowerCase().includes(q)) return true;
                    return typeof e.info === 'string' && e.info.toLowerCase().includes(q);

                }),
            }))
            .filter(g => g.entries.length > 0);
    }, [query]);

    const totalCount = useMemo(
        () => groups.reduce((n, g) => n + g.entries.length, 0),
        [groups],
    );

    return (
        <div className="lua-editor__ref-panel" ref={panelRef} role="dialog" aria-label="Lua function reference">
            <div className="lua-editor__ref-header">
                <input
                    ref={inputRef}
                    type="text"
                    className="lua-editor__ref-search"
                    placeholder="Search functions, signatures, descriptions…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                />
                <span className="lua-editor__ref-count">{totalCount}</span>
                <button
                    type="button"
                    className="lua-editor__ref-close"
                    onClick={onClose}
                    title="Close (Esc)"
                    aria-label="Close"
                >
                    ×
                </button>
            </div>
            <div className="lua-editor__ref-body">
                {groups.length === 0 ? (
                    <div className="lua-editor__ref-empty">No matches</div>
                ) : groups.map(group => (
                    <div key={group.title} className="lua-editor__ref-group">
                        <div className="lua-editor__ref-group-title">{group.title}</div>
                        <ul className="lua-editor__ref-list">
                            {group.entries.map(e => {
                                const insertText = group.prefix + e.label;
                                return (
                                    <li
                                        key={insertText}
                                        className="lua-editor__ref-item"
                                        onClick={() => onInsert(insertText)}
                                        title={`Insert ${insertText}`}
                                    >
                                        <div className="lua-editor__ref-item-head">
                                            <span className="lua-editor__ref-item-name">{insertText}</span>
                                            {e.detail && (
                                                <span className="lua-editor__ref-item-sig">{e.detail}</span>
                                            )}
                                        </div>
                                        {typeof e.info === 'string' && e.info && (
                                            <div className="lua-editor__ref-item-info">{e.info}</div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ))}
            </div>
        </div>
    );
}
