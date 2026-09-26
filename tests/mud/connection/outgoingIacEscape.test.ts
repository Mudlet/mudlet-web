// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';

/** A 0xFF data byte in an outgoing command must go out as IAC IAC, as desktop
 *  Mudlet's `cTelnet::sendData` does with `escapeIac`. Under a single-byte
 *  encoding that byte is an ordinary letter (`я` in CP1251, `ÿ` in Latin-1),
 *  and sent bare the server reads it as the start of a telnet command. */

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
}

function sentHex(sock: MockWebSocket): string {
  return sock.sent.flatMap(b => [...b]).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

describe('outgoing IAC escaping', () => {
  let realWebSocket: unknown;
  let realAddEventListener: unknown;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    realAddEventListener = (globalThis as Record<string, unknown>).addEventListener;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
    (globalThis as Record<string, unknown>).addEventListener = () => {};
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
    (globalThis as Record<string, unknown>).addEventListener = realAddEventListener;
  });

  function connected() {
    const client = new MudClient({ url: 'ws://test.invalid' }, new EventBus<MudClientEvents>());
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.onopen?.({});
    sock.sent.length = 0;
    return { client, sock };
  }

  it('doubles CP1251 "я" (0xFF) to IAC IAC', () => {
    const { client, sock } = connected();
    expect(client.setServerEncoding('WINDOWS-1251')).toBe(true);
    client.send('моя', false);
    expect(sentHex(sock)).toBe('ec ee ff ff 0d 0a');
  });

  it('doubles Latin-1 "ÿ" (0xFF) to IAC IAC', () => {
    const { client, sock } = connected();
    expect(client.setServerEncoding('ISO-8859-1')).toBe(true);
    client.send('ÿes', false);
    expect(sentHex(sock)).toBe('ff ff 65 73 0d 0a');
  });

  it('leaves UTF-8, which never contains 0xFF, untouched', () => {
    const { client, sock } = connected();
    client.send('ÿя', false);
    expect(sentHex(sock)).toBe('c3 bf d1 8f 0d 0a');
  });
});
