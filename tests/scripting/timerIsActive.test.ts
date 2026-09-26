// @vitest-environment node
//
// `isActive(name, "timer")` for an enabled timer inside a disabled TimerGroup.
// Neither client fires it, and desktop answers 0 because a timer's active flag
// is its real running state; Mudlet Web checked only the node's own flag and
// answered 1 (mudlet-web#181). Triggers keep the own-flag answer in both.
//
// Harness as in triggerLinePass.test.ts: node env + a stubbed LuaRuntime.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {}, setCurrentLine: () => {}, getCurrentLine: () => undefined,
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

const base = { code: '', language: 'lua', repeat: true };

describe('isActive for timers', () => {
    let engine: InstanceType<typeof ScriptingEngine>;

    afterEach(() => {
        useAppStore.setState(s => {
            const { [CONN]: _t, ...timers } = s.connectionTimers;
            const { [CONN]: _g, ...triggers } = s.connectionTriggers;
            return { connectionTimers: timers, connectionTriggers: triggers };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('reports a timer inside a disabled folder as inactive, like desktop', () => {
        useAppStore.setState(s => ({
            connections: s.connections.some(c => c.id === CONN)
                ? s.connections
                : [...s.connections, { id: CONN, name: 'Timers', url: 'ws://localhost' }],
            connectionTimers: { ...s.connectionTimers, [CONN]: [
                { ...base, id: 'f', parentId: null, isGroup: true, enabled: false, name: 'Folder', seconds: 0 },
                { ...base, id: 't', parentId: 'f', isGroup: false, enabled: true, name: 'InOffFolder', seconds: 1 },
                { ...base, id: 'u', parentId: null, isGroup: false, enabled: true, name: 'TopLevel', seconds: 1 },
            ] as never },
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [
                { id: 'tg', parentId: null, isGroup: true, enabled: false, name: 'TFolder', code: '', language: 'lua', patterns: [] },
                { id: 'tr', parentId: 'tg', isGroup: false, enabled: true, name: 'InOffTFolder', code: '', language: 'lua', patterns: [] },
            ] as never },
        }));
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );

        expect(engine.isActiveByName('InOffFolder', 'timer', false)).toBe(0);
        expect(engine.isActiveByName('TopLevel', 'timer', false)).toBe(1);
        // Triggers are unchanged: their own flag, unless ancestors are asked for.
        expect(engine.isActiveByName('InOffTFolder', 'trigger', false)).toBe(1);
        expect(engine.isActiveByName('InOffTFolder', 'trigger', true)).toBe(0);
    });
});
