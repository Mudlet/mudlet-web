// @vitest-environment node
//
// isActive(name, "timer") reports the timer engine's runtime active flag, not
// the stored switch (mudlet-web#217). The engine-level transitions are pinned in
// tests/mud/timers/timerActiveState.test.ts; this covers the wiring through
// ScriptingEngine: isActiveByName, toggleTimerByName (enableTimer/disableTimer),
// isAncestorsActiveById and getProfileStats.
//
// Node env + a stubbed LuaRuntime, as host-send.test.ts does: nothing on the Lua
// side is needed to observe the host methods the Lua bindings call.
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

const CONN = 'timer-is-active-conn';

type EngineInternals = { applyTimersFromStore: () => void };

const node = (over: Record<string, unknown>) => ({
    isGroup: false, parentId: null, enabled: true, seconds: 1, code: 'x',
    language: 'lua', repeat: true, ...over,
});

/** The package from mudlet-web#217: an enabled timer in a disabled TimerGroup. */
const FOLDER = node({ id: 'f', name: 'Folder', isGroup: true, enabled: false, seconds: 0, code: '' });
const CHILD = node({ id: 't', name: 'InOffFolder', parentId: 'f' });
const ROOT = node({ id: 'r', name: 'Root' });

describe('isActive(name, "timer") — runtime active state', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    const reload = () => (engine as unknown as EngineInternals).applyTimersFromStore();
    const timers = () => useAppStore.getState().connectionTimers[CONN] ?? [];

    beforeEach(() => {
        vi.useFakeTimers();
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Timers', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({
            connectionTimers: { ...s.connectionTimers, [CONN]: [FOLDER, CHILD, ROOT] as never },
        }));
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        reload();
    });

    afterEach(() => {
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTimers;
            return { connectionTimers: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        vi.useRealTimers();
    });

    it('reports an enabled timer imported under a disabled TimerGroup as inactive', () => {
        expect(engine.isActiveByName('InOffFolder', 'timer', false)).toBe(0);
        expect(engine.isActiveByName('InOffFolder', 'timer', true)).toBe(0);
        expect(engine.isActiveByName('Root', 'timer', false)).toBe(1);
    });

    it('reports it active after an explicit enableTimer, but not with ancestors checked', () => {
        expect(engine.toggleTimerByName('InOffFolder', true)).toBe(true);
        reload();
        expect(engine.isActiveByName('InOffFolder', 'timer', false)).toBe(1);
        expect(engine.isActiveByName('InOffFolder', 'timer', true)).toBe(0);
        // By numeric id too.
        const numeric = engine.numericIdFor('t');
        expect(engine.isActiveByName(numeric, 'timer', false)).toBe(1);
        expect(engine.isAncestorsActiveById(numeric, 'timer')).toBe(false);
    });

    it('enabling the group activates the timer and leaves only the group\'s switch written', () => {
        engine.toggleTimerByName('Folder', true);
        reload();
        expect(engine.isActiveByName('InOffFolder', 'timer', true)).toBe(1);
        expect(engine.isAncestorsActiveById(engine.numericIdFor('t'), 'timer')).toBe(true);
        engine.toggleTimerByName('Folder', false);
        reload();
        expect(engine.isActiveByName('InOffFolder', 'timer', false)).toBe(0);
        // The child's own switch is untouched by its folder's toggles.
        expect(timers().find(t => t.id === 't')!.enabled).toBe(true);
    });

    it('counts timers in getProfileStats by the same state', () => {
        const stats = () => (engine.getProfileStats() as { timers: { active: number } }).timers.active;
        expect(stats()).toBe(1);
        engine.toggleTimerByName('InOffFolder', true);
        reload();
        expect(stats()).toBe(2);
    });
});
