// Tab completion as desktop Mudlet does it — a port of
// TCommandLine::handleTabCompletion, shared by the main command bar and every
// named command line (createCommandLine, a miniconsole's or user window's own
// line), which all run the same TCommandLine code on desktop.
//
// The pool is rebuilt on every press from the main console's buffer as it is
// right now: its last 500 lines, so a word that has scrolled further back, or
// that a clearWindow() wiped, is not offered (#342). The command line's own
// addCmdLineSuggestion words follow, and its addCmdLineBlacklist words are
// struck out of both.

/** How much of the main console TCommandLine::handleTabCompletion reads. */
export const TAB_COMPLETION_LINES = 500;

// Qt's \w under UseUnicodePropertiesOption: letters, digits and underscore.
const WORD_RUN = /[\p{L}\p{N}_]+/gu;
const TRAILING_WORD = /[\p{L}\p{N}_]+$/u;
const WORD_CHAR = /^[\p{L}\p{N}_]/u;

/**
 * The candidate words, in the order desktop builds them: the buffer lines
 * joined with spaces and split at word boundaries, then the suggestions, with
 * anything on the blacklist (compared case-insensitively) taken out. Only the
 * word runs of the buffer are kept — the runs between them start with a
 * non-word character, so no completion pattern could match one anyway.
 */
export function tabCompletionPool(
    lines: readonly string[],
    suggestions: Iterable<string> = [],
    blacklist: Iterable<string> = [],
): string[] {
    const words: string[] = [];
    for (const line of lines) {
        const found = line.match(WORD_RUN);
        if (found) for (const w of found) words.push(w);
    }
    for (const s of suggestions) words.push(s);
    const banned = new Set(Array.from(blacklist, w => w.toLowerCase()));
    return banned.size === 0 ? words : words.filter(w => !banned.has(w.toLowerCase()));
}

export interface TabCompletionMatches {
    /** The text kept in front of the proposal (`mTabCompletionTyped.left(typePosition)`). */
    userWords: string;
    /** Candidates in Tab order, newest first; never empty. */
    matches: string[];
}

/**
 * What a Tab on `typed` can complete to, or null when desktop would do nothing:
 * nothing typed, a trailing space, or no candidate.
 *
 * The word completed is the run of word characters at the very end; a
 * candidate has to start with it (ignoring case) and carry at least one more
 * word character straight after (`^<word>\w+`), so `zq` never offers
 * `zq-thing` and `zqo` never offers `zqo'brien`. Repeats collapse only when
 * spelled exactly alike — `zqcase` and `ZQCASE` are two candidates — and each
 * candidate takes the place of its LAST occurrence, so the most recently seen
 * comes first. When the text ends in some other character there is no word,
 * desktop's `left(-1)` keeps the whole text, and any word at all is appended.
 */
export function tabCompletionMatches(typed: string, pool: readonly string[]): TabCompletionMatches | null {
    if (typed === '' || typed.endsWith(' ') || pool.length === 0) return null;
    const m = TRAILING_WORD.exec(typed);
    const lastWord = m ? m[0] : '';
    const userWords = m ? typed.slice(0, m.index) : typed;
    const lower = lastWord.toLowerCase();
    const seen = new Set<string>();
    const matches: string[] = [];
    for (let i = pool.length - 1; i >= 0; i--) {
        const w = pool[i];
        if (seen.has(w)) continue;
        if (w.length <= lastWord.length) continue;
        if (w.slice(0, lastWord.length).toLowerCase() !== lower) continue;
        if (!WORD_CHAR.test(w.slice(lastWord.length))) continue;
        seen.add(w);
        matches.push(w);
    }
    return matches.length === 0 ? null : { userWords, matches };
}

/**
 * One command line's Tab state — desktop's mTabCompletionTyped /
 * mTabCompletionCount / mTabCompletionOld. The first Tab remembers what was
 * typed; later presses complete that same text again, stepping forward (Tab)
 * or back (Shift+Tab) through the candidates and stopping at either end rather
 * than wrapping. Typing anything in between starts over from the new text.
 */
export class TabCompletionCycle {
    private typed: string | null = null;
    private count = -1;
    private lastWritten: string | null = null;

    /** Forget the cycle: Escape, Space, Enter, or an edit. */
    reset(): void {
        this.typed = null;
        this.count = -1;
        this.lastWritten = null;
    }

    /**
     * A Tab (`dir` 1) or Shift+Tab (-1) on a line holding `current`. Returns the
     * new line text and the proposal, or null when there is nothing to complete
     * (the line is then left as it is).
     */
    step(current: string, dir: 1 | -1, pool: () => readonly string[]): { text: string; proposal: string } | null {
        if (this.typed === null || this.lastWritten !== current) {
            if (current === '') return null;
            this.typed = current;
            this.count = -1;
        }
        this.count += dir;
        const found = tabCompletionMatches(this.typed, pool());
        if (!found) return null;
        this.count = Math.max(0, Math.min(this.count, found.matches.length - 1));
        const proposal = found.matches[this.count];
        const text = found.userWords + proposal;
        this.lastWritten = text;
        return { text, proposal };
    }
}
