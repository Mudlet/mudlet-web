// @vitest-environment node

// Mudlet/mudlet-web#365, items 2-4, checked against desktop Mudlet PTB:
// tostring() with no argument, sendSocket's bytes and parse flag, and
// toNativeSeparators. Item 1 (the extra connect/disconnect/output events) is
// engine-level and lives in luaApiDrift365Events.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('Lua API drift vs desktop (#365)', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  describe('tostring', () => {
    it('raises on a missing argument as stock Lua 5.1 does', () => {
      expect(env.run('local ok, e = pcall(tostring) return tostring(ok) .. "|" .. e'))
        .toBe("false|bad argument #1 to 'tostring' (value expected)");
      // the bug the issue describes: one argument to a handler, select(2, ...) is empty
      expect(env.run(`local function h(...) return tostring(select(2, ...)) end
        return (pcall(h, "only"))`)).toBe(false);
    });

    it('still stringifies an explicit nil and ordinary values', () => {
      expect(env.run('return tostring(nil)')).toBe('nil');
      expect(env.run('return tostring(12) .. tostring(true) .. tostring("x")')).toBe('12truex');
    });
  });

  describe('sendSocket', () => {
    const hex = (s: string) => Array.from(s, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
    let sent: string[];
    beforeEach(() => {
      sent = [];
      vi.spyOn(env.session, 'sendSocket').mockImplementation((data: string) => { sent.push(data); return true; });
    });

    it('sends the UTF-8 bytes of the Lua string', () => {
      expect(env.run('return sendSocket("k é\\r\\n")')).toBe(true);
      env.run('sendSocket("m я\\r\\n")');
      expect(sent.map(hex)).toEqual(['6b 20 c3 a9 0d 0a', '6d 20 d1 8f 0d 0a']);
    });

    it('sends bytes that are not valid UTF-8 unchanged, up to the first NUL', () => {
      env.run('sendSocket("\\255\\250\\201\\255\\240")');
      env.run('sendSocket("ab\\0cd")');
      expect(sent.map(hex)).toEqual(['ff fa c9 ff f0', '61 62']);
    });

    it('decodes the telnet byte tags when asked to', () => {
      env.run('sendSocket("a<T_IAC><T_NOP>b<0D><0A>", true)');
      env.run('sendSocket("<O_GMCP>", true)');
      env.run('sendSocket("<O_GMCP>", false)');
      env.run('sendSocket("<O_GMCP>")');
      expect(sent.map(hex)).toEqual(['61 ff f1 62 0d 0a', 'c9', hex('<O_GMCP>'), hex('<O_GMCP>')]);
    });

    it('raises for a parse flag that is not a boolean, and names a missing argument', () => {
      expect(() => env.run('sendSocket("x", "yes")'))
        .toThrow('sendSocket: bad argument #2 type (parse telnet codes {default = false} as boolean is optional, got string!)');
      expect(() => env.run('sendSocket("x", nil)')).toThrow(/as boolean is optional, got nil!/);
      expect(() => env.run('sendSocket()'))
        .toThrow('sendSocket: bad argument #1 type (data as string expected, got no value!)');
      expect(sent).toEqual([]);
    });
  });

  describe('toNativeSeparators', () => {
    it("turns backslashes into slashes and returns gsub's count, as desktop on Linux", () => {
      expect(env.run('local p, n = toNativeSeparators("a/b\\\\c") return p .. "|" .. n')).toBe('a/b/c|1');
      expect(env.run('local p, n = toNativeSeparators("C:\\\\Users\\\\me\\\\x.lua") return p .. "|" .. n'))
        .toBe('C:/Users/me/x.lua|3');
      expect(env.run('return select("#", toNativeSeparators("plain"))')).toBe(2);
    });
  });
});
