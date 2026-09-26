/**
 * The case tables behind `utf8.upper` / `utf8.lower`. Mudlet bundles luautf8,
 * which maps every character by Unicode's simple (one-to-one) case mapping;
 * the pure-Lua shim only had byte-wise `string.upper`, so `utf8.upper("ärger")`
 * came back `äRGER`.
 *
 * Rather than vendor UnicodeData, the table is read off the JS engine: a
 * character whose `toUpperCase()` / `toLowerCase()` is exactly one other code
 * point is a simple mapping. Multi-character results (`ß` → `SS`) are special
 * casing, which luautf8 leaves alone, and so is this.
 *
 * Serialised as `u<TAB>from<TAB>to<LF>` / `l<TAB>…` lines — one string crosses
 * into Lua, which builds plain tables to hand to `string.gsub`. ASCII is left
 * out: `string.upper` / `string.lower` already cover it.
 */
let cached: string | null = null;

export function utf8CaseMap(): string {
    if (cached !== null) return cached;
    const lines: string[] = [];
    // Cased letters stop at the Adlam block (U+1E900); nothing above has a mapping.
    for (let cp = 0x80; cp < 0x1f000; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const ch = String.fromCodePoint(cp);
        const up = ch.toUpperCase();
        if (up !== ch && [...up].length === 1) lines.push(`u\t${ch}\t${up}\n`);
        const low = ch.toLowerCase();
        if (low !== ch && [...low].length === 1) lines.push(`l\t${ch}\t${low}\n`);
    }
    cached = lines.join('');
    return cached;
}
