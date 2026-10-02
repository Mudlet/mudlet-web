// @vitest-environment node
//
// Telnet negotiation drift against desktop Mudlet, measured with the real
// Mudlet PTB and a byte-logging test MUD (issue #286). Every expectation here is
// the byte sequence desktop sends for the same input; where the client name
// differs it is Mudlet Web's own ("MUDLET-WEB" for "MUDLET").
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { MudSession } from '../../../src/mud/MudSession';
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

  take(): string {
    const out = this.sent.map(b => String.fromCharCode(...b)).join('');
    this.sent.length = 0;
    return out;
  }
}

const IAC = '\xFF', SB = '\xFA', SE = '\xF0', WILL = '\xFB', DO = '\xFD', DONT = '\xFE';
const sb = (body: string) => IAC + SB + body + IAC + SE;
const b = (n: number) => String.fromCharCode(n);
const naws = (w: number, h: number) => sb('\x1F' + b(w >> 8) + b(w & 0xff) + b(h >> 8) + b(h & 0xff));
const NAWS_DO = IAC + DO + '\x1F';
const TTYPE_SEND = sb('\x18\x01');
const ttypeIs = (value: string) => sb('\x18\x00' + value);
const NEW_ENVIRON_DO = IAC + DO + '\x27';

describe('telnet negotiation matches desktop Mudlet (#286)', () => {
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
    sock.take();
    return { client, sock, bus };
  }

  describe('1. NAWS reports min(columns, wrap), and follows wrap and font changes', () => {
    it('caps the width at the wrap column (desktop default 100)', () => {
      const { client, sock } = connected();
      client.setWindowSize(169, 43);
      sock.deliver(NAWS_DO);
      expect(sock.take()).toBe(IAC + WILL + '\x1F' + naws(100, 43));
    });

    it('re-sends when the wrap changes, and when the font changes the grid', () => {
      const { client, sock } = connected();
      client.setWrapAt(100);
      client.setWindowSize(169, 43);
      sock.deliver(NAWS_DO);
      sock.take();
      client.setWrapAt(60);                 // setWindowWrap("main", 60)
      expect(sock.take()).toBe(naws(60, 43));
      client.setWrapAt(250);                // setWindowWrap("main", 250): the window is narrower
      expect(sock.take()).toBe(naws(169, 43));
      client.setWindowSize(93, 30);         // setFontSize("main", 20): fewer, taller cells
      expect(sock.take()).toBe(naws(93, 30));
    });

    it('sends nothing when the reported size is unchanged', () => {
      const { client, sock } = connected();
      client.setWindowSize(169, 43);
      sock.deliver(NAWS_DO);
      sock.take();
      client.setWindowSize(180, 43);        // still capped at 100
      client.setWrapAt(100);
      expect(sock.take()).toBe('');
    });

    it('answers every DO NAWS, even with the size unchanged', () => {
      const { client, sock } = connected();
      client.setWindowSize(80, 24);
      sock.deliver(NAWS_DO);
      sock.take();
      sock.deliver(NAWS_DO);
      expect(sock.take()).toBe(naws(80, 24));
    });

    it('takes the timestamp gutter off the width, after the wrap cap', () => {
      const { client, sock } = connected();
      client.setWindowSize(169, 43);
      client.setTimestampsShown(true);
      sock.deliver(NAWS_DO);
      expect(sock.take()).toContain(naws(87, 43)); // min(169, 100) - 13
    });

    it('reports the window width when wrapping is switched off (wrap 0)', () => {
      const { client, sock } = connected();
      client.setWrapAt(0);
      client.setWindowSize(169, 43);
      sock.deliver(NAWS_DO);
      expect(sock.take()).toContain(naws(169, 43));
    });

    it('a session seeds each new client with the wrap it was told', () => {
      const session = new MudSession();
      session.setWrapAt(60);
      session.setWindowSize(169, 43);
      session.connect('ws://test.invalid');
      const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      sock.onopen?.({});
      sock.take();
      sock.deliver(NAWS_DO);
      expect(sock.take()).toContain(naws(60, 43));
      session.destroy();
    });
  });

  describe('2. NEW-ENVIRON WORD_WRAP is the wrap column', () => {
    it('reports the wrap, not the window width', () => {
      const { client, sock } = connected({ newEnvironEnabled: true });
      client.setWindowSize(180, 43);
      client.setWrapAt(100);
      sock.deliver(NEW_ENVIRON_DO);
      sock.take();
      sock.deliver(sb('\x27\x01\x03WORD_WRAP'));
      expect(sock.take()).toBe(sb('\x27\x00\x03WORD_WRAP\x01100'));
    });
  });

  describe('3. the TTYPE cycle wraps around', () => {
    it('sends name, type, MTTS, MTTS, then starts over', () => {
      const { sock } = connected();
      sock.deliver(IAC + DO + '\x18');
      sock.take();
      const replies: string[] = [];
      for (let i = 0; i < 9; i++) {
        sock.deliver(TTYPE_SEND);
        replies.push(sock.take());
      }
      const name = ttypeIs('MUDLET-WEB'), type = ttypeIs('ANSI-TRUECOLOR'), mtts = ttypeIs('MTTS 2349');
      expect(replies).toEqual([name, type, mtts, mtts, name, type, mtts, mtts, name]);
    });

    it('repeats the client name alone with MTTS off', () => {
      const { sock } = connected({ mttsEnabled: false });
      sock.deliver(IAC + DO + '\x18');
      sock.take();
      for (let i = 0; i < 3; i++) {
        sock.deliver(TTYPE_SEND);
        expect(sock.take()).toBe(ttypeIs('MUDLET-WEB'));
      }
    });
  });

  describe('4. MTTS carries SSL (2048) and MNES (512)', () => {
    const toMtts = (sock: MockWebSocket): string => {
      sock.deliver(IAC + DO + '\x18');
      sock.deliver(TTYPE_SEND);
      sock.deliver(TTYPE_SEND);
      sock.take();
      sock.deliver(TTYPE_SEND);
      return sock.take();
    };

    it('advertises SSL by default, whatever the transport', () => {
      expect(toMtts(connected().sock)).toBe(ttypeIs('MTTS 2349'));
      expect(toMtts(connected({ url: 'wss://test.invalid' }).sock)).toBe(ttypeIs('MTTS 2349'));
    });

    it('reports TLS=1 in NEW-ENVIRON', () => {
      const { sock } = connected({ newEnvironEnabled: true });
      sock.deliver(NEW_ENVIRON_DO);
      sock.take();
      sock.deliver(sb('\x27\x01\x03TLS'));
      expect(sock.take()).toBe(sb('\x27\x00\x03TLS\x011'));
    });

    it('adds MNES when MNES and NEW-ENVIRON are both on, in TTYPE and in the MNES reply', () => {
      const { sock } = connected({ mnesEnabled: true, newEnvironEnabled: true });
      expect(toMtts(sock)).toBe(ttypeIs('MTTS 2861'));
      sock.deliver(NEW_ENVIRON_DO);
      sock.take();
      sock.deliver(sb('\x27\x01\x00MTTS'));
      expect(sock.take()).toBe(sb('\x27\x00\x00MTTS\x012861'));
    });

    it('leaves MNES out while NEW-ENVIRON is off', () => {
      expect(toMtts(connected({ mnesEnabled: true }).sock)).toBe(ttypeIs('MTTS 2349'));
    });
  });

  describe('5. AYT and STATUS SEND are answered', () => {
    it('answers IAC AYT with a raw YES', () => {
      const { sock } = connected();
      sock.deliver(IAC + '\xF6');
      expect(sock.take()).toBe('YES');
    });

    it('answers STATUS SEND with the options on each side', () => {
      const { sock } = connected();
      sock.deliver(IAC + WILL + '\x05');   // → DO STATUS
      sock.deliver(IAC + DO + '\x05');     // → WILL STATUS
      sock.deliver(IAC + WILL + '\x01');   // → DO ECHO, sent by the echo handler
      sock.take();
      sock.deliver(sb('\x05\x01'));
      expect(sock.take()).toBe(sb('\x05\x00' + DO + '\x01' + WILL + '\x05' + DO + '\x05'));
    });

    it('ignores a STATUS subnegotiation that is not a bare SEND', () => {
      const { sock } = connected();
      sock.deliver(sb('\x05\x00' + WILL + '\x05'));
      expect(sock.take()).toBe('');
    });
  });

  describe('6. NEW-ENVIRON requests for unknown or empty variables', () => {
    it('lists an unknown variable without a VALUE', () => {
      const { sock } = connected({ newEnvironEnabled: true });
      sock.deliver(NEW_ENVIRON_DO);
      sock.take();
      sock.deliver(sb('\x27\x01\x00IPADDRESS\x03CLIENT_NAME'));
      expect(sock.take()).toBe(sb('\x27\x00\x00IPADDRESS\x03CLIENT_NAME\x01MUDLET-WEB'));
    });

    it('answers SEND VAR with no names with an empty IS', () => {
      const { sock } = connected({ newEnvironEnabled: true });
      sock.deliver(NEW_ENVIRON_DO);
      sock.take();
      sock.deliver(sb('\x27\x01\x00'));
      expect(sock.take()).toBe(sb('\x27\x00'));
    });
  });

  describe('7. CHARSET translate tables are rejected', () => {
    it('rejects a REQUEST that opens with [TTABLE]', () => {
      const { client, sock } = connected();
      sock.deliver(IAC + WILL + '\x2A');
      sock.take();
      sock.deliver(sb('\x2A\x01[TTABLE]\x01;ISO-8859-2;UTF-8'));
      expect(sock.take()).toBe(sb('\x2A\x03'));
      expect(client.getServerEncoding()).not.toBe('UTF-8');
    });

    it('answers TTABLE-IS with TTABLE-REJECTED', () => {
      const { sock } = connected();
      sock.deliver(IAC + WILL + '\x2A');
      sock.take();
      sock.deliver(sb('\x2A\x04\x01;x'));
      expect(sock.take()).toBe(sb('\x2A\x05'));
    });
  });

  describe('8. specialForceCompressionOff refuses MCCP', () => {
    it('answers WILL COMPRESS2 and WILL COMPRESS with DONT', () => {
      const { sock } = connected({ mccpEnabled: false });
      sock.deliver(IAC + WILL + '\x56');
      expect(sock.take()).toBe(IAC + DONT + '\x56');
      sock.deliver(IAC + WILL + '\x55');
      expect(sock.take()).toBe(IAC + DONT + '\x55');
    });

    it('still accepts COMPRESS2 when compression is allowed', () => {
      const { sock } = connected();
      sock.deliver(IAC + WILL + '\x56');
      expect(sock.take()).toBe(IAC + DO + '\x56');
    });
  });
});
