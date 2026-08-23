/**
 * Undoing the game's own line wrapping — Mudlet's `undoServerWrap` /
 * `undoServerWrapWidth` (`TBuffer.cpp`).
 *
 * Many MUDs word-wrap their output server-side at a fixed column. That makes
 * triggers awkward to write (a phrase can be split across two "lines" that were
 * never separate) and pins the display to the game's width instead of the
 * window's. Turning the option on holds back any line that ends where the game's
 * wrapper would have broken it and glues the continuation on, so triggers and
 * rendering see one whole logical line.
 *
 * The heuristics live here as pure functions over *visible* text so they can be
 * tested directly, and so the pipeline glue in `ScriptingEngine` stays readable.
 *
 * **Visible text, not raw.** Mudlet judges `mMudLine`, which is plain characters
 * with the styling held alongside in a `TChar` buffer. mudix keeps styling
 * inline as ANSI escapes, so every predicate here takes text that has been put
 * through {@link visibleText} first — otherwise a colour-heavy line would be
 * measured as far longer than the player sees, and its escape punctuation would
 * drag the letter ratio below the prose threshold.
 */

import { scanEscape } from './ansiEscapes';

/** How far below the configured column a line may end and still count as
 *  ending *at* it. The game breaks at the last space that fits, so a wrapped
 *  segment falls up to a word short. Mudlet's `csmServerWrapSlack`. */
export const SERVER_WRAP_SLACK = 15;

/** Refuse to keep joining past this visible length — a runaway join would
 *  otherwise swallow a whole screen. Mudlet's `csmServerWrapMaxJoinedLength`. */
export const SERVER_WRAP_MAX_JOINED_LENGTH = 10000;

/** How much clear room the continuation's first word must have had on the line
 *  above before that line counts as one the game ended itself. Mudlet's
 *  `csmServerWrapFitTolerance` — only *clear* room disproves a wrap, because a
 *  segment inside the join band already sits up to {@link SERVER_WRAP_SLACK}
 *  short of the column. */
export const SERVER_WRAP_FIT_TOLERANCE = 8;

/** Longest run of digits a bare list label may carry (`1.`, `12)`, `999.`).
 *  Mudlet's `csmMaxListNumberDigits`. Bracketed labels are exempt — `[1366]` is
 *  a label however long it runs, where a bare `1364.` is as likely a price. */
export const MAX_LIST_NUMBER_DIGITS = 3;

/** How much of a held game line's opening is kept for comparing a continuation
 *  against. Mudlet's `csmServerWrapSegmentStartChars` — only the first
 *  {@link SERVER_WRAP_REPEATED_WORDS} shared words and the spaces after them
 *  have to fall inside it, and that leaves room for it even where a long name
 *  is one of them. */
export const SERVER_WRAP_SEGMENT_START_CHARS = 48;

/** How many opening words a continuation has to share with the held segment
 *  before it is a message the game re-prefixed rather than a wrap. Mudlet's
 *  `csmServerWrapRepeatedWords` — one is far too common in prose to prove
 *  anything. */
export const SERVER_WRAP_REPEATED_WORDS = 2;

/** How long a held-back line waits for its continuation before being committed
 *  on its own. Mudlet's `csmServerWrapFlushDelayMs`. */
export const SERVER_WRAP_FLUSH_DELAY_MS = 300;

/** Bounds on `undoServerWrapWidth`, matching Mudlet's `setConfig` validation
 *  (and the `qBound` its profile-XML import applies). */
export const SERVER_WRAP_WIDTH_MIN = 20;
export const SERVER_WRAP_WIDTH_MAX = 500;
/** Mudlet's `Host::mUndoServerWrapWidth` default. */
export const SERVER_WRAP_WIDTH_DEFAULT = 80;

/** Strip ANSI/OSC escapes so a line can be measured and classified the way the
 *  player sees it. Uses the shared scanner, so it skips CSI, OSC, DCS-family and
 *  short escapes alike rather than guessing at a regex. */
export function visibleText(line: string): string {
    if (!line.includes('\x1b')) return line;
    let out = '';
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\x1b') {
            const scan = scanEscape(line, i);
            // An incomplete escape runs to the end of the line — nothing visible
            // follows it, so stopping here is the same as skipping it.
            i = scan.end;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/**
 * Mudlet `TBuffer::endsAtServerWrapColumn`. True when a segment's visible length
 * lands in the `[width - slack, width]` band — i.e. where the game's own word
 * wrap would have broken it.
 */
export function endsAtServerWrapColumn(visibleLength: number, width: number): boolean {
    return visibleLength <= width && visibleLength >= width - SERVER_WRAP_SLACK;
}

const ALLOWED_FINALS = '.,;:!?\'")';
const SENTENCE_FINALS = '.!?\'")';

/**
 * Mudlet `TBuffer::looksLikeWrappedProse`. Word-wrapped prose breaks *between
 * words*, so a wrapped segment ends in a word (or a sentence mark that happened
 * to land on the wrap column) and is mostly letters. ASCII art, dividers and
 * table borders also run right up to the screen width but end in — and are full
 * of — symbols; gluing those back together would mangle them.
 *
 * `visible` must already be ANSI-stripped.
 */
export function looksLikeWrappedProse(visible: string): boolean {
    // Some games keep the space they broke at rather than swallowing it — but
    // only ever one, except right after a sentence end, where a game that puts
    // two spaces after a full stop keeps both. Any longer run of trailing
    // whitespace is padding (or a blank line), which word wrap never produces.
    let end = visible.length;
    while (end > 0 && isSpace(visible[end - 1])) end--;
    if (end === 0) return false;

    const last = visible[end - 1];
    const trailingSpaces = visible.length - end;
    if (trailingSpaces > 2) return false;
    if (trailingSpaces === 2 && !SENTENCE_FINALS.includes(last)) return false;
    if (!isLetterOrNumber(last) && !ALLOWED_FINALS.includes(last)) return false;

    let letters = 0;
    let nonSpace = 0;
    for (const c of visible) {
        if (isSpace(c)) continue;
        nonSpace++;
        if (isLetterOrNumber(c)) letters++;
    }
    // At least 60% of the non-space characters must be letters or digits.
    return nonSpace > 0 && letters * 10 >= nonSpace * 6;
}

/**
 * Mudlet `TBuffer::segmentEndsSettledSentence`. Where a game swallows the space
 * it breaks at, a segment that finishes a sentence right on the wrap column
 * looks exactly like one the game ended there itself — and games end lines on
 * sentences all the time: a room description, the exits line below it, the
 * object line below that. Joining those runs separate lines into one and breaks
 * triggers anchored to their starts.
 *
 * A kept break space is the one piece of evidence that settles it, so only a
 * sentence with nothing at all after it is refused — the check reads the very
 * last character rather than the last non-space one. What that costs is a
 * genuine wrap landing exactly after a sentence staying split, which reads as a
 * break at a sentence boundary; far cheaper than the joins it prevents.
 *
 * This belongs at the *hold* decision only: continuations legitimately end
 * sentences, so {@link looksLikeWrappedProse} must keep accepting them.
 *
 * `visible` must already be ANSI-stripped.
 */
export function segmentEndsSettledSentence(visible: string): boolean {
    if (!visible.length) return false;
    return SENTENCE_FINALS.includes(visible[visible.length - 1]);
}

/**
 * Mudlet `TBuffer::continuationRepeatsSegmentOpening`. Games that wrap a tell,
 * say or channel message themselves put the whole prefix back on every physical
 * line of it (`Anne teilt Dir mit: …`). Those lines break mid-sentence at the
 * wrap column and leave no room for the next word, so every other check reads
 * them as one wrapped paragraph and the join buries the prefix in the middle of
 * it. The repeated opening is what gives them away — two words of it, because
 * prose starts line after line with the same article or pronoun and one proves
 * nothing.
 *
 * `segmentStart` is the held *game line's* opening (see
 * {@link SERVER_WRAP_SEGMENT_START_CHARS}), not the joined paragraph's: a
 * continuation is compared against the line it actually follows.
 *
 * Both strings must already be ANSI-stripped.
 */
export function continuationRepeatsSegmentOpening(segmentStart: string, visibleNext: string): boolean {
    const comparable = Math.min(segmentStart.length, visibleNext.length);
    let i = 0;
    // A held segment can open with the space the game moved the break to rather
    // than swallowing it, and that space begins no word.
    while (i < comparable && isSpace(segmentStart[i])) i++;

    let repeatedWords = 0;
    for (; i < comparable; i++) {
        if (segmentStart[i] !== visibleNext[i]) break;
        // A word is over at the first space after it, so a run of them counts
        // once — two words shared, not one and a wide gap.
        if (isSpace(segmentStart[i]) && !isSpace(segmentStart[i - 1])) repeatedWords++;
    }
    return repeatedWords >= SERVER_WRAP_REPEATED_WORDS;
}

/**
 * Mudlet `TBuffer::startsWithListMarker`. A list entry reads exactly like
 * wrapped prose — a sentence that can end right at the wrap column — so only its
 * marker tells a list apart from a paragraph.
 *
 * Every form accepted here has to be one the game's own word wrap could not
 * produce at the start of a continuation. The ambiguous ones are deliberately
 * left out: a spaced dash opens a continuation whenever the wrap lands on it,
 * and a parenthesised number is as often an aside as a label, so it is capped at
 * {@link MAX_LIST_NUMBER_DIGITS} like a bare one. Only `[...]` is exempt from
 * the cap — nothing writes `[2500]` mid-sentence.
 *
 * `visible` must already be ANSI-stripped.
 */
export function startsWithListMarker(visible: string): boolean {
    let start = 0;
    while (start < visible.length && isSpace(visible[start])) start++;
    if (start >= visible.length) return false;

    const BULLETS = '*+•·●◦';
    if (BULLETS.includes(visible[start])) {
        return start + 1 < visible.length && visible[start + 1] === ' ';
    }

    const OPENERS = '[(';
    const CLOSERS = '])';
    const bracket = OPENERS.indexOf(visible[start]);
    const numberStart = bracket < 0 ? start : start + 1;
    let numberEnd = numberStart;
    while (numberEnd < visible.length && visible[numberEnd] >= '0' && visible[numberEnd] <= '9') numberEnd++;
    const digits = numberEnd - numberStart;
    if (!digits || numberEnd >= visible.length) return false;

    const numberFitsAList = digits <= MAX_LIST_NUMBER_DIGITS || visible[start] === '[';
    const closed = bracket >= 0
        ? visible[numberEnd] === CLOSERS[bracket]
        : (visible[numberEnd] === '.' || visible[numberEnd] === ')');
    return numberFitsAList && closed
        && numberEnd + 1 < visible.length && visible[numberEnd + 1] === ' ';
}

/**
 * Mudlet `TBuffer::pendingLineHadRoomForNextWord`. Word wrap breaks a line for
 * one reason only: the next word did not fit. So a continuation whose first word
 * would have gone on the game line above it is not a continuation at all — the
 * game ended that line itself. Without this, two sentences that each stop short
 * of the wrap column read exactly like one wrapped paragraph.
 *
 * `heldSegmentLength` is the length of the last *game line* joined into the held
 * text, not of the held text itself: once a paragraph has been joined the held
 * text is longer than the wrap column, and the line the next word would have
 * landed on is the one the game last sent.
 *
 * Both strings must already be ANSI-stripped.
 */
export function pendingLineHadRoomForNextWord(
    visiblePending: string, heldSegmentLength: number, visibleNext: string, width: number,
): boolean {
    let trailingSpaces = 0;
    while (trailingSpaces < visiblePending.length
        && isSpace(visiblePending[visiblePending.length - trailingSpaces - 1])) trailingSpaces++;
    const heldEnd = heldSegmentLength - trailingSpaces;

    let wordStart = 0;
    while (wordStart < visibleNext.length && isSpace(visibleNext[wordStart])) wordStart++;
    let wordEnd = wordStart;
    while (wordEnd < visibleNext.length && !isSpace(visibleNext[wordEnd])) wordEnd++;

    // The word starts past whatever the join will put between the two: the
    // spaces the game left on either side of the break, or the single one added
    // for it when the game swallowed it.
    const separator = Math.max(1, trailingSpaces + wordStart);
    return heldEnd + separator + (wordEnd - wordStart) + SERVER_WRAP_FIT_TOLERANCE <= width;
}

/**
 * Mudlet's guard before joining: a genuine continuation of wrapped prose starts
 * with a word — or with the single space some games move the break to instead of
 * swallowing it. *Deeper* indentation, a segment that isn't prose at all, a list
 * entry, or a first word that would have fitted on the line above all mean the
 * held line was complete after all and must be committed on its own first.
 *
 * `visibleNext` must already be ANSI-stripped.
 */
export function shouldCommitPendingBeforeJoin(
    visibleNext: string,
    nextIsProse: boolean,
    fit?: { visiblePending: string; heldSegmentLength: number; segmentStart: string; width: number },
): boolean {
    const doubleIndented = isSpace(visibleNext[0] ?? '') && visibleNext.length > 1 && isSpace(visibleNext[1]);
    if (doubleIndented || !nextIsProse || startsWithListMarker(visibleNext)) return true;
    if (!fit) return false;
    return continuationRepeatsSegmentOpening(fit.segmentStart, visibleNext)
        || pendingLineHadRoomForNextWord(
            fit.visiblePending, fit.heldSegmentLength, visibleNext, fit.width);
}

/**
 * Mudlet `TBuffer::joinPendingServerWrapOntoCurrent`. Concatenates the held line
 * and its continuation, restoring the space the game's wrapper swallowed when
 * neither side already carries one.
 *
 * Operates on the **raw** lines (escapes and all): mudix's styling is inline, so
 * a plain concatenation carries each half's colour across untouched — the
 * `TChar`-buffer splice Mudlet needs has no equivalent here. The space-insertion
 * test looks at the visible text so a trailing colour reset can't hide the space
 * that is already there.
 */
export function joinWrappedLines(pending: string, next: string): string {
    const pendingVisible = visibleText(pending);
    const nextVisible = visibleText(next);
    const needsSpace = !pendingVisible.endsWith(' ') && !nextVisible.startsWith(' ');
    return needsSpace ? `${pending} ${next}` : pending + next;
}

// Unicode-aware, matching QChar::isSpace — JS `\s` covers NBSP and the U+2000
// space family as well as the ASCII controls.
function isSpace(c: string): boolean {
    return /\s/u.test(c);
}

function isLetterOrNumber(c: string): boolean {
    // Unicode-aware, matching QChar::isLetterOrNumber — a MUD may well be
    // sending accented or non-Latin prose.
    return /[\p{L}\p{N}]/u.test(c);
}

// ── auto-detection ──────────────────────────────────────────────────────────
// Mudlet `TBuffer::recordLineLengthForWrapDetection`: while the option is off,
// watch how game line lengths pile up. If they stack against a stable ceiling
// column, the game is almost certainly wrapping its own output, and it's worth
// telling the user once that the option exists.

/** Lines shorter than this carry no signal about a wrap column. */
export const WRAP_DETECT_MIN_LENGTH = 40;
/** Evaluate the collected sample only once every this many recorded lines. */
export const WRAP_DETECT_SAMPLE_INTERVAL = 100;
/** How many lines must sit at the ceiling before it's believable. */
export const WRAP_DETECT_THRESHOLD = 40;
/** A plausible wrap column has to fall in this range. */
export const WRAP_DETECT_CEILING_MIN = 60;
export const WRAP_DETECT_CEILING_MAX = 160;
/** How far below the ceiling still counts as "at" it, when tallying support. */
const WRAP_DETECT_CEILING_BAND = 8;
/** More than this many lines *longer* than the ceiling disproves it. */
const WRAP_DETECT_MAX_BEYOND = 2;

/**
 * Given the tally of observed line lengths, report the game's apparent wrap
 * column, or null when the evidence doesn't support one.
 *
 * The ceiling is the longest length seen more than incidentally (≥3 times); it
 * has to be a plausible screen width, carry enough lines just below it, and have
 * almost nothing beyond it — a game that regularly emits longer lines is not
 * wrapping at that column.
 */
export function detectWrapCeiling(counts: ReadonlyMap<number, number>): number | null {
    let ceiling = 0;
    for (const [length, count] of counts) {
        if (count >= 3 && length > ceiling) ceiling = length;
    }
    if (ceiling < WRAP_DETECT_CEILING_MIN || ceiling > WRAP_DETECT_CEILING_MAX) return null;

    let atCeiling = 0;
    let beyondCeiling = 0;
    for (const [length, count] of counts) {
        if (length > ceiling) beyondCeiling += count;
        else if (length >= ceiling - WRAP_DETECT_CEILING_BAND) atCeiling += count;
    }
    if (atCeiling < WRAP_DETECT_THRESHOLD || beyondCeiling > WRAP_DETECT_MAX_BEYOND) return null;
    return ceiling;
}
