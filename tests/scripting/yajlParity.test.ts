// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Issue #296: yajl drift against desktop Mudlet, which links lua-yajl
// (brimworks/lua-yajl over yajl 2.1). Expected values are desktop's output as
// reported in the issue, or read off lua_yajl.c / yajl_gen.c where it is silent.
describe('yajl parity with desktop lua-yajl (issue #296)', () => {
  let t: TestRuntime;
  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => { t.dispose(); });

  const run = (code: string) => t.run(code);
  const ys = (expr: string) => run(`return yajl.to_string(${expr})`);

  describe('1. integer-keyed tables with holes are arrays', () => {
    it('fills holes with null instead of switching to an object', () => {
      expect(ys('{[1]=1,[3]=3}')).toBe('[1,null,3]');
      expect(run('local a={"a","b","c"}; a[1]=nil; return yajl.to_string(a)')).toBe('[null,"b","c"]');
      expect(ys('{[5]="x"}')).toBe('[null,null,null,null,"x"]');
    });

    it('keeps a decoded list a list after one element is cleared', () => {
      expect(run(`local v = yajl.to_value('{"list":[1,null,3]}'); v.list[2] = nil; return yajl.to_string(v)`))
        .toBe('{"list":[1,null,3]}');
    });

    it('treats any all-integer-keyed table as an array, as js_generator_value does', () => {
      expect(ys('{}')).toBe('[]');
      // keys at or below zero never raise the length
      expect(ys('{[0]="z"}')).toBe('[]');
      expect(ys('{[-1]=1,[2]=2}')).toBe('[null,2]');
      // a non-integral or non-number key makes it an object
      expect(ys('{[1.5]=1}')).toBe('{"1.5":1}');
      expect(ys('{[1]=1,x=2}')).toMatch(/^\{("1":1,"x":2|"x":2,"1":1)\}$/);
    });
  });

  describe('2. yajl.null is a userdata', () => {
    it('has type userdata and prints as null', () => {
      expect(run('return type(yajl.null)')).toBe('userdata');
      expect(run(`return type(yajl.to_value('{"a":null}').a)`)).toBe('userdata');
      expect(run('return tostring(yajl.null)')).toBe('null');
    });

    it('is not mistaken for a table when walking decoded data', () => {
      expect(run(`
        local n = 0
        for _, v in pairs(yajl.to_value('{"hp":null,"mp":5}')) do
          if type(v) == "table" then n = n + 1 end
        end
        return n`)).toBe(0);
    });

    it('raises when indexed or measured, like a real userdata', () => {
      expect(run('return (pcall(function() return yajl.null.x end))')).toBe(false);
      expect(run('return (pcall(function() return #yajl.null end))')).toBe(false);
    });

    it('is the same value decode hands out and encode recognises', () => {
      expect(run(`return yajl.to_value('[null]')[1] == yajl.null`)).toBe(true);
      expect(run(`return yajl.to_value('null') == yajl.null`)).toBe(true);
      expect(ys('{yajl.null, 1}')).toBe('[null,1]');
    });

    it('arrives in gmcp as the same userdata', () => {
      t.rt.setGmcpValue('Char.Vitals', JSON.parse('{"hp":null,"mp":5,"list":[1,null]}'));
      expect(run('return type(gmcp.Char.Vitals.hp)')).toBe('userdata');
      expect(run('return gmcp.Char.Vitals.hp == yajl.null')).toBe(true);
      expect(run('return gmcp.Char.Vitals.list[2] == yajl.null')).toBe(true);
      expect(run('return gmcp.Char.Vitals.mp')).toBe(5);
    });

    it('crosses into JS as nothing rather than a stray reference', () => {
      // wasmoon reads a userdata's first word as one of its JS reference ids.
      expect(run('return yajl.null')).toBeUndefined();
    });
  });

  describe('3. indent, generator and parser', () => {
    it('pretty-prints with indent exactly as yajl_gen beautify does', () => {
      expect(ys('{a=1}, {indent="  "}')).toBe('{\n  "a": 1\n}\n');
      expect(ys('{1,{2,3}}, {indent="  "}')).toBe('[\n  1,\n  [\n    2,\n    3\n  ]\n]\n');
      expect(ys('{a={}}, {indent="\\t"}')).toBe('{\n\t"a": [\n\n\t]\n}\n');
      expect(ys('"x", {indent="  "}')).toBe('"x"\n');
    });

    it('exposes yajl.generator with a printer and the value/open/close methods', () => {
      expect(run(`
        local out = {}
        local g = yajl.generator{ printer = function(s) out[#out+1] = s end }
        g:open_object()
        g:string("a"); g:integer(3.7)
        g:string("b"); g:open_array(); g:boolean(true); g:null(); g:double(1); g:number(2.5); g:close()
        g:string("c"); g:value({1, 2})
        g:close()
        return table.concat(out)`)).toBe('{"a":3,"b":[true,null,1.0,2.5],"c":[1,2]}');
    });

    it('refuses a non-string key the way yajl does', () => {
      expect(run(`
        local g = yajl.generator{ printer = function() end }
        g:open_object()
        local ok, err = pcall(g.integer, g, 1)
        return err`)).toMatch(/^InvalidState: expected either a call to close\(\) or string\(\)/);
      expect(run(`
        local g = yajl.generator{ printer = function() end }
        local ok, err = pcall(g.close, g)
        return err`)).toMatch(/^StackUnderflow:/);
    });

    it('honours __gen_json', () => {
      expect(run(`
        local obj = setmetatable({}, { __gen_json = function(self, gen) gen:string("custom") end })
        return yajl.to_string({ obj })`)).toBe('["custom"]');
    });

    it('exposes yajl.parser streaming events across chunk boundaries', () => {
      expect(run(`
        local seen = {}
        local events = {
          value = function(_, v, kind) seen[#seen+1] = kind .. "=" .. tostring(v) end,
          open_object = function() seen[#seen+1] = "{" end,
          object_key = function(_, k) seen[#seen+1] = "key=" .. k end,
          open_array = function() seen[#seen+1] = "[" end,
          close = function(_, kind) seen[#seen+1] = "close " .. kind end,
        }
        local parse = yajl.parser{ events = events }
        parse('{"a":[1')
        parse('2,tr')
        parse('ue,null,"x\\\\u00e9"],"b"')
        parse(':-0}')
        parse(nil)
        return table.concat(seen, " ")`))
        .toBe('{ key=a [ number=12 boolean=true null=null string=x\u00e9 close array key=b number=-0 close object');
    });

    it('reports a premature end on completion', () => {
      expect(run(`
        local parse = yajl.parser{ events = {} }
        parse('[1,')
        local ok, err = pcall(parse, nil)
        return err`)).toMatch(/^InvalidJSONInput: parse error: premature EOF/);
    });
  });

  describe('4. deep documents decode, as on desktop', () => {
    it('decodes 300 and 2000 levels', () => {
      expect(run(`
        local s = string.rep("[",300).."1"..string.rep("]",300)
        local ok, v = pcall(yajl.to_value, s)
        local d = 0
        while type(v) == "table" do d = d + 1; v = v[1] end
        return tostring(ok) .. " " .. d .. " " .. tostring(v)`)).toBe('true 300 1');
      expect(run(`
        local s = string.rep('{"k":',2000).."null"..string.rep("}",2000)
        local ok, v = pcall(yajl.to_value, s)
        local d = 0
        while type(v) == "table" do d = d + 1; v = v.k end
        return tostring(ok) .. " " .. d .. " " .. tostring(v == yajl.null)`)).toBe('true 2000 true');
    });

    it('fails cleanly past lua_yajl\'s stack limit and leaves the VM usable', () => {
      expect(run(`
        local ok, err = pcall(yajl.to_value, string.rep("[",2665)..string.rep("]",2665))
        return tostring(ok)`)).toBe('true');
      expect(run(`
        local ok, err = pcall(yajl.to_value, string.rep("[",2666)..string.rep("]",2666))
        return tostring(ok) .. " " .. tostring(err)`)).toBe('false lua stack overflow');
      expect(run(`
        local ok, err = pcall(yajl.to_value, string.rep("[",100000)..string.rep("]",100000))
        return tostring(ok) .. " " .. tostring(err)`)).toBe('false lua stack overflow');
      expect(run('return 1 + 1')).toBe(2);
    });

    it('stores a deep gmcp payload whole', () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 300; i++) deep = { k: deep };
      t.rt.setGmcpValue('Deep.Thing', deep);
      expect(run(`
        local v, d = gmcp.Deep.Thing, 0
        while type(v) == "table" do d = d + 1; v = v.k end
        return d .. " " .. v`)).toBe('300 leaf');
    });
  });

  describe('5. numbers decode through strtod', () => {
    it('keeps infinities', () => {
      expect(run(`local v = yajl.to_value('[1e999,-1e999]') return tostring(v[1]) .. " " .. tostring(v[2])`))
        .toBe('inf -inf');
    });

    it('keeps negative zero, without turning a neighbouring 0 into -0', () => {
      expect(run(`local v = yajl.to_value('[-0,-0.0,0]') return tostring(v[1]) .. " " .. tostring(v[2]) .. " " .. tostring(v[3])`))
        .toBe('-0 -0 0');
      expect(run(`local v = yajl.to_value('[0,-0]') return tostring(v[1]) .. " " .. tostring(v[2])`))
        .toBe('0 -0');
    });

    it('keeps them on the deep path too', () => {
      expect(run(`
        local v = yajl.to_value(string.rep("[",200).."[1e999,-0]"..string.rep("]",200))
        for _ = 1, 200 do v = v[1] end
        return tostring(v[1]) .. " " .. tostring(v[2])`)).toBe('inf -0');
    });
  });

  describe('6. encoder details', () => {
    it('encodes functions as their tostring()', () => {
      expect(String(ys('{f=print}'))).toMatch(/^\{"f":"function: [^"]+"\}$/);
    });

    it('uses uppercase hex in \\u escapes and leaves / and DEL alone', () => {
      expect(ys('"\\31"')).toBe('"\\u001F"');
      expect(ys('"\\1\\127/"')).toBe('"\\u0001\x7f/"');
      expect(ys('"a\\"b\\\\c\\n\\t\\r\\b\\f"')).toBe('"a\\"b\\\\c\\n\\t\\r\\b\\f"');
    });

    it('raises yajl\'s StackOverflow from nesting depth 128', () => {
      expect(run(`
        local function nest(n) local t = 1 for _ = 1, n do t = {t} end return t end
        local ok1 = pcall(yajl.to_string, nest(127))
        local ok2, err = pcall(yajl.to_string, nest(128))
        return tostring(ok1) .. " " .. tostring(ok2) .. " " .. err`))
        .toMatch(/^true false StackOverflow: YAJL's max generation depth was exceeded/);
      // a self-referencing table hits the same wall instead of overflowing Lua
      expect(run(`local t = {} t[1] = t return (select(2, pcall(yajl.to_string, t)))`))
        .toMatch(/^StackOverflow:/);
    });

    it('keeps that limit out of the Variables view, which snapshots user data through JSON', () => {
      run('deepUserGlobal = 1; for _ = 1, 150 do deepUserGlobal = { deepUserGlobal } end');
      const entry = t.rt.listGlobals().find(e => e.name === 'deepUserGlobal');
      let node = entry as { children?: unknown[] } | undefined;
      let depth = 0;
      while (node?.children?.length) { depth++; node = node.children[0] as typeof node; }
      expect(depth).toBe(150);
      run('deepUserGlobal = nil');
    });

    it('spells non-finite numbers the way js_generator_number does', () => {
      expect(ys('{math.huge, -math.huge, 0/0}')).toBe('[1e+666,-1e+666,-0]');
    });

    it('encodes numbers with %.14g like desktop Lua', () => {
      expect(ys('{1, 1.5, 1e20, 0.1, -0}')).toBe('[1,1.5,1e+20,0.1,-0]');
    });
  });

  describe('decode errors use yajl\'s wording', () => {
    it('prefixes InvalidJSONInput and names the problem', () => {
      expect(run(`return (select(2, pcall(yajl.to_value, '{1:2}')))`))
        .toMatch(/^InvalidJSONInput: parse error: invalid object key \(must be a string\)\n/);
      expect(run(`return (select(2, pcall(yajl.to_value, '[1,2')))`))
        .toMatch(/^InvalidJSONInput: parse error: premature EOF\n/);
      expect(run(`return (select(2, pcall(yajl.to_value, '[1] x')))`))
        .toMatch(/^InvalidJSONInput: parse error: trailing garbage\n/);
      expect(run(`return (select(2, pcall(yajl.to_value, '[tru]')))`))
        .toMatch(/^InvalidJSONInput: lexical error: invalid string in json text\.\n/);
    });

    it('accepts comments only when asked to', () => {
      expect(run(`return (select(2, pcall(yajl.to_value, '[1 /* c */]')))`))
        .toMatch(/^InvalidJSONInput: lexical error: probable comment found/);
      expect(run(`return yajl.to_value('[1 /* c */, 2 // d\\n]', {allow_comments=true})[2]`)).toBe(2);
    });
  });
});
