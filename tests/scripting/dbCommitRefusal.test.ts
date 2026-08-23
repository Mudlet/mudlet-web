// @vitest-environment node
//
// db.Database:_commit answers (false, why) rather than swallowing a refusal.
// That return value exists because db:create turns the driver's own autocommit
// off for every database it makes: nothing lands until a commit goes through, so
// a "true" over a refused one loses the work silently.
//
// mudix keeps a database in wasm memory rather than in a file, so it cannot
// reproduce the way DB_spec provokes a refusal — a second connection holding the
// file's lock (see e2e/knownDivergences.ts). The refusals it CAN meet are the
// ones SQLite raises at COMMIT on one connection: a DEFERRABLE constraint
// checked only when the transaction ends, and a database that has outgrown what
// the wasm heap can still grow to. Those go through the same Luasql.lua path,
// which is what this pins.
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

  it('conn:commit answers false and says why', () => {
    expect(env.run(`${armDeferredViolation}
      local ok, err = conn:commit()
      return tostring(ok) .. "|" .. tostring(err)`))
      .toMatch(/^false\|.*FOREIGN KEY constraint failed/);
  });

  it('leaves the transaction open, as SQLite does, so the work is still there', () => {
    // A refused COMMIT does not end the transaction. The shim must not mark it
    // ended either, or the next BEGIN errors out on a transaction already live.
    expect(env.run(`${armDeferredViolation}
      conn:commit()
      conn:execute("DELETE FROM child")
      local ok = conn:commit()
      local rows = conn:execute("SELECT COUNT(*) FROM child")
      return tostring(ok) .. "|" .. tostring(rows:fetch()[1])`))
      .toBe('true|0');
  });

  it('a rollback still discards the work a refused commit left pending', () => {
    expect(env.run(`${armDeferredViolation}
      conn:commit()
      conn:rollback()
      local rows = conn:execute("SELECT COUNT(*) FROM child")
      return rows:fetch()[1]`))
      .toBe(0);
  });

  it('setautocommit(true) reports it too rather than turning the flag over lost work', () => {
    expect(env.run(`${armDeferredViolation}
      local ok, err = conn:setautocommit(true)
      return tostring(ok) .. "|" .. tostring(err)`))
      .toMatch(/^false\|.*FOREIGN KEY constraint failed/);
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
