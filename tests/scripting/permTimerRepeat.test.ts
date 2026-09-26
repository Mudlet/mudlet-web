// @vitest-environment node
//
// permTimer creates a timer that repeats, as every Mudlet perm timer does
// (TTimer has no one-shot mode) — mudlet-web#187 found it firing only once.
//
// Node env + a stubbed LuaRuntime, as timerIsActive.test.ts does. The timer
// body is observed through the TimerEngine callback rather than through Lua.
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

const CONN = 'perm-timer-repeat-conn';

describe('permTimer — repeats like a Mudlet perm timer', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let timerEngine: InstanceType<typeof TimerEngine>;
    const timers = () => useAppStore.getState().connectionTimers[CONN] ?? [];

    beforeEach(() => {
        vi.useFakeTimers();
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'PermTimer', url: 'ws://localhost' }],
            }));
        }
        timerEngine = new TimerEngine();
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), timerEngine, new KeyEngine(), CONN,
        );
    });

    afterEach(() => {
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTimers;
            return { connectionTimers: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        vi.useRealTimers();
    });

    it('stores the new timer as repeating', () => {
        expect(engine.createPermTimer('vT', '', 1, 'vTC = (vTC or 0) + 1')).toBeGreaterThan(0);
        expect(timers().find(t => t.name === 'vT')!.repeat).toBe(true);
    });

    it('fires every interval once enabled, not just once', () => {
        engine.createPermTimer('vT', '', 1, 'vTC = (vTC or 0) + 1');
        const fired = vi.fn();
        const load = () => timerEngine.loadPerm(timers(), fired);
        load();
        // What enableTimer("vT") does: write the switch, reload, apply it.
        expect(engine.toggleTimerByName('vT', true)).toBe(true);
        load();
        timerEngine.applyPermSwitch(timers().filter(t => t.name === 'vT').map(t => t.id), true, timers());
        vi.advanceTimersByTime(5500);
        expect(fired).toHaveBeenCalledTimes(5);
        expect(engine.isActiveByName('vT', 'timer', false)).toBe(1);
    });

    it('can be pumped by waitForEvent and stays armed for its next tick', () => {
        // Mudlet's busted helper waits on a timer by pumping due timers by hand
        // (TimerEngine.pumpDue); a repeating perm timer has to be pumpable.
        engine.createPermTimer('vT', '', 1, 'x = 1');
        const fired = vi.fn();
        const ids = () => timers().filter(t => t.name === 'vT').map(t => t.id);
        engine.toggleTimerByName('vT', true);
        timerEngine.loadPerm(timers(), fired);
        timerEngine.applyPermSwitch(ids(), true, timers());
        expect(timerEngine.pumpDue(Date.now() + 1000)).toBe(1);
        expect(fired).toHaveBeenCalledTimes(1);
        // The pumped tick re-armed a full interval from now; the one it
        // replaced does not also land.
        vi.advanceTimersByTime(999);
        expect(fired).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(fired).toHaveBeenCalledTimes(2);
    });
});
