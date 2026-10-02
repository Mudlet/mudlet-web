/**
 * Line-break opportunities, as desktop Mudlet finds them.
 *
 * Mudlet's TBuffer::getWrapInfo picks where a too-long line breaks by asking
 * QTextBoundaryFinder(QTextBoundaryFinder::Line) — Qt's own implementation of
 * the Unicode line breaking algorithm (UAX #14), not ICU's. The two differ in
 * enough places (Qt still runs the old pair-table formulation, resolves AI and
 * XX to AL, and has its own LB25 number state machine) that neither the
 * browser's ICU nor a fresh UAX #14 implementation would land every break where
 * desktop does. So this is a port of `getLineBreaks()` in Qt 6.11's
 * qunicodetools.cpp, statement for statement, over the property data Qt
 * generates from its UCD files (see scripts/generate-unicode-tables.mjs).
 *
 * Qt's one script tailoring that moves line breaks for text a game is likely
 * to send is Thai, which it hands to libthai's dictionary. The browser has no
 * libthai; the Thai runs are segmented with `Intl.Segmenter`'s ICU dictionary
 * instead, which agrees on ordinary words but is not the same dictionary.
 * Myanmar's syllable tailoring is not ported.
 */
import { runLookup } from './unicodeRuns';
import { LINE_BREAK_PAIRS, LINE_BREAK_RUNS } from './unicodeTables.generated';

const props = runLookup(LINE_BREAK_RUNS, n => new Uint16Array(n));

// Qt's QUnicodeTables::LineBreakClass, in enum order.
const OP = 0, QU = 3, QU_Pi = 4, QU_Pf = 5, QU_19 = 6, GL = 7, CL = 1, CP = 2, EX = 9, SY = 10, IS = 11, PR = 12,
    PO = 13, NU = 14, AL = 15, HL = 16, HY = 19, WS_HY = 20, HH = 21, WS_BA = 23, HYBA = 24, ZW = 27, CM = 28,
    WJ = 29, RI = 35, CB = 36, EM = 38, AK = 39, AP = 40, AS = 41, VI = 42, VF = 43, ZWJ = 44, SA = 45, SG = 46,
    SP = 47, CR = 48, LF = 49, BK = 50;

// Property bits (see the generated file's header).
const LBC_MASK = 0x3f;
const EA_BIT = 1 << 6;
const CAT_SHIFT = 7;
const CAT_PI = 1, CAT_PF = 2, CAT_MARK = 3;
const EXTPICT_CN_BIT = 1 << 9;
const SCRIPT_SHIFT = 10;
const SCRIPT_THAI = 1;
const ME_BIT = 1 << 12;

const category = (p: number) => (p >> CAT_SHIFT) & 3;
const PROPS_LF = 0;
const PROPS_A = 1;
let fixedProps: Uint16Array | null = null;
const fixed = (which: number): number => {
    fixedProps ??= Uint16Array.of(props(0x0a), props(0x41));
    return fixedProps[which];
};

// The pair table's actions, as the letters the generator writes.
const PAIR_COLUMNS = ZWJ;
const A_PB = 80, A_DB = 68, A_IB = 73, A_CI = 67, A_CP = 88, A_HH = 72, A_IN = 78, A_DN = 85; // 'P' 'D' 'I' 'C' 'X' 'H' 'N' 'U'

// LB25's number-sequence state machine (LB::NS).
const NS_None = 0, NS_Start = 1, NS_Continue = 2, NS_Break = 3, NS_NeedOPNU = 4, NS_CNeedNU = 5, NS_CNeedISNU = 6;
const NS_XX = 0, NS_PRPO = 1, NS_OP = 2, NS_HY = 3, NS_NU = 4, NS_SY = 5, NS_IS = 6, NS_CLCP = 7;
const NS_ACTIONS: readonly (readonly number[])[] = [
    //  XX         PRPO         OP           HY        NU           SY           IS           CLCP
    [NS_None, NS_NeedOPNU, NS_Start, NS_None, NS_Start, NS_None, NS_None, NS_None], // XX
    [NS_None, NS_NeedOPNU, NS_Continue, NS_Break, NS_Start, NS_None, NS_None, NS_None], // PRPO
    [NS_None, NS_Start, NS_Start, NS_Break, NS_Continue, NS_None, NS_Continue, NS_None], // OP
    [NS_None, NS_None, NS_None, NS_Start, NS_Continue, NS_None, NS_None, NS_None], // HY
    [NS_Break, NS_Break, NS_Break, NS_Break, NS_Continue, NS_Continue, NS_Continue, NS_Continue], // NU
    [NS_Break, NS_Break, NS_Break, NS_Break, NS_Continue, NS_Continue, NS_Continue, NS_Continue], // SY
    [NS_Break, NS_Break, NS_Break, NS_Break, NS_Continue, NS_Continue, NS_Continue, NS_Continue], // IS
    [NS_Break, NS_Continue, NS_Break, NS_Break, NS_Break, NS_Break, NS_Break, NS_Break], // CLCP
];
function nsClass(lbc: number): number {
    switch (lbc) {
        case PR: case PO: return NS_PRPO;
        case OP: return NS_OP;
        case HY: return NS_HY;
        case NU: return NS_NU;
        case SY: return NS_SY;
        case IS: return NS_IS;
        case CL: case CP: return NS_CLCP;
        default: return NS_XX;
    }
}

// LB28a's Brahmic orthographic syllable states (LB::BRS).
const DOTTED_CIRCLE = 0x25cc;
const BRS_None = 0, BRS_Start = 1, BRS_2VF = 2, BRS_2VI = 3, BRS_3VIAK = 4, BRS_4 = 5, BRS_4VF = 6, BRS_Restart = 7;
function brsUpdate(state: number, lbc: number, ucs4: number): number {
    if (lbc === CM) return state;
    switch (state) {
        case BRS_Start:
            if (lbc === VF) return BRS_2VF;
            if (lbc === VI) return BRS_2VI;
            if (ucs4 === DOTTED_CIRCLE || lbc === AK || lbc === AS) return BRS_4;
            break;
        case BRS_2VI:
            if (ucs4 === DOTTED_CIRCLE || lbc === AK) return BRS_3VIAK;
            break;
        case BRS_4:
            if (lbc === VF) return BRS_4VF;
            return BRS_Restart;
        case BRS_None:
            if (ucs4 === DOTTED_CIRCLE || lbc === AK || lbc === AS) return BRS_Start;
            break;
    }
    return BRS_None;
}

const LB15A = new Set([BK, CR, LF, OP, QU, QU_Pi, QU_Pf, GL, SP, ZW]);
const LB15B = new Set([SP, GL, WJ, CL, QU, QU_Pi, QU_Pf, CP, EX, IS, SY, BK, CR, LF, ZW]);

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

/**
 * Where `text` may break: `breaks[p]` is 1 when a line may start at UTF-16
 * offset `p`. `breaks[0]` is 0 and `breaks[text.length]` is 1, as in Qt.
 */
export function lineBreakOpportunities(text: string): Uint8Array {
    const len = text.length;
    const breaks = new Uint8Array(len + 1);
    if (len === 0) {
        breaks[0] = 1;
        return breaks;
    }
    const clear = (from: number, to: number) => {
        for (let j = from; j < to; j++) breaks[j] = 0;
    };
    const rawClass = (c: number) => props(c) & LBC_MASK;

    let nestart = 0;
    let nelast = NS_XX;
    let neactlast = NS_None;
    let brsState = BRS_None;
    let brsStart = 0;

    let lcls = LF; // to meet LB10
    let cls = lcls;
    let lastProp = fixed(PROPS_LF);

    for (let i = 0; i !== len; ++i) {
        const pos = i;
        let ucs4 = text.charCodeAt(i);
        if (isHigh(ucs4) && i + 1 !== len) {
            const low = text.charCodeAt(i + 1);
            if (isLow(low)) {
                ucs4 = ((ucs4 - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                ++i;
            }
        }

        let prop = props(ucs4);
        let ncls = prop & LBC_MASK;

        block: {
            if (ncls === SA) {
                // LB1: resolve SA to AL, except of those that have Category Mn or Mc be resolved to CM
                if (category(prop) === CAT_MARK) ncls = CM;
            }

            if (ncls === QU) {
                if (category(prop) === CAT_PI) {
                    // LB15a
                    if (LB15A.has(lcls)) ncls = QU_Pi;
                } else if (category(prop) === CAT_PF) {
                    // LB15b
                    let nncls: number;
                    if (i + 1 >= len) {
                        nncls = LF;
                    } else {
                        let c = text.charCodeAt(i + 1);
                        nncls = -1;
                        if (isHigh(c) && i + 2 < len) {
                            const low = text.charCodeAt(i + 2);
                            if (isLow(low)) c = ((c - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                            else nncls = SG;
                        }
                        if (nncls < 0) nncls = rawClass(c);
                    }
                    if (LB15B.has(nncls)) ncls = QU_Pf;
                }
            }

            if ((lcls >= SP || lcls === ZW || lcls === GL || lcls === CB) && (ncls === HY || ncls === HH)) {
                // LB20a: Do not break after a word-initial hyphen.
                ncls = ncls === HH ? WS_BA : WS_HY;
            }

            if (cls === AP && ucs4 === DOTTED_CIRCLE && lcls !== SP) {
                // LB28a: AP × (AK | [◌] | AS)
                break block;
            }
            let goNext = false;
            for (;;) {
                // LB28a cont'd
                const oldState = brsState;
                brsState = brsUpdate(brsState, ncls, ucs4);
                if (brsState === oldState) break;
                if (brsState === BRS_Start) {
                    brsStart = i;
                } else if (brsState === BRS_2VI) {
                    clear(brsStart + 1, i);
                    brsStart = i;
                    goNext = true;
                } else if (brsState === BRS_Restart) {
                    brsState = BRS_Start;
                    brsStart = pos - 1;
                    continue;
                } else if (brsState === BRS_2VF || brsState === BRS_4VF || brsState === BRS_3VIAK) {
                    clear(brsStart + 1, i);
                    if (brsState === BRS_3VIAK) {
                        brsState = BRS_Start;
                        brsStart = i;
                    } else {
                        brsState = BRS_None;
                    }
                    goNext = true;
                }
                break;
            }
            if (goNext) break block;

            if (ncls === IS && lcls === SP && i + 1 < len) {
                // LB15c: break before a decimal mark that follows a space
                let ch = text.charCodeAt(i + 1);
                let valid = true;
                if (isHigh(ch) && i + 2 < len) {
                    const low = text.charCodeAt(i + 2);
                    if (isLow(low)) ch = ((ch - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                    else valid = false;
                }
                if (valid && rawClass(ch) === NU) {
                    breaks[pos] = 1;
                    break block;
                }
            }

            if (lcls === HL && (ncls === HY || ncls === HH)) {
                // LB21a: HL (HY | HH) × [^HL]
                ncls = HYBA;
                break block;
            }

            {
                // LB25: do not break lines inside numbers
                const necur = nsClass(ncls);
                let neact = NS_ACTIONS[nelast][necur];
                if (neactlast === NS_CNeedNU && necur !== NS_NU) {
                    neact = NS_None;
                } else if (neactlast === NS_NeedOPNU) {
                    neact = necur === NS_OP ? NS_CNeedISNU : necur === NS_NU ? NS_Continue : NS_None;
                } else if (neactlast === NS_CNeedISNU) {
                    neact = necur === NS_IS ? NS_CNeedNU : necur === NS_NU ? NS_Continue : NS_None;
                }
                switch (neact) {
                    case NS_Break:
                        clear(nestart + 1, pos);
                        nelast = NS_XX;
                        break;
                    case NS_None:
                        nelast = NS_XX;
                        break;
                    case NS_NeedOPNU:
                    case NS_Start:
                        if (neactlast === NS_Start || neactlast === NS_Continue) clear(nestart + 1, pos);
                        nestart = i;
                        nelast = necur;
                        break;
                    default: // CNeedNU, CNeedISNU, Continue
                        nelast = necur;
                        break;
                }
                neactlast = neact;
            }

            if (ncls === QU && lcls !== SP && lcls !== ZW) {
                // LB19a: unless surrounded by East Asian characters, no break either side of an unresolved quotation mark
                let nextNonEastAsian = true;
                if (i + 1 < len) {
                    let nch = text.charCodeAt(i + 1);
                    if (isHigh(nch) && i + 2 < len) {
                        const low = text.charCodeAt(i + 2);
                        if (isLow(low)) nch = ((nch - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                    }
                    const np = props(nch);
                    const nncls = np & LBC_MASK;
                    nextNonEastAsian = nncls !== CM && nncls <= SP && !(np & EA_BIT);
                }
                if (!(lastProp & EA_BIT) || nextNonEastAsian) ncls = QU_19;
            }

            if (lcls >= CR) {
                // LB4: BK!, LB5: (CRxLF|CR|LF|NL)!
                if (lcls > CR || ncls !== LF) breaks[pos] = 1;
                break block;
            }

            if (ncls >= SP) {
                if (ncls > SP) break block; // LB6: x(BK|CR|LF|NL)
                lcls = ncls; // LB7: xSP
                continue;
            }

            if ((((ncls === QU || ncls === QU_19) && category(prop) !== CAT_PI)
                || (cls === QU && category(lastProp) !== CAT_PF))
                && lcls !== SP && lcls !== ZW && ncls !== CM) {
                // LB19
                break block;
            }

            if ((ncls === CM || ncls === ZWJ) && lcls !== ZW && lcls < SP) {
                // LB9: treat CM that doesn't follow SP, BK, CR, LF, NL, or ZW as X
                lcls = ncls;
                continue;
            }

            if (lcls === ZWJ) break block; // LB8a: ZWJ ×

            if (ncls === RI && lcls === RI) {
                // LB30a
                ncls = SP;
                break block;
            }

            if (ncls === EM && (lastProp & EXTPICT_CN_BIT) && lcls !== SP) {
                // LB30b: [\p{Extended_Pictographic}&\p{Cn}] × EM
                break block;
            }

            // South East Asian text needing dictionary analysis is AL here.
            if (cls >= SA) cls = AL;

            let tcls = cls;
            // LB10: any remaining combining mark or ZWJ is AL, with the properties of U+0041
            if (tcls === CM || tcls === ZWJ) {
                tcls = AL;
                lastProp = fixed(PROPS_A);
            }
            if (ncls === CM || ncls === ZWJ) {
                ncls = AL;
                prop = fixed(PROPS_A);
            }

            switch (LINE_BREAK_PAIRS.charCodeAt(tcls * PAIR_COLUMNS + (ncls < ZWJ ? ncls : AL))) {
                case A_DB:
                    breaks[pos] = 1;
                    break;
                case A_IB:
                    if (lcls === SP) breaks[pos] = 1;
                    break;
                case A_CI:
                    if (lcls !== SP) { lcls = ncls; continue; }
                    breaks[pos] = 1;
                    break;
                case A_CP:
                    if (lcls !== SP) { lcls = ncls; continue; }
                    break;
                case A_HH:
                    if (lcls !== HL) breaks[pos] = 1;
                    break;
                case A_IN:
                    if ((prop & EA_BIT) || lcls === SP) breaks[pos] = 1;
                    break;
                case A_DN:
                    if (neactlast === NS_None || neactlast > NS_Break) breaks[pos] = 1;
                    break;
                case A_PB:
                default:
                    break;
            }
        }
        // next:
        if (ncls !== CM && ncls !== ZWJ) {
            cls = ncls;
            lastProp = prop;
        }
        lcls = ncls;
    }

    if (NS_ACTIONS[nelast][NS_XX] === NS_Break) clear(nestart + 1, len); // LB25

    breaks[0] = 0; // LB2
    breaks[len] = 1; // LB3

    tailorThai(text, breaks);
    return breaks;
}

let thaiWords: Intl.Segmenter | null | undefined;

/**
 * Qt's Thai tailoring: initScripts() itemizes the line by script (Common and
 * Inherited characters join their neighbour, marks join their base), and every
 * Thai item has its breaks replaced by libthai's word breaks.
 */
function tailorThai(text: string, breaks: Uint8Array): void {
    const len = text.length;
    let hasThai = false;
    for (let i = 0; i < len; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0x0e01 && c <= 0x0e5b) { hasThai = true; break; }
    }
    if (!hasThai) return;
    if (thaiWords === undefined) {
        thaiWords = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
            ? new Intl.Segmenter('th', { granularity: 'word' })
            : null;
    }
    if (!thaiWords) return;

    // initScripts(): script 0 is Common/Inherited, 1 Thai, 2 anything else.
    let sor = 0;
    let script = 0;
    const apply = (from: number, to: number) => {
        if (script === SCRIPT_THAI) thaiItem(text, from, to, breaks);
    };
    for (let i = 0; i < len;) {
        const eor = i;
        const ucs4 = text.codePointAt(i)!;
        i += ucs4 > 0xffff ? 2 : 1;
        const p = props(ucs4);
        const nscript = (p >> SCRIPT_SHIFT) & 3;
        if (nscript === script || nscript === 0) continue;
        if (script === 0) { script = nscript; continue; }
        if (category(p) === CAT_MARK || (p & ME_BIT)) continue;
        apply(sor, eor);
        sor = eor;
        script = nscript;
    }
    apply(sor, len);
}

function thaiItem(text: string, from: number, to: number, breaks: Uint8Array): void {
    breaks.fill(0, from, to);
    let previousSpace = false;
    let first = true;
    for (const { segment, index, isWordLike } of thaiWords!.segment(text.slice(from, to))) {
        const space = /^\s+$/.test(segment);
        if (!first && !space && (isWordLike || previousSpace)) breaks[from + index] = 1;
        previousSpace = space;
        first = false;
    }
    if (from === 0) breaks[0] = 0;
}
