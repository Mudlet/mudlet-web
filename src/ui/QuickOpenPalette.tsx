import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { File } from 'lucide-react';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';

const MAX_RESULTS = 80;
const MAX_FILES   = 5000;

interface FileEntry {
    path: string;     // absolute (e.g. /profiles/<id>/scripts/foo.lua)
    relPath: string;  // path relative to profile root, no leading slash
    name: string;
}

interface ScoredEntry extends FileEntry {
    score: number;
    matches: number[]; // indices into relPath that matched the query
}

function walkVFS(vfs: ProfileVFS): FileEntry[] {
    const out: FileEntry[] = [];
    const stack: string[] = [vfs.profilePath];
    const rootLen = vfs.profilePath.length + 1;
    while (stack.length > 0 && out.length < MAX_FILES) {
        const dir = stack.pop()!;
        let names: string[];
        try { names = vfs.readdir(dir); } catch { continue; }
        for (const name of names) {
            const full = `${dir}/${name}`;
            const info = vfs.stat(full);
            if (!info) continue;
            if (info.type === 'dir') stack.push(full);
            else {
                out.push({
                    path: full,
                    relPath: full.length > rootLen ? full.substring(rootLen) : name,
                    name,
                });
            }
        }
    }
    return out;
}

// Fuzzy subsequence match. Returns null when query can't be matched.
// Higher score = better. Bonuses: consecutive runs, word boundaries,
// filename region (over directory path), exact case. Tie-breaker on length.
function fuzzyScore(query: string, entry: FileEntry): { score: number; matches: number[] } | null {
    const q = query.toLowerCase();
    const candidate = entry.relPath.toLowerCase();
    const nameStart = entry.relPath.length - entry.name.length;
    const matches: number[] = [];

    let qi = 0;
    let score = 0;
    let prevIdx = -1;
    let run = 0;

    for (let i = 0; i < candidate.length && qi < q.length; i++) {
        if (candidate[i] !== q[qi]) continue;
        matches.push(i);
        if (prevIdx === i - 1) {
            run += 1;
            score += 5 + run;
        } else {
            run = 0;
            score += 1;
        }
        if (i >= nameStart) score += 2;
        const prevChar = i > 0 ? candidate[i - 1] : '';
        if (i === 0 || prevChar === '/' || prevChar === '_' || prevChar === '-' || prevChar === '.' || prevChar === ' ') {
            score += 3;
        }
        if (entry.relPath[i] === query[qi]) score += 1;
        prevIdx = i;
        qi += 1;
    }

    if (qi < q.length) return null;
    score -= Math.floor(candidate.length / 32);
    return { score, matches };
}

function splitMatches(matches: number[], nameStart: number): { dirMatches: number[]; nameMatches: number[] } {
    const dirMatches: number[]  = [];
    const nameMatches: number[] = [];
    for (const m of matches) {
        if (m >= nameStart) nameMatches.push(m - nameStart);
        else if (m < nameStart - 1) dirMatches.push(m); // skip the '/' separator
    }
    return { dirMatches, nameMatches };
}

function highlight(text: string, indices: number[]): ReactNode {
    if (indices.length === 0) return text;
    const set = new Set(indices);
    const parts: ReactNode[] = [];
    let last = 0;
    for (let i = 0; i < text.length; i++) {
        if (!set.has(i)) continue;
        if (i > last) parts.push(text.substring(last, i));
        parts.push(<mark key={i} className="qo-match">{text[i]}</mark>);
        last = i + 1;
    }
    if (last < text.length) parts.push(text.substring(last));
    return parts;
}

interface QuickOpenPaletteProps {
    vfs: ProfileVFS;
    onPick: (path: string) => void;
    onClose: () => void;
}

export function QuickOpenPalette({ vfs, onPick, onClose }: QuickOpenPaletteProps) {
    const [query, setQuery]   = useState('');
    const [active, setActive] = useState(0);
    const inputRef            = useRef<HTMLInputElement>(null);
    const listRef             = useRef<HTMLDivElement>(null);

    const entries = useMemo(() => walkVFS(vfs), [vfs]);

    const results = useMemo<ScoredEntry[]>(() => {
        if (!query.trim()) {
            return entries
                .slice()
                .sort((a, b) => a.relPath.localeCompare(b.relPath))
                .slice(0, MAX_RESULTS)
                .map(e => ({ ...e, score: 0, matches: [] }));
        }
        const scored: ScoredEntry[] = [];
        for (const e of entries) {
            const r = fuzzyScore(query, e);
            if (r) scored.push({ ...e, score: r.score, matches: r.matches });
        }
        scored.sort((a, b) => b.score - a.score || a.relPath.length - b.relPath.length);
        return scored.slice(0, MAX_RESULTS);
    }, [entries, query]);

    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => { inputRef.current?.focus(); }, []);
    useEffect(() => {
        const list = listRef.current;
        const el = list?.children[active] as HTMLElement | undefined;
        el?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const commit = (idx: number) => {
        const picked = results[idx];
        if (picked) { onPick(picked.path); onClose(); }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive(a => Math.min(a + 1, Math.max(results.length - 1, 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(a => Math.max(a - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            commit(active);
        }
    };

    return (
        <div
            className="modal-overlay qo-overlay"
            onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div
                className="qo-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Go to file"
                onMouseDown={e => e.stopPropagation()}
            >
                {/* Combobox over the results list: the placeholder disappears the
                    moment the user types, so it cannot be the field's name, and
                    without aria-activedescendant the Up/Down selection changes
                    nothing a screen reader can observe. */}
                <input
                    ref={inputRef}
                    className="qo-input"
                    placeholder="Go to file by name…"
                    aria-label="Go to file by name"
                    role="combobox"
                    aria-expanded={results.length > 0}
                    aria-controls="qo-list"
                    aria-autocomplete="list"
                    aria-activedescendant={results.length > 0 ? `qo-item-${active}` : undefined}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                    autoComplete="off"
                />
                <div className="qo-list" id="qo-list" role="listbox" aria-label="Matching files" ref={listRef}>
                    {results.length === 0 ? (
                        <div className="qo-empty" role="status">
                            {entries.length === 0 ? 'No files in this profile.' : 'No files match.'}
                        </div>
                    ) : results.map((r, i) => {
                        const nameStart = r.relPath.length - r.name.length;
                        const { dirMatches, nameMatches } = splitMatches(r.matches, nameStart);
                        const dirPart = nameStart > 0 ? r.relPath.substring(0, nameStart - 1) : '';
                        return (
                            <div
                                key={r.path}
                                id={`qo-item-${i}`}
                                role="option"
                                aria-selected={i === active}
                                aria-label={r.relPath}
                                className={`qo-item${i === active ? ' qo-active' : ''}`}
                                onMouseMove={() => { if (i !== active) setActive(i); }}
                                onClick={() => commit(i)}
                            >
                                <File size={13} className="qo-icon" />
                                <span className="qo-name">{highlight(r.name, nameMatches)}</span>
                                {dirPart && <span className="qo-path">{highlight(dirPart, dirMatches)}</span>}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
