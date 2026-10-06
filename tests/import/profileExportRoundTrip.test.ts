import { describe, it, expect } from 'vitest';
import { strToU8, strFromU8, unzipSync } from 'fflate';
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
    resolveModulesFromTree,
} from '../../src/import/mudletProfileImport';
import { bundleToConnectionData, bundleToConnectionRecord, decodeProfileDataItem } from '../../src/import/applyMudletProfile';
import { parseInstalledModules, parseInstalledPackages } from '../../src/import/mudletHost';
import { serializeMudletXml } from '../../src/import/mudletXmlExport';
import type { PersistedProfileData } from '../../src/storage/profileVfsData';

// Export is only worth anything if import reads it back, so these tests drive
// the real pipeline end to end: profile data -> zip -> bundle -> store slices.

const STAMP = formatSaveStamp(new Date(2026, 6, 29, 20, 14, 3));

/** An entry's DOS date and time from the zip's central directory, comparable as one number. */
function dosTime(zip: Uint8Array, name: string): number {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let at = 0; at + 46 <= zip.length; at++) {
        if (view.getUint32(at, true) !== 0x02014b50) continue;
        const length = view.getUint16(at + 28, true);
        if (strFromU8(zip.subarray(at + 46, at + 46 + length)) === name) {
            return view.getUint16(at + 14, true) * 0x10000 + view.getUint16(at + 12, true);
        }
    }
    throw new Error(`${name} is not in the archive`);
}

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

    // Two options that sound like one. Mudlet's `<Host>` expresses neither, so
    // both ride in the sidecar, and an export that dropped one would silently
    // change how the profile behaves on the machine it lands on.
    it('keeps both connection flags apart', () => {
        const [bundle] = roundTrip([source({
            connection: {
                id: 'c9', name: 'Arkadia', mode: 'mud', host: 'arkadia.rpg.pl', port: 23,
                autoReconnect: true, reconnectOnDrop: true,
            },
        })]);
        expect(bundleToConnectionRecord(bundle)).toMatchObject({
            autoReconnect: true, reconnectOnDrop: true,
        });

        const [off] = roundTrip([source({
            connection: {
                id: 'c10', name: 'Arkadia', mode: 'mud', host: 'arkadia.rpg.pl', port: 23,
                reconnectOnDrop: true,
            },
        })]);
        const record = bundleToConnectionRecord(off);
        expect(record.reconnectOnDrop).toBe(true);
        expect(record.autoReconnect).toBeUndefined();
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

describe('for desktop Mudlet', () => {
    const host = (folder: Record<string, Uint8Array>) =>
        new DOMParser().parseFromString(strFromU8(folder[`current/${STAMP}.xml`]), 'text/xml').getElementsByTagName('Host')[0];
    const item = (folder: Record<string, Uint8Array>, name: string) => decodeProfileDataItem(folder[name]);

    it('writes the connection files desktop\'s Connect dialog reads', () => {
        const folder = buildProfileFolder(source({
            connection: {
                id: 'c1', name: 'Arkadia', mode: 'mud', host: 'arkadia.rpg.pl', port: 7000, tls: true,
                charLoginAccount: 'Zoë', description: 'main', autoReconnect: true,
            },
            files: { login: strToU8('stale'), autoreconnect: strToU8('2') },
        }), STAMP);
        expect(item(folder, 'url')).toBe('arkadia.rpg.pl');
        expect(item(folder, 'port')).toBe('7000');
        expect(item(folder, 'login')).toBe('Zoë');
        expect(item(folder, 'description')).toBe('main');
        expect(item(folder, 'autologin')).toBe('2');
        expect(item(folder, 'autoreconnect')).toBe('0');
        expect(item(folder, 'ssl_tsl')).toBe('2');
        // QDataStream's QString: byte count, then UTF-16BE
        expect(Array.from(folder.port)).toEqual([0, 0, 0, 8, 0, 0x37, 0, 0x30, 0, 0x30, 0, 0x30]);
        expect(host(folder).getAttribute('mSslTsl')).toBe('yes');
    });

    it('leaves a websocket profile without an address desktop would misdial', () => {
        const folder = buildProfileFolder(source({
            connection: { id: 'c2', name: 'Web', mode: 'websocket', url: 'wss://example.org/ws' },
        }), STAMP);
        expect(item(folder, 'url')).toBe('');
        expect(item(folder, 'port')).toBe('');
    });

    const TRIGGER = {
        id: 'mt1', name: 'Combat hit', enabled: true, isGroup: false, parentId: null, packageName: 'Combat',
        patterns: [{ text: 'You hit', type: 'substring' }], code: 'x()', language: 'lua', fireLength: 0,
        multipleMatches: false, multiline: false, delta: 0, isFilter: false,
    };

    function withModules(packages: object[], files: Record<string, Uint8Array>) {
        const data = profileData();
        return source({
            profilePath: '/profiles/c1',
            data: { ...data, triggers: [...data.triggers, TRIGGER], packages: [...data.packages, ...packages] } as PersistedProfileData,
            files,
        });
    }

    it('lists modules as modules, with paths inside the folder, and keeps their items in their own files', () => {
        const moduleXml = strToU8(serializeMudletXml({ scripts: [], aliases: [], timers: [], keys: [], buttons: [], triggers: [TRIGGER] } as never, 'Combat'));
        const src = withModules([
            { name: 'Combat', kind: 'module', xmlPath: 'Combat.xml', sync: true, priority: -1, installedAt: '' },
            { name: 'Gui', kind: 'module', sourcePath: '/profiles/c1/downloads/Gui.mpackage', xmlPath: 'Gui.xml', installedAt: '' },
            { name: 'Builtin', kind: 'module', xmlVfsPath: '/lua/builtin.xml', installedAt: '' },
            // desktop would call a module in this file "my-mapper"
            { name: 'Mapper', kind: 'module', xmlVfsPath: '/profiles/c1/scripts/my-mapper.xml', installedAt: '' },
        ], {
            'Combat/Combat.xml': moduleXml,
            'downloads/Gui.mpackage': new Uint8Array([0x50, 0x4b, 3, 4]),
            'scripts/my-mapper.xml': strToU8('<MudletPackage/>'),
        });
        const folder = buildProfileFolder(src, STAMP);
        const h = host(folder);

        // desktop deletes <module>/ when a module is removed, so none is listed from there
        expect(parseInstalledModules(h)).toEqual([
            { key: 'Builtin', filepath: 'modules/Builtin.xml', globalSave: false, priority: 0 },
            { key: 'Combat', filepath: 'modules/Combat.xml', globalSave: true, priority: -1 },
            { key: 'Gui', filepath: 'downloads/Gui.mpackage', globalSave: false, priority: 0 },
            { key: 'Mapper', filepath: 'modules/Mapper.xml', globalSave: false, priority: 0 },
        ]);
        expect(folder['modules/Mapper.xml']).toBe(src.files['scripts/my-mapper.xml']);
        expect(h.innerHTML).toContain('<filepath>downloads/Gui.mpackage</filepath><zipSync>0</zipSync><globalSave>0</globalSave>');
        expect(parseInstalledPackages(h)).toEqual(['run-lua-code']);
        expect(strFromU8(folder[`current/${STAMP}.xml`])).not.toContain('Combat hit');
        expect(folder['modules/Combat.xml']).toBe(moduleXml);
        expect(strFromU8(folder['modules/Builtin.xml'])).toContain('MudletPackage');
    });

    it('lists a synced archive module by the XML it syncs to, and keeps an archive out of the folder removal deletes', () => {
        const archive = new Uint8Array([0x50, 0x4b, 3, 4]);
        const synced = strToU8('<MudletPackage>edited</MudletPackage>');
        const folder = buildProfileFolder(withModules([
            { name: 'Gui', kind: 'module', sourcePath: '/profiles/c1/Gui/Gui.mpackage', xmlPath: 'Gui.xml', installedAt: '' },
            { name: 'Combat', kind: 'module', sourcePath: '/profiles/c1/downloads/Combat.mpackage', xmlPath: 'Combat.xml', sync: true, installedAt: '' },
        ], {
            'Gui/Gui.mpackage': archive,
            'Gui/Gui.xml': strToU8('<MudletPackage/>'),
            'downloads/Combat.mpackage': archive,
            'Combat/Combat.xml': synced,
        }), STAMP);

        expect(parseInstalledModules(host(folder))).toEqual([
            { key: 'Combat', filepath: 'modules/Combat.xml', globalSave: true, priority: 0 },
            { key: 'Gui', filepath: 'modules/Gui.mpackage', globalSave: false, priority: 0 },
        ]);
        expect(folder['modules/Combat.xml']).toBe(synced);
        expect(folder['modules/Gui.mpackage']).toBe(archive);
    });

    it('keeps a websocket address out of <Host>, where desktop would take it for a hostname', () => {
        const folder = buildProfileFolder(source({
            connection: { id: 'c2', name: 'Web', mode: 'websocket', url: 'wss://example.org/ws' },
        }), STAMP);
        expect(host(folder).getElementsByTagName('url')[0]?.textContent ?? '').toBe('');
    });

    it('dates the new save and map after everything else, for desktop to load them when unzipped by hand', () => {
        const now = new Date(2026, 6, 29, 20, 14, 4);
        const zip = buildProfilesZip([source({
            mapBytes: new Uint8Array([1]),
            files: { 'current/2099-01-01#00-00-00.xml': strToU8('<old/>') },
        })], now);
        const times = new Map<string, number>();
        unzipSync(zip, {
            filter: f => {
                times.set(f.name, dosTime(zip, f.name));
                return false;
            },
        });
        const stamp = formatSaveStamp(now);
        const save = [...times.keys()].find(n => n.endsWith(`current/${stamp}.xml`))!;
        const map = [...times.keys()].find(n => n.endsWith(`map/${stamp}map.dat`))!;
        const old = [...times.keys()].find(n => n.endsWith('current/2099-01-01#00-00-00.xml'))!;
        expect(times.get(save)).toBe(times.get(map));
        expect(times.get(save)!).toBeGreaterThan(times.get(old)!);
    });

    it('finds each module again on the way back into Mudlet Web', () => {
        const moduleXml = strToU8(serializeMudletXml({ scripts: [], aliases: [], timers: [], keys: [], buttons: [], triggers: [TRIGGER] } as never, 'Combat'));
        const zip = buildProfilesZip([withModules(
            [{ name: 'Combat', kind: 'module', xmlVfsPath: '/profiles/c1/scripts/Combat.xml', installedAt: '' }],
            { 'scripts/Combat.xml': moduleXml },
        )], new Date(2026, 6, 29, 20, 14, 3));
        const [bundle] = extractMudletProfileZipAll(zip);
        expect(bundle.packages.map(p => p.name)).toEqual(['run-lua-code']);
        const { resolved, unresolved } = resolveModulesFromTree(bundle);
        expect(unresolved).toEqual([]);
        expect(resolved.map(r => r.path)).toEqual(['scripts/Combat.xml']);
        expect(strFromU8(resolved[0].xmlBytes)).toContain('Combat hit');
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
