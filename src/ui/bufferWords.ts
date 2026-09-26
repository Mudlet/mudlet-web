// Tab-completion of argument words from recently-seen output. The companion to
// commandHistory.ts: history completes whole *commands* (the first word), this
// completes the *current word* against the pool of words the MUD has recently
// printed. CommandBar routes between the two by word position (Option 1).

import type { MudSession } from '../mud/MudSession';
import { AnsiAwareBuffer } from '../mud/text/FormatState';

/** Shortest word worth indexing. Single chars complete to too much noise. */
const MIN_WORD_LEN = 2;
/** Cap on distinct words retained — bounds memory on long sessions. */
const MAX_WORDS = 4000;
/** Cap on cycle candidates so Tab can't spin through thousands of matches. */
const MATCH_LIMIT = 200;

// Unicode-aware token (letters/digits/underscore). An ASCII \w would miss the
// accented words on non-English MUDs (e.g. Polish ą/ł/ż).
const WORD_RE = new RegExp(`[\\p{L}\\p{N}_]{${MIN_WORD_LEN},}`, 'gu');

// Transient partial lines (a script echo built up char-by-char) are re-emitted
// whole, so indexing the partials would just seed truncated words. Mirrors the
// same skip in SessionLogger.
const SKIP_TYPES = new Set(['script-partial']);

/**
 * Maintains a bounded, recency-ordered set of words seen in session output.
 * Subscribes to the `message` event — the single choke point every output line
 * passes through (the same tap SessionLogger uses) — so it captures MUD text,
 * script echoes, and trigger output alike. One instance per session.
 */
export class BufferWordIndex {
    // Lowercase key -> original-cased word. Map insertion order *is* the recency
    // order (oldest first); re-seeing a word deletes + re-inserts it at the tail.
    private readonly words = new Map<string, string>();
    private unsubscribe: (() => void) | null = null;

    constructor(private readonly session: MudSession) {}

    start(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = this.session.events.on('message', (text, type) => this.ingest(text, type));
    }

    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    private ingest(text?: string | AnsiAwareBuffer, type?: string): void {
        if (text === undefined || text === null) return;
        if (SKIP_TYPES.has(type ?? '')) return;

        // Strip ANSI from raw strings (route through a buffer only when an escape
        // is actually present — most echoes/errors are plain). Buffers already
        // expose clean plain text via `.text`.
        const plain = typeof text === 'string'
            ? (text.includes('\x1b') ? new AnsiAwareBuffer(text).text : text)
            : text.text;
        if (!plain) return;

        const found = plain.match(WORD_RE);
        if (!found) return;
        for (const word of found) {
            const key = word.toLowerCase();
            this.words.delete(key);
            this.words.set(key, word);
        }
        while (this.words.size > MAX_WORDS) {
            const oldest = this.words.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.words.delete(oldest);
        }
    }

    /** Words in recency order, newest first. */
    getWords(): string[] {
        const out = Array.from(this.words.values());
        out.reverse();
        return out;
    }
}

export interface ActiveWord {
    /** Everything before the trailing word (unchanged by completion). */
    prefix: string;
    /** The trailing word the user is typing. */
    word: string;
}

/** Splits the trailing word being typed from its leading text. Returns null when
 *  the command is empty or ends in whitespace/punctuation (nothing to complete). */
export function splitTrailingWord(command: string): ActiveWord | null {
    const m = command.match(/[\p{L}\p{N}_]+$/u);
    if (!m) return null;
    const word = m[0];
    return { prefix: command.slice(0, command.length - word.length), word };
}

/**
 * Prefix-matches `word` against several candidate lists, tried in priority order
 * (e.g. suggestions, then buffer words). Case-insensitive,
 * de-duplicated across all lists, excludes the exact word already typed. Matching
 * is **prefix-only** — never subsequence — so a completion always literally starts
 * with what was typed. The returned order is the Tab cycle order.
 */
export function matchWordCandidates(
    word: string,
    lists: string[][],
    limit = MATCH_LIMIT,
): string[] {
    const lower = word.toLowerCase();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
        for (const candidate of list) {
            if (out.length >= limit) return out;
            const k = candidate.toLowerCase();
            if (k === lower) continue;          // exact — adds nothing
            if (!k.startsWith(lower)) continue;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(candidate);
        }
    }
    return out;
}
