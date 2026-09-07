// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import {
    serializeVariablePackage,
    type MudletVariable,
} from '../../src/import/mudletVariables';

// The `demoVar` global as a parsed variable tree — same data as the real Mudlet
// <VariablePackage> fixture (see tests/import/mudletVariables.test.ts), exercising
// every type, a numeric key, and a nested table. Built inline rather than parsed
// from XML because this suite runs in the node environment (no DOMParser); the
// XML parse path is covered by the happy-dom import test.
const DEMO_TREE: MudletVariable[] = [
    { name: 'demoVar', keyKind: 'string', valueType: 'table', value: '', children: [
        { name: '7', keyKind: 'number', valueType: 'string', value: 'numkey' },
        { name: 'b', keyKind: 'string', valueType: 'boolean', value: 'true' },
        { name: 'f', keyKind: 'string', valueType: 'number', value: '3.5' },
        { name: 'n', keyKind: 'string', valueType: 'number', value: '42' },
        { name: 's', keyKind: 'string', valueType: 'string', value: 'hi' },
        { name: 'sub', keyKind: 'string', valueType: 'table', value: '', children: [
            { name: 'x', keyKind: 'string', valueType: 'number', value: '1' },
            { name: 'y', keyKind: 'string', valueType: 'string', value: 'deep' },
        ] },
    ] },
];

describe('LuaRuntime variable bridge — restore + capture', () => {
    let rt: TestRuntime;
    beforeAll(async () => { rt = await createTestRuntime(); });
    afterAll(() => rt.dispose());

    it('restores scalars, nested tables, and numeric keys into _G', () => {
        rt.rt.restoreVariables(DEMO_TREE);

        expect(rt.run('return demoVar[7]')).toBe('numkey');     // numeric key, not "7"
        expect(rt.run('return demoVar.b')).toBe(true);          // real boolean
        expect(rt.run('return demoVar.f')).toBe(3.5);           // float
        expect(rt.run('return demoVar.n')).toBe(42);            // integer
        expect(rt.run('return demoVar.s')).toBe('hi');
        expect(rt.run('return demoVar.sub.x')).toBe(1);
        expect(rt.run('return demoVar.sub.y')).toBe('deep');
        // string key "7" must NOT exist — the key is numeric
        expect(rt.run('return demoVar["7"]')).toBeNull();
    });

    it('captures the live globals back to a variable tree', () => {
        rt.run('captured = { n = 7, s = "x", t = { inner = true } }');
        const tree = rt.rt.captureVariables(['captured']);

        expect(tree).toHaveLength(1);
        const root = tree[0];
        expect(root).toMatchObject({ name: 'captured', keyKind: 'string', valueType: 'table' });
        const byName = Object.fromEntries(root.children!.map(c => [c.name, c]));
        expect(byName['n']).toMatchObject({ valueType: 'number', value: '7' });
        expect(byName['s']).toMatchObject({ valueType: 'string', value: 'x' });
        expect(byName['t']).toMatchObject({ valueType: 'table' });
        expect(byName['t'].children![0]).toMatchObject({ name: 'inner', valueType: 'boolean', value: 'true' });
    });

    it('skips unset names and non-serializable values', () => {
        rt.run('aFunc = function() end');
        expect(rt.rt.captureVariables(['doesNotExist'])).toEqual([]);
        expect(rt.rt.captureVariables(['aFunc'])).toEqual([]);
    });

    it('lists globals with saveable/builtin flags, previews, and nested children', () => {
        rt.run('myStr = "hello"; myNum = 3; myTab = { a = 1, deep = { z = 9 } }; myFn = function() end');
        const globals = rt.rt.listGlobals();
        const byName = Object.fromEntries(globals.map(g => [g.name, g]));

        // User globals created after boot are not built-ins.
        expect(byName['myStr']).toMatchObject({ valueType: 'string', saveable: true, value: 'hello' });
        expect(byName['myStr'].builtin).toBeFalsy();
        expect(byName['myNum']).toMatchObject({ valueType: 'number', saveable: true, value: '3' });
        expect(byName['myFn']).toMatchObject({ valueType: 'function', saveable: false });

        // User tables are recursed so the view can expand them.
        const tab = byName['myTab'];
        expect(tab).toMatchObject({ valueType: 'table', isTable: true });
        const kids = Object.fromEntries(tab.children!.map(c => [c.name, c]));
        expect(kids['a']).toMatchObject({ value: '1' });
        expect(kids['deep'].children![0]).toMatchObject({ name: 'z', value: '9' });

        // Bundled API names are present but flagged built-in (hidden by default in
        // the UI) and NOT recursed; internal helpers are excluded entirely.
        expect(byName['send']).toMatchObject({ saveable: false, builtin: true });
        expect(byName['send'].children).toBeUndefined();
        expect(globals.some(g => g.name.startsWith('__mudlet'))).toBe(false);
    });

    it('survives a reference cycle without hanging', () => {
        rt.run('cyc = {}; cyc.self = cyc; cyc.v = 5');
        const tree = rt.rt.captureVariables(['cyc']);
        const byName = Object.fromEntries(tree[0].children!.map(c => [c.name, c]));
        expect(byName['v']).toMatchObject({ value: '5' });
        // the back-reference is captured as an empty table (cycle broken)
        expect(byName['self']).toMatchObject({ valueType: 'table' });
        expect(byName['self'].children).toEqual([]);
    });

    it('round-trips tree → _G → capture → XML to the real Mudlet bytes', () => {
        const REAL = [
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
            '\t</VariablePackage>',
        ].join('\n');

        rt.rt.restoreVariables(DEMO_TREE);
        const captured = rt.rt.captureVariables(['demoVar']);
        const out = serializeVariablePackage({ hidden: [], variables: captured });
        expect(out).toBe(REAL);
    });
});
