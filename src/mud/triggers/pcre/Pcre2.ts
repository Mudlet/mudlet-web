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
 * Anything outside the trigger engine (e.g. the Lua `rex` module) keeps using
 * the upstream package directly; both share the same wasm module instance.
 */
import libpcre2 from 'pcre2-wasm-universal/libpcre2';

const PCRE2_NO_MATCH = -1;

type Cfunc = (...args: number[]) => number;
interface CFuncs {
    malloc: (bytes: number) => number;
    free: (ptr: number) => void;
    compile: Cfunc;
    destroyCode: Cfunc;
    lastErrorMessage: Cfunc;
    lastErrorOffset: Cfunc;
    /** match(codePtr, subjectPtr, lengthInCodeUnits, startOffset, matchDataPtr) */
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
            match: w('match', 'number', ['number', 'number', 'number', 'number', 'number']),
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
        }
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
        const startOffset = start || 0;

        ensureLineEncoded(subject);
        if (this.matchData === 0) this.matchData = cfunc.createMatchData(this.codePtr);

        const result = cfunc.match(this.codePtr, bufPtr, bufLen, startOffset, this.matchData);
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

    matchAll(subject: string): Pcre2Match[] {
        // Mudlet's global-match loop (TAlias::match, TTrigger::match_perl):
        // resume at the end of the last match, and when that match was
        // zero-width step past the position rather than asking PCRE2 for the
        // same empty match at the same offset for ever. Upstream's wrapper only
        // does `start = iter[0].end`, so a pattern that can match nothing —
        // `(\d*)`, the one Trigger_spec and Alias_spec use — spins until the
        // safety cap fires, and that throw takes the whole line's trigger pass
        // down with it.
        //
        // Mudlet retries at the same offset with PCRE2_NOTEMPTY_ATSTART before
        // stepping; the `match` export this wrapper is built on takes no options
        // argument, so the step here is unconditional. The two differ only for a
        // pattern that prefers an empty match where a non-empty one also starts.
        const results: Pcre2Match[] = [];
        let start = 0;
        // Stepping one code point at a time over a long line is legitimate, so
        // the cap has to scale with the subject. It is only here so that a bug
        // in the loop terminates instead of hanging the tab.
        let safety = 2 * subject.length + 1000;
        let iter: Pcre2Match | null;
        while ((iter = this.match(subject, start)) !== null) {
            results.push(iter);
            const whole = iter[0];
            if (whole.end > whole.start) {
                start = whole.end;
            } else {
                // A surrogate pair is one code point but two UTF-16 code units,
                // and PCRE2 in 16-bit UTF mode rejects an offset splitting one.
                const cp = subject.codePointAt(whole.end);
                start = whole.end + (cp !== undefined && cp > 0xffff ? 2 : 1);
            }
            safety--;
            if (safety <= 0) throw new Error('safety limit exceeded');
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
