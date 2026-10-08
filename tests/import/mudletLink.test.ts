import { describe, it, expect } from 'vitest';
import { strFromU8, strToU8 } from 'fflate';
import { findNewestCurrentXml, isMudletProfileVfs, opensAsLinkedProfile, readNewestParseableXml, type LinkedVfsReader } from '../../src/import/mudletLink';

// A minimal in-memory VfsReader. `files` maps a relative path to its mtime (ms);
// `contents` optionally maps a path to file text or bytes. Directories are inferred.
function mockVfs(files: Record<string, number>, contents: Record<string, string | Uint8Array> = {}): LinkedVfsReader {
    const paths = Object.keys(files);
    return {
        exists: (p) => paths.includes(p) || paths.some(f => f.startsWith(`${p}/`)),
        readdir: (p) => {
            const prefix = `${p}/`;
            return [...new Set(paths.filter(f => f.startsWith(prefix)).map(f => f.slice(prefix.length).split('/')[0]))];
        },
        stat: (p) => (p in files ? { mtime: new Date(files[p]) } : null),
        readFile: (p) => { const c = contents[p] ?? ''; return typeof c === 'string' ? c : strFromU8(c); },
        readBinaryFile: (p) => { const c = contents[p] ?? ''; return typeof c === 'string' ? strToU8(c) : c; },
    };
}

const VALID_XML = '<?xml version="1.0"?><MudletPackage version="1.001"><HostPackage><Host><name>P</name></Host></HostPackage></MudletPackage>';

describe('findNewestCurrentXml', () => {
    it('returns null when there is no current/ directory', () => {
        const vfs = mockVfs({ 'map/2026map': 1 });
        expect(findNewestCurrentXml(vfs)).toBeNull();
        expect(isMudletProfileVfs(vfs)).toBe(false);
    });

    it('picks the most recently modified save', () => {
        const vfs = mockVfs({
            'current/2026-06-26#11-50-18.xml': 1000,
            'current/2026-06-26#11-57-29.xml': 2000,
            'current/autosave.xml': 1500,
        });
        expect(findNewestCurrentXml(vfs)).toBe('current/2026-06-26#11-57-29.xml');
        expect(isMudletProfileVfs(vfs)).toBe(true);
    });

    it('deprioritizes autosave.xml in favor of a timestamped save', () => {
        // autosave is not what Mudlet loads — a real timestamped save wins even
        // when autosave has the newer mtime.
        const vfs = mockVfs({
            'current/2026-06-26#11-50-18.xml': 1000,
            'current/autosave.xml': 9000,
        });
        expect(findNewestCurrentXml(vfs)).toBe('current/2026-06-26#11-50-18.xml');
    });

    it('falls back to the latest timestamp filename when no mtimes and no autosave', () => {
        const vfs = mockVfs({
            'current/2026-06-26#11-50-18.xml': 0,
            'current/2026-06-26#11-57-29.xml': 0,
        });
        expect(findNewestCurrentXml(vfs)).toBe('current/2026-06-26#11-57-29.xml');
    });

    it('ignores non-xml files in current/', () => {
        const vfs = mockVfs({ 'current/notes.txt': 5000, 'current/save.xml': 1000 });
        expect(findNewestCurrentXml(vfs)).toBe('current/save.xml');
    });
});

describe('readNewestParseableXml', () => {
    it('returns the newest save when it parses', () => {
        const vfs = mockVfs(
            { 'current/old.xml': 1000, 'current/new.xml': 2000 },
            { 'current/old.xml': VALID_XML, 'current/new.xml': VALID_XML },
        );
        expect(readNewestParseableXml(vfs)?.path).toBe('current/new.xml');
    });

    it('skips a corrupt newest save and falls back to the newest valid one', () => {
        const vfs = mockVfs(
            { 'current/autosave.xml': 3000, 'current/good.xml': 2000 },
            { 'current/autosave.xml': '<MudletPackage>...broken extra }}', 'current/good.xml': VALID_XML },
        );
        // autosave is newest but malformed → fall back to the good timestamped save
        expect(readNewestParseableXml(vfs)?.path).toBe('current/good.xml');
    });

    it('returns null when nothing parses', () => {
        const vfs = mockVfs({ 'current/a.xml': 1000 }, { 'current/a.xml': 'not xml at all <<<' });
        expect(readNewestParseableXml(vfs)).toBeNull();
    });
});

describe('loadMudletLinkedProfile — package set', () => {
    const CONN = 'linked-packages-conn';
    const xmlWith = (...names: string[]) => '<?xml version="1.0"?><MudletPackage version="1.001"><HostPackage><Host>'
        + `<name>P</name><mInstalledPackages>${names.map(n => `<string>${n}</string>`).join('')}</mInstalledPackages>`
        + '</Host></HostPackage></MudletPackage>';

    it('takes which packages are installed from the XML, and what they are from the sidecar', async () => {
        const { loadMudletLinkedProfile } = await import('../../src/import/mudletLink');
        const { useAppStore } = await import('../../src/storage/appStore');
        const { PROFILE_DATA_PATH } = await import('../../src/storage/profileVfsData');
        const sidecar = {
            packages: [
                { name: 'vpkg', installedAt: 'then', xmlPath: 'vpkg.xml', sourcePath: '/p/vpkg.xml' },
                // Uninstalled in desktop since: the XML no longer lists it.
                { name: 'dropped', installedAt: 'then' },
                // Modules live in <mInstalledModules>, never <mInstalledPackages>.
                { name: 'shared', installedAt: 'then', kind: 'module' },
            ],
        };
        const vfs = mockVfs(
            { 'current/2026-01-01#00-00-00.xml': 1, [PROFILE_DATA_PATH]: 1, 'fresh/config.lua': 1 },
            {
                'current/2026-01-01#00-00-00.xml': xmlWith('vpkg', 'fresh'),
                [PROFILE_DATA_PATH]: JSON.stringify(sidecar),
                'fresh/config.lua': 'mpackage = [[fresh]]\nversion = [[2.0]]',
            },
        );

        expect(loadMudletLinkedProfile(vfs, CONN, 'now')).toBe(true);
        const pkgs = useAppStore.getState().connectionPackages[CONN] ?? [];
        expect(pkgs.map(p => p.name)).toEqual(['vpkg', 'fresh', 'shared']);
        expect(pkgs[0]).toMatchObject({ installedAt: 'then', xmlPath: 'vpkg.xml', sourcePath: '/p/vpkg.xml' });
        expect(pkgs[1]).toMatchObject({ installedAt: 'now', version: '2.0' });
        expect(pkgs[2]).toMatchObject({ kind: 'module' });
    });
});

describe('opensAsLinkedProfile', () => {
    const withSave = () => mockVfs({ 'current/2026-01-01#00-00-00.xml': 1 }, { 'current/2026-01-01#00-00-00.xml': VALID_XML });

    it('loads a linked Mudlet folder from its newest save', () => {
        expect(opensAsLinkedProfile({ mudletLinked: true }, withSave())).toBe(true);
    });

    it('does not for a Mudlet Web profile whose current/ saveProfile() wrote (#259)', () => {
        expect(opensAsLinkedProfile({}, withSave())).toBe(false);
    });

    it('does not for a linked profile with no save to load', () => {
        expect(opensAsLinkedProfile({ mudletLinked: true }, mockVfs({ 'map/m': 1 }))).toBe(false);
    });
});
