import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, X } from 'lucide-react';
import { buildMatcher } from '../search/matcher';
import { useDebounced } from '../search/useDebounced';
import {
    applyHighlights, clearHighlights, findMatchIndex,
    indexNearViewport, revealLine, scanOutput, seedFromSelection,
    type OutputMatch,
} from './outputSearch';
import type { MudSession } from '../../mud/MudSession';
import './OutputSearchBar.css';

interface OutputSearchBarProps {
    session: MudSession;
    /** The `.output-wrapper` scroller holding the rendered scrollback. */
    outputRef: React.RefObject<HTMLDivElement | null>;
    /** Changes on every Ctrl+F. Re-focuses the box and re-seeds it from the
     *  output selection, so pressing the shortcut again behaves like the
     *  browser's find rather than doing nothing. */
    focusNonce: number;
    onClose: () => void;
    /** Rebuilds the split-view panel from the (now highlighted) source lines —
     *  its contents are clones, so marks only reach it via a re-populate. */
    refreshSticky?: () => void;
    /** Focus target once the bar closes, so the player can keep typing. */
    commandInputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}

/** Long enough to swallow a burst of typing, short enough that the count feels
 *  live. Also throttles the rescan driven by incoming MUD output. */
const RESCAN_DELAY = 120;

export function OutputSearchBar({
    session, outputRef, focusNonce, onClose, refreshSticky, commandInputRef,
}: OutputSearchBarProps) {
    const [query, setQuery] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [useRegex, setUseRegex] = useState(false);
    const [matches, setMatches] = useState<OutputMatch[]>([]);
    const [index, setIndex] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);

    // Read inside the rescan effect without making it a dependency — a rescan
    // triggered by new MUD output must not also re-run when the index moves.
    const indexRef = useRef(index);
    indexRef.current = index;
    const matchesRef = useRef(matches);
    matchesRef.current = matches;

    const debouncedQuery = useDebounced(query, RESCAN_DELAY);
    const matcher = useMemo(
        () => buildMatcher(debouncedQuery, matchCase, useRegex),
        [debouncedQuery, matchCase, useRegex],
    );

    // Read the selection before focusing — moving focus into the box collapses
    // it. An empty seed leaves whatever was already typed alone.
    useEffect(() => {
        const seed = seedFromSelection(outputRef.current);
        if (seed) setQuery(seed);
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusNonce]);

    /** Re-tint the output for `next`, optionally scrolling to the current hit.
     *  Highlighting and revealing are separate because a rescan caused by
     *  incoming output must not yank the view away from what's being read. */
    const paint = useCallback((next: OutputMatch[], nextIndex: number, reveal: boolean) => {
        const container = outputRef.current;
        if (!container) return;
        clearHighlights(container);
        applyHighlights(next, nextIndex);
        const current = next[nextIndex];
        if (reveal && current) revealLine(container, current.line);
        refreshSticky?.();
    }, [outputRef, refreshSticky]);

    // Query / flags changed: rescan from scratch and jump to the hit nearest
    // whatever the player is currently looking at.
    useEffect(() => {
        const container = outputRef.current;
        if (!container) return;
        const found = scanOutput(container, matcher);
        const nextIndex = indexNearViewport(container, found);
        setMatches(found);
        setIndex(nextIndex);
        paint(found, nextIndex, true);
    }, [matcher, outputRef, paint]);

    // New output arrives while the bar is open: rescan so fresh lines get
    // tinted and evicted ones drop out, holding the player's place in the list.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const rescan = () => {
            timer = null;
            const container = outputRef.current;
            if (!container) return;
            const found = scanOutput(container, matcher);
            const previous = matchesRef.current[indexRef.current] ?? null;
            const carried = findMatchIndex(found, previous);
            const nextIndex = carried !== -1
                ? carried
                : Math.min(Math.max(indexRef.current, 0), found.length - 1);
            setMatches(found);
            setIndex(nextIndex);
            paint(found, nextIndex, false);
        };
        const schedule = () => {
            if (timer === null) timer = setTimeout(rescan, RESCAN_DELAY);
        };
        const off = session.events.on('message', schedule);
        return () => {
            off();
            if (timer !== null) clearTimeout(timer);
        };
    }, [session, matcher, outputRef, paint]);

    // Leaving the bar must never leave the output tinted.
    useEffect(() => {
        const container = outputRef.current;
        return () => {
            if (container) clearHighlights(container);
            refreshSticky?.();
        };
    }, [outputRef, refreshSticky]);

    const step = useCallback((delta: number) => {
        if (matches.length === 0) return;
        const base = index === -1 ? (delta > 0 ? -1 : 0) : index;
        const next = (base + delta + matches.length) % matches.length;
        setIndex(next);
        paint(matches, next, true);
    }, [matches, index, paint]);

    const close = useCallback(() => {
        onClose();
        commandInputRef?.current?.focus();
    }, [onClose, commandInputRef]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    };

    // F3 / Shift+F3 walk results even when focus has gone back to the command
    // line — Mudlet's binding, and it keeps the bar useful without stealing it.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'F3' || e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [step]);

    const invalid = !matcher.valid;
    const status = invalid
        ? 'Bad pattern'
        : debouncedQuery === ''
            ? ''
            : matches.length === 0
                ? 'No results'
                : `${index + 1}/${matches.length}`;

    return (
        <div className="output-search" role="search">
            <div className={`output-search__bar${invalid ? ' output-search__bar--invalid' : ''}`}>
                <Search size={13} strokeWidth={1.8} className="output-search__bar-icon" />
                <input
                    ref={inputRef}
                    className="output-search__input"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Find in output"
                    aria-label="Find in output"
                    spellCheck={false}
                    autoComplete="off"
                />
                <span className={`output-search__count${invalid ? ' output-search__count--invalid' : ''}`}>
                    {status}
                </span>
                <button
                    type="button"
                    className="output-search__nav"
                    onClick={() => step(-1)}
                    disabled={matches.length === 0}
                    title="Previous match (Shift+Enter)"
                    aria-label="Previous match"
                >
                    <ChevronUp size={14} strokeWidth={1.8} />
                </button>
                <button
                    type="button"
                    className="output-search__nav"
                    onClick={() => step(1)}
                    disabled={matches.length === 0}
                    title="Next match (Enter)"
                    aria-label="Next match"
                >
                    <ChevronDown size={14} strokeWidth={1.8} />
                </button>
                <button
                    type="button"
                    className={`output-search__toggle${matchCase ? ' output-search__toggle--on' : ''}`}
                    onClick={() => setMatchCase(v => !v)}
                    title="Match case"
                    aria-label="Match case"
                    aria-pressed={matchCase}
                >
                    <CaseSensitive size={14} strokeWidth={1.8} />
                </button>
                <button
                    type="button"
                    className={`output-search__toggle${useRegex ? ' output-search__toggle--on' : ''}`}
                    onClick={() => setUseRegex(v => !v)}
                    title="Use regular expression"
                    aria-label="Use regular expression"
                    aria-pressed={useRegex}
                >
                    <Regex size={14} strokeWidth={1.8} />
                </button>
                <button
                    type="button"
                    className="output-search__close"
                    onClick={close}
                    title="Close (Esc)"
                    aria-label="Close search"
                >
                    <X size={14} strokeWidth={1.8} />
                </button>
            </div>
        </div>
    );
}
