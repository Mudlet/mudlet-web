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
    sock.sent.length = 0;
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

  // ATCP (200) is GMCP's predecessor: Mudlet takes it up only while GMCP is
  // switched off for the profile.
  it('takes up ATCP only while GMCP is off, with the hello after the DO', () => {
    const ATCP_WILL = '\xFF\xFB\xC8', ATCP_DO = '\xFF\xFD\xC8';
    const events: string[] = [];
    const on = connected({ gmcpEnabled: false });
    on.bus.on('protocol.enabled', p => events.push(`on:${p}`));
    on.sock.deliver(ATCP_WILL);
    const sent = sentText(on.sock);
    expect(sent.startsWith('\xFF\xFD\xC8\xFF\xFA\xC8hello ')).toBe(true);
    expect(sent.endsWith('map_display 1\n\xFF\xF0')).toBe(true);
    expect(events).toEqual(['on:ATCP']);

    MockWebSocket.instances = [];
    const off = connected({ gmcpEnabled: true });
    off.bus.on('protocol.enabled', p => events.push(`off:${p}`));
    off.sock.deliver(ATCP_WILL + ATCP_DO);
    expect(sentText(off.sock)).toBe('\xFF\xFE\xC8\xFF\xFC\xC8'); // DONT, WONT
    expect(events).toEqual(['on:ATCP']);
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
    // ANSI(1) + 256(8) + OSC_COLOR_PALETTE(32) + TRUECOLOR(256) + UTF8(4) + SSL(2048) + SCREEN_READER(64) = 2413.
    expect(sentText(sock)).toContain(TTYPE_IS + 'MTTS 2413');
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
    // ANSI(1) + 256(8) + OSC_COLOR_PALETTE(32) + TRUECOLOR(256) + UTF8(4) + SSL(2048) = 2349 — desktop's default.
    expect(sentText(sock)).toContain(TTYPE_IS + 'MTTS 2349');
  });

  // Mudlet only answers the server's REQUEST ("Mudlet does not initiate
  // negotiations yet", ctelnet.cpp) — it never sends one of its own (#179).
  it('accepts WILL CHARSET with DO CHARSET and waits for the server to REQUEST', () => {
    const { sock } = connected();
    sock.deliver(CHARSET_WILL);
    expect(sentText(sock)).toBe(CHARSET_DO);
  });

  it('accepts DO CHARSET with WILL CHARSET and sends no REQUEST', () => {
    const { sock } = connected();
    sock.deliver(CHARSET_DO);
    expect(sentText(sock)).toBe(CHARSET_WILL);
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

  // Mudlet/mudlet-web#191: CP866 was offered, ACCEPTED on the wire, and then
  // refused by the decoder, so the game's Russian came out as U+FFFD.
  it('decodes in the CP866 it accepted', () => {
    const { client, sock, bus } = connected();
    const lines: string[] = [];
    bus.on('flushLines', groups => lines.push(...groups.map(g => g.text)));
    sock.deliver(CHARSET_WILL);
    sock.sent.length = 0;
    sock.deliver('\xFF\xFA' + OPT_CHARSET + CHARSET_REQUEST + ';CP866' + '\xFF\xF0');
    expect(sentText(sock)).toBe('\xFF\xFA' + OPT_CHARSET + CHARSET_ACCEPTED + 'CP866' + '\xFF\xF0');
    expect(client.getServerEncoding()).toBe('CP866');
    sock.deliver('\x8F\xE0\xA8\xA2\xA5\xE2\r\n');
    client.flushMessageBuffer();
    expect(lines.join('\n')).toContain('Привет');
  });

  it('reports the window size once the server accepts NAWS', () => {
    const seen: string[] = [];
    const { client, sock, bus } = connected();
    bus.on('naws.negotiated', () => seen.push('naws'));
    client.setWindowSize(90, 40);
    sock.deliver(NAWS_DO);
    // IAC SB NAWS 0 90 0 40 IAC SE (16-bit big-endian cols then rows)
    expect(sentText(sock)).toContain('\xFF\xFA\x1F\x00\x5A\x00\x28\xFF\xF0');
    expect(seen).toEqual(['naws']);
  });

  it('does not offer NAWS unprompted on connect, only in answer to DO NAWS (as Mudlet)', () => {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid' }, bus);
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.onopen?.({});
    expect(sentText(sock)).toBe('');
    sock.deliver(NAWS_DO);
    expect(sentText(sock).startsWith(NAWS_WILL + '\xFF\xFA\x1F')).toBe(true);
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

  it('refuses an unregistered option and still raises telnet.event for it', () => {
    const events: [number, number][] = [];
    const { sock, bus } = connected();
    bus.on('telnet.event', (type, option) => events.push([type, option]));
    sock.deliver('\xFF\xFB\x5D'); // IAC WILL ZMP (not registered)
    expect(events).toEqual([[251, 93]]);
    expect(sentText(sock)).toBe('\xFF\xFE\x5D'); // IAC DONT ZMP
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
