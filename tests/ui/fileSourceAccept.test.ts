import { describe, it, expect } from 'vitest';
import { acceptToRegExp } from '../../src/ui/components/FileSourceButton';

// The dual-source picker reuses one `accept` string for both halves: the OS
// picker takes it verbatim, and the VFS tree needs it as a filename filter.
// VFS entries carry no MIME type, so the translation has to be lenient where it
// can't be exact — a filter that hides every file would make the profile source
// look empty.

describe('acceptToRegExp', () => {
    it('matches the listed extensions, case-insensitively', () => {
        const re = acceptToRegExp('.xml,.mpackage,.zip')!;
        expect(re.test('package.mpackage')).toBe(true);
        expect(re.test('Profile.XML')).toBe(true);
        expect(re.test('map.dat')).toBe(false);
        // Extension has to be terminal — a name that merely contains it doesn't count.
        expect(re.test('notes.zip.txt')).toBe(false);
    });

    it('expands type/* wildcards into the extensions a VFS name can carry', () => {
        const re = acceptToRegExp('image/*')!;
        expect(re.test('logo.png')).toBe(true);
        expect(re.test('icon.WEBP')).toBe(true);
        expect(re.test('theme.css')).toBe(false);
    });

    it('ignores concrete MIME types but keeps the extensions beside them', () => {
        const re = acceptToRegExp('application/json,.json')!;
        expect(re.test('logs.json')).toBe(true);
        expect(re.test('logs.txt')).toBe(false);
    });

    it('filters nothing when nothing translatable is left', () => {
        // All-MIME accept lists would otherwise hide every file in the tree.
        expect(acceptToRegExp('application/json')).toBeUndefined();
        expect(acceptToRegExp('')).toBeUndefined();
        expect(acceptToRegExp(undefined)).toBeUndefined();
    });

    it('escapes regex metacharacters in extensions', () => {
        const re = acceptToRegExp('.d+t')!;
        expect(re.test('map.d+t')).toBe(true);
        expect(re.test('map.ddt')).toBe(false);
    });
});
