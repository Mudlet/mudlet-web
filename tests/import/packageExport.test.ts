// Default happy-dom environment: the round-trip parses XML back with DOMParser.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
    buildConfigLua,
    buildPackageEntries,
    buildPackageZip,
    countSelected,
    descendantIds,
    sanitizePackageName,
    selectExportInput,
    selectExportNodes,
} from '../../src/import/packageExport';
import { installPackageFromBytes } from '../../src/import/packageInstaller';
import type { SerializeInput } from '../../src/import/mudletXmlExport';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import type { ScriptNode, TriggerNode } from '../../src/storage/schema';

const EMPTY: SerializeInput = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] };

function script(p: Partial<ScriptNode>): ScriptNode {
    return {
        id: 's', name: 'S', enabled: true, isGroup: false, parentId: null,
        code: 'echo("hi")', language: 'lua', eventHandlers: [], ...p,
    };
}

function trigger(p: Partial<TriggerNode>): TriggerNode {
    return {
        id: 't', name: 'T', enabled: true, isGroup: false, parentId: null,
        patterns: [{ text: 'HP: (\\d+)', type: 'regex' }],
        code: 'echo("x")', language: 'lua', fireLength: 0, multipleMatches: false,
        multiline: false, delta: 0, isFilter: false, ...p,
    };
}

/** Minimal in-memory stand-in for the ProfileVFS methods the installer touches. */
function stubVfs(): ProfileVFS {
    const files = new Map<string, string | Uint8Array>();
    const dirs = new Set<string>();
    return {
        profilePath: '/profiles/test',
        exists: (p: string) => dirs.has(p) || files.has(p),
        mkdir: (p: string) => { dirs.add(p.replace(/\/$/, '')); },
        rmdir: (p: string) => { dirs.delete(p); },
        writeFile: (p: string, data: string) => { files.set(p, data); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, data); },
        readFile: (p: string) => String(files.get(p) ?? ''),
        readBinaryFile: (p: string) => files.get(p) as Uint8Array,
    } as unknown as ProfileVFS;
}

const META = { name: 'mypkg', created: '2026-07-31T10:00:00.000Z' };

describe('buildConfigLua', () => {
    it('writes Mudlet\'s keys, in Mudlet\'s order, even when empty', () => {
        const cfg = buildConfigLua({ ...META, author: 'Me', title: 'My Package', version: '1.2' });
        expect(cfg).toContain('mpackage = [[mypkg]]');
        expect(cfg).toContain('author = [[Me]]');
        expect(cfg).toContain('title = [[My Package]]');
        expect(cfg).toContain('version = [[1.2]]');
        // Keys with no value are still emitted, as dlgPackageExporter does.
        expect(cfg).toContain('description = [[]]');
        expect(cfg).toContain('dependencies = [[]]');
        expect(cfg).toContain('created = "2026-07-31T10:00:00.000Z"');
        const order = ['mpackage', 'author', 'icon', 'title', 'description', 'version', 'helpURL', 'dependencies', 'created'];
        const positions = order.map(k => cfg.indexOf(`${k} = `));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('escapes a value containing ]] by raising the long-bracket level', () => {
        // Mudlet writes plain [[…]] and corrupts the file here; ours has to survive
        // the reader, because the description is the field most likely to hold Lua.
        const cfg = buildConfigLua({ ...META, description: 'see t[[1]] for details' });
        expect(cfg).toContain('description = [=[see t[[1]] for details]=]');
        const manifest = installFromZip({ meta: { ...META, description: 'see t[[1]] for details' }, nodes: EMPTY });
        expect(manifest.description).toBe('see t[[1]] for details');
    });

    it('keeps a leading newline the Lua long-bracket rule would swallow', () => {
        const cfg = buildConfigLua({ ...META, description: '\nline one' });
        expect(cfg).toContain('description = [[\n\nline one]]');
        const manifest = installFromZip({ meta: { ...META, description: '\nline one' }, nodes: EMPTY });
        expect(manifest.description).toBe('\nline one');
    });

    it('joins dependencies with commas', () => {
        expect(buildConfigLua({ ...META, dependencies: ['a', 'b'] })).toContain('dependencies = [[a,b]]');
    });
});

/** Build a package and push it straight back through the installer. */
function installFromZip(input: Parameters<typeof buildPackageZip>[0]) {
    const zipped = buildPackageZip(input);
    const { manifest } = installPackageFromBytes('mypkg.mpackage', zipped, stubVfs());
    return manifest;
}

describe('selection', () => {
    const nodes: ScriptNode[] = [
        script({ id: 'g', name: 'Group', isGroup: true }),
        script({ id: 'a', name: 'A', parentId: 'g' }),
        script({ id: 'b', name: 'B', parentId: 'g' }),
        script({ id: 'nested', name: 'Nested', isGroup: true, parentId: 'g' }),
        script({ id: 'c', name: 'C', parentId: 'nested' }),
        script({ id: 'outside', name: 'Outside' }),
    ];

    it('descendantIds walks the whole subtree', () => {
        expect(descendantIds(nodes, 'g').sort()).toEqual(['a', 'b', 'c', 'nested']);
        expect(descendantIds(nodes, 'a')).toEqual([]);
    });

    it('keeps only the selected nodes and preserves their hierarchy', () => {
        const picked = selectExportNodes(nodes, new Set(['g', 'a', 'b', 'nested', 'c']));
        expect(picked.map(n => n.id)).toEqual(['g', 'a', 'b', 'nested', 'c']);
        expect(picked.find(n => n.id === 'a')!.parentId).toBe('g');
        expect(picked.find(n => n.id === 'c')!.parentId).toBe('nested');
    });

    it('re-roots a selected child whose parent was left out', () => {
        // Mudlet drops this item entirely (its exporter only walks down from
        // checked roots). Re-rooting keeps what the user actually checked.
        const picked = selectExportNodes(nodes, new Set(['c']));
        expect(picked.map(n => n.id)).toEqual(['c']);
        expect(picked[0].parentId).toBeNull();
    });

    it('counts across all six categories', () => {
        const input = selectExportInput(
            { ...EMPTY, scripts: nodes, triggers: [trigger({ id: 't1' })] },
            { scripts: new Set(['a', 'b']), aliases: new Set(), triggers: new Set(['t1']), timers: new Set(), keys: new Set(), buttons: new Set() },
        );
        expect(countSelected(input)).toBe(3);
    });
});

describe('buildPackageEntries', () => {
    it('lays the archive out the way the installer reads it', () => {
        const entries = buildPackageEntries({
            meta: { ...META, icon: 'logo.png' },
            nodes: { ...EMPTY, scripts: [script({})] },
            assets: { 'sounds/beep.wav': new Uint8Array([1, 2, 3]) },
            iconBytes: new Uint8Array([9]),
        });
        expect(Object.keys(entries).sort()).toEqual([
            '.mudlet/Icon/logo.png', 'config.lua', 'mypkg.xml', 'sounds/beep.wav',
        ]);
    });

    it('never lets a stale config.lua or XML from the package folder through', () => {
        // Re-exporting an installed package harvests its directory, which still
        // holds the previous pair — shipping those would ship stale metadata.
        const entries = buildPackageEntries({
            meta: META,
            nodes: EMPTY,
            assets: { 'config.lua': new Uint8Array([0]), 'mypkg.xml': new Uint8Array([0]) },
        });
        expect(strFromU8(entries['config.lua'])).toContain('mpackage = [[mypkg]]');
        expect(strFromU8(entries['mypkg.xml'])).toContain('<MudletPackage');
    });

    it('drops path traversal out of asset paths', () => {
        const entries = buildPackageEntries({
            meta: META, nodes: EMPTY, assets: { '../../etc/passwd': new Uint8Array([0]), '/abs/x.png': new Uint8Array([0]) },
        });
        expect(Object.keys(entries).sort()).toEqual(['abs/x.png', 'config.lua', 'etc/passwd', 'mypkg.xml']);
    });

    it('sanitizes a name that would produce an unextractable archive', () => {
        expect(sanitizePackageName('my/pkg: v2')).toBe('my_pkg_ v2');
        const entries = buildPackageEntries({ meta: { ...META, name: 'my/pkg' }, nodes: EMPTY });
        expect(entries['my_pkg.xml']).toBeDefined();
        expect(strFromU8(entries['config.lua'])).toContain('mpackage = [[my_pkg]]');
    });
});

describe('export → install round trip', () => {
    it('reinstalls with its metadata and items intact', () => {
        const zipped = buildPackageZip({
            meta: { ...META, author: 'Me', title: 'My Package', version: '2.0', description: 'Does things', icon: 'logo.png' },
            nodes: {
                ...EMPTY,
                scripts: [script({ id: 's1', name: 'Boot', eventHandlers: ['sysLoadEvent'] })],
                triggers: [trigger({ id: 't1', name: 'HP', multiline: true })],
            },
            iconBytes: new Uint8Array([137, 80, 78, 71]),
        });

        const { manifest, data } = installPackageFromBytes('mypkg.mpackage', zipped, stubVfs());
        expect(manifest).toMatchObject({
            name: 'mypkg', author: 'Me', title: 'My Package', version: '2.0',
            description: 'Does things', icon: 'logo.png', created: META.created,
        });
        // The importer wraps each category in a group named after the package.
        expect(data.scripts.find(s => s.name === 'Boot')).toMatchObject({ eventHandlers: ['sysLoadEvent'] });
        expect(data.triggers.find(t => t.name === 'HP')).toMatchObject({ multiline: true });
        expect(data.warnings).toEqual([]);

        const entries = unzipSync(zipped);
        expect(entries['.mudlet/Icon/logo.png']).toBeDefined();
    });

    it('does not nest the package one level deeper on every re-export', () => {
        // Install once, then export exactly what came back — the wrapper group our
        // importer adds has to be stripped, or each round adds a folder level.
        const first = buildPackageZip({ meta: META, nodes: { ...EMPTY, scripts: [script({ id: 's1', name: 'Boot' })] } });
        const installed = installPackageFromBytes('mypkg.mpackage', first, stubVfs()).data;
        expect(installed.scripts.filter(s => s.isGroup).map(s => s.name)).toEqual(['mypkg']);

        const second = buildPackageZip({ meta: META, nodes: { ...EMPTY, scripts: installed.scripts } });
        const reinstalled = installPackageFromBytes('mypkg.mpackage', second, stubVfs()).data;
        expect(reinstalled.scripts.filter(s => s.isGroup).map(s => s.name)).toEqual(['mypkg']);
        expect(reinstalled.scripts.find(s => s.name === 'Boot')).toBeDefined();
    });
});
