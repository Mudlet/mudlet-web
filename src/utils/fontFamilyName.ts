// Reading a font file's own family name.
//
// `new FontFace(family, bytes)` takes the family as an argument — the browser
// never tells you what the file calls itself. Everywhere a human is in the loop
// (the FontPicker) that is fine, because they type it. A font shipped inside a
// package has nobody to type it, and registering it under its file name would
// mean a stylesheet asking for the family the package's own scripts name could
// not find it. Desktop has no such problem: `FontManager::loadFont` hands the
// file to Qt, which reads the name out itself (`QFontDatabase::applicationFontFamilies`).
//
// So this reads the one table that carries it. The format is sfnt, shared by
// TrueType and OpenType and documented as the OpenType `name` table.

/** Preferred (typographic) family — what a family with more than four styles
 *  uses, and what desktop reports for one. */
const NAME_ID_TYPOGRAPHIC_FAMILY = 16;
/** Family name. Present in every font; the fallback when there is no 16. */
const NAME_ID_FAMILY = 1;

const SFNT_HEADER_BYTES = 12;
const TABLE_RECORD_BYTES = 16;
const NAME_RECORD_BYTES = 12;

function tagAt(view: DataView, offset: number): string {
    return String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
}

/**
 * Decode one name record's bytes.
 *
 * Windows records (platform 3) and the ISO/Unicode platform 0 are UTF-16BE;
 * Macintosh Roman (platform 1, encoding 0) is a single-byte encoding whose
 * lower half is ASCII — which is all a family name is in practice, so it is
 * read as Latin-1 rather than carrying a MacRoman table for the handful of
 * accented codepoints above 127.
 */
function decodeNameRecord(bytes: Uint8Array, platformId: number): string {
    if (platformId === 1) {
        return new TextDecoder('latin1').decode(bytes);
    }
    return new TextDecoder('utf-16be').decode(bytes);
}

/** Whether `a` is a better source for the family name than `b`. */
function betterRecord(
    a: { nameId: number; platformId: number },
    b: { nameId: number; platformId: number } | null,
): boolean {
    if (!b) return true;
    // 16 beats 1: a font with more than four styles puts the name a user would
    // recognise in 16 and a truncated four-style grouping in 1.
    if (a.nameId !== b.nameId) return a.nameId === NAME_ID_TYPOGRAPHIC_FAMILY;
    // Windows records first — they are UTF-16 and unambiguous, where the Mac
    // ones are a legacy single-byte encoding.
    if (a.platformId !== b.platformId) return a.platformId === 3;
    return false;
}

/** The family name declared by one sfnt font, starting at `base`. */
function familyFromSfnt(view: DataView, base: number): string | null {
    if (base + SFNT_HEADER_BYTES > view.byteLength) return null;
    const numTables = view.getUint16(base + 4);
    let nameOffset = 0;
    for (let i = 0; i < numTables; i++) {
        const rec = base + SFNT_HEADER_BYTES + i * TABLE_RECORD_BYTES;
        if (rec + TABLE_RECORD_BYTES > view.byteLength) return null;
        if (tagAt(view, rec) === 'name') {
            nameOffset = view.getUint32(rec + 8);
            break;
        }
    }
    // Table offsets are absolute within the file even inside a collection, so
    // this is deliberately not relative to `base`.
    if (!nameOffset || nameOffset + 6 > view.byteLength) return null;

    const count = view.getUint16(nameOffset + 2);
    // Where the string pool starts, relative to the table.
    const storage = nameOffset + view.getUint16(nameOffset + 4);

    let best: { nameId: number; platformId: number; text: string } | null = null;
    for (let i = 0; i < count; i++) {
        const rec = nameOffset + 6 + i * NAME_RECORD_BYTES;
        if (rec + NAME_RECORD_BYTES > view.byteLength) break;
        const nameId = view.getUint16(rec + 6);
        if (nameId !== NAME_ID_FAMILY && nameId !== NAME_ID_TYPOGRAPHIC_FAMILY) continue;
        const platformId = view.getUint16(rec);
        if (!betterRecord({ nameId, platformId }, best)) continue;

        const length = view.getUint16(rec + 8);
        const start = storage + view.getUint16(rec + 10);
        if (start + length > view.byteLength) continue;
        const text = decodeNameRecord(
            new Uint8Array(view.buffer, view.byteOffset + start, length),
            platformId,
        ).trim();
        if (text) best = { nameId, platformId, text };
    }
    return best?.text ?? null;
}

/**
 * The family name a font file declares, or null when the bytes are not a font
 * this can read.
 *
 * Null is a normal answer, not an error: a package may ship a font in a format
 * with no sfnt wrapper, and the caller's job is then to say so rather than to
 * register the file under a name nothing would ask for.
 */
export function fontFamilyName(bytes: Uint8Array): string | null {
    if (bytes.byteLength < SFNT_HEADER_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // A collection (.ttc/.otc) is a header followed by offsets to ordinary sfnt
    // fonts. Every face in one shares a family in practice, so the first that
    // names itself answers for the file — which is also what Qt reports first.
    if (tagAt(view, 0) === 'ttcf') {
        const numFonts = view.getUint32(8);
        for (let i = 0; i < numFonts; i++) {
            const rec = 12 + i * 4;
            if (rec + 4 > view.byteLength) break;
            const family = familyFromSfnt(view, view.getUint32(rec));
            if (family) return family;
        }
        return null;
    }
    return familyFromSfnt(view, 0);
}

/** File extensions desktop's `Host::installPackageFonts` picks up
 *  (Host.cpp:3513). */
export const FONT_EXTENSIONS = ['.otf', '.ttf', '.ttc', '.otc'] as const;

export function isFontPath(path: string): boolean {
    const lower = path.toLowerCase();
    return FONT_EXTENSIONS.some(ext => lower.endsWith(ext));
}
