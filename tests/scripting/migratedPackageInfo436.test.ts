// @vitest-environment node
//
// Issue #436 (item 6): a package that came across in a desktop profile import
// answered getPackageInfo with an empty table. The import put config.lua's
// version/author/title on the manifest's own fields, but getPackageInfo reads
// only `declaredInfo` — so mpkg, which compares versions, saw nothing
// installed. The import half is in tests/import/desktopProfileGaps436.test.ts;
// this checks the answer the engine gives for the registered manifests.
//
// Harness as installPackageRefusal.test.ts: node env and a mocked Lua runtime,
// so only the engine's own bookkeeping is under test.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { strToU8 } from 'fflate';

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
const { buildMudletProfileBundle } = await import('../../src/import/mudletProfileImport');

// Minimal DOM for the engine constructor, installed after the imports (pcre2
// picks node-vs-browser loading at module init).
const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;
const { Window } = await import('happy-dom');
const win = new Window();
g.DOMParser = win.DOMParser;
g.XMLSerializer = win.XMLSerializer;

const CONN = 'migrated-436-conn';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001"><HostPackage><Host><name>P</name>
  <mInstalledPackages><string>mpkg</string><string>echo</string></mInstalledPackages>
</Host></HostPackage></MudletPackage>`;

describe('getPackageInfo for a package migrated from desktop (mudlet-web#436)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;

    beforeAll(() => {
        const bundle = buildMudletProfileBundle({
            'P/current/2026-06-26#10-00-00.xml': strToU8(XML),
            'P/mpkg/config.lua': strToU8('mpackage = [[mpkg]]\nversion = "2.3.1"\nauthor = "demonnic"\ntitle = "Package Manager"\n'),
        });
        // As bundleToConnectionData registers them, install time stamped.
        const packages = bundle.packages.map(p => ({ ...p, installedAt: '2026-06-26T12:00:00.000Z' }));
        useAppStore.setState(s => ({
            connections: [...s.connections, { id: CONN, name: 'P', url: 'ws://localhost' }],
            connectionPackages: { ...s.connectionPackages, [CONN]: packages },
        }));
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
    });

    afterAll(() => {
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('answers with what its config.lua declared', () => {
        expect(engine.getPackageInfo('mpkg')).toEqual({
            mpackage: 'mpkg', version: '2.3.1', author: 'demonnic', title: 'Package Manager',
        });
    });

    it('answers with nothing for one that shipped no config.lua, as desktop does', () => {
        expect(engine.getPackageInfo('echo')).toEqual({});
    });
});
