/**
 * Give pcre2-wasm-universal's `_match` export an `options` argument.
 *
 * The library's C wrapper is
 *
 *     int match(code, subject, length, startOffset, matchData)
 *         { return pcre2_match(code, subject, length, startOffset, 0, matchData, NULL); }
 *
 * and its `compile` always sets PCRE2_UTF. With options fixed at 0, every
 * pcre2_match call checks that the subject is valid UTF-16 from the start
 * offset to the END of the subject, so a global match — one call per match,
 * each starting where the last one ended — costs the number of matches times
 * the length of the line: quadratic. A 64 kB line of 13 000 words took twenty
 * times as long as an 8 kB one. Mudlet (and pcre2_substitute itself) checks the
 * subject once and passes PCRE2_NO_UTF_CHECK for the rest of the loop, which
 * needs the options argument the wrapper doesn't pass through.
 *
 * The wrapper compiles to
 *
 *     local.get 0  local.get 1  local.get 2  local.get 3
 *     i32.const 0                                ;; options
 *     local.get 4
 *     call $pcre2_match_16
 *
 * so the patch retypes `_match` to take a sixth i32 (the module already
 * declares that exact signature, for pcre2_match_16 itself) and swaps
 * `i32.const 0` for `local.get 5`. Both edits are the same size as what they
 * replace, so no section or body length moves. A caller passing five arguments
 * still gets options 0 — JS fills the missing one with `undefined` → 0 — and a
 * caller passing six to the unpatched module has the sixth dropped, so either
 * side can be old without breaking the other; only the speed differs.
 *
 * Returns a patched copy, or null when the bytes aren't the build this patch
 * was written against (anything unexpected, so the caller falls back to the
 * module as shipped rather than a guess). Already-patched input comes back
 * unchanged, so it is safe to apply twice.
 */
export function patchLibpcre2Wasm(input: Uint8Array): Uint8Array<ArrayBuffer> | null {
    try {
        return patch(input);
    } catch {
        return null;
    }
}

const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_EXPORT = 7;
const SECTION_CODE = 10;
const I32 = 0x7f;
const LOCAL_GET = 0x20;
const I32_CONST = 0x41;
const CALL = 0x10;
const END = 0x0b;

function patch(input: Uint8Array): Uint8Array<ArrayBuffer> | null {
    const bytes = new Uint8Array(input);
    if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;

    let pos = 8;
    const readU32 = (): number => {
        let result = 0;
        let shift = 0;
        for (;;) {
            const b = bytes[pos++];
            if (b === undefined) throw new Error('truncated');
            result |= (b & 0x7f) << shift;
            if (!(b & 0x80)) return result >>> 0;
            shift += 7;
        }
    };
    const skipName = () => { const n = readU32(); pos += n; };
    const readName = () => {
        const n = readU32();
        const s = new TextDecoder().decode(bytes.subarray(pos, pos + n));
        pos += n;
        return s;
    };

    /** param count of each i32-only signature returning one i32, else -1 */
    let i32Sigs: number[] = [];
    let importedFuncs = 0;
    let functionSection = -1;
    let codeSection = -1;
    let matchFunc = -1;

    while (pos < bytes.length) {
        const id = bytes[pos++];
        const size = readU32();
        const start = pos;
        const end = start + size;
        if (id === SECTION_TYPE) {
            const count = readU32();
            i32Sigs = [];
            for (let i = 0; i < count; i++) {
                if (bytes[pos++] !== 0x60) throw new Error('type form');
                const params = readU32();
                let allI32 = true;
                for (let p = 0; p < params; p++) if (bytes[pos++] !== I32) allI32 = false;
                const results = readU32();
                for (let r = 0; r < results; r++) if (bytes[pos++] !== I32) allI32 = false;
                i32Sigs.push(allI32 && results === 1 ? params : -1);
            }
        } else if (id === SECTION_IMPORT) {
            const count = readU32();
            for (let i = 0; i < count; i++) {
                skipName();
                skipName();
                const kind = bytes[pos++];
                if (kind === 0) { readU32(); importedFuncs++; }
                else if (kind === 1) { pos++; const flags = readU32(); readU32(); if (flags & 1) readU32(); }
                else if (kind === 2) { const flags = readU32(); readU32(); if (flags & 1) readU32(); }
                else if (kind === 3) { pos += 2; }
                else throw new Error('import kind');
            }
        } else if (id === SECTION_FUNCTION) {
            functionSection = start;
        } else if (id === SECTION_EXPORT) {
            const count = readU32();
            for (let i = 0; i < count; i++) {
                const name = readName();
                const kind = bytes[pos++];
                const index = readU32();
                if (kind === 0 && name === '_match') matchFunc = index;
            }
        } else if (id === SECTION_CODE) {
            codeSection = start;
        }
        pos = end;
    }
    if (functionSection < 0 || codeSection < 0 || matchFunc < importedFuncs) return null;
    const local = matchFunc - importedFuncs;

    // The function section entry naming `_match`'s type.
    pos = functionSection;
    const funcCount = readU32();
    if (local >= funcCount) return null;
    for (let i = 0; i < local; i++) readU32();
    const typeAt = pos;
    const typeIndex = readU32();
    if (pos - typeAt !== 1) return null;
    const sixArgs = i32Sigs.indexOf(6);
    if (sixArgs < 0 || sixArgs > 0x7f) return null;
    if (typeIndex === sixArgs) {
        // Already retyped — accept only if the body reads its sixth argument.
        return bodyMatches(bytes, codeSection, local, LOCAL_GET, 5) ? bytes : null;
    }
    if (i32Sigs[typeIndex] !== 5) return null;

    const optionsAt = bodyMatches(bytes, codeSection, local, I32_CONST, 0);
    if (optionsAt === false) return null;
    bytes[typeAt] = sixArgs;
    bytes[optionsAt] = LOCAL_GET;
    bytes[optionsAt + 1] = 5;
    return bytes;
}

/**
 * Whether `_match`'s body is the four-argument pass-through, `op arg`, the
 * fifth argument and a call — returning the offset of `op`, or false.
 */
function bodyMatches(bytes: Uint8Array, codeSection: number, local: number, op: number, arg: number): number | false {
    let pos = codeSection;
    const readU32 = (): number => {
        let result = 0;
        let shift = 0;
        for (;;) {
            const b = bytes[pos++];
            result |= (b & 0x7f) << shift;
            if (!(b & 0x80)) return result >>> 0;
            shift += 7;
        }
    };
    const count = readU32();
    if (local >= count) return false;
    for (let i = 0; i < local; i++) { const size = readU32(); pos += size; }
    const size = readU32();
    const body = pos;
    const expectHead = [0, LOCAL_GET, 0, LOCAL_GET, 1, LOCAL_GET, 2, LOCAL_GET, 3, op, arg, LOCAL_GET, 4, CALL];
    for (let i = 0; i < expectHead.length; i++) if (bytes[body + i] !== expectHead[i]) return false;
    // The call's function index, then the end of the body.
    pos = body + expectHead.length;
    readU32();
    if (bytes[pos] !== END || pos + 1 !== body + size) return false;
    return body + 9;
}
