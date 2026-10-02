// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Issue #275: wasm32 Lua narrows lua_Integer and `long` to 32 bits, so
// string.format/sub/byte, tonumber and table.insert mangled any number of 2^31
// or more — and table.insert at 2^32+1 looped ~2^31 times, freezing the tab.
// WideIntegers.lua wraps format, tonumber and insert to answer what desktop's
// 64-bit Lua 5.1 does; sub/byte are left alone on purpose (PLATFORM_DIVERGENCES
// in e2e/knownDivergences.ts). The expected values are the issue's own,
// measured on desktop Mudlet.
describe('64-bit integers in the Lua stdlib (#275)', () => {
  let env: TestRuntime;
  beforeAll(async () => { env = await createTestRuntime(); });
  afterAll(() => env.dispose());

  const str = (code: string) => env.run(`return ${code}`);
  /** Every value the expression returns, joined with spaces. */
  const all = (code: string) =>
    env.run(`local t = table.pack and table.pack(${code}) or { n = select('#', ${code}), ${code} }
      local out = {} for i = 1, t.n do out[i] = tostring(t[i]) end return table.concat(out, ' ')`);

  describe('the issue table', () => {
    it('formats %d past 2^31 as the full integer', () => {
      expect(str('string.format("%d %d %d %d", 2^31, 3000000000, 1700000000123, -5000000000)'))
        .toBe('2147483648 3000000000 1700000000123 -5000000000');
    });

    it('formats %x/%X past 2^32', () => {
      expect(str('string.format("%x", 2^32)')).toBe('100000000');
      expect(str('string.format("%X", 0x1FFFFFFFF)')).toBe('1FFFFFFFF');
    });

    it('keeps the width and %i', () => {
      expect(str('string.format("%5d|%i", 2^40, 2^35)')).toBe('1099511627776|34359738368');
    });

    it('reads base-16 numbers past 32 bits, and rejects a bare 0x', () => {
      expect(str('tonumber("100000000", 16)')).toBe(4294967296);
      expect(str('tonumber("ffffffffff", 16)')).toBe(1099511627775);
      expect(str('tonumber("0x")')).toBeNull();
    });

    it('inserts at 2^32+1 without freezing: the low 32 bits are position 1, as on desktop', () => {
      // Guard: only make the call if the wrapper is in place — without it this
      // would loop ~2^31 times inside C and hang the worker, not fail.
      expect(str("debug.getinfo(table.insert, 'S').what")).toBe('Lua');
      expect(env.run(`local t = {}
        local ok = pcall(table.insert, t, 2^32 + 1, "x")
        return tostring(ok) .. " " .. tostring(t[1]) .. " " .. #t`)).toBe('true x 1');
    });
  });

  describe('string.format', () => {
    it('applies printf flags, width and precision to a wide value', () => {
      expect(str('string.format("[%015d|%-15d|%+d|% d|%.15d]", 2^40, 2^40, 2^40, 2^40, 2^33)'))
        .toBe('[001099511627776|1099511627776  |+1099511627776| 1099511627776|000008589934592]');
      expect(str('string.format("[%#x|%#o|%#X|%20.15x|%015d]", 2^40, 2^40, 2^40, 2^40, -2^40)'))
        .toBe('[0x10000000000|020000000000000|0X10000000000|     000010000000000|-01099511627776]');
    });

    it('gives a negative number to an unsigned conversion as its 64-bit pattern', () => {
      expect(str('string.format("%x|%u|%o|%X", -1, -1, -1, -2^32)'))
        .toBe('ffffffffffffffff|18446744073709551615|1777777777777777777777|FFFFFFFF00000000');
    });

    it('casts the unrepresentable the way x86-64 does', () => {
      expect(str('string.format("%d|%d|%u|%x", 0/0, 1e300, 2^63, 2^64)'))
        .toBe('-9223372036854775808|-9223372036854775808|9223372036854775808|0');
    });

    it('leaves the other items of a mixed format alone', () => {
      expect(str('string.format("%s has %d gold (%5.1f%%) %q %c", "Bob", 3e9, 12.25, "a\\nb", 65)'))
        .toBe('Bob has 3000000000 gold ( 12.2%) "a\\\nb" A');
      expect(str('string.format("%d", "3000000000")')).toBe('3000000000');
      expect(str('string.format(123)')).toBe('123');
    });

    it('still formats the 32-bit range exactly as before', () => {
      expect(str('string.format("%d|%d|%x|%X|%05d|%-4d|%+d", 2147483647, -2147483648, 4294967295, 255, 42, 7, 3)'))
        .toBe('2147483647|-2147483648|ffffffff|FF|00042|7   |+3');
      expect(str('string.format("%d", 2147483647.9)')).toBe('2147483647');
    });
  });

  describe('string.sub / string.byte (left unwrapped — a recorded divergence)', () => {
    it('are still the C originals, so the hot path pays nothing', () => {
      // A wrapper cost them ~5x per call to fix positions >= 2^31 that no real
      // script uses; see PLATFORM_DIVERGENCES. If one is ever reinstated, that
      // entry must go too.
      expect(str("debug.getinfo(string.sub, 'S').what")).toBe('C');
      expect(str("debug.getinfo(string.byte, 'S').what")).toBe('C');
    });

    it('behave as desktop for every position inside the 32-bit range', () => {
      expect(str('("hello"):sub(-3) .. ("hello"):sub(2, -2) .. ("hello"):sub(0)')).toBe('lloellhello');
      expect(all('("hello"):byte(-3, -1)')).toBe('108 108 111');
      expect(all('("abc"):byte()')).toBe('97');
      expect(str('("hello"):sub(-2147483647, 2) .. ("hello"):sub(2, 2147483647)')).toBe('heello');
    });
  });

  describe('tonumber', () => {
    it('reads a negative or overflowing string the way 64-bit strtoul does', () => {
      expect(str('tonumber("-1", 16)')).toBe(18446744073709551615);
      expect(str('tonumber("ffffffffffffffffffff", 16)')).toBe(18446744073709551615);
    });

    it('rejects a bare 0x in every base that would read it', () => {
      expect(str('tonumber("  0x  ")')).toBeNull();
      expect(str('tonumber("0X", 10)')).toBeNull();
      expect(str('tonumber("0x", 16)')).toBeNull();
    });

    it('is unchanged otherwise', () => {
      expect(env.run(`return table.concat({
        tostring(tonumber("0x10")), tostring(tonumber("0")), tostring(tonumber(" 0 ")),
        tostring(tonumber("ff", 16)), tostring(tonumber("0xff", 16)), tostring(tonumber(" zz ", 36)),
        tostring(tonumber("11", 2)), tostring(tonumber("ffffffff", 16)), tostring(tonumber("12", "16")),
        tostring(tonumber(nil)), tostring(tonumber("x", 16)), tostring(tonumber("1e1"))}, " ")`))
        .toBe('16 0 0 255 255 1295 3 4294967295 18 nil nil 10');
    });
  });

  describe('table.insert', () => {
    it('appends and inserts as before', () => {
      expect(env.run(`local t = {"a", "b"}
        table.insert(t, "c") table.insert(t, 1, "z") table.insert(t, 9, "q")
        return table.concat(t, "", 1, 4) .. tostring(t[9])`)).toBe('zabcq');
    });

    it('shifts the non-positive keys for a position at or below 0, without visiting every slot', () => {
      expect(env.run(`local t = {[-1] = "y", [0] = "z", "a"}
        table.insert(t, -1, "x")
        return t[-1] .. t[0] .. t[1] .. t[2]`)).toBe('xyza');
      // Desktop shifts t[2..1] up and then walks 2e9 empty slots; the result is
      // the same, here without the walk.
      expect(env.run(`local t = {"a", "b"}
        table.insert(t, -2000000000, "x")
        return t[-2000000000] .. tostring(t[1]) .. t[2] .. t[3]`)).toBe('xnilab');
    });
  });

  describe('errors', () => {
    // Desktop raises these from the C function, so the message names the
    // caller's line and the name the caller used; the wrappers must not
    // move either into WideIntegers.lua.
    const err = (body: string) =>
      env.run(`local ok, e = pcall(function() ${body} end) return e`) as string;
    const AT = '[string "local ok, e = pcall(function() ';

    it('report the script line and the stock message', () => {
      expect(err('local x = string.format("%d", nil) return x'))
        .toBe(`${AT}local x = st..."]:1: bad argument #2 to 'format' (number expected, got nil)`);
      expect(err('local x = string.format("%d %d", 3e9) return x'))
        .toBe(`${AT}local x = st..."]:1: bad argument #3 to 'format' (no value)`);
      expect(err('local x = string.format("%s", {}) return x'))
        .toMatch(/\]:1: bad argument #2 to 'format' \(string expected, got table\)$/);
      expect(err('local x = string.format("%y", 1) return x'))
        .toMatch(/\]:1: invalid option '%y' to 'format'$/);
      expect(err('local x = table.insert(nil, 1) return x'))
        .toBe(`${AT}local x = ta..."]:1: bad argument #1 to 'insert' (table expected, got nil)`);
      expect(err('local x = table.insert(nil, 1, 2) return x'))
        .toMatch(/\]:1: bad argument #1 to 'insert' \(table expected, got nil\)$/);
      expect(err('local x = table.insert({}, 1, 2, 3) return x'))
        .toMatch(/\]:1: wrong number of arguments to 'insert'$/);
      expect(err('local x = tonumber("1", 99) return x'))
        .toMatch(/\]:1: bad argument #2 to 'tonumber' \(base out of range\)$/);
      expect(err('local x = tonumber() return x'))
        .toMatch(/\]:1: bad argument #1 to 'tonumber' \(value expected\)$/);
    });

    it('do not count self in a method call, and use the name the caller used', () => {
      expect(err('local x = ("%d"):format(nil) return x'))
        .toMatch(/\]:1: bad argument #1 to 'format' \(number expected, got nil\)$/);
      expect(err('local fmt = string.format local x = fmt("%d", nil) return x'))
        .toMatch(/\]:1: bad argument #2 to 'fmt' \(number expected, got nil\)$/);
    });
  });
});
