// @vitest-environment node
//
// Connection behaviour measured against Mudlet PTB (mudlet-web#339), driven end
// to end through a mock WebSocket → MudClient → ScriptingEngine, with a `^(.*)$`
// regex trigger recording every line and the Lua runtime's emitEvent recording
// the system events (and what a handler would read at that moment).
//
// 1. Text without a newline still pending when the connection closes is shown
//    and matched, just after sysDisconnectionEvent — for a server close and for
//    disconnect() alike.
// 2. getConnectionInfo() reports the server connectToServer() pointed the
//    profile at, saved or not, through failures and reconnect().
// 3. disconnect() with output still unwritten raises sysDisconnectionEvent
//    after the calling script has returned; with none, before it returns.
// 4. The connection notices are console lines getLineCount()/getLines() see.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let onRunWithMatches: (name: string, matches: (string | undefined)[]) => void = () => {};
let onEmitEvent: (event: string) => void = () => {};

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, processInput: () => false,
            emitEvent: (event: string) => onEmitEvent(event),
            runWithMatches: (_code: string, name: string, matches: (string | undefined)[]) =>
                onRunWithMatches(name, matches),
            destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {},
            setCurrentLine: () => {},
            getCurrentLine: () => undefined,
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
g.window = {
    innerWidth: 1024, innerHeight: 768, ...noopDom,
    matchMedia: () => ({ matches: false, ...noopDom }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
};
g.document = noopDom;

/** A socket whose `bufferedAmount` behaves like a browser's: send() queues the
 *  bytes at once, and they leave on a later turn of the event loop. */
class MockWebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    protocol = '';
    bufferedAmount = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send(bytes: Uint8Array) {
        this.bufferedAmount += bytes.length;
        setTimeout(() => { this.bufferedAmount = 0; }, 0);
    }
    close() { this.readyState = MockWebSocket.CLOSED; }

    deliver(text: string) {
        this.onmessage?.({ data: new TextEncoder().encode(text).buffer as ArrayBuffer });
    }
}

const CONN = 'connection-drift-339-conn';
const PROFILE_URL = 'ws://profile.invalid:4000';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    markScriptsLoaded: () => void;
    api: {
        getConnectionInfo(): { host: string; port: number; connected: boolean };
        connectToServer(host: string, port?: number, save?: boolean): boolean;
    };
};

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('connection drift vs. Mudlet PTB (mudlet-web#339)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let internals: EngineInternals;
    /** `TRIG [line]` per trigger fire and `DISC`/`CONN` per system event. */
    let log: string[];
    let realWebSocket: unknown;

    const boot = async () => {
        useAppStore.setState(s => ({
            connectionTriggers: {
                ...s.connectionTriggers,
                [CONN]: [{
                    id: 'all', name: 'all', isGroup: false, parentId: null, enabled: true,
                    code: 'x', language: 'lua', fireLength: 0, multipleMatches: false,
                    multiline: false, delta: 0, isFilter: false,
                    patterns: [{ type: 'regex', text: '^(.*)$' }],
                }] as never,
            },
        }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        await TriggerEngine.ready();
        internals = engine as unknown as EngineInternals;
        internals.triggersReady = true;
        internals.applyTriggersFromStore();
    };

    const main = () => session.consoles.get('main')!;
    const bufferLines = () => main().getLines(0, main().getLineCount() + 1).map(plain).filter(l => l !== '');
    const sock = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const dial = (url = PROFILE_URL) => {
        session.connect(url);
        sock().onopen?.({});
        return sock();
    };

    beforeEach(() => {
        realWebSocket = g.WebSocket;
        g.WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift', url: PROFILE_URL }],
            }));
        }
        log = [];
        onRunWithMatches = (_name, matches) => log.push(`TRIG [${(matches[0] ?? '').replace(/\n$/, '')}]`);
        onEmitEvent = (event) => {
            if (event === 'sysDisconnectionEvent') log.push('DISC');
            if (event === 'sysConnectionEvent') log.push('CONN');
        };
    });

    afterEach(() => {
        onRunWithMatches = () => {};
        onEmitEvent = () => {};
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTriggers;
            return { connectionTriggers: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        g.WebSocket = realWebSocket;
        vi.useRealTimers();
    });

    describe('1. a partial line pending at close', () => {
        it('is shown and matched just after sysDisconnectionEvent when the server closes', async () => {
            await boot();
            const s = dial();
            log = [];
            s.deliver('Hello 1\r\n');
            s.deliver('Server full, bye');
            s.onclose?.({ code: 1000, reason: '', wasClean: true });

            // Desktop: TRIG [Hello 1], DISC, TRIG [Server full, bye]
            expect(log).toEqual(['TRIG [Hello 1]', 'DISC', 'TRIG [Server full, bye]']);
            const lines = bufferLines();
            expect(lines).toContain('Server full, bye');
            expect(lines.indexOf('Server full, bye')).toBeGreaterThan(lines.indexOf('Hello 1'));
        });

        it('is shown and matched just after sysDisconnectionEvent on disconnect()', async () => {
            await boot();
            const s = dial();
            log = [];
            s.deliver('Hello 1\r\n');
            s.deliver('Half a line');
            session.disconnect();

            expect(log).toEqual(['TRIG [Hello 1]', 'DISC', 'TRIG [Half a line]']);
            expect(bufferLines()).toContain('Half a line');
        });

        it('comes before the disconnect notices', async () => {
            await boot();
            const s = dial();
            s.deliver('Server full, bye');
            s.onclose?.({ code: 1000, reason: '', wasClean: true });

            const lines = bufferLines();
            const at = lines.indexOf('Server full, bye');
            expect(at).toBeGreaterThan(-1);
            expect(lines.findIndex(l => l.startsWith('[ ALERT ] - Socket got disconnected'))).toBeGreaterThan(at);
        });
    });

    describe('2. getConnectionInfo() after connectToServer()', () => {
        const info = () => {
            const { host, port, connected } = internals.api.getConnectionInfo();
            return `${host}:${port}:${connected}`;
        };

        it('reports the new target at once, connected, and through a failure', async () => {
            await boot();
            internals.markScriptsLoaded();
            expect(info()).toBe('profile.invalid:4000:false');

            expect(internals.api.connectToServer('127.0.0.1', 7490)).toBe(true);
            expect(info()).toBe('127.0.0.1:7490:false');

            sock().onopen?.({});
            sock().onmessage?.({ data: JSON.stringify({ type: 'game.connected' }) });
            expect(info()).toBe('127.0.0.1:7490:true');

            internals.api.connectToServer('127.0.0.1', 7499);
            sock().onclose?.({ code: 1006, reason: 'ECONNREFUSED', wasClean: false });
            expect(info()).toBe('127.0.0.1:7499:false');

            internals.api.connectToServer('nosuchhost.invalid', 4000);
            expect(info()).toBe('nosuchhost.invalid:4000:false');
        });

        it('keeps reporting it across reconnect()', async () => {
            await boot();
            internals.markScriptsLoaded();
            internals.api.connectToServer('127.0.0.1', 7490);
            session.reconnect();
            expect(info()).toBe('127.0.0.1:7490:false');
        });

        it('reports it while the dial is still held for the initial load', async () => {
            await boot();
            internals.api.connectToServer('127.0.0.1', 7490);
            expect(MockWebSocket.instances).toHaveLength(0);
            expect(info()).toBe('127.0.0.1:7490:false');
        });

        it('goes back to the profile once a dial elsewhere overtakes it', async () => {
            await boot();
            internals.markScriptsLoaded();
            internals.api.connectToServer('127.0.0.1', 7490);
            dial(PROFILE_URL);
            expect(info()).toBe('profile.invalid:4000:true');
        });
    });

    describe('3. disconnect() with output still pending', () => {
        it('raises sysDisconnectionEvent after the caller has returned', async () => {
            await boot();
            dial();
            log = [];
            // send("quit") disconnect() send("RESULT B after")
            session.send('quit');
            session.disconnect();
            log.push('B after');

            expect(log).toEqual(['B after']);
            await new Promise(resolve => setTimeout(resolve, 0));
            // Desktop: B after, DISC handler
            expect(log).toEqual(['B after', 'DISC']);
            expect(session.status).toBe('disconnected');
        });

        it('raises it before returning when nothing is waiting to be written', async () => {
            await boot();
            dial();
            await new Promise(resolve => setTimeout(resolve, 0));
            log = [];
            session.disconnect();
            log.push('B after');

            expect(log).toEqual(['DISC', 'B after']);
        });

        it('is reported before a redial replaces the closing connection', async () => {
            await boot();
            dial();
            log = [];
            session.send('quit');
            session.disconnect();
            dial();

            expect(log).toEqual(['DISC', 'CONN']);
            expect(session.status).toBe('connected');
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(log).toEqual(['DISC', 'CONN']);
            expect(session.status).toBe('connected');
        });
    });

    describe('4. connection notices in the buffer', () => {
        it('counts the dial and connect notices by sysConnectionEvent', async () => {
            await boot();
            let atConnect: string[] = [];
            onEmitEvent = (event) => { if (event === 'sysConnectionEvent') atConnect = bufferLines(); };
            dial();

            expect(atConnect).toEqual([
                '[ INFO ]  - Attempting an open connection to ws://profile.invalid:4000 ...',
                '[  OK  ]  - Open connection made.',
            ]);
        });

        it('stores the disconnect notices after the last game line', async () => {
            await boot();
            const s = dial();
            s.deliver('Hello 1\r\n');
            session.disconnect();

            const lines = bufferLines();
            const tail = lines.slice(lines.indexOf('Hello 1'));
            expect(tail[0]).toBe('Hello 1');
            expect(tail[1]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(tail[2].trim()).toBe('User Disconnected');
            expect(tail[3]).toMatch(/^\[ INFO \]  - Connection time: \d\d:\d\d:\d\d\.\d\d\d\.$/);
            expect(tail).toHaveLength(4);
        });
    });
});
