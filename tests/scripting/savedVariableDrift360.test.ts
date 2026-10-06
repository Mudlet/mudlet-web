// @vitest-environment node
//
// Issue #360: saved variables that drifted from desktop Mudlet.
//
//  1. A package's or module's <VariablePackage> globals went into _G but not
//     onto the save-list, so they — and any later change to them — were gone
//     after a restart. Desktop's XMLimport::readVariable saves them like the
//     profile's own.
//  2. saveProfile() wrote the values captured at the last debounced profile
//     flush, not the live _G, and left profile.json behind too — so a crash
//     after the save reopened with the older values.
//  (3. boolean keys — the Lua side — are in variableBridge.test.ts and the
//      XML side in mudletVariables.test.ts.)
//
// Harness as packageModuleDrift328.test.ts: an in-memory VFS and a mocked
// Lua runtime, whose `_G` here is a map of variable trees by name — enough to
// see what the engine restores, captures and writes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MudletVariable } from '../../src/import/mudletVariables';

const fakeG = new Map<string, MudletVariable>();

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            restoreVariables: (vars: MudletVariable[]) => { for (const v of vars) fakeG.set(v.name, v); },
            captureVariables: (names: string[]) => names.flatMap(n => (fakeG.has(n) ? [fakeG.get(n)!] : [])),
        }),
    },
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
const { PROFILE_DATA_PATH } = await import('../../src/storage/profileVfsData');
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;
const { Window } = await import('happy-dom');
const domWindow = new Window();
g.DOMParser = domWindow.DOMParser;
g.XMLSerializer = domWindow.XMLSerializer;

const CONN = 'drift-360-conn';
const PROFILE = '/profiles/test';

const varsXml = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <VariablePackage>
    <HiddenVariables />
    <Variable>
      <name>pkgVar</name>
      <keyType>4</keyType>
      <value>7</value>
      <valueType>3</valueType>
    </Variable>
    <VariableGroup>
      <name>pkgTab</name>
      <keyType>4</keyType>
      <value></value>
      <valueType>5</valueType>
      <Variable>
        <name>k</name>
        <keyType>4</keyType>
        <value>v</value>
        <valueType>4</valueType>
      </Variable>
    </VariableGroup>
  </VariablePackage>
</MudletPackage>`;

function stubVfs() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const under = (p: string, q: string) => q === p || q.startsWith(`${p}/`);
    const vfs = {
        profilePath: PROFILE,
        exists: (p: string) => dirs.has(p) || files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)),
        mkdir: (p: string) => { dirs.add(p.replace(/\/$/, '')); },
        rmdir: (p: string) => {
            for (const d of [...dirs]) if (under(p, d)) dirs.delete(d);
            for (const f of [...files.keys()]) if (under(p, f)) files.delete(f);
        },
        rename: (from: string, to: string) => {
            for (const d of [...dirs]) if (under(from, d)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
            for (const f of [...files.keys()]) if (under(from, f)) { files.set(to + f.slice(from.length), files.get(f)!); files.delete(f); }
        },
        writeFile: (p: string, data: string) => { files.set(p, data); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, new TextDecoder().decode(data)); },
        readBinaryFile: (p: string) => new TextEncoder().encode(files.get(p) ?? ''),
        readFile: (p: string) => {
            const v = files.get(p);
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return v;
        },
        readdir: (p: string) => [...files.keys()]
            .filter(k => k.startsWith(`${p}/`))
            .map(k => k.slice(p.length + 1)),
        stat: () => ({ mtime: new Date(0) }),
        resolvePath: (p: string) => (p.startsWith('/') ? p : `${PROFILE}/${p}`),
        flush: async () => {},
    };
    return { vfs: vfs as unknown as ProfileVFS, files };
}

const num = (name: string, value: string): MudletVariable => ({ name, keyKind: 'string', valueType: 'number', value });

describe('saved variables match desktop (mudlet-web#360)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let vfs: ProfileVFS;
    let files: Map<string, string>;

    const saved = () => useAppStore.getState().connectionVariables[CONN];
    const profileJsonVars = () => JSON.parse(files.get(PROFILE_DATA_PATH) ?? '{}').variables;

    beforeEach(async () => {
        fakeG.clear();
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
            }));
        }
        useAppStore.getState().hydrateConnectionData(CONN, {});
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        await (engine as unknown as { runtimeReady: Promise<unknown> }).runtimeReady;
        ({ vfs, files } = stubVfs());
        (engine as unknown as { vfs: ProfileVFS }).vfs = vfs;
        vi.spyOn(engine, 'raiseEvent').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    describe('1. package and module variables are saved', () => {
        it('installPackage puts the package\'s variables on the save-list', () => {
            vfs.writeFile(`${PROFILE}/pkgvars.xml`, varsXml);
            expect(engine.installPackageFromVfsPath(`${PROFILE}/pkgvars.xml`)).toEqual({ ok: true, error: null });

            expect(fakeG.get('pkgVar')?.value).toBe('7');
            expect(saved()?.saveList).toEqual(['pkgVar', 'pkgTab']);

            // A later change is what the next save captures.
            fakeG.set('pkgVar', num('pkgVar', '8'));
            expect(engine.saveProfileXml().ok).toBe(true);
            const vars = profileJsonVars();
            expect(vars.saveList).toEqual(['pkgVar', 'pkgTab']);
            const byName = Object.fromEntries((vars.values as MudletVariable[]).map(v => [v.name, v]));
            expect(byName.pkgVar).toMatchObject({ valueType: 'number', value: '8' });
            expect(byName.pkgTab.children).toEqual([{ name: 'k', keyKind: 'string', valueType: 'string', value: 'v' }]);
        });

        it('installModule does the same', () => {
            vfs.writeFile(`${PROFILE}/modvars.xml`, varsXml);
            expect(engine.installModuleFromPath(`${PROFILE}/modvars.xml`).ok).toBe(true);
            expect(saved()?.saveList).toEqual(['pkgVar', 'pkgTab']);
        });

        it('keeps names already saved and does not list them twice', () => {
            useAppStore.getState().setVariableSaveList(CONN, ['mine', 'pkgVar']);
            vfs.writeFile(`${PROFILE}/pkgvars.xml`, varsXml);
            expect(engine.installPackageFromVfsPath(`${PROFILE}/pkgvars.xml`).ok).toBe(true);
            expect(saved()?.saveList).toEqual(['mine', 'pkgVar', 'pkgTab']);
        });

        it('a refused reinstall adds nothing to the save-list', () => {
            vfs.writeFile(`${PROFILE}/pkgvars.xml`, varsXml);
            expect(engine.installPackageFromVfsPath(`${PROFILE}/pkgvars.xml`).ok).toBe(true);
            useAppStore.getState().setVariableSaveList(CONN, []);
            expect(engine.installPackageFromVfsPath(`${PROFILE}/pkgvars.xml`).ok).toBe(false);
            expect(saved()?.saveList).toEqual([]);
        });

        it('loadPackageVariables (the Package Manager path) restores and saves them', () => {
            engine.loadPackageVariables({ variables: [num('uiVar', '3')] } as Parameters<typeof engine.loadPackageVariables>[0]);
            expect(fakeG.get('uiVar')?.value).toBe('3');
            expect(saved()?.saveList).toEqual(['uiVar']);
        });
    });

    describe('2. saveProfile writes the live values', () => {
        beforeEach(() => {
            useAppStore.getState().hydrateConnectionData(CONN, {
                variables: { saveList: ['svNum'], values: [num('svNum', '42')] },
            });
            fakeG.set('svNum', num('svNum', '43'));
        });

        it('into the XML save', () => {
            const res = engine.saveProfileXml();
            expect(res.ok).toBe(true);
            const xml = files.get([...files.keys()].find(k => k.startsWith('current/'))!)!;
            expect(xml).toMatch(/<name>svNum<\/name>\s*<keyType>4<\/keyType>\s*<value>43<\/value>/);
            expect(xml).not.toContain('<value>42</value>');
        });

        it('into profile.json, so a reopen after a crash sees them', () => {
            expect(engine.saveProfileXml().ok).toBe(true);
            expect(profileJsonVars().values).toEqual([num('svNum', '43')]);
        });
    });
});
