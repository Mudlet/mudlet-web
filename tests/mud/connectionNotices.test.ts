// @vitest-environment node
//
// Node env with the same DOM stubs connectionEventStatus.test.ts uses — nothing
// here touches a real document, but MudSession's constructor looks for a window.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const { MudSession } = await import('../../src/mud/MudSession');

class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];
    /** Set to make the constructor throw, as a bad URL scheme does. */
    static throwOnConstruct: string | null = null;

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    protocol = '';
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) {
        if (MockWebSocket.throwOnConstruct) throw new Error(MockWebSocket.throwOnConstruct);
        MockWebSocket.instances.push(this);
    }
    send() {}
    close() { this.readyState = MockWebSocket.CLOSED; }
}

const PROXY_URL = 'wss://proxy.invalid/?host=achaea.com&port=23';
const PROXY_TLS_URL = 'wss://proxy.invalid/?host=achaea.com&port=443&tls=1';

/**
 * Nothing used to be written to the console when a connection began or ended.
 * `isAbnormalClose()` returns false for 1000/1005, so a clean close from the
 * proxy — a server-side "Goodbye!", an idle kick, a Disconnect click — never
 * reached the only path that printed anything. The tab-title emoji and a 4px
 * status dot were the sole signals, and neither survives into a session log.
 *
 * cTelnet narrates all of it: "[ INFO ]  - Attempting an open connection to
 * %1:%2 ..." (ctelnet.cpp:1213-1280), "[  OK  ]  - Open connection made."
 * (ctelnet.cpp:700-713), "[ ALERT ] - Socket got disconnected[, for reason:]"
 * (ctelnet.cpp:826-895) and "[ INFO ]  - Connection time: %1."
 * (ctelnet.cpp:774). See issue #55.
 */
describe('connect/disconnect console notices', () => {
    let session: InstanceType<typeof MudSession>;
    let realWebSocket: unknown;
    let messages: string[];

    /** Console rows with the ANSI colouring stripped. */
    const lines = () => messages.map(m => m.replace(/\x1b\[[0-9;]*m/g, ''));

    const dial = (url = PROXY_URL) => {
        session.connect(url);
        return MockWebSocket.instances[MockWebSocket.instances.length - 1];
    };

    /** Open the socket *and* have the proxy report that it reached the game.
     *  Through a proxy the WebSocket opening only means the proxy accepted us —
     *  it dials the game afterwards — so the session clock (Mudlet's
     *  mConnectionTimer) starts on this frame, not on `onopen`. */
    const settle = (sock: MockWebSocket) => {
        sock.onopen?.({});
        sock.onmessage?.({ data: JSON.stringify({ type: 'game.connected' }) as unknown as ArrayBuffer });
        return sock;
    };

    beforeEach(() => {
        realWebSocket = g.WebSocket;
        g.WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        MockWebSocket.throwOnConstruct = null;
        messages = [];
        session = new MudSession();
        session.events.on('message', (text) => { if (typeof text === 'string') messages.push(text); });
    });

    afterEach(() => {
        try { session.destroy(); } catch { /* teardown best-effort */ }
        g.WebSocket = realWebSocket;
        vi.useRealTimers();
    });

    describe('the dial attempt', () => {
        it('names the game and port, not the proxy URL', () => {
            dial();
            expect(lines()[0]).toBe('[ INFO ]  - Attempting an open connection to achaea.com:23 via proxy...');
        });

        it('says "secure" when the proxy was asked to wrap the socket in TLS', () => {
            dial(PROXY_TLS_URL);
            expect(lines()[0]).toBe('[ INFO ]  - Attempting a secure connection to achaea.com:443 via proxy...');
        });

        it('names the endpoint itself in websocket mode, with no proxy hop', () => {
            dial('wss://mud.example.org:4000/ws');
            expect(lines()[0]).toBe('[ INFO ]  - Attempting a secure connection to wss://mud.example.org:4000/ws ...');
        });
    });

    describe('the connection being made', () => {
        it('reports an open connection', () => {
            settle(dial());
            expect(lines()).toContain('[  OK  ]  - Open connection made.');
        });

        // Issue #237: the proxy accepts our WebSocket before it dials the game,
        // so the WebSocket opening proves nothing about the game. Nothing is
        // "made" until the proxy says it got there.
        it('does not report a connection the proxy has not made yet', () => {
            const connects: number[] = [];
            session.events.on('client.connect', () => connects.push(1));
            dial().onopen?.({});
            expect(lines().some(l => l.includes('connection made'))).toBe(false);
            expect(connects).toHaveLength(0);
            expect(session.status).toBe('connecting');
        });

        it('reports it once the proxy has reached the game', () => {
            const sock = dial();
            sock.onopen?.({});
            sock.onmessage?.({ data: JSON.stringify({ type: 'game.connected' }) as unknown as ArrayBuffer });
            expect(lines()).toContain('[  OK  ]  - Open connection made.');
            expect(session.status).toBe('connected');
        });

        // A proxy predating `game.connected` says nothing, so the first byte the
        // game sends is the proof instead.
        it('takes the first game byte as the proof from an older proxy', () => {
            const sock = dial();
            sock.onopen?.({});
            sock.onmessage?.({ data: new TextEncoder().encode('Welcome\r\n').buffer as ArrayBuffer });
            expect(lines()).toContain('[  OK  ]  - Open connection made.');
            expect(session.status).toBe('connected');
        });

        // A direct websocket has only the one leg: opening it is reaching the game.
        it('reports a direct websocket connection as soon as it opens', () => {
            dial('ws://mud.example.org:4000/ws').onopen?.({});
            expect(lines()).toContain('[  OK  ]  - Open connection made.');
            expect(session.status).toBe('connected');
        });

        // Mudlet wires slot_socketConnected to QSslSocket::encrypted for a
        // secure profile. Here the WebSocket opening only proves the proxy
        // answered, so the announcement is left to the tls.established handler
        // ("Secure connection made (…)") rather than claimed twice.
        it('leaves a secure connection to the TLS handshake to announce', () => {
            dial(PROXY_TLS_URL).onopen?.({});
            expect(lines().some(l => l.includes('connection made'))).toBe(false);
        });
    });

    describe('the disconnect', () => {
        // The reported case: the server closes cleanly ("Goodbye!") and the
        // proxy relays code 1000. Nothing was appended at all.
        it('announces a clean server-side close', () => {
            const sock = settle(dial());
            messages = [];
            sock.onclose?.({ code: 1000, reason: '', wasClean: true });

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(lines()[1].trim()).toBe('Connection/login attempt rejected by server');
            expect(lines()[2]).toMatch(/^\[ INFO \]  - Connection time: \d\d:\d\d:\d\d\.\d\d\d\.$/);
        });

        it('names the user when the user clicked Disconnect', () => {
            settle(dial());
            messages = [];
            session.disconnect();

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(lines()[1].trim()).toBe('User Disconnected');
        });

        // An idle kick: a long, healthy session that simply ends. The proxy
        // relays the game hanging up as a plain close frame, and cTelnet names it
        // with Qt's RemoteHostClosedError text (issue #237 — this used to say
        // only "Socket got disconnected.").
        it('names the remote host closing the connection', () => {
            vi.useFakeTimers();
            const sock = settle(dial());
            messages = [];
            vi.advanceTimersByTime(65_000);
            sock.onclose?.({ code: 1000, reason: 'TCP connection closed', wasClean: true });

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(lines()[1].trim()).toBe('The remote host closed the connection');
            expect(lines()[2]).toBe('[ INFO ]  - Connection time: 00:01:05.000.');
        });

        // Tearing a live session down to dial again has no close frame and no
        // error behind it, so there is nothing to name.
        it('says only that it got disconnected when it has no reason', () => {
            vi.useFakeTimers();
            settle(dial());
            vi.advanceTimersByTime(65_000);
            messages = [];
            dial();

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected.');
            expect(lines()[1]).toBe('[ INFO ]  - Connection time: 00:01:05.000.');
        });

        // Past the five-second window, the socket's own words are the reason —
        // cTelnet's last arm (ctelnet.cpp:1092-1093).
        it('carries the socket error as the reason, printed once', () => {
            vi.useFakeTimers();
            const sock = settle(dial());
            messages = [];
            vi.advanceTimersByTime(30_000);
            sock.onclose?.({ code: 1006, reason: '', wasClean: false });

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(lines()[1].trim()).toBe('Connection lost (no close frame received from server)');
            // The old `[connection error] …` row said the same thing again, in a
            // different format. It stays in the script log, not the console.
            expect(lines().some(l => l.startsWith('[connection error]'))).toBe(false);
            expect(session.scriptLog.some(e => e.text.startsWith('[connection error]'))).toBe(true);
        });

        // A dial that dies in the WebSocket constructor produces no close event,
        // so without an explicit disconnect the failure would never be narrated
        // and the session would sit in `connecting` for ever. It never reached
        // the proxy, so it is cTelnet's "via proxy" failure, carrying the
        // transport's own words.
        it('announces a dial that never opened a socket at all', () => {
            MockWebSocket.throwOnConstruct = 'The URL is invalid';
            session.connect(PROXY_URL);

            expect(lines()[0]).toBe('[ INFO ]  - Attempting an open connection to achaea.com:23 via proxy...');
            expect(lines()[1]).toBe('[ ERROR ] - Unable to connect to achaea.com:23 via proxy - The URL is invalid.');
            expect(lines()[2].trim()).toBe('Check the proxy details entered in the profile preferences.');
            expect(lines()).toHaveLength(3);
            expect(session.scriptLog.some(e => e.text.includes('The URL is invalid'))).toBe(true);
            expect(session.status).toBe('disconnected');
        });

        // The window wins over the socket's error, which is the half Mudlet Web had
        // backwards: a server that slams the door on login drops us with a
        // transport error inside those five seconds, and Mudlet still calls that
        // a rejection rather than repeating the transport's words.
        it('prefers the rejection window over the socket error', () => {
            vi.useFakeTimers();
            const sock = settle(dial());
            messages = [];
            vi.advanceTimersByTime(1_200);
            sock.onclose?.({ code: 1006, reason: '', wasClean: false });

            expect(lines()[1].trim()).toBe('Connection/login attempt rejected by server');
        });

        it('says nothing about a session that was never dialed', () => {
            session.disconnect();
            expect(messages).toEqual([]);
        });

        it('announces each connection exactly once across a reconnect', () => {
            settle(dial());
            const second = settle(dial());
            second.onclose?.({ code: 1000, reason: '', wasClean: true });

            const disconnects = lines().filter(l => l.startsWith('[ ALERT ] - Socket got disconnected'));
            const attempts = lines().filter(l => l.includes('Attempting an open connection'));
            expect(attempts).toHaveLength(2);
            expect(disconnects).toHaveLength(2);
        });
    });
    // Issue #237. cTelnet::slot_socketError: an attempt that never reaches the
    // game is not a connection that was lost. No "Open connection made", no
    // "Socket got disconnected", no connection time — one error naming the
    // address and why, in the operating system's words.
    describe('an attempt that never reaches the game', () => {
        const refuse = (sock: MockWebSocket, reason: string) => {
            sock.onopen?.({});
            sock.onclose?.({ code: 1011, reason, wasClean: true });
        };

        it('reports a refused connection in the words Mudlet uses', () => {
            refuse(dial(), 'Proxy: connect to achaea.com:23 failed: ECONNREFUSED');
            expect(lines().slice(1)).toEqual([
                '[ ERROR ] - Unable to connect to achaea.com:23 - Connection refused.',
                '            Check your internet connection and the details entered for the game server.',
            ]);
            expect(session.status).toBe('disconnected');
        });

        it('reports a host that does not resolve as the lookup failure', () => {
            refuse(dial(), 'Proxy: connect to nowhere.invalid:23 failed: ENOTFOUND');
            expect(lines()[1]).toBe('[ ERROR ] - Unable to connect to "achaea.com".');
            expect(lines()[2].trim()).toBe('Check your internet connection and the details entered for the game server.');
        });

        it('passes on a reason it has no translation for', () => {
            refuse(dial(PROXY_TLS_URL), 'Proxy: TLS certificate rejected: CERT_HAS_EXPIRED');
            expect(lines()).toContain('[ ERROR ] - Unable to connect to achaea.com:443 - TLS certificate rejected: CERT_HAS_EXPIRED.');
        });

        it('blames the proxy when the proxy itself could not be reached', () => {
            dial().onclose?.({ code: 1006, reason: '', wasClean: false });
            expect(lines()[1]).toBe('[ ERROR ] - Unable to connect to achaea.com:23 via proxy - The proxy could not be reached.');
            expect(lines()[2].trim()).toBe('Check the proxy details entered in the profile preferences.');
        });

        it('reports a direct websocket that never opened', () => {
            dial('wss://mud.example.org:4000/ws').onclose?.({ code: 1006, reason: '', wasClean: false });
            expect(lines()[1]).toBe('[ ERROR ] - Unable to connect to wss://mud.example.org:4000/ws - The server could not be reached.');
        });

        it('never raises client.connect, but does raise client.disconnect', () => {
            const seen: string[] = [];
            session.events.on('client.connect', () => seen.push('connect'));
            session.events.on('client.disconnect', () => seen.push('disconnect'));
            refuse(dial(), 'Proxy: connect to achaea.com:23 failed: ECONNREFUSED');
            expect(seen).toEqual(['disconnect']);
        });

        // handleFailedConnection with mDontReconnect: the player called it off,
        // and "its failure is not news to anybody".
        it('says nothing about an attempt the player called off', () => {
            dial().onopen?.({});
            messages = [];
            session.disconnect();
            expect(messages).toEqual([]);
            expect(session.status).toBe('disconnected');
        });

        it('says nothing about an attempt abandoned for a new dial', () => {
            dial().onopen?.({});
            messages = [];
            dial();
            expect(lines()).toEqual(['[ INFO ]  - Attempting an open connection to achaea.com:23 via proxy...']);
        });
    });

    // cTelnet posts a failed attempt's error before raising sysDisconnectionEvent
    // (handleFailedConnection), but raises it *before* reporting a connection
    // that was lost (slot_socketDisconnected). A late `client.disconnect`
    // listener stands in for the scripting engine's bridge here.
    describe('order against sysDisconnectionEvent', () => {
        const marker = () => session.events.on('client.disconnect', () => messages.push('<sysDisconnectionEvent>'));

        it('reports a lost connection after the event', () => {
            marker();
            const sock = settle(dial());
            messages = [];
            sock.onclose?.({ code: 1000, reason: '', wasClean: true });
            expect(lines()[0]).toBe('<sysDisconnectionEvent>');
            expect(lines()[1]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
        });

        it('reports a failed attempt before the event', () => {
            marker();
            const sock = dial();
            messages = [];
            sock.onopen?.({});
            sock.onclose?.({ code: 1011, reason: 'Proxy: connect to achaea.com:23 failed: ECONNREFUSED', wasClean: true });
            expect(lines()[0]).toMatch(/^\[ ERROR \]/);
            expect(lines()[2]).toBe('<sysDisconnectionEvent>');
        });
    });
});
