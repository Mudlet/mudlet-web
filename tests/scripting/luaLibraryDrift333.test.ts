// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/**
 * Mudlet/mudlet-web#333: rex, utf8, io, LPeg and math.randomseed against the
 * desktop PTB. Every expectation is the value desktop gave for the same call.
 */
describe('rex matches bytes, as lrexlib does (#333)', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);
  const list = (code: string) => run(`local out = {} ${code} return table.concat(out, " ")`);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  it('a character is one byte unless the pattern asks for UTF', () => {
    expect(run(`return #rex.match("日本", "^(.)")`)).toBe(1);
    expect(run(`local n = 0 for _ in rex.gmatch("日本語", ".") do n = n + 1 end return n`)).toBe(9);
    expect(run(`return rex.find("É", "é", 1, "i")`)).toBeNull();
  });

  it('takes text that is not UTF-8', () => {
    expect(list(`out = {pcall(rex.find, "ab\\255cd", "c")} for i = 1, #out do out[i] = tostring(out[i]) end`))
      .toBe('true 4 4');
    expect(list(`local s, m, n = rex.gsub("x\\200y", "y", "z") out = {s == "x\\200z", m, n}
      for i = 1, #out do out[i] = tostring(out[i]) end`)).toBe('true 1 1');
    expect(run(`return rex.match("a\\0b\\255", "b.") == "b\\255"`)).toBe(true);
    expect(run(`return select(2, rex.find("\\0\\0x", "x"))`)).toBe(3);
  });

  it('skips an empty match right after the previous match', () => {
    expect(list(`local s, m = rex.gsub("baaac", "a*", "-") out = {s, m}`)).toBe('-b-c- 3');
    expect(list(`for c in rex.gmatch("a1b22", "\\\\d*") do out[#out + 1] = "[" .. c .. "]" end`))
      .toBe('[] [1] [22]');
    expect(run(`return rex.count("aaa", "a*")`)).toBe(1);
  });

  it('split returns the separator after each section', () => {
    expect(list(`for a, b in rex.split("a,b;c", "[,;]") do out[#out + 1] = a .. "|" .. tostring(b) end`))
      .toBe('a|, b|; c|nil');
    expect(list(`for a, b, c in rex.split("k1=v1;k2", "(\\\\d)(=)?") do
      out[#out + 1] = a .. "|" .. tostring(b) .. "|" .. tostring(c) end`)).toBe('k|1|= v|1|false ;k|2|false |nil|nil');
  });

  it('exec and tfind add named groups to their table', () => {
    expect(list(`local s, e, t = rex.new("(?<k>\\\\w+)=(?<v>\\\\d+)"):exec("x=1") out = {s, e, t[1], t[4], t.k, t.v}`))
      .toBe('1 3 1 3 x 1');
    expect(list(`local s, e, t = rex.new("(?<k>\\\\w+)=(?<v>\\\\d+)?"):tfind("x=") out = {t[1], tostring(t[2]), t.k, tostring(t.v)}`))
      .toBe('x false x false');
  });

  it('gsub asks a function n whether to replace each match', () => {
    expect(list(`local s, m, n = rex.gsub("foo=12 bar=345 baz=6", "\\\\d+", "#", function(s, e) return e > 10 end)
      out = {s, m, n}`)).toBe('foo=12 bar=# baz=# 3 2');
    // Its first value can be the replacement; a number second value stops asking.
    expect(list(`local seen = {}
      local s, m, n = rex.gsub("a b c d", "\\\\w", "X", function(st, e, r)
        seen[#seen + 1] = st .. r
        return "<" .. r .. ">", 1
      end)
      out = {s, m, n, table.concat(seen, ",")}`)).toBe('<X> X c d 2 2 1X');
    expect(list(`local s, m, n = rex.gsub("a b", "\\\\w", "X", function() return false, true end) out = {s, m, n}`))
      .toBe('a X 2 1');
  });

  it('has every lrexlib flag, and honours exec flags', () => {
    expect(run(`local n = 0 for _ in pairs(rex.flags()) do n = n + 1 end return n`)).toBe(138);
    expect(list(`local f = rex.flags() out = {f.NOTBOL, f.NOTEMPTY, f.PARTIAL_SOFT, f.PARTIAL_HARD, f.ERROR_NOMATCH, f.ANCHORED}`))
      .toBe('1 4 16 32 -1 -2147483648');
    expect(run(`local t = {} return rex.flags(t) == t and t.UTF ~= nil`)).toBe(true);
    expect(run(`return rex.new("^a"):find("ab", 1, 1)`)).toBeNull();
    expect(list(`out = {rex.new("^a"):find("ab", 1, 0)}`)).toBe('1 1');
    expect(list(`out = {rex.find("ab", "b", 1, nil, rex.flags().NOTEOL)}`)).toBe('2 2');
    expect(run(`return rex.find("ab", "b$", 1, nil, rex.flags().NOTEOL)`)).toBeNull();
    expect(run(`return rex.match("", "x*", 1, nil, rex.flags().NOTEMPTY)`)).toBeNull();
    expect(run(`return (select(2, pcall(rex.find, "ab", "abc", 1, nil, rex.flags().PARTIAL_HARD)))`))
      .toContain('PCRE2_ERROR_PARTIAL');
  });

  it('compile flags given as numbers reach the pattern', () => {
    expect(list(`local f = rex.flags() out = {rex.new("\\\\w+", f.UTF + f.UCP):find("xééy")}`)).toBe('1 6');
    expect(list(`out = {rex.new("(*UTF)(*UCP)\\\\w+"):find("xééy")}`)).toBe('1 6');
    expect(list(`out = {rex.find("ABC", "b", 1, rex.flags().CASELESS)}`)).toBe('2 2');
    expect(run(`return rex.find("xa.c", "a.c", 1, 33554432)`)).toBe(2);
    expect(run(`return rex.find("xabc", "a.c", 1, 33554432)`)).toBeNull();
    // A UTF pattern decodes the subject, and still reports bytes.
    expect(list(`out = {rex.find("日本語", "本.", 1, rex.flags().UTF)}`)).toBe('4 9');
    expect(run(`return #rex.match("日本", "(*UTF)^(.)")`)).toBe(3);
    expect(run(`return (pcall(rex.find, "a\\255", "a", 1, rex.flags().UTF))`)).toBe(false);
  });
});

describe('utf8 is luautf8 0.2.1 (#333)', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);
  const list = (code: string) => run(`local out = {} ${code} for i = 1, #out do out[i] = tostring(out[i]) end return table.concat(out, " ")`);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  it('fold and ncasecmp use Unicode case folding', () => {
    expect(run(`return utf8.fold("ÉLAN Straße")`)).toBe('élan straße');
    expect(run(`return utf8.fold(0xC9)`)).toBe(233);
    expect(run(`return utf8.fold("µſ")`)).toBe('μs');
    expect(run(`return utf8.ncasecmp("Élan", "élan")`)).toBe(0);
    expect(run(`return utf8.ncasecmp("abc", "ABD")`)).toBe(-1);
    expect(run(`return utf8.ncasecmp("abc", "AB")`)).toBe(1);
  });

  it('escape reads %u as decimal and only %x as hex', () => {
    expect(run(`return utf8.escape("%u{456}") == utf8.char(456)`)).toBe(true);
    expect(run(`return utf8.escape("%x{456}") == utf8.char(0x456)`)).toBe(true);
    expect(run(`return utf8.escape("%u456!")`)).toBe(`${String.fromCodePoint(456)}!`);
    expect(run(`return utf8.escape("100%%")`)).toBe('100%');
  });

  it('patterns: frontier, position captures and %1 without captures', () => {
    expect(list(`out = {utf8.find("abc def", "%f[%a]%a+", 2)}`)).toBe('5 7');
    expect(list(`for p in utf8.gmatch("ab cd", "()%S+") do out[#out + 1] = p end`)).toBe('1 4');
    expect(list(`for p in utf8.gmatch("ab", "()") do out[#out + 1] = p end`)).toBe('1 2 3');
    expect(run(`return (utf8.gsub("日本語", "本", "<%1>"))`)).toBe('日<本>語');
    expect(list(`out = {utf8.match("日本語", "()本()")}`)).toBe('2 3');
    expect(list(`out = {utf8.find("x日本語y", "(本)(.)")}`)).toBe('3 4 本 語');
    expect(run(`return (utf8.gsub("(a)(b)", "%b()", "[]"))`)).toBe('[][]');
    expect(run(`return (utf8.gsub("hello hello", "(h%a+) %1", "%1"))`)).toBe('hello');
  });

  it('gsub reads its count as an integer, a negative one as none', () => {
    expect(list(`out = {utf8.gsub("aaa", "a", "b", -1)}`)).toBe('aaa 0');
    expect(list(`out = {utf8.gsub("aaa", "a", "b", 1.5)}`)).toBe('baa 1');
  });

  it('offset also returns where the character ends', () => {
    expect(list(`out = {utf8.offset("héllo wörld", 3)}`)).toBe('4 4');
    expect(list(`out = {utf8.offset("héllo wörld", 2)}`)).toBe('2 3');
  });

  it('walks over invalid bytes and continuation bytes', () => {
    expect(run(`return utf8.sub("ab\\255cd\\195", 2, 4) == "b\\255c"`)).toBe(true);
    expect(run(`return utf8.len("ab\\255cd\\195", 1, -1, true)`)).toBe(6);
    expect(list(`out = {utf8.len("ab\\255cd\\195")}`)).toBe('nil 3');
    expect(list(`out = {utf8.next("日本語", 3)}`)).toBe('4 26412');
    expect(list(`out = {utf8.byte("日本語", 1, 2)}`)).toBe('26085 26412');
    expect(list(`out = {utf8.charpos("日本語", 2, 1)}`)).toBe('4 26412');
  });

  it('positions and bounds', () => {
    expect(run(`return utf8.insert("日本語", 0, "X")`)).toBe('日本語X');
    expect(run(`return utf8.insert("日本語", 1, "X")`)).toBe('X日本語');
    expect(run(`return utf8.insert("日本語", "X")`)).toBe('日本語X');
    expect(list(`out = {utf8.charpos("日本語", nil, 2)}`)).toBe('7 35486');
    expect(list(`out = {utf8.widthindex("日本語abc", 100)}`)).toBe('6');
    expect(list(`out = {utf8.widthindex("日本語abc", 3)}`)).toBe('2 1 2');
    expect(run(`return utf8.lower("İ")`)).toBe('i');
    expect(run(`return utf8.lower(0x130)`)).toBe(0x69);
    expect(run(`return utf8.remove("日本語", 2, 2)`)).toBe('日語');
  });
});

/** In-memory stand-in for ProfileVFS covering the methods the io hooks use. */
class StubVFS {
  profilePath = '/profiles/test';
  files = new Map<string, Uint8Array>();
  resolvePath(p: string): string { return p.startsWith('/') ? p : `${this.profilePath}/${p}`; }
  exists(p: string): boolean { return this.files.has(this.resolvePath(p)); }
  readBinaryFile(p: string): Uint8Array {
    const bytes = this.files.get(this.resolvePath(p));
    if (!bytes) throw new Error(`ENOENT: ${p}`);
    return bytes;
  }
  writeBinaryFile(p: string, data: Uint8Array): void { this.files.set(this.resolvePath(p), data); }
  stat(p: string): { type: 'file' | 'dir' } | null {
    const abs = this.resolvePath(p);
    if (this.files.has(abs)) return { type: 'file' };
    return this.profilePath === abs || this.profilePath.startsWith(`${abs}/`) || abs === '/'
      ? { type: 'dir' } : null;
  }
}

describe('io reads, seeks and appends as glibc stdio does (#333)', () => {
  let t: TestRuntime;
  const stub = new StubVFS();
  const run = (code: string) => t.run(code);
  // A file holding `body`, opened with `mode`, as `f`.
  const withFile = (body: string, mode: string, code: string) => run(`
    local path = getMudletHomeDir() .. "/t.txt"
    local w = assert(io.open(path, "w")) w:write(${JSON.stringify(body)}) w:close()
    local f = assert(io.open(path, ${JSON.stringify(mode)}))
    ${code}
  `);

  beforeAll(async () => { t = await createTestRuntime({ vfs: stub as unknown as ProfileVFS }); });
  afterAll(() => t?.dispose());

  it('read(0) is nil at the end of the file', () => {
    expect(withFile('ab', 'r', `
      local n = 0
      while f:read(0) and n < 10 do f:read(1) n = n + 1 end
      return n .. tostring(f:read(0))
    `)).toBe('2nil');
    expect(withFile('', 'r', 'return f:read(0)')).toBeNull();
  });

  it.each([
    ['0x1F rest', '31| rest'],
    ['+3', '3|'],
    ['.5', '0.5|'],
    ['inf', 'inf|'],
    ['5. rest', '5| rest'],
    ['  -2.5e2x', '-250|x'],
    ['1e+ x', '1| x'],
    ['abc', 'nil|abc'],
  ])('read("*n") on %j', (body, expected) => {
    expect(withFile(body, 'r', `
      local v = f:read("*n")
      return tostring(v) .. "|" .. (f:read("*a") or "")
    `)).toBe(expected);
  });

  it('seek refuses a negative position and allows one past the end', () => {
    expect(withFile('0123456789', 'r', `
      local a, b, c = f:seek("set", -5)
      return tostring(a) .. "|" .. tostring(b) .. "|" .. tostring(c)
    `)).toBe('nil|Invalid argument|22');
    expect(withFile('0123456789', 'r', `return f:seek("end", 10) .. "," .. f:seek("set", 50) .. "," .. tostring(f:read(1))`))
      .toBe('20,50,nil');
  });

  it('a write past the end pads with NULs', () => {
    expect(withFile('abcdef', 'r+', `
      f:seek("set", 10) f:write("Q") f:close()
      local r = io.open(path, "rb") local s = r:read("*a") r:close()
      return #s .. "|" .. s:gsub("%z", "0")
    `)).toBe('11|abcdef0000Q');
  });

  it('append modes', () => {
    expect(withFile('abcdef', 'a+', 'return f:read("*a")')).toBe('abcdef');
    expect(withFile('abcdef', 'a', 'f:write("g") return f:seek()')).toBe(7);
    expect(withFile('abcdef', 'a+', `
      f:seek("set", 0) f:write("X") local p = f:seek() f:close()
      local r = io.open(path) local s = r:read("*a") r:close()
      return p .. "|" .. s
    `)).toBe('7|abcdefX');
  });
});

describe('LPeg 1.1 and math.randomseed (#333)', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  it('has the % accumulator capture', () => {
    expect(run(`
      local f = function(acc, v) return acc + v end
      local p = lpeg.Cc(0) * ((lpeg.R"09" / tonumber) % f)^1
      return p:match("12345")
    `)).toBe(15);
    expect(run(`
      local p = lpeg.Ct(lpeg.Cc("x") * (lpeg.C(lpeg.R"az") % function(acc, c) return acc .. c end)^0)
      return p:match("abc")[1]
    `)).toBe('xabc');
    expect(run(`return (pcall(lpeg.match, lpeg.P"a" % function() end, "a"))`)).toBe(false);
  });

  it('numbers the captures nested in a string capture after it', () => {
    expect(run(`return lpeg.match(lpeg.C(lpeg.C"a" * lpeg.C"b") / "%2-%1", "ab")`)).toBe('a-ab');
    expect(run(`return lpeg.match(lpeg.C(lpeg.C"a" * lpeg.C"b") / "%3%2", "ab")`)).toBe('ba');
    expect(run(`return lpeg.match((lpeg.C"a" * lpeg.C(lpeg.C"b")) / "%1%2%3", "ab")`)).toBe('abb');
  });

  it('truncates a fractional init', () => {
    expect(run(`return lpeg.match(lpeg.P"b", "ab", 2.5)`)).toBe(3);
    expect(run(`return lpeg.match(lpeg.Cp(), "abc", -1.5)`)).toBe(3);
  });

  it('math.randomseed(inf or nan) seeds as srand(0), which glibc makes srand(1)', () => {
    const seq = (seed: string) => run(`math.randomseed(${seed})
      return string.format("%.17g %d %d", math.random(), math.random(10), math.random(1, 6))`);
    for (const seed of ['1/0', '0/0', '-1/0', '1e300']) {
      expect(seq(seed)).toMatch(/^0\.84018771715470952 4 \d$/);
      expect(seq(seed)).toBe(seq('1'));
    }
  });
});
