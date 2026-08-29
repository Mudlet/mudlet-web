// @vitest-environment node
//
// Node env + a mocked Lua runtime, for the same reasons as
// server-media-gate.test.ts: wasmoon can't resolve its WASM under happy-dom,
// and none of the Lua side is needed to pin which events an install raises.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
        }),
    },
}));

// The download and the unpack are the two things this test has no business
// doing for real: one needs the network, the other a mounted profile VFS.
vi.mock('../../src/import/remotePackageInstall', async (orig) => ({
    ...(await orig<typeof import('../../src/import/remotePackageInstall')>()),
    downloadFromUrl: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));
vi.mock('../../src/import/packageInstaller', () => ({
    installPackageFromBytes: vi.fn(() => ({
        // Deliberately unlike the filename in the URL below: an mpackage's
        // config.lua names the package, and the two disagree often enough that
        // which one the event carries is the whole point of the last assertion.
        manifest: { name: 'GameUI', version: '2.0', files: [] },
        data: { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] },
    })),
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    // The output pipeline walks the DOM for OSC 8 visibility timers.
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'server-gui-installed-conn';

type EngineInternals = {
    handleClientGuiInstall: (value: unknown) => Promise<void>;
    vfs: unknown;
    raiseEvent: (event: string, args: unknown[]) => void;
};

// Mudlet raises sysServerGuiInstalled once a game has supplied its own
// interface through Client.GUI (ctelnet.cpp, right after installPackage), so a
// starter UI can step aside. mudix ships mudlet-base-ui by default and it
// listens for exactly this, so without the event both interfaces stay on
// screen at once.
describe('Client.GUI install raises sysServerGuiInstalled', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let raised: Array<{ event: string; args: unknown[] }>;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'GUI', url: 'ws://localhost' }],
            }));
        }
        useAppStore.getState().patchConnectionProfile(CONN, { allowMudPackageInstall: undefined });
        // The store is module-level: without this, the package installed by the
        // previous test is still registered and isClientGuiRedelivery skips the
        // re-install of the same url+version.
        useAppStore.setState(st => ({ connectionPackages: { ...st.connectionPackages, [CONN]: [] } }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        // A VFS stand-in: the install path only flushes it and hands it to the
        // (mocked) unpacker.
        (engine as unknown as EngineInternals).vfs = { flush: async () => {}, exists: () => false };
        raised = [];
        vi.spyOn(engine as unknown as EngineInternals, 'raiseEvent')
            .mockImplementation((event: string, args: unknown[]) => { raised.push({ event, args }); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const install = (value: unknown) =>
        (engine as unknown as EngineInternals).handleClientGuiInstall(value);

    it('raises it after the install events, naming the package', async () => {
        await install({ url: 'https://example.invalid/ui/game-ui.mpackage', version: '2.0' });
        const names = raised.map(r => r.event);
        expect(names).toContain('sysServerGuiInstalled');
        // After sysInstall/sysInstallPackage: a handler that reacts to the
        // game's UI arriving should see the package's own items already loaded.
        expect(names.indexOf('sysServerGuiInstalled'))
            .toBeGreaterThan(names.indexOf('sysInstallPackage'));
    });

    it('carries the manifest name — the one getPackages and sysUninstallPackage use', async () => {
        await install({ url: 'https://example.invalid/ui/game-ui.mpackage', version: '2.0' });
        const evt = raised.find(r => r.event === 'sysServerGuiInstalled');
        // Not 'game-ui', the filename Mudlet would derive: mudix registers the
        // package under its manifest name, and the base UI matches the name it
        // stored against getPackages() to decide when to come back.
        expect(evt?.args).toEqual(['GameUI']);
    });

    it('does not raise it when the profile refuses server package installs', async () => {
        useAppStore.getState().patchConnectionProfile(CONN, { allowMudPackageInstall: false });
        await install({ url: 'https://example.invalid/ui/game-ui.mpackage', version: '2.0' });
        expect(raised.map(r => r.event)).not.toContain('sysServerGuiInstalled');
    });
});
