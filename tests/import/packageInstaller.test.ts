// Default happy-dom environment: parseMudletXml goes through DOMParser.
//
// Issue #101: the installer used to delete the target package directory before
// it had established that the install could succeed, so every later refusal —
// a corrupt archive, an archive with no XML, "already installed" — destroyed
// the files of the copy it was declining to replace. These pin the order:
// nothing on disk changes until commit().
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
    installPackageFromBytes,
    preparePackageInstall,
} from '../../src/import/packageInstaller';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <TriggerPackage>
    <Trigger isActive="yes" isFolder="no" isTempTrigger="no" isMultiline="no" isPerlSlashGOption="no" isColorizerTrigger="no" isFilterTrigger="no" isSoundTrigger="no" isColorTrigger="no" isColorTriggerFg="no" isColorTriggerBg="no">
      <name>hello</name>
      <script>echo("hi")</script>
      <triggerType>0</triggerType>
      <conditonLineDelta>0</conditonLineDelta>
      <mStayOpen>0</mStayOpen>
      <mCommand></mCommand>
      <packageName></packageName>
      <mFgColor>#ff0000</mFgColor>
      <mBgColor>#ffff00</mBgColor>
      <mSoundFile></mSoundFile>
      <colorTriggerFgColor></colorTriggerFgColor>
      <colorTriggerBgColor></colorTriggerBgColor>
      <regexCodeList><string>hello</string></regexCodeList>
      <regexCodePropertyList><integer>1</integer></regexCodePropertyList>
    </Trigger>
  </TriggerPackage>
</MudletPackage>`;

function goodArchive(): Uint8Array {
    return zipSync({
        'mypkg.xml': strToU8(XML),
        'config.lua': strToU8('mpackage = [[mypkg]]\nversion = [[1.0]]\n'),
        'resources/logo.txt': strToU8('a resource the package ships'),
    });
}

/** An mpackage that is not a zip at all — the corrupt-download case. */
function corruptArchive(): Uint8Array {
    return strToU8('this is not a zip file, it is an error page');
}

interface FakeVfs extends ProfileVFS {
    /** Every path currently held, for asserting what an install left behind. */
    paths(): string[];
}

/**
 * In-memory ProfileVFS stand-in. `rmdir` is recursive, like the real one —
 * a stub that only forgets the directory entry would hide the very data loss
 * these tests are about.
 */
function stubVfs(): FakeVfs {
    const files = new Map<string, string | Uint8Array>();
    const dirs = new Set<string>();
    const under = (p: string, q: string) => q === p || q.startsWith(`${p}/`);
    return {
        profilePath: '/profiles/test',
        exists: (p: string) => dirs.has(p) || files.has(p),
        mkdir: (p: string) => { dirs.add(p.replace(/\/$/, '')); },
        rmdir: (p: string) => {
            for (const d of [...dirs]) if (under(p, d)) dirs.delete(d);
            for (const f of [...files.keys()]) if (under(p, f)) files.delete(f);
        },
        writeFile: (p: string, data: string) => { files.set(p, data); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, data); },
        readFile: (p: string) => String(files.get(p) ?? ''),
        readBinaryFile: (p: string) => files.get(p) as Uint8Array,
        paths: () => [...dirs, ...files.keys()].sort(),
    } as unknown as FakeVfs;
}

const PKG_DIR = '/profiles/test/mypkg';

describe('preparePackageInstall', () => {
    it('writes nothing until commit runs', () => {
        const vfs = stubVfs();
        const prepared = preparePackageInstall('mypkg.mpackage', goodArchive(), vfs);

        // The manifest and the parsed nodes are already known — which is what
        // lets a caller decide to refuse before anything is written.
        expect(prepared.manifest.name).toBe('mypkg');
        expect(prepared.manifest.version).toBe('1.0');
        expect(prepared.data.triggers.length).toBeGreaterThan(0);
        expect(vfs.paths()).toEqual([]);

        prepared.commit();
        expect(vfs.readFile(`${PKG_DIR}/resources/logo.txt`)).toBe('a resource the package ships');
        expect(vfs.exists(`${PKG_DIR}/mypkg.xml`)).toBe(true);
    });

    it('leaves an existing install intact when the new archive is corrupt', () => {
        // Issue #101, case 1: the wipe used to happen before the zip check.
        const vfs = stubVfs();
        installPackageFromBytes('mypkg.mpackage', goodArchive(), vfs);
        const before = vfs.paths();

        expect(() => preparePackageInstall('mypkg.mpackage', corruptArchive(), vfs))
            .toThrow('could not unzip package');
        expect(vfs.paths()).toEqual(before);
        expect(vfs.readFile(`${PKG_DIR}/resources/logo.txt`)).toBe('a resource the package ships');
    });

    it('leaves an existing install intact when the new archive holds no package XML', () => {
        const vfs = stubVfs();
        installPackageFromBytes('mypkg.mpackage', goodArchive(), vfs);
        const before = vfs.paths();

        const empty = zipSync({ 'readme.txt': strToU8('nothing installable here') });
        expect(() => preparePackageInstall('mypkg.mpackage', empty, vfs))
            .toThrow('no package found in mypkg.mpackage');
        expect(vfs.paths()).toEqual(before);
    });

    it('leaves nothing behind when a refused install had no previous copy', () => {
        // A refusal must not create the directory either: `getMudletHomeDir()/<name>`
        // existing is how scripts and the uninstaller decide a package has files.
        const vfs = stubVfs();
        expect(() => preparePackageInstall('mypkg.mpackage', corruptArchive(), vfs)).toThrow();
        expect(vfs.exists(PKG_DIR)).toBe(false);
    });

    it('replaces the previous copy on commit rather than merging into it', () => {
        const vfs = stubVfs();
        installPackageFromBytes('mypkg.mpackage', goodArchive(), vfs);
        vfs.writeFile(`${PKG_DIR}/stale.txt`, 'left over from the old install');

        const second = zipSync({ 'mypkg.xml': strToU8(XML) });
        installPackageFromBytes('mypkg.mpackage', second, vfs);
        expect(vfs.exists(`${PKG_DIR}/stale.txt`)).toBe(false);
        expect(vfs.exists(`${PKG_DIR}/mypkg.xml`)).toBe(true);
    });

    it('keeps a source archive staged inside the package dir', () => {
        // The "unzip into <pkgDir>/ then installPackage(<pkgDir>/foo.mpackage)"
        // pattern: the wipe would destroy the file being installed from.
        const vfs = stubVfs();
        const sourcePath = `${PKG_DIR}/mypkg.mpackage`;
        vfs.mkdir(PKG_DIR);
        vfs.writeBinaryFile(sourcePath, goodArchive());
        installPackageFromBytes('mypkg.mpackage', goodArchive(), vfs, { sourcePath });
        expect(vfs.exists(sourcePath)).toBe(true);
        expect(vfs.readFile(`${PKG_DIR}/resources/logo.txt`)).toBe('a resource the package ships');
    });

    it('rolls the directory back when a write fails partway through', () => {
        const vfs = stubVfs();
        let writes = 0;
        const realWrite = vfs.writeFile.bind(vfs);
        vfs.writeFile = (p: string, data: string) => {
            if (++writes > 1) throw new Error('quota exceeded');
            realWrite(p, data);
        };
        const prepared = preparePackageInstall('mypkg.mpackage', goodArchive(), vfs);
        expect(() => prepared.commit()).toThrow('quota exceeded');
        // Half an unpack is worse than none: it looks like an installed package.
        expect(vfs.exists(PKG_DIR)).toBe(false);
    });
});
