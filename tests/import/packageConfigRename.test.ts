// Default happy-dom environment: parseMudletXml needs DOMParser.
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
    installPackageFromBytes,
    uninstallPackageFiles,
    moduleXmlAbsolutePath,
} from '../../src/import/packageInstaller';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/**
 * Mudlet lets a package rename itself: `config.lua` declares `mpackage`, and
 * that — not the archive's filename — is the name the package is installed as.
 * It is how something published as `mypkg-2.1.3.mpackage` presents itself as
 * `mypkg`. Desktop unpacks under the filename, reads config.lua, then renames
 * the folder on disk before importing the XML, so the folder, the node tags and
 * the installed-package list all agree (`Host::installPackage`,
 * src/Host.cpp:2130-2150).
 *
 * We only put the declared name in the manifest, leaving the directory and every
 * node's packageName tag on the filename. Uninstall resolves both of those from
 * `manifest.name`, so it removed nothing at all.
 */

/** Minimal in-memory stand-in for the ProfileVFS methods the installer touches. */
function stubVfs(): ProfileVFS & { files: Map<string, string | Uint8Array>; dirs: Set<string> } {
    const files = new Map<string, string | Uint8Array>();
    const dirs = new Set<string>();
    const under = (p: string) => (k: string) => k === p || k.startsWith(`${p}/`);
    const vfs = {
        profilePath: '/profiles/test',
        files,
        dirs,
        exists: (p: string) => dirs.has(p) || files.has(p),
        mkdir: (p: string) => { dirs.add(p.replace(/\/$/, '')); },
        rmdir: (p: string) => {
            const hit = under(p);
            for (const k of [...dirs]) if (hit(k)) dirs.delete(k);
            for (const k of [...files.keys()]) if (hit(k)) files.delete(k);
        },
        rename: (oldPath: string, newPath: string) => {
            const hit = under(oldPath);
            for (const k of [...dirs]) if (hit(k)) { dirs.delete(k); dirs.add(newPath + k.slice(oldPath.length)); }
            for (const k of [...files.keys()]) if (hit(k)) {
                files.set(newPath + k.slice(oldPath.length), files.get(k)!);
                files.delete(k);
            }
        },
        readFile: (p: string) => {
            const v = files.get(p);
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return typeof v === 'string' ? v : new TextDecoder().decode(v);
        },
        writeFile: (p: string, data: string) => { files.set(p, data); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, data); },
        flush: async () => {},
    };
    return vfs as unknown as ProfileVFS & { files: typeof files; dirs: typeof dirs };
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <TriggerPackage>
    <Trigger isActive="yes" isFolder="no" isTempTrigger="no" isMultiline="no" isPerlSlashGOption="no" isColorizerTrigger="no" isFilterTrigger="no" isSoundTrigger="no" isColorTrigger="no" isColorTriggerFg="no" isColorTriggerBg="no">
      <name>qa trigger</name>
      <script>echo("hi")</script>
      <packageName/>
      <regexCodeList><string>hello</string></regexCodeList>
      <regexCodePropertyList><integer>1</integer></regexCodePropertyList>
    </Trigger>
  </TriggerPackage>
  <ScriptPackage>
    <Script isActive="yes" isFolder="no">
      <name>qa script</name>
      <script>-- body</script>
      <packageName/>
      <eventHandlerList></eventHandlerList>
    </Script>
  </ScriptPackage>
</MudletPackage>`;

function archive(opts: { config?: string } = {}): Uint8Array {
    const entries: Record<string, Uint8Array> = {
        'qa-import-pkg.xml': strToU8(XML),
        'images/logo.txt': strToU8('not really an image'),
    };
    if (opts.config) entries['config.lua'] = strToU8(opts.config);
    return zipSync(entries);
}

const FILE = 'qa-import-pkg-1.0.mpackage';

describe('installPackageFromBytes — config.lua renames the package', () => {
    it('installs under the declared name: directory, node tags and manifest agree', () => {
        const vfs = stubVfs();
        const { manifest, data } = installPackageFromBytes(
            FILE, archive({ config: 'mpackage = "qaRenamedPkg"\nversion = "1.0"\n' }), vfs,
        );

        expect(manifest.name).toBe('qaRenamedPkg');
        // Every imported node is tagged with the installed name — the store's
        // uninstall strips by that tag and looks it up from manifest.name.
        for (const node of [...data.triggers, ...data.scripts]) {
            expect(node.packageName).toBe('qaRenamedPkg');
        }
        // The unpacked payload moved with the name, as it does on desktop.
        const paths = [...vfs.files.keys()].sort();
        expect(paths).toEqual([
            '/profiles/test/qaRenamedPkg/config.lua',
            '/profiles/test/qaRenamedPkg/images/logo.txt',
            '/profiles/test/qaRenamedPkg/qa-import-pkg.xml',
        ]);
        expect(vfs.exists('/profiles/test/qa-import-pkg-1.0')).toBe(false);
        // ...so a module reload resolves to a file that actually exists.
        const xmlPath = moduleXmlAbsolutePath(manifest, vfs);
        expect(xmlPath).toBe('/profiles/test/qaRenamedPkg/qa-import-pkg.xml');
        expect(vfs.exists(xmlPath!)).toBe(true);
    });

    it('uninstall removes the renamed package files', async () => {
        const vfs = stubVfs();
        const { manifest } = installPackageFromBytes(
            FILE, archive({ config: 'mpackage = "qaRenamedPkg"\n' }), vfs,
        );
        await uninstallPackageFiles(manifest, vfs);
        expect([...vfs.files.keys()]).toEqual([]);
    });

    it('re-installing from a differently named file leaves only one copy', () => {
        const vfs = stubVfs();
        const cfg = 'mpackage = "qaRenamedPkg"\n';
        installPackageFromBytes('qa-import-pkg-1.0.mpackage', archive({ config: cfg }), vfs);
        installPackageFromBytes('qa-import-pkg-2.0.mpackage', archive({ config: cfg }), vfs);

        const dirs = new Set([...vfs.files.keys()].map(p => p.split('/')[3]));
        expect([...dirs]).toEqual(['qaRenamedPkg']);
    });

    it('control: without config.lua the filename still names the package', () => {
        const vfs = stubVfs();
        const { manifest, data } = installPackageFromBytes(FILE, archive(), vfs);

        expect(manifest.name).toBe('qa-import-pkg-1.0');
        expect(data.triggers[0].packageName).toBe('qa-import-pkg-1.0');
        expect(vfs.exists('/profiles/test/qa-import-pkg-1.0/qa-import-pkg.xml')).toBe(true);
    });

    it('sanitizes a declared name that would escape the profile directory', () => {
        const vfs = stubVfs();
        const { manifest } = installPackageFromBytes(
            FILE, archive({ config: 'mpackage = "../evil"\n' }), vfs,
        );
        expect(manifest.name).toBe('.._evil');
        expect(vfs.exists('/profiles/test/.._evil/config.lua')).toBe(true);
    });
});
