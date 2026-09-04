import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from './components';
import { useConnectionId, useProfileField } from '../storage';
import { useIsMobile, useIsTouch } from '../hooks/useViewportMode';
import { useCommandHistory } from './useCommandHistory';
import { matchHistory, type Match } from './commandHistory';
import { hasPrecedingWord, matchWordCandidates, splitTrailingWord, type ActiveWord, type BufferWordIndex } from './bufferWords';
import type { CmdLineMenuEntry, CmdLineMenuRegistry } from './CmdLineMenuRegistry';

interface CommandBarProps {
    command: string;
    onCommandChange: (command: string) => void;
    passwordMode?: boolean;
    commandInputRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
    onSubmit: () => void;
    cmdLineMenu: CmdLineMenuRegistry;
    /** Tab-completion suggestions added via Mudlet's addCmdLineSuggestion API.
     *  Merged ahead of command history (dedup, case-insensitive). */
    suggestions?: string[];
    /** Words Mudlet's addCmdLineBlacklist API has taken out of Tab completion.
     *  Subtractive across every source below, not just `suggestions`. */
    blacklist?: string[];
    /** Mudlet's per-command-line setSaveCommandHistory. False keeps the history
     *  for this session but stops persisting it. */
    saveHistory?: boolean;
    /** Recency-ordered words seen in output, for argument-word Tab completion. */
    bufferWords?: BufferWordIndex | null;
}

export function CommandBar({ command, onCommandChange, passwordMode, commandInputRef, onSubmit, cmdLineMenu, suggestions, blacklist, saveHistory, bufferWords }: CommandBarProps) {
    const [menu, setMenu] = useState<{ x: number; y: number; items: CmdLineMenuEntry[] } | null>(null);
    const inputBackground = useProfileField('inputBackground');
    const inputForeground = useProfileField('inputForeground');
    // Mudlet's "Highlight history" and "Disable password masking", both off by
    // default as they are on desktop.
    const highlightHistory = useProfileField('highlightHistory') ?? false;
    const disablePasswordMasking = useProfileField('disablePasswordMasking') ?? false;
    const inputStyle = (inputBackground || inputForeground) ? {
        ...(inputBackground ? { background: inputBackground } : {}),
        ...(inputForeground ? { color: inputForeground } : {}),
    } : undefined;

    // Mudlet's `commandLineHistorySaveSize` (per-profile config bag) caps how many
    // entries are persisted. Unset / invalid → the default save size.
    const config = useProfileField('config');
    const rawSaveSize = config?.commandLineHistorySaveSize;
    const historySaveSize = typeof rawSaveSize === 'number' && Number.isFinite(rawSaveSize) && rawSaveSize >= 0
        ? rawSaveSize
        : undefined;
    const connectionId = useConnectionId();
    const { history, add: pushHistory } = useCommandHistory(connectionId, historySaveSize, saveHistory !== false);

    // -1 = "draft" slot (the user's pre-traversal text); otherwise an index
    // into the MRU `history` array.
    const [cursor, setCursor] = useState(-1);
    const draftRef = useRef(command);
    const isComposingRef = useRef(false);

    // Last value we know is in `command`. Lets us distinguish edits coming
    // *through* this component (typing / traversal / Tab) from external
    // updates fired via script.setcmd / script.appendcmd, which need to reset
    // the traversal cursor and re-arm the draft.
    const lastValueRef = useRef(command);

    // After traversal or Tab, we want the caret pinned at end after the value
    // re-renders. Set inside the keydown handler, applied in useLayoutEffect.
    // false = nothing pending; 'end' = park the caret at the end; 'history' =
    // the value came from a history recall, which "Highlight history" selects.
    const pendingCaretEndRef = useRef<false | 'end' | 'history'>(false);

    // Explicit caret position to restore after a re-render (e.g. inserting a
    // newline mid-text via Ctrl/Shift+Enter). Takes precedence over the
    // pin-to-end behaviour above.
    const pendingCaretPosRef = useRef<number | null>(null);

    // In-progress argument-word Tab cycle. `lastValue` is the value we last wrote
    // — if the box no longer matches it, the user has edited and the cycle is
    // stale, so the next Tab recomputes matches from scratch.
    const cycleRef = useRef<{ matches: string[]; index: number; lastValue: string } | null>(null);
    const resetCycle = () => { cycleRef.current = null; };

    const [ghostHidden, setGhostHidden] = useState(false);
    const isMobile = useIsMobile();
    const isTouch = useIsTouch();

    // Suggestions (from Mudlet's addCmdLineSuggestion) come before history so
    // they outrank older entries when prefix kinds tie. Dedup is case-insensitive
    // — typing the same word in either source shouldn't produce a duplicate row.
    const candidates = useMemo<string[]>(() => {
        if (!suggestions || suggestions.length === 0) return history;
        const seen = new Set<string>();
        const out: string[] = [];
        for (const s of suggestions) {
            const k = s.toLowerCase();
            if (!seen.has(k)) { seen.add(k); out.push(s); }
        }
        for (const h of history) {
            const k = h.toLowerCase();
            if (!seen.has(k)) { seen.add(k); out.push(h); }
        }
        return out;
    }, [suggestions, history]);

    const matches = useMemo<Match[]>(
        () => (passwordMode ? [] : matchHistory(command, candidates)),
        [command, candidates, passwordMode],
    );

    const ghostText = useMemo(() => {
        // No inline ghost while composing a multi-line command — the overlay is
        // a single centred line and would render against the wrong row. On mobile
        // the floating history suggestion is unwanted noise behind the text.
        if (passwordMode || ghostHidden || isMobile || matches.length === 0 || command.includes('\n')) return '';
        const top = matches[0];
        // Only a true prefix match produces a visible inline ghost — anything
        // else would shift the displayed glyph and look like a glitch.
        if (top.kind !== 'prefix-start') return '';
        return top.item.slice(command.length);
    }, [matches, command, ghostHidden, passwordMode, isMobile]);

    // External `command` updates (script.setcmd / appendcmd / clearcmd) snap
    // us back to the draft slot and re-arm the ghost.
    useEffect(() => {
        if (command === lastValueRef.current) return;
        lastValueRef.current = command;
        draftRef.current = command;
        setCursor(-1);
        setGhostHidden(false);
        cycleRef.current = null;
    }, [command]);

    useLayoutEffect(() => {
        const el = commandInputRef.current;
        if (pendingCaretPosRef.current !== null) {
            const pos = pendingCaretPosRef.current;
            pendingCaretPosRef.current = null;
            if (el) el.setSelectionRange(pos, pos);
            return;
        }
        if (!pendingCaretEndRef.current) return;
        const fromHistory = pendingCaretEndRef.current === 'history';
        pendingCaretEndRef.current = false;
        if (!el) return;
        const len = el.value.length;
        // Mudlet's "Highlight history": a command recalled with Up/Down comes
        // back selected, so the next keystroke replaces it instead of appending
        // to it. Only for history — a caret parked at the end after an ordinary
        // edit must stay a caret.
        if (fromHistory && highlightHistory) el.setSelectionRange(0, len);
        else el.setSelectionRange(len, len);
    });

    // Auto-grow the multi-line command box to fit its content (up to the CSS
    // max-height, beyond which it scrolls). Reset to 'auto' first so it can
    // shrink back when lines are removed. Single-line <input> (password mode)
    // is left untouched.
    //
    // The field is `box-sizing: border-box`, but `scrollHeight` excludes the
    // border — so setting height = scrollHeight leaves the border eating into the
    // content box, overflowing by the border width and showing a spurious
    // scrollbar even on a single line. Add the vertical border back so the box
    // fits its content exactly.
    useLayoutEffect(() => {
        const el = commandInputRef.current;
        if (!el || el.tagName !== 'TEXTAREA') return;
        el.style.height = 'auto';
        const cs = getComputedStyle(el);
        const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        el.style.height = `${el.scrollHeight + borderY}px`;
    }, [command, commandInputRef]);

    // Focus on mount and whenever the element swaps between the command
    // <textarea> and the password <input> (mode toggle), so the user can keep
    // typing without re-clicking the box.
    //
    // Not on a touch phone. Focus there summons the on-screen keyboard, which eats
    // half the screen — so the client would open, and every password prompt
    // would re-open, with the game hidden behind a keyboard nobody asked for.
    // The player taps the box when they actually mean to type (see the matching
    // opt-out in StickyOutputPanel, and the blur-on-send in `submit` below).
    useEffect(() => {
        if (isMobile && isTouch) return;
        commandInputRef.current?.focus();
    }, [commandInputRef, passwordMode, isMobile, isTouch]);

    useEffect(() => {
        if (!menu) return;
        const onDown = (e: MouseEvent) => {
            const root = document.getElementById('mudix-cmdline-menu');
            if (root && !root.contains(e.target as Node)) setMenu(null);
        };
        const onClose = () => setMenu(null);
        document.addEventListener('mousedown', onDown);
        window.addEventListener('resize', onClose);
        window.addEventListener('blur', onClose);
        return () => {
            document.removeEventListener('mousedown', onDown);
            window.removeEventListener('resize', onClose);
            window.removeEventListener('blur', onClose);
        };
    }, [menu]);

    const setValue = (val: string) => {
        lastValueRef.current = val;
        onCommandChange(val);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const val = e.target.value;
        draftRef.current = val;
        setCursor(-1);
        setGhostHidden(false);
        resetCycle();
        setValue(val);
    };

    const submit = () => {
        if (isComposingRef.current) return;
        // Empty Enter is still sent — many MUDs treat a bare newline as a
        // meaningful command (continue prompts, "look" repeats). Just don't
        // record blanks in history.
        if (command && !passwordMode) pushHistory(command);
        draftRef.current = command;
        setCursor(-1);
        setGhostHidden(false);
        resetCycle();
        onSubmit();
        // Hand the screen back after each command on a phone: keeping focus
        // keeps the on-screen keyboard up over the output, so the player never
        // sees the reply to what they just sent. Desktop keeps focus — there is
        // nothing covering anything, and re-clicking between commands would be
        // absurd.
        //
        // Both halves are load-bearing. The keyboard is what covers the output,
        // and a keyboard is a property of the device rather than of the
        // container's width: mudlet.org embeds this client in a 563px frame,
        // which is under the phone breakpoint on a 2560px screen and has
        // nothing to hide behind. Width alone would blur the caret after every
        // command for every desktop visitor to the front page.
        if (isMobile && isTouch) commandInputRef.current?.blur();
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        submit();
    };

    // Insert a newline at the caret. Mudlet binds Ctrl+Enter to this so the user
    // can stage several commands in the box; a plain Enter then sends each line
    // (split downstream in handleSend). Shift+Enter is accepted too as the more
    // common editor convention.
    const insertNewlineAtCaret = () => {
        const el = commandInputRef.current;
        const start = el?.selectionStart ?? command.length;
        const end = el?.selectionEnd ?? command.length;
        const next = command.slice(0, start) + '\n' + command.slice(end);
        draftRef.current = next;
        setCursor(-1);
        setGhostHidden(true);
        resetCycle();
        pendingCaretPosRef.current = start + 1;
        setValue(next);
    };

    // Complete the trailing word by cycling through prefix matches. `dir` is +1
    // for Tab (forward) / -1 for Shift+Tab (backward); the index wraps. The first
    // press computes + caches the candidate list from the typed word; subsequent
    // presses just advance the cached index (the snapshot survives until the user
    // edits, which clears cycleRef). `lists` are the candidate pools in priority
    // order — for the first word: suggestions, history (whole commands), buffer
    // words; for an argument word: suggestions, buffer words.
    const cycleWord = (active: ActiveWord, dir: 1 | -1, lists: string[][]): void => {
        let state = cycleRef.current;
        if (!state || state.lastValue !== command) {
            const matched = matchWordCandidates(active.word, lists);
            if (matched.length === 0) { cycleRef.current = null; return; }
            state = { matches: matched, index: dir === 1 ? 0 : matched.length - 1, lastValue: '' };
            cycleRef.current = state;
        } else {
            const n = state.matches.length;
            state.index = (state.index + dir + n) % n;
        }
        const next = active.prefix + state.matches[state.index];
        state.lastValue = next;
        draftRef.current = next;
        setCursor(-1);
        pendingCaretEndRef.current = 'end';
        setValue(next);
    };

    const traverseTo = (newCursor: number) => {
        resetCycle();
        if (newCursor === -1) {
            setCursor(-1);
            pendingCaretEndRef.current = 'end';
            setValue(draftRef.current);
        } else {
            setCursor(newCursor);
            pendingCaretEndRef.current = 'history';
            setValue(history[newCursor]);
        }
    };

    const qualifiesForTraversal = (dir: 'up' | 'down'): boolean => {
        const el = commandInputRef.current;
        if (!el) return false;
        const value = el.value;
        const len = value.length;
        if (len === 0) return true;
        const s = el.selectionStart ?? 0;
        const e = el.selectionEnd ?? 0;
        // In a multi-line command Up/Down navigate between rows; only hand off to
        // history once the caret sits on the boundary row in the press direction.
        if (dir === 'up' && value.lastIndexOf('\n', s - 1) !== -1) return false;
        if (dir === 'down' && value.indexOf('\n', e) !== -1) return false;
        if (s === 0 && e === len) return true;  // full selection
        if (s === 0 && e === 0) return true;    // caret at start
        if (s === len && e === len) return true; // caret at end
        return false;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (isComposingRef.current || e.nativeEvent.isComposing) return;

        if (e.key === 'Escape') {
            resetCycle();
            if (ghostText) {
                setGhostHidden(true);
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'Enter') {
            // Ctrl/Shift/etc.+Enter stages a newline instead of sending, so the
            // user can compose several commands at once. Passwords stay single
            // line. A plain Enter always sends; we preventDefault so the textarea
            // doesn't insert its own newline first.
            e.preventDefault();
            if (!passwordMode && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) {
                insertNewlineAtCaret();
            } else {
                submit();
            }
            return;
        }

        if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !passwordMode) {
            const active = splitTrailingWord(command);
            if (!active) {
                // Nothing to complete (empty input or trailing whitespace). Consume
                // forward Tab so focus stays in the box; leave Shift+Tab native.
                if (!e.shiftKey) e.preventDefault();
                return;
            }
            e.preventDefault();
            const sugg = suggestions ?? [];
            const words = bufferWords?.getWords() ?? [];
            // First word: complete commands you've run (history) + suggestions +
            // buffer words. Argument word: suggestions + buffer words only.
            // History is prefix-matched too, so it never "completes" to an
            // unrelated command the way subsequence matching used to.
            const lists = hasPrecedingWord(active.prefix)
                ? [sugg, words]
                : [sugg, history, words];
            // The blacklist subtracts from every list, matched case-insensitively
            // (TCommandLine::tabComplete does the same) — a word blacklisted once
            // must not come back via history or the output buffer.
            const banned = new Set((blacklist ?? []).map(w => w.toLowerCase()));
            const allowed = banned.size === 0
                ? lists
                : lists.map(l => l.filter(w => !banned.has(w.toLowerCase())));
            cycleWord(active, e.shiftKey ? -1 : 1, allowed);
            return;
        }

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            if (!qualifiesForTraversal(e.key === 'ArrowUp' ? 'up' : 'down')) return;
            if (history.length === 0 && cursor === -1) return;

            if (e.key === 'ArrowUp') {
                if (cursor === -1) draftRef.current = command;
                const next = Math.min(cursor + 1, history.length - 1);
                if (next !== cursor) {
                    e.preventDefault();
                    traverseTo(next);
                } else if (history.length > 0) {
                    // At the oldest entry already — still consume the keypress
                    // so caret doesn't jump unexpectedly.
                    e.preventDefault();
                }
            } else {
                if (cursor === -1) return; // already on draft; let native do nothing
                e.preventDefault();
                traverseTo(cursor - 1);
            }
        }
    };

    const handleCompositionStart = () => { isComposingRef.current = true; };
    const handleCompositionEnd = () => { isComposingRef.current = false; };

    const handleContextMenu = (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const items = cmdLineMenu.list();
        if (items.length === 0) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items });
    };

    return (
        <form className="command-bar" onSubmit={handleSubmit}>
            <div className="command-input-wrap">
                <span className="prompt" aria-hidden="true">&gt;</span>

                {ghostText && (
                    <div className="command-ghost" aria-hidden="true">
                        <span className="command-ghost__shadow">{command}</span>
                        <span className="command-ghost__suffix">{ghostText}</span>
                    </div>
                )}

                {passwordMode ? (
                    <Input
                        ref={commandInputRef as React.RefObject<HTMLInputElement>}
                        className="command-input"
                        // Mudlet's "Disable password masking": still the
                        // single-line password field (no history, no ghost
                        // completion), just readable — for a player who would
                        // rather see a typo than retype a long passphrase.
                        type={disablePasswordMasking ? 'text' : 'password'}
                        value={command}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        onCompositionStart={handleCompositionStart}
                        onCompositionEnd={handleCompositionEnd}
                        onContextMenu={handleContextMenu}
                        placeholder="Enter password…"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label="Command input"
                        style={inputStyle}
                    />
                ) : (
                    // A <textarea> (not <input>) so Ctrl/Shift+Enter can stage
                    // multiple lines. rows=1 keeps it single-line until the user
                    // adds a newline; the auto-grow effect resizes it to fit.
                    <textarea
                        ref={commandInputRef as React.RefObject<HTMLTextAreaElement>}
                        className="command-input command-input--multiline input"
                        rows={1}
                        value={command}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        onCompositionStart={handleCompositionStart}
                        onCompositionEnd={handleCompositionEnd}
                        onContextMenu={handleContextMenu}
                        placeholder="Enter command…"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label="Command input"
                        style={inputStyle}
                    />
                )}
            </div>

            <Button
                variant="secondary"
                type="submit"
            >
                Send
            </Button>

            {menu && (
                <div
                    id="mudix-cmdline-menu"
                    className="map-context-menu"
                    style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999 }}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    {menu.items.map(item => (
                        <div
                            key={item.uniqueName}
                            className="map-context-menu-item"
                            onMouseDown={(e) => {
                                e.stopPropagation();
                                cmdLineMenu.dispatch(item.uniqueName, command);
                                setMenu(null);
                            }}
                        >
                            <span className="map-context-menu-label">{item.displayName}</span>
                        </div>
                    ))}
                </div>
            )}
        </form>
    );
}
