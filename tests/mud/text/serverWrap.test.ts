import { describe, it, expect } from 'vitest';
import {
    visibleText,
    endsAtServerWrapColumn,
    looksLikeWrappedProse,
    shouldCommitPendingBeforeJoin,
    segmentEndsSettledSentence,
    continuationRepeatsSegmentOpening,
    joinWrappedLines,
    detectWrapCeiling,
    SERVER_WRAP_SLACK,
    WRAP_DETECT_THRESHOLD,
} from '../../../src/mud/text/serverWrap';

// The heuristics behind Mudlet's `undoServerWrap` (TBuffer.cpp). These decide
// whether a line the game sent is a whole line or half of one it wrapped itself
// — get them wrong and either prose stays split or ASCII art gets glued into
// mush, so each rule is pinned individually.

describe('visibleText', () => {
    it('returns the line untouched when it holds no escapes', () => {
        expect(visibleText('You see a cat.')).toBe('You see a cat.');
    });

    it('strips SGR colour so length reflects what the player sees', () => {
        expect(visibleText('\x1b[32mgreen\x1b[0m text')).toBe('green text');
    });

    it('strips OSC 8 hyperlinks, payload and all', () => {
        expect(visibleText('\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
    });

    it('drops an escape cut off by the end of the line', () => {
        expect(visibleText('tail\x1b[')).toBe('tail');
    });
});

describe('endsAtServerWrapColumn', () => {
    const WIDTH = 80;

    it('accepts a line ending exactly at the column', () => {
        expect(endsAtServerWrapColumn(WIDTH, WIDTH)).toBe(true);
    });

    // The game breaks at the last space that fits, so a wrapped segment falls
    // up to a word short of the column.
    it('accepts a line up to the slack allowance short of the column', () => {
        expect(endsAtServerWrapColumn(WIDTH - SERVER_WRAP_SLACK, WIDTH)).toBe(true);
        expect(endsAtServerWrapColumn(WIDTH - SERVER_WRAP_SLACK + 1, WIDTH)).toBe(true);
    });

    it('rejects a line that falls further short than the slack', () => {
        expect(endsAtServerWrapColumn(WIDTH - SERVER_WRAP_SLACK - 1, WIDTH)).toBe(false);
        expect(endsAtServerWrapColumn(10, WIDTH)).toBe(false);
    });

    it('rejects a line past the column — the game would have broken it', () => {
        expect(endsAtServerWrapColumn(WIDTH + 1, WIDTH)).toBe(false);
    });
});

describe('looksLikeWrappedProse', () => {
    it('accepts ordinary prose ending in a word', () => {
        expect(looksLikeWrappedProse('The tall grass sways in the evening breeze and')).toBe(true);
    });

    it('accepts prose ending on a sentence mark that landed at the column', () => {
        expect(looksLikeWrappedProse('You hear something moving in the undergrowth.')).toBe(true);
    });

    it('accepts a single trailing space — some games keep the break space', () => {
        expect(looksLikeWrappedProse('a wooden door stands slightly ajar ')).toBe(true);
    });

    it('accepts two trailing spaces only after a sentence end', () => {
        expect(looksLikeWrappedProse('The door is shut.  ')).toBe(true);
        expect(looksLikeWrappedProse('a shut wooden door  ')).toBe(false);
    });

    it('rejects a longer run of trailing whitespace — that is padding', () => {
        expect(looksLikeWrappedProse('centered title    ')).toBe(false);
    });

    it('rejects a blank or whitespace-only line', () => {
        expect(looksLikeWrappedProse('')).toBe(false);
        expect(looksLikeWrappedProse('     ')).toBe(false);
    });

    it('rejects dividers and ASCII art, which also run to the screen width', () => {
        expect(looksLikeWrappedProse('='.repeat(78))).toBe(false);
        expect(looksLikeWrappedProse('+----------+----------+')).toBe(false);
        expect(looksLikeWrappedProse('/\\_/\\  (o.o)  >^<  ~~~~')).toBe(false);
    });

    it('rejects a symbol-heavy status bar even though it ends in a digit', () => {
        expect(looksLikeWrappedProse('[HP:100/100] [MP:55/60] [EX:12.4%] <><><> 42')).toBe(false);
    });

    it('accepts non-Latin prose (QChar::isLetterOrNumber is Unicode-aware)', () => {
        expect(looksLikeWrappedProse('Wąska ścieżka wije się przez gęsty las i')).toBe(true);
    });
});

describe('shouldCommitPendingBeforeJoin', () => {
    it('joins a continuation that starts with a word', () => {
        expect(shouldCommitPendingBeforeJoin('vanishes into the trees.', true)).toBe(false);
    });

    it('joins a continuation that starts with the single break space', () => {
        expect(shouldCommitPendingBeforeJoin(' vanishes into the trees.', true)).toBe(false);
    });

    it('refuses to join a more deeply indented line — that is a new block', () => {
        expect(shouldCommitPendingBeforeJoin('   Centered Heading', true)).toBe(true);
    });

    it('refuses to join a line that is not prose at all', () => {
        expect(shouldCommitPendingBeforeJoin('======================', false)).toBe(true);
    });
});

describe('segmentEndsSettledSentence', () => {
    // The whole point is that it reads the LAST character rather than the last
    // non-space one: a kept break space is the evidence that the game wrapped
    // there rather than ending the line itself.
    it('refuses a segment that stops dead on a full stop', () => {
        expect(segmentEndsSettledSentence('Es gibt drei sichtbare Ausgaenge: osten, westen und sueden.'))
            .toBe(true);
    });

    it('refuses the other marks that finish a sentence', () => {
        for (const line of ['What a day!', 'Where now?', 'he said "run"', "it was 'over'", 'a note (here)']) {
            expect(segmentEndsSettledSentence(line)).toBe(true);
        }
    });

    it('holds a segment that stops mid-sentence', () => {
        expect(segmentEndsSettledSentence('nickt Dir kurz zu und laechelt dabei,')).toBe(false);
    });

    it('holds a sentence whose break space the game kept', () => {
        expect(segmentEndsSettledSentence('so viel aus, wie ein Hund! ')).toBe(false);
        expect(segmentEndsSettledSentence('alpha.  ')).toBe(false);
    });

    it('holds an empty segment — there is no sentence to have finished', () => {
        expect(segmentEndsSettledSentence('')).toBe(false);
    });
});

describe('continuationRepeatsSegmentOpening', () => {
    it('parts a message the game re-prefixed on every line', () => {
        expect(continuationRepeatsSegmentOpening(
            'Anne sagt: Ich habe Dir etwas Wichtiges zu erzaehlen',
            'Anne sagt: Hoere gut zu, denn es ist wichtig.')).toBe(true);
    });

    it('joins prose that merely opens with the same word twice', () => {
        // German prose starts line after line with the same pronoun; one shared
        // word proves nothing.
        expect(continuationRepeatsSegmentOpening(
            'Du bist bis zu den ersten Haeusern der Stadt vorgedrungen',
            'Du weitere Gebaeude vermutest.')).toBe(false);
    });

    it('does not count a wide gap as a second shared word', () => {
        expect(continuationRepeatsSegmentOpening('Anne   sagt hello', 'Anne   sagt goodbye')).toBe(true);
        expect(continuationRepeatsSegmentOpening('Anne   hello', 'Anne   goodbye')).toBe(false);
    });

    it('skips the break space a leading-space game puts on every segment', () => {
        // Both open with that space, so it begins no word and " der Laerm" and
        // " der Duft" share one word, not two.
        expect(continuationRepeatsSegmentOpening(
            ' der Laerm der vielen Stimmen dringt', ' der Duft von Gewuerzen liegt')).toBe(false);
    });
});

describe('joinWrappedLines', () => {
    it('restores the space the wrapper swallowed', () => {
        expect(joinWrappedLines('the tall grass sways and', 'rustles quietly.'))
            .toBe('the tall grass sways and rustles quietly.');
    });

    it('does not double the space when the held line kept it', () => {
        expect(joinWrappedLines('the tall grass sways and ', 'rustles quietly.'))
            .toBe('the tall grass sways and rustles quietly.');
    });

    it('does not double the space when the continuation carries it', () => {
        expect(joinWrappedLines('the tall grass sways and', ' rustles quietly.'))
            .toBe('the tall grass sways and rustles quietly.');
    });

    // mudix keeps styling inline, so a plain concatenation carries each half's
    // colour across — no TChar-buffer splice needed. The space test still has to
    // read through the escapes, or a trailing reset would hide an existing space.
    it('preserves inline colour on both halves', () => {
        expect(joinWrappedLines('\x1b[32mgreen and', '\x1b[0mplain.'))
            .toBe('\x1b[32mgreen and \x1b[0mplain.');
    });

    it('sees a space hidden behind a trailing escape', () => {
        expect(joinWrappedLines('green and \x1b[0m', 'plain.'))
            .toBe('green and \x1b[0mplain.');
    });
});

describe('detectWrapCeiling', () => {
    /** A game wrapping at `col`: plenty of lines just under it, none past it. */
    const wrappingGame = (col: number, n = WRAP_DETECT_THRESHOLD) => {
        const counts = new Map<number, number>();
        for (let i = 0; i < n; i++) {
            const len = col - (i % 6); // clusters within the ceiling band
            counts.set(len, (counts.get(len) ?? 0) + 1);
        }
        return counts;
    };

    it('reports the ceiling when lines pile up against it', () => {
        expect(detectWrapCeiling(wrappingGame(80))).toBe(80);
    });

    it('returns null when too few lines reach the ceiling', () => {
        expect(detectWrapCeiling(wrappingGame(80, 12))).toBeNull();
    });

    it('returns null when the game regularly sends longer lines', () => {
        const counts = wrappingGame(80);
        counts.set(120, 5); // more than the tolerated couple of stragglers
        expect(detectWrapCeiling(counts)).toBeNull();
    });

    it('tolerates a couple of stragglers past the ceiling', () => {
        const counts = wrappingGame(80);
        counts.set(140, 1);
        // 140 is seen once, so it never becomes the ceiling itself, and one
        // line beyond 80 is within tolerance.
        expect(detectWrapCeiling(counts)).toBe(80);
    });

    it('ignores a ceiling outside a plausible screen width', () => {
        expect(detectWrapCeiling(wrappingGame(50))).toBeNull();
        expect(detectWrapCeiling(wrappingGame(200))).toBeNull();
    });

    it('returns null for an empty sample', () => {
        expect(detectWrapCeiling(new Map())).toBeNull();
    });
});
