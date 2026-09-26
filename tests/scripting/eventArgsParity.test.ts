// @vitest-environment node
//
// Mudlet 5.0 parity for the arguments the engine raises its own events with
// (issue #172). The Lua runtime is mocked to a recorder: what matters here is
// exactly what ScriptingEngine hands emitEvent, which Bridge.lua's dispatcher
// then passes to handlers after the event name. Same DOM-stub ordering rule as
// force-mxp-processor.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const emitted: Array<{ event: string; args: unknown[] }> = [];

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, processInput: () => false,
            emitEvent: (event: string, args: unknown[]) => { emitted.push({ event, args }); },
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            setGmcpValue: () => {}, setMsdpValue: () => {}, setMsspValue: () => {},
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

const CONN = 'event-args-parity-conn';

describe('engine-raised event arguments match Mudlet', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;

    const eventsNamed = (prefix: string) => emitted.filter(e => e.event.startsWith(prefix));

    beforeEach(async () => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'EventArgs', url: 'ws://localhost' }],
            }));
        }
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        // The engine adopts the (mocked) runtime once create() resolves.
        await new Promise(r => setTimeout(r, 0));
        emitted.length = 0;
    });

    afterEach(() => {
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('gmcp.* events carry only the full key after the event name', () => {
        session.events.emit('gmcp', { path: 'Char.Vitals', value: { hp: 5 } });
        expect(eventsNamed('gmcp.')).toEqual([
            { event: 'gmcp.Char', args: ['gmcp.Char.Vitals'] },
            { event: 'gmcp.Char.Vitals', args: ['gmcp.Char.Vitals'] },
        ]);
    });

    it('msdp.* and mssp.* events carry the key once', () => {
        session.events.emit('msdp', { path: 'HEALTH', value: '10' });
        session.events.emit('mssp', { name: 'PLAYERS', value: '3' });
        expect(eventsNamed('msdp.')).toEqual([{ event: 'msdp.HEALTH', args: ['msdp.HEALTH'] }]);
        expect(eventsNamed('mssp.')).toEqual([{ event: 'mssp.PLAYERS', args: ['mssp.PLAYERS'] }]);
    });

    it('a disconnect raises sysDisconnectionEvent and no sysProtocolDisabled', () => {
        session.events.emit('protocol.enabled', 'GMCP');
        emitted.length = 0;
        session.events.emit('client.disconnect');
        expect(emitted.map(e => e.event)).toContain('sysDisconnectionEvent');
        expect(eventsNamed('sysProtocolDisabled')).toEqual([]);
    });

    it('resetProfile raises sysLoadEvent with false', async () => {
        engine.resetProfile();
        await vi.waitFor(() => expect(eventsNamed('sysLoadEvent')).toHaveLength(1));
        expect(eventsNamed('sysLoadEvent')).toEqual([{ event: 'sysLoadEvent', args: [false] }]);
    });
});
