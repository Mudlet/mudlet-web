// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { luaChunkForValue } from '../../src/scripting/lua/yajl';

// yajl.to_value decodes via __yajl_parse_src__ (JSON.parse in JS, then Lua
// table-constructor SOURCE handed back for Lua's own parser to compile) rather
// than returning an object graph for wasmoon to walk node by node. The graph
// path measured 280s on an 8.1MB map database vs 45ms for the actual
// JSON.parse, so these tests pin the behaviour the fast path has to preserve —
// and that the documented fallback still works.
describe('yajl.to_value — source-emitting decoder', () => {
  let t: TestRuntime;
  beforeEach(async () => { t = await createTestRuntime(); });
  afterEach(() => { t.dispose(); });

  const decode = (json: string, expr: string): unknown =>
    t.run(`local v = yajl.to_value([==[${json}]==]) return ${expr}`);

  it('decodes scalars', () => {
    expect(decode('42', 'v')).toBe(42);
    expect(decode('-1.5', 'v')).toBe(-1.5);
    expect(decode('true', 'v')).toBe(true);
    expect(decode('false', 'v')).toBe(false);
    expect(decode('"hi"', 'v')).toBe('hi');
  });

  it('decodes arrays 1-indexed with a correct length', () => {
    expect(decode('[10,20,30]', 'v[1]')).toBe(10);
    expect(decode('[10,20,30]', 'v[3]')).toBe(30);
    expect(decode('[10,20,30]', '#v')).toBe(3);
    expect(decode('[10,20,30]', 'v[0] == nil')).toBe(true);
  });

  it('decodes nested objects and arrays', () => {
    const json = '{"a":{"b":[1,{"c":"deep"}]}}';
    expect(decode(json, 'v.a.b[1]')).toBe(1);
    expect(decode(json, 'v.a.b[2].c')).toBe('deep');
  });

  it('maps JSON null to the yajl.null sentinel, not nil', () => {
    // The distinction matters: a nil would delete the key entirely.
    expect(decode('{"k":null}', 'v.k == yajl.null')).toBe(true);
    expect(decode('{"k":null}', 'v.k ~= nil')).toBe(true);
  });

  it('handles keys that are not valid bare Lua identifiers', () => {
    expect(decode('{"end":1}', 'v["end"]')).toBe(1);
    expect(decode('{"1":2}', 'v["1"]')).toBe(2);
    expect(decode('{"":3}', 'v[""]')).toBe(3);
    expect(decode('{"a b":4}', 'v["a b"]')).toBe(4);
  });

  it('round-trips strings needing escapes, including quotes and backslashes', () => {
    expect(decode('{"s":"a\\"b"}', 'v.s')).toBe('a"b');
    expect(decode('{"s":"a\\\\b"}', 'v.s')).toBe('a\\b');
    expect(decode('{"s":"tab\\there"}', 'v.s')).toBe('tab\there');
    expect(decode('{"s":"nl\\nhere"}', 'v.s')).toBe('nl\nhere');
  });

  it('preserves non-ASCII as UTF-8 bytes across the bridge', () => {
    // Emitted as \ddd escapes so the chunk stays pure ASCII — the same hazard
    // VFS.lua armors around. Compare byte length, since Lua strings are bytes.
    expect(decode('{"s":"\\u00e9"}', '#v.s')).toBe(2);      // é = C3 A9
    expect(decode('{"s":"\\u00e9"}', 'string.byte(v.s,1)')).toBe(0xC3);
    expect(decode('{"s":"\\u00e9"}', 'string.byte(v.s,2)')).toBe(0xA9);
    expect(decode('{"s":"\\u4e2d"}', '#v.s')).toBe(3);      // 中
  });

  it('does not let a digit after an escape merge into it', () => {
    // "\n" then "7": a two-digit escape would swallow the 7 as \n7.
    const r = decode('{"s":"\\u00017"}', 'string.byte(v.s,1)..","..string.byte(v.s,2)');
    expect(r).toBe('1,55');
  });

  it('decodes a large array fast (the regression this path exists for)', () => {
    const big = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, n: `r${i}` })));
    const started = Date.now();
    expect(decode(big, '#v')).toBe(20000);
    expect(decode(big, 'v[20000].n')).toBe('r19999');
    // The graph path took ~35µs/KB; this is a loose ceiling that still fails
    // loudly if the fast path silently stops being taken.
    expect(Date.now() - started).toBeLessThan(15000);
  });
});

// Documents too deep to express as source go through __yajl_parse__, which
// builds the value with the raw lua_* API instead (it replaced a decoder that
// handed wasmoon an object graph). Any structural divergence between the two
// would silently corrupt decoded data (a Mudlet JSON map, say) depending only
// on how deep it is, so pin them against each other over a document
// shaped like a real map: areas holding rooms, coordinate arrays, exit lists,
// string-keyed userData, nulls, unicode, and numeric-looking keys.
describe('yajl.to_value matches the raw-API decoder', () => {
  let t: TestRuntime;
  beforeEach(async () => { t = await createTestRuntime(); });
  afterEach(() => { t.dispose(); });

  const MAP_LIKE = JSON.stringify({
    formatVersion: 1,
    areaCount: 2,
    playersRoomId: 390,
    anonymousAreaName: 'Unnamed Area',
    areas: [
      { id: -1, name: 'Default Area', roomCount: 0, rooms: [], userData: { 'system.zoom': '20' } },
      {
        id: 1,
        name: 'Earth',
        roomCount: 2,
        rooms: [
          {
            id: 1, name: 'Meeting point', hash: 'Sol.Earth.390', environment: 272,
            coordinates: [6, -6, 0],
            exits: [{ exitId: 2, name: 'east' }],
            stubExits: [{ name: 'out' }],
            userData: { fed2_area: 'Earth', fed2_num: '390', 'system.color': '#ffffff' },
          },
          {
            id: 2, name: 'Launch pad — “outer”', hash: null, environment: 0,
            coordinates: [0, 0, -1], exits: [], stubExits: [],
            userData: { '728': 'numeric-looking key', '': 'empty key', 'end': 'reserved word' },
          },
        ],
      },
    ],
    customEnvColors: { '272': [255, 128, 0, 255] },
    mapSymbolFontDetails: null,
    playerRoomColors: [[0, 0, 0, 255], [255, 255, 255, 255]],
  });

  it('produces a structurally identical tree', () => {
    const diff = t.run(`
      local s = [==[${MAP_LIKE}]==]
      local a = __yajl_parse__(s)
      local b = yajl.to_value(s)
      local diff
      local function cmp(x, y, path)
        if diff then return end
        if type(x) ~= type(y) then
          diff = path .. ' type ' .. type(x) .. '/' .. type(y); return
        end
        if type(x) ~= 'table' then
          if x ~= y then diff = path .. ' value ' .. tostring(x) .. '/' .. tostring(y) end
          return
        end
        local n = 0
        for k, v in pairs(x) do
          n = n + 1
          cmp(v, y[k], path .. '.' .. tostring(k) .. '(' .. type(k) .. ')')
          if diff then return end
        end
        local m = 0
        for _ in pairs(y) do m = m + 1 end
        if n ~= m then diff = path .. ' keycount ' .. n .. '/' .. m end
      end
      cmp(a, b, 'root')
      return diff or 'identical'
    `);
    expect(diff).toBe('identical');
  });

  it('agrees on nested lookups that map code actually performs', () => {
    const probe = (expr: string) => t.run(`
      local s = [==[${MAP_LIKE}]==]
      return tostring((function(v) return ${expr} end)(__yajl_parse__(s)))
        .. '|' .. tostring((function(v) return ${expr} end)(yajl.to_value(s)))
    `);
    // Same value on both sides of the '|' means the decoders agree.
    for (const expr of [
      'v.areas[2].rooms[1].name',
      'v.areas[2].rooms[1].coordinates[1]',
      'v.areas[2].rooms[1].exits[1].name',
      'v.areas[2].rooms[2].userData["728"]',
      'v.areas[2].rooms[2].hash == yajl.null',
      'v.customEnvColors["272"][4]',
      '#v.areas',
      'type(v.areas[1].rooms)',
    ]) {
      const [oldV, newV] = String(probe(expr)).split('|');
      expect(`${expr} → ${newV}`).toBe(`${expr} → ${oldV}`);
    }
  });
});

describe('luaChunkForValue', () => {
  it('returns null for documents nested past the emit limit', () => {
    // Lua caps nested constructors (LUAI_MAXCCALLS), so deep values must fall
    // back to the raw-API path rather than emitting source that won't compile.
    let deep: unknown = 1;
    for (let i = 0; i < 400; i++) deep = [deep];
    expect(luaChunkForValue(deep)).toBeNull();
  });

  it('emits source for values within the limit', () => {
    expect(luaChunkForValue({ a: [1, 2] })).toContain('return ');
  });
});
