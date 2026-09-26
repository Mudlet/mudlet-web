// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { CLIENT_NAME, CLIENT_VERSION } from '../../../src/version';
import type { MudClientEvents } from '../../../src/mud/events';

// Telnet negotiation checked byte for byte against desktop Mudlet's
// cTelnet::processTelnetCommand (#179): what sysTelnetEvent carries, and the
// answer every option gets once nothing specific to it applies.

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

const sentText = (sock: MockWebSocket): string =>
  sock.sent.map(b => String.fromCharCode(...b)).join('');

const IAC = '\xFF', SB = '\xFA', SE = '\xF0';
const WILL = '\xFB', WONT = '\xFC', DO = '\xFD', DONT = '\xFE';
const cmd = (c: string, opt: number) => IAC + c + String.fromCharCode(opt);

describe('telnet negotiation parity with desktop Mudlet', () => {
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
    const events: [number, number, string][] = [];
    bus.on('telnet.event', (type, option, msg) => events.push([type, option, msg]));
    return { client, sock, bus, events };
  }

  describe('sysTelnetEvent', () => {
    it('carries the command byte as its type and the SB body as its message', () => {
      const { client, sock, events } = connected();
      client.addSupportedTelnetOption(150);
      sock.deliver(cmd(WILL, 150));
      sock.deliver(IAC + SB + '\x96payload' + IAC + SE);
      sock.deliver(cmd(DO, 151));
      expect(events.map(([t, o]) => [t, o])).toEqual([[251, 150], [250, 150], [253, 151]]);
      expect(events[1][2]).toBe('payload');
    });

    it('is raised for the options Mudlet Web negotiates itself', () => {
      const { sock, events } = connected({ msdpEnabled: true });
      sock.deliver(cmd(WILL, 201) + cmd(WILL, 69));
      expect(events.map(([t, o]) => [t, o])).toEqual([[251, 201], [251, 69]]);
    });

    it('raises every subnegotiation in a packet, payload decoded as UTF-8', () => {
      const { sock, events } = connected();
      const utf8 = String.fromCharCode(...new TextEncoder().encode('Zażółć'));
      sock.deliver(IAC + SB + '\x96one' + IAC + SE + IAC + SB + '\x96' + utf8 + IAC + SE);
      expect(events).toEqual([[250, 150, 'one'], [250, 150, 'Zażółć']]);
    });

    it('is raised for two-byte commands, but not for GA, EOR or a stray SE', () => {
      const { sock, events } = connected();
      sock.deliver('>' + IAC + '\xF9' + IAC + '\xEF' + IAC + SE + IAC + '\xF1');
      expect(events.map(([t, o]) => [t, o])).toEqual([[241, 0]]); // NOP
    });
  });

  describe('options nothing specific answers', () => {
    it('refuses an unknown option from either direction', () => {
      const { sock } = connected();
      sock.deliver(cmd(DO, 99) + cmd(WILL, 99));
      expect(sentText(sock)).toBe(cmd(WONT, 99) + cmd(DONT, 99));
    });

    it.each([
      ['DO ECHO', cmd(DO, 1), cmd(WONT, 1)],
      ['DO SGA', cmd(DO, 3), cmd(WONT, 3)],
      ['DO TSPEED', cmd(DO, 32), cmd(WONT, 32)],
      ['DO BINARY', cmd(DO, 0), cmd(WONT, 0)],
      ['WILL BINARY', cmd(WILL, 0), cmd(DONT, 0)],
      ['an unrequested WILL ATCP', cmd(WILL, 200), cmd(DONT, 200)],
      ['DO EOR', cmd(DO, 25), cmd(WONT, 25)],
      ['DO COMPRESS2', cmd(DO, 86), cmd(WONT, 86)],
    ])('refuses %s', (_name, inbound, reply) => {
      const { sock } = connected();
      sock.deliver(inbound);
      expect(sentText(sock)).toBe(reply);
    });

    it('takes STATUS up from either direction, answering each only once', () => {
      const { sock } = connected();
      sock.deliver(cmd(WILL, 5) + cmd(WILL, 5) + cmd(DO, 5) + cmd(DO, 5));
      expect(sentText(sock)).toBe(cmd(DO, 5) + cmd(WILL, 5));
    });

    it('answers every DO TIMING-MARK with WONT', () => {
      const { sock } = connected();
      sock.deliver(cmd(DO, 6) + cmd(DO, 6));
      expect(sentText(sock)).toBe(cmd(WONT, 6) + cmd(WONT, 6));
    });

    it('acknowledges a WONT only once the server has announced the option', () => {
      const { sock } = connected();
      sock.deliver(cmd(WONT, 99));
      expect(sentText(sock)).toBe('');
      sock.deliver(cmd(WILL, 99) + cmd(WONT, 99));
      expect(sentText(sock)).toBe(cmd(DONT, 99) + cmd(DONT, 99));
    });

    it('answers a DONT with WONT the first time, then only while it is on', () => {
      const { sock } = connected();
      sock.deliver(cmd(DONT, 99) + cmd(DONT, 99));
      expect(sentText(sock)).toBe(cmd(WONT, 99));
    });

    it('withdraws NAWS on DONT and offers it again on the next DO', () => {
      const { sock } = connected();
      sock.deliver(cmd(DO, 31));
      sock.sent.length = 0;
      sock.deliver(cmd(DONT, 31));
      expect(sentText(sock)).toBe(cmd(WONT, 31));
      sock.sent.length = 0;
      sock.deliver(cmd(DO, 31));
      expect(sentText(sock).startsWith(cmd(WILL, 31) + IAC + SB + '\x1F')).toBe(true);
    });

    it('still takes registered options up from both directions', () => {
      const { client, sock } = connected();
      client.addSupportedTelnetOption(93);
      sock.deliver(cmd(WILL, 93) + cmd(DO, 93));
      expect(sentText(sock)).toBe(cmd(DO, 93) + cmd(WILL, 93));
    });
  });

  describe('MSDP start sequence', () => {
    it('follows DO MSDP with LIST COMMANDS and the client name and version', () => {
      const { sock } = connected({ msdpEnabled: true });
      sock.deliver(cmd(WILL, 69));
      expect(sentText(sock)).toBe(
        cmd(DO, 69)
        + IAC + SB + 'E\x01LIST\x02COMMANDS' + IAC + SE
        + IAC + SB + 'E\x01CLIENT_NAME\x02' + CLIENT_NAME + '\x01CLIENT_VERSION\x02' + CLIENT_VERSION + IAC + SE,
      );
    });

    it('answers a server DO MSDP with WILL alone', () => {
      const { sock } = connected({ msdpEnabled: true });
      sock.deliver(cmd(DO, 69));
      expect(sentText(sock)).toBe(cmd(WILL, 69));
    });
  });
});
