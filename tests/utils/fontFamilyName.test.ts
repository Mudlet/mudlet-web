// Reading a font file's declared family name (issue #103).
//
// `new FontFace(family, bytes)` has to be told the family; the browser never
// reads it out of the file. A package's font has nobody to type one, so it is
// read here — from the sfnt `name` table, the same place Qt reads it for
// desktop's `FontManager::loadFont`.
//
// The fonts below are built byte by byte rather than checked in as fixtures, so
// what each case asserts is visible in the test itself.

import { describe, it, expect } from 'vitest';
import { fontFamilyName, isFontPath } from '../../src/utils/fontFamilyName';

interface NameRecord {
    platformId: number;
    encodingId: number;
    languageId: number;
    nameId: number;
    text: string;
}

function encodeText(text: string, platformId: number): Uint8Array {
    if (platformId === 1) return new Uint8Array([...text].map(c => c.charCodeAt(0)));
    const out = new Uint8Array(text.length * 2);
    [...text].forEach((c, i) => {
        out[i * 2] = c.charCodeAt(0) >> 8;
        out[i * 2 + 1] = c.charCodeAt(0) & 0xff;
    });
    return out;
}

/** A `name` table holding exactly these records. */
function nameTable(records: NameRecord[]): Uint8Array {
    const encoded = records.map(r => encodeText(r.text, r.platformId));
    const headerLen = 6 + records.length * 12;
    const pool = encoded.reduce((n, e) => n + e.byteLength, 0);
    const table = new Uint8Array(headerLen + pool);
    const view = new DataView(table.buffer);
    view.setUint16(0, 0);                  // format
    view.setUint16(2, records.length);     // count
    view.setUint16(4, headerLen);          // offset to the string pool
    let cursor = 0;
    records.forEach((r, i) => {
        const rec = 6 + i * 12;
        view.setUint16(rec, r.platformId);
        view.setUint16(rec + 2, r.encodingId);
        view.setUint16(rec + 4, r.languageId);
        view.setUint16(rec + 6, r.nameId);
        view.setUint16(rec + 8, encoded[i].byteLength);
        view.setUint16(rec + 10, cursor);
        table.set(encoded[i], headerLen + cursor);
        cursor += encoded[i].byteLength;
    });
    return table;
}

/** A one-table sfnt font carrying `records`, optionally at an offset (so a
 *  collection can point several headers at one file). */
function sfntFont(records: NameRecord[]): Uint8Array {
    const name = nameTable(records);
    const headerLen = 12 + 16;
    const font = new Uint8Array(headerLen + name.byteLength);
    const view = new DataView(font.buffer);
    view.setUint32(0, 0x00010000);         // TrueType outlines
    view.setUint16(4, 1);                  // numTables
    // The three fields after numTables (searchRange, entrySelector, rangeShift)
    // are left zero: nothing reads them here, and neither does the real parser.
    font.set([0x6e, 0x61, 0x6d, 0x65], 12); // 'name'
    view.setUint32(12 + 8, headerLen);     // offset
    view.setUint32(12 + 12, name.byteLength);
    font.set(name, headerLen);
    return font;
}

const WINDOWS = { platformId: 3, encodingId: 1, languageId: 0x409 };
const MACINTOSH = { platformId: 1, encodingId: 0, languageId: 0 };

describe('fontFamilyName', () => {
    it('reads the family from a Windows (UTF-16BE) name record', () => {
        expect(fontFamilyName(sfntFont([
            { ...WINDOWS, nameId: 1, text: 'QAPackageFont' },
        ]))).toBe('QAPackageFont');
    });

    it('reads a Macintosh (single-byte) record when that is all there is', () => {
        expect(fontFamilyName(sfntFont([
            { ...MACINTOSH, nameId: 1, text: 'QAMacFont' },
        ]))).toBe('QAMacFont');
    });

    it('prefers the typographic family (16) over the four-style family (1)', () => {
        // A family with more than four styles puts the name a user would
        // recognise in 16 and a truncated grouping in 1.
        expect(fontFamilyName(sfntFont([
            { ...WINDOWS, nameId: 1, text: 'QABig Semibold' },
            { ...WINDOWS, nameId: 16, text: 'QABig' },
        ]))).toBe('QABig');
    });

    it('prefers the Windows record over the Macintosh one for the same name id', () => {
        expect(fontFamilyName(sfntFont([
            { ...MACINTOSH, nameId: 1, text: 'QAMac' },
            { ...WINDOWS, nameId: 1, text: 'QAWindows' },
        ]))).toBe('QAWindows');
    });

    it('ignores name ids that are not a family', () => {
        // 4 is the full font name, 6 the PostScript name — neither is what a
        // CSS font-family would ask for.
        expect(fontFamilyName(sfntFont([
            { ...WINDOWS, nameId: 4, text: 'QAThing Regular' },
            { ...WINDOWS, nameId: 6, text: 'QAThing-Regular' },
        ]))).toBeNull();
    });

    it('reads the first named face of a collection', () => {
        const inner = sfntFont([{ ...WINDOWS, nameId: 1, text: 'QACollected' }]);
        const header = 12 + 4;               // ttcf header + one offset
        const file = new Uint8Array(header + inner.byteLength);
        const view = new DataView(file.buffer);
        file.set([0x74, 0x74, 0x63, 0x66], 0); // 'ttcf'
        view.setUint32(4, 0x00010000);         // version
        view.setUint32(8, 1);                  // numFonts
        view.setUint32(12, header);            // offset to the only font
        file.set(inner, header);
        // Table offsets inside a collection are absolute within the file, so
        // the inner font's own 'name' offset has to be shifted with it.
        new DataView(file.buffer).setUint32(header + 12 + 8, header + 12 + 16);
        expect(fontFamilyName(file)).toBe('QACollected');
    });

    it('returns null rather than guessing for bytes that are not a font', () => {
        expect(fontFamilyName(new Uint8Array([1, 2, 3]))).toBeNull();
        expect(fontFamilyName(new TextEncoder().encode('<html>not a font</html>'))).toBeNull();
    });

    it('returns null for a font with no name table at all', () => {
        const font = new Uint8Array(12 + 16);
        new DataView(font.buffer).setUint32(0, 0x00010000);
        new DataView(font.buffer).setUint16(4, 1);
        font.set([0x67, 0x6c, 0x79, 0x66], 12); // 'glyf', not 'name'
        expect(fontFamilyName(font)).toBeNull();
    });

    it('does not read past the end of a truncated file', () => {
        const full = sfntFont([{ ...WINDOWS, nameId: 1, text: 'QATruncated' }]);
        for (const cut of [13, 20, 30, full.byteLength - 4]) {
            expect(() => fontFamilyName(full.slice(0, cut))).not.toThrow();
        }
    });
});

describe('isFontPath', () => {
    it('accepts the four extensions desktop picks up', () => {
        // Host::installPackageFonts, Host.cpp:3513.
        for (const ext of ['otf', 'ttf', 'ttc', 'otc']) {
            expect(isFontPath(`fonts/thing.${ext}`)).toBe(true);
            expect(isFontPath(`fonts/THING.${ext.toUpperCase()}`)).toBe(true);
        }
    });

    it('rejects everything else', () => {
        for (const path of ['config.lua', 'pkg.xml', 'images/logo.png', 'fonts', 'a.ttf.bak']) {
            expect(isFontPath(path)).toBe(false);
        }
    });
});
