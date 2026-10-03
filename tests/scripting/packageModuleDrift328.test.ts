// @vitest-environment node
//
// Issue #328: package/module behaviour that drifted from desktop Mudlet.
//
//  1. setPackageInfo fields outlived uninstallPackage and overrode the
//     archive's config.lua on a reinstall.
//  2. getPackageInfo(<module name>) answered with the module's info.
//  3. reloadModule raised sysReadModuleEvent instead of desktop's sync
//     uninstall + install events, and named the unpacked XML rather than the
//     .mpackage the module was installed from.
//  4. reloadModule dropped setModuleInfo fields on a plain-XML module.
//  5. uninstallModule on a sync-enabled module raised sysSyncUninstallModule.
//  6. An archive with two XML files at its root imported only the first.
//  7. getModules() and equal-priority module loading went by install order,
//     not by name.
//  8. Installing a package did not move permanent triggers ahead of temps.
//
// Harness as packageModuleNameCollision.test.ts: a mocked Lua runtime and an
// in-memory VFS, so only the engine's own bookkeeping is under test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
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
g.DOMParser = new Window().DOMParser;

const CONN = 'drift-328-conn';
const PROFILE = '/profiles/test';

const aliasXml = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <AliasPackage>
    <Alias isActive="yes" isFolder="no">
      <name>${name}</name>
      <script>echo("ALIAS from ${name}")</script>
      <command></command>
      <packageName></packageName>
      <regex>^r10two</regex>
    </Alias>
  </AliasPackage>
</MudletPackage>`;

const scriptXml = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <ScriptPackage>
    <Script isActive="yes" isFolder="no">
      <name>${name}</name>
      <packageName></packageName>
      <script>-- ${name}</script>
      <eventHandlerList />
    </Script>
  </ScriptPackage>
</MudletPackage>`;

const triggerXml = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <TriggerPackage>
    <Trigger isActive="yes" isFolder="no" isTempTrigger="no" isMultiline="no" isPerlSlashGOption="no" isColorizerTrigger="no" isFilterTrigger="no" isSoundTrigger="no" isColorTrigger="no" isColorTriggerFg="no" isColorTriggerBg="no">
      <name>${name}</name>
      <script></script>
      <triggerType>0</triggerType>
      <conditonLineDelta>0</conditonLineDelta>
      <mStayOpen>0</mStayOpen>
      <mCommand></mCommand>
      <packageName></packageName>
      <mFgColor>#ff0000</mFgColor>
      <mBgColor>#ffff00</mBgColor>
      <mSoundFile></mSoundFile>
      <colorTriggerFgColor>#000000</colorTriggerFgColor>
      <colorTriggerBgColor>#000000</colorTriggerBgColor>
      <regexCodeList><string>never matches r10un</string></regexCodeList>
      <regexCodePropertyList><integer>0</integer></regexCodePropertyList>
    </Trigger>
  </TriggerPackage>
</MudletPackage>`;

function stubVfs() {
    const files = new Map<string, string | Uint8Array>();
    const dirs = new Set<string>();
    const under = (p: string, q: string) => q === p || q.startsWith(`${p}/`);
    return {
        profilePath: PROFILE,
        exists: (p: string) => dirs.has(p) || files.has(p),
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
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, data); },
        readFile: (p: string) => {
            const v = files.get(p);
            return v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v ?? '');
        },
        readBinaryFile: (p: string) => {
            const v = files.get(p);
            return typeof v === 'string' ? strToU8(v) : v as Uint8Array;
        },
        resolvePath: (p: string) => p,
        flush: async () => {},
    } as unknown as ProfileVFS;
}

describe('package/module parity with desktop (mudlet-web#328)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let triggerEngine: InstanceType<typeof TriggerEngine>;
    let vfs: ProfileVFS;
    let events: Array<[string, unknown[]]>;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(st => ({
            connectionPackages: { ...st.connectionPackages, [CONN]: [] },
            connectionScripts: { ...st.connectionScripts, [CONN]: [] },
            connectionAliases: { ...st.connectionAliases, [CONN]: [] },
            connectionTriggers: { ...st.connectionTriggers, [CONN]: [] },
        }));
        triggerEngine = new TriggerEngine();
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), triggerEngine, new TimerEngine(), new KeyEngine(), CONN,
        );
        vfs = stubVfs();
        (engine as unknown as { vfs: ProfileVFS }).vfs = vfs;
        events = [];
        vi.spyOn(engine, 'raiseEvent').mockImplementation((event: string, args: unknown[] = []) => {
            events.push([event, args]);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    describe('1. setPackageInfo does not outlive uninstallPackage', () => {
        const FILE = `${PROFILE}/r10zfile.mpackage`;
        beforeEach(() => {
            vfs.writeBinaryFile(FILE, zipSync({
                'r10z.xml': strToU8(scriptXml('r10zscript')),
                'config.lua': strToU8('mpackage = [[r10zcfg]]\ntitle = [[Test Title]]\n'),
            }));
        });

        it('clears the fields on uninstall and reinstalls from config.lua', () => {
            expect(engine.installPackageFromVfsPath(FILE).ok).toBe(true);
            engine.setPackageInfo('r10zcfg', 'title', 'New');
            engine.setPackageInfo('r10zcfg', 'custom', 'c');
            expect(engine.getPackageInfo('r10zcfg')).toMatchObject({ title: 'New', custom: 'c' });

            expect(engine.uninstallPackageByName('r10zcfg')).toBe(true);
            expect(engine.getPackageInfo('r10zcfg')).toEqual({});

            expect(engine.installPackageFromVfsPath(FILE).ok).toBe(true);
            const info = engine.getPackageInfo('r10zcfg');
            expect(info.title).toBe('Test Title');
            expect(info.custom).toBeUndefined();
        });
    });

    describe('2. getPackageInfo does not report a module', () => {
        it('answers {} for a module\'s name; getModuleInfo has the fields', () => {
            const FILE = `${PROFILE}/r10mzfile.mpackage`;
            vfs.writeBinaryFile(FILE, zipSync({
                'r10mz.xml': strToU8(scriptXml('r10mzscript')),
                'config.lua': strToU8('mpackage = [[r10mzcfg]]\ntitle = [[Mod Title]]\n'),
            }));
            expect(engine.installModuleFromPath(FILE).ok).toBe(true);

            expect(engine.getPackageInfo('r10mzcfg')).toEqual({});
            expect(engine.getModuleInfoRecord('r10mzcfg')).toMatchObject({ title: 'Mod Title' });
        });
    });

    describe('3. reloadModule raises a sync uninstall and install', () => {
        it('plain XML: sysUninstall, sysSyncUninstallModule, sysInstall, sysSyncInstallModule', () => {
            const FILE = `${PROFILE}/r10m.xml`;
            vfs.writeFile(FILE, scriptXml('r10mscript'));
            expect(engine.installModuleFromPath(FILE).ok).toBe(true);
            events = [];

            expect(engine.reloadModuleFromFile('r10m')).toBe(true);
            expect(events).toEqual([
                ['sysUninstall', ['r10m']],
                ['sysSyncUninstallModule', ['r10m']],
                ['sysInstall', ['r10m']],
                ['sysSyncInstallModule', ['r10m', FILE]],
            ]);
        });

        it('archive: sysSyncInstallModule names the .mpackage, as getModulePath does', () => {
            const FILE = `${PROFILE}/r10mzfile.mpackage`;
            vfs.writeBinaryFile(FILE, zipSync({
                'r10mzcfg.xml': strToU8(scriptXml('r10mzscript')),
                'config.lua': strToU8('mpackage = [[r10mzcfg]]\n'),
            }));
            expect(engine.installModuleFromPath(FILE).ok).toBe(true);
            events = [];

            expect(engine.reloadModuleFromFile('r10mzcfg')).toBe(true);
            expect(engine.getModulePath('r10mzcfg')).toBe(FILE);
            expect(events.at(-1)).toEqual(['sysSyncInstallModule', ['r10mzcfg', FILE]]);
            expect(events.map(e => e[0])).not.toContain('sysReadModuleEvent');
        });
    });

    describe('4. reloadModule keeps setModuleInfo on a plain-XML module', () => {
        it('keeps the field for plain XML', () => {
            const FILE = `${PROFILE}/r10m.xml`;
            vfs.writeFile(FILE, scriptXml('r10mscript'));
            engine.installModuleFromPath(FILE);
            engine.setModuleInfo('r10m', 'k', 'v');

            engine.reloadModuleFromFile('r10m');
            expect(engine.getModuleInfoRecord('r10m')).toEqual({ k: 'v' });
        });

        it('re-reads an archive\'s config.lua, replacing what a script set', () => {
            const FILE = `${PROFILE}/r10mzfile.mpackage`;
            vfs.writeBinaryFile(FILE, zipSync({
                'r10mzcfg.xml': strToU8(scriptXml('r10mzscript')),
                'config.lua': strToU8('mpackage = [[r10mzcfg]]\ntitle = [[Mod Title]]\n'),
            }));
            engine.installModuleFromPath(FILE);
            engine.setModuleInfo('r10mzcfg', 'title', 'Changed');

            engine.reloadModuleFromFile('r10mzcfg');
            expect(engine.getModuleInfoRecord('r10mzcfg')).toMatchObject({ title: 'Mod Title' });
        });
    });

    describe('5. uninstallModule on a sync-enabled module', () => {
        it('raises sysUninstall and sysLuaUninstallModule only', () => {
            const FILE = `${PROFILE}/r10m.xml`;
            vfs.writeFile(FILE, scriptXml('r10mscript'));
            engine.installModuleFromPath(FILE);
            engine.setModuleSync('r10m', true);
            events = [];

            expect(engine.uninstallModuleByName('r10m')).toBe(true);
            expect(events).toEqual([
                ['sysUninstall', ['r10m']],
                ['sysLuaUninstallModule', ['r10m']],
            ]);
        });
    });

    describe('6. an archive with two XML files at its root', () => {
        it('imports both, in name order', () => {
            const FILE = `${PROFILE}/r10two.mpackage`;
            vfs.writeBinaryFile(FILE, zipSync({
                'b.xml': strToU8(aliasXml('b.xml')),
                'a.xml': strToU8(aliasXml('a.xml')),
            }));
            expect(engine.installPackageFromVfsPath(FILE)).toEqual({ ok: true, error: null });

            const aliases = (useAppStore.getState().connectionAliases[CONN] ?? [])
                .filter(a => !a.isGroup).map(a => a.name);
            expect(aliases).toEqual(['a.xml', 'b.xml']);
        });
    });

    describe('7. getModules() order', () => {
        it('lists modules by name in byte order, not install order', () => {
            for (const name of ['r10zz', 'r10aa', 'r10Mm']) {
                const file = `${PROFILE}/${name}.xml`;
                vfs.writeFile(file, scriptXml(`${name}script`));
                expect(engine.installModuleFromPath(file).ok).toBe(true);
            }
            expect(engine.getModuleNames()).toEqual(['r10Mm', 'r10aa', 'r10zz']);
        });
    });

    describe('8. installing a package moves permanent triggers ahead of temps', () => {
        it('calls reorderAfterPackageImport with the post-install trigger tree', () => {
            const spy = vi.spyOn(triggerEngine, 'reorderAfterPackageImport');
            const FILE = `${PROFILE}/r10un.xml`;
            vfs.writeFile(FILE, triggerXml('r10untrigger'));
            expect(engine.installPackageFromVfsPath(FILE).ok).toBe(true);

            expect(spy).toHaveBeenCalledTimes(1);
            const tree = spy.mock.calls[0][0];
            expect(tree.some(t => t.name === 'r10untrigger')).toBe(true);
        });
    });
});
