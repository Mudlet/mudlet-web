import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { buildMudletProfileBundle, extractMudletProfileZip, resolveModulesFromTree, addModuleToBundle } from '../../src/import/mudletProfileImport';

function profileXml(opts: { sep: string; varName: string; varValue: string }): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage>
    <Host autoClearCommandLineAfterSend="no">
      <name>test profile</name>
      <url>test.pl</url>
      <port>23</port>
      <mCommandSeparator>${opts.sep}</mCommandSeparator>
    </Host>
  </HostPackage>
  <TriggerPackage>
    <Trigger isActive="yes" isFolder="no">
      <name>newhp</name>
      <script></script>
      <regexCodeList><string>HP</string></regexCodeList>
      <regexCodePropertyList><integer>0</integer></regexCodePropertyList>
    </Trigger>
  </TriggerPackage>
  <VariablePackage>
    <HiddenVariables />
    <Variable>
      <name>${opts.varName}</name>
      <keyType>4</keyType>
      <value>${opts.varValue}</value>
      <valueType>4</valueType>
    </Variable>
  </VariablePackage>
</MudletPackage>`;
}

// A directory-shaped file map (what a File System Access walk or an unzip
// yields): two current saves (the 11-57 one is newer), two map saves, and a
// loose profile-root file.
function profileFiles(): Record<string, Uint8Array> {
    return {
        'test profile/current/2026-06-26#11-50-18.xml': strToU8(profileXml({ sep: '/', varName: 'oldvar', varValue: 'old' })),
        'test profile/current/2026-06-26#11-57-29.xml': strToU8(profileXml({ sep: ';;', varName: 'newvar', varValue: 'new' })),
        'test profile/map/2026-06-26#11-00-00map': new Uint8Array([1, 2]),
        'test profile/map/2026-06-26#11-57-00map': new Uint8Array([9, 9, 9]),
        'test profile/gmcp.lua': strToU8('-- a package file'),
    };
}

describe('buildMudletProfileBundle', () => {
    const bundle = buildMudletProfileBundle(profileFiles());

    it('reads the connection identity from <Host>', () => {
        expect(bundle.name).toBe('test profile');
        expect(bundle.host).toBe('test.pl');
        expect(bundle.port).toBe(23);
    });

    it('parses the NEWEST current/*.xml (by timestamp filename)', () => {
        expect(bundle.profile.settings.commandSeparator).toBe(';;'); // from the 11-57 save
        expect(bundle.profile.variables.variables.map(v => v.name)).toEqual(['newvar']);
        expect(bundle.profile.automation.triggers.map(t => t.name)).toContain('newhp');
    });

    it('picks the newest map binary', () => {
        expect(bundle.mapBytes).toEqual(new Uint8Array([9, 9, 9]));
    });

    it('keeps profile-root files but excludes current/ and map/', () => {
        expect(Object.keys(bundle.files)).toEqual(['gmcp.lua']);
        expect(bundle.files['gmcp.lua']).toEqual(strToU8('-- a package file'));
    });

    it('handles a root-level profile (no wrapping folder)', () => {
        const flat: Record<string, Uint8Array> = {
            'current/2026-06-26#11-57-29.xml': strToU8(profileXml({ sep: ';;', varName: 'v', varValue: 'x' })),
        };
        expect(buildMudletProfileBundle(flat, 'Fallback').name).toBe('test profile');
    });

    it('throws when there is no current/*.xml', () => {
        expect(() => buildMudletProfileBundle({ 'random.txt': new Uint8Array([1]) }))
            .toThrow(/not a mudlet profile/i);
    });
});

const MODULE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <AliasPackage>
    <Alias isActive="yes" isFolder="no"><name>btn</name><command>press</command><regex>^b$</regex><script></script></Alias>
  </AliasPackage>
</MudletPackage>`;

function profileWithModule(): Record<string, Uint8Array> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage><Host>
    <name>P</name>
    <mInstalledModules>
      <key>buttons</key><filepath>C:/Users/x/Downloads/buttons.xml</filepath><globalSave>0</globalSave><priority>0</priority>
    </mInstalledModules>
    <mInstalledModules>
      <key>missing</key><filepath>C:/elsewhere/missing.xml</filepath><globalSave>1</globalSave><priority>2</priority>
    </mInstalledModules>
  </Host></HostPackage>
</MudletPackage>`;
    return {
        'P/current/2026-06-26#10-00-00.xml': strToU8(xml),
        // The 'buttons' module's file happens to live in the profile tree.
        'P/some/buttons.xml': strToU8(MODULE_XML),
    };
}

describe('module resolution', () => {
    it('parses <mInstalledModules> into the bundle', () => {
        const bundle = buildMudletProfileBundle(profileWithModule());
        expect(bundle.modules.map(m => m.key)).toEqual(['buttons', 'missing']);
        expect(bundle.modules[1]).toMatchObject({ key: 'missing', globalSave: true, priority: 2 });
    });

    it('auto-resolves modules whose file is in the tree (by basename), leaving the rest', () => {
        const bundle = buildMudletProfileBundle(profileWithModule());
        const { resolved, unresolved } = resolveModulesFromTree(bundle);
        expect(resolved.map(r => r.ref.key)).toEqual(['buttons']);
        expect(unresolved.map(m => m.key)).toEqual(['missing']);
    });

    it('folds a resolved/uploaded module in as a removable package', () => {
        const bundle = buildMudletProfileBundle(profileWithModule());
        addModuleToBundle(bundle, 'buttons', strToU8(MODULE_XML));
        // The module's alias is imported and tagged with the module key.
        const alias = bundle.profile.automation.aliases.find(a => a.name === 'btn');
        expect(alias?.packageName).toBe('buttons');
        expect(bundle.packages.some(p => p.name === 'buttons')).toBe(true);
    });
});

describe('extractMudletProfileZip', () => {
    it('unzips a profile archive and builds the same bundle', () => {
        const zip = zipSync(profileFiles());
        const bundle = extractMudletProfileZip(zip);
        expect(bundle.name).toBe('test profile');
        expect(bundle.profile.settings.commandSeparator).toBe(';;');
        expect(bundle.mapBytes).toEqual(new Uint8Array([9, 9, 9]));
        expect(Object.keys(bundle.files)).toEqual(['gmcp.lua']);
    });
});

// A profile import used to succeed in total silence even when it dropped data:
// the parser's warnings went into `profile.automation.warnings` and nothing on
// the profile path ever read them (issue #45). The bundle now carries one list
// that every later stage appends to, which is what the import UI reads.
describe('bundle warnings', () => {
    // An unbound Qt key code (999999 maps to nothing) is the parser's own
    // long-standing warning, and an offset timer — a timer nested under a
    // non-folder timer, TTimer.h:75-84 — is a structure this client cannot
    // represent at all.
    const lossyXml = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage><Host><name>Lossy</name></Host></HostPackage>
  <KeyPackage>
    <Key isActive="yes" isFolder="no">
      <name>weird</name><script></script><command></command>
      <keyCode>999999</keyCode><keyModifier>0</keyModifier>
    </Key>
  </KeyPackage>
  <TimerPackage>
    <Timer isActive="yes" isFolder="no">
      <name>heartbeat</name><script></script><command></command><time>00:00:05.000</time>
      <Timer isActive="yes" isFolder="no">
        <name>followup</name><script></script><command></command><time>00:00:02.000</time>
      </Timer>
    </Timer>
  </TimerPackage>
</MudletPackage>`;

    const lossyFiles = (): Record<string, Uint8Array> => ({
        'Lossy/current/2026-06-26#10-00-00.xml': strToU8(lossyXml),
    });

    it('carries the parser warnings on the bundle, not just inside the automation', () => {
        const bundle = buildMudletProfileBundle(lossyFiles());
        expect(bundle.warnings.some(w => w.includes('"weird"'))).toBe(true);
    });

    it('warns that an offset timer cannot keep its relationship to its parent', () => {
        const bundle = buildMudletProfileBundle(lossyFiles());
        const w = bundle.warnings.find(w => w.includes('"heartbeat"'));
        expect(w).toBeDefined();
        expect(w).toContain('"followup"');
        expect(w).toContain('offset timer');
    });

    it('is a copy, so appending to it does not mutate the parsed automation', () => {
        const bundle = buildMudletProfileBundle(lossyFiles());
        const before = bundle.profile.automation.warnings.length;
        bundle.warnings.push('added later');
        expect(bundle.profile.automation.warnings).toHaveLength(before);
    });

    it('names the module a folded-in module\'s warnings came from', () => {
        const bundle = buildMudletProfileBundle(profileWithModule());
        const moduleXml = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001"><KeyPackage>
  <Key isActive="yes" isFolder="no">
    <name>modkey</name><script></script><command></command>
    <keyCode>999999</keyCode><keyModifier>0</keyModifier>
  </Key>
</KeyPackage></MudletPackage>`;
        addModuleToBundle(bundle, 'buttons', strToU8(moduleXml));
        expect(bundle.warnings.some(w => w.startsWith('Module "buttons": ') && w.includes('"modkey"'))).toBe(true);
    });

    it('leaves the list empty for a profile that imports cleanly', () => {
        expect(buildMudletProfileBundle(profileFiles()).warnings).toEqual([]);
    });
});
