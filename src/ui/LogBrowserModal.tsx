import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ResizableModal } from './ResizableModal';
import { Button, FileSourceButton, useConfirm, type PickedFile } from './components';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';
import { useAppStore } from '../storage';
import {
    clearAllLogs,
    deleteSession,
    deleteSessions,
    getSessionEntries,
    listSessions,
    type LogEntry,
    type LogSession,
} from '../storage/logStorage';
import {
    exportSessionHtml,
    exportSessionsJson,
    exportSessionsZip,
    formatDateTime,
    formatTime,
    importSessionsJson,
} from '../storage/logExport';

interface LogBrowserModalProps {
    connectionId: string;
    connectionName: string;
    /** Lets "Import…" read a log export the profile already holds. */
    vfs?: ProfileVFS | null;
    onClose: () => void;
}

interface SearchHit {
    sessionId: string;
    index: number;
    time: number;
    snippet: string;
}

/** Build a line matcher from a query: `/regex/flags` or a literal substring. */
function buildMatcher(query: string): (s: string) => boolean {
    const re = query.match(/^\/(.*)\/([a-z]*)$/i);
    if (re) {
        try {
            // Drop the global flag — `.test()` on a /g regex is stateful.
            const compiled = new RegExp(re[1], re[2].replace('g', ''));
            return (s) => compiled.test(s);
        } catch {
            /* fall through to literal match on a malformed pattern */
        }
    }
    const needle = query.toLowerCase();
    return (s) => s.toLowerCase().includes(needle);
}

function sessionLabel(s: LogSession): string {
    return `${formatDateTime(s.startedAt)} → ${formatTime(s.endedAt)}`;
}

const ROW_OVERSCAN = 12;

export function LogBrowserModal({ connectionId, connectionName, vfs = null, onClose }: LogBrowserModalProps) {
    const confirm = useConfirm();
    const savedBounds = useAppStore(s => s.connectionModalBounds[connectionId]?.['logs']);
    const saveModalBounds = useAppStore(s => s.saveModalBounds);

    const [sessions, setSessions] = useState<LogSession[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [entriesLoading, setEntriesLoading] = useState(false);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [showTimestamps, setShowTimestamps] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);

    const [searchText, setSearchText] = useState('');
    const [searchScope, setSearchScope] = useState<'current' | 'all'>('current');
    const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
    const [searching, setSearching] = useState(false);

    const [scrollTarget, setScrollTarget] = useState<{ index: number; token: number } | null>(null);
    const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
    const pendingJump = useRef<{ sessionId: string; index: number } | null>(null);

    // Caches loaded entries so cross-session search and jumps don't refetch.
    const entryCache = useRef<Map<string, LogEntry[]>>(new Map());
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadEntries = useCallback(async (sessionId: string): Promise<LogEntry[]> => {
        const cached = entryCache.current.get(sessionId);
        if (cached) return cached;
        const rows = await getSessionEntries(sessionId);
        entryCache.current.set(sessionId, rows);
        return rows;
    }, []);

    const refreshSessions = useCallback(async () => {
        const rows = await listSessions(connectionId);
        setSessions(rows);
        setSelectedId(prev => (prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? null));
    }, [connectionId]);

    useEffect(() => { void refreshSessions(); }, [refreshSessions]);

    // Load entries for the selected session, then resolve any pending jump.
    useEffect(() => {
        if (!selectedId) { setEntries([]); return; }
        let cancelled = false;
        setEntriesLoading(true);
        void loadEntries(selectedId).then(rows => {
            if (cancelled) return;
            setEntries(rows);
            setEntriesLoading(false);
            const jump = pendingJump.current;
            if (jump && jump.sessionId === selectedId) {
                pendingJump.current = null;
                setScrollTarget({ index: jump.index, token: Date.now() });
                setHighlightIndex(jump.index);
            }
        });
        return () => { cancelled = true; };
    }, [selectedId, loadEntries]);

    // Auto-clear a search/jump highlight after a couple of seconds.
    useEffect(() => {
        if (highlightIndex === null) return;
        const t = setTimeout(() => setHighlightIndex(null), 2200);
        return () => clearTimeout(t);
    }, [highlightIndex]);

    const selected = useMemo(
        () => sessions?.find(s => s.id === selectedId) ?? null,
        [sessions, selectedId],
    );

    const toggleCheck = (id: string) => {
        setChecked(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const allChecked = !!sessions && sessions.length > 0 && checked.size === sessions.length;
    const toggleAll = () => {
        if (!sessions) return;
        setChecked(allChecked ? new Set() : new Set(sessions.map(s => s.id)));
    };

    const checkedSessions = useMemo(
        () => (sessions ?? []).filter(s => checked.has(s.id)),
        [sessions, checked],
    );

    const withBusy = async (label: string, fn: () => Promise<void>) => {
        setBusy(label);
        try { await fn(); } catch (err) {
            console.error('[LogBrowser]', label, 'failed', err);
        } finally { setBusy(null); }
    };

    const handleDeleteSession = async (s: LogSession) => {
        const ok = await confirm({
            title: 'Delete log',
            message: `Delete the session from ${sessionLabel(s)}? This cannot be undone.`,
            tone: 'danger',
            buttons: [
                { label: 'Cancel', value: false, variant: 'ghost' },
                { label: 'Delete', value: true, variant: 'danger' },
            ],
            dismissValue: false,
        });
        if (!ok) return;
        await withBusy('Deleting…', async () => {
            await deleteSession(s.id);
            entryCache.current.delete(s.id);
            checked.delete(s.id);
            await refreshSessions();
        });
    };

    const handleDeleteSelected = async () => {
        if (checkedSessions.length === 0) return;
        const ok = await confirm({
            title: 'Delete logs',
            message: `Delete ${checkedSessions.length} selected session(s)? This cannot be undone.`,
            tone: 'danger',
            buttons: [
                { label: 'Cancel', value: false, variant: 'ghost' },
                { label: 'Delete', value: true, variant: 'danger' },
            ],
            dismissValue: false,
        });
        if (!ok) return;
        await withBusy('Deleting…', async () => {
            const ids = checkedSessions.map(s => s.id);
            await deleteSessions(ids);
            ids.forEach(id => entryCache.current.delete(id));
            setChecked(new Set());
            await refreshSessions();
        });
    };

    const handleClearAll = async () => {
        const ok = await confirm({
            title: 'Clear all logs',
            message: 'Delete every recorded log for every connection? This cannot be undone.',
            tone: 'danger',
            buttons: [
                { label: 'Cancel', value: false, variant: 'ghost' },
                { label: 'Clear everything', value: true, variant: 'danger' },
            ],
            dismissValue: false,
        });
        if (!ok) return;
        await withBusy('Clearing…', async () => {
            await clearAllLogs();
            entryCache.current.clear();
            setChecked(new Set());
            await refreshSessions();
        });
    };

    const handleImport = async (file: File) => {
        await withBusy('Importing…', async () => {
            const text = await file.text();
            const n = await importSessionsJson(text);
            await refreshSessions();
            await confirm({
                title: 'Import complete',
                message: `Imported ${n} session(s).`,
                buttons: [{ label: 'OK', value: true }],
            });
        });
    };

    const runSearch = useCallback(async () => {
        const q = searchText.trim();
        if (!q) { setSearchResults(null); return; }
        const match = buildMatcher(q);
        const targets = searchScope === 'all' ? (sessions ?? []) : (selected ? [selected] : []);
        setSearching(true);
        try {
            const hits: SearchHit[] = [];
            outer: for (const s of targets) {
                const rows = await loadEntries(s.id);
                for (let i = 0; i < rows.length; i++) {
                    if (match(rows[i].plain)) {
                        hits.push({ sessionId: s.id, index: i, time: rows[i].timestamp, snippet: rows[i].plain.slice(0, 240) });
                        if (hits.length >= 2000) break outer;
                    }
                }
            }
            setSearchResults(hits);
        } finally {
            setSearching(false);
        }
    }, [searchText, searchScope, sessions, selected, loadEntries]);

    const jumpToHit = (hit: SearchHit) => {
        if (hit.sessionId === selectedId) {
            setScrollTarget({ index: hit.index, token: Date.now() });
            setHighlightIndex(hit.index);
        } else {
            pendingJump.current = { sessionId: hit.sessionId, index: hit.index };
            setSelectedId(hit.sessionId);
        }
    };

    const headerExtra = busy ? <span className="lb-busy">{busy}</span> : null;

    return (
        <ResizableModal
            title="Logs"
            onClose={onClose}
            savedBounds={savedBounds}
            onBoundsChange={b => saveModalBounds(connectionId, 'logs', b)}
            defaultW={900}
            defaultH={620}
            minW={560}
            minH={360}
            className="log-browser"
            bodyClassName="log-browser__body"
            headerExtra={headerExtra}
        >
            <div className="lb-sidebar">
                <div className="lb-sidebar__head">
                    <label className="lb-checkbox">
                        <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                        <span>{checked.size > 0 ? `${checked.size} selected` : 'Select all'}</span>
                    </label>
                    <span className="lb-conn-name" title={connectionName}>{connectionName}</span>
                </div>

                <div className="lb-session-list">
                    {sessions === null && <div className="lb-empty">Loading…</div>}
                    {sessions?.length === 0 && <div className="lb-empty">No logs recorded yet.</div>}
                    {sessions?.map(s => (
                        <div
                            key={s.id}
                            className={`lb-session${s.id === selectedId ? ' lb-session--active' : ''}`}
                            onClick={() => setSelectedId(s.id)}
                        >
                            <input
                                type="checkbox"
                                checked={checked.has(s.id)}
                                onChange={() => toggleCheck(s.id)}
                                onClick={e => e.stopPropagation()}
                            />
                            <div className="lb-session__text">
                                <div className="lb-session__label">{sessionLabel(s)}</div>
                                <div className="lb-session__meta">{s.entryCount.toLocaleString()} lines</div>
                            </div>
                            <button
                                type="button"
                                className="lb-session__del"
                                title="Delete this log"
                                onClick={e => { e.stopPropagation(); void handleDeleteSession(s); }}
                            >✕</button>
                        </div>
                    ))}
                </div>

                <div className="lb-sidebar__actions">
                    <div className="lb-action-row">
                        <Button size="sm" variant="secondary" disabled={checkedSessions.length === 0}
                            onClick={() => void withBusy('Zipping…', () => exportSessionsZip(checkedSessions))}>
                            ZIP
                        </Button>
                        <Button size="sm" variant="secondary" disabled={checkedSessions.length === 0}
                            onClick={() => void withBusy('Exporting…', () => exportSessionsJson(checkedSessions))}>
                            JSON
                        </Button>
                        <Button size="sm" variant="danger" disabled={checkedSessions.length === 0}
                            onClick={() => void handleDeleteSelected()}>
                            Delete
                        </Button>
                    </div>
                    <div className="lb-action-row">
                        <FileSourceButton
                            size="sm"
                            variant="ghost"
                            vfs={vfs}
                            label="Import…"
                            accept="application/json,.json"
                            pickerTitle="Import log export from profile files"
                            onPick={(picked: PickedFile[]) => {
                                const first = picked[0];
                                if (first) void handleImport(first.file);
                            }}
                        />
                        <Button size="sm" variant="ghost" onClick={() => void handleClearAll()}>Clear all</Button>
                    </div>
                </div>
            </div>

            <div className="lb-main">
                <div className="lb-main__head">
                    <div className="lb-search">
                        <input
                            type="text"
                            className="lb-search__input"
                            placeholder="Search… (/regex/i for patterns)"
                            value={searchText}
                            onChange={e => setSearchText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') void runSearch(); }}
                        />
                        <select
                            className="lb-search__scope"
                            value={searchScope}
                            onChange={e => setSearchScope(e.target.value as 'current' | 'all')}
                            title="Search scope"
                        >
                            <option value="current">This session</option>
                            <option value="all">All sessions</option>
                        </select>
                        <Button size="sm" variant="secondary" onClick={() => void runSearch()}>Search</Button>
                        {searchResults !== null && (
                            <Button size="sm" variant="ghost" onClick={() => { setSearchResults(null); setSearchText(''); }}>Clear</Button>
                        )}
                    </div>
                    <div className="lb-main__tools">
                        <label className="lb-checkbox">
                            <input type="checkbox" checked={showTimestamps} onChange={e => setShowTimestamps(e.target.checked)} />
                            <span>Timestamps</span>
                        </label>
                        <Button size="sm" variant="secondary" disabled={!selected}
                            onClick={() => selected && void withBusy('Exporting…', () => exportSessionHtml(selected))}>
                            Download HTML
                        </Button>
                    </div>
                </div>

                {searchResults !== null && (
                    <div className="lb-results">
                        <div className="lb-results__head">
                            {searching ? 'Searching…' : `${searchResults.length} match${searchResults.length === 1 ? '' : 'es'}${searchResults.length >= 2000 ? '+ (capped)' : ''}`}
                        </div>
                        <div className="lb-results__list">
                            {searchResults.map((hit, i) => (
                                <div key={i} className="lb-result" onClick={() => jumpToHit(hit)}>
                                    <span className="lb-result__time">{formatTime(hit.time)}</span>
                                    <span className="lb-result__snippet">{hit.snippet}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <LogViewport
                    entries={entries}
                    loading={entriesLoading}
                    showTimestamps={showTimestamps}
                    scrollTarget={scrollTarget}
                    highlightIndex={highlightIndex}
                />
            </div>
        </ResizableModal>
    );
}

// ── Uniform-height virtual list ────────────────────────────────────────────
// Each captured line is a single visual row (upstream splits on '\n'), so we
// render with `white-space: pre` and a fixed row height — giving correct,
// jank-free virtualization without measuring every row.

interface LogViewportProps {
    entries: LogEntry[];
    loading: boolean;
    showTimestamps: boolean;
    scrollTarget: { index: number; token: number } | null;
    highlightIndex: number | null;
}

function LogViewport({ entries, loading, showTimestamps, scrollTarget, highlightIndex }: LogViewportProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const probeRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(0);
    const [rowH, setRowH] = useState(0);

    // Track viewport height.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
        ro.observe(el);
        setViewportH(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    // Measure a single row's height from the hidden probe.
    useLayoutEffect(() => {
        const el = probeRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            const h = el.getBoundingClientRect().height;
            if (h > 0) setRowH(Math.round(h));
        });
        ro.observe(el);
        const h = el.getBoundingClientRect().height;
        if (h > 0) setRowH(Math.round(h));
        return () => ro.disconnect();
    }, []);

    // Jump to a target index (centered) when requested.
    useLayoutEffect(() => {
        if (!scrollTarget || rowH <= 0) return;
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = Math.max(0, scrollTarget.index * rowH - el.clientHeight / 2);
        setScrollTop(el.scrollTop);
    }, [scrollTarget, rowH]);

    const total = entries.length;
    const start = rowH > 0 ? Math.max(0, Math.floor(scrollTop / rowH) - ROW_OVERSCAN) : 0;
    // Before the probe has measured, render a small slice so we never mount
    // every row at once for a huge log.
    const visCount = rowH > 0 ? Math.ceil(viewportH / rowH) + ROW_OVERSCAN * 2 : 60;
    const end = Math.min(total, start + visCount);
    const slice = entries.slice(start, end);

    return (
        <div className="lb-viewport" ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
            <div className="lb-line lb-line--probe" ref={probeRef} aria-hidden="true">
                <span className="lb-line__ts">00:00:00</span><span className="lb-line__content">probe</span>
            </div>
            {loading && <div className="lb-empty">Loading…</div>}
            {!loading && total === 0 && <div className="lb-empty">No lines in this session.</div>}
            {!loading && total > 0 && (
                <div className="lb-spacer" style={{ height: rowH > 0 ? total * rowH : undefined }}>
                    <div className="lb-window" style={{ transform: `translateY(${start * rowH}px)` }}>
                        {slice.map((entry, i) => {
                            const index = start + i;
                            return (
                                <div
                                    key={index}
                                    className={`lb-line ${entry.type}${index === highlightIndex ? ' lb-line--highlight' : ''}`}
                                    style={rowH > 0 ? { height: rowH } : undefined}
                                >
                                    {showTimestamps && <span className="lb-line__ts">{formatTime(entry.timestamp)}</span>}
                                    <span
                                        className="lb-line__content"
                                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(entry.html) }}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
