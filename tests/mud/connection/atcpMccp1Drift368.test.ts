// @vitest-environment node
// mudlet-web#368 — telnet drift against desktop: inbound ATCP was ignored,
// sendATCP sent while ATCP was off, and MCCP v1 (option 85) went unanswered.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import zlib from 'node:zlib';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { MccpHandler } from '../../../src/mud/protocol/mccp';
import { parseAtcpMessage } from '../../../src/mud/protocol/atcp';
import type { MudClientEvents } from '../../../src/mud/events';

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

const IAC = '\xFF', SB = '\xFA', SE = '\xF0';
const ATCP_WILL = '\xFF\xFB\xC8', ATCP_WONT = '\xFF\xFC\xC8';
const atcpSb = (body: string) => `${IAC}${SB}\xC8${body}${IAC}${SE}`;

const COMPRESS_WILL = '\xFF\xFB\x55', COMPRESS_DO = '\xFF\xFD\x55', COMPRESS_DONT = '\xFF\xFE\x55';
const COMPRESS2_WILL = '\xFF\xFB\x56', COMPRESS2_DO = '\xFF\xFD\x56';
const MCCP1_START = '\xFF\xFA\x55\xFB\xF0'; // IAC SB COMPRESS WILL SE — no IAC before SE

describe('parseAtcpMessage — cTelnet::setATCPVariables', () => {
  it.each([
    ['Char.Vitals H:100/120 M:50/60\nNL:10/100', 'CharVitals', 'H:100/120 M:50/60 NL:10/100'],
    ['Room.Num 1234', 'RoomNum', '1234'],
    ['Char.Name Bob Bobson', 'CharName', 'Bob Bobson'],
    ['Foo.Bar x y\nz', 'FooBar', 'x y z'],
    ['Auth.Request CH', 'AuthRequest', 'CH'],
    ['Room.Exits\nn,s,e', 'RoomExits', 'n,s,e'],
    ['Foo', 'Foo', ''],
  ])('%j files %s = %j', (text, name, value) => {
    expect(parseAtcpMessage(text)).toEqual({ name, value });
  });

  it('leaves Client.Compose to the composer desktop opens for it', () => {
    expect(parseAtcpMessage('Client.Compose Title\nbody')).toBeNull();
  });
});

describe('ATCP and MCCP v1 over the wire', () => {
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
    const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    sock.onopen?.({});
    sock.sent.length = 0;
    return { client, sock, bus };
  }

  describe('1. inbound ATCP', () => {
    it('raises one atcp message per subnegotiation, named and split as desktop does', () => {
      const { sock, bus } = connected({ gmcpEnabled: false });
      const seen: Array<{ name: string; value: string }> = [];
      bus.on('atcp', m => seen.push(m));
      sock.deliver(ATCP_WILL);
      sock.deliver(atcpSb('Char.Vitals H:100/120 M:50/60\nNL:10/100') + atcpSb('Room.Num 1234'));
      sock.deliver(atcpSb('Char.Name Bob Bobson') + atcpSb('Foo.Bar x y\nz'));
      sock.deliver(atcpSb('')); // empty — ignored, as desktop's size < 6 check does
      expect(seen).toEqual([
        { name: 'CharVitals', value: 'H:100/120 M:50/60 NL:10/100' },
        { name: 'RoomNum', value: '1234' },
        { name: 'CharName', value: 'Bob Bobson' },
        { name: 'FooBar', value: 'x y z' },
      ]);
    });

    it('answers Auth.Request with the hello, after raising it', () => {
      const { sock, bus } = connected({ gmcpEnabled: false });
      sock.deliver(ATCP_WILL);
      sock.sent.length = 0;
      const order: string[] = [];
      bus.on('atcp', m => order.push(`${m.name}=${m.value}:${sentText(sock).length}`));
      sock.deliver(atcpSb('Auth.Request CH'));
      expect(order).toEqual(['AuthRequest=CH:0']);
      const sent = sentText(sock);
      expect(sent.startsWith('\xFF\xFA\xC8hello ')).toBe(true);
      expect(sent.endsWith('map_display 1\n\xFF\xF0')).toBe(true);
    });

    it('decodes the message under the server encoding', () => {
      const { sock, bus } = connected({ gmcpEnabled: false });
      const seen: string[] = [];
      bus.on('atcp', m => seen.push(m.value));
      sock.deliver(ATCP_WILL);
      sock.deliver(atcpSb('Char.Name Micha\xC5\x82'));
      expect(seen).toEqual(['Michał']);
    });
  });

  describe('2. sendATCP only while ATCP is enabled', () => {
    it('refuses before negotiation, sends once it is on, refuses after WONT', () => {
      const { client, sock } = connected({ gmcpEnabled: false });
      expect(client.sendATCP('Pre.Neg 1')).toBe(false);
      expect(sentText(sock)).toBe('');

      sock.deliver(ATCP_WILL);
      sock.sent.length = 0;
      expect(client.sendATCP('On 1')).toBe(true);
      expect(sentText(sock)).toBe(atcpSb('On 1'));

      sock.deliver(ATCP_WONT);
      sock.sent.length = 0;
      expect(client.sendATCP('Post.Wont 1')).toBe(false);
      expect(sentText(sock)).not.toContain('Post.Wont');
    });

    it('refuses while GMCP is on, which turns ATCP down', () => {
      const { client, sock } = connected({ gmcpEnabled: true });
      sock.deliver(ATCP_WILL);
      sock.sent.length = 0;
      expect(client.sendATCP('X 1')).toBe(false);
      expect(sentText(sock)).toBe('');
    });
  });

  describe('3. MCCP v1 (COMPRESS, option 85)', () => {
    it('answers WILL COMPRESS with DO COMPRESS, once', () => {
      const { sock } = connected();
      sock.deliver(COMPRESS_WILL);
      expect(sentText(sock)).toBe(COMPRESS_DO);
      sock.deliver(COMPRESS_WILL);
      expect(sentText(sock)).toBe(COMPRESS_DO);
    });

    it('turns v1 down once v2 has been accepted', () => {
      const { sock } = connected();
      sock.deliver(COMPRESS2_WILL);
      expect(sentText(sock)).toBe(COMPRESS2_DO);
      sock.sent.length = 0;
      sock.deliver(COMPRESS_WILL);
      expect(sentText(sock)).toBe(COMPRESS_DONT);
    });

    it('turns v1 down with compression forced off', () => {
      const { sock } = connected({ mccpEnabled: false });
      sock.deliver(COMPRESS_WILL);
      expect(sentText(sock)).toBe(COMPRESS_DONT);
    });

    it('decompresses the stream after IAC SB COMPRESS WILL SE', () => {
      const { sock, bus } = connected();
      sock.deliver(COMPRESS_WILL);
      const incoming: string[] = [];
      bus.on('socket.incoming', d => incoming.push(d));
      const z = zlib.deflateSync(Buffer.from('compressed line one\r\nline two\r\n', 'latin1'));
      sock.deliver('plain\r\n' + MCCP1_START + z.toString('latin1') + 'after\r\n');
      expect(incoming.join('')).toBe('plain\r\ncompressed line one\r\nline two\r\nafter\r\n');
    });
  });
});

describe('MccpHandler — v1 start sequence', () => {
  it('is not honoured unless v1 was agreed to', () => {
    const sent: string[] = [];
    const m = new MccpHandler(d => sent.push(d));
    expect(m.processData(MCCP1_START)).toBe(MCCP1_START);
    expect(m.isActive()).toBe(false);
    m.processData(COMPRESS_WILL);
    expect(sent).toEqual([COMPRESS_DO]);
    expect(m.processData(MCCP1_START)).toBe('');
    expect(m.isActive()).toBe(true);
  });

  it('forgets the agreement on WONT COMPRESS and on reset', () => {
    const m = new MccpHandler(() => {});
    m.processData(COMPRESS_WILL + '\xFF\xFC\x55');
    expect(m.processData(MCCP1_START)).toBe(MCCP1_START);
    m.processData(COMPRESS_WILL);
    m.reset();
    expect(m.processData(MCCP1_START)).toBe(MCCP1_START);
  });
});
