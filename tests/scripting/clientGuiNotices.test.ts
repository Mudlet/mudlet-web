// @vitest-environment node
//
// Same harness as serverGuiInstalled.test.ts. Telnet_spec's Client.GUI specs
// read these notices with getLines(), but can never see the failure one: the
// fetch cannot settle inside a synchronous busted run (see knownDivergences.ts),
// so the buffer side of both notices is pinned here, against the real path.
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

vi.mock('../../src/import/remotePackageInstall', async (orig) => ({
    ...(await orig<typeof import('../../src/import/remotePackageInstall')>()),
    downloadFromUrl: vi.fn(async () => { throw new Error('Failed to fetch'); }),
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
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'client-gui-notices-conn';
const URL = 'http://127.0.0.1:1/not-served/RegressRawGui.mpackage';

type EngineInternals = {
    handleClientGuiInstall: (value: unknown) => Promise<void>;
    vfs: unknown;
};

// Mudlet posts both through cTelnet::postMessage, which writes the main
// console's buffer: a notice the player reads is a line scripts can read too.
describe('Client.GUI notices reach the main console buffer', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;

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
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const mainLines = () => {
        const main = session.consoles.get('main')!;
        return main.getLines(0, main.getLineNumber() + 1).join('\n');
    };

    it('announces the download and then its failure, naming the url', async () => {
        const pending = (engine as unknown as EngineInternals).handleClientGuiInstall(`7704\n${URL}`);
        // Written before the download starts, as Mudlet posts it before get()
        expect(mainLines()).toContain(`Downloading and installing package 'RegressRawGui' (url='${URL}')`);
        await pending;
        expect(mainLines()).toContain(`[ WARN ]  - Package download failed from '${URL}', reason: Failed to fetch`);
    });
});
