import { describe, it, expect } from 'vitest';
import { strToU8, strFromU8 } from 'fflate';
import { applyHostIdentity, extractHostPackageXml, parseMudletHost } from '../../src/import/mudletHost';
import {
    buildHostBaseXml,
    buildProfileFolder,
    buildProfileXml,
    formatSaveStamp,
    RETAINED_HOST_PATH,
} from '../../src/import/mudletProfileExport';
import { buildMudletProfileBundle } from '../../src/import/mudletProfileImport';
import { readHostBase } from '../../src/import/collectProfileExport';
import type { PersistedProfileData } from '../../src/storage/profileVfsData';
import type { MudConnection } from '../../src/storage/schema';

// Mudlet's <Host> is ~120 attributes, 26 elements and 53 colours; mudix models
// about a third. The rest survives a round-trip only by being carried verbatim,
// so these tests pin what extraction keeps, what it deliberately drops, and that
// the export writes it back out with the live identity stamped over it.

const STAMP = formatSaveStamp(new Date(2026, 6, 29, 20, 14, 3));

/** Field names taken from Mudlet's own reader (`XMLimport.cpp` @124ee8b5f):
 *  proxy at :813-824, TLS at :804-805, logging at :850-895, the dictionary at
 *  :852, consoleBufferSize/useMaxConsoleBufferSize at :1148-1150,
 *  mCommandLineFont at :1166, mSpellDic at :1176, mMapInfoContributors at :1189,
 *  profileShortcut at :1193, stopwatches at :1195, MMCP at :1197, and the `*2`
 *  second-console palette at :1241-1246. None of these has a ProfileSettings
 *  home; all of them must come back out unchanged. */
const IMPORTED_SAVE = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage>
    <Host autoClearCommandLineAfterSend="no" mEnableGMCP="yes" mEnableMSDP="no"
          mSslTsl="yes" mSslIgnoreExpired="yes"
          mProxyAddress="10.0.0.9" mProxyPort="8080" mProxyUsername="pw"
          logDirectory="D:/logs" logFileNameFormat="yyyy-MM-dd" logFileName="arkadia"
          mEnableUserDictionary="yes"
          mSearchEngineName="DuckDuckGo" mTimerSupressionInterval="00:00:02.000"
          playerRoomStyle="2" NetworkPacketTimeout="300">
      <name>Old Name</name>
      <url>old.example.org</url>
      <port>4000</port>
      <mCommandSeparator>;;</mCommandSeparator>
      <wrapAt>100</wrapAt>
      <mFgColor>#c0c0c0</mFgColor>
      <mBgColor>#000000</mBgColor>
      <mFgColor2>#00ff00</mFgColor2>
      <mBlack2>#111111</mBlack2>
      <consoleBufferSize>250000</consoleBufferSize>
      <useMaxConsoleBufferSize>100000</useMaxConsoleBufferSize>
      <mCommandLineFont>Fira Code,12,-1,5,400,0,0,0,0,0,0,0,0,0,0,1,,0,0</mCommandLineFont>
      <mSpellDic>en_GB</mSpellDic>
      <mMapInfoContributors>
        <string>Short</string>
      </mMapInfoContributors>
      <profileShortcut><key>Reconnect</key><value>Ctrl+R</value></profileShortcut>
      <stopwatches><stopwatch id="1" name="fight"/></stopwatches>
      <MMCP chatName="Bob" chatPort="4050" autostartServer="yes"/>
      <mInstalledPackages>
        <string>old-package</string>
      </mInstalledPackages>
      <mInstalledModules>
        <key>buttons</key>
        <filepath>C:/Users/someone/buttons.xml</filepath>
        <globalSave>1</globalSave>
        <priority>0</priority>
      </mInstalledModules>
    </Host>
  </HostPackage>
  <TriggerPackage>
    <TriggerGroup isActive="yes" isFolder="no">
      <name>Stale</name>
      <script>echo("stale")</script>
      <regexCodeList><string>stale</string></regexCodeList>
      <regexCodePropertyList><integer>1</integer></regexCodePropertyList>
    </TriggerGroup>
  </TriggerPackage>
  <VariablePackage><VariableGroup><Variable><name>old</name></Variable></VariableGroup></VariablePackage>
</MudletPackage>`;

const CONNECTION: MudConnection = {
    id: 'c1', name: 'Arkadia', mode: 'mud', host: 'arkadia.rpg.pl', port: 23,
};

function profileData(over: Partial<PersistedProfileData> = {}): PersistedProfileData {
    return {
        version: 2,
        scripts: [], aliases: [], triggers: [], timers: [], keybindings: [], buttons: [],
        packages: [{ name: 'run-lua-code', version: '1.0', installedAt: '2026-01-01T00:00:00.000Z' }],
        profile: { commandSeparator: '::', outputWrapAt: 120 },
        ...over,
    } as PersistedProfileData;
}

function host(xml: string): Element {
    return new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('Host')[0];
}

describe('extractHostPackageXml', () => {
    const extracted = extractHostPackageXml(IMPORTED_SAVE)!;

    it('keeps the Host fields mudix does not model', () => {
        // Attributes.
        expect(extracted).toContain('mProxyAddress="10.0.0.9"');
        expect(extracted).toContain('mProxyPort="8080"');
        expect(extracted).toContain('mSslTsl="yes"');
        expect(extracted).toContain('logDirectory="D:/logs"');
        expect(extracted).toContain('mSearchEngineName="DuckDuckGo"');
        expect(extracted).toContain('mTimerSupressionInterval="00:00:02.000"');
        expect(extracted).toContain('playerRoomStyle="2"');
        // Elements, including the second-console palette and the nested blocks.
        expect(extracted).toContain('<consoleBufferSize>250000</consoleBufferSize>');
        expect(extracted).toContain('<mSpellDic>en_GB</mSpellDic>');
        expect(extracted).toContain('<mFgColor2>#00ff00</mFgColor2>');
        expect(extracted).toContain('<mBlack2>#111111</mBlack2>');
        expect(extracted).toContain('<mCommandLineFont>');
        expect(extracted).toContain('<stopwatch');
        expect(extracted).toContain('chatName="Bob"');
        expect(extracted).toContain('<profileShortcut>');
        expect(extracted).toContain('<mMapInfoContributors>');
    });

    it('drops the automation and variable packages, which are regenerated', () => {
        expect(extracted).not.toContain('TriggerPackage');
        expect(extracted).not.toContain('VariablePackage');
        expect(extracted).not.toContain('stale');
    });

    it('drops mInstalledModules, which import folds into ordinary packages', () => {
        expect(extracted).not.toContain('mInstalledModules');
        expect(extracted).not.toContain('buttons.xml');
    });

    it('keeps the document a valid Mudlet save with the original version stamp', () => {
        expect(extracted).toContain('<MudletPackage version="1.001">');
        expect(extracted).toContain('<HostPackage>');
        // happy-dom lowercases a doctype name on re-serialization where a browser
        // preserves it, so match case-insensitively rather than pin the artifact.
        expect(extracted).toMatch(/<!DOCTYPE MudletPackage>/i);
        const doc = new DOMParser().parseFromString(extracted, 'text/xml');
        expect(doc.getElementsByTagName('parsererror')[0]).toBeUndefined();
    });

    it('answers null rather than throwing for input it cannot use', () => {
        expect(extractHostPackageXml('<MudletPackage><TriggerPackage/></MudletPackage>')).toBeNull();
        expect(extractHostPackageXml('not xml at <all')).toBeNull();
    });
});

describe('applyHostIdentity', () => {
    it('overwrites the retained name, address and package list', () => {
        const el = host(extractHostPackageXml(IMPORTED_SAVE)!);
        applyHostIdentity(el, {
            name: 'Arkadia', url: 'arkadia.rpg.pl', port: 23,
            installedPackages: ['run-lua-code', 'mpkg'],
        });
        const xml = new XMLSerializer().serializeToString(el);
        expect(xml).toContain('<name>Arkadia</name>');
        expect(xml).toContain('<url>arkadia.rpg.pl</url>');
        expect(xml).toContain('<port>23</port>');
        expect(xml).not.toContain('Old Name');
        expect(xml).not.toContain('old.example.org');
        // The retained list is replaced wholesale, not merged into.
        expect(xml).not.toContain('old-package');
        expect(xml).toContain('<string>run-lua-code</string>');
        expect(xml).toContain('<string>mpkg</string>');
    });

    it('creates the elements when the Host has none', () => {
        const el = host('<Host></Host>');
        applyHostIdentity(el, { name: 'New', url: 'h', port: 1, installedPackages: [] });
        const xml = new XMLSerializer().serializeToString(el);
        expect(xml).toContain('<name>New</name>');
        expect(xml).toContain('<mInstalledPackages');
    });

    it('escapes XML metacharacters', () => {
        const el = host('<Host></Host>');
        applyHostIdentity(el, {
            name: 'Bob & <Alice>', url: 'h', port: 1, installedPackages: ['a&b'],
        });
        const xml = new XMLSerializer().serializeToString(el);
        expect(xml).toContain('<name>Bob &amp; &lt;Alice&gt;</name>');
        expect(xml).toContain('<string>a&amp;b</string>');
    });
});

describe('buildHostBaseXml', () => {
    it('falls back to the empty skeleton without a retained Host', () => {
        const xml = buildHostBaseXml(CONNECTION, ['run-lua-code']);
        expect(xml).toContain('<name>Arkadia</name>');
        expect(xml).toContain('<port>23</port>');
        expect(xml).toContain('<string>run-lua-code</string>');
        expect(xml).not.toContain('mProxyAddress');
    });

    it('degrades to the skeleton for a retained file that is unusable', () => {
        for (const bad of ['', 'truncated <Host', '<MudletPackage><HostPackage/></MudletPackage>']) {
            const xml = buildHostBaseXml(CONNECTION, [], bad);
            expect(xml).toContain('<name>Arkadia</name>');
        }
    });
});

describe('buildProfileXml with a retained <Host>', () => {
    const xml = buildProfileXml(CONNECTION, profileData(), IMPORTED_SAVE);

    it('carries the unmodeled settings through to the export', () => {
        expect(xml).toContain('mProxyAddress="10.0.0.9"');
        expect(xml).toContain('mSslTsl="yes"');
        expect(xml).toContain('<consoleBufferSize>250000</consoleBufferSize>');
        expect(xml).toContain('<mSpellDic>en_GB</mSpellDic>');
        expect(xml).toContain('<mBlack2>#111111</mBlack2>');
        expect(xml).toContain('chatName="Bob"');
    });

    it('lets the live modeled settings win over the retained ones', () => {
        const settings = parseMudletHost(host(xml));
        expect(settings.commandSeparator).toBe('::');
        expect(settings.outputWrapAt).toBe(120);
    });

    it('stamps the live identity and package set over the retained ones', () => {
        expect(xml).toContain('<name>Arkadia</name>');
        expect(xml).toContain('<url>arkadia.rpg.pl</url>');
        expect(xml).not.toContain('Old Name');
        expect(xml).not.toContain('old-package');
        expect(xml).toContain('<string>run-lua-code</string>');
    });

    it('does not carry the retained automation or variables', () => {
        // The retained document's stale trigger must not reappear alongside the
        // freshly serialized (here empty) automation.
        expect(xml).not.toContain('Stale');
        expect(xml).not.toContain('echo("stale")');
    });
});

describe('import → export → import keeps the unmodeled Host', () => {
    const bundle = buildMudletProfileBundle({ 'current/2026-01-01#00-00-00.xml': strToU8(IMPORTED_SAVE) });

    it('retains the original <HostPackage> on the bundle', () => {
        expect(bundle.hostPackageXml).toBeDefined();
        expect(bundle.hostPackageXml).toContain('mProxyAddress="10.0.0.9"');
    });

    it('writes it back out and reads it back unchanged', () => {
        const folder = buildProfileFolder({
            connection: CONNECTION,
            data: profileData(),
            files: {},
            hostBaseXml: bundle.hostPackageXml,
        }, STAMP);
        const exported = strFromU8(folder[`current/${STAMP}.xml`]);
        const reimported = buildMudletProfileBundle({ [`current/${STAMP}.xml`]: strToU8(exported) });

        // Mudlet's own prolog, as the string-built skeleton used to emit.
        expect(exported).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><!DOCTYPE MudletPackage>/i);
        expect(reimported.name).toBe('Arkadia');
        expect(reimported.hostPackageXml).toContain('mProxyAddress="10.0.0.9"');
        expect(reimported.hostPackageXml).toContain('<consoleBufferSize>250000</consoleBufferSize>');
        expect(reimported.hostPackageXml).toContain('chatName="Bob"');
        // A second cycle is lossless too — the retained Host is regenerated from
        // the export, so fidelity doesn't decay over repeated round-trips.
        expect(reimported.hostPackageXml).toContain('<mSpellDic>en_GB</mSpellDic>');
    });

    it('loses them when there is nothing retained, as before', () => {
        const folder = buildProfileFolder({
            connection: CONNECTION, data: profileData(), files: {},
        }, STAMP);
        expect(strFromU8(folder[`current/${STAMP}.xml`])).not.toContain('mProxyAddress');
    });
});

describe('readHostBase', () => {
    /** A profile VFS as far as the base lookup is concerned. */
    function vfs(files: Record<string, string>) {
        return {
            exists: (p: string) => p in files || Object.keys(files).some(k => k.startsWith(`${p}/`)),
            readdir: (p: string) => Object.keys(files)
                .filter(k => k.startsWith(`${p}/`))
                .map(k => k.slice(p.length + 1)),
            stat: () => ({ mtime: new Date(0) }),
            readFile: (p: string) => files[p],
        };
    }

    it('lives under the internal directory the export and Mudlet both skip', () => {
        expect(RETAINED_HOST_PATH.startsWith('.mudix/')).toBe(true);
    });

    it('prefers the retained copy over a save mudix wrote itself', () => {
        // saveProfile() puts mudix's own output in current/; basing on that
        // would re-read what an earlier export already narrowed.
        const base = readHostBase(vfs({
            [RETAINED_HOST_PATH]: extractHostPackageXml(IMPORTED_SAVE)!,
            'current/2026-07-29#20-14-03.xml': buildProfileXml(CONNECTION, profileData()),
        }));
        expect(base).toContain('mProxyAddress="10.0.0.9"');
    });

    it('falls back to a linked folder\'s own newest save', () => {
        const base = readHostBase(vfs({ 'current/2026-01-01#00-00-00.xml': IMPORTED_SAVE }));
        expect(base).toContain('mProxyAddress="10.0.0.9"');
    });

    it('answers nothing for a profile born in mudix', () => {
        expect(readHostBase(vfs({ 'lua-packages/thing.lua': 'return 1' }))).toBeUndefined();
    });
});
