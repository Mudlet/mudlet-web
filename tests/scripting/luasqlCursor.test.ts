// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// The raw luasql.sqlite3 cursor behaves the way LuaSQL's ls_sqlite3.c does.
// DB.lua always passes fetch a table, so these only show to scripts that use
// luasql directly — which is what desktop Mudlet's own luasql binding serves.
describe('luasql.sqlite3 cursor', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  // A fresh database per use: the sqlite client outlives each runtime and
  // hands a reopened path its still-live handle, rows and all.
  let dbSeq = 0;
  const setup = () => `
    local conn = luasql.sqlite3():connect("cursorparity-${++dbSeq}.db")
    conn:execute("CREATE TABLE t (n INTEGER, s TEXT, r REAL)")
    conn:execute("INSERT INTO t VALUES (7, 's', NULL)")
    conn:execute("INSERT INTO t VALUES (8, 'u', 1.5)")
  `;

  it('fetch() with no table returns the row as multiple values', () => {
    expect(env.run(`${setup()}
      local cur = conn:execute("SELECT n, s FROM t ORDER BY n")
      local n, s = cur:fetch()
      return type(n) .. "|" .. tostring(n) .. "|" .. tostring(s) .. "|" .. select("#", cur:fetch())`))
      .toBe('number|7|s|2');
  });

  it('keeps NULL columns in position when returning multiple values', () => {
    expect(env.run(`${setup()}
      local cur = conn:execute("SELECT n, r, s FROM t ORDER BY n")
      local count = select("#", cur:fetch())
      local n, r, s = cur:fetch()
      return count .. "|" .. tostring(n) .. "|" .. tostring(r) .. "|" .. tostring(s)`))
      .toBe('3|8|1.5|u');
  });

  it('returns nil once the rows run out', () => {
    expect(env.run(`${setup()}
      local cur = conn:execute("SELECT n FROM t WHERE n = 7")
      cur:fetch()
      return tostring(cur:fetch())`)).toBe('nil');
  });

  it('fills a table by number, by name, or both, as the mode says', () => {
    expect(env.run(`${setup()}
      local cur = conn:execute("SELECT n, s FROM t ORDER BY n")
      local byNum = cur:fetch({})
      local both = cur:fetch({}, "an")
      return tostring(byNum[1]) .. tostring(byNum.n) .. "|" .. tostring(both[1]) .. tostring(both.n) .. both.s`))
      .toBe('7nil|88u');
    expect(env.run(`${setup()}
      local cur = conn:execute("SELECT n FROM t ORDER BY n")
      local row = cur:fetch({}, "a")
      return tostring(row[1]) .. "|" .. tostring(row.n)`))
      .toBe('nil|7');
  });

  it('reports declared column types, nil for an expression', () => {
    expect(env.run(`${setup()}
      local cur = conn:execute("SELECT n, s, r, n + 1 AS e FROM t")
      local types = cur:getcoltypes()
      return table.concat({ types[1], types[2], types[3], tostring(types[4]) }, ",")`))
      .toBe('INTEGER,TEXT,REAL,nil');
  });

  it('closes once, then refuses to be used', () => {
    expect(env.run(`${setup()}
      local cur = conn:execute("SELECT n FROM t")
      return tostring(cur:close()) .. "|" .. tostring(cur:close())`)).toBe('true|false');
    expect(() => env.run(`${setup()}
      local cur = conn:execute("SELECT n FROM t")
      cur:close()
      cur:fetch()`)).toThrow(/bad argument #1 to 'fetch' \(LuaSQL: cursor is closed\)/);
    expect(() => env.run(`${setup()}
      local cur = conn:execute("SELECT n FROM t")
      cur:close()
      cur:getcolnames()`)).toThrow(/LuaSQL: cursor is closed/);
  });

  it('prefixes errors with "LuaSQL: " instead of the sqlite result code', () => {
    expect(env.run(`${setup()}
      local cur, err = conn:execute("SELECT * FROM missing")
      return tostring(cur) .. "|" .. err`)).toBe('nil|LuaSQL: no such table: missing');
  });
});
