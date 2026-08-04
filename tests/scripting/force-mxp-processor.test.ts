// @vitest-environment node
//
// Node env, not happy-dom, and with the Lua runtime mocked away: the engine
// boots one eagerly in its constructor and none of it is needed here. Same
// rationale (and the same DOM-stub ordering rule) as server-media-gate.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

// Mudlet's `specialForceMXPProcessorOn` (Host::mForceMXPProcessorOn) runs the
// in-band MXP parser on servers that never negotiate telnet option 91, and locks
// it into secure mode because such servers emit secure tags without ever sending
// a mode switch.
//
// The preference is read at CONNECT, not on write — matching Mudlet, whose
// preferences row carries "Please reconnect to your game for the change to take
// effect". That is also what makes it survive a profile load: nothing else
// pushes the persisted value onto the parser, and `mxp.reset()` on connect has
// just cleared the lock it implies.

const CONN = 'force-mxp-conn';

describe('specialForceMXPProcessorOn is applied at connect', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;

    const setBag = (patch: Record<string, unknown>) => {
        const bag = useAppStore.getState().connectionProfile[CONN]?.config ?? {};
        useAppStore.getState().patchConnectionProfile(CONN, { config: { ...bag, ...patch } });
    };

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'ForceMxp', url: 'ws://localhost' }],
            }));
        }
        useAppStore.getState().patchConnectionProfile(CONN, { config: {} });
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
    });

    afterEach(() => {
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('leaves the processor off when the key is unset', () => {
        session.events.emit('client.connect');
        expect(engine.forceMxpProcessorOn).toBe(false);
    });

    it('turns the processor on when the persisted key is true', () => {
        setBag({ specialForceMXPProcessorOn: true });
        session.events.emit('client.connect');
        expect(engine.forceMxpProcessorOn).toBe(true);
    });

    // The Settings checkbox writes the bag directly (no setConfig call), so this
    // is the path that makes that control do anything at all.
    it('picks up a bag write made after construction, on the next connect', () => {
        session.events.emit('client.connect');
        expect(engine.forceMxpProcessorOn).toBe(false);

        setBag({ specialForceMXPProcessorOn: true });
        // Deliberately not live — Mudlet requires the reconnect too.
        expect(engine.forceMxpProcessorOn).toBe(false);

        session.events.emit('client.connect');
        expect(engine.forceMxpProcessorOn).toBe(true);
    });

    it('turns the processor back off once the key is cleared', () => {
        setBag({ specialForceMXPProcessorOn: true });
        session.events.emit('client.connect');
        expect(engine.forceMxpProcessorOn).toBe(true);

        setBag({ specialForceMXPProcessorOn: false });
        session.events.emit('client.connect');
        expect(engine.forceMxpProcessorOn).toBe(false);
    });

    // mxp.reset() on connect clears lockedMode, so re-applying the flag has to
    // happen after it — otherwise the secure lock is silently dropped and every
    // <SEND>/<A>/definition tag starts being discarded as unsafe.
    it('re-locks secure mode after the per-connect MXP reset', () => {
        setBag({ specialForceMXPProcessorOn: true });
        session.events.emit('client.connect');
        const mxp = (engine as unknown as { mxp: { lineMode: string } }).mxp;
        expect(mxp.lineMode).toBe('secure');
    });
});
