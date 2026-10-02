// @vitest-environment node
//
// Issue #284, the engine half:
//
//  1. AliasUnit::processDataStream asks each alias isActive() as it walks the
//     tree, so an alias that disables or enables a later one decides whether
//     that one fires in the same pass. Mudlet Web collected every match first.
//  3. Enter on a miniconsole's own command line (a ConsoleCommandLine) with no
//     action sends the text and then prints it into that miniconsole, as
//     TCommandLine::enterCommand does — Mudlet Web only sent it.
//
// A stubbed LuaRuntime, as in host-send.test.ts: an alias's "code" is a word
// the stub hands to the test, which plays the script's part.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scripts: { run?: (code: string) => void } = {};

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: (code: string) => scripts.run?.(code), destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {}, setTempItemEnabled: () => false,
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
const Pcre2 = (await import('../../src/mud/triggers/pcre/Pcre2')).default;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
// Window drains measure a cell on a canvas; with none there the default is used.
g.document = { ...noopDom, createElement: () => ({ getContext: () => null }) };

const CONN = 'input-pass-parity';

const alias = (name: string, enabled = true) => ({
    id: `id-${name}`, name, isGroup: false, parentId: null, enabled,
    pattern: '^tg$', command: '', code: name, language: 'lua',
});

type Api = {
    createMiniConsole: (name: string, x: number, y: number, w: number, h: number) => boolean;
    getLines: (from: number, to: number, win?: string) => string[] | null;
    getLineCount: (win?: string) => number;
    setCommandForegroundColor: (r: number, g: number, b: number, a?: number, name?: string) => boolean;
};

describe('input pass parity (issue #284)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let aliasEngine: InstanceType<typeof AliasEngine>;
    let wire: string[];

    beforeEach(async () => {
        await Pcre2.init();
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Parity', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({
            connectionAliases: {
                ...s.connectionAliases,
                [CONN]: [alias('t0'), alias('t1'), alias('t2', false), alias('t3')] as never,
            },
        }));
        session = new MudSession();
        aliasEngine = new AliasEngine();
        engine = new ScriptingEngine(session, aliasEngine, new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN);
        wire = [];
        vi.spyOn(session, 'sendData').mockImplementation((text: string) => { wire.push(text); });
        // The store subscription that reloads the alias engine is wired once
        // the output is ready and the (stub) runtime has loaded.
        session.events.emit('output.ready');
        for (let i = 0; i < 200 && aliasEngine.matchAllPerm('tg').length === 0; i++) {
            await new Promise(r => setTimeout(r, 0));
        }
        expect(aliasEngine.matchAllPerm('tg').map(h => h.alias.name)).toEqual(['t0', 't1', 't3']);
    });

    afterEach(() => {
        scripts.run = undefined;
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionAliases;
            return { connectionAliases: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('lets an alias enable or disable a later alias within the same pass', () => {
        const fired: string[] = [];
        scripts.run = (code) => {
            fired.push(code);
            if (code === 't0') {
                engine.toggleAliasByName('t1', false);
                engine.toggleAliasByName('t2', true);
            } else if (code === 't3') {
                engine.toggleAliasByName('t1', true);
                engine.toggleAliasByName('t2', false);
            }
        };
        engine.sendCommand('tg');
        engine.sendCommand('tg');
        // Desktop, both times: t0, t2, t3.
        expect(fired).toEqual(['t0', 't2', 't3', 't0', 't2', 't3']);
        expect(wire).toEqual([]);
    });

    it('does not run an alias created during the pass until the next command', () => {
        const fired: string[] = [];
        scripts.run = (code) => {
            fired.push(code);
            if (code === 't0' && !useAppStore.getState().connectionAliases[CONN].some(a => a.name === 'late')) {
                { const { id: _id, ...late } = alias('late'); useAppStore.getState().addAlias(CONN, late as never); }
            }
        };
        engine.sendCommand('tg');
        expect(fired).toEqual(['t0', 't1', 't3']);
        fired.length = 0;
        engine.sendCommand('tg');
        expect(fired).toEqual(['t0', 't1', 't3', 'late']);
    });

    it('echoes a command typed into a miniconsole command line into that miniconsole', () => {
        const api = (engine as unknown as { api: Api }).api;
        expect(api.createMiniConsole('mc1', 0, 0, 200, 100)).toBe(true);
        expect(session.windows.enableCommandLine('mc1')).toBe(true);
        expect(session.windows.submitCmdLine('mc1', 't2')).toBe(true);
        // Through the aliases first (none match), then the wire.
        expect(wire).toEqual(['t2']);
        expect(api.getLines(0, api.getLineCount('mc1'), 'mc1')).toEqual(['t2']);
    });

    it('prints nothing into the miniconsole when command echo is off, or an action takes the text', () => {
        const api = (engine as unknown as { api: Api }).api;
        api.createMiniConsole('mc2', 0, 0, 200, 100);
        session.windows.enableCommandLine('mc2');
        session.showSentText = 'never';
        session.windows.submitCmdLine('mc2', 'quiet');
        session.showSentText = 'script';
        session.windows.setCmdLineAction('mc2', () => {});
        session.windows.submitCmdLine('mc2', 'taken');
        expect(wire).toEqual(['quiet']);
        expect(api.getLines(0, api.getLineCount('mc2'), 'mc2')).toEqual([]);
    });
});
