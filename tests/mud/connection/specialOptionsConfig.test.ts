// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import {
  TELNET_GA, TELNET_EOR,
  OPT_TTYPE, TTYPE_SEND, TTYPE_IS,
} from '../../../src/mud/protocol/constants';
import { CLIENT_NAME, CLIENT_VERSION } from '../../../src/version';
import type { MudClientEvents } from '../../../src/mud/events';

// The "Special Options" half of Mudlet's setConfig surface — the keys that only
// mean anything down at the telnet layer:
//   inputLineStrictUnixEndings  (mUSE_UNIX_EOL, cTelnet::sendData)
//   specialForceGAOff           (mFORCE_GA_OFF, cTelnet::processSocketData)
//   versionInTTYPE              (mVersionInTTYPE, TTYPE cycle step 0)
//   promptForVersionInTTYPE     (mPromptedForVersionInTTYPE + trackKaVirNegotiation)
//   promptForMXPProcessorOn     (mPromptedForMXPProcessorOn, in-band MXP gate)
// ProfileSession feeds each of these from the profile config bag; here we drive
// MudClient directly so the behaviour is pinned independently of the React layer.

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

describe('telnet-layer setConfig options', () => {
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

  // ── inputLineStrictUnixEndings ────────────────────────────────────────────

  describe('inputLineStrictUnixEndings', () => {
    it('terminates commands with CRLF by default', () => {
      const { client, sock } = connected();
      client.send('look');
      expect(sentText(sock)).toBe('look\r\n');
    });

    it('terminates commands with a bare LF when enabled', () => {
      const { client, sock } = connected({ inputLineStrictUnixEndings: true });
      client.send('look');
      expect(sentText(sock)).toBe('look\n');
    });

    // Mudlet reads mUSE_UNIX_EOL per send in cTelnet::sendData, so the setter is
    // live rather than latched at connect like the negotiation flags.
    it('applies a live change to the next command', () => {
      const { client, sock } = connected();
      client.setInputLineStrictUnixEndings(true);
      client.send('north');
      expect(sentText(sock)).toBe('north\n');
      client.setInputLineStrictUnixEndings(false);
      sock.sent.length = 0;
      client.send('south');
      expect(sentText(sock)).toBe('south\r\n');
    });
  });

  // ── specialForceGAOff ─────────────────────────────────────────────────────

  describe('specialForceGAOff', () => {
    function collect(opts: Record<string, unknown> = {}) {
      const bus = new EventBus<MudClientEvents>();
      const client = new MudClient({ url: 'ws://test.invalid', ...opts }, bus);
      const out = { text: '', prompts: 0 };
      bus.on('flushLines', (groups) => { for (const g of groups) out.text += g.text; });
      bus.on('prompt', () => { out.prompts++; });
      return { client, out };
    }

    it('treats IAC GA as a prompt marker by default', () => {
      const { client, out } = collect();
      client.feedTelnet('Hp: 100 > ' + TELNET_GA);
      expect(out.text).toBe('Hp: 100 > ');
      expect(out.prompts).toBe(1);
    });

    it('turns IAC GA into a newline and raises no prompt when forced off', () => {
      const { client, out } = collect({ specialForceGAOff: true });
      client.feedTelnet('Hp: 100 > ' + TELNET_GA);
      // Mudlet's else branch pushes '\n' where the marker was, so the tail
      // becomes a complete line instead of a held-back prompt.
      expect(out.text).toBe('Hp: 100 > \n');
      expect(out.prompts).toBe(0);
    });

    it('does the same for IAC EOR', () => {
      const { client, out } = collect({ specialForceGAOff: true });
      client.feedTelnet('Hp: 100 > ' + TELNET_EOR);
      expect(out.text).toBe('Hp: 100 > \n');
      expect(out.prompts).toBe(0);
    });

    it('substitutes the newline in place, not at the end of the frame', () => {
      const { client, out } = collect({ specialForceGAOff: true });
      client.feedTelnet('Hp: 100 > ' + TELNET_GA + 'You wake up.\r\n');
      expect(out.text).toBe('Hp: 100 > \nYou wake up.\n');
    });

    it('leaves a GA-looking byte pair inside a subnegotiation payload alone', () => {
      // IAC SB MSSP … IAC SE where the body happens to contain \xF9. The parser
      // consumes the whole subnegotiation as one sequence, so no newline is
      // injected into the visible text.
      const { client, out } = collect({ specialForceGAOff: true, msspEnabled: true });
      client.feedTelnet('\xFF\xFA\x46\x01NAME\x02A\xF9B\xFF\xF0Hello\r\n');
      expect(out.text).toBe('Hello\n');
    });
  });

  // ── versionInTTYPE ────────────────────────────────────────────────────────

  describe('versionInTTYPE', () => {
    /** Ask for the first TTYPE cycle value and return what we replied with. */
    function firstTtypeReply(opts: Record<string, unknown> = {}): string {
      const { sock } = connected({ mttsEnabled: true, ...opts });
      sock.deliver('\xFF\xFA' + OPT_TTYPE + TTYPE_SEND + '\xFF\xF0');
      const prefix = '\xFF\xFA' + OPT_TTYPE + TTYPE_IS;
      const reply = sentText(sock);
      const start = reply.indexOf(prefix) + prefix.length;
      return reply.slice(start, reply.indexOf('\xFF\xF0', start));
    }

    it('reports the bare client name by default', () => {
      expect(firstTtypeReply()).toBe(CLIENT_NAME);
    });

    it('appends the client version when enabled', () => {
      expect(firstTtypeReply({ versionInTTYPE: true })).toBe(`${CLIENT_NAME} ${CLIENT_VERSION}`);
    });

    it('leaves the terminal-type and MTTS cycle steps untouched', () => {
      const { sock } = connected({ mttsEnabled: true, versionInTTYPE: true });
      const send = '\xFF\xFA' + OPT_TTYPE + TTYPE_SEND + '\xFF\xF0';
      sock.deliver(send);
      sock.deliver(send);
      sock.deliver(send);
      const reply = sentText(sock);
      // Only step 0 carries the version; step 1 is the terminal type and step 2
      // the MTTS bitvector (ctelnet.cpp case 0 vs cases 1/2).
      expect(reply).toContain(`${CLIENT_NAME} ${CLIENT_VERSION}`);
      expect(reply).toContain('MTTS ');
      expect(reply).not.toContain(`MTTS ${CLIENT_VERSION}`);
    });
  });

  // ── promptForVersionInTTYPE / KaVir detection ─────────────────────────────

  describe('KaVir protocol detection', () => {
    // The fingerprint from expectedOrderForKaVirHandler (ctelnet.cpp):
    // TTYPE, NAWS, CHARSET, MSDP, MSSP, ATCP, MSP, MXP.
    const KAVIR = [24, 31, 42, 69, 70, 200, 90, 91];
    const will = (opt: number) => '\xFF\xFB' + String.fromCharCode(opt);
    const doo  = (opt: number) => '\xFF\xFD' + String.fromCharCode(opt);

    // Option negotiation only runs on real socket frames (MudClient routes them
    // through TelnetNegotiator.processFrame before the text pipeline), so these
    // deliver through the mock socket rather than feedTelnet.
    function detector(opts: Record<string, unknown> = {}) {
      const { sock, bus } = connected(opts);
      const hits = { n: 0 };
      bus.on('kavir.detected', () => { hits.n++; });
      return { sock, hits };
    }

    it('fires when the server offers the fingerprint order', () => {
      const { sock, hits } = detector();
      for (const opt of KAVIR) sock.deliver(will(opt));
      expect(hits.n).toBe(1);
    });

    it('counts DO the same as WILL', () => {
      const { sock, hits } = detector();
      for (const opt of KAVIR) sock.deliver(doo(opt));
      expect(hits.n).toBe(1);
    });

    it('matches on the trailing window, ignoring earlier options', () => {
      const { sock, hits } = detector();
      sock.deliver(will(1) + will(3) + will(25));
      for (const opt of KAVIR) sock.deliver(will(opt));
      expect(hits.n).toBe(1);
    });

    it('does not fire for the same options in a different order', () => {
      const { sock, hits } = detector();
      const shuffled = [31, 24, 42, 69, 70, 200, 90, 91];
      for (const opt of shuffled) sock.deliver(will(opt));
      expect(hits.n).toBe(0);
    });

    it('does not fire when an unrelated option interrupts the run', () => {
      const { sock, hits } = detector();
      for (const opt of [24, 31, 42, 69, 86, 70, 200, 90, 91]) sock.deliver(will(opt));
      expect(hits.n).toBe(0);
    });

    it('fires at most once per connection', () => {
      const { sock, hits } = detector();
      for (const opt of KAVIR) sock.deliver(will(opt));
      for (const opt of KAVIR) sock.deliver(will(opt));
      expect(hits.n).toBe(1);
    });

    // mPromptedForVersionInTTYPE: the profile has already been through this, so
    // a user who turned versionInTTYPE back off is not overridden.
    it('stays silent once the profile has been prompted', () => {
      const { sock, hits } = detector({ promptForVersionInTTYPE: true });
      for (const opt of KAVIR) sock.deliver(will(opt));
      expect(hits.n).toBe(0);
    });
  });

  // ── promptForMXPProcessorOn / in-band MXP gate ────────────────────────────

  describe('in-band MXP detection gate', () => {
    function mxpDetector(opts: Record<string, unknown> = {}) {
      const { sock, bus } = connected(opts);
      const seen: boolean[] = [];
      bus.on('mxp.negotiated', (viaTelnet) => { seen.push(viaTelnet); });
      return { sock, seen };
    }

    it('starts MXP from an in-band ESC[1z on a fresh profile', () => {
      const { sock, seen } = mxpDetector();
      sock.deliver('\x1b[1z<b>Hi</b>\r\n');
      expect(seen).toEqual([false]);
    });

    it('stops auto-starting once prompted and no longer forced on', () => {
      // Mudlet's gate: mForceMXPProcessorOn || !mPromptedForMXPProcessorOn.
      const { sock, seen } = mxpDetector({ promptForMXPProcessorOn: true });
      sock.deliver('\x1b[1z<b>Hi</b>\r\n');
      expect(seen).toEqual([]);
    });

    it('keeps auto-starting when prompted but still forced on', () => {
      const { sock, seen } = mxpDetector({
        promptForMXPProcessorOn: true,
        specialForceMXPProcessorOn: true,
      });
      sock.deliver('\x1b[1z<b>Hi</b>\r\n');
      expect(seen).toEqual([false]);
    });

    it('is unaffected by the gate when MXP negotiates over telnet option 91', () => {
      const { sock, seen } = mxpDetector({ promptForMXPProcessorOn: true });
      sock.deliver('\xFF\xFB\x5B'); // IAC WILL MXP
      expect(seen).toEqual([true]);
    });
  });
});
