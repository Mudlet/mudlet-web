// @vitest-environment node
//
// Node env with the Lua runtime mocked away, as in server-media-gate.test.ts:
// what is under test is when the engine raises sysExitEvent, not Lua.
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

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');

// A window that really dispatches, installed after the imports (see
// server-media-gate.test.ts for why).
const target = new EventTarget();
const noopDom = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', hidden: false };
const g = globalThis as Record<string, unknown>;
g.window = {
    innerWidth: 1024, innerHeight: 768,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    matchMedia: () => ({ matches: false, ...noopDom }),
};
g.document = { ...noopDom, querySelectorAll: () => [] };

const transition = (type: string, persisted = false) =>
    target.dispatchEvent(Object.assign(new Event(type), { persisted }));

const CONN = 'exit-on-pagehide-conn';

// #438: Adjustable.Container saves its layout in sysExitEvent. Raised in
// beforeunload, the event came before the "Leave site?" prompt a live
// connection raises, so a player who stayed had already spent their one exit
// event. pagehide is when the page is really going.
describe('sysExitEvent on page unload (#438)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let exits: () => number;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Exit', url: 'ws://localhost' }],
            }));
        }
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        const raise = vi.spyOn(engine, 'raiseEvent');
        exits = () => raise.mock.calls.filter(([name]) => name === 'sysExitEvent').length;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* best-effort */ }
    });

    it('is not raised by beforeunload, which the player can still cancel', () => {
        transition('beforeunload');
        expect(exits()).toBe(0);
    });

    it('is raised once on pagehide', () => {
        transition('pagehide');
        transition('pagehide');
        expect(exits()).toBe(1);
    });

    it('is raised again after the page comes back from the back/forward cache', () => {
        transition('pagehide', true);
        transition('pageshow', true);
        transition('pagehide');
        expect(exits()).toBe(2);
    });

    it('is not raised again by pagehide once the engine has been destroyed', () => {
        engine.destroy();
        const before = exits();
        transition('pagehide');
        expect(exits()).toBe(before);
    });
});
