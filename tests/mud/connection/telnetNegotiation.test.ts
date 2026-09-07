// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import {
  MSDP_WILL, MSDP_DO,
  MSSP_WILL, MSSP_DO,
  GMCP_WILL, GMCP_DO,
  TTYPE_DO, TTYPE_WILL, OPT_TTYPE, TTYPE_SEND, TTYPE_IS,
  CHARSET_WILL, CHARSET_DO, OPT_CHARSET, CHARSET_REQUEST, CHARSET_ACCEPTED,
  NAWS_WILL, NAWS_DO,
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

describe('telnet option negotiation (TelnetNegotiator via MudClient)', () => {
  let realWebSocket: unknown;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  });

  function connected(opts: Record<string, unknown> = {}) {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid', ...opts }, bus);
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.onopen?.({});
    sock.sent.length = 0; // discard the proactive NAWS WILL
    return { client, sock, bus };
  }

  it('accepts WILL MSDP with DO MSDP and emits msdp.negotiated', () => {
    const seen: string[] = [];
    const { sock, bus } = connected({ msdpEnabled: true });
    bus.on('msdp.negotiated', () => seen.push('msdp'));
    sock.deliver(MSDP_WILL);
    expect(sentText(sock)).toContain(MSDP_DO);
    expect(seen).toEqual(['msdp']);
  });

  it('ignores WILL MSDP when MSDP is disabled (default)', () => {
    const { sock } = connected();
    sock.deliver(MSDP_WILL);
    expect(sentText(sock)).not.toContain(MSDP_DO);
  });

  it('accepts WILL MSSP with DO MSSP and emits mssp.negotiated', () => {
    const seen: string[] = [];
    const { sock, bus } = connected();
    bus.on('mssp.negotiated', () => seen.push('mssp'));
    sock.deliver(MSSP_WILL);
    expect(sentText(sock)).toContain(MSSP_DO);
    expect(seen).toEqual(['mssp']);
  });

  it('agrees to DO TTYPE and answers the SEND cycle: name → type → MTTS', () => {
    const { sock } = connected();
    sock.deliver(TTYPE_DO);
    expect(sentText(sock)).toContain(TTYPE_WILL);

    const sendReq = '\xFF\xFA' + OPT_TTYPE + TTYPE_SEND + '\xFF\xF0';
    sock.sent.length = 0;
    sock.deliver(sendReq);
    expect(sentText(sock)).toContain(TTYPE_IS + 'MUDLET-WEB');
    sock.sent.length = 0;
    sock.deliver(sendReq);
    expect(sentText(sock)).toContain(TTYPE_IS + 'ANSI-TRUECOLOR');
    sock.sent.length = 0;
    sock.deliver(sendReq);
    expect(sentText(sock)).toContain(TTYPE_IS + 'MTTS ');
  });

  it('sets the MTTS SCREEN READER bit in the TTYPE cycle when advertiseScreenReader is on', () => {
    const { sock } = connected({ screenReaderAdvertised: true });
    sock.deliver(TTYPE_DO);
    const sendReq = '\xFF\xFA' + OPT_TTYPE + TTYPE_SEND + '\xFF\xF0';
    sock.sent.length = 0;
    sock.deliver(sendReq); // name
    sock.sent.length = 0;
    sock.deliver(sendReq); // terminal type
    sock.sent.length = 0;
    sock.deliver(sendReq); // MTTS bitvector
    // ANSI(1) + 256(8) + OSC_COLOR_PALETTE(32) + TRUECOLOR(256) + UTF8(4) + SCREEN_READER(64) = 365.
    expect(sentText(sock)).toContain(TTYPE_IS + 'MTTS 365');
  });

  it('omits the MTTS SCREEN READER bit by default', () => {
    const { sock } = connected();
    sock.deliver(TTYPE_DO);
    const sendReq = '\xFF\xFA' + OPT_TTYPE + TTYPE_SEND + '\xFF\xF0';
    sock.sent.length = 0;
    sock.deliver(sendReq);
    sock.sent.length = 0;
    sock.deliver(sendReq);
    sock.sent.length = 0;
    sock.deliver(sendReq);
    // ANSI(1) + 256(8) + OSC_COLOR_PALETTE(32) + TRUECOLOR(256) + UTF8(4) = 301.
    expect(sentText(sock)).toContain(TTYPE_IS + 'MTTS 301');
  });

  it('accepts WILL CHARSET with DO CHARSET and sends our REQUEST', () => {
    const { sock } = connected();
    sock.deliver(CHARSET_WILL);
    const out = sentText(sock);
    expect(out).toContain(CHARSET_DO);
    expect(out).toContain(CHARSET_REQUEST + ';UTF-8;ISO-8859-2;ISO-8859-1');
  });

  it('switches the inbound decoder when the server ACCEPTS a charset', () => {
    const seen: string[] = [];
    const { client, sock, bus } = connected();
    bus.on('charset.negotiated', (name) => seen.push(name));
    sock.deliver(CHARSET_WILL);
    sock.deliver('\xFF\xFA' + OPT_CHARSET + CHARSET_ACCEPTED + 'ISO-8859-2' + '\xFF\xF0');
    // Reported under this client's own name for the encoding, which is the
    // spelling getServerEncoding() answers with however it was set.
    expect(seen).toEqual(['ISO 8859-2']);
    expect(client.getServerEncoding()).toBe('iso-8859-2');
  });

  it('answers the server-side CHARSET REQUEST by accepting a supported name', () => {
    const { client, sock } = connected();
    sock.deliver(CHARSET_WILL);
    sock.sent.length = 0;
    sock.deliver('\xFF\xFA' + OPT_CHARSET + CHARSET_REQUEST + ';KOI8-R;ISO-8859-2' + '\xFF\xF0');
    // The server's order decides — the first name we can decode wins, as it
    // does in Mudlet — and the reply echoes the wire spelling back.
    expect(sentText(sock)).toContain(CHARSET_ACCEPTED + 'KOI8-R');
    expect(client.getServerEncoding()).toBe('koi8-r');
  });

  it('reports the window size once the server accepts NAWS', () => {
    const seen: string[] = [];
    const { client, sock, bus } = connected();
    bus.on('naws.negotiated', () => seen.push('naws'));
    client.setWindowSize(120, 40);
    sock.deliver(NAWS_DO);
    // IAC SB NAWS 0 120 0 40 IAC SE (16-bit big-endian cols then rows)
    expect(sentText(sock)).toContain('\xFF\xFA\x1F\x00\x78\x00\x28\xFF\xF0');
    expect(seen).toEqual(['naws']);
  });

  it('does not offer NAWS when disabled', () => {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid', nawsEnabled: false }, bus);
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.onopen?.({});
    expect(sentText(sock)).not.toContain(NAWS_WILL);
    sock.deliver(NAWS_DO);
    expect(sentText(sock)).not.toContain('\xFF\xFA\x1F');
  });

  it('auto-negotiates options registered via addSupportedTelnetOption', () => {
    const { client, sock } = connected();
    client.addSupportedTelnetOption(93); // ZMP
    sock.deliver('\xFF\xFB\x5D'); // IAC WILL ZMP
    expect(sentText(sock)).toContain('\xFF\xFD\x5D'); // IAC DO ZMP
    sock.sent.length = 0;
    sock.deliver('\xFF\xFD\x5D'); // IAC DO ZMP
    expect(sentText(sock)).toContain('\xFF\xFB\x5D'); // IAC WILL ZMP
  });

  it('raises telnet.event for unrecognized options instead of answering', () => {
    const events: [number, number][] = [];
    const { sock, bus } = connected();
    bus.on('telnet.event', (type, option) => events.push([type, option]));
    sock.deliver('\xFF\xFB\x5D'); // IAC WILL ZMP (not registered)
    expect(events).toEqual([[1, 93]]);
    expect(sentText(sock)).toBe('');
  });

  it('answers a negotiation command split across two WebSocket frames', () => {
    const { sock } = connected();
    sock.deliver('\xFF');       // bare IAC at frame end
    sock.deliver('\xFB\x46');   // WILL MSSP continues in the next frame
    expect(sentText(sock)).toContain(MSSP_DO);
  });

  it('does not mistake escaped IAC bytes inside a subneg payload for negotiation', () => {
    const { sock } = connected();
    // An MSSP subnegotiation whose payload contains an escaped 0xFF (IAC IAC)
    // followed by bytes that spell WILL GMCP. The old substring scan matched
    // `\xFF\xFB\xC9` inside the payload and acked GMCP that was never offered.
    sock.deliver('\xFF\xFA\x46\x01NAME\x02X\xFF\xFF\xFB\xC9Y\xFF\xF0');
    expect(sentText(sock)).not.toContain(GMCP_DO);
    expect(sentText(sock)).not.toContain(GMCP_WILL);
  });
});
