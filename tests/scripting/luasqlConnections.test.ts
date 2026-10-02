// @vitest-environment node
//
// luasql.sqlite3 and the db:* API behave as they do on desktop Mudlet, where
// each connection is LuaSQL 2.6's own sqlite handle on a database file
// (ls_sqlite3.c). Each block is one item of issue #274, reproduced against the
// real Mudlet PTB: the expected values are desktop's.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/** In-memory stand-in for ProfileVFS: the methods the io and sql bridges use,
 *  including the read barrier ProfileVFS runs before every read. */
class StubVFS {
    profilePath = '/profiles/test';
    files = new Map<string, Uint8Array>();
    dirs = new Set<string>(['/', '/profiles', '/profiles/test']);
    private barrier: ((abs: string) => void) | null = null;
    setReadBarrier(b: ((abs: string) => void) | null): void { this.barrier = b; }
    private read(abs: string): string { this.barrier?.(abs); return abs; }
    resolvePath(p: string): string { return p.startsWith('/') ? p : `${this.profilePath}/${p}`; }
    exists(p: string): boolean { const a = this.resolvePath(p); return this.files.has(a) || this.dirs.has(a); }
    readBinaryFile(p: string): Uint8Array {
        const bytes = this.files.get(this.read(this.resolvePath(p)));
        if (!bytes) throw new Error(`ENOENT: ${p}`);
        return bytes;
    }
    writeBinaryFile(p: string, data: Uint8Array): void { this.files.set(this.resolvePath(p), new Uint8Array(data)); }
    readFile(p: string): string { return new TextDecoder().decode(this.readBinaryFile(p)); }
    writeFile(p: string, content: string): void { this.writeBinaryFile(p, new TextEncoder().encode(content)); }
    deleteFile(p: string): void { this.files.delete(this.resolvePath(p)); }
    remove(p: string): void { this.files.delete(this.resolvePath(p)); }
    stat(p: string): { type: 'file' | 'dir'; size: number } | null {
        const abs = this.read(this.resolvePath(p));
        if (this.files.has(abs)) return { type: 'file', size: this.files.get(abs)!.byteLength };
        return this.dirs.has(abs) ? { type: 'dir', size: 0 } : null;
    }
}

const H = 'getMudletHomeDir()';

describe('luasql connections and the db:* API match desktop', () => {
    let vfs: StubVFS;
    let env: TestRuntime;
    beforeEach(async () => {
        vfs = new StubVFS();
        env = await createTestRuntime({ vfs: vfs as unknown as ProfileVFS });
    });
    afterEach(() => env.dispose());

    /** Restart the client over the same profile files. */
    const restart = async () => {
        env.dispose();
        env = await createTestRuntime({ vfs: vfs as unknown as ProfileVFS });
    };

    const count = (path: string, table: string) => `(function()
        local c = luasql.sqlite3():connect(${path})
        local cu, err = c:execute("select count(*) from ${table}")
        if not cu then c:close() return err end
        local n = cu:fetch(); cu:close(); c:close(); return n
    end)()`;

    describe('1. uncommitted work is rolled back, not committed', () => {
        it('raw luasql: close drops what autocommit-off work never committed', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(${H}.."/r5a.db")
                c:execute("create table t(a)"); c:setautocommit(false)
                c:execute("insert into t values (1),(2)"); c:close()
                return ${count(`${H}.."/r5a.db"`, 't')}`)).toBe(0);
        });

        it('db:*: db:close drops an open _begin', () => {
            expect(env.run(`
                local d = db:create("rfiveb", {k={a=0}}); db:add(d.k,{a=1})
                d:_begin(); db:add(d.k,{a=2},{a=3}); db:close()
                return ${count(`${H}.."/Database_rfiveb.db"`, 'k')}`)).toBe(1);
        });

        it('a restart keeps committed rows and drops uncommitted ones', async () => {
            env.run(`
                local d = db:create("rfivec", {k={a=0}})
                for i = 1, 100 do db:add(d.k, {a=i}) end
                d:_begin(); db:add(d.k, {a=-1})
                local c = luasql.sqlite3():connect(${H}.."/raw.db")
                c:execute("create table t(a)"); c:setautocommit(false); c:execute("insert into t values (1)")
                _G.keep = {d, c}`);
            await restart();
            expect(env.run(`
                local c = luasql.sqlite3():connect(${H}.."/Database_rfivec.db")
                local cu = c:execute("select count(*), sum(a) from k"); local n, s = cu:fetch(); cu:close(); c:close()
                return n .. "/" .. s .. "/" .. ${count(`${H}.."/raw.db"`, 't')}`)).toBe('100/5050/0');
        });
    });

    describe('2. every connection is its own handle', () => {
        it('closing a side connection leaves db:* working', () => {
            expect(env.run(`
                local a = db:create("rea", {k={a=0}}); db:add(a.k,{a=1},{a=2})
                local c = luasql.sqlite3():connect(${H}.."/Database_rea.db")
                local cu = c:execute("select count(*) from k"); cu:fetch(); cu:close(); c:close()
                local ok = db:add(a.k,{a=3})
                local agg = db:aggregate(a.k.a, "sum")
                return tostring(ok) .. "|" .. #db:fetch(a.k) .. "|" .. agg .. "|" .. tostring((a:_commit()))`))
                .toBe('true|3|6|true');
        });

        it('a second connection does not see work inside an open _begin', () => {
            expect(env.run(`
                local a = db:create("reb", {k={a=0}}); db:add(a.k,{a=1})
                a:_begin(); db:add(a.k,{a=2})
                local n = ${count(`${H}.."/Database_reb.db"`, 'k')}
                a:_rollback(); a:_end()
                return n`)).toBe(1);
        });

        it('a reader part way through its rows makes _commit answer false (DB_spec)', () => {
            expect(env.run(`
                local mydb = db:create("refusal", {sheet={name=""}})
                db:add(mydb.sheet, {name="committed"})
                local reader_env = luasql.sqlite3()
                local reader = reader_env:connect(${H}.."/Database_refusal.db")
                local cursor = reader:execute("SELECT name FROM sheet")
                cursor:fetch()
                mydb:_begin(); db:add(mydb.sheet, {name="blocked"})
                local ok, msg = mydb:_commit()
                mydb:_rollback(); mydb:_end()
                cursor:close(); reader:close(); reader_env:close()
                local names = {}
                for _, r in ipairs(db:fetch(mydb.sheet)) do names[#names + 1] = r.name end
                return tostring(ok) .. "|" .. tostring(msg:find("refusal", 1, true) ~= nil) .. "|" .. table.concat(names, ",")`))
                .toBe('false|true|committed');
        });

        it('a connection that is garbage collected is closed, its uncommitted work with it', () => {
            expect(env.run(`
                local w = luasql.sqlite3():connect(${H}.."/gc.db")
                w:execute("create table t(a)"); w:setautocommit(false); w:execute("insert into t values (1)")
                local other = luasql.sqlite3():connect(${H}.."/gc.db")
                local _, before = other:execute("insert into t values (2)")
                w = nil; collectgarbage("collect"); collectgarbage("collect")
                local after = other:execute("insert into t values (3)")
                local cu = other:execute("select group_concat(a) from t"); local all = cu:fetch(); cu:close()
                return tostring(before) .. "|" .. tostring(after) .. "|" .. all`))
                .toBe('LuaSQL: database is locked|1|3');
        });

        it('the read lock goes once the rows run out', () => {
            expect(env.run(`
                local w = luasql.sqlite3():connect(${H}.."/lock.db")
                w:execute("create table t(a)"); w:execute("insert into t values (1)")
                local r = luasql.sqlite3():connect(${H}.."/lock.db")
                local cu = r:execute("select a from t"); cu:fetch()
                local _, blocked = w:execute("insert into t values (2)")
                cu:fetch() -- nil: the rows ran out, the cursor closed itself
                local after = w:execute("insert into t values (3)")
                return tostring(blocked) .. "|" .. tostring(after)`))
                .toBe('LuaSQL: database is locked|1');
        });
    });

    describe('3. text that is not UTF-8 is stored byte for byte', () => {
        it('through db:add and db:fetch', () => {
            expect(env.run(`
                local b = db:create("rbytes", {j={x=""}})
                db:add(b.j, {x="\\255\\254\\128A"})
                local v = db:fetch(b.j)[1].x
                local c = luasql.sqlite3():connect(${H}.."/Database_rbytes.db")
                local cu = c:execute("select hex(x) from j"); local hex = cu:fetch(); cu:close(); c:close()
                return table.concat({v:byte(1, -1)}, " ") .. "|" .. hex`)).toBe('255 254 128 65|FFFE8041');
        });

        it('through a raw literal, NUL-free text and blobs alike', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(":memory:")
                c:execute("create table b(a)")
                c:execute("insert into b values ('\\255\\254\\128A')")
                c:execute("insert into b values (x'00FF80')")
                local cu = c:execute("select a, hex(a) from b order by rowid")
                local t, th = cu:fetch(); local bl = cu:fetch()
                cu:close(); c:close()
                return table.concat({t:byte(1, -1)}, " ") .. "|" .. th .. "|" .. table.concat({bl:byte(1, -1)}, " ")`))
                .toBe('255 254 128 65|FFFE8041|0 255 128');
        });
    });

    it('4. the .db file read right after a write holds it', () => {
        expect(env.run(`
            local d = db:create("rcopy", {k={a=0}, j={b=0}})
            for i = 1, 50 do db:add(d.k, {a=i}) end
            db:add(d.j, {b=1})
            local src = assert(io.open(${H}.."/Database_rcopy.db", "rb")); local data = src:read("*a"); src:close()
            local dst = assert(io.open(${H}.."/copy.db", "wb")); dst:write(data); dst:close()
            return ${count(`${H}.."/copy.db"`, 'k')} .. " | " .. ${count(`${H}.."/copy.db"`, 'j')}`)).toBe('50 | 1');
    });

    it('5. integers beyond 2^53 come back as numbers', () => {
        expect(env.run(`
            local c = luasql.sqlite3():connect(":memory:")
            local cu = c:execute("select 9223372036854775807, 9007199254740993, 1727800000123456789")
            local a, b, d = cu:fetch(); cu:close(); c:close()
            return type(a) .. type(b) .. type(d) .. "|" .. tostring(a > 0) .. "|" .. tostring(d == 1727800000123456789)`))
            .toBe('numbernumbernumber|true|true');
    });

    it('6. every :memory: connection is a private database, and no file', () => {
        expect(env.run(`
            local c = luasql.sqlite3():connect(":memory:"); c:execute("create table m(a)"); c:execute("insert into m values(1)")
            local c2 = luasql.sqlite3():connect(":memory:")
            local cu, err = c2:execute("select count(*) from m")
            c:close(); c2:close()
            return tostring(cu) .. "|" .. err .. "|" .. tostring(io.exists(":memory:"))`))
            .toBe('nil|LuaSQL: no such table: m|false');
    });

    it('7. connect to a path that cannot be opened fails', () => {
        expect(env.run(`
            local c, err = luasql.sqlite3():connect(${H}.."/nodir/sub/x.db")
            return tostring(c) .. "|" .. err`)).toBe('nil|LuaSQL: unable to open database file');
        expect(vfs.files.has('/profiles/test/nodir/sub/x.db')).toBe(false);
    });

    it('8. conn:getlastautoid', () => {
        expect(env.run(`
            local c = luasql.sqlite3():connect(":memory:"); c:execute("create table t(a)")
            c:execute("insert into t values (5)"); c:execute("insert into t values (6)")
            local id = c:getlastautoid(); c:close(); return id`)).toBe(2);
    });

    describe('9. lifecycle and error semantics', () => {
        const conn = `local env = luasql.sqlite3(); local c = env:connect(":memory:"); c:execute("create table t(a)")`;

        it('runs only the first of two statements', () => {
            expect(env.run(`${conn}
                c:execute("insert into t values (1); insert into t values (2), (3)")
                local cu = c:execute("select count(*) from t"); return (cu:fetch())`)).toBe(1);
        });

        it('closes a cursor once its rows run out', () => {
            expect(env.run(`${conn}
                c:execute("insert into t values (1)")
                local cu = c:execute("select a from t"); cu:fetch()
                local n = select("#", cu:fetch())
                local ok, err = pcall(cu.getcolnames, cu)
                return n .. "|" .. tostring(ok) .. "|" .. err .. "|" .. tostring(cu:close())`))
                .toBe("1|false|bad argument #1 to '?' (LuaSQL: cursor is closed)|false");
        });

        it('refuses to close a connection with a cursor open', () => {
            expect(env.run(`${conn}
                local cu = c:execute("select a from t")
                local ok, err = pcall(c.close, c)
                cu:close()
                return tostring(ok) .. "|" .. err .. "|" .. tostring(c:close())`))
                .toBe('false|LuaSQL: there are open cursors|true');
        });

        it('commit and rollback with no transaction active are errors', () => {
            expect(env.run(`${conn}
                local a, ae = c:commit(); local b, be = c:rollback()
                return tostring(a) .. "|" .. ae .. "|" .. tostring(b) .. "|" .. be`))
                .toBe('nil|LuaSQL: cannot commit - no transaction is active|nil|LuaSQL: cannot rollback - no transaction is active');
        });

        it('raises on a closed connection or environment', () => {
            expect(() => env.run(`${conn} c:close(); c:execute("select 1")`))
                .toThrow(/calling 'execute' on bad self \(LuaSQL: connection is closed\)/);
            expect(() => env.run(`${conn} env:close(); env:connect(":memory:")`))
                .toThrow(/calling 'connect' on bad self \(LuaSQL: environment is closed\)/);
        });

        it('env:close twice is false; objects are userdata named as desktop names them', () => {
            expect(env.run(`${conn}
                local cu = c:execute("select a from t")
                local names = tostring(env):match("^SQLite3 environment %(0x%x+%)$") and tostring(c):match("^SQLite3 connection %(0x%x+%)$")
                    and tostring(cu):match("^SQLite3 cursor %(0x%x+%)$") and "named" or "unnamed"
                local types = type(env) .. type(c) .. type(cu)
                cu:close(); c:close()
                return types .. "|" .. names .. "|" .. tostring(c) .. "|" .. tostring(env:close()) .. tostring(env:close())`))
                .toBe('userdatauserdatauserdata|named|SQLite3 connection (closed)|truefalse');
        });

        it('carries the module info fields', () => {
            expect(env.run(`return luasql._VERSION .. "|" .. luasql._COPYRIGHT .. "|" .. luasql._DESCRIPTION .. "|" .. type(luasql._CLIENTVERSION)`))
                .toBe('LuaSQL 2.6.0 (for Lua 5.1)|Copyright (C) 2003-2020 Kepler Project|LuaSQL is a simple interface from Lua to a DBMS|string');
        });

        it('escape doubles quotes and stops at a NUL, like %q', () => {
            expect(env.run(`${conn} return c:escape("it's\\0gone")`)).toBe("it''s");
        });

        it('setautocommit(false) inside a transaction raises', () => {
            expect(() => env.run(`${conn} c:setautocommit(false); c:setautocommit(false)`))
                .toThrow(/LuaSQL: cannot start a transaction within a transaction/);
        });
    });
});
