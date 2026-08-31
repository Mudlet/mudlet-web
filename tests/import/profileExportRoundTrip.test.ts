import { describe, it, expect } from 'vitest';
import { strToU8, strFromU8 } from 'fflate';
import {
    buildProfileFolder,
    buildProfilesZip,
    buildProfileXml,
    formatSaveStamp,
    sanitizeFolderName,
    CONNECTION_SIDECAR_PATH,
    type ProfileExportSource,
} from '../../src/import/mudletProfileExport';
import {
    extractMudletProfileZipAll,
    findProfileRoots,
    buildMudletProfileBundle,
} from '../../src/import/mudletProfileImport';
import { bundleToConnectionData, bundleToConnectionRecord } from '../../src/import/applyMudletProfile';
import type { PersistedProfileData } from '../../src/storage/profileVfsData';

// Export is only worth anything if import reads it back, so these tests drive
// the real pipeline end to end: profile data -> zip -> bundle -> store slices.

const STAMP = formatSaveStamp(new Date(2026, 6, 29, 20, 14, 3));

function profileData(over: Partial<PersistedProfileData> = {}): PersistedProfileData {
    return {
        version: 2,
        scripts: [{
            id: 's1', name: 'Boot', enabled: true, isGroup: false, parentId: null,
            code: 'echo("hello")', language: 'lua', eventHandlers: ['sysLoadEvent'],
        }],
        aliases: [{
            id: 'a1', name: 'greet', enabled: true, isGroup: false, parentId: null,
            pattern: '^hi$', command: 'say hello', code: '', language: 'lua',
        }],
        triggers: [{
            id: 't1', name: 'HP', enabled: true, isGroup: false, parentId: null,
            patterns: [{ text: 'HP: (\\d+)', type: 'regex' }],
            code: 'echo(matches[2])', language: 'lua', fireLength: 0,
            multipleMatches: false, multiline: false, delta: 0, isFilter: false,
        }],
        timers: [{
            id: 'tm1', name: 'Tick', enabled: true, isGroup: false, parentId: null,
            seconds: 5, code: 'send("look")', language: 'lua', repeat: true,
        }],
        keybindings: [{
            id: 'k1', name: 'F1', enabled: true, isGroup: false, parentId: null,
            key: 'F1', modifiers: [], code: 'send("score")', language: 'lua', command: '',
        }],
        buttons: [],
        packages: [{ name: 'run-lua-code', version: '1.0', installedAt: '2026-01-01T00:00:00.000Z' }],
        variables: {
            saveList: ['myVar'],
            values: [{ name: 'myVar', keyKind: 'string', valueType: 'string', value: 'kept' }],
        },
        profile: { commandSeparator: ';;', outputWrapAt: 120, fontSize: 14 },
        ...over,
    } as PersistedProfileData;
}

function source(over: Partial<ProfileExportSource> = {}): ProfileExportSource {
    return {
        connection: { id: 'c1', name: 'Arkadia', mode: 'mud', host: 'arkadia.rpg.pl', port: 23 },
        data: profileData(),
        files: { 'lua-packages/thing.lua': strToU8('return 1'), '.mudix/profile.json': strToU8('{"stale":true}') },
        ...over,
    };
}

describe('buildProfileFolder', () => {
    it('lays the profile out the way the importer expects', () => {
        const folder = buildProfileFolder(source(), STAMP);
        expect(Object.keys(folder)).toContain(`current/${STAMP}.xml`);
        expect(Object.keys(folder)).toContain('lua-packages/thing.lua');
        expect(Object.keys(folder)).toContain(CONNECTION_SIDECAR_PATH);
    });

    it('drops the internal profile.json — its state is already in the XML', () => {
        const folder = buildProfileFolder(source(), STAMP);
        expect(Object.keys(folder)).not.toContain('.mudix/profile.json');
    });

    it('writes the map under map/ and session logs under logs/', () => {
        const folder = buildProfileFolder(source({
            mapBytes: new Uint8Array([1, 2, 3]),
            logs: [{ name: 'Arkadia 2026-07-29 20-00-00', html: '<html>log</html>' }],
        }), STAMP);
        expect(Object.keys(folder).some(p => p.startsWith('map/'))).toBe(true);
        expect(folder['logs/Arkadia 2026-07-29 20-00-00.html']).toBeTruthy();
    });
});

describe('buildProfileXml', () => {
    it('is a parseable Mudlet save carrying identity and installed packages', () => {
        const xml = buildProfileXml(source().connection, profileData());
        expect(xml).toContain('<MudletPackage version="1.001">');
        expect(xml).toContain('<name>Arkadia</name>');
        expect(xml).toContain('<url>arkadia.rpg.pl</url>');
        expect(xml).toContain('<port>23</port>');
        expect(xml).toContain('<string>run-lua-code</string>');
    });

    it('escapes XML metacharacters in the profile name', () => {
        const xml = buildProfileXml(
            { id: 'x', name: 'Bob & <Alice>', mode: 'mud', host: 'h', port: 1 },
            profileData(),
        );
        expect(xml).toContain('<name>Bob &amp; &lt;Alice&gt;</name>');
        expect(() => buildMudletProfileBundle({ [`current/${STAMP}.xml`]: strToU8(xml) })).not.toThrow();
    });
});

describe('export → import round-trip', () => {
    function roundTrip(sources: ProfileExportSource[]) {
        const zip = buildProfilesZip(sources, new Date(2026, 6, 29, 20, 14, 3));
        return extractMudletProfileZipAll(zip);
    }

    it('preserves automation, variables, settings and packages', () => {
        const [bundle] = roundTrip([source()]);
        expect(bundle.name).toBe('Arkadia');
        const data = bundleToConnectionData(bundle, '2026-07-29T00:00:00.000Z');

        expect(data.scripts.map(s => s.name)).toEqual(['Boot']);
        expect(data.scripts[0].code).toBe('echo("hello")');
        expect(data.scripts[0].eventHandlers).toEqual(['sysLoadEvent']);
        expect(data.aliases[0]).toMatchObject({ pattern: '^hi$', command: 'say hello' });
        expect(data.triggers[0].patterns[0]).toMatchObject({ text: 'HP: (\\d+)', type: 'regex' });
        expect(data.timers[0]).toMatchObject({ seconds: 5, repeat: true });
        expect(data.keybindings[0]).toMatchObject({ key: 'F1' });
        expect(data.profile).toMatchObject({ commandSeparator: ';;', outputWrapAt: 120 });
        expect(data.variables.values.map(v => v.name)).toEqual(['myVar']);
        expect(data.variables.values[0].value).toBe('kept');
        expect(data.packages.map(p => p.name)).toEqual(['run-lua-code']);
    });

    it('carries loose VFS files and the map across', () => {
        const [bundle] = roundTrip([source({ mapBytes: new Uint8Array([9, 8, 7]) })]);
        expect(strFromU8(bundle.files['lua-packages/thing.lua'])).toBe('return 1');
        expect(Array.from(bundle.mapBytes!)).toEqual([9, 8, 7]);
    });

    it('restores a telnet connection as host/port', () => {
        const [bundle] = roundTrip([source()]);
        expect(bundleToConnectionRecord(bundle)).toMatchObject({
            name: 'Arkadia', mode: 'mud', host: 'arkadia.rpg.pl', port: 23,
        });
    });

    it('restores websocket mode, which a Mudlet <Host> cannot express', () => {
        const [bundle] = roundTrip([source({
            connection: {
                id: 'c2', name: 'Last Outpost', mode: 'websocket',
                url: 'wss://last-outpost.com/ws/telnet/', autoReconnect: true,
            },
        })]);
        const record = bundleToConnectionRecord(bundle);
        expect(record).toMatchObject({
            name: 'Last Outpost', mode: 'websocket',
            url: 'wss://last-outpost.com/ws/telnet/', autoReconnect: true,
        });
        // A ws URL parked in <Host><url> must not resurface as a telnet hostname.
        expect(record.host).toBeUndefined();
    });

    it('keeps a per-profile proxy override', () => {
        const [bundle] = roundTrip([source({
            connection: { id: 'c3', name: 'Proxied', mode: 'mud', host: 'h', port: 4000, proxyUrl: 'wss://proxy.example/ws' },
        })]);
        expect(bundleToConnectionRecord(bundle).proxyUrl).toBe('wss://proxy.example/ws');
    });

    it('falls back to Mudlet defaults when the sidecar is absent or corrupt', () => {
        const zip = buildProfilesZip([source()], new Date(2026, 6, 29, 20, 14, 3));
        const [bundle] = extractMudletProfileZipAll(zip);
        bundle.files[CONNECTION_SIDECAR_PATH] = strToU8('{not json');
        expect(bundleToConnectionRecord(bundle)).toMatchObject({ mode: 'mud', host: 'arkadia.rpg.pl' });
    });

    it('round-trips several profiles in one archive', () => {
        const bundles = roundTrip([
            source(),
            source({ connection: { id: 'c2', name: 'MS2', mode: 'mud', host: 'midnightsun2.org', port: 3000 } }),
            source({ connection: { id: 'c3', name: 'Aardmud', mode: 'mud', host: 'aardmud.org', port: 23 } }),
        ]);
        expect(bundles.map(b => b.name).sort()).toEqual(['Aardmud', 'Arkadia', 'MS2']);
        for (const b of bundles) expect(b.profile.automation.scripts.length).toBe(1);
    });

    it('disambiguates profiles that share a name instead of merging them', () => {
        const bundles = roundTrip([
            source(),
            source({ connection: { id: 'c2', name: 'Arkadia', mode: 'mud', host: 'other.host', port: 23 } }),
        ]);
        expect(bundles).toHaveLength(2);
        expect(bundles.map(b => b.host).sort()).toEqual(['arkadia.rpg.pl', 'other.host']);
    });
});

describe('findProfileRoots', () => {
    it('finds one root per profile folder', () => {
        expect(findProfileRoots({
            'Arkadia/current/save.xml': strToU8('<x/>'),
            'MS2/current/save.xml': strToU8('<x/>'),
            'MS2/map/map.dat': strToU8('m'),
        })).toEqual(['Arkadia/', 'MS2/']);
    });

    it('treats a bare profile (files at the root) as the only root', () => {
        expect(findProfileRoots({
            'current/save.xml': strToU8('<x/>'),
            'nested/current/save.xml': strToU8('<x/>'),
        })).toEqual(['']);
    });

    it('ignores a nested profile deeper than the outer one, as before', () => {
        expect(findProfileRoots({
            'Arkadia/current/save.xml': strToU8('<x/>'),
            'Arkadia/modules/Other/current/save.xml': strToU8('<x/>'),
        })).toEqual(['Arkadia/']);
    });

    it('returns nothing for a tree with no profile in it', () => {
        expect(findProfileRoots({ 'readme.txt': strToU8('hi') })).toEqual([]);
    });
});

describe('sanitizeFolderName', () => {
    it('replaces characters that would break a zip entry or filesystem', () => {
        expect(sanitizeFolderName('Arkadia: main/test', 'fallback')).toBe('Arkadia_ main_test');
    });

    it('falls back only when nothing usable is left', () => {
        expect(sanitizeFolderName('   ', 'profile-1')).toBe('profile-1');
        expect(sanitizeFolderName('...', 'profile-1')).toBe('profile-1');
        // Separators become underscores rather than vanishing, so a name made
        // only of them still yields a usable folder.
        expect(sanitizeFolderName('///', 'profile-1')).toBe('___');
    });
});
