// Encode SQLite result rows as a Lua source literal so a single loadstring()
// inside Lua can materialize the whole table tree. Avoids wasmoon's per-cell
// JS↔WASM boundary crossings on bulk fetches (people DB, etc.) — the dominant
// cost on /laduj-style profile loads.
//
// Output format: `{{...},{...},...}` — a Lua array of arrays, 1-indexed by
// construction. Cells are emitted as numbers, double-quoted strings (with
// minimal escapes), `nil` for SQL NULL, or boolean literals if sqlite ever
// hands one back. Binary blobs are escaped byte-by-byte as `\DDD` (decimal,
// always 3 digits) so non-UTF-8 byte sequences round-trip safely.

type SqlCell = string | number | bigint | boolean | null | undefined | Uint8Array;

/**
 * Encode a single Lua string literal. Non-ASCII characters pass through
 * verbatim — they ride out to Lua as UTF-8 bytes via wasmoon's string
 * encoding, and Lua treats strings as raw bytes, so the round trip is exact.
 * Only control characters and the few escape-significant ASCII chars need
 * explicit escapes. `\DDD` is always padded to 3 digits to avoid the
 * `\1a` ambiguity (Lua reads up to 3 decimal digits per escape).
 */
function encodeLuaString(s: string): string {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0x22)      out += '\\"';
        else if (c === 0x5c) out += '\\\\';
        else if (c === 0x0a) out += '\\n';
        else if (c === 0x0d) out += '\\r';
        else if (c === 0x09) out += '\\t';
        else if (c < 0x20 || c === 0x7f) {
            out += '\\' + c.toString(10).padStart(3, '0');
        } else {
            out += s[i];
        }
    }
    out += '"';
    return out;
}

// Each byte's spelling inside a Lua string literal, computed once.
const BYTE_LITERAL: string[] = Array.from({length: 256}, (_, c) => {
    if (c === 0x22) return '\\"';
    if (c === 0x5c) return '\\\\';
    if (c >= 0x20 && c < 0x7f) return String.fromCharCode(c);
    return '\\' + c.toString(10).padStart(3, '0');
});

/** Raw bytes as a Lua string literal: printable ASCII as itself, everything
 *  else as a `\DDD` escape. The source is pure ASCII, so it crosses the wasmoon
 *  bridge without being UTF-8 re-encoded — the bytes Lua gets are the bytes. */
export function encodeLuaBytes(buf: Uint8Array): string {
    let out = '"';
    for (let i = 0; i < buf.length; i++) out += BYTE_LITERAL[buf[i]];
    return out + '"';
}

const encodeBytes = encodeLuaBytes;

function encodeCell(v: SqlCell): string {
    if (v === null || v === undefined) return 'nil';
    if (typeof v === 'number') {
        // NaN / ±Inf aren't writable Lua literals; emit arithmetic expressions
        // that produce the same value when the chunk runs.
        if (Number.isFinite(v))  return String(v);
        if (Number.isNaN(v))     return '(0/0)';
        return v > 0 ? '(1/0)' : '(-1/0)';
    }
    // An INTEGER beyond 2^53 read as a BigInt: Lua 5.1 has only doubles, and
    // desktop LuaSQL converts with a plain (double) cast, so it is a number,
    // never a string.
    if (typeof v === 'bigint') return encodeCell(Number(v));
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string')  return encodeLuaString(v);
    if (v instanceof Uint8Array) return encodeBytes(v);
    return encodeLuaString(String(v));
}

export function encodeRowsToLuaSource(rows: unknown[][]): string {
    // Array buffer + single join: ~50MB/s in V8 vs. cons-string churn from
    // tight `+=` chains over millions of fragments.
    const parts: string[] = ['{'];
    for (let r = 0; r < rows.length; r++) {
        if (r > 0) parts.push(',');
        parts.push('{');
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
            if (c > 0) parts.push(',');
            parts.push(encodeCell(row[c] as SqlCell));
        }
        parts.push('}');
    }
    parts.push('}');
    return parts.join('');
}
