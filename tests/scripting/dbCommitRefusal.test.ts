// @vitest-environment node
//
// conn:commit answers (nil, why) rather than swallowing a refusal, and
// db.Database:_commit passes it on. That return value exists because db:create
// turns the driver's own autocommit off for every database it makes: nothing
// lands until a commit goes through, so a "true" over a refused one loses the
// work silently.
//
// The refusals pinned here are the ones SQLite raises at COMMIT on one
// connection — a DEFERRABLE constraint checked only when the transaction ends —
// and the one DB_spec provokes, a second connection part way through reading
// (tests/scripting/luasqlConnections.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('a refused COMMIT is reported, not swallowed', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  /** A connection inside a transaction holding a deferred foreign key violation,
   *  which SQLite refuses only when the COMMIT arrives. */
  const armDeferredViolation = `
    local conn = luasql.sqlite3():connect("commitrefusal.db")
    conn:execute("PRAGMA foreign_keys = ON")
    conn:execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
    conn:execute([[CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER
      REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)]])
    conn:setautocommit(false)
    conn:execute("INSERT INTO child (id, pid) VALUES (1, 999)")
  `;

  it('conn:commit answers nil and says why', () => {
    expect(env.run(`${armDeferredViolation}
      local ok, err = conn:commit()
      return tostring(ok) .. "|" .. tostring(err)`))
      .toBe('nil|LuaSQL: FOREIGN KEY constraint failed');
  });

  it('leaves the transaction open, as SQLite does, so the work is still there', () => {
    // A refused COMMIT does not end the transaction. The shim must not mark it
    // ended either, or the next BEGIN errors out on a transaction already live.
    expect(env.run(`${armDeferredViolation}
      conn:commit()
      conn:execute("DELETE FROM child")
      local ok = conn:commit()
      local rows = conn:execute("SELECT COUNT(*) FROM child")
      return tostring(ok) .. "|" .. tostring((rows:fetch()))`))
      .toBe('true|0');
  });

  it('a rollback still discards the work a refused commit left pending', () => {
    expect(env.run(`${armDeferredViolation}
      conn:commit()
      conn:rollback()
      local rows = conn:execute("SELECT COUNT(*) FROM child")
      return (rows:fetch())`))
      .toBe(0);
  });

  it('setautocommit(true) rolls the open transaction back, as LuaSQL does', () => {
    // ls_sqlite3.c conn_setautocommit: "undo active transaction - ignore errors"
    expect(env.run(`${armDeferredViolation}
      local ok, err = conn:setautocommit(true)
      local rows = conn:execute("SELECT COUNT(*) FROM child")
      return tostring(ok) .. "|" .. tostring(err) .. "|" .. tostring((rows:fetch()))`))
      .toBe('true|nil|0');
  });

  it('a healthy commit still answers true', () => {
    expect(env.run(`
      local conn = luasql.sqlite3():connect("commitok.db")
      conn:execute("CREATE TABLE t (n INTEGER)")
      conn:setautocommit(false)
      conn:execute("INSERT INTO t VALUES (1)")
      local ok, err = conn:commit()
      return tostring(ok) .. "|" .. tostring(err)`))
      .toBe('true|nil');
  });
});
