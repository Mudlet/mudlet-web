// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * `sendTelnetChannel102(msg)` is documented — by Mudlet and by our own error
 * text — as taking two *raw* bytes, "may use lua \\### for each byte where ###
 * is a number between 1 and 254". Those bytes have to survive the wasmoon
 * bridge, and as a Lua string they did not: wasmoon marshals Lua→JS strings
 * through emscripten's `UTF8ToString`, which UTF-8-*decodes* them. Measured
 * before the fix:
 *
 *   Lua "\1\200"  -> JS "Ȁ"              -> wire 01 00
 *   Lua "\1\255"  -> JS "\uDEC0\uDC00"        -> wire 01 c0 00
 *
 * Neither is the payload the caller asked for, and the 0xFF case doesn't even
 * keep its length. Bridge.lua now hands the two bytes over as numbers, which
 * cross unchanged.
 */
describe('sendTelnetChannel102 raw byte fidelity across the Lua bridge', () => {
  let t: TestRuntime;
  const sent: string[] = [];

  beforeAll(async () => {
    t = await createTestRuntime();
    // No socket in the test runtime, so stand in for the client and record what
    // MudSession was asked to send.
    t.session.sendTelnetChannel102 = (msg: string) => { sent.push(msg); return true; };
  });

  afterAll(() => t?.dispose());

  const bytes = (s: string) => [...s].map(c => c.charCodeAt(0));

  it('carries a high byte through unchanged', () => {
    sent.length = 0;
    expect(t.run('return sendTelnetChannel102("\\1\\200")')).toBe(true);
    expect(bytes(sent[0])).toEqual([0x01, 0xC8]);
  });

  it('carries 0xFF through as one byte, not a mangled surrogate pair', () => {
    sent.length = 0;
    t.run('return sendTelnetChannel102("\\1\\255")');
    expect(bytes(sent[0])).toEqual([0x01, 0xFF]);
  });

  it('carries a NUL byte, which UTF8ToString used to truncate at', () => {
    sent.length = 0;
    t.run('return sendTelnetChannel102("\\1\\0")');
    expect(bytes(sent[0])).toEqual([0x01, 0x00]);
  });

  it('still leaves ASCII payloads alone', () => {
    sent.length = 0;
    t.run('return sendTelnetChannel102("ab")');
    expect(bytes(sent[0])).toEqual([0x61, 0x62]);
  });

  it('still rejects a payload that is not exactly two bytes', () => {
    sent.length = 0;
    expect(t.run('local ok = sendTelnetChannel102("abc") return ok')).toBe(null);
    expect(t.run('local _, err = sendTelnetChannel102("abc") return err'))
      .toContain('invalid message of length 3');
    expect(sent).toEqual([]);
  });
});
