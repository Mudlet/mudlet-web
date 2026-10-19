// Issue #455: desktop's profile-data files are serialised QStrings.
import { describe, it, expect } from 'vitest';
import { strToU8 } from 'fflate';
import { decodeProfileData, encodeProfileData } from '../../src/import/qtProfileData';

describe('desktop profile-data files', () => {
    it('writes a big-endian byte length, then UTF-16BE', () => {
        expect(Array.from(encodeProfileData('Hero'))).toEqual([0, 0, 0, 8, 0, 0x48, 0, 0x65, 0, 0x72, 0, 0x6f]);
        expect(Array.from(encodeProfileData(''))).toEqual([0, 0, 0, 0]);
    });

    it('reads back what it writes, surrogate pairs included', () => {
        for (const s of ['', '2', 'ISO 8859-1', 'Żółw', 'smile 😀', 'x'.repeat(300)]) {
            expect(decodeProfileData(encodeProfileData(s))).toBe(s);
        }
    });

    it('reads a null QString as empty', () => {
        expect(decodeProfileData(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe('');
    });

    it('reads anything that is not a whole QString as UTF-8 text', () => {
        expect(decodeProfileData(strToU8('2'))).toBe('2');
        expect(decodeProfileData(strToU8('Hero\n'))).toBe('Hero\n');
        expect(decodeProfileData(strToU8('café'))).toBe('café');
        expect(decodeProfileData(new Uint8Array())).toBe('');
        // A length prefix that overruns the file.
        expect(decodeProfileData(new Uint8Array([0, 0, 0, 8, 0, 0x48]))).toBe('\0\0\0\b\0H');
    });
});
