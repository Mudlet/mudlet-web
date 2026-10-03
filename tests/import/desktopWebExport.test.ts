import { describe, it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
    addModuleToBundle,
    buildMudletProfileBundle,
    extractMudletProfileZipAll,
    resolveModulesFromTree,
    type MudletProfileBundle,
} from '../../src/import/mudletProfileImport';
import { parseMudletProfile } from '../../src/import/mudletHost';
import { bundleToConnectionData, bundleToConnectionRecord, decodeProfileDataItem } from '../../src/import/applyMudletProfile';
import { buildConnectionSidecar, CONNECTION_SIDECAR_PATH } from '../../src/import/mudletProfileExport';
import type { MudConnection } from '../../src/storage/schema';

// Desktop Mudlet's Toolbox → "Export to Mudlet Web" (MudletWebExport.cpp in
// Mudlet/Mudlet) writes the profile folder as desktop keeps it, plus each
// module's file at `<module>/<its file name>`, since modules live outside the
// profile on desktop. These tests hold the archive to that shape, and the XML
// to what desktop's XMLexport really writes.

const moduleXml = (alias: string) => `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <AliasPackage>
    <Alias isActive="yes" isFolder="no"><name>${alias}</name><command></command><regex>^${alias}$</regex><script></script></Alias>
  </AliasPackage>
</MudletPackage>`;

// Every module in one <mInstalledModules>, an archive's sync flag in <zipSync>
// with <globalSave> pinned to 0 — XMLexport::writeHost, verbatim in shape.
const desktopSave = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE MudletPackage>
<MudletPackage version="1.001">
  <HostPackage>
    <Host mSslTsl="yes" mSslIgnoreExpired="no" mSslIgnoreSelfSigned="yes" mSslIgnoreAll="no">
      <name>Achaea</name>
      <mInstalledPackages><string>somepkg</string></mInstalledPackages>
      <mInstalledModules>
        <key>ui</key><filepath>C:/Users/me/Documents/ui.xml</filepath><globalSave>1</globalSave><priority>2</priority>
        <key>mapper</key><filepath>/home/me/mapper.mpackage</filepath><zipSync>1</zipSync><globalSave>0</globalSave><priority>-1</priority>
        <key>dup</key><filepath>/home/me/dup/init.xml</filepath><globalSave>0</globalSave><priority>0</priority>
      </mInstalledModules>
      <url>achaea.com</url>
      <port>23</port>
    </Host>
  </HostPackage>
</MudletPackage>`;

/** A QString as `QDataStream << QString` writes it: a big-endian byte count,
 *  then UTF-16BE — the format of every file `MudletApp::writeProfileData` makes. */
function qstring(text: string | null): Uint8Array {
    if (text === null) return new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const out = new Uint8Array(4 + text.length * 2);
    new DataView(out.buffer).setUint32(0, text.length * 2);
    for (let i = 0; i < text.length; i++) new DataView(out.buffer).setUint16(4 + i * 2, text.charCodeAt(i));
    return out;
}

const mapperArchive = () => zipSync({
    'mapper.xml': strToU8(moduleXml('mapper')),
    'images/arrow.png': new Uint8Array([7]),
});

function desktopExport(): Record<string, Uint8Array> {
    return {
        'Achaea/current/2026-10-03#12-00-00.xml': strToU8(desktopSave),
        'Achaea/map/2026-10-03#12-00-00map.dat': new Uint8Array([1, 2, 3]),
        // copied in from outside the profile by the export
        'Achaea/ui/ui.xml': strToU8(moduleXml('ui')),
        'Achaea/dup/init.xml': strToU8(moduleXml('dup')),
        'Achaea/mapper/mapper.mpackage': mapperArchive(),
        // desktop's own unpacked copy of the archived module, and a file the
        // module wrote for itself
        'Achaea/mapper/mapper.xml': strToU8(moduleXml('mapper')),
        'Achaea/mapper/images/arrow.png': new Uint8Array([7]),
        'Achaea/mapper/settings.lua': strToU8('-- mine'),
        // a package that happens to share the dup module's file name
        'Achaea/somepkg/init.xml': strToU8(moduleXml('package')),
        // the connection dialog's files, as MudletApp::writeProfileData leaves them
        'Achaea/login': qstring('Héro'),
        'Achaea/description': qstring('My main'),
        'Achaea/autologin': qstring('2'),
        'Achaea/autoreconnect': qstring('0'),
    };
}

function importLikeTheConnectionScreen(bundle: MudletProfileBundle) {
    const { resolved, unresolved } = resolveModulesFromTree(bundle);
    for (const r of resolved) addModuleToBundle(bundle, r.ref, r.xmlBytes, r.path);
    return unresolved;
}

const saveWith = (modules: string) => desktopSave.replace(/<mInstalledModules>[\s\S]*<\/mInstalledModules>/, `<mInstalledModules>${modules}</mInstalledModules>`);

describe('parseInstalledModules', () => {
    it('reads every module from desktop\'s single <mInstalledModules>', () => {
        const modules = parseMudletProfile(desktopSave).modules;
        expect(modules.map(m => m.key)).toEqual(['ui', 'mapper', 'dup']);
        expect(modules[0]).toMatchObject({ filepath: 'C:/Users/me/Documents/ui.xml', globalSave: true, priority: 2 });
        // the archive's sync comes from <zipSync>, not the 0 in <globalSave>
        expect(modules[1]).toMatchObject({ globalSave: true, priority: -1 });
        expect(modules[2]).toMatchObject({ globalSave: false, priority: 0 });
    });
});

describe('a desktop "Export to Mudlet Web" archive', () => {
    it('imports with every module resolved, none asked for', () => {
        const [bundle] = extractMudletProfileZipAll(zipSync(desktopExport()));
        expect(importLikeTheConnectionScreen(bundle)).toEqual([]);
        expect(bundle.warnings).toEqual([]);

        const modules = bundle.packages.filter(p => p.kind === 'module');
        expect(modules.map(m => [m.name, m.sync, m.priority])).toEqual([['ui', true, 2], ['mapper', true, -1], ['dup', false, 0]]);
        expect(modules[0]).toMatchObject({ xmlVfsPath: 'ui/ui.xml' });
        expect(modules[2]).toMatchObject({ xmlVfsPath: 'dup/init.xml' });
        const aliases = bundle.profile.automation.aliases.map(a => [a.name, a.packageName]);
        expect(aliases).toEqual(expect.arrayContaining([['ui', 'ui'], ['mapper', 'mapper'], ['dup', 'dup']]));
        expect(aliases.some(([name]) => name === 'package')).toBe(false);
        expect(bundle.files['mapper/settings.lua']).toEqual(strToU8('-- mine'));
    });

    // Laid out as an archive module installed in Mudlet Web is, so uninstalling
    // it takes its folder and getModulePath answers with the archive
    it('installs an archived module from its archive', () => {
        const [bundle] = extractMudletProfileZipAll(zipSync(desktopExport()));
        importLikeTheConnectionScreen(bundle);
        expect(bundle.packages.find(p => p.name === 'mapper')).toEqual({
            name: 'mapper', installedAt: '', kind: 'module', sync: true, priority: -1,
            xmlPath: 'mapper.xml', sourceFile: 'mapper.mpackage',
        });
        expect(bundle.files['mapper/images/arrow.png']).toEqual(new Uint8Array([7]));
    });

    it('reloads an unsynced archived module from its archive, as desktop does', () => {
        const files = desktopExport();
        files['Achaea/current/2026-10-03#12-00-00.xml'] = strToU8(desktopSave.replace('<zipSync>1</zipSync>', '<zipSync>0</zipSync>'));
        const [bundle] = extractMudletProfileZipAll(zipSync(files));
        importLikeTheConnectionScreen(bundle);
        expect(bundle.packages.find(p => p.name === 'mapper')?.sourcePath).toBe('mapper/mapper.mpackage');
        const data = bundleToConnectionData(bundle, '2026-10-03T12:00:00Z', '/profiles/new');
        expect(data.packages.find(p => p.name === 'mapper')?.sourcePath).toBe('/profiles/new/mapper/mapper.mpackage');
    });

    it('falls back to desktop\'s unpacked copy without the archive', () => {
        const files = desktopExport();
        delete files['Achaea/mapper/mapper.mpackage'];
        const [bundle] = extractMudletProfileZipAll(zipSync(files));
        expect(importLikeTheConnectionScreen(bundle)).toEqual([]);
        expect(bundle.packages.find(p => p.name === 'mapper')).toMatchObject({ kind: 'module', xmlPath: 'mapper.xml', sourceFile: 'mapper.mpackage' });
        expect(bundle.packages.find(p => p.name === 'mapper')?.xmlVfsPath).toBeUndefined();
    });

    it('anchors each module\'s file in the new profile', () => {
        const [bundle] = extractMudletProfileZipAll(zipSync(desktopExport()));
        importLikeTheConnectionScreen(bundle);
        const data = bundleToConnectionData(bundle, '2026-10-03T12:00:00Z', '/profiles/new');
        expect(data.packages.find(p => p.name === 'dup')?.xmlVfsPath).toBe('/profiles/new/dup/init.xml');
    });

    it('never binds a module to a file in another package\'s folder', () => {
        const files = desktopExport();
        delete files['Achaea/dup/init.xml'];
        const [bundle] = extractMudletProfileZipAll(zipSync(files));
        expect(importLikeTheConnectionScreen(bundle).map(m => m.key)).toEqual(['dup']);
    });

    it('carries the connection dialog over, but not as a password', () => {
        const [bundle] = extractMudletProfileZipAll(zipSync(desktopExport()));
        const record = bundleToConnectionRecord(bundle);
        expect(record).toMatchObject({
            name: 'Achaea', mode: 'mud', host: 'achaea.com', port: 23,
            tls: true, sslIgnoreSelfSigned: true,
            charLoginAccount: 'Héro', description: 'My main', autoReconnect: true,
        });
        expect(record.sslIgnoreExpired).toBeUndefined();
        expect(record.sslIgnoreAll).toBeUndefined();
        expect(record.reconnectOnDrop).toBeUndefined();
        expect(record.charLoginPassword).toBeUndefined();
    });

    it('falls back to the ssl_tsl file when the save predates the attribute', () => {
        const files = desktopExport();
        files['Achaea/current/2026-10-03#12-00-00.xml'] = strToU8(desktopSave.replace(/ mSsl\w+="\w+"/g, ''));
        files['Achaea/ssl_tsl'] = qstring('2');
        expect(bundleToConnectionRecord(buildMudletProfileBundle(files)).tls).toBe(true);
        files['Achaea/ssl_tsl'] = qstring('0');
        expect(bundleToConnectionRecord(buildMudletProfileBundle(files)).tls).toBeUndefined();
    });

    // A folder picked or zipped by hand has them; desktop's export does not
    it('never copies a credential into the profile', () => {
        const files = {
            ...desktopExport(),
            'Achaea/password': strToU8('hunter2'),
            'Achaea/encryption_key': new Uint8Array(32),
            'Achaea/passwords/character_password.dat': new Uint8Array([1]),
            'Achaea/reconnect': qstring('{"account":"me"}'),
        };
        const keys = Object.keys(buildMudletProfileBundle(files).files);
        expect(keys.filter(k => /^(password|encryption_key|reconnect)$|^passwords\//.test(k))).toEqual([]);
    });
});

// Once a desktop profile is in Mudlet Web, its retained <Host> and login file
// travel with every Mudlet Web export; the sidecar has to outrank them
describe('the connection sidecar', () => {
    it('keeps a setting the user cleared after importing from desktop', () => {
        const cleared: MudConnection = { id: 'x', name: 'Achaea', mode: 'mud', host: 'achaea.com', port: 23 };
        const sidecar = buildConnectionSidecar(cleared);
        expect(sidecar).toMatchObject({ tls: false, charLoginAccount: '', description: '' });
        const files = { ...desktopExport(), [`Achaea/${CONNECTION_SIDECAR_PATH}`]: strToU8(JSON.stringify(sidecar)) };
        const record = bundleToConnectionRecord(buildMudletProfileBundle(files));
        expect(record.tls).toBeUndefined();
        expect(record.sslIgnoreSelfSigned).toBeUndefined();
        expect(record.charLoginAccount).toBeUndefined();
        expect(record.description).toBeUndefined();
    });

    it('brings back what Mudlet Web set', () => {
        const set: MudConnection = { id: 'x', name: 'A', mode: 'mud', host: 'a', port: 23, tls: true, sslIgnoreAll: true, charLoginAccount: 'Me', description: 'd' };
        const files = {
            'A/current/1.xml': strToU8('<MudletPackage><HostPackage><Host><name>A</name></Host></HostPackage></MudletPackage>'),
            [`A/${CONNECTION_SIDECAR_PATH}`]: strToU8(JSON.stringify(buildConnectionSidecar(set))),
        };
        expect(bundleToConnectionRecord(buildMudletProfileBundle(files))).toMatchObject({ tls: true, sslIgnoreAll: true, charLoginAccount: 'Me', description: 'd' });
    });
});

describe('decodeProfileDataItem', () => {
    it('reads what QDataStream wrote', () => {
        expect(decodeProfileDataItem(qstring('Héro ⚔'))).toBe('Héro ⚔');
        expect(decodeProfileDataItem(qstring(''))).toBe('');
        expect(decodeProfileDataItem(qstring(null))).toBe('');
    });

    it('takes anything else as plain text', () => {
        expect(decodeProfileDataItem(strToU8('Hero\n'))).toBe('Hero\n');
        expect(decodeProfileDataItem(strToU8('2'))).toBe('2');
    });

    it('decodes the empty login a real desktop profile writes', () => {
        const [bundle] = extractMudletProfileZipAll(zipSync({ ...desktopExport(), 'Achaea/login': qstring('') }));
        expect(bundleToConnectionRecord(bundle).charLoginAccount).toBeUndefined();
    });
});

describe('a module handed over at the upload prompt', () => {
    const bare = () => buildMudletProfileBundle({ 'P/current/1.xml': strToU8(desktopSave) });

    it('unpacks an .mpackage under the module\'s name', () => {
        const bundle = addModuleToBundle(bare(), 'mapper', mapperArchive(), undefined, 'mapper.mpackage');
        expect(bundle.warnings).toEqual([]);
        expect(bundle.packages.find(p => p.name === 'mapper')).toMatchObject({ kind: 'module', xmlPath: 'mapper.xml' });
        expect(bundle.files['mapper/images/arrow.png']).toEqual(new Uint8Array([7]));
        expect(bundle.profile.automation.aliases.some(a => a.name === 'mapper' && a.packageName === 'mapper')).toBe(true);
    });

    it('stores XML given for an archive module under an XML\'s name', () => {
        const bundle = addModuleToBundle(bare(), 'mapper', strToU8(moduleXml('mapper')), undefined, 'mapper.xml');
        expect(bundle.packages.find(p => p.name === 'mapper')).toMatchObject({ xmlPath: 'mapper.xml' });
        expect(Object.keys(bundle.files)).toEqual(['mapper/mapper.xml']);
    });

    it('goes by the file name, as Mudlet does, not by sniffing', () => {
        const bundle = addModuleToBundle(bare(), 'mapper', strToU8('not a zip'), undefined, 'mapper.mpackage');
        expect(bundle.packages.some(p => p.name === 'mapper')).toBe(false);
        expect(bundle.warnings).toEqual(['Module "mapper" was left out: could not unzip mapper.mpackage.']);
    });

    it('is left out with a warning when the archive holds no module XML', () => {
        const bundle = addModuleToBundle(bare(), 'mapper', zipSync({ 'readme.txt': strToU8('hi') }), undefined, 'mapper.mpackage');
        expect(bundle.packages.some(p => p.name === 'mapper')).toBe(false);
        expect(bundle.warnings).toEqual(['Module "mapper" was left out: no package found in mapper.mpackage.']);
    });

    it('imports every XML at the archive\'s root, as desktop does', () => {
        const bundle = addModuleToBundle(bare(), 'mapper', zipSync({
            'a.xml': strToU8(moduleXml('first')),
            'b.xml': strToU8(moduleXml('second')),
        }), undefined, 'mapper.mpackage');
        const names = bundle.profile.automation.aliases.filter(a => a.packageName === 'mapper' && !a.isGroup).map(a => a.name);
        expect(names).toEqual(['first', 'second']);
    });

    it('keeps every entry inside the module\'s folder', () => {
        const bundle = addModuleToBundle(bare(), 'mapper', zipSync({
            'mapper.xml': strToU8(moduleXml('mapper')),
            '../escaped.lua': strToU8('-- outside'),
            'a/../../escaped2.lua': strToU8('-- outside'),
        }), undefined, 'mapper.mpackage');
        expect(Object.keys(bundle.files).sort()).toEqual(['mapper/mapper.mpackage', 'mapper/mapper.xml']);
    });

    it('refuses a module whose name would climb out of its folder', () => {
        const bundle = buildMudletProfileBundle({
            'P/current/1.xml': strToU8(saveWith('<key>../other</key><filepath>/x/evil.mpackage</filepath><zipSync>0</zipSync><globalSave>0</globalSave><priority>0</priority>')),
            'P/evil.mpackage': mapperArchive(),
        });
        expect(resolveModulesFromTree(bundle)).toEqual({ resolved: [], unresolved: [] });
        addModuleToBundle(bundle, '../other', mapperArchive(), undefined, 'evil.mpackage');
        expect(Object.keys(bundle.files).some(k => k.startsWith('..') || k.includes('/../'))).toBe(false);
        expect(bundle.warnings.every(w => w.includes('its name can\'t be a folder'))).toBe(true);
    });
});
