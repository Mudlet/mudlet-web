// @vitest-environment node
// mudlet-web#384 — processing order against desktop: text around an MCCP start
// or end was processed after out-of-band data from the other side of the
// boundary, and telnet negotiation after a GA was applied before the text up
// to that GA.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import zlib from 'node:zlib';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { MccpHandler } from '../../../src/mud/protocol/mccp';
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

const IAC = '\xFF', SB = '\xFA', SE = '\xF0', GA = '\xFF\xF9';
const GMCP_WILL = '\xFF\xFB\xC9', GMCP_WONT = '\xFF\xFC\xC9';
const ECHO_WILL = '\xFF\xFB\x01';
const COMPRESS2_WILL = '\xFF\xFB\x56';
const MCCP2_START = '\xFF\xFA\x56\xFF\xF0';
const gmcp = (body: string) => `${IAC}${SB}\xC9${body}${IAC}${SE}`;
const latin1 = (buf: Buffer) => String.fromCharCode(...buf);
const deflate = (s: string, final: boolean) => {
  const buf = Buffer.from(s, 'latin1');
  return latin1(final ? zlib.deflateSync(buf) : zlib.deflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
};

describe('mudlet-web#384 — processing order', () => {
  let realWebSocket: unknown;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  });

  /** A connected client whose bus logs, in order, each GMCP message, each
   *  line handed to the triggers, and each negotiation event. */
  function connected() {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid' }, bus);
    client.connect();
    const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    sock.onopen?.({});
    const log: string[] = [];
    bus.on('gmcp', ({ path, value }) => log.push(`gmcp ${path} ${JSON.stringify(value)}`));
    bus.on('flushLines', (groups) => {
      for (const g of groups) for (const line of g.text.split('\n')) if (line) log.push(`line ${line}`);
    });
    bus.on('telnet.event', (type, option) => log.push(`telnet ${type} ${option}`));
    bus.on('telnet.echo', (mask) => log.push(`echo ${mask}`));
    return { client, sock, log, bus };
  }

  describe('2. MCCP boundaries', () => {
    it('processes the plain text before an MCCP start before inflating the rest', () => {
      const { sock, log } = connected();
      sock.deliver(GMCP_WILL + COMPRESS2_WILL);
      log.length = 0;
      sock.deliver('LINE A1\r\n' + gmcp('Num 2') + MCCP2_START
        + deflate('LINE C1\r\n' + gmcp('Num 3') + 'LINE C2\r\n', false));
      // Desktop: evG 2 | trig LINE A1 (sees num=2) | evG 3 | trig LINE C1 …
      expect(log).toEqual(['gmcp Num 2', 'line LINE A1', 'gmcp Num 3', 'line LINE C1', 'line LINE C2']);
    });

    it('processes the inflated text before the plain text after the stream ends', () => {
      const { sock, log } = connected();
      sock.deliver(GMCP_WILL + COMPRESS2_WILL);
      sock.deliver(MCCP2_START);
      log.length = 0;
      sock.deliver(deflate('LINE F1\r\n', true) + gmcp('Num 3') + 'LINE F2\r\n');
      // Desktop: trig LINE F1 | evG 3 | trig LINE F2
      expect(log).toEqual(['line LINE F1', 'gmcp Num 3', 'line LINE F2']);
    });

    it('still joins the pieces for processData', () => {
      // A start sequence counts only once the offer has been taken up.
      const accepted = (): MccpHandler => {
        const h = new MccpHandler(() => {});
        h.processChunks(COMPRESS2_WILL);
        return h;
      };
      const h = accepted();
      expect(h.processChunks('plain')).toEqual(['plain']);
      expect(h.processChunks(MCCP2_START)).toEqual(['']);
      const h2 = accepted();
      const data = 'A\r\n' + MCCP2_START + deflate('B\r\n', true) + 'C\r\n';
      expect(h2.processChunks(data)).toEqual(['A\r\n', 'B\r\n', 'C\r\n']);
      const h3 = accepted();
      expect(h3.processData(data)).toBe('A\r\nB\r\nC\r\n');
    });
  });

  describe('3. negotiation after a GA', () => {
    it('applies WILL GMCP after the prompt it follows has been processed', () => {
      const { sock, log } = connected();
      sock.deliver('LINE A\r\nP1>' + GA + GMCP_WILL + 'LINE B\r\n');
      // Desktop: trig LINE A | prompt P1> | sysTelnetEvent 251 201 | trig LINE B
      expect(log).toEqual(['line LINE A', 'line P1>', 'telnet 251 201', 'line LINE B']);
    });

    it('applies WONT GMCP after the prompt too', () => {
      const { sock, log } = connected();
      sock.deliver(GMCP_WILL);
      log.length = 0;
      sock.deliver('P1>' + GA + GMCP_WONT + 'LINE B\r\n');
      expect(log).toEqual(['line P1>', 'telnet 252 201', 'line LINE B']);
    });

    it('turns server echo on only once the prompt before it is processed', () => {
      const { sock, client, log, bus } = connected();
      // What a prompt trigger would read: is the server echoing yet?
      const echoingAtPrompt: boolean[] = [];
      bus.on('flushLines', () => echoingAtPrompt.push(!client.shouldEchoCommand()));
      sock.deliver('Password:' + GA + ECHO_WILL);
      expect(log[0]).toBe('line Password:');
      expect(log.slice(1).sort()).toEqual(['echo true', 'telnet 251 1']);
      expect(echoingAtPrompt).toEqual([false]);
      expect(client.shouldEchoCommand()).toBe(false);
    });

    it('still applies negotiation before the text that follows it in the same run', () => {
      const { sock, log } = connected();
      sock.deliver(GMCP_WILL + 'LINE A\r\n');
      expect(log).toEqual(['telnet 251 201', 'line LINE A']);
    });
  });
});
