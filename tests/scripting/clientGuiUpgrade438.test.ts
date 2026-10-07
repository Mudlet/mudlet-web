// @vitest-environment node
//
// Same harness as serverGuiInstalled.test.ts: a mocked Lua runtime, download
// and unpack. What is pinned is the order of what an offer does, against the
// real store and the real uninstall.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {}, setGmcpValue: () => {},
        }),
    },
}));

vi.mock('../../src/import/remotePackageInstall', async (orig) => ({
    ...(await orig<typeof import('../../src/import/remotePackageInstall')>()),
    downloadFromUrl: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));
vi.mock('../../src/import/packageInstaller', async (orig) => ({
    ...(await orig<typeof import('../../src/import/packageInstaller')>()),
    installPackageFromBytes: vi.fn(() => ({
        manifest: { name: 'MedUI', version: '1.0', files: [] },
        data: { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [] },
    })),
    uninstallPackageFiles: vi.fn(async () => {}),
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
const { clientGuiPackageName } = await import('../../src/import/remotePackageInstall');

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'client-gui-upgrade-conn';
const URL = 'https://example.invalid/ui/MedUI.mpackage';

type EngineInternals = {
    handleClientGuiInstall: (value: unknown) => Promise<void>;
    vfs: unknown;
    raiseEvent: (event: string, args: unknown[]) => void;
};

// #438: desktop (cTelnet::handleGUIPackageInstallationAndUpgrade) answers a
// Client.GUI offer of a new version for an installed package by announcing the
// upgrade, uninstalling the old one — its sysUninstall handlers run — and only
// then installing the new one. A package installed by hand counts: it is found
// by the name derived from the URL, and upgraded "from version '-1'".
describe('Client.GUI version upgrade', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let raised: string[];

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'GUI', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(st => ({ connectionPackages: { ...st.connectionPackages, [CONN]: [] } }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        (engine as unknown as EngineInternals).vfs = { flush: async () => {}, exists: () => false };
        raised = [];
        vi.spyOn(engine as unknown as EngineInternals, 'raiseEvent')
            .mockImplementation((event: string, args: unknown[]) => { raised.push(`${event}:${args.join(',')}`); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const offer = (version: string) =>
        (engine as unknown as EngineInternals).handleClientGuiInstall({ url: URL, version });
    const mainText = () => {
        const main = session.consoles.get('main')!;
        return main.getLines(0, main.getLineNumber() + 1).join('\n');
    };
    const packages = () => useAppStore.getState().connectionPackages[CONN] ?? [];

    it('uninstalls the old version before installing the new one', async () => {
        await offer('1');
        raised.length = 0;
        await offer('2');
        expect(mainText()).toContain("Upgrading the GUI to new version '2' from version '1'");
        expect(raised.indexOf('sysUninstallPackage:MedUI')).toBeGreaterThanOrEqual(0);
        expect(raised.indexOf('sysUninstallPackage:MedUI'))
            .toBeLessThan(raised.indexOf('sysInstallPackage:MedUI'));
        expect(packages().map(p => [p.name, p.sourceVersion])).toEqual([['MedUI', '2']]);
    });

    it('does nothing for a re-delivery of the version already installed', async () => {
        await offer('1');
        raised.length = 0;
        await offer('1');
        expect(raised).toEqual([]);
        expect(mainText()).not.toContain('Upgrading the GUI');
    });

    it('upgrades a package the player installed by hand, from version -1', async () => {
        useAppStore.getState().installPackage(CONN, { name: 'MedUI', version: '1.0', installedAt: '' },
            { scripts: [], aliases: [], triggers: [], timers: [], keys: [], buttons: [], warnings: [] });
        await offer('3');
        expect(mainText()).toContain("Upgrading the GUI to new version '3' from version '-1'");
        expect(raised).toContain('sysUninstallPackage:MedUI');
        expect(packages().map(p => [p.name, p.sourceUrl, p.sourceVersion])).toEqual([['MedUI', URL, '3']]);
    });
});

describe('clientGuiPackageName', () => {
    it('derives the name the way desktop does', () => {
        expect(clientGuiPackageName('https://example.invalid/ui/MedUI.mpackage')).toBe('MedUI');
        expect(clientGuiPackageName('https://example.invalid/Game.UI.v2.zip')).toBe('GameUIv2');
        expect(clientGuiPackageName('https://example.invalid/gui.XML')).toBe('gui');
    });
});
