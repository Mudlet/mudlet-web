// @vitest-environment node
//
// Node env with the Lua runtime mocked away — the engine boots one eagerly in
// its constructor and only its emitEvent hook matters here. Same DOM-stub
// ordering rule as force-mxp-processor.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** What getConnectionInfo() reported while each system event was dispatched. */
const observed: Array<{ event: string; connected: boolean }> = [];
/** Set once the engine exists — the mock is hoisted above its construction. */
let probeConnected: (() => boolean) | null = null;

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            emitEvent: (event: string) => {
                if (probeConnected) observed.push({ event, connected: probeConnected() });
            },
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

class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    protocol = '';
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string, public requestedProtocols?: string | string[]) {
        MockWebSocket.instances.push(this);
    }
    send() {}
    close() { this.readyState = MockWebSocket.CLOSED; }
}

const CONN = 'connection-event-status-conn';

// Mudlet raises sysConnectionEvent from cTelnet::slot_socketConnected() and
// sysDisconnectionEvent from slot_socketDisconnected(), and getConnectionInfo()
// reads the live QAbstractSocket state — so a Lua handler always sees the state
// the event announces. mudix has to reproduce that through an EventBus, whose
// listeners fire in registration order: the session's own status latch must be
// registered before the scripting engine's bridge, or every handler observes the
// *previous* state (f2ce-tools' F2T_CONNECTED cache stuck at false forever).
describe('getConnectionInfo() inside sys(Dis)ConnectionEvent handlers', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let realWebSocket: unknown;

    beforeEach(async () => {
        realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
        (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        observed.length = 0;
        probeConnected = null;

        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'ConnStatus', url: 'ws://localhost' }],
            }));
        }
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        const internals = engine as unknown as {
            runtimeReady: Promise<unknown>;
            api: { getConnectionInfo(): { connected: boolean } };
        };
        await internals.runtimeReady;
        // The exact call the Lua `getConnectionInfo()` global lands on.
        probeConnected = () => internals.api.getConnectionInfo().connected;
    });

    afterEach(() => {
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
        probeConnected = null;
    });

    const seen = (event: string) => observed.filter(e => e.event === event);

    it('reports connected=true throughout sysConnectionEvent', () => {
        session.connect('ws://test.invalid');
        MockWebSocket.instances[0].onopen?.({});

        expect(seen('sysConnectionEvent')).toEqual([{ event: 'sysConnectionEvent', connected: true }]);
        expect(session.status).toBe('connected');
    });

    it('reports connected=false throughout sysDisconnectionEvent', () => {
        session.connect('ws://test.invalid');
        MockWebSocket.instances[0].onopen?.({});
        observed.length = 0;
        MockWebSocket.instances[0].onclose?.({ code: 1000, reason: '', wasClean: true });

        expect(seen('sysDisconnectionEvent')).toEqual([{ event: 'sysDisconnectionEvent', connected: false }]);
        expect(session.status).toBe('disconnected');
    });

    // The client-initiated close is a separate emit path in MudClient (the
    // socket handlers are nulled and the disconnect synthesized), so it needs
    // its own coverage — a script calling disconnect() must see the same thing.
    it('reports connected=false when the close is client-initiated', () => {
        session.connect('ws://test.invalid');
        MockWebSocket.instances[0].onopen?.({});
        observed.length = 0;
        session.disconnect();

        expect(seen('sysDisconnectionEvent')).toEqual([{ event: 'sysDisconnectionEvent', connected: false }]);
        expect(session.status).toBe('disconnected');
    });

    // Reconnecting tears the old client down first; the disconnect that
    // synthesizes must not report the *new* dial as still-connected.
    it('reports connected=false on the teardown that precedes a redial', () => {
        session.connect('ws://test.invalid');
        MockWebSocket.instances[0].onopen?.({});
        observed.length = 0;
        session.connect('ws://test.invalid');

        expect(seen('sysDisconnectionEvent')).toEqual([{ event: 'sysDisconnectionEvent', connected: false }]);
        expect(session.status).toBe('connecting');
    });
});
