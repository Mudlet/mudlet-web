import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Pencil, Trash2 } from 'lucide-react';
import { Button, Input, useConfirm } from '../../components';
import { useAppStore } from '../../../storage/appStore';
import type { ScriptingEngine } from '../../../scripting/ScriptingEngine';
import type { LuaGlobalEntry, VariablePathSegment } from '../../../scripting/IScriptingRuntime';

const EMPTY_LIST: string[] = [];

/** The four types Mudlet's `comboBox_variable_value_type` offers, and the two
 *  `comboBox_variable_key_type` does (ui/vars_main_area.ui:105, :165). */
const VALUE_TYPES = ['string', 'number', 'boolean', 'table'] as const;
const KEY_TYPES = ['string', 'number'] as const;
type ValueType = typeof VALUE_TYPES[number];
type KeyType = typeof KEY_TYPES[number];

interface VariablesViewProps {
    connectionId: string;
    scriptingEngineRef?: React.RefObject<ScriptingEngine | null>;
    /** A search result asking for this top-level global to be brought into view.
     *  `revision` makes a repeat jump to the same name re-apply the filter. */
    focus?: { name: string; revision: number } | null;
}

/** A short, single-line preview of an entry's value for the list. */
function preview(entry: LuaGlobalEntry): string {
    if (entry.isTable) return entry.children?.length ? `{ ${entry.children.length} }` : '{ }';
    if (entry.valueType === 'nil') return 'not set';
    const v = entry.value ?? '';
    return v.length > 80 ? `${v.slice(0, 80)}…` : v;
}

function byName(a: LuaGlobalEntry, b: LuaGlobalEntry): number {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** How the path reads as Lua — `myTable.sub` / `myTable[3]`. Used as the row's
 *  identity (expansion, hidden set) as well as its tooltip. */
function pathKey(path: readonly VariablePathSegment[]): string {
    let out = '';
    for (const seg of path) {
        if (out === '') out = seg.key;
        else if (seg.kind === 'number') out += `[${seg.key}]`;
        else out += `.${seg.key}`;
    }
    return out;
}

/** Only the four types the editor can write round-trip; everything else
 *  (function, userdata, thread) is shown but not editable, as desktop greys it. */
function isEditableType(t: string): t is ValueType {
    return (VALUE_TYPES as readonly string[]).includes(t);
}

interface DraftState {
    /** The row being edited, or null when the draft is a new entry. */
    path: VariablePathSegment[] | null;
    /** Table the new entry goes into (empty = a top-level global). */
    parent: VariablePathSegment[];
    name: string;
    keyType: KeyType;
    valueType: ValueType;
    value: string;
}

/**
 * Mudlet's Variables view: the live `_G` tree with a checkbox per top-level
 * entry that toggles whether it persists across sessions (the profile's
 * save-list / Mudlet `<VariablePackage>`), and the create/rename/retype/edit/
 * hide/delete controls desktop puts in `vars_main_area.ui` — name
 * (`lineEdit_var_name:73`), key type (`comboBox_variable_key_type:105`), hidden
 * (`checkBox_variable_hidden:142`), value type
 * (`comboBox_variable_value_type:165`), plus `dlgTriggerEditor::addVar`
 * (:5211). Edits go straight into the running `_G`, so a script sees them
 * immediately.
 *
 * Built-in globals — the default Lua + Mudlet API namespace present at runtime
 * boot — are hidden by default (toggle to show), so only your own variables
 * appear. Tables expand to browse their contents (fetched eagerly, so expansion
 * is instant). Functions/userdata are shown but neither flaggable nor editable.
 * Save flagging is top-level granularity (checking a table persists all of it);
 * per-key flagging is a follow-up.
 *
 * Enumerating `_G` runs synchronously on the Lua/main thread, so we defer it a
 * tick behind a loader: the spinner paints first, then the walk runs, keeping
 * opening the tab responsive even for a large namespace.
 */
export function VariablesView({ connectionId, scriptingEngineRef, focus }: VariablesViewProps) {
    const confirm = useConfirm();
    const saveList = useAppStore(s => s.connectionVariables[connectionId]?.saveList ?? EMPTY_LIST);
    const hiddenList = useAppStore(s => s.connectionVariables[connectionId]?.hidden ?? EMPTY_LIST);
    const setSaveList = useAppStore(s => s.setVariableSaveList);
    const setHiddenList = useAppStore(s => s.setVariableHidden);
    const [globals, setGlobals] = useState<LuaGlobalEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadToken, setLoadToken] = useState(0);
    const [filter, setFilter] = useState('');
    const [showBuiltins, setShowBuiltins] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState<string | null>(null);
    const [draft, setDraft] = useState<DraftState | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(() => { setLoading(true); setLoadToken(t => t + 1); }, []);

    // Run the (synchronous) `_G` walk a tick after the loader renders, so the
    // spinner is visible before the main thread is busy. Re-runs on Refresh and
    // after every applied edit.
    useEffect(() => {
        let cancelled = false;
        const id = setTimeout(() => {
            const g = scriptingEngineRef?.current?.listGlobals() ?? [];
            if (!cancelled) { setGlobals(g); setLoading(false); }
        }, 0);
        return () => { cancelled = true; clearTimeout(id); };
    }, [loadToken, scriptingEngineRef]);

    // A search hit filters the list down to the global it found, and shows
    // hidden/built-in rows if that is the only way the hit can appear.
    const lastFocusRef = useRef<number | null>(null);
    useEffect(() => {
        if (!focus || focus.revision === lastFocusRef.current) return;
        lastFocusRef.current = focus.revision;
        setFilter(focus.name);
        setSelected(focus.name);
    }, [focus]);

    const savedSet = useMemo(() => new Set(saveList), [saveList]);
    const hiddenSet = useMemo(() => new Set(hiddenList), [hiddenList]);

    const topRows = useMemo(() => {
        const byNameMap = new Map(globals.map(g => [g.name, g]));
        // Surface saved names that aren't currently in _G (e.g. set later by a
        // script) so they remain visible and removable.
        for (const name of saveList) {
            if (!byNameMap.has(name)) byNameMap.set(name, { name, valueType: 'nil', saveable: true });
        }
        const f = filter.trim().toLowerCase();
        return [...byNameMap.values()]
            // Built-ins hidden unless toggled — but a saved global always shows.
            .filter(g => showBuiltins || !g.builtin || savedSet.has(g.name))
            .filter(g => showHidden || !hiddenSet.has(g.name))
            .filter(g => !f || g.name.toLowerCase().includes(f))
            .sort(byName);
    }, [globals, saveList, filter, showBuiltins, showHidden, savedSet, hiddenSet]);

    const toggleSave = useCallback((name: string) => {
        const next = new Set(saveList);
        if (next.has(name)) next.delete(name); else next.add(name);
        setSaveList(connectionId, [...next]);
    }, [saveList, setSaveList, connectionId]);

    const toggleHidden = useCallback((key: string) => {
        const next = new Set(hiddenList);
        if (next.has(key)) next.delete(key); else next.add(key);
        setHiddenList(connectionId, [...next]);
    }, [hiddenList, setHiddenList, connectionId]);

    const toggleExpand = useCallback((key: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }, []);

    /** Send one edit to the runtime and reload the tree if it took. */
    const apply = useCallback((edit: Parameters<ScriptingEngine['editVariable']>[0]): boolean => {
        const engine = scriptingEngineRef?.current;
        if (!engine) { setError('the Lua runtime is not running — open the profile first'); return false; }
        const failure = engine.editVariable(edit);
        setError(failure);
        if (failure) return false;
        refresh();
        return true;
    }, [scriptingEngineRef, refresh]);

    const beginNew = useCallback(() => {
        // A new entry lands inside the selected table, or at the top level —
        // the same rule the item trees use for "+ New".
        const parentEntry = selected ? findByPath(globals, selected) : null;
        const parent = parentEntry?.entry.isTable ? parentEntry.path : [];
        setError(null);
        setDraft({ path: null, parent, name: '', keyType: 'string', valueType: 'string', value: '' });
    }, [globals, selected]);

    const beginEdit = useCallback((path: VariablePathSegment[], entry: LuaGlobalEntry) => {
        setError(null);
        setDraft({
            path,
            parent: path.slice(0, -1),
            name: path[path.length - 1].key,
            keyType: path[path.length - 1].kind,
            valueType: isEditableType(entry.valueType) ? entry.valueType : 'string',
            value: entry.value ?? '',
        });
    }, []);

    const commitDraft = useCallback(() => {
        if (!draft) return;
        const name = draft.name.trim();
        if (!name) { setError('a variable needs a name'); return; }
        const target: VariablePathSegment[] = [...draft.parent, { key: name, kind: draft.keyType }];
        const previous = draft.path;

        // A rename (or a key-type change) moves the entry first, so the value
        // assignment below lands on the new key rather than resurrecting the
        // old one. Retyping to `table` keeps whatever the table already held.
        if (previous) {
            const last = previous[previous.length - 1];
            if (last.key !== name || last.kind !== draft.keyType) {
                if (!apply({ op: 'move', path: previous, to: { key: name, kind: draft.keyType } })) return;
                if (previous.length === 1 && savedSet.has(last.key)) {
                    setSaveList(connectionId, saveList.map(n => n === last.key ? name : n));
                }
            }
        }
        if (!apply({ op: 'set', path: target, valueType: draft.valueType, value: draft.value })) return;
        setDraft(null);
        setSelected(pathKey(target));
    }, [draft, apply, savedSet, saveList, setSaveList, connectionId]);

    const deleteEntry = useCallback(async (path: VariablePathSegment[]) => {
        const key = pathKey(path);
        const ok = await confirm<boolean>({
            title: 'Delete variable?',
            tone: 'danger',
            message: <>Set <code>{key}</code> to <code>nil</code>? Any script still reading it will see nothing there.</>,
            buttons: [
                { label: 'Cancel', value: false, variant: 'secondary' },
                { label: 'Delete', value: true, variant: 'danger', autoFocus: true },
            ],
            dismissValue: false,
        });
        if (!ok) return;
        if (!apply({ op: 'delete', path })) return;
        if (path.length === 1 && savedSet.has(path[0].key)) {
            setSaveList(connectionId, saveList.filter(n => n !== path[0].key));
        }
        if (hiddenSet.has(key)) setHiddenList(connectionId, hiddenList.filter(n => n !== key));
        if (selected === key) setSelected(null);
    }, [apply, confirm, savedSet, saveList, setSaveList, hiddenSet, hiddenList, setHiddenList, connectionId, selected]);

    const renderRows = useCallback((entries: LuaGlobalEntry[], depth: number, parentPath: VariablePathSegment[]): React.ReactNode[] => {
        const rows: React.ReactNode[] = [];
        for (const g of entries) {
            const path = [...parentPath, { key: g.name, kind: (g.keyKind === 'number' ? 'number' : 'string') as KeyType }];
            const key = pathKey(path);
            if (depth > 0 && !showHidden && hiddenSet.has(key)) continue;
            const kids = g.children ? [...g.children].sort(byName) : [];
            const hasChildren = kids.length > 0;
            const isOpen = expanded.has(key);
            const checked = depth === 0 && savedSet.has(g.name);
            const isHidden = hiddenSet.has(key);
            const editable = g.saveable && !g.builtin;

            if (draft && draft.path && pathKey(draft.path) === key) {
                rows.push(<DraftRow key={key} depth={depth} draft={draft} setDraft={setDraft} onCommit={commitDraft} onCancel={() => setDraft(null)} />);
            } else {
                rows.push(
                    <div
                        key={key}
                        className={`variables__row${selected === key ? ' variables__row--selected' : ''}${isHidden ? ' variables__row--hidden' : ''}`}
                        style={{ paddingLeft: 12 + depth * 16, opacity: g.saveable ? 1 : 0.5 }}
                        onClick={() => setSelected(key)}
                        title={key}
                    >
                        {g.isTable && hasChildren ? (
                            <button
                                className="variables__chevron"
                                onClick={e => { e.stopPropagation(); toggleExpand(key); }}
                                title={isOpen ? 'Collapse' : 'Expand'}
                            >
                                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                        ) : (
                            <span className="variables__chevron-spacer" />
                        )}
                        {depth === 0 ? (
                            <input
                                type="checkbox"
                                checked={checked}
                                disabled={!g.saveable}
                                onClick={e => e.stopPropagation()}
                                onChange={() => toggleSave(g.name)}
                                title={g.saveable ? 'Save across sessions' : `${g.valueType} — not saveable`}
                                style={{ accentColor: 'var(--accent)', cursor: g.saveable ? 'pointer' : 'default', flexShrink: 0 }}
                            />
                        ) : (
                            <span className="variables__chevron-spacer" />
                        )}
                        <span className="variables__name" style={{ fontWeight: checked ? 600 : 400 }}>{g.name}</span>
                        <span className="variables__type">{g.valueType}</span>
                        <span className="variables__value">{preview(g)}</span>
                        <span className="variables__actions">
                            <button
                                className="variables__action"
                                title={isHidden ? 'Show this variable' : 'Hide this variable from the list'}
                                onClick={e => { e.stopPropagation(); toggleHidden(key); }}
                            >{isHidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                            <button
                                className="variables__action"
                                title={editable ? 'Edit name, type or value' : `${g.valueType} values cannot be edited here`}
                                disabled={!editable}
                                onClick={e => { e.stopPropagation(); beginEdit(path, g); }}
                            ><Pencil size={12} /></button>
                            <button
                                className="variables__action variables__action--danger"
                                title="Set to nil"
                                disabled={g.builtin}
                                onClick={e => { e.stopPropagation(); void deleteEntry(path); }}
                            ><Trash2 size={12} /></button>
                        </span>
                    </div>,
                );
            }
            if (hasChildren && isOpen) rows.push(...renderRows(kids, depth + 1, path));
        }
        return rows;
    }, [expanded, savedSet, hiddenSet, showHidden, selected, draft, toggleExpand, toggleSave, toggleHidden, beginEdit, deleteEntry, commitDraft]);

    return (
        <div className="script-editor__error-log-view">
            <div className="script-editor__error-log-header">
                <span className="script-editor__error-log-title">
                    {saveList.length} saved · {loading ? '…' : topRows.length} shown
                </span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="variables__toggle">
                        <input
                            type="checkbox"
                            checked={showBuiltins}
                            onChange={e => setShowBuiltins(e.target.checked)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                        />
                        Show built-ins
                    </label>
                    <label className="variables__toggle">
                        <input
                            type="checkbox"
                            checked={showHidden}
                            onChange={e => setShowHidden(e.target.checked)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                        />
                        Show hidden
                    </label>
                    <Input
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder="Filter…"
                        style={{ width: 140, height: 26 }}
                    />
                    <Button variant="secondary" size="sm" onClick={beginNew}>+ New</Button>
                    <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>Refresh</Button>
                </div>
            </div>
            {error && <div className="variables__error" role="alert">{error}</div>}
            <div style={{ flex: 1, overflow: 'auto', fontSize: 12 }}>
                {draft && !draft.path && (
                    <DraftRow depth={draft.parent.length} draft={draft} setDraft={setDraft} onCommit={commitDraft} onCancel={() => setDraft(null)} />
                )}
                {loading ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, opacity: 0.7 }}>
                        <Loader2 size={15} style={{ animation: 'package-repo-spin 0.9s linear infinite' }} />
                        <span>Reading variables…</span>
                    </div>
                ) : topRows.length === 0 ? (
                    <div style={{ padding: 16, opacity: 0.6 }}>
                        {globals.length === 0
                            ? 'No globals — open/connect the profile so the Lua runtime is running, then Refresh.'
                            : showBuiltins ? 'No globals match the filter.'
                            : 'No user variables yet. Click "+ New" to create one, or tick a global to save it across sessions.'}
                    </div>
                ) : renderRows(topRows, 0, [])}
            </div>
        </div>
    );
}

// ── Create / edit row ─────────────────────────────────────────────────────────

interface DraftRowProps {
    depth: number;
    draft: DraftState;
    setDraft: (d: DraftState) => void;
    onCommit: () => void;
    onCancel: () => void;
}

/** The inline form desktop spreads across `vars_main_area.ui`: name, key type,
 *  value type and the value itself, in one row where the variable sits. */
function DraftRow({ depth, draft, setDraft, onCommit, onCancel }: DraftRowProps) {
    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => { nameRef.current?.focus(); }, []);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };

    const parentLabel = draft.parent.length ? `${pathKey(draft.parent)}.` : '';

    return (
        <div className="variables__row variables__row--draft" style={{ paddingLeft: 12 + depth * 16 }} onKeyDown={onKeyDown}>
            {parentLabel && <span className="variables__draft-parent" title={parentLabel}>{parentLabel}</span>}
            <input
                ref={nameRef}
                className="variables__draft-name"
                value={draft.name}
                placeholder="name"
                spellCheck={false}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
            <select
                className="variables__draft-select"
                value={draft.keyType}
                title="Key type — how Lua holds the name (myTable.name vs myTable[3])"
                onChange={e => setDraft({ ...draft, keyType: e.target.value as KeyType })}
            >
                {KEY_TYPES.map(t => <option key={t} value={t}>{t} key</option>)}
            </select>
            <select
                className="variables__draft-select"
                value={draft.valueType}
                title="Value type"
                onChange={e => setDraft({ ...draft, valueType: e.target.value as ValueType })}
            >
                {VALUE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {draft.valueType === 'boolean' ? (
                <select
                    className="variables__draft-select"
                    value={draft.value === 'true' ? 'true' : 'false'}
                    onChange={e => setDraft({ ...draft, value: e.target.value })}
                >
                    <option value="true">true</option>
                    <option value="false">false</option>
                </select>
            ) : draft.valueType === 'table' ? (
                <span className="variables__draft-note">
                    {draft.path ? 'existing contents are kept' : 'starts empty'}
                </span>
            ) : (
                <input
                    className="variables__draft-value"
                    value={draft.value}
                    placeholder={draft.valueType === 'number' ? '0' : 'value'}
                    spellCheck={false}
                    onChange={e => setDraft({ ...draft, value: e.target.value })}
                />
            )}
            <Button variant="primary" size="sm" onClick={onCommit}>Save</Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Locate an entry by its rendered path key, returning it with the typed path
 *  the runtime needs. */
function findByPath(
    globals: readonly LuaGlobalEntry[],
    key: string,
): { entry: LuaGlobalEntry; path: VariablePathSegment[] } | null {
    let found: { entry: LuaGlobalEntry; path: VariablePathSegment[] } | null = null;
    const visit = (entry: LuaGlobalEntry, parent: VariablePathSegment[]) => {
        if (found) return;
        const path = [...parent, { key: entry.name, kind: (entry.keyKind === 'number' ? 'number' : 'string') as KeyType }];
        if (pathKey(path) === key) { found = { entry, path }; return; }
        for (const child of entry.children ?? []) visit(child, path);
    };
    for (const g of globals) visit(g, []);
    return found;
}
