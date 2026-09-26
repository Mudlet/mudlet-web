// @vitest-environment node
//
// A perm* item created inside a module's group joins that module, so
// enableModuleSync writes it back to the module file as Mudlet does
// (mudlet-web#187). Nodes of an installed module all carry its packageName, and
// that tag is what syncModuleToFile selects on.
//
// Node env + a stubbed LuaRuntime, as timerIsActive.test.ts does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {}, tempItemExists: () => false,
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

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'perm-in-module-conn';
const MOD = 'vModule';

const group = (id: string, name: string, packageName?: string) => ({
    id, name, parentId: null, isGroup: true, enabled: true, packageName,
});

describe('perm* items created under a module group', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    const state = () => useAppStore.getState();

    beforeEach(() => {
        if (!state().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Module', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({
            connectionAliases: { ...s.connectionAliases, [CONN]: [
                { ...group('ma', 'ModAliases', MOD), pattern: '', command: '', code: '', language: 'lua' },
                { ...group('pa', 'ProfileAliases'), pattern: '', command: '', code: '', language: 'lua' },
            ] as never },
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [
                { ...group('mt', 'ModTriggers', MOD), patterns: [], code: '', language: 'lua' },
            ] as never },
            connectionTimers: { ...s.connectionTimers, [CONN]: [
                { ...group('mm', 'ModTimers', MOD), seconds: 0, code: '', language: 'lua', repeat: true },
            ] as never },
            connectionKeybindings: { ...s.connectionKeybindings, [CONN]: [
                { ...group('mk', 'ModKeys', MOD), key: '', modifiers: [], code: '', language: 'lua' },
            ] as never },
            connectionScripts: { ...s.connectionScripts, [CONN]: [
                { ...group('ms', 'ModScripts', MOD), code: '', language: 'lua', eventHandlers: [] },
            ] as never },
        }));
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
    });

    afterEach(() => {
        useAppStore.setState(s => {
            const drop = <T,>(m: Record<string, T>) => { const { [CONN]: _d, ...rest } = m; return rest; };
            return {
                connectionAliases: drop(s.connectionAliases),
                connectionTriggers: drop(s.connectionTriggers),
                connectionTimers: drop(s.connectionTimers),
                connectionKeybindings: drop(s.connectionKeybindings),
                connectionScripts: drop(s.connectionScripts),
            };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const byName = <T extends { name: string }>(list: T[] | undefined, name: string) =>
        (list ?? []).find(n => n.name === name) as (T & { packageName?: string }) | undefined;

    it('tags each kind with the module it was created in', () => {
        expect(engine.createPermAlias('vA', 'ModAliases', '^va$', 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermRegexTrigger('vTr', 'ModTriggers', ['^vt$'], 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermTimer('vTi', 'ModTimers', 5, 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermKey('vK', 'ModKeys', 0, 65, 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermScript('vS', 'ModScripts', 'x = 1')).toBeGreaterThan(0);
        expect(byName(state().connectionAliases[CONN], 'vA')?.packageName).toBe(MOD);
        expect(byName(state().connectionTriggers[CONN], 'vTr')?.packageName).toBe(MOD);
        expect(byName(state().connectionTimers[CONN], 'vTi')?.packageName).toBe(MOD);
        expect(byName(state().connectionKeybindings[CONN], 'vK')?.packageName).toBe(MOD);
        expect(byName(state().connectionScripts[CONN], 'vS')?.packageName).toBe(MOD);
    });

    it('leaves items under a profile group, or at the root, untagged', () => {
        engine.createPermAlias('vP', 'ProfileAliases', '^vp$', 'x = 1');
        engine.createPermAlias('vR', '', '^vr$', 'x = 1');
        const aliases = state().connectionAliases[CONN];
        expect(byName(aliases, 'vP')).toBeDefined();
        expect(byName(aliases, 'vP')).not.toHaveProperty('packageName');
        expect(byName(aliases, 'vR')).not.toHaveProperty('packageName');
    });
});
