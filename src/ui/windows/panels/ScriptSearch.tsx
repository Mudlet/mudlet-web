import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Braces, CaseSensitive, ChevronDown, ChevronRight, Clock, Folder, Keyboard, MousePointerClick, Regex, Search, Shuffle, FileCode2, WholeWord, Zap } from 'lucide-react';
import { useAppStore } from '../../../storage';
import type { AliasNode, ButtonNode, KeyNode, ScriptNode, TimerNode, TriggerNode, TriggerPattern } from '../../../storage/schema';
import type { LuaGlobalEntry } from '../../../scripting/IScriptingRuntime';
import type { ScriptingEngine } from '../../../scripting/ScriptingEngine';
import { buildMatcher, type MatchRange, type SearchMatcher } from '../../search/matcher';
import { useDebounced } from '../../search/useDebounced';
import './ScriptSearch.css';

export type EditCategory = 'scripts' | 'aliases' | 'triggers' | 'timers' | 'keys' | 'buttons';
type AnyNode = ScriptNode | AliasNode | TriggerNode | TimerNode | KeyNode | ButtonNode;

const EMPTY: never[] = [];

const CATEGORY_SINGULAR: Record<EditCategory, string> = {
    scripts: 'Script', aliases: 'Alias', triggers: 'Trigger',
    timers: 'Timer', keys: 'Key', buttons: 'Button',
};

const CATEGORY_ICON: Record<EditCategory, React.ElementType> = {
    scripts: FileCode2, aliases: Shuffle, triggers: Zap,
    timers: Clock, keys: Keyboard, buttons: MousePointerClick,
};

function formatCode(code: string): string {
    if (!code) return '';
    if (code.startsWith('Key'))    return code.slice(3);
    if (code.startsWith('Digit'))  return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    return code;
}

function formatKeyCombo(key: string, modifiers: string[]): string {
    if (!key) return '';
    return [...modifiers.map(m => m[0].toUpperCase() + m.slice(1)), formatCode(key)].join('+');
}

// ── Matching ────────────────────────────────────────────────────────────────

interface SearchOccurrence {
    meta: string;
    what: string;
    ranges: MatchRange[];
    line?: number;
}

/** Scan every user-facing text field of a node and return one occurrence per
 *  matching field (one per matching line for code). */
function findOccurrences(item: AnyNode, matcher: SearchMatcher): SearchOccurrence[] {
    const occ: SearchOccurrence[] = [];
    const any = item as unknown as Record<string, unknown>;
    const codeLabel = any.language === 'js' ? 'JS' : 'Lua';

    const field = (meta: string, value: unknown) => {
        if (typeof value !== 'string' || !value) return;
        const what = value.trim();
        const ranges = matcher.ranges(what);
        if (ranges.length) occ.push({ meta, what, ranges });
    };

    field('name', item.name);
    field('pattern', any.pattern);
    if (Array.isArray(any.patterns)) {
        for (const p of any.patterns as TriggerPattern[]) field('pattern', p.text);
    }
    field('command', any.command);
    field('command ↓', any.commandDown);
    field('tooltip', any.tooltip);
    field('icon', any.icon);
    if (Array.isArray(any.eventHandlers)) {
        for (const e of any.eventHandlers as string[]) field('event', e);
    }
    if ('key' in item && (item as KeyNode).key) {
        field('key', formatKeyCombo((item as KeyNode).key, (item as KeyNode).modifiers));
    }

    if (typeof any.code === 'string' && any.code) {
        const lines = (any.code as string).split('\n');
        for (let i = 0; i < lines.length; i++) {
            const what = lines[i].trim();
            const ranges = matcher.ranges(what);
            if (ranges.length) occ.push({ meta: `${codeLabel} ${i + 1}`, what, ranges, line: i + 1 });
        }
    }
    return occ;
}

/**
 * One search hit: an editor item with the fields that matched, or a Lua global.
 *
 * Desktop keeps variables in the same results tree behind the "Include
 * variables" option (`searchVariables`, dlgTriggerEditor.cpp:2382), matching a
 * variable's name and its value — so a global set from a script is findable
 * without knowing which script set it.
 */
interface ResultGroup {
    key: string;
    /** Displayed as the group's title — an item name, or a variable's path. */
    name: string;
    /** Right-hand tag: the category singular, or "Variable". */
    tag: string;
    icon: React.ElementType;
    isFolder: boolean;
    occurrences: SearchOccurrence[];
    /** Jump target for a clicked occurrence. */
    go: (occ: SearchOccurrence) => void;
}

/**
 * Walk the enumerated `_G` tree, returning one group per matching variable.
 *
 * Built-ins are skipped: they are the Lua + Mudlet API namespace the Variables
 * view hides by default, and searching them would bury every real hit under the
 * standard library. Desktop skips its hidden variables in `searchVariables` for
 * the same reason.
 */
function findVariableGroups(
    globals: readonly LuaGlobalEntry[],
    matcher: SearchMatcher,
    onNavigate: (path: string) => void,
): ResultGroup[] {
    const out: ResultGroup[] = [];

    const visit = (entry: LuaGlobalEntry, prefix: string) => {
        // A numeric key can't be written with a dot, so index it as Lua would.
        const path = prefix === ''
            ? entry.name
            : entry.keyKind === 'number' ? `${prefix}[${entry.name}]` : `${prefix}.${entry.name}`;

        const occurrences: SearchOccurrence[] = [];
        const nameRanges = matcher.ranges(path);
        if (nameRanges.length) occurrences.push({ meta: 'name', what: path, ranges: nameRanges });
        if (entry.value) {
            const valueRanges = matcher.ranges(entry.value);
            if (valueRanges.length) occurrences.push({ meta: entry.valueType, what: entry.value, ranges: valueRanges });
        }
        if (occurrences.length) {
            // Navigation is by the top-level name: that is what the Variables
            // view filters on, and it brings the whole table into view.
            const root = path.split(/[.[]/, 1)[0];
            out.push({
                key: `variables:${path}`,
                name: path,
                tag: 'Variable',
                icon: Braces,
                isFolder: false,
                occurrences,
                go: () => onNavigate(root),
            });
        }
        for (const child of entry.children ?? []) visit(child, path);
    };

    for (const g of globals) {
        if (g.builtin) continue;
        visit(g, '');
    }
    return out;
}

/** Render `text` with the given match ranges wrapped in highlight marks. */
function HighlightedText({ text, ranges }: { text: string; ranges: MatchRange[] }) {
    if (ranges.length === 0) return <>{text}</>;
    const parts: React.ReactNode[] = [];
    let last = 0;
    ranges.forEach(([start, end], i) => {
        if (start > last) parts.push(text.slice(last, start));
        parts.push(<mark key={i} className="script-search__mark">{text.slice(start, end)}</mark>);
        last = end;
    });
    if (last < text.length) parts.push(text.slice(last));
    return <>{parts}</>;
}

// Virtualised results list: every row (group head or occurrence) is laid out at
// this fixed height so only the rows in view need to be rendered.
const ROW_H = 24;
const OVERSCAN = 8;

type FlatRow =
    | { type: 'head'; key: string; group: ResultGroup; collapsed: boolean }
    | { type: 'occ'; key: string; group: ResultGroup; occ: SearchOccurrence };

// ── Component ─────────────────────────────────────────────────────────────────

interface ScriptSearchProps {
    connectionId: string;
    scriptingEngineRef?: React.RefObject<ScriptingEngine | null>;
    /** Navigate the editor to a matched item (and optionally a code line). */
    onNavigate: (category: EditCategory, id: string, line?: number) => void;
    /** Show the Variables tab filtered to the named top-level global. */
    onNavigateVariable?: (name: string) => void;
}

/** Global search for the Scripts editor — lives in the modal title bar and
 *  drops a VS Code-style results overlay (rendered through a portal so it
 *  escapes the modal's `overflow: hidden`). */
export function ScriptSearch({ connectionId, scriptingEngineRef, onNavigate, onNavigateVariable }: ScriptSearchProps) {
    const [search, setSearch] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [useRegex, setUseRegex] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [includeVariables, setIncludeVariables] = useState(false);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [open, setOpen] = useState(false);
    const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

    // The heavy scan runs off the debounced query so typing stays responsive;
    // the input itself still reflects `search` immediately.
    const query = useDebounced(search, 140);
    const pending = query !== search;

    const wrapRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);

    // Virtualisation viewport state.
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(420);

    const scripts     = useAppStore(s => s.connectionScripts[connectionId] ?? EMPTY);
    const aliases     = useAppStore(s => s.connectionAliases[connectionId] ?? EMPTY);
    const triggers    = useAppStore(s => s.connectionTriggers[connectionId] ?? EMPTY);
    const timers      = useAppStore(s => s.connectionTimers[connectionId] ?? EMPTY);
    const keybindings = useAppStore(s => s.connectionKeybindings[connectionId] ?? EMPTY);
    const buttons     = useAppStore(s => s.connectionButtons[connectionId] ?? EMPTY);

    const searchActive = query.length > 0;
    const matcher = useMemo(
        () => buildMatcher(query, matchCase, useRegex, wholeWord),
        [query, matchCase, useRegex, wholeWord],
    );

    // Enumerating `_G` walks the whole user namespace on the Lua/main thread, so
    // it happens only with the option on, and only once per time the dropdown is
    // opened rather than on every keystroke — desktop likewise repopulates its
    // variable tree only when the option is set (dlgTriggerEditor.cpp:2370).
    const [globalsToken, setGlobalsToken] = useState(0);
    const dropdownOpen = open && search.length > 0;
    useEffect(() => {
        if (dropdownOpen && includeVariables) setGlobalsToken(t => t + 1);
    }, [dropdownOpen, includeVariables]);

    const globals = useMemo<readonly LuaGlobalEntry[]>(
        // eslint-disable-next-line react-hooks/exhaustive-deps
        () => (includeVariables ? scriptingEngineRef?.current?.listGlobals() ?? EMPTY : EMPTY),
        [includeVariables, globalsToken, scriptingEngineRef],
    );

    const results = useMemo<ResultGroup[]>(() => {
        if (!searchActive || !matcher.valid) return [];
        const lists: Array<[EditCategory, AnyNode[]]> = [
            ['scripts', scripts], ['aliases', aliases], ['triggers', triggers],
            ['timers', timers], ['keys', keybindings], ['buttons', buttons],
        ];
        const out: ResultGroup[] = [];
        for (const [cat, list] of lists) {
            for (const it of list) {
                const occurrences = findOccurrences(it, matcher);
                if (occurrences.length === 0) continue;
                out.push({
                    key: `${cat}:${it.id}`,
                    name: it.name,
                    tag: CATEGORY_SINGULAR[cat],
                    icon: it.isGroup ? Folder : CATEGORY_ICON[cat],
                    isFolder: it.isGroup,
                    occurrences,
                    go: occ => onNavigate(cat, it.id, occ.line),
                });
            }
        }
        if (includeVariables && onNavigateVariable) {
            out.push(...findVariableGroups(globals, matcher, onNavigateVariable));
        }
        return out;
    }, [searchActive, matcher, scripts, aliases, triggers, timers, keybindings, buttons,
        includeVariables, globals, onNavigate, onNavigateVariable]);

    const totalMatches = useMemo(() => results.reduce((n, r) => n + r.occurrences.length, 0), [results]);

    // Flatten the group/occurrence tree into a single row list (respecting
    // collapse state) so the dropdown can window it.
    const flatRows = useMemo(() => {
        const rows: FlatRow[] = [];
        for (const group of results) {
            const isCollapsed = collapsed.has(group.key);
            rows.push({ type: 'head', key: group.key, group, collapsed: isCollapsed });
            if (!isCollapsed) {
                for (let i = 0; i < group.occurrences.length; i++) {
                    rows.push({ type: 'occ', key: `${group.key}:${i}`, group, occ: group.occurrences[i] });
                }
            }
        }
        return rows;
    }, [results, collapsed]);

    const totalRows = flatRows.length;
    const startRow = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
    const visibleRows = flatRows.slice(startRow, endRow);

    // Anchor the portal dropdown under the input. Recomputed whenever it opens or
    // the layout might shift (results changing height, window resize/scroll).
    useLayoutEffect(() => {
        if (!dropdownOpen) return;
        const measure = () => {
            const el = inputRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const width = Math.min(480, Math.max(300, window.innerWidth - 16));
            const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
            setRect({ left, top: r.bottom + 6, width });
            if (resultsRef.current) setViewportH(resultsRef.current.clientHeight);
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
        };
    }, [dropdownOpen, results.length]);

    // Close on outside click / Escape.
    useEffect(() => {
        if (!dropdownOpen) return;
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            if (wrapRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); } };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [dropdownOpen]);

    // A new query produces a fresh result set — jump back to the top.
    useEffect(() => {
        setScrollTop(0);
        if (resultsRef.current) resultsRef.current.scrollTop = 0;
    }, [query, matchCase, useRegex, wholeWord, includeVariables]);

    const toggleCollapsed = useCallback((key: string) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }, []);

    const navigate = useCallback((group: ResultGroup, occ: SearchOccurrence) => {
        group.go(occ);
        setOpen(false);
        setSearch('');
    }, []);

    return (
        <div className="script-search" ref={wrapRef}>
            <div className={`script-search__bar${searchActive && !matcher.valid ? ' script-search__bar--invalid' : ''}`}>
                <Search size={13} strokeWidth={1.8} className="script-search__bar-icon" />
                <input
                    ref={inputRef}
                    className="script-search__input"
                    type="text"
                    placeholder="Search scripts, triggers…"
                    value={search}
                    spellCheck={false}
                    onChange={e => { setSearch(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    onMouseDown={e => e.stopPropagation() /* don't start a modal drag */}
                />
                <button
                    className={`script-search__toggle${matchCase ? ' script-search__toggle--on' : ''}`}
                    onClick={() => setMatchCase(v => !v)}
                    title="Match case"
                    tabIndex={-1}
                ><CaseSensitive size={14} strokeWidth={1.8} /></button>
                <button
                    className={`script-search__toggle${wholeWord ? ' script-search__toggle--on' : ''}`}
                    onClick={() => setWholeWord(v => !v)}
                    title="Whole word — only match whole words"
                    tabIndex={-1}
                ><WholeWord size={14} strokeWidth={1.8} /></button>
                <button
                    className={`script-search__toggle${useRegex ? ' script-search__toggle--on' : ''}`}
                    onClick={() => setUseRegex(v => !v)}
                    title="Use regular expression"
                    tabIndex={-1}
                ><Regex size={14} strokeWidth={1.8} /></button>
                {onNavigateVariable && (
                    <button
                        className={`script-search__toggle${includeVariables ? ' script-search__toggle--on' : ''}`}
                        onClick={() => setIncludeVariables(v => !v)}
                        title="Include variables — also search the names and values of your Lua globals"
                        tabIndex={-1}
                    ><Braces size={14} strokeWidth={1.8} /></button>
                )}
                {search && (
                    <button className="script-search__clear" onClick={() => { setSearch(''); inputRef.current?.focus(); }} title="Clear" tabIndex={-1}>×</button>
                )}
            </div>

            {dropdownOpen && rect && createPortal(
                <div
                    ref={dropdownRef}
                    className="script-search__dropdown"
                    style={{ left: rect.left, top: rect.top, width: rect.width }}
                >
                    <div className="script-search__summary">
                        {!matcher.valid
                            ? 'Invalid regular expression'
                            : pending
                                ? 'Searching…'
                                : totalMatches === 0
                                    ? 'No results'
                                    : `${totalMatches} result${totalMatches === 1 ? '' : 's'} in ${results.length} item${results.length === 1 ? '' : 's'}`}
                    </div>
                    <div
                        className="script-search__results"
                        ref={resultsRef}
                        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
                    >
                        <div className="script-search__spacer" style={{ height: totalRows * ROW_H }}>
                            {visibleRows.map((row, i) => {
                                const top = (startRow + i) * ROW_H;
                                const Icon = row.group.icon;
                                if (row.type === 'head') {
                                    return (
                                        <div
                                            key={row.key}
                                            className="script-search__group-head"
                                            style={{ top }}
                                            onClick={() => toggleCollapsed(row.key)}
                                            title={row.group.name}
                                        >
                                            {row.collapsed
                                                ? <ChevronRight size={14} strokeWidth={1.8} className="script-search__chevron" />
                                                : <ChevronDown size={14} strokeWidth={1.8} className="script-search__chevron" />}
                                            <Icon
                                                size={13}
                                                strokeWidth={1.6}
                                                className={row.group.isFolder ? 'script-search__icon-folder' : 'script-search__icon-type'}
                                            />
                                            <span className="script-search__group-name">{row.group.name}</span>
                                            <span className="script-search__group-cat">{row.group.tag}</span>
                                            <span className="script-search__count">{row.group.occurrences.length}</span>
                                        </div>
                                    );
                                }
                                return (
                                    <div
                                        key={row.key}
                                        className="script-search__occ"
                                        style={{ top }}
                                        onClick={() => navigate(row.group, row.occ)}
                                        title={row.occ.what}
                                    >
                                        <span className="script-search__occ-what">
                                            <HighlightedText text={row.occ.what} ranges={row.occ.ranges} />
                                        </span>
                                        <span className="script-search__occ-meta">{row.occ.meta}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
