// @vitest-environment node
//
// Config-effect drift against the Mudlet PTB (mudlet-web#379): settings changed
// with setConfig mid-session, compared on the wire. Every expectation is what
// desktop sends for the same sequence. Item 4 (f3SearchEnabled) is in
// tests/ui/f3SearchDrift379.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudSession } from '../../../src/mud/MudSession';
import { CLIENT_NAME, CLIENT_VERSION } from '../../../src/version';

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

const IAC = '\xFF', SB = '\xFA', SE = '\xF0', WILL = '\xFB', DO = '\xFD';
const sb = (body: string) => IAC + SB + body + IAC + SE;
const b = (n: number) => String.fromCharCode(n);
const naws = (w: number, h: number) => sb('\x1F' + b(w >> 8) + b(w & 0xff) + b(h >> 8) + b(h & 0xff));
const NAWS_DO = IAC + DO + '\x1F';
const TTYPE_DO = IAC + DO + '\x18';
const TTYPE_SEND = sb('\x18\x01');
const ttypeIs = (value: string) => sb('\x18\x00' + value);
const COMPRESS2_WILL = IAC + WILL + '\x56';
const COMPRESS2_DO = IAC + DO + '\x56';

describe('setConfig mid-session matches desktop Mudlet (#379)', () => {
  let realWebSocket: unknown;
  let session: MudSession;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
    MockWebSocket.instances = [];
    session = new MudSession();
  });
  afterEach(() => {
    session.destroy();
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  });

  function connect(): MockWebSocket {
    session.connect('ws://test.invalid');
    const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    sock.onopen?.({});
    sock.take();
    return sock;
  }

  describe('1. enableNAWS off stops NAWS reports at once', () => {
    it('sends SB NAWS for 60 and 40 only', () => {
      session.setWindowSize(169, 43);
      const sock = connect();
      sock.deliver(NAWS_DO);
      expect(sock.take()).toBe(IAC + WILL + '\x1F' + naws(100, 43));

      session.setWrapAt(60);
      expect(sock.take()).toBe(naws(60, 43));
      session.setProtocolOptions({ nawsEnabled: false });
      session.setWrapAt(50);
      session.setWrapAt(45);
      expect(sock.take()).toBe('');
      session.setProtocolOptions({ nawsEnabled: true });
      expect(sock.take()).toBe('');
      session.setWrapAt(40);
      expect(sock.take()).toBe(naws(40, 43));
    });

    it('a window resize while off is not reported either', () => {
      session.setWindowSize(80, 24);
      const sock = connect();
      sock.deliver(NAWS_DO);
      sock.take();
      session.setProtocolOptions({ nawsEnabled: false });
      session.setWindowSize(70, 20);
      expect(sock.take()).toBe('');
    });
  });

  describe('2. versionInTTYPE applies to the next SB TTYPE SEND', () => {
    it('adds the version without a reconnect', () => {
      // MTTS off keeps every SEND on the client-name step of the cycle.
      session.setProtocolOptions({ mttsEnabled: false });
      const sock = connect();
      sock.deliver(TTYPE_DO);
      sock.deliver(TTYPE_SEND);
      expect(sock.take()).toBe(IAC + WILL + '\x18' + ttypeIs(CLIENT_NAME));
      session.setVersionInTTYPE(true);
      sock.deliver(TTYPE_SEND);
      expect(sock.take()).toBe(ttypeIs(`${CLIENT_NAME} ${CLIENT_VERSION}`));
      session.setVersionInTTYPE(false);
      sock.deliver(TTYPE_SEND);
      expect(sock.take()).toBe(ttypeIs(CLIENT_NAME));
    });

    it('the next cycle after the MTTS steps carries it too', () => {
      const sock = connect();
      sock.deliver(TTYPE_DO);
      for (let i = 0; i < 4; i++) sock.deliver(TTYPE_SEND); // name, type, MTTS, MTTS
      sock.take();
      session.setVersionInTTYPE(true);
      sock.deliver(TTYPE_SEND);
      expect(sock.take()).toBe(ttypeIs(`${CLIENT_NAME} ${CLIENT_VERSION}`));
    });
  });

  describe('3. an option that is already on is not answered again', () => {
    it('no settings changed: WILL COMPRESS2 and DO TTYPE go unanswered', () => {
      const sock = connect();
      sock.deliver(COMPRESS2_WILL + TTYPE_DO);
      expect(sock.take()).toBe(COMPRESS2_DO + IAC + WILL + '\x18');
      sock.deliver(COMPRESS2_WILL);
      sock.deliver(TTYPE_DO);
      expect(sock.take()).toBe('');
    });

    it('NAWS off and compression forced off: nothing for WILL COMPRESS2, DO NAWS or DO TTYPE', () => {
      session.setWindowSize(80, 24);
      const sock = connect();
      sock.deliver(COMPRESS2_WILL + NAWS_DO + TTYPE_DO);
      expect(sock.take()).toBe(COMPRESS2_DO + IAC + WILL + '\x1F' + naws(80, 24) + IAC + WILL + '\x18');

      session.setProtocolOptions({ nawsEnabled: false, mccpEnabled: false });
      sock.deliver(COMPRESS2_WILL);
      sock.deliver(NAWS_DO);
      sock.deliver(TTYPE_DO);
      expect(sock.take()).toBe('');
    });

    it('a repeated DO NAWS re-sends the size but not WILL, and raises no second sysProtocolEnabled', () => {
      session.setWindowSize(80, 24);
      const sock = connect();
      const enabled: string[] = [];
      session.events.on('protocol.enabled', name => enabled.push(name));
      sock.deliver(NAWS_DO);
      sock.take();
      sock.deliver(NAWS_DO);
      expect(sock.take()).toBe(naws(80, 24));
      expect(enabled).toEqual(['NAWS']);
    });

    it('MCCP v1 too: a repeat WILL COMPRESS goes unanswered once forced off', () => {
      const sock = connect();
      sock.deliver(IAC + WILL + '\x55');
      expect(sock.take()).toBe(IAC + DO + '\x55');
      session.setProtocolOptions({ mccpEnabled: false });
      sock.deliver(IAC + WILL + '\x55');
      expect(sock.take()).toBe('');
    });

    it('compression forced off mid-session turns a first offer down', () => {
      const sock = connect();
      session.setProtocolOptions({ mccpEnabled: false });
      sock.deliver(COMPRESS2_WILL);
      expect(sock.take()).toBe(IAC + '\xFE' + '\x56');
    });
  });
});
