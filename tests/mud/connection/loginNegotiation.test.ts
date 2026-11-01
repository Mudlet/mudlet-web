// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import {
  EOR_WILL, EOR_DO,
  SGA_WILL, SGA_DO, SGA_DONT,
  LINEMODE_WILL, LINEMODE_DO, LINEMODE_DONT, LINEMODE_WONT,
  ECHO_WILL, ECHO_WONT,
  NEW_ENVIRON_DO, NEW_ENVIRON_WILL, NEW_ENVIRON_WONT,
  OPT_NEW_ENVIRON, NEW_ENVIRON_IS, NEW_ENVIRON_SEND,
  NEW_ENVIRON_VAR, NEW_ENVIRON_USERVAR,
} from '../../../src/mud/protocol/constants';
import type { MudClientEvents } from '../../../src/mud/events';

/** Minimal stand-in for the browser WebSocket, capturing outbound frames. */
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close() { this.readyState = MockWebSocket.CLOSED; }

  deliver(byteString: string) {
    const buf = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) buf[i] = byteString.charCodeAt(i) & 0xff;
    this.onmessage?.({ data: buf.buffer });
  }
}

function sentText(sock: MockWebSocket): string {
  return sock.sent.map(b => String.fromCharCode(...b)).join('');
}

describe('login-time telnet negotiation replies', () => {
  let realWebSocket: unknown;
  let realAddEventListener: unknown;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    realAddEventListener = (globalThis as Record<string, unknown>).addEventListener;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
    (globalThis as Record<string, unknown>).addEventListener = () => {};
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
    (globalThis as Record<string, unknown>).addEventListener = realAddEventListener;
  });

  function connected(opts: Record<string, unknown> = {}) {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid', ...opts }, bus);
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.onopen?.({});
    sock.sent.length = 0;
    return { client, sock, bus };
  }

  const GMCP = String.fromCharCode(201);
  const gmcpFrame = (body: string) => '\xFF\xFA' + GMCP + body + '\xFF\xF0';

  it('accepts WILL EOR with DO EOR (enables prompt markers)', () => {
    const { sock } = connected();
    sock.deliver(EOR_WILL);
    expect(sentText(sock)).toContain(EOR_DO);
  });

  it('refuses WILL SGA with DONT SGA (Mudlet-parity: line mode only)', () => {
    const { sock, bus } = connected();
    const rejected: string[] = [];
    bus.on('protocol.rejected', (p) => rejected.push(p));
    sock.deliver(SGA_WILL);
    const out = sentText(sock);
    expect(out).toContain(SGA_DONT);
    expect(out).not.toContain(SGA_DO); // never enable SGA — keeps IAC GA prompt markers flowing
    expect(rejected).toContain('SUPPRESS_GO_AHEAD');
  });

  it('refuses WILL LINEMODE with DONT LINEMODE', () => {
    const { sock, bus } = connected();
    const rejected: string[] = [];
    bus.on('protocol.rejected', (p) => rejected.push(p));
    sock.deliver(LINEMODE_WILL);
    expect(sentText(sock)).toContain(LINEMODE_DONT);
    expect(rejected).toContain('LINEMODE');
  });

  it('refuses DO LINEMODE with WONT LINEMODE', () => {
    const { sock, bus } = connected();
    const rejected: string[] = [];
    bus.on('protocol.rejected', (p) => rejected.push(p));
    sock.deliver(LINEMODE_DO);
    expect(sentText(sock)).toContain(LINEMODE_WONT);
    expect(rejected).toContain('LINEMODE');
  });

  /** Bring a connection into the ECHO+SGA state both a character-at-a-time
   *  server and an ordinary password prompt produce, with a detection counter
   *  attached. Echo commits only after the EchoHandler debounce window. */
  function echoAndSga() {
    const { client, sock, bus } = connected();
    let count = 0;
    bus.on('charmode.detected', () => { count++; });
    sock.deliver(SGA_WILL);
    sock.deliver(ECHO_WILL);
    vi.advanceTimersByTime(600);
    return { client, sock, bus, detections: () => count };
  }

  it('raises charmode.detected once when ECHO+SGA outlive a submitted command', () => {
    vi.useFakeTimers();
    try {
      const { client, detections } = echoAndSga();
      // The negotiation alone means nothing — a password prompt looks identical.
      vi.advanceTimersByTime(10_000);
      expect(detections()).toBe(0);

      client.send('look');
      vi.advanceTimersByTime(2_900);
      expect(detections()).toBe(0); // still inside the detection window
      vi.advanceTimersByTime(200);
      expect(detections()).toBe(1);

      // Idempotent for the rest of the connection.
      client.send('look');
      vi.advanceTimersByTime(5_000);
      expect(detections()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not raise charmode.detected when the server releases ECHO after the line', () => {
    vi.useFakeTimers();
    try {
      const { client, sock, detections } = echoAndSga();
      client.send('mypassword');
      // A password mask ends right after the masked line — that WONT ECHO is
      // what tells it apart from character-at-a-time mode.
      sock.deliver(ECHO_WONT);
      vi.advanceTimersByTime(10_000);
      expect(detections()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let auto-login credentials arm charmode detection', () => {
    vi.useFakeTimers();
    try {
      const { client, detections } = echoAndSga();
      client.send('secret', false); // isGameCommand: false — as sendSecret does
      vi.advanceTimersByTime(10_000);
      expect(detections()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // A server's `IAC SB NEW-ENVIRON SEND IAC SE` request — the option parser
  // strips IAC SB/SE and hands the body (option code + command) to the handler.
  const sendRequest = '\xFF\xFA' + OPT_NEW_ENVIRON + NEW_ENVIRON_SEND + '\xFF\xF0';

  it('declines DO NEW-ENVIRON with WONT when MNES is disabled', () => {
    const { sock } = connected({ mnesEnabled: false });
    sock.deliver(NEW_ENVIRON_DO);
    const out = sentText(sock);
    expect(out).toContain(NEW_ENVIRON_WONT);
    expect(out).not.toContain(NEW_ENVIRON_WILL);
  });

  it('declines DO NEW-ENVIRON with WONT when only MNES is enabled (NEW-ENVIRON gates the option)', () => {
    const { sock } = connected({ mnesEnabled: true, newEnvironEnabled: false });
    sock.deliver(NEW_ENVIRON_DO);
    const out = sentText(sock);
    expect(out).toContain(NEW_ENVIRON_WONT);
    expect(out).not.toContain(NEW_ENVIRON_WILL);
  });

  it('ignores a SEND when NEW-ENVIRON is off, even with MNES on', () => {
    const { sock } = connected({ mnesEnabled: true, newEnvironEnabled: false });
    sock.deliver(sendRequest);
    expect(sentText(sock)).toBe('');
  });

  it('accepts DO NEW-ENVIRON with WILL when MNES and NEW-ENVIRON are enabled', () => {
    const { sock } = connected({ mnesEnabled: true, newEnvironEnabled: true });
    sock.deliver(NEW_ENVIRON_DO);
    const out = sentText(sock);
    expect(out).toContain(NEW_ENVIRON_WILL);
    expect(out).not.toContain(NEW_ENVIRON_WONT);
  });

  it('accepts DO NEW-ENVIRON with WILL when only plain NEW-ENVIRON is enabled', () => {
    const { sock } = connected({ newEnvironEnabled: true });
    sock.deliver(NEW_ENVIRON_DO);
    const out = sentText(sock);
    expect(out).toContain(NEW_ENVIRON_WILL);
    expect(out).not.toContain(NEW_ENVIRON_WONT);
  });

  it('answers a SEND in MNES mode with VAR-framed core variables only', () => {
    const { sock } = connected({ mnesEnabled: true, newEnvironEnabled: true });
    sock.deliver(NEW_ENVIRON_DO);
    sock.sent.length = 0;
    sock.deliver(sendRequest);
    const out = sentText(sock);
    expect(out).toContain(NEW_ENVIRON_IS + NEW_ENVIRON_VAR + 'CHARSET');
    expect(out).toContain(NEW_ENVIRON_VAR + 'CLIENT_NAME' + '\x01' + 'MUDLET-WEB');
    // MNES restricts to the five core vars — no extended capabilities, no USERVAR.
    // (Check unambiguous extended-only vars; "ANSI" now appears inside the
    // TERMINAL_TYPE value "ANSI-TRUECOLOR".)
    expect(out).not.toContain('256_COLORS');
    expect(out).not.toContain('OSC_HYPERLINKS');
    expect(out).not.toContain(NEW_ENVIRON_USERVAR);
  });

  it('answers a SEND in NEW-ENVIRON mode with USERVAR-framed extended variables', () => {
    const { sock } = connected({ newEnvironEnabled: true });
    sock.deliver(NEW_ENVIRON_DO);
    sock.sent.length = 0;
    sock.deliver(sendRequest);
    const out = sentText(sock);
    // Core vars still present, but framed as USERVAR (not VAR).
    expect(out).toContain(NEW_ENVIRON_USERVAR + 'CHARSET');
    expect(out).not.toContain(NEW_ENVIRON_VAR + 'CHARSET');
    // Extended capability set is included.
    expect(out).toContain(NEW_ENVIRON_USERVAR + 'ANSI');
    expect(out).toContain(NEW_ENVIRON_USERVAR + 'TRUECOLOR');
  });

  it('lets MNES take precedence over NEW-ENVIRON when both are enabled', () => {
    const { sock } = connected({ mnesEnabled: true, newEnvironEnabled: true });
    sock.deliver(NEW_ENVIRON_DO);
    sock.sent.length = 0;
    sock.deliver(sendRequest);
    const out = sentText(sock);
    expect(out).toContain(NEW_ENVIRON_VAR + 'CHARSET');
    expect(out).not.toContain('256_COLORS'); // restricted to the MNES core set
    expect(out).not.toContain('OSC_HYPERLINKS');
  });

  // TLS is Mudlet's capability flag ("1" whenever built with SSL), not a report
  // on this link — and Mudlet Web can reach a game over TLS from either mode,
  // so it says "1" over plain ws:// to a proxy just as over wss:// (#286).
  it.each(['wss://secure.invalid', 'ws://proxy.invalid'])('reports TLS=1 in NEW-ENVIRON mode over %s', (url) => {
    const { sock } = connected({ newEnvironEnabled: true, url });
    sock.deliver(NEW_ENVIRON_DO);
    sock.sent.length = 0;
    sock.deliver(sendRequest);
    // USERVAR 'TLS' VALUE(\x01) '1'
    expect(sentText(sock)).toContain(NEW_ENVIRON_USERVAR + 'TLS' + '\x01' + '1');
  });

  it('emits mnes.negotiated with the active protocol name', () => {
    const seen: string[] = [];
    const { sock, bus } = connected({ newEnvironEnabled: true });
    bus.on('mnes.negotiated', (name) => seen.push(name));
    sock.deliver(NEW_ENVIRON_DO);
    expect(seen).toEqual(['NEW-ENVIRON']);
  });

  it('emits charLogin.request on Char.Login.Default (no auto-reply)', () => {
    const { sock, bus } = connected();
    let caps: unknown;
    bus.on('charLogin.request', (c) => { caps = c; });
    sock.deliver(gmcpFrame('Char.Login.Default {"type":["password-credentials"]}'));
    expect(caps).toEqual({ version: 1, methods: ['password-credentials'] });
    // The client never auto-answers — CharLoginController drives the reply.
    expect(sentText(sock)).not.toContain('Char.Login.Credentials');
  });

  it('sendCharLoginCredentials sends account + password with the common fields', () => {
    const { client, sock } = connected();
    client.sendCharLoginCredentials('myaccount', 'secret');
    expect(sentText(sock)).toContain(
      'Char.Login.Credentials {"account":"myaccount","password":"secret","version":1,"token_storage":false}');
  });

  it('sendCharLoginCredentials with no account sends the bare version 1 hand-off', () => {
    const { client, sock } = connected();
    client.sendCharLoginCredentials(undefined, undefined, true);
    expect(sentText(sock)).toContain('Char.Login.Credentials {}');
  });

  it('a version 2 hand-off carries version and token_storage but no account', () => {
    const { client, sock } = connected();
    sock.deliver(gmcpFrame('Char.Login.Default {"version":2,"type":["oauth"]}'));
    sock.sent.length = 0;
    client.sendCharLoginCredentials(undefined, undefined, true);
    expect(sentText(sock)).toContain('Char.Login.Credentials {"version":2,"token_storage":true}');
  });

  it('reads a string version and clamps a higher one to 2', () => {
    const { sock, bus } = connected();
    const versions: number[] = [];
    bus.on('charLogin.request', (c) => { versions.push(c.version); });
    sock.deliver(gmcpFrame('Char.Login.Default {"version":"2","type":["oauth"]}'));
    sock.deliver(gmcpFrame('Char.Login.Default {"version":7,"type":["oauth"]}'));
    sock.deliver(gmcpFrame('Char.Login.Default {"version":2.5,"type":["oauth"]}'));
    expect(versions).toEqual([2, 2, 1]);
  });

  describe('game transport security', () => {
    const oauthDefault = gmcpFrame('Char.Login.Default {"version":2,"type":["oauth"],'
      + '"location":"https://id.example/.well-known/openid-configuration","client_id":"mudlet"}');

    it('treats a wss:// direct connection as secure', () => {
      const { client, sock, bus } = connected({ url: 'wss://game.invalid' });
      let oauth: unknown;
      bus.on('charLogin.request', (c) => { oauth = c.oauth; });
      sock.deliver(oauthDefault);
      expect(client.gameTransportSecure).toBe(true);
      expect(oauth).toEqual({
        location: 'https://id.example/.well-known/openid-configuration',
        clientId: 'mudlet', scopes: [], nonceRequired: false,
      });
    });

    it('ignores the OAuth fields over a cleartext connection', () => {
      const { client, sock, bus } = connected();
      let oauth: unknown = 'unset';
      bus.on('charLogin.request', (c) => { oauth = c.oauth; });
      sock.deliver(oauthDefault);
      expect(client.gameTransportSecure).toBe(false);
      expect(oauth).toBeUndefined();
    });

    // A wss:// proxy only secures the browser↔proxy hop; the game leg is
    // encrypted once the proxy says it shook hands with the game.
    it('treats a proxy dial as secure only after tls.established', () => {
      const { client, sock } = connected({ url: 'wss://proxy.invalid/?host=g&port=6000&tls=1' });
      expect(client.gameTransportSecure).toBe(false);
      sock.onmessage?.({ data: JSON.stringify({ type: 'tls.established', protocol: 'TLSv1.3' }) } as never);
      expect(client.gameTransportSecure).toBe(true);
    });

    it('never treats a proxy dial without tls=1 as secure', () => {
      const { client } = connected({ url: 'wss://proxy.invalid/?host=g&port=23' });
      expect(client.gameTransportSecure).toBe(false);
    });

    it('refuses to send a secure-only token or an auth code in the clear', () => {
      const { client, sock } = connected();
      expect(client.sendCharLoginReconnect('acct', 'tok', true)).toBe(false);
      expect(client.sendCharLoginAuthCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://x/' })).toBe(false);
      expect(sentText(sock)).toBe('');
      // A token the server explicitly allowed in the clear does go.
      expect(client.sendCharLoginReconnect('acct', 'tok', false)).toBe(true);
      expect(sentText(sock)).toContain('Char.Login.Reconnect {"account":"acct","token":"tok","version":1,"token_storage":false}');
    });

    it('sends Char.Login.AuthCode over a secure connection', () => {
      const { client, sock } = connected({ url: 'wss://game.invalid' });
      sock.deliver(oauthDefault);
      sock.sent.length = 0;
      expect(client.sendCharLoginAuthCode(
        { code: 'c0de', codeVerifier: 'v3r', redirectUri: 'https://web.mudlet.org/oauth-callback.html', nonce: 'n' },
        true,
      )).toBe(true);
      expect(sentText(sock)).toContain('Char.Login.AuthCode {"code":"c0de","code_verifier":"v3r",'
        + '"redirect_uri":"https://web.mudlet.org/oauth-callback.html","nonce":"n","version":2,"token_storage":true}');
    });
  });

  it('emits charLogin.url for http(s) links only', () => {
    const { sock, bus } = connected();
    const links: unknown[] = [];
    bus.on('charLogin.url', (l) => { links.push(l); });
    sock.deliver(gmcpFrame('Char.Login.URL {"url":"https://game.example/login?x=1","provider":"Discord"}'));
    sock.deliver(gmcpFrame('Char.Login.URL {"url":"javascript:alert(1)"}'));
    expect(links).toEqual([{ url: 'https://game.example/login?x=1', provider: 'discord' }]
      .concat([null as never]));
  });

  it('emits charLogin.token, defaulting secure_only to the transport', () => {
    const { sock, bus } = connected();
    const tokens: unknown[] = [];
    bus.on('charLogin.token', (t) => { tokens.push(t); });
    sock.deliver(gmcpFrame('Char.Login.Token {"account":"a","token":"t"}'));
    sock.deliver(gmcpFrame('Char.Login.Token {"account":"a","token":"t","secure_only":"true"}'));
    sock.deliver(gmcpFrame('Char.Login.Token {"account":"a"}'));
    expect(tokens).toEqual([
      { account: 'a', token: 't', secureOnly: false },
      { account: 'a', token: 't', secureOnly: true },
    ]);
  });

  it('emits charLogin.result on Char.Login.Result', () => {
    const { sock, bus } = connected();
    const results: { success: boolean; message?: string }[] = [];
    bus.on('charLogin.result', (r) => { results.push(r); });
    sock.deliver(gmcpFrame('Char.Login.Result {"success":false,"message":"Invalid credentials"}'));
    sock.deliver(gmcpFrame('Char.Login.Result {"success":true}'));
    expect(results).toEqual([
      { success: false, message: 'Invalid credentials' },
      { success: true, message: undefined },
    ]);
  });

  it('reads a string "true" success as a successful login', () => {
    // StickMUD (and other LPMud-family drivers) parse JSON booleans but write
    // them back as strings. Mudlet accepts both spellings; so must we, or a
    // successful login surfaces as "Login failed."
    const { sock, bus } = connected();
    const results: { success: boolean; message?: string }[] = [];
    bus.on('charLogin.result', (r) => { results.push(r); });
    sock.deliver(gmcpFrame('Char.Login.Result {"success":"true"}'));
    sock.deliver(gmcpFrame('Char.Login.Result {"success":"false","message":"Nope"}'));
    expect(results).toEqual([
      { success: true, message: undefined },
      { success: false, message: 'Nope' },
    ]);
  });

  it('answers all three in a single combined negotiation frame', () => {
    // Mirrors The Last Outpost's opening burst.
    const { sock } = connected({ mnesEnabled: false });
    sock.deliver(SGA_WILL + EOR_WILL + NEW_ENVIRON_DO);
    const out = sentText(sock);
    expect(out).toContain(SGA_DONT); // refused (line mode only), but still answered
    expect(out).toContain(EOR_DO);
    expect(out).toContain(NEW_ENVIRON_WONT);
  });
});
