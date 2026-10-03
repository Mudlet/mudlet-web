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

function desktopExport(): Record<string, Uint8Array> {
    return {
        'Achaea/current/2026-10-03#12-00-00.xml': strToU8(desktopSave),
        'Achaea/map/2026-10-03#12-00-00map.dat': new Uint8Array([1, 2, 3]),
        // copied in from outside the profile by the export
        'Achaea/ui/ui.xml': strToU8(moduleXml('ui')),
        'Achaea/dup/init.xml': strToU8(moduleXml('dup')),
        // desktop's own unpacked copy of the archived module, with an asset
        'Achaea/mapper/mapper.xml': strToU8(moduleXml('mapper')),
        'Achaea/mapper/icon.png': new Uint8Array([0x89, 0x50]),
        // a package that happens to share the dup module's file name
        'Achaea/somepkg/init.xml': strToU8(moduleXml('package')),
        // the connection dialog's files, as Host::writeProfileData leaves them
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
        expect(modules.map(m => [m.name, m.xmlVfsPath, m.sync, m.priority])).toEqual([
            ['ui', 'ui/ui.xml', true, 2],
            ['mapper', 'mapper/mapper.xml', true, -1],
            ['dup', 'dup/init.xml', false, 0],
        ]);
        const aliases = bundle.profile.automation.aliases.map(a => [a.name, a.packageName]);
        expect(aliases).toEqual(expect.arrayContaining([['ui', 'ui'], ['mapper', 'mapper'], ['dup', 'dup']]));
        expect(aliases.some(([name]) => name === 'package')).toBe(false);
        expect(bundle.files['mapper/icon.png']).toEqual(new Uint8Array([0x89, 0x50]));
    });

    it('anchors each module\'s file in the new profile', () => {
        const [bundle] = extractMudletProfileZipAll(zipSync(desktopExport()));
        importLikeTheConnectionScreen(bundle);
        const data = bundleToConnectionData(bundle, '2026-10-03T12:00:00Z', '/profiles/new');
        expect(data.packages.find(p => p.name === 'dup')?.xmlVfsPath).toBe('/profiles/new/dup/init.xml');
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

describe('a module handed over as its archive', () => {
    const archive = () => zipSync({
        'mapper.xml': strToU8(moduleXml('mapper')),
        'images/arrow.png': new Uint8Array([7]),
    });

    it('is unpacked under its name, the way desktop installs it', () => {
        const files = desktopExport();
        delete files['Achaea/mapper/mapper.xml'];
        delete files['Achaea/mapper/icon.png'];
        files['Achaea/mapper/mapper.mpackage'] = archive();
        const [bundle] = extractMudletProfileZipAll(zipSync(files));
        expect(importLikeTheConnectionScreen(bundle)).toEqual([]);
        expect(bundle.packages.find(p => p.name === 'mapper')).toMatchObject({ kind: 'module', xmlVfsPath: 'mapper/mapper.xml' });
        expect(bundle.files['mapper/images/arrow.png']).toEqual(new Uint8Array([7]));
        expect(bundle.profile.automation.aliases.some(a => a.name === 'mapper' && a.packageName === 'mapper')).toBe(true);
    });

    it('works from the upload prompt too', () => {
        const bundle = buildMudletProfileBundle({ 'P/current/1.xml': strToU8(desktopSave) });
        addModuleToBundle(bundle, 'mapper', archive());
        expect(bundle.packages.find(p => p.name === 'mapper')?.xmlVfsPath).toBe('mapper/mapper.xml');
        expect(bundle.warnings).toEqual([]);
    });

    it('is left out with a warning when it holds no module XML', () => {
        const bundle = buildMudletProfileBundle({ 'P/current/1.xml': strToU8(desktopSave) });
        addModuleToBundle(bundle, 'mapper', zipSync({ 'readme.txt': strToU8('hi') }));
        expect(bundle.packages.some(p => p.name === 'mapper')).toBe(false);
        expect(bundle.warnings).toEqual(['Module "mapper": its archive holds no module XML, so it was left out.']);
    });
});

describe('unpacking a module archive', () => {
    it('keeps every entry inside the module\'s folder', () => {
        const bundle = buildMudletProfileBundle({ 'P/current/1.xml': strToU8(desktopSave) });
        addModuleToBundle(bundle, 'mapper', zipSync({
            'mapper.xml': strToU8(moduleXml('mapper')),
            '../escaped.lua': strToU8('-- outside'),
            'a/../../escaped2.lua': strToU8('-- outside'),
        }));
        expect(Object.keys(bundle.files).sort()).toEqual(['mapper/mapper.xml']);
    });

    it('takes the archive\'s own XML over a stale copy already in the tree', () => {
        const bundle = buildMudletProfileBundle({
            'P/current/1.xml': strToU8(desktopSave),
            'P/mapper/mapper.xml': strToU8(moduleXml('stale')),
        });
        addModuleToBundle(bundle, 'mapper', zipSync({ 'mapper.xml': strToU8(moduleXml('fresh')) }));
        const names = bundle.profile.automation.aliases.map(a => a.name);
        expect(names).toContain('fresh');
        expect(names).not.toContain('stale');
    });
});
