// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import { GMCP_COMMAND_CODE, GMCP_IAC, GMCP_SB, GMCP_SE, GMCP_WILL } from '../../../src/mud/protocol/constants';
import type { MudClientEvents } from '../../../src/mud/events';

/** End-to-end cover for the contract the GMCP transcoding rests on: that the
 *  socket layer deals in byte-strings (one char per wire byte) in *both*
 *  directions. gmcpParse.test.ts exercises the stream in isolation and so
 *  assumes that contract; nothing asserted it against MudClient itself, which
 *  meant a change to `bytesToLatin1` or `sendBytes` — say, either growing a
 *  real codec — would have left `toByteString` double-encoding with a green
 *  suite. */

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close() { this.readyState = MockWebSocket.CLOSED; }

  /** Deliver a Latin-1 byte-string as if it arrived from the server. */
  deliver(byteString: string) {
    const buf = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) buf[i] = byteString.charCodeAt(i) & 0xff;
    this.onmessage?.({ data: buf.buffer });
  }
}

function sentText(sock: MockWebSocket): string {
  return sock.sent.map(b => String.fromCharCode(...b)).join('');
}

/** A complete GMCP subnegotiation, body encoded as real UTF-8 wire bytes. */
function gmcpFrame(body: string): string {
  const bytes = new TextEncoder().encode(body);
  let out = GMCP_IAC + GMCP_SB + String.fromCharCode(GMCP_COMMAND_CODE);
  for (const b of bytes) out += String.fromCharCode(b);
  return out + GMCP_IAC + GMCP_SE;
}

describe('GMCP UTF-8 across the socket boundary', () => {
  let realWebSocket: unknown;
  let realBeforeUnload: unknown;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    realBeforeUnload = (globalThis as Record<string, unknown>).addEventListener;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
    (globalThis as Record<string, unknown>).addEventListener = () => {};
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
    (globalThis as Record<string, unknown>).addEventListener = realBeforeUnload;
  });

  function connected() {
    const bus = new EventBus<MudClientEvents>();
    const client = new MudClient({ url: 'ws://test.invalid' }, bus);
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.onopen?.({});
    sock.sent.length = 0;
    return { client, bus, sock };
  }

  it('decodes an inbound UTF-8 body into the gmcp event', () => {
    const { bus, sock } = connected();
    const seen: unknown[] = [];
    bus.on('gmcp', ({ path, value }) => { if (path === 'Room.Info') seen.push(value); });

    sock.deliver(gmcpFrame('Room.Info {"name":"Tristeza • Port of Darkhill","flag":"⛵"}'));

    expect(seen).toEqual([{ name: 'Tristeza • Port of Darkhill', flag: '⛵' }]);
  });

  it('puts real UTF-8 bytes on the wire for an outbound body', () => {
    const { client, sock } = connected();
    sock.deliver(GMCP_WILL); // accept GMCP so sendGmcp has a negotiated channel
    sock.sent.length = 0;

    client.sendGmcp('Char.Name', { name: 'Zoë' });

    // The bytes themselves, not a round-trip: 'ë' must be C3 AB on the wire.
    expect(sentText(sock)).toContain('"name":"Zo\xC3\xAB"');
  });

  it('reassembles a multi-byte character split across two socket frames', () => {
    // The stream decodes each subnegotiation body in one non-streaming call, so
    // a UTF-8 sequence torn between frames would decode to U+FFFD twice. It is
    // MudClient's pendingSubneg buffering that prevents it — nothing else does,
    // and nothing else covered it.
    const { bus, sock } = connected();
    const seen: unknown[] = [];
    bus.on('gmcp', ({ path, value }) => { if (path === 'Room.Info') seen.push(value); });

    const whole = gmcpFrame('Room.Info {"name":"Café"}');
    // Cut inside the two-byte 'é' (C3 A9).
    const cut = whole.indexOf('\xC3') + 1;
    expect(cut).toBeGreaterThan(0);
    sock.deliver(whole.slice(0, cut));
    expect(seen).toEqual([]); // nothing dispatched from a partial subnegotiation
    sock.deliver(whole.slice(cut));

    expect(seen).toEqual([{ name: 'Café' }]);
  });

  it('survives a body carrying an astral character, which no IAC can hide in', () => {
    // UTF-8 never emits 0xFF, so a body cannot fake the IAC SE that terminates
    // the subnegotiation — the property encodeGmcpRaw's doc comment relies on.
    const { bus, sock } = connected();
    const seen: unknown[] = [];
    bus.on('gmcp', ({ path, value }) => { if (path === 'Char.Status') seen.push(value); });

    const frame = gmcpFrame('Char.Status {"mood":"𝄞 🎺"}');
    expect(frame.slice(3, -2)).not.toContain('\xFF');
    sock.deliver(frame + 'Hello there\r\n');

    expect(seen).toEqual([{ mood: '𝄞 🎺' }]);
  });
});
