// @vitest-environment node
//
// The cases mudlet-web#371 found the #327 and #330 fixes missed, measured
// against the Mudlet PTB. Each row's desktop result is the expectation.
//
//  1. A tempComplexRegexTrigger whose code string does not compile is made
//     but inactive, however it is switched: isActive says 0, enableTrigger
//     leaves it 0, and a matching line is neither run nor highlighted.
//     (tempColorTrigger and tempAnsiColorTrigger are covered with the other
//     temp kinds in luaErrorHandlingParity.test.ts.)
//  2. Temp and permanent items a script body makes while the profile loads
//     fire in creation order, as the same calls made later already did.
//
// Node env + a stubbed LuaRuntime, as tempTriggerAliasDrift327.test.ts does
// it: the "scripts" are closures over the real engine, keyed by item name.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let onRunWithMatches: (name: string, matches: (string | undefined)[]) => void = () => {};

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: (_code: string, name: string, matches: (string | undefined)[]) =>
                onRunWithMatches(name, matches),
            destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {}, setCurrentLine: () => {}, getCurrentLine: () => undefined,
            shiftCaptureSpans: () => {}, tempItemExists: () => false,
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
const { installAutomationBindings } = await import('../../src/scripting/lua/bindings/automation');
type ScriptingAPI = import('../../src/scripting/ScriptingAPI').ScriptingAPI;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'temp-drift-371-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    applyAliasesFromStore: () => void;
    scheduleTriggerApply: () => void;
    api: ScriptingAPI;
};

describe('mudlet-web#371 — temp items parity with desktop', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let internals: EngineInternals;
    let api: ScriptingAPI;
    let aliases: InstanceType<typeof AliasEngine>;
    let triggers: InstanceType<typeof TriggerEngine>;
    let scripts: Record<string, (matches: (string | undefined)[]) => void>;
    let out: string[];
    let unsubscribe: () => void = () => {};

    /** An engine as the profile load leaves it before the scripts run: saved
     *  triggers not compiled yet, and no store subscription — so nothing the
     *  scripts add reaches the engines until {@link finishLoad}. */
    const startLoad = async () => {
        useAppStore.setState(s => ({
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [] },
            connectionAliases: { ...s.connectionAliases, [CONN]: [] },
        }));
        const session = new MudSession();
        aliases = new AliasEngine();
        triggers = new TriggerEngine();
        engine = new ScriptingEngine(session, aliases, triggers, new TimerEngine(), new KeyEngine(), CONN);
        vi.spyOn(session, 'sendData').mockImplementation(() => {});
        await TriggerEngine.ready();
        internals = engine as unknown as EngineInternals;
        internals.triggersReady = false;
        api = internals.api;
    };

    /** What the load does once the scripts have run: aliases applied, PCRE
     *  ready and the triggers compiled, and the store watched from then on. */
    const finishLoad = () => {
        internals.applyAliasesFromStore();
        internals.triggersReady = true;
        internals.applyTriggersFromStore();
        unsubscribe = useAppStore.subscribe((state, prev) => {
            if (state.connectionTriggers[CONN] !== prev.connectionTriggers[CONN]) internals.scheduleTriggerApply();
            if (state.connectionAliases[CONN] !== prev.connectionAliases[CONN]) internals.applyAliasesFromStore();
        });
    };

    const boot = async () => { await startLoad(); finishLoad(); };

    const feed = (text: string) =>
        engine.processFlushBatch([{ text, type: 'mud', fromServer: true }]);

    const lines = (): string[] => api.getLines(0, api.getLineCount()) ?? [];

    /** The characters of line `y` whose foreground is `rgb`, gaps as '.'. */
    const paintedIn = (y: number, rgb: number[]): string => {
        const text = lines()[y];
        let s = '';
        for (let x = 0; x < text.length; x++) {
            api.moveCursor(undefined, x, y);
            api.selectSection(x, 1);
            s += (api.getFgColor() ?? []).slice(0, 3).join() === rgb.join() ? text[x] : '.';
        }
        api.deselect();
        return s;
    };

    /** tempComplexRegexTrigger as Bridge.lua hands it to the engine, with the
     *  flag it sets when the script's code string did not compile. */
    const complex = (name: string, regex: string, uncompiled: boolean) => {
        let fn: ((...a: unknown[]) => number) | undefined;
        const lua = { global: { set: (k: string, v: unknown) => { if (k === '__mudlet_tempComplexTrigger') fn = v as never; } } };
        installAutomationBindings({ lua, api } as never);
        return fn!(name, `regex\x02${regex}`, 'x', false, false, false, 0, 0, 'red', '', uncompiled);
    };

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        out = [];
        onRunWithMatches = (name, matches) => scripts[name]?.(matches);
    });

    afterEach(() => {
        unsubscribe();
        unsubscribe = () => {};
        onRunWithMatches = () => {};
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _t, ...restT } = s.connectionTriggers;
            const { [CONN]: _a, ...restA } = s.connectionAliases;
            return { connectionTriggers: restT, connectionAliases: restA };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    describe('1. a tempComplexRegexTrigger whose code does not compile', () => {
        it('is made but inactive, stays so when enabled, and neither runs nor highlights', async () => {
            await boot();
            const bad = complex('badc', '^HL', true);
            const good = complex('goodc', '^OK', false);
            scripts.badc = () => out.push('bad ran');
            scripts.goodc = () => out.push('good ran');
            expect(bad).toBeGreaterThan(0);
            expect(engine.existsByName(bad, 'trigger')).toBe(1);
            expect(engine.isActiveByName(bad, 'trigger', false)).toBe(0);
            expect(engine.isActiveByName('badc', 'trigger', false)).toBe(0);
            expect(engine.isActiveByName(good, 'trigger', false)).toBe(1);

            engine.toggleTriggerByName('badc', true);
            expect(engine.isActiveByName(bad, 'trigger', false)).toBe(0);

            feed('HL line\nOK line\n');
            expect(out).toEqual(['good ran']);
            expect(paintedIn(0, [255, 0, 0])).toBe('.......');
            expect(paintedIn(1, [255, 0, 0])).toBe('OK.....');
        });

        it('is gone once killed', async () => {
            await boot();
            const bad = complex('badk', '^HL', true);
            expect(api.removeTemporaryTrigger(bad)).toBe(true);
            expect(engine.existsByName(bad, 'trigger')).toBe(0);
        });
    });

    describe('2. items a script makes while the profile loads keep creation order', () => {
        it('a line runs temp A, perm, temp C', async () => {
            await startLoad();
            triggers.addTemp('LD1', () => out.push('temp A'), 'substring');
            engine.createPermSubstringTrigger('ld1p', '', ['LD1'], 'x');
            triggers.addTemp('LD1', () => out.push('temp C'), 'substring');
            scripts.ld1p = () => out.push('perm');
            finishLoad();

            feed('LD1\n');
            expect(out).toEqual(['temp A', 'perm', 'temp C']);
        });

        it('an alias runs temp A, perm, temp C', async () => {
            await startLoad();
            aliases.addTemp('^ld2$', () => out.push('temp A'));
            engine.createPermAlias('ld2p', '', '^ld2$', 'x');
            aliases.addTemp('^ld2$', () => out.push('temp C'));
            scripts.ld2p = () => out.push('perm');
            finishLoad();

            engine.processInput('ld2');
            expect(out).toEqual(['temp A', 'perm', 'temp C']);
        });

        it('a tempComplexRegexTrigger fires ahead of a tempRegexTrigger made after it', async () => {
            await startLoad();
            engine.createTempComplexTrigger({
                name: 'ld3c', patterns: [{ type: 'regex', text: '^LD3' }], code: 'x',
                multiline: false, isFilter: false, multipleMatches: false, fireLength: 0, delta: 0,
            });
            triggers.addTemp('^LD3', () => out.push('regex'), 'regex');
            scripts.ld3c = () => out.push('complex');
            finishLoad();

            feed('LD3\n');
            expect(out).toEqual(['complex', 'regex']);
        });
    });
});
