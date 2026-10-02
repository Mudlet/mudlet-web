#!/usr/bin/env node
/**
 * Regenerate src/mud/text/unicodeTables.generated.ts — the character data the
 * main console's wrap needs to break lines where desktop Mudlet does.
 *
 * Two tables, each from what desktop actually links against rather than from
 * whatever Unicode version a browser happens to ship:
 *
 *  - WIDTH: Mudlet's own `src/widechar_width.h` (ridiculousfish/widecharwidth),
 *    classified the way `graphemeInfo::codepointWidth` in TTextProperties.h
 *    reads it. Mudlet's three hand overrides (U+2764, U+1F6E1, U+2318) stay in
 *    wcwidth.ts next to that function's port, not baked in here.
 *  - LINE BREAK: the properties Qt's `getLineBreaks()` (qunicodetools.cpp)
 *    consults, from the UCD files of the Qt release Mudlet's CI builds with,
 *    resolved the way Qt's util/unicode generator resolves them (AI/XX → AL,
 *    CJ → NS, NL → BK, its defaults for unlisted code points).
 *
 *   node scripts/generate-unicode-tables.mjs
 *   node scripts/generate-unicode-tables.mjs --mudlet-ref <sha> --qt-ref v6.11.1
 *
 * Bump `--qt-ref` when Mudlet's build-mudlet.yml moves to a Qt with a newer
 * Unicode, and re-run after a sync brings a new widechar_width.h.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/mud/text/unicodeTables.generated.ts');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
};
const MUDLET_REF = opt('--mudlet-ref', 'development');
const QT_REF = opt('--qt-ref', 'v6.11.1');
const MUDLET_URL = `https://raw.githubusercontent.com/Mudlet/Mudlet/${MUDLET_REF}/src/widechar_width.h`;
const QT_UCD = `https://raw.githubusercontent.com/qt/qtbase/${QT_REF}/util/unicode/data/`;

async function get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.text();
}

const MAX = 0x110000;

// ---------------------------------------------------------------- widths ----

function parseWidecharTables(header) {
    const tables = {};
    const re = /static const struct widechar_range widechar_(\w+)_table\[\] = \{([\s\S]*?)\};/g;
    for (let m; (m = re.exec(header));) {
        const ranges = [];
        for (const r of m[2].matchAll(/\{0x([0-9A-Fa-f]+), 0x([0-9A-Fa-f]+)\}/g)) {
            ranges.push([parseInt(r[1], 16), parseInt(r[2], 16)]);
        }
        tables[m[1]] = ranges;
    }
    return tables;
}

/** Width class per code point: 0, 1, 2, or 3 for East Asian ambiguous. */
function widthClasses(header) {
    const t = parseWidecharTables(header);
    const order = ['ascii', 'private', 'nonprint', 'nonchar', 'combining', 'combiningletters', 'doublewide', 'ambiguous', 'unassigned', 'widened'];
    for (const name of order) if (!t[name]) throw new Error(`widechar_width.h: no ${name} table`);
    // widechar_wcwidth()'s test order, mapped through codepointWidth().
    const cls = { ascii: 1, private: 1, nonprint: 0, nonchar: 0, combining: 0, combiningletters: 0, doublewide: 2, ambiguous: 3, unassigned: 1, widened: 2 };
    const out = new Uint8Array(MAX).fill(255);
    for (const name of order) {
        for (const [lo, hi] of t[name]) {
            for (let c = lo; c <= hi; c++) if (out[c] === 255) out[c] = cls[name];
        }
    }
    for (let c = 0; c < MAX; c++) if (out[c] === 255) out[c] = 1;
    return { classes: out, version: /widechar_width\.h for Unicode ([\d.]+)/.exec(header)?.[1] ?? '?' };
}

// ------------------------------------------------------------ line break ----

// Qt's LineBreakClass enum, in order (qunicodetables_p.h).
const LBC = ['OP', 'CL', 'CP', 'QU', 'QU_Pi', 'QU_Pf', 'QU_19', 'GL', 'NS', 'EX', 'SY', 'IS', 'PR', 'PO', 'NU', 'AL', 'HL', 'ID',
    'IN', 'HY', 'WS_HY', 'HH', 'BA', 'WS_BA', 'HYBA', 'BB', 'B2', 'ZW', 'CM', 'WJ', 'H2', 'H3', 'JL', 'JV', 'JT', 'RI', 'CB',
    'EB', 'EM', 'AK', 'AP', 'AS', 'VI', 'VF', 'ZWJ', 'SA', 'SG', 'SP', 'CR', 'LF', 'BK'];
const lbcIndex = Object.fromEntries(LBC.map((n, i) => [n, i]));
// util/unicode/main.cpp initLineBreak()
const UCD_TO_QT = { ...Object.fromEntries(LBC.map(n => [n, n])), NL: 'BK', CJ: 'NS', AI: 'AL', XX: 'AL' };

function eachLine(text, fn) {
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) continue;
        const fields = line.split(';').map(s => s.trim());
        const [a, b] = fields[0].split('..');
        fn(parseInt(a, 16), parseInt(b ?? a, 16), fields);
    }
}

// Bits of one packed line-break property value.
const EA_BIT = 1 << 6; // East Asian width F, W or H
const CAT_SHIFT = 7; // 0 other, 1 Pi, 2 Pf, 3 Mn or Mc
const EXTPICT_CN_BIT = 1 << 9; // Extended_Pictographic and unassigned (LB30b)
const SCRIPT_SHIFT = 10; // 0 Common or Inherited, 1 Thai, 2 any other
const ME_BIT = 1 << 12; // Mark_Enclosing (script itemization only)

function lineBreakProps({ lineBreak, eaw, unicodeData, emoji, scripts }) {
    const lbc = new Uint8Array(MAX);
    // main.cpp's UnicodeData constructor defaults
    for (let c = 0; c < MAX; c++) {
        const id = (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF)
            || (c >= 0x1F000 && c <= 0x1F7FF) || (c >= 0x1F900 && c <= 0x1FAFF) || (c >= 0x1FC00 && c <= 0x1FFFD)
            || (c >= 0x20000 && c <= 0x2FFFD) || (c >= 0x30000 && c <= 0x3FFFD);
        lbc[c] = id ? lbcIndex.ID : (c >= 0x20A0 && c <= 0x20CF) ? lbcIndex.PR : lbcIndex.AL;
    }
    eachLine(lineBreak, (lo, hi, f) => {
        const q = UCD_TO_QT[f[1]];
        if (q === undefined) throw new Error(`LineBreak.txt: unknown class ${f[1]}`);
        for (let c = lo; c <= hi; c++) lbc[c] = lbcIndex[q];
    });

    const ea = new Uint8Array(MAX);
    eachLine(eaw, (lo, hi, f) => {
        if (f[1] === 'F' || f[1] === 'W' || f[1] === 'H') for (let c = lo; c <= hi; c++) ea[c] = 1;
    });

    // General category; anything UnicodeData.txt does not list is Cn.
    const cat = new Array(MAX).fill('Cn');
    let rangeStart = -1;
    for (const line of unicodeData.split('\n')) {
        if (!line) continue;
        const f = line.split(';');
        const c = parseInt(f[0], 16);
        if (f[1].endsWith(', First>')) { rangeStart = c; continue; }
        if (f[1].endsWith(', Last>')) { for (let x = rangeStart; x <= c; x++) cat[x] = f[2]; continue; }
        cat[c] = f[2];
    }

    const extPict = new Uint8Array(MAX);
    eachLine(emoji, (lo, hi, f) => {
        if (f[1] === 'Extended_Pictographic') for (let c = lo; c <= hi; c++) extPict[c] = 1;
    });

    const script = new Uint8Array(MAX).fill(0); // unlisted is Unknown, which Qt orders below Common
    eachLine(scripts, (lo, hi, f) => {
        const s = f[1] === 'Common' || f[1] === 'Inherited' ? 0 : f[1] === 'Thai' ? 1 : 2;
        for (let c = lo; c <= hi; c++) script[c] = s;
    });

    const out = new Uint16Array(MAX);
    for (let c = 0; c < MAX; c++) {
        const g = cat[c];
        const catBits = g === 'Pi' ? 1 : g === 'Pf' ? 2 : (g === 'Mn' || g === 'Mc') ? 3 : 0;
        out[c] = lbc[c]
            | (ea[c] ? EA_BIT : 0)
            | (catBits << CAT_SHIFT)
            | (extPict[c] && g === 'Cn' ? EXTPICT_CN_BIT : 0)
            | (script[c] << SCRIPT_SHIFT)
            | (g === 'Me' ? ME_BIT : 0);
    }
    return { props: out, version: /LineBreak-([\d.]+)\.txt/.exec(lineBreak)?.[1] ?? '?' };
}

// -------------------------------------------------------------- encoding ----

/**
 * Run-length encode a table over 0..10FFFF as base-36 "length,value" pairs
 * joined by ',' — compact, ASCII, and decoded in one pass at first use.
 */
function encodeRuns(values) {
    const parts = [];
    let start = 0;
    for (let c = 1; c <= MAX; c++) {
        if (c === MAX || values[c] !== values[start]) {
            parts.push((c - start).toString(36), values[start].toString(36));
            start = c;
        }
    }
    return { text: parts.join(','), runs: parts.length / 2 };
}

/**
 * Qt's line-break pair table (`LB::breakTable` in qunicodetools.cpp), one
 * letter per action: P prohibited, D direct, I indirect, C combining indirect,
 * X combining prohibited, H prohibited after Hebrew + hyphen, N indirect if
 * narrow, U direct outside a numeric sequence. Rows and columns must be the
 * LineBreakClass order up to ZWJ, which lineBreak.ts indexes it by.
 */
function pairTable(source) {
    const body = /static const uchar breakTable\[QUnicodeTables::LineBreak_ZWJ\]\[QUnicodeTables::LineBreak_ZWJ\] = \{([\s\S]*?)\n\};/.exec(source);
    if (!body) throw new Error('qunicodetools.cpp: breakTable not found');
    const letter = { PB: 'P', DB: 'D', IB: 'I', CI: 'C', CP: 'X', HH: 'H', IN: 'N', DN: 'U' };
    const rows = [...body[1].matchAll(/\{([^}]*)\}/g)].map(m => m[1].split(',').map(s => s.trim()));
    const size = lbcIndex.ZWJ;
    if (rows.length !== size || rows.some(r => r.length !== size)) {
        throw new Error(`qunicodetools.cpp: breakTable is not ${size}x${size} — LineBreakClass changed, re-port lineBreak.ts`);
    }
    return rows.map(r => r.map(a => {
        if (!letter[a]) throw new Error(`breakTable: unknown action ${a}`);
        return letter[a];
    }).join('')).join('');
}

function chunk(s, width = 100) {
    const lines = [];
    for (let i = 0; i < s.length; i += width) lines.push(s.slice(i, i + width));
    return lines.map(l => `    '${l}'`).join(' +\n');
}

const [header, tools, enums, lineBreak, eaw, unicodeData, emoji, scripts] = await Promise.all([
    get(MUDLET_URL),
    get(`https://raw.githubusercontent.com/qt/qtbase/${QT_REF}/src/corelib/text/qunicodetools.cpp`),
    get(`https://raw.githubusercontent.com/qt/qtbase/${QT_REF}/src/corelib/text/qunicodetables_p.h`),
    ...['LineBreak.txt', 'EastAsianWidth.txt', 'UnicodeData.txt', 'emoji-data.txt', 'Scripts.txt'].map(f => get(QT_UCD + f)),
]);
const qtEnum = /enum LineBreakClass \{([\s\S]*?)NumLineBreakClasses/.exec(enums)?.[1].match(/LineBreak_(\w+)/g)?.map(s => s.slice(10));
if (qtEnum?.join() !== LBC.join()) throw new Error(`Qt's LineBreakClass is now ${qtEnum} — update LBC here and the constants in lineBreak.ts`);
const pairs = pairTable(tools);
const width = widthClasses(header);
const lb = lineBreakProps({ lineBreak, eaw, unicodeData, emoji, scripts });
const w = encodeRuns(width.classes);
const l = encodeRuns(lb.props);

const ts = `// GENERATED by scripts/generate-unicode-tables.mjs — do not edit by hand.
//
// WIDTH_RUNS: Mudlet's widechar_width.h (Unicode ${width.version}, Mudlet/Mudlet@${MUDLET_REF}),
//   0 / 1 / 2 columns, 3 = East Asian ambiguous. ${w.runs} runs.
// LINE_BREAK_RUNS: what Qt's line breaker reads, from the UCD of qt/qtbase@${QT_REF}
//   (LineBreak ${lb.version}). Bits: 0-5 Qt LineBreakClass, 6 East Asian F/W/H,
//   7-8 category (1 Pi, 2 Pf, 3 Mn/Mc), 9 Extended_Pictographic & Cn,
//   10-11 script (0 Common/Inherited, 1 Thai, 2 other), 12 Me. ${l.runs} runs.
//
// Both are base-36 "runLength,value" pairs covering U+0000..U+10FFFF in order.

export const WIDTH_RUNS =
${chunk(w.text)};

export const LINE_BREAK_RUNS =
${chunk(l.text)};

// Qt's LB::breakTable, ${lbcIndex.ZWJ}x${lbcIndex.ZWJ}, row-major: P prohibited, D direct, I indirect,
// C combining indirect, X combining prohibited, H prohibited after Hebrew + hyphen,
// N indirect if narrow, U direct outside a numeric sequence.
export const LINE_BREAK_PAIRS =
${chunk(pairs, lbcIndex.ZWJ)};
`;
writeFileSync(OUT, ts);
console.log(`wrote ${OUT}: ${w.runs} width runs, ${l.runs} line-break runs, ${ts.length} bytes`);
