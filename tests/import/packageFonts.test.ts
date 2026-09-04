// Fonts shipped inside a package (issue #103).
//
// They were unpacked correctly and then never registered with the browser, so
// the profile that had just installed the package could not use the font:
// `getAvailableFonts()` did not list it, `document.fonts` never grew, and every
// element asking for the family fell back. No error, no warning.
//
// Desktop walks the unpacked package directory recursively and loads every
// `.otf/.ttf/.ttc/.otc` it finds (`Host::installPackageFonts`, Host.cpp:3513),
// and re-runs that for every installed package on profile open
// (`Host::refreshPackageFonts`, :3529).
//
// `loadFontFromVfs` is mocked: it is the one step that needs a real FontFace,
// and what is under test here is which files are found and what family each is
// registered under.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loaded: { family: string; path: string }[] = [];
let loadShouldThrow: string | null = null;

vi.mock('../../src/utils/fontLoader', () => ({
    loadFontFromVfs: async (family: string, path: string) => {
        if (loadShouldThrow) throw new Error(loadShouldThrow);
        loaded.push({ family, path });
    },
}));

const { installPackageFonts, refreshPackageFonts } = await import('../../src/import/packageFonts');
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import type { PackageManifest } from '../../src/storage/schema';

const PROFILE = '/profiles/test';

/** A minimal sfnt font declaring one Windows family-name record. Enough for
 *  the real `fontFamilyName` to read, which is deliberately not mocked. */
function fontNamed(family: string): Uint8Array {
    const text = new Uint8Array(family.length * 2);
    [...family].forEach((c, i) => { text[i * 2 + 1] = c.charCodeAt(0); });
    const nameHeader = 6 + 12;
    const name = new Uint8Array(nameHeader + text.byteLength);
    const nv = new DataView(name.buffer);
    nv.setUint16(2, 1);              // one record
    nv.setUint16(4, nameHeader);     // string pool offset
    nv.setUint16(6, 3);              // platform: Windows
    nv.setUint16(6 + 2, 1);          // encoding: UTF-16BE
    nv.setUint16(6 + 6, 1);          // nameId: family
    nv.setUint16(6 + 8, text.byteLength);
    name.set(text, nameHeader);

    const headerLen = 12 + 16;
    const font = new Uint8Array(headerLen + name.byteLength);
    const fv = new DataView(font.buffer);
    fv.setUint32(0, 0x00010000);
    fv.setUint16(4, 1);
    font.set([0x6e, 0x61, 0x6d, 0x65], 12); // 'name'
    fv.setUint32(20, headerLen);
    fv.setUint32(24, name.byteLength);
    font.set(name, headerLen);
    return font;
}

/** In-memory VFS with a directory listing, which is what the walk needs. */
function stubVfs(files: Record<string, Uint8Array | string>): ProfileVFS {
    const paths = new Set(Object.keys(files));
    const dirs = new Set<string>();
    for (const p of paths) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return {
        profilePath: PROFILE,
        exists: (p: string) => paths.has(p) || dirs.has(p),
        readdir: (p: string) => {
            if (!dirs.has(p)) throw new Error(`ENOTDIR: ${p}`);
            const out = new Set<string>();
            for (const candidate of [...paths, ...dirs]) {
                if (!candidate.startsWith(`${p}/`)) continue;
                out.add(candidate.slice(p.length + 1).split('/')[0]);
            }
            return [...out];
        },
        readBinaryFile: (p: string) => {
            const v = files[p];
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return typeof v === 'string' ? new TextEncoder().encode(v) : v;
        },
    } as unknown as ProfileVFS;
}

const manifest = (name: string): PackageManifest =>
    ({ name, sourceFile: `${name}.mpackage`, installedAt: '' }) as PackageManifest;

beforeEach(() => { loaded.length = 0; loadShouldThrow = null; });

describe('installPackageFonts', () => {
    it('registers a font under the family the file declares, not its file name', () => {
        const vfs = stubVfs({
            [`${PROFILE}/qafontpkg/qafontpkg.xml`]: '<MudletPackage/>',
            [`${PROFILE}/qafontpkg/fonts/qafont.ttf`]: fontNamed('QAPackageFont'),
        });
        return installPackageFonts(manifest('qafontpkg'), vfs).then(result => {
            expect(result.registered).toEqual(['QAPackageFont']);
            expect(result.warnings).toEqual([]);
            expect(loaded).toEqual([
                { family: 'QAPackageFont', path: `${PROFILE}/qafontpkg/fonts/qafont.ttf` },
            ]);
        });
    });

    it('walks subdirectories, as desktop\'s QDirIterator does', async () => {
        const vfs = stubVfs({
            [`${PROFILE}/deep/a.ttf`]: fontNamed('QATop'),
            [`${PROFILE}/deep/ui/fonts/b.otf`]: fontNamed('QANested'),
            [`${PROFILE}/deep/ui/fonts/more/c.ttc`]: fontNamed('QADeeper'),
        });
        const result = await installPackageFonts(manifest('deep'), vfs);
        expect(result.registered.sort()).toEqual(['QADeeper', 'QANested', 'QATop']);
    });

    it('ignores files that are not fonts', async () => {
        const vfs = stubVfs({
            [`${PROFILE}/mixed/mixed.xml`]: '<MudletPackage/>',
            [`${PROFILE}/mixed/config.lua`]: 'mpackage = [[mixed]]',
            [`${PROFILE}/mixed/images/logo.png`]: new Uint8Array([1, 2, 3]),
            [`${PROFILE}/mixed/real.ttf`]: fontNamed('QAOnlyOne'),
        });
        const result = await installPackageFonts(manifest('mixed'), vfs);
        expect(result.registered).toEqual(['QAOnlyOne']);
    });

    it('warns instead of guessing when a font declares no family', async () => {
        const vfs = stubVfs({ [`${PROFILE}/bad/broken.ttf`]: new Uint8Array([0, 1, 2, 3]) });
        const result = await installPackageFonts(manifest('bad'), vfs);
        expect(result.registered).toEqual([]);
        // Registering it under its file name would produce a family nothing
        // asks for — silence is the bug, so this has to say something.
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('bad/broken.ttf');
        expect(result.warnings[0]).toContain('no family name');
    });

    it('carries on past a font that will not load, and reports it', async () => {
        loadShouldThrow = 'FontFace rejected the data';
        const vfs = stubVfs({ [`${PROFILE}/pkg/a.ttf`]: fontNamed('QAFails') });
        const result = await installPackageFonts(manifest('pkg'), vfs);
        expect(result.registered).toEqual([]);
        expect(result.warnings[0]).toContain('QAFails');
        expect(result.warnings[0]).toContain('FontFace rejected the data');
    });

    it('does nothing for a package with no directory on disk', async () => {
        // A plain-XML package keeps no files, so it cannot be shipping a font.
        const result = await installPackageFonts(manifest('xmlonly'), stubVfs({}));
        expect(result).toEqual({ registered: [], warnings: [] });
        expect(loaded).toEqual([]);
    });
});

describe('refreshPackageFonts', () => {
    it('re-registers every installed package\'s fonts', async () => {
        // The half without which a package's font works until the tab is closed
        // and then silently stops.
        const vfs = stubVfs({
            [`${PROFILE}/one/a.ttf`]: fontNamed('QAOne'),
            [`${PROFILE}/two/b.ttf`]: fontNamed('QATwo'),
            [`${PROFILE}/three/notafont.txt`]: 'nothing here',
        });
        const result = await refreshPackageFonts(
            [manifest('one'), manifest('two'), manifest('three')], vfs,
        );
        expect(result.registered).toEqual(['QAOne', 'QATwo']);
        expect(result.warnings).toEqual([]);
    });
});
