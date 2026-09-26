// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * Mudlet/mudlet-web#183: `rex` (Mudlet's lrexlib rex_pcre) and `utf8` (Mudlet's
 * luautf8) drifted from desktop Mudlet. Every expectation below is what Mudlet
 * 5.0 returned for the same call.
 */
describe('rex parity with lrexlib', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  it('gsub honours the match limit and returns the match and substitution counts', () => {
    expect(run(`local s, m, n = rex.gsub("a a a a", "a", "b", 2); return s .. "|" .. m .. "|" .. n`))
      .toBe('b b a a|2|2');
  });

  it('gsub substitutes %N and %0 in a string replacement', () => {
    expect(run(`local s, m, n = rex.gsub("ab", "(a)(b)", "%2%1"); return s .. "|" .. m .. "|" .. n`))
      .toBe('ba|1|1');
    expect(run(`return (rex.gsub("ab", "(a)(b)", "[%0]"))`)).toBe('[ab]');
    expect(run(`return (rex.gsub("ab", "a", "<%1>"))`)).toBe('<a>b');
    expect(run(`return (rex.gsub("ab", "a", "100%%"))`)).toBe('100%b');
  });

  it('gsub passes the whole match to a function when the pattern has no captures', () => {
    expect(run(`return (rex.gsub("x1y22", "\\\\d+", function(d) return "<" .. d .. ">" end))`))
      .toBe('x<1>y<22>');
  });

  it('gsub passes the captures to a function, and keeps the match on nil/false', () => {
    expect(run(`return (rex.gsub("a1 b2", "(\\\\w)(\\\\d)", function(l, d) return d .. l end))`)).toBe('1a 2b');
    expect(run(`local s, m, n = rex.gsub("a b", "\\\\w", function() return false end); return s .. "|" .. m .. "|" .. n`))
      .toBe('a b|2|0');
  });

  it('gsub looks a table replacement up by the match', () => {
    expect(run(`return (rex.gsub("hp mp", "\\\\w+", {hp = "HP"}))`)).toBe('HP mp');
    expect(run(`return (rex.gsub("hp=1", "(\\\\w+)=(\\\\d)", {hp = "HEALTH"}))`)).toBe('HEALTH');
  });

  it('find and tfind report byte offsets, as string.find does', () => {
    expect(run(`local s, e = rex.find("café wörd", "wörd"); return s .. " " .. e`)).toBe('7 11');
    expect(run(`local s, e = string.find("café wörd", "wörd", 1, true); return s .. " " .. e`)).toBe('7 11');
    expect(run(`local s, e = rex.find("café wörd", "wörd"); return ("café wörd"):sub(s, e)`)).toBe('wörd');
    expect(run(`local s, e = rex.tfind("café wörd", "wörd"); return s .. " " .. e`)).toBe('7 11');
  });

  it('takes init as a byte offset', () => {
    // byte 7 is where "wörd" starts; "ö" is bytes 8-9
    expect(run(`return (rex.find("café wörd", "\\\\w+", 7))`)).toBe(7);
    expect(run(`return (rex.match("café wörd", "\\\\S+", 7))`)).toBe('wörd');
    expect(run(`return (rex.match("abc", "c", -1))`)).toBe('c');
    expect(run(`return rex.find("abc", "x*", 5)`)).toBeNull();
    expect(run(`return (rex.find("abc", "$", 4))`)).toBe(4);
  });

  it('matches an empty subject', () => {
    expect(run(`return (rex.match("", "^$"))`)).toBe('');
  });

  it('rex.new(...):exec returns start, end and the capture offsets', () => {
    expect(run(`
      local s, e, t = rex.new("(\\\\d)(x)?"):exec("a1")
      return table.concat({s, e, t[1], t[2], tostring(t[3]), tostring(t[4])}, ",")
    `)).toBe('2,2,2,2,false,false');
    expect(run(`local s, e, t = rex.exec("ä1", "(\\\\d)"); return s .. "," .. e .. "," .. t[1]`)).toBe('3,3,3');
  });

  it('rex.new compiles the pattern up front', () => {
    expect(run(`local ok, err = pcall(rex.new, "(bad"); return tostring(ok) .. "|" .. tostring(err)`))
      .toMatch(/^false\|.*missing closing parenthesis/);
    expect(run(`return type(rex.new("(good)"))`)).toBe('userdata');
  });

  it('counts the empty match at the end of the subject', () => {
    expect(run(`return rex.count("abc", "x*")`)).toBe(4);
    expect(run(`local n = 0; for _ in rex.gmatch("abc", "x*") do n = n + 1 end; return n`)).toBe(4);
    expect(run(`local s, m = rex.gsub("abc", "x*", "-"); return s .. "|" .. m`)).toBe('-a-b-c-|4');
  });
});

describe('utf8 parity with luautf8', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  it('upper and lower map non-ASCII letters', () => {
    expect(run(`return utf8.upper("ärger")`)).toBe('ÄRGER');
    expect(run(`return utf8.lower("ÄRGER Ωμέγα")`)).toBe('ärger ωμέγα');
    // Special casing is not simple mapping: luautf8 leaves ß alone.
    expect(run(`return utf8.upper("straße")`)).toBe('STRAßE');
  });

  it('char takes any number of code points', () => {
    expect(run(`return utf8.char(72, 228)`)).toBe('Hä');
    expect(run(`return utf8.char(0x1F642)`)).toBe('🙂');
  });

  it('len honours the i/j byte range and reports invalid input', () => {
    expect(run(`return utf8.len("hello wörld", 7)`)).toBe(5);
    expect(run(`return utf8.len("hello wörld")`)).toBe(11);
    expect(run(`return utf8.len("hello wörld", 1, 5)`)).toBe(5);
    expect(run(`local n, p = utf8.len("ab\\255c"); return tostring(n) .. " " .. p`)).toBe('nil 3');
  });

  it('codepoint, offset and charpattern exist', () => {
    expect(run(`return table.concat({utf8.codepoint("Hä!", 1, -1)}, ",")`)).toBe('72,228,33');
    expect(run(`return utf8.codepoint("Hä", 2)`)).toBe(228);
    expect(run(`return utf8.offset("aäb", 3)`)).toBe(4);
    expect(run(`return utf8.offset("aäb", -1)`)).toBe(4);
    expect(run(`return utf8.offset("aäb", 0, 3)`)).toBe(2);
    expect(run(`return utf8.offset("aäb", 5)`)).toBeNull();
    expect(run(`local n = 0; for _ in ("aä🙂"):gmatch(utf8.charpattern) do n = n + 1 end; return n`)).toBe(3);
  });
});
