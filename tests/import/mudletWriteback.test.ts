import { describe, it, expect } from 'vitest';
import { buildLinkedWriteback, mudletTimestamp } from '../../src/import/mudletWriteback';
import { parseMudletProfile } from '../../src/import/mudletHost';
import type { SerializeInput } from '../../src/import/mudletXmlExport';
import type { TriggerNode } from '../../src/storage/schema';

const BASE = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <HostPackage>
    <Host mUnknownToggle="yes" mEnableGMCP="yes">
      <name>Arkadia</name>
      <url>arkadia.pl</url>
      <port>23</port>
      <mCommandSeparator>;;</mCommandSeparator>
      <someUnknownElement>preserve me</someUnknownElement>
    </Host>
  </HostPackage>
  <TriggerPackage>
    <Trigger isActive="yes" isFolder="no">
      <name>oldTrigger</name><script></script>
      <regexCodeList><string>OLD</string></regexCodeList>
      <regexCodePropertyList><integer>0</integer></regexCodePropertyList>
    </Trigger>
  </TriggerPackage>
  <VariablePackage>
    <HiddenVariables />
    <Variable><name>oldVar</name><keyType>4</keyType><value>1</value><valueType>3</valueType></Variable>
  </VariablePackage>
</MudletPackage>`;

function trigger(name: string, pat: string): TriggerNode {
    return {
        id: name, name, enabled: true, isGroup: false, parentId: null,
        patterns: [{ text: pat, type: 'substring' }],
        code: '', language: 'lua', fireLength: 0, multipleMatches: false,
        multiline: false, delta: 0, isFilter: false,
    };
}

const EMPTY_TREES: SerializeInput = { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] };

describe('buildLinkedWriteback', () => {
    const out = buildLinkedWriteback(
        BASE,
        { ...EMPTY_TREES, triggers: [trigger('newTrigger', 'NEW')] },
        { hidden: [], variables: [{ name: 'gold', keyKind: 'string', valueType: 'number', value: '500' }] },
    );

    it('preserves the entire Host block, including fields mudlet does not model', () => {
        expect(out).toContain('mUnknownToggle="yes"');
        expect(out).toContain('<someUnknownElement>preserve me</someUnknownElement>');
        expect(out).toContain('<mCommandSeparator>;;</mCommandSeparator>');
        // identity survives a re-parse
        const reparsed = parseMudletProfile(out);
        expect(reparsed.connection).toMatchObject({ name: 'Arkadia', host: 'arkadia.pl', port: 23 });
        expect(reparsed.settings.commandSeparator).toBe(';;');
    });

    it('replaces the automation with the live trees', () => {
        const reparsed = parseMudletProfile(out);
        expect(reparsed.automation.triggers.map(t => t.name)).toEqual(['newTrigger']);
        expect(out).not.toContain('oldTrigger');
    });

    it('replaces the variable package with the captured variables', () => {
        const reparsed = parseMudletProfile(out);
        expect(reparsed.variables.variables.map(v => v.name)).toEqual(['gold']);
        expect(out).not.toContain('oldVar');
    });

    it('throws on malformed base XML', () => {
        expect(() => buildLinkedWriteback('<not xml', EMPTY_TREES, { hidden: [], variables: [] }))
            .toThrow();
    });

    it('updates modeled Host settings in place while preserving unmodeled ones', () => {
        const updated = buildLinkedWriteback(
            BASE,
            EMPTY_TREES,
            { hidden: [], variables: [] },
            { commandSeparator: '/', promptTimeoutMs: 500, protocols: { gmcp: false }, outputForeground: '#abcdef' },
        );
        const reparsed = parseMudletProfile(updated);
        expect(reparsed.settings.commandSeparator).toBe('/');           // changed
        expect(reparsed.settings.promptTimeoutMs).toBe(500);            // changed
        expect(reparsed.settings.protocols?.gmcp).toBe(false);         // changed
        expect(reparsed.settings.outputForeground).toBe('#abcdef');    // added element
        // unmodeled Host bits still intact
        expect(updated).toContain('mUnknownToggle="yes"');
        expect(updated).toContain('<someUnknownElement>preserve me</someUnknownElement>');
        // identity untouched
        expect(reparsed.connection).toMatchObject({ name: 'Arkadia', host: 'arkadia.pl', port: 23 });
    });

    it('writes a system font family + size, preserving the QFont tail', () => {
        const base = BASE.replace('</Host>',
            '<mDisplayFont>Old Font,11,-1,5,400,0,0,0,0,0,0,0,0,0,0,1,,0,0</mDisplayFont></Host>');
        const out = buildLinkedWriteback(base, EMPTY_TREES, { hidden: [], variables: [] },
            { outputFont: { kind: 'system', family: 'Fira Code' }, fontSize: 16 });
        expect(out).toContain('<mDisplayFont>Fira Code,16,-1,5,400,0,0,0,0,0,0,0,0,0,0,1,,0,0</mDisplayFont>');
    });

    it('does not write a url/vfs font family, but still syncs the size', () => {
        const base = BASE.replace('</Host>',
            '<mDisplayFont>Keep Me,11,-1,5,400,0,0,0,0,0,0,0,0,0,0,1,,0,0</mDisplayFont></Host>');
        const out = buildLinkedWriteback(base, EMPTY_TREES, { hidden: [], variables: [] },
            { outputFont: { kind: 'vfs', family: 'My VFS Font', path: '/f.ttf' }, fontSize: 20 });
        expect(out).toContain('<mDisplayFont>Keep Me,20,-1,5,400,0,0,0,0,0,0,0,0,0,0,1,,0,0</mDisplayFont>');
        expect(out).not.toContain('My VFS Font');
    });
});

describe('mudletTimestamp', () => {
    it('formats like Mudlet (YYYY-MM-DD#HH-mm-ss)', () => {
        expect(mudletTimestamp(new Date(2026, 5, 26, 9, 5, 3))).toBe('2026-06-26#09-05-03');
    });
});
