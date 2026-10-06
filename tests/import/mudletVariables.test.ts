import { describe, it, expect } from 'vitest';
import {
    parseVariablePackageXml,
    parseVariablePackage,
    serializeVariablePackage,
} from '../../src/import/mudletVariables';

// Canonical <VariablePackage> taken verbatim from a real Mudlet 4.x profile
// export (test profile, 2026-06-26). Exercises every type code, a numeric key,
// and a nested table. Lines are joined so the tab indentation is unambiguous;
// this is byte-for-byte what Mudlet wrote (one tab inside <MudletPackage>).
const REAL_PACKAGE = [
    '\t<VariablePackage>',
    '\t\t<HiddenVariables />',
    '\t\t<VariableGroup>',
    '\t\t\t<name>demoVar</name>',
    '\t\t\t<keyType>4</keyType>',
    '\t\t\t<value></value>',
    '\t\t\t<valueType>5</valueType>',
    '\t\t\t<Variable>',
    '\t\t\t\t<name>7</name>',
    '\t\t\t\t<keyType>3</keyType>',
    '\t\t\t\t<value>numkey</value>',
    '\t\t\t\t<valueType>4</valueType>',
    '\t\t\t</Variable>',
    '\t\t\t<Variable>',
    '\t\t\t\t<name>b</name>',
    '\t\t\t\t<keyType>4</keyType>',
    '\t\t\t\t<value>true</value>',
    '\t\t\t\t<valueType>1</valueType>',
    '\t\t\t</Variable>',
    '\t\t\t<Variable>',
    '\t\t\t\t<name>f</name>',
    '\t\t\t\t<keyType>4</keyType>',
    '\t\t\t\t<value>3.5</value>',
    '\t\t\t\t<valueType>3</valueType>',
    '\t\t\t</Variable>',
    '\t\t\t<Variable>',
    '\t\t\t\t<name>n</name>',
    '\t\t\t\t<keyType>4</keyType>',
    '\t\t\t\t<value>42</value>',
    '\t\t\t\t<valueType>3</valueType>',
    '\t\t\t</Variable>',
    '\t\t\t<Variable>',
    '\t\t\t\t<name>s</name>',
    '\t\t\t\t<keyType>4</keyType>',
    '\t\t\t\t<value>hi</value>',
    '\t\t\t\t<valueType>4</valueType>',
    '\t\t\t</Variable>',
    '\t\t\t<VariableGroup>',
    '\t\t\t\t<name>sub</name>',
    '\t\t\t\t<keyType>4</keyType>',
    '\t\t\t\t<value></value>',
    '\t\t\t\t<valueType>5</valueType>',
    '\t\t\t\t<Variable>',
    '\t\t\t\t\t<name>x</name>',
    '\t\t\t\t\t<keyType>4</keyType>',
    '\t\t\t\t\t<value>1</value>',
    '\t\t\t\t\t<valueType>3</valueType>',
    '\t\t\t\t</Variable>',
    '\t\t\t\t<Variable>',
    '\t\t\t\t\t<name>y</name>',
    '\t\t\t\t\t<keyType>4</keyType>',
    '\t\t\t\t\t<value>deep</value>',
    '\t\t\t\t\t<valueType>4</valueType>',
    '\t\t\t\t</Variable>',
    '\t\t\t</VariableGroup>',
    '\t\t</VariableGroup>',
    '\t\t<VariableGroup>',
    '\t\t\t<name>test table</name>',
    '\t\t\t<keyType>4</keyType>',
    '\t\t\t<value></value>',
    '\t\t\t<valueType>5</valueType>',
    '\t\t</VariableGroup>',
    '\t</VariablePackage>',
].join('\n');

const wrapDoc = (frag: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<MudletPackage version="1.001">\n${frag}\n</MudletPackage>`;

describe('mudletVariables — parse', () => {
    const pkg = parseVariablePackageXml(wrapDoc(REAL_PACKAGE));

    it('reads top-level variables and an empty hidden list', () => {
        expect(pkg.hidden).toEqual([]);
        expect(pkg.variables.map(v => v.name)).toEqual(['demoVar', 'test table']);
    });

    it('decodes scalar types, values, and a numeric key', () => {
        const demo = pkg.variables.find(v => v.name === 'demoVar')!;
        expect(demo.valueType).toBe('table');
        const byName = Object.fromEntries(demo.children!.map(c => [c.name, c]));

        expect(byName['7']).toMatchObject({ keyKind: 'number', valueType: 'string', value: 'numkey' });
        expect(byName['b']).toMatchObject({ keyKind: 'string', valueType: 'boolean', value: 'true' });
        expect(byName['f']).toMatchObject({ keyKind: 'string', valueType: 'number', value: '3.5' });
        expect(byName['n']).toMatchObject({ keyKind: 'string', valueType: 'number', value: '42' });
        expect(byName['s']).toMatchObject({ keyKind: 'string', valueType: 'string', value: 'hi' });
    });

    it('recurses into nested tables', () => {
        const demo = pkg.variables.find(v => v.name === 'demoVar')!;
        const sub = demo.children!.find(c => c.name === 'sub')!;
        expect(sub.valueType).toBe('table');
        expect(sub.children!.map(c => `${c.name}=${c.value}`)).toEqual(['x=1', 'y=deep']);
    });

    it('keeps an empty table as a childless group', () => {
        const empty = pkg.variables.find(v => v.name === 'test table')!;
        expect(empty.valueType).toBe('table');
        expect(empty.children).toEqual([]);
    });
});

describe('mudletVariables — serialize', () => {
    it('reproduces Mudlet bytes exactly (round-trips the real package)', () => {
        const pkg = parseVariablePackageXml(wrapDoc(REAL_PACKAGE));
        expect(serializeVariablePackage(pkg)).toBe(REAL_PACKAGE);
    });

    it('escapes &/</> in names and values', () => {
        const xml = serializeVariablePackage({
            hidden: [],
            variables: [{ name: 'a&b', keyKind: 'string', valueType: 'string', value: '1 < 2 & 3 > 0' }],
        });
        expect(xml).toContain('<name>a&amp;b</name>');
        expect(xml).toContain('<value>1 &lt; 2 &amp; 3 &gt; 0</value>');
        // and it parses back to the original strings
        const back = parseVariablePackage(
            new DOMParser().parseFromString(wrapDoc(xml), 'text/xml').getElementsByTagName('VariablePackage')[0],
        );
        expect(back.variables[0]).toMatchObject({ name: 'a&b', value: '1 < 2 & 3 > 0' });
    });

    // #360: Mudlet saves a boolean key with keyType 1 and "true"/"false" as its
    // name; reading it as a string key turned [true] into ["true"].
    it('round-trips boolean keys as keyType 1', () => {
        const xml = serializeVariablePackage({
            hidden: [],
            variables: [{ name: 'svNumKey', keyKind: 'string', valueType: 'table', value: '', children: [
                { name: 'false', keyKind: 'boolean', valueType: 'string', value: 'fk' },
                { name: 'true', keyKind: 'boolean', valueType: 'string', value: 'bk' },
            ] }],
        });
        expect(xml).toMatch(/<name>true<\/name>\s*<keyType>1<\/keyType>/);
        expect(xml).toMatch(/<name>false<\/name>\s*<keyType>1<\/keyType>/);
        const kids = parseVariablePackageXml(wrapDoc(xml)).variables[0].children!;
        expect(kids.map(c => [c.name, c.keyKind, c.value])).toEqual([
            ['false', 'boolean', 'fk'],
            ['true', 'boolean', 'bk'],
        ]);
    });

    it('emits populated hidden variables', () => {
        const xml = serializeVariablePackage({ hidden: ['foo', 'bar'], variables: [] });
        expect(xml).toContain('<HiddenVariables>');
        expect(xml).toContain('<name>foo</name>');
        expect(parseVariablePackageXml(wrapDoc(xml)).hidden).toEqual(['foo', 'bar']);
    });
});
