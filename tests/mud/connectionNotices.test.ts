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
            dial().onopen?.({});
            expect(lines()).toContain('[  OK  ]  - Open connection made.');
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
            const sock = dial();
            sock.onopen?.({});
            messages = [];
            sock.onclose?.({ code: 1000, reason: '', wasClean: true });

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(lines()[1].trim()).toBe('Connection/login attempt rejected by server');
            expect(lines()[2]).toMatch(/^\[ INFO \]  - Connection time: \d\d:\d\d:\d\d\.\d\d\d\.$/);
        });

        it('names the user when the user clicked Disconnect', () => {
            dial().onopen?.({});
            messages = [];
            session.disconnect();

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(lines()[1].trim()).toBe('User Disconnected');
        });

        // An idle kick: a long, healthy session that simply ends. Past the
        // five-second window cTelnet has no explanation to offer, so it says so.
        it('says only that it got disconnected when it has no reason', () => {
            vi.useFakeTimers();
            const sock = dial();
            sock.onopen?.({});
            messages = [];
            vi.advanceTimersByTime(65_000);
            sock.onclose?.({ code: 1000, reason: '', wasClean: true });

            expect(lines()[0]).toBe('[ ALERT ] - Socket got disconnected.');
            expect(lines()[1]).toBe('[ INFO ]  - Connection time: 00:01:05.000.');
        });

        // Past the five-second window, the socket's own words are the reason —
        // cTelnet's last arm (ctelnet.cpp:1092-1093).
        it('carries the socket error as the reason, printed once', () => {
            vi.useFakeTimers();
            const sock = dial();
            sock.onopen?.({});
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
        // and the session would sit in `connecting` for ever. Mudlet leaves its
        // timeOffset at 0 when the connection timer never started
        // (ctelnet.cpp:993), so this lands in the rejection window, and the
        // transport's own words go to the script log rather than the console.
        it('announces a dial that never opened a socket at all', () => {
            MockWebSocket.throwOnConstruct = 'The URL is invalid';
            session.connect(PROXY_URL);

            expect(lines()[0]).toBe('[ INFO ]  - Attempting an open connection to achaea.com:23 via proxy...');
            expect(lines()[1]).toBe('[ ALERT ] - Socket got disconnected, for reason:');
            expect(lines()[2].trim()).toBe('Connection/login attempt rejected by server');
            expect(session.scriptLog.some(e => e.text.includes('The URL is invalid'))).toBe(true);
            expect(session.status).toBe('disconnected');
        });

        // The window wins over the socket's error, which is the half mudix had
        // backwards: a server that slams the door on login drops us with a
        // transport error inside those five seconds, and Mudlet still calls that
        // a rejection rather than repeating the transport's words.
        it('prefers the rejection window over the socket error', () => {
            vi.useFakeTimers();
            const sock = dial();
            sock.onopen?.({});
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
            const first = dial();
            first.onopen?.({});
            const second = dial();
            second.onopen?.({});
            second.onclose?.({ code: 1000, reason: '', wasClean: true });

            const disconnects = lines().filter(l => l.startsWith('[ ALERT ] - Socket got disconnected'));
            const attempts = lines().filter(l => l.includes('Attempting an open connection'));
            expect(attempts).toHaveLength(2);
            expect(disconnects).toHaveLength(2);
        });
    });
});
