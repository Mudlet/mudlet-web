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
    // The Greek letters with ypogegrammeni have a one-character *simple*
    // uppercase (U+1F80 → U+1F88), but JS only exposes the full mapping, which
    // is two characters (ἈΙ) — so they are listed from UnicodeData directly.
    const greek: Array<[number, number]> = [[0x1fb3, 0x1fbc], [0x1fc3, 0x1fcc], [0x1ff3, 0x1ffc]];
    for (const base of [0x1f80, 0x1f90, 0x1fa0]) {
        for (let i = 0; i < 8; i++) greek.push([base + i, base + 8 + i]);
    }
    for (const [from, to] of greek) {
        lines.push(`u\t${String.fromCodePoint(from)}\t${String.fromCodePoint(to)}\n`);
    }
    // Titlecase, where it is not the uppercase (UnicodeData field 14 against
    // field 12): the digraphs title as their mixed-case form, and Georgian
    // Mkhedruli has an uppercase (Mtavruli, U+1C90…) but titles as itself.
    // Everything else titles as its uppercase. `utf8.title` reads these first.
    const title: Array<[number, number]> = [];
    for (const [lo, mid] of [[0x1c4, 0x1c5], [0x1c7, 0x1c8], [0x1ca, 0x1cb], [0x1f1, 0x1f2]]) {
        for (let cp = lo; cp < lo + 3; cp++) title.push([cp, mid]);
    }
    for (let cp = 0x10d0; cp <= 0x10ff; cp++) {
        if (String.fromCodePoint(cp).toUpperCase() !== String.fromCodePoint(cp)) title.push([cp, cp]);
    }
    for (const [from, to] of title) {
        lines.push(`t\t${String.fromCodePoint(from)}\t${String.fromCodePoint(to)}\n`);
    }
    cached = lines.join('');
    return cached;
}
