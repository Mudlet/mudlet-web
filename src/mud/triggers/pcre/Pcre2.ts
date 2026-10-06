/**
 * Vendored, performance-tuned PCRE2 wrapper for the trigger hot path.
 *
 * This is a focused fork of `pcre2-wasm-universal`'s `src/PCRE.js` (the wrapper
 * only — the prebuilt `dist/libpcre2.js` glue and `.wasm` binary are reused
 * untouched via the package's `./libpcre2` subpath export). It exposes the same
 * surface the trigger engine consumes (`init` / `new Pcre2(pattern)` /
 * `match` / `matchAll` / `destroy`) and returns the identical match shape, so it
 * is a drop-in for `import PCRE from 'pcre2-wasm-universal'` there.
 *
 * Two differences from the upstream wrapper, both targeting the per-line scan
 * where one line is matched against N triggers (see TriggerEngine):
 *
 *   1. Shared line buffer. Upstream `match()` re-encodes the subject to UTF-16LE
 *      and copies it into wasm on EVERY call — so a 1-line / N-trigger pass
 *      encodes the same line N times. Here the line is encoded into a single
 *      module-level wasm buffer once; subsequent matches of the same line (the
 *      common case: every trigger in the pass receives the same string
 *      reference) reuse it via a reference-equality fast path.
 *
 *   2. Reusable match-data. Upstream allocates and frees a `pcre2_match_data`
 *      block on every call, including non-matches. Here each compiled pattern
 *      keeps one match-data block for its lifetime; `pcre2_match` overwrites it
 *      in place, so the malloc/free per call disappears.
 *
 * These are constant-factor wins (the engine is still interpreted — the wasm
 * build has no JIT), but they remove the redundant work the scan was repeating.
 *
 * A third one is not constant: {@link Pcre2.matchAll} checks the subject is
 * valid UTF-16 once and skips the check for the rest of the loop. The shipped
 * `_match` export takes no options argument, so the pcre2 wasm is patched as it
 * is served (vite-plugin/pcre2Wasm.ts) to take one; without the patch every
 * call re-checks from its start offset to the end of the line, which makes a
 * global match quadratic in the line's length. The same options argument
 * carries the NOTEMPTY_ATSTART | ANCHORED retry that loop makes after an empty
 * match, as Mudlet's does.
 *
 * The alias engine compiles its patterns with it too (PatternEngine), and so
 * does the Lua `rex` module (rex.ts); all of them share the same wasm module
 * instance.
 *
 * Bumping pcre2-wasm-universal means re-deriving that wasm patch for the new
 * binary — see "UPGRADING" in vite-plugin/pcre2Wasm.ts. An unrecognised binary
 * still works, just quadratically, and tests/triggers/pcreMatchAllLinear.test.ts
 * fails so the bump can't land without it.
 */
import libpcre2 from 'pcre2-wasm-universal/libpcre2';

const PCRE2_NO_MATCH = -1;

/** pcre2_match option: the subject has already been checked for valid UTF, so
 *  don't scan it again. Only honoured by a patched wasm — see the header. */
export const PCRE2_NO_UTF_CHECK = 0x40000000;
/** pcre2_match options Mudlet's global-match loop retries an empty match with. */
const PCRE2_NOTEMPTY_ATSTART = 0x00000008;
const PCRE2_ANCHORED = 0x80000000;

type Cfunc = (...args: number[]) => number;
interface CFuncs {
    malloc: (bytes: number) => number;
    free: (ptr: number) => void;
    compile: Cfunc;
    destroyCode: Cfunc;
    lastErrorMessage: Cfunc;
    lastErrorOffset: Cfunc;
    /** match(codePtr, subjectPtr, lengthInCodeUnits, startOffset, matchDataPtr, options) —
     *  `options` reaches pcre2_match only in the patched wasm; the shipped one
     *  drops the sixth argument and always passes 0. */
    match: Cfunc;
    createMatchData: Cfunc;
    destroyMatchData: Cfunc;
    getOvectorCount: Cfunc;
    getOvectorPtr: Cfunc;
    getMatchNameCount: Cfunc;
    getMatchNameTableEntrySize: Cfunc;
    getMatchNameTable: Cfunc;
}

let initialized = false;
let cfunc: CFuncs;

export type Pcre2MatchGroup = { start: number; end: number; match: string; name?: string; group?: number };
export type Pcre2Match = { length: number; [k: number]: Pcre2MatchGroup; [k: string]: Pcre2MatchGroup | number };

// ── Shared per-line subject buffer ────────────────────────────────────────────
// One wasm buffer holding the current line as UTF-16LE, reused across every
// pattern matched against that line. `bufCapacity`/`bufLen` are in 16-bit code
// units (PCRE2 runs in 16-bit mode here). `curLine` holds the string reference
// last encoded so the per-line scan — which hands the SAME reference to each
// trigger — short-circuits to a pointer compare instead of re-encoding.
let bufPtr = 0;
let bufCapacity = 0;
let bufLen = 0;
let curLine: string | null = null;

function ensureLineEncoded(subject: string): void {
    if (subject === curLine) return; // same reference (or interned-equal) → already in wasm
    const len = subject.length;
    if (bufPtr === 0 || len > bufCapacity) {
        if (bufPtr !== 0) cfunc.free(bufPtr);
        bufCapacity = Math.max(len, bufCapacity * 2, 256);
        bufPtr = cfunc.malloc(bufCapacity * 2); // may grow wasm memory → read HEAP views AFTER
    }
    const u16 = libpcre2.HEAPU16; // fetched post-malloc so it isn't a detached view
    const base = bufPtr >> 1;
    for (let i = 0; i < len; i++) u16[base + i] = subject.charCodeAt(i);
    curLine = subject;
    bufLen = len;
}

// ── Unpaired surrogates ───────────────────────────────────────────────────────
// Mudlet hands pcre2 a trigger's line, or an alias's command, as UTF-8
// (`QString::toUtf8`), which leaves an unpaired surrogate out, so the text on
// either side of one is matched as if it were together. pcre2 here runs in
// 16-bit mode on the JS string itself, where an unpaired surrogate is invalid
// UTF-16 and fails the whole match. So those callers match {@link pcreSubject}
// of the line instead, and every offset reported is into that subject, as
// Mudlet's are into its UTF-8 one. The wrapper itself still refuses invalid
// UTF-16, as pcre2 does. A line only carries one from an MXP entity or a
// script, so the scan is cached for the per-line pass, which hands every
// pattern the same string.
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
let rawSubject: string | null = null;
let cleanSubject = '';

/** `subject` without its unpaired surrogates — what Mudlet's pcre2 sees. */
export function pcreSubject(subject: string): string {
    if (subject === rawSubject || subject === cleanSubject) return cleanSubject;
    rawSubject = subject;
    cleanSubject = subject.replace(UNPAIRED_SURROGATE, '');
    return cleanSubject;
}

/** Drop the cached line so the next match re-encodes. Used after teardown or
 *  when callers want to be sure a stale buffer can't be reused. */
export function resetLineBuffer(): void {
    curLine = null;
    bufLen = 0;
}

export default class Pcre2 {
    private codePtr = 0;
    private matchData = 0;
    private readonly nametable: Record<number, string> = {};
    /** The name table in PCRE2's own order (sorted by name), duplicates kept. */
    private readonly nameEntries: Array<[string, number]> = [];

    /** Whether {@link init} has resolved, so a pattern can be compiled
     *  synchronously right now. */
    static get ready(): boolean {
        return initialized;
    }

    static async init(): Promise<void> {
        if (initialized) return;
        await libpcre2.loaded;
        const w = (name: string, ret: string | null, args: string[]) => libpcre2.cwrap(name, ret, args) as Cfunc;
        cfunc = {
            malloc: (bytes: number) => libpcre2._malloc(bytes),
            free: (ptr: number) => libpcre2._free(ptr),
            compile: libpcre2.cwrap('compile', 'number', ['array', 'number', 'string']) as Cfunc,
            destroyCode: w('destroyCode', null, ['number']),
            lastErrorMessage: w('lastErrorMessage', 'number', ['number', 'number']),
            lastErrorOffset: w('lastErrorOffset', 'number', []),
            // Subject is passed as a pointer ('number'), not an 'array' — we
            // supply the pre-encoded shared buffer, so no per-call stack copy.
            match: w('match', 'number', ['number', 'number', 'number', 'number', 'number', 'number']),
            createMatchData: w('createMatchData', 'number', ['number']),
            destroyMatchData: w('destroyMatchData', null, ['number']),
            getOvectorCount: w('getOvectorCount', 'number', ['number']),
            getOvectorPtr: w('getOvectorPointer', 'number', ['number']),
            getMatchNameCount: w('getMatchNameCount', 'number', ['number']),
            getMatchNameTableEntrySize: w('getMatchNameTableEntrySize', 'number', ['number']),
            getMatchNameTable: w('getMatchNameTable', 'number', ['number']),
        };
        initialized = true;
    }

    /** The PCRE2 library's own version string (`pcre2_config(PCRE2_CONFIG_VERSION)`),
     *  e.g. "10.42 2022-12-11" — what lrexlib's `rex.version()` reports. */
    static version(): string {
        if (!initialized) throw new Error('Pcre2.init() has not completed');
        const fn = libpcre2.cwrap('version', 'number', ['number']);
        const len = fn(0);
        if (len <= 0) return '';
        const ptr = libpcre2._malloc(len * 2);
        try {
            fn(ptr);
            const u16 = libpcre2.HEAPU16;
            let out = '';
            for (let i = 0; i < len; i++) {
                const c = u16[(ptr >> 1) + i];
                if (c === 0) break;
                out += String.fromCharCode(c);
            }
            return out;
        } finally {
            libpcre2._free(ptr);
        }
    }

    constructor(pattern: string, flags = '') {
        if (!initialized) throw new Error('Pcre2.init() must resolve before compiling patterns');
        const patternBuffer = encodeUTF16LE(pattern);
        // cwrap('array') expects a JS typed array here; pass through ccall's array marshalling.
        const ptr = (cfunc.compile as unknown as (a: Uint8Array, b: number, c: string) => number)(
            patternBuffer,
            patternBuffer.length / 2,
            flags,
        );
        if (ptr === 0) {
            const { errorMessage, offset } = this.getLastError();
            const err = new Error(errorMessage) as Error & { offset?: number };
            err.offset = offset;
            throw err;
        }
        this.codePtr = ptr;

        // Extract the named-group table once at compile time.
        const nameCount = cfunc.getMatchNameCount(ptr);
        const entrySize = cfunc.getMatchNameTableEntrySize(ptr);
        const tableBuf = cfunc.getMatchNameTable(ptr);
        for (let i = 0; i < nameCount; i++) {
            const p = tableBuf + entrySize * i * 2;
            const index = libpcre2.getValue(p, 'i16', false);
            this.nametable[index] = copyStringBuffer(p + 2, utf16leLen(p + 2));
            this.nameEntries.push([this.nametable[index], index]);
        }
    }

    /** `[name, group number]` for each named group, in PCRE2's name-table
     *  order — what lrexlib walks to add named captures to a result table. */
    get groupNames(): ReadonlyArray<[string, number]> {
        return this.nameEntries;
    }

    /** The number of capturing groups (PCRE2_INFO_CAPTURECOUNT): the match
     *  data is sized from the pattern, one ovector pair more than that. */
    get captureCount(): number {
        if (this.codePtr === 0) return 0;
        if (this.matchData === 0) this.matchData = cfunc.createMatchData(this.codePtr);
        return cfunc.getOvectorCount(this.matchData) - 1;
    }

    destroy(): void {
        if (this.codePtr === 0) return;
        if (this.matchData !== 0) {
            cfunc.destroyMatchData(this.matchData);
            this.matchData = 0;
        }
        cfunc.destroyCode(this.codePtr);
        this.codePtr = 0;
    }

    match(subject: string, start?: number): Pcre2Match | null {
        if (this.codePtr === 0) return null;
        // Preserve upstream semantics: the guard only bites when `start` is a
        // number (matchAll); a plain match(line) leaves it undefined.
        if (start !== undefined && start >= subject.length) return null;
        return this.matchFrom(subject, start || 0);
    }

    /**
     * {@link match} without the end-of-subject guard: `startOffset` may equal
     * `subject.length`, where a pattern that can match nothing still finds its
     * empty match. That is where TAlias::match's global loop tries after a
     * match that ran to the end of the command.
     */
    matchFrom(subject: string, startOffset: number, options = 0): Pcre2Match | null {
        if (this.codePtr === 0) return null;
        ensureLineEncoded(subject);
        if (this.matchData === 0) this.matchData = cfunc.createMatchData(this.codePtr);

        const result = cfunc.match(this.codePtr, bufPtr, bufLen, startOffset, this.matchData, options);
        if (result < 0) {
            if (result === PCRE2_NO_MATCH) return null;
            const err = new Error(`PCRE2 match error ${result}`) as Error & { code?: number };
            err.code = result;
            throw err;
        }

        const matchCount = cfunc.getOvectorCount(this.matchData);
        const vectorPtr = cfunc.getOvectorPtr(this.matchData);
        const matches = convertOVector(subject, vectorPtr, matchCount);

        const results: Pcre2Match = { ...matches } as unknown as Pcre2Match;
        for (const i in matches) {
            const idx = Number(i);
            if (idx in this.nametable) {
                const name = this.nametable[idx];
                const grp = matches[idx];
                results[name] = grp;
                grp.group = idx;
                grp.name = name;
            }
        }
        results.length = matchCount;
        return results;
    }

    /**
     * {@link matchFrom} as Mudlet's trigger and alias code calls pcre2_match:
     * any error is "no match". TTrigger::match_perl and TAlias::match treat a
     * negative return from the first pcre2_match the same whatever it is, so a
     * pattern that backtracks into the match limit (-47) is simply a pattern
     * that did not match this line, and the triggers and aliases after it still
     * run. Throwing here took the rest of the line's pass with it (#361).
     */
    tryMatchFrom(subject: string, startOffset: number, options = 0): Pcre2Match | null {
        try {
            return this.matchFrom(subject, startOffset, options);
        } catch {
            return null;
        }
    }

    /**
     * Every match of the pattern in `subject`, by Mudlet's global-match loop
     * (TTrigger::match_perl under "match all", and TAlias::match, which always
     * runs it) — pcre2demo's loop:
     *
     *  - resume at the end of the last match, even when that is the end of the
     *    subject, where a pattern that can match nothing still finds its empty
     *    match (`(\d*)` on a line gives one there);
     *  - after an EMPTY match, first ask again at the same offset with
     *    PCRE2_NOTEMPTY_ATSTART | PCRE2_ANCHORED, so a pattern that preferred
     *    nothing still reports the non-empty match it could make there (`a??`
     *    on "aa" gives "", "a", "", "a", ""); only when that fails step one
     *    code point on and match normally from there;
     *  - stop after an empty match at the end of the subject.
     *
     * `lenient` is how the trigger and alias engines call it: an error from
     * pcre2_match (the match limit, say) ends the loop with what was found so
     * far, and an error on the first call means no match — desktop's
     * `if (rc < 0) goto END`. Without it the error is thrown, as
     * {@link matchFrom} throws.
     */
    matchAll(subject: string, lenient = false): Pcre2Match[] {
        const results: Pcre2Match[] = [];
        const length = subject.length;
        const call = (at: number, options: number): Pcre2Match | null =>
            lenient ? this.tryMatchFrom(subject, at, options) : this.matchFrom(subject, at, options);
        // The first call checks the whole subject is valid UTF-16 — from offset
        // 0 to the end — and refuses it if it isn't. Every later call would
        // repeat that check from its own offset to the end of the line, once
        // per match, so it is skipped: Mudlet's loop and pcre2_substitute's do
        // the same. The loop only resumes at the end of a match or a whole code
        // point further on, so no offset it hands over splits a surrogate pair,
        // which is the other thing the check guards.
        const first = call(0, 0);
        if (first === null) return results;
        results.push(first);
        let matchStart = first[0].start;
        let matchEnd = first[0].end;
        // Only here so that a bug in the loop terminates instead of hanging the
        // tab: each offset costs at most an empty match, a retry and a
        // non-empty match.
        let safety = 3 * length + 1000;
        for (;;) {
            const at = matchEnd;
            let options = PCRE2_NO_UTF_CHECK;
            const retry = matchStart === matchEnd;
            if (retry) {
                if (at >= length) break;
                options |= PCRE2_NOTEMPTY_ATSTART | PCRE2_ANCHORED;
            }
            let m = call(at, options);
            // The empty match again means the module dropped the options (the
            // unpatched wasm — see the header), which NOTEMPTY_ATSTART forbids.
            if (m !== null && retry && m[0].start === at && m[0].end === at) m = null;
            if (m === null) {
                if (!retry) break;
                // A surrogate pair is one code point but two UTF-16 code units,
                // and PCRE2 in 16-bit UTF mode rejects an offset splitting one.
                const cp = subject.codePointAt(at);
                matchEnd = at + (cp !== undefined && cp > 0xffff ? 2 : 1);
            } else {
                results.push(m);
                matchStart = m[0].start;
                matchEnd = m[0].end;
            }
            if (--safety <= 0) throw new Error('safety limit exceeded');
        }
        return results;
    }

    private getLastError(): { errorMessage: string; offset: number } {
        const bufLength = 256;
        const errBuf = cfunc.malloc(bufLength * 2);
        const actualLen = cfunc.lastErrorMessage(errBuf, bufLength);
        const errorMessage = copyStringBuffer(errBuf, actualLen);
        cfunc.free(errBuf);
        const offset = cfunc.lastErrorOffset();
        return { errorMessage, offset };
    }
}

// ── helpers (ported verbatim from upstream PCRE.js) ───────────────────────────

function encodeUTF16LE(str: string): Uint8Array {
    const buffer = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        buffer[i * 2] = code & 0xff;
        buffer[i * 2 + 1] = (code >> 8) & 0xff;
    }
    return buffer;
}

const utf16Decoder = new TextDecoder('utf-16le');

function copyStringBuffer(ptr: number, len: number): string {
    len = libpcre2.HEAPU16[ptr / 2 + (len - 1)] === 0 ? len - 1 : len;
    const encoded = libpcre2.HEAP8.subarray(ptr, ptr + len * 2);
    return utf16Decoder.decode(encoded);
}

function utf16leLen(ptr: number): number {
    let len = 0;
    while (libpcre2.getValue(ptr, 'i16', false) !== 0) {
        len++;
        ptr += 2;
    }
    return len;
}

function convertOVector(subject: string, vectorPtr: number, vectorCount: number): Record<number, Pcre2MatchGroup> {
    const table: Record<number, Pcre2MatchGroup> = {};
    for (let i = 0; i < vectorCount; i++) {
        const ptr = vectorPtr + i * 4 * 2;
        const start = libpcre2.getValue(ptr, 'i32', false);
        const end = libpcre2.getValue(ptr + 4, 'i32', false);
        table[i] = { start, end, match: subject.substring(start, end) };
    }
    return table;
}
