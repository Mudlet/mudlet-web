// @vitest-environment node
//
// Mudlet/mudlet-web#365, item 1: the engine used to pass its own `connect`,
// `disconnect` and `output(line, type)` events into Lua's dispatch, so a "*"
// catch-all handler (or one registered for those names) saw events desktop
// never raises. Desktop raises only the sys* names. The Lua runtime is mocked
// away, as in connectionEventStatus.test.ts — only emitEvent matters here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const observed: string[] = [];

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            setCurrentLine: () => {},
            emitEvent: (event: string) => { observed.push(event); },
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

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
    }
    send() {}
    close() { this.readyState = MockWebSocket.CLOSED; }
}

const CONN = 'lua-api-drift-365-conn';

describe('only sys* connection events reach Lua (#365)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let realWebSocket: unknown;

    beforeEach(async () => {
        realWebSocket = g.WebSocket;
        g.WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift365', url: 'ws://localhost' }],
            }));
        }
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        await (engine as unknown as { runtimeReady: Promise<unknown> }).runtimeReady;
        observed.length = 0;
    });

    afterEach(() => {
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        g.WebSocket = realWebSocket;
    });

    const watched = () => observed.filter(e => ['connect', 'disconnect', 'output',
        'sysConnectionEvent', 'sysDisconnectionEvent'].includes(e));

    const open = () => {
        session.connect('ws://test.invalid');
        const sock = MockWebSocket.instances[0];
        sock.onopen?.({});
        return sock;
    };

    it('raises sysConnectionEvent alone on connect', () => {
        open();
        expect(watched()).toEqual(['sysConnectionEvent']);
    });

    it('raises nothing for a server line', () => {
        open();
        observed.length = 0;
        session.events.emit('flushLines', [{ text: 'hello world\n', type: 'mud' }]);
        expect(watched()).toEqual([]);
    });

    it('raises sysDisconnectionEvent alone on disconnect', () => {
        const sock = open();
        observed.length = 0;
        sock.onclose?.({ code: 1000, reason: '', wasClean: true });
        expect(watched()).toEqual(['sysDisconnectionEvent']);
    });
});
