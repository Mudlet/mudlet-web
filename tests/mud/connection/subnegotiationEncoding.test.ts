// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { GMCP_IAC, GMCP_SB, GMCP_SE, OPT_ATCP, OPT_TELNET_102 } from '../../../src/mud/protocol/constants';
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
}

function sentText(sock: MockWebSocket): string {
  return sock.sent.map(b => String.fromCharCode(...b)).join('');
}

describe('raw subnegotiation encoding (sendATCP / sendTelnetChannel102)', () => {
  let realWebSocket: unknown;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  });

  function connected() {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid' }, bus);
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.onopen?.({});
    sock.sent.length = 0; // discard the proactive NAWS WILL
    return { client, sock };
  }

  it('frames an ASCII ATCP message unchanged', () => {
    const { client, sock } = connected();
    expect(client.sendATCP('Char.Login')).toBe(true);
    expect(sentText(sock)).toBe(`${GMCP_IAC}${GMCP_SB}${OPT_ATCP}Char.Login${GMCP_IAC}${GMCP_SE}`);
  });

  it('UTF-8-encodes a non-ASCII ATCP message rather than truncating it', () => {
    const { client, sock } = connected();
    client.sendATCP('Char.Login Michał');
    const body = sentText(sock).slice(3, -2);
    // 'ł' is U+0142 — one char, two UTF-8 bytes. Truncation to Latin-1 would
    // have written the single byte 0x42 ('B') instead.
    expect(body).toBe('Char.Login Micha\xC5\x82');
    expect(new TextDecoder('utf-8').decode(
      Uint8Array.from(body, c => c.charCodeAt(0)),
    )).toBe('Char.Login Michał');
  });

  it('never emits a bare IAC inside an ATCP body', () => {
    const { client, sock } = connected();
    client.sendATCP('xÿy'); // U+00FF used to go out as the raw byte 0xFF
    const body = sentText(sock).slice(3, -2);
    expect(body).toBe('x\xC3\xBFy');
    expect(body).not.toContain(GMCP_IAC);
  });

  it('sends channel-102 payload bytes verbatim, without UTF-8 expansion', () => {
    const { client, sock } = connected();
    // Aardwolf's documented usage: two raw bytes, chosen numerically.
    expect(client.sendTelnetChannel102('\x01\xC8')).toBe(true);
    expect(sentText(sock)).toBe(`${GMCP_IAC}${GMCP_SB}${OPT_TELNET_102}\x01\xC8${GMCP_IAC}${GMCP_SE}`);
  });

  it('doubles a 0xFF payload byte on channel 102 without touching the framing', () => {
    const { client, sock } = connected();
    client.sendTelnetChannel102('\x01\xFF');
    const wire = sentText(sock);
    expect(wire).toBe(`${GMCP_IAC}${GMCP_SB}${OPT_TELNET_102}\x01\xFF\xFF${GMCP_IAC}${GMCP_SE}`);
    // The leading IAC SB and trailing IAC SE stay single — Mudlet's replace runs
    // over the whole framed string and doubles those too, which mis-frames it.
    expect(wire.startsWith(`${GMCP_IAC}${GMCP_SB}`)).toBe(true);
    expect(wire.endsWith(`${GMCP_IAC}${GMCP_SE}`)).toBe(true);
  });
});
