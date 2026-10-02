// @vitest-environment node
//
// The main console wraps a long server line where desktop Mudlet does
// (mudlet-web#281): columns are counted with Mudlet's width table, one width
// per grapheme taken from its base character, and a line breaks only where Qt's
// line breaker (QTextBoundaryFinder::Line) allows. Every expectation marked
// "desktop" was measured on Mudlet 5.0.0 PTB against the same server line.
import { describe, it, expect } from 'vitest';
import { Console } from '../../../src/mud/text/Console';
import { AnsiAwareBuffer } from '../../../src/mud/text/FormatState';
import { codePointWidth, clusterWidth } from '../../../src/mud/text/wcwidth';
import { lineBreakOpportunities } from '../../../src/mud/text/lineBreak';

/** Wrap `text` as a server line at Mudlet's default width; code points per stored line. */
function wrapped(text: string, width = 100): number[] {
    return wrappedLines(text, width).map(line => [...line].length);
}

function wrappedLines(text: string, width = 100): string[] {
    const console = new Console();
    console.setWrapWidth(width);
    const buffer = new AnsiAwareBuffer().append(text);
    console.appendLine(buffer);
    return console.wrapAppendedLine(buffer).map(line => line.text);
}

/** Offsets inside `text` Qt's line breaker allows a break before. */
function breaksOf(text: string): number[] {
    const breaks = lineBreakOpportunities(text);
    const out: number[] = [];
    for (let i = 1; i < text.length; i++) if (breaks[i]) out.push(i);
    return out;
}

describe('column widths match desktop', () => {
    it('counts U+2764 HEAVY BLACK HEART two wide, as Mudlet overrides it', () => {
        expect(codePointWidth(0x2764)).toBe(2);
        expect(wrapped('K1 ' + '❤'.repeat(60))).toEqual([51, 12]); // desktop
    });

    it('measures a heart with VS16 by its base character', () => {
        expect(clusterWidth('❤️')).toBe(2);
        expect(wrapped('K2 ' + '❤️'.repeat(60))).toEqual([99, 24]); // desktop
    });

    it('gives a soft hyphen no width', () => {
        expect(codePointWidth(0xad)).toBe(0);
        expect(wrapped('K3 ' + 'abcdefgh­'.repeat(12))).toEqual([111]); // desktop: one line
    });

    it('keeps the widths desktop already agreed on', () => {
        expect(clusterWidth('漢')).toBe(2);
        expect(clusterWidth('Ａ')).toBe(2); // fullwidth form
        expect(clusterWidth('😀')).toBe(2);
        expect(clusterWidth('🇵🇱')).toBe(1); // regional indicators are in no wide table

        expect(clusterWidth('👍🏽')).toBe(2);
        expect(clusterWidth('👨‍👩‍👧')).toBe(2);
        expect(clusterWidth('é')).toBe(1);
        expect(codePointWidth(0x200b)).toBe(0);
    });
});

describe('break points match desktop', () => {
    it('breaks after an em dash, en dash or U+2010 rather than mid-word', () => {
        for (const dash of ['—', '–', '‐']) {
            expect(wrapped('D1 ' + ('abcdefgh' + dash).repeat(12))).toEqual([93, 18]); // desktop
        }
    });

    it('breaks after a zero-width space', () => {
        // 7 letters + a ZWSP that takes no column: 14 words fill 98 columns.
        const words = Array.from({ length: 30 }, () => 'abcdefg').join('​');
        expect(wrapped(words)).toEqual([112, 112, 15]);
    });

    it('breaks between ☺ and between €, which Qt classes ID and PR', () => {
        expect(wrapped('S1 ' + '☺'.repeat(110))).toEqual([100, 13]); // desktop
        expect(wrapped('S1 ' + '€'.repeat(110))).toEqual([100, 13]); // desktop
    });

    it('does not break between ⭐, which Qt classes AL', () => {
        expect(wrapped('S1 ' + '⭐'.repeat(55))).toEqual([3, 50, 5]); // desktop
    });

    it("keeps ConsoleWrap_spec's break points", () => {
        expect(wrappedLines('the quick brown fox jumps over the lazy dog', 20)).toEqual(['the quick brown fox ', 'jumps over the lazy ', 'dog']);
        expect(wrappedLines('abcd-efghijkl', 10)).toEqual(['abcd-', 'efghijkl']);
        expect(wrappedLines('abcé-efghijkl', 10)).toEqual(['abcé-', 'efghijkl']);
        expect(wrappedLines('日本語のテキストです', 10)).toEqual(['日本語のテ', 'キストです']);
        expect(wrappedLines('aaaa      bbbb', 8)).toEqual(['aaaa    ', 'bbbb']);
        expect(wrappedLines('abcdefghijklmnopqrst', 10)).toEqual(['abcdefghij', 'klmnopqrst']);
        expect(wrappedLines('abc', 1)).toEqual(['a', 'b', 'c']);
    });

    it('breaks a zero-width-space separated run after each ZWSP', () => {
        expect(breaksOf('ab​cd​ef')).toEqual([3, 6]);
    });

    it('breaks Thai text without spaces between words, not mid-word', () => {
        const thai = 'ภาษาไทยเป็นภาษาที่มีระดับเสียง'; // "Thai is a tonal language"
        const breaks = breaksOf(thai);
        expect(breaks.length).toBeGreaterThan(2);
        expect(breaks).toContain('ภาษาไทย'.length);
        // Desktop hands Thai to libthai's dictionary; this is ICU's, so only
        // the shape is pinned: a break between two words, not a hard cut.
        const lines = wrappedLines('T1 ' + thai.repeat(6));
        expect(lines.length).toBe(2);
        const cut = lines[0].length;
        expect(breaksOf('T1 ' + thai.repeat(6))).toContain(cut);
        expect(['ภาษา', 'ไทย', 'เป็น', 'ที่', 'มี', 'ระดับ', 'เสียง'].some(w => lines[0].endsWith(w))).toBe(true);
    });
});

/**
 * Mudlet's lineBreakInfo::asciiLineBreaks (TTextProperties.h): Qt's line
 * breaker cut down to printable ASCII, which Mudlet's AsciiLineBreakTest checks
 * against the Qt it links. Ported here only as an oracle for the full port.
 */
function mudletAsciiLineBreaks(text: string): number[] {
    const [OP, CL, CP, QU, QU19, EX, SY, IS, PR, PO, NU, AL, HY, WSHY, BA, SP, SOT] = [...Array(17).keys()];
    const classOf = (c: string): number => {
        switch (c) {
            case ' ': return SP;
            case '!': case '?': return EX;
            case '"': case "'": return QU;
            case '$': case '+': case '\\': return PR;
            case '%': return PO;
            case '(': case '[': case '{': return OP;
            case ')': case ']': return CP;
            case '}': return CL;
            case ',': case '.': case ':': case ';': return IS;
            case '-': return HY;
            case '/': return SY;
            case '|': return BA;
            default: return c >= '0' && c <= '9' ? NU : AL;
        }
    };
    const [DB, IB, PB, DN] = [0, 1, 2, 3];
    const T = [
        [PB, PB, PB, PB, PB, PB, PB, PB, PB, PB, PB, PB, PB, PB, PB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, DB, DB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, IB, IB, IB, IB, IB],
        [IB, PB, PB, IB, IB, PB, PB, PB, IB, IB, IB, IB, IB, IB, IB],
        [IB, PB, PB, IB, IB, PB, PB, PB, IB, IB, IB, IB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, DB, DB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, DB, DB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DN, DB, IB, IB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, IB, IB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, IB, IB, IB, IB, IB],
        [IB, PB, PB, IB, IB, PB, PB, PB, IB, IB, IB, IB, IB, IB, IB],
        [IB, PB, PB, IB, IB, PB, PB, PB, IB, IB, IB, IB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, IB, DB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, IB, IB, IB, IB, IB],
        [DB, PB, PB, IB, IB, PB, PB, PB, DB, DB, DB, DB, IB, IB, IB],
    ];
    const [None, Start, Continue, Break, NeedOPNU, CNeedNU, CNeedISNU] = [0, 1, 2, 3, 4, 5, 6];
    const [XX, PRPO, nOP, nHY, nNU, nSY, nIS, CLCP] = [0, 1, 2, 3, 4, 5, 6, 7];
    const A = [
        [None, NeedOPNU, Start, None, Start, None, None, None],
        [None, NeedOPNU, Continue, Break, Start, None, None, None],
        [None, Start, Start, Break, Continue, None, Continue, None],
        [None, None, None, Start, Continue, None, None, None],
        [Break, Break, Break, Break, Continue, Continue, Continue, Continue],
        [Break, Break, Break, Break, Continue, Continue, Continue, Continue],
        [Break, Break, Break, Break, Continue, Continue, Continue, Continue],
        [Break, Continue, Break, Break, Break, Break, Break, Break],
    ];
    const toNs = (c: number) => c === PR || c === PO ? PRPO : c === OP ? nOP : c === HY ? nHY : c === NU ? nNU
        : c === SY ? nSY : c === IS ? nIS : c === CL || c === CP ? CLCP : XX;
    const len = text.length;
    const breaks = new Array<boolean>(len + 1).fill(false);
    const clearInside = (from: number, to: number) => { for (let j = from + 1; j < to; j++) breaks[j] = false; };
    let nestart = 0, nelast = XX, neactlast = None, lcls = SOT, cls = SOT;
    for (let i = 0; i < len; i++) {
        let ncls = classOf(text[i]);
        if (ncls === HY && (lcls === SP || lcls === SOT)) ncls = WSHY;
        if (ncls === IS && lcls === SP && i + 1 < len && classOf(text[i + 1]) === NU) {
            breaks[i] = true;
            cls = lcls = ncls;
            continue;
        }
        {
            const necur = toNs(ncls);
            let neact = A[nelast][necur];
            if (neactlast === CNeedNU && necur !== nNU) neact = None;
            else if (neactlast === NeedOPNU) neact = necur === nOP ? CNeedISNU : necur === nNU ? Continue : None;
            else if (neactlast === CNeedISNU) neact = necur === nIS ? CNeedNU : necur === nNU ? Continue : None;
            if (neact === Break) { clearInside(nestart, i); nelast = XX; }
            else if (neact === None) nelast = XX;
            else if (neact === NeedOPNU || neact === Start) {
                if (neactlast === Start || neactlast === Continue) clearInside(nestart, i);
                nestart = i;
                nelast = necur;
            } else nelast = necur;
            neactlast = neact;
        }
        if (ncls === QU && lcls !== SP) ncls = QU19;
        if (lcls === SOT) { cls = ncls === SP ? AL : ncls; lcls = ncls; continue; }
        if (ncls === SP) { lcls = SP; continue; }
        if ((ncls === QU || ncls === QU19 || cls === QU) && lcls !== SP) { cls = lcls = ncls; continue; }
        const act = T[cls][ncls];
        if (act === DB) breaks[i] = true;
        else if (act === IB) { if (lcls === SP) breaks[i] = true; }
        else if (act === DN) { if (neactlast === None || neactlast > Break) breaks[i] = true; }
        cls = lcls = ncls;
    }
    if (A[nelast][XX] === Break) clearInside(nestart, len);
    const out: number[] = [];
    for (let i = 1; i < len; i++) if (breaks[i]) out.push(i);
    return out;
}

describe('plain ASCII break points', () => {
    it("agree with Mudlet's ASCII breaker on game-like text", () => {
        const corpus = [
            'see a/b and x-y, (z) 3.14 $5',
            '"quoted" word and \'single\' -- dashes - here',
            'You have 1,234.56 gold (and $12) or 50% off: -5 +3 [ok] {x}!',
            'http://example.com/path?q=1|2 foo\\bar',
            ' leading space, then .5 and -word and a-b-c',
            'HP:100/120 MP:45/80 [####----] (95%)',
        ];
        for (const line of corpus) expect(breaksOf(line)).toEqual(mudletAsciiLineBreaks(line));
    });

    it("agree with Mudlet's ASCII breaker on random printable ASCII", () => {
        let seed = 281;
        const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
        const alphabet = ' !"#$%&\'()*+,-./0123456789:;<=>?@AZaz[\\]^_`{|}~  aa11';
        for (let n = 0; n < 3000; n++) {
            const length = 1 + Math.floor(rand() * 24);
            let line = '';
            for (let k = 0; k < length; k++) line += alphabet[Math.floor(rand() * alphabet.length)];
            expect(breaksOf(line), JSON.stringify(line)).toEqual(mudletAsciiLineBreaks(line));
        }
    });
});
