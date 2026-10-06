// @vitest-environment node
//
// luasql and the db:* API against desktop Mudlet's, item by item of issue
// #335: cursors that read one row per fetch, commits that reach the profile
// before the page can close, a database file changed under an open
// connection, ATTACH / VACUUM INTO on profile files, and desktop's SQLite
// (3.37) number text and round(). Expected values are the desktop PTB's.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { configure, InMemory, mkdirSync, existsSync, readFileSync } from '@zenfs/core';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { round337 } from '../../src/db/sqliteClient';

/** In-memory stand-in for ProfileVFS: what the io and sql bridges use, with
 *  the read barrier and write observer ProfileVFS runs. */
class StubVFS {
    profilePath = '/profiles/test';
    files = new Map<string, Uint8Array>();
    dirs = new Set<string>(['/', '/profiles', '/profiles/test']);
    flushes = 0;
    private barrier: ((abs: string) => void) | null = null;
    private observer: ((abs: string, kind: 'write' | 'remove') => void) | null = null;
    setReadBarrier(b: ((abs: string) => void) | null): void { this.barrier = b; }
    setWriteObserver(o: ((abs: string, kind: 'write' | 'remove') => void) | null): void { this.observer = o; }
    async flush(): Promise<void> { this.flushes++; }
    private read(abs: string): string { this.barrier?.(abs); return abs; }
    resolvePath(p: string): string {
        const abs = p.startsWith('/') ? p : `${this.profilePath}/${p}`;
        const out: string[] = [];
        for (const part of abs.split('/')) {
            if (part === '' || part === '.') continue;
            if (part === '..') out.pop(); else out.push(part);
        }
        return '/' + out.join('/');
    }
    exists(p: string): boolean { const a = this.resolvePath(p); return this.files.has(a) || this.dirs.has(a); }
    readBinaryFile(p: string): Uint8Array {
        const bytes = this.files.get(this.read(this.resolvePath(p)));
        if (!bytes) throw new Error(`ENOENT: ${p}`);
        return bytes;
    }
    writeBinaryFile(p: string, data: Uint8Array): void {
        const abs = this.resolvePath(p);
        this.files.set(abs, new Uint8Array(data));
        this.observer?.(abs, 'write');
    }
    readFile(p: string): string { return new TextDecoder().decode(this.readBinaryFile(p)); }
    writeFile(p: string, content: string): void { this.writeBinaryFile(p, new TextEncoder().encode(content)); }
    deleteFile(p: string): void { this.remove(p); }
    remove(p: string): void {
        const abs = this.resolvePath(p);
        if (!this.files.delete(abs)) throw new Error(`ENOENT: ${p}`);
        this.observer?.(abs, 'remove');
    }
    rename(from: string, to: string): void {
        const a = this.read(this.resolvePath(from));
        const b = this.resolvePath(to);
        const bytes = this.files.get(a);
        if (!bytes) throw new Error(`ENOENT: ${from}`);
        this.files.delete(a);
        this.files.set(b, bytes);
        this.observer?.(a, 'remove');
        this.observer?.(b, 'remove');
    }
    stat(p: string): { type: 'file' | 'dir'; size: number } | null {
        const abs = this.read(this.resolvePath(p));
        if (this.files.has(abs)) return { type: 'file', size: this.files.get(abs)!.byteLength };
        return this.dirs.has(abs) ? { type: 'dir', size: 0 } : null;
    }
}

const H = 'getMudletHomeDir()';
const tick = () => new Promise(r => setTimeout(r, 5));

describe('issue #335: luasql and db:* match desktop', () => {
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

    /** A fresh connection's answer to one single-value query. */
    const one = (path: string, sql: string) => `(function()
        local c = luasql.sqlite3():connect(${path})
        local cu, err = c:execute("${sql}")
        if not cu then c:close() return err end
        local v = cu:fetch(); if v then cu:close() end; c:close(); return v
    end)()`;

    describe('1. a cursor reads one row per fetch, seeing its connection\'s writes', () => {
        const seed = (name: string) => `
            local c = luasql.sqlite3():connect(${H}.."/${name}.db")
            c:execute("create table t(a integer primary key, v text)")
            for i = 1, 6 do c:execute("insert into t values ("..i..", 'v"..i.."')") end
            local cu = c:execute("select a, v from t order by a")
            local seen = {}`;

        it('a row deleted ahead of the cursor is not returned', () => {
            expect(env.run(`${seed('del')}
                local a = cu:fetch()
                c:execute("delete from t where a = 4")
                while a do seen[#seen + 1] = a; a = cu:fetch() end
                return table.concat(seen, ",")`)).toBe('1,2,3,5,6');
        });

        it('a row updated ahead of the cursor comes back updated', () => {
            expect(env.run(`${seed('upd')}
                local a, v = cu:fetch()
                c:execute("update t set v = 'CHANGED' where a = 5")
                while a do seen[#seen + 1] = a .. ":" .. v; a, v = cu:fetch() end
                return table.concat(seen, ",")`)).toBe('1:v1,2:v2,3:v3,4:v4,5:CHANGED,6:v6');
        });

        it('a row inserted past the cursor is returned', () => {
            expect(env.run(`${seed('ins')}
                local a = cu:fetch()
                c:execute("delete from t where a = 4")
                c:execute("insert into t values (100, 'new')")
                while a do seen[#seen + 1] = a; a = cu:fetch() end
                return table.concat(seen, ",") .. " (" .. #seen .. " rows)"`)).toBe('1,2,3,5,6,100 (6 rows)');
        });

        it('deleting the next row on each fetch skips it', () => {
            expect(env.run(`${seed('next')}
                local a = cu:fetch()
                while a do
                    seen[#seen + 1] = a
                    c:execute("delete from t where a = " .. (a + 1))
                    a = cu:fetch()
                end
                return table.concat(seen, ",")`)).toBe('1,3,5');
        });

        it('a failing step ends the cursor with nil and the error', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(":memory:")
                local cu = c:execute("select abs(x) from (select 1 as x union all select -9223372036854775807 - 1)")
                local first = cu:fetch()
                local v, err = cu:fetch()
                return first .. "|" .. tostring(v) .. "|" .. err .. "|" .. tostring(cu:close())`))
                .toBe('1|nil|LuaSQL: integer overflow|false');
        });
    });

    describe('2. a commit reaches the profile by the end of its task', () => {
        it('db:add and a raw insert are in the file, and the file flushed, before any close', async () => {
            env.run(`
                local d = db:create("quick", {k={a=0}})
                db:add(d.k, {a=1}, {a=2}, {a=3})
                local c = luasql.sqlite3():connect(${H}.."/raw.db")
                c:execute("create table t(a)")
                _G.keep = {d, c}
                db:add(d.k, {a=100}); c:execute("insert into t values (7)")`);
            const flushesBefore = vfs.flushes;
            await tick();
            expect(vfs.flushes).toBeGreaterThan(flushesBefore);
            // Read the files as a page opened after a crash would: a second
            // profile holding copies of them, with nothing of the first open.
            const copy = new StubVFS();
            copy.profilePath = '/profiles/copy';
            copy.dirs.add('/profiles/copy');
            for (const [k, v] of vfs.files) copy.files.set(k.replace('/profiles/test/', '/profiles/copy/'), v);
            const other = await createTestRuntime({ vfs: copy as unknown as ProfileVFS });
            try {
                expect(other.run(`
                    local c = luasql.sqlite3():connect(${H}.."/Database_quick.db")
                    local cu = c:execute("select count(*), sum(a) from k")
                    local n, sum = cu:fetch(); cu:close(); c:close()
                    return n .. "/" .. sum .. "|" .. ${one(`${H}.."/raw.db"`, 'select a from t')}`)).toBe('4/106|7');
            } finally {
                other.dispose();
            }
        });
    });

    describe('3. a database file changed under an open connection', () => {
        it('bytes copied over it with io are what the connection reads, and survive a restart', async () => {
            const result = env.run(`
                local d = db:create("restore", {k={a=0}})
                db:add(d.k, {a=1}, {a=3})
                local function copy(from, to)
                    local f = assert(io.open(from, "rb")); local data = f:read("*a"); f:close()
                    local g = assert(io.open(to, "wb")); g:write(data); g:close()
                end
                local path = ${H}.."/Database_restore.db"
                copy(path, ${H}.."/backup.db")
                db:add(d.k, {a=2})
                -- (read on a side connection: a db:fetch here would leave the db:*
                -- connection in its read transaction, on desktop as here, and it
                -- would go on reading that snapshot until its next commit)
                local before = ${one('path', 'select group_concat(a) from (select a from k order by a)')}
                copy(${H}.."/backup.db", path)
                local after = {}
                for _, r in ipairs(db:fetch(d.k, nil, {d.k.a})) do after[#after + 1] = r.a end
                _G.keep = d
                return before .. "|" .. table.concat(after, ",")`);
            expect(result).toBe('1.0,2.0,3.0|1,3');
            await restart();
            expect(env.run(`
                local d = db:create("restore", {k={a=0}})
                local out = {}
                for _, r in ipairs(db:fetch(d.k, nil, {d.k.a})) do out[#out + 1] = r.a end
                return table.concat(out, ",")`)).toBe('1,3');
        });

        it('a raw connection reads what was copied over its file', () => {
            expect(env.run(`
                local a = luasql.sqlite3():connect(${H}.."/a.db")
                a:execute("create table t(x)"); a:execute("insert into t values (1),(2),(3)")
                local b = luasql.sqlite3():connect(${H}.."/b.db")
                b:execute("create table t(x)"); b:execute("insert into t values (1),(3)"); b:close()
                local f = assert(io.open(${H}.."/b.db", "rb")); local data = f:read("*a"); f:close()
                local g = assert(io.open(${H}.."/a.db", "wb")); g:write(data); g:close()
                local cu = a:execute("select group_concat(x) from t"); local all = cu:fetch(); cu:close()
                return all`)).toBe('1,3');
        });

        it('a removed file stays removed: writes are refused and nothing comes back', async () => {
            const result = env.run(`
                local d = db:create("reset", {k={a=0}})
                db:add(d.k, {a=1}, {a=2}, {a=3})
                local path = ${H}.."/Database_reset.db"
                local removed = os.remove(path)
                local ok, err = db:add(d.k, {a=4})
                return tostring(removed) .. "|" .. tostring(ok) .. "|" .. tostring(err) .. "|" .. tostring(io.exists(path))`) as string;
            const [removed, , err, exists] = result.split('|');
            expect(removed).toBe('true');
            expect(err).toContain('attempt to write a readonly database');
            expect(exists).toBe('false');
            await tick();
            expect(vfs.files.has('/profiles/test/Database_reset.db')).toBe(false);
            await restart();
            expect(env.run(`
                local d = db:create("reset", {k={a=0}})
                return #db:fetch(d.k)`)).toBe(0);
        });

        it('a raw connection on a removed file still reads it, and cannot write', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(${H}.."/gone.db")
                c:execute("create table t(x)"); c:execute("insert into t values (1),(2)")
                os.remove(${H}.."/gone.db")
                local _, err = c:execute("insert into t values (3)")
                local cu = c:execute("select group_concat(x) from t"); local all = cu:fetch(); cu:close()
                return all .. "|" .. err .. "|" .. tostring(io.exists(${H}.."/gone.db"))`))
                .toBe('1,2|LuaSQL: attempt to write a readonly database|false');
        });

        it('a file renamed away takes the committed rows with it', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(${H}.."/moved.db")
                c:execute("create table t(x)"); c:execute("insert into t values (1),(2)")
                os.rename(${H}.."/moved.db", ${H}.."/elsewhere.db")
                local _, err = c:execute("insert into t values (3)")
                return err .. "|" .. ${one(`${H}.."/elsewhere.db"`, 'select group_concat(x) from t')}`))
                .toBe('LuaSQL: attempt to write a readonly database|1,2');
        });
    });

    describe('4. ATTACH and VACUUM INTO reach profile files', () => {
        it('attaches an existing file', () => {
            expect(env.run(`
                local o = luasql.sqlite3():connect(${H}.."/other.db")
                o:execute("create table ot(x)"); o:execute("insert into ot values ('fromother')"); o:close()
                local c = luasql.sqlite3():connect(":memory:")
                assert(c:execute("attach database '"..${H}.."/other.db' as o"))
                local cu = c:execute("select * from o.ot"); local v = cu:fetch(); cu:close()
                return v`)).toBe('fromother');
        });

        it('attaches a new file, creating it, and what is written to it is kept', async () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(${H}.."/main.db")
                local r1 = c:execute("attach database '"..${H}.."/fresh.db' as f")
                local r2 = c:execute("create table f.ft(x)")
                local r3 = c:execute("insert into f.ft values (42)")
                _G.keep = c
                return tostring(r1) .. tostring(r2) .. tostring(r3)`))
                .toBe('001');
            await tick();
            expect(vfs.files.has('/profiles/test/fresh.db')).toBe(true);
            expect(env.run(`return ${one(`${H}.."/fresh.db"`, 'select x from ft')}`)).toBe(42);
        });

        it('a relative ATTACH is relative to the profile', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(":memory:")
                c:execute("attach database 'rel.db' as r"); c:execute("create table r.t(x)")
                local cu = c:execute("select file from pragma_database_list where name = 'r'")
                local file = cu:fetch(); cu:close(); c:close()
                return file`)).toBe('/profiles/test/rel.db');
        });

        it('VACUUM INTO writes the backup file', async () => {
            expect(env.run(`
                local d = db:create("vac", {k={a=0}})
                for i = 1, 10 do db:add(d.k, {a=i}) end
                local c = luasql.sqlite3():connect(${H}.."/Database_vac.db")
                local n, err = c:execute("vacuum into '"..${H}.."/backup.db'")
                c:close()
                return tostring(n) .. tostring(err) .. "|" .. ${one(`${H}.."/backup.db"`, 'select sum(a) from k')}`))
                .toBe('0nil|55');
            await tick();
            expect(vfs.files.has('/profiles/test/backup.db')).toBe(true);
        });

        it('an ATTACH into a missing directory fails as desktop\'s does', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(":memory:")
                local _, err = c:execute("attach database '"..${H}.."/nodir/x.db' as x")
                return err`)).toBe('LuaSQL: unable to open database: /profiles/test/nodir/x.db');
        });

        it('the main database reports its real path', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(${H}.."/named.db")
                local cu = c:execute("select file from pragma_database_list where name = 'main'")
                local file = cu:fetch(); cu:close(); c:close()
                return file`)).toBe('/profiles/test/named.db');
        });
    });

    describe('5. numbers turned into text, and round(), as desktop\'s SQLite 3.37 does them', () => {
        it('CAST gives 15 significant digits', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(":memory:")
                local cu = c:execute("select cast(0.1+0.2 as text), cast(1e15 as text), cast(1.0/3 as text)")
                local a, b, d = cu:fetch(); cu:close(); c:close()
                return a .. "|" .. b .. "|" .. d`)).toBe('0.3|1.0e+15|0.333333333333333');
        });

        it('db:add of a number into a TEXT column stores desktop\'s text', () => {
            expect(env.run(`
                local d = db:create("numtext", {k={s=""}})
                db:add(d.k, {s=9007199254741000}, {s=0.1+0.2})
                local out = {}
                for _, r in ipairs(db:fetch(d.k)) do out[#out + 1] = type(r.s) .. ":" .. r.s end
                return table.concat(out, ",")`)).toBe('string:9.007199254741e+15,string:0.3');
        });

        it('round() rounds as 3.37 does', () => {
            expect(env.run(`
                local c = luasql.sqlite3():connect(":memory:")
                local cu = c:execute("select round(1.005,2), round(2.675,2), round(2.5), round(-2.5), round(-1.005,2), round(null), round(1.5,null), typeof(round(3))")
                local r = {cu:fetch()}; cu:close(); c:close()
                return table.concat({tostring(r[1]), tostring(r[2]), tostring(r[3]), tostring(r[4]), tostring(r[5]), tostring(r[6]), tostring(r[7]), r[8]}, ",")`))
                .toBe('1.01,2.68,3,-3,-1.01,nil,nil,real');
        });

        it('round337 keeps 16 significant digits and leaves huge values alone', () => {
            expect(round337(0.125, 2)).toBe(0.13);
            expect(round337(123456789.123456789, 10)).toBe(123456789.1234567);
            expect(round337(1e300, 2)).toBe(1e300);
            expect(round337(0.0049, 2)).toBe(0);
            expect(round337(12.345, 0)).toBe(12);
            expect(round337(-0.5, 0)).toBe(-1);
        });
    });
});

// The same, over a real ProfileVFS on an in-memory ZenFS: the write observer
// is ProfileVFS's own, wired through io, os.remove and os.rename.
describe('issue #335 over a real ProfileVFS', () => {
    const PROFILE = '/profiles/drift335';
    let t: TestRuntime;
    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        t = await createTestRuntime({ vfs: new Ctor('drift335', {}, 'idb') });
    });
    afterAll(() => t.dispose());

    it('io writing over an open database replaces what its connection reads', () => {
        expect(t.run(`
            local a = luasql.sqlite3():connect(${H}.."/a.db")
            a:execute("create table t(x)"); a:execute("insert into t values (1),(2),(3)")
            local b = luasql.sqlite3():connect(${H}.."/b.db")
            b:execute("create table t(x)"); b:execute("insert into t values (1),(3)"); b:close()
            local f = assert(io.open(${H}.."/b.db", "rb")); local data = f:read("*a"); f:close()
            local g = assert(io.open(${H}.."/a.db", "wb")); g:write(data); g:close()
            local cu = a:execute("select group_concat(x) from t"); local all = cu:fetch(); cu:close(); a:close()
            return all`)).toBe('1,3');
    });

    it('os.remove leaves the connection on the unlinked file and the file gone', async () => {
        expect(t.run(`
            local c = luasql.sqlite3():connect(${H}.."/rm.db")
            c:execute("create table t(x)"); c:execute("insert into t values (1)")
            os.remove(${H}.."/rm.db")
            local _, err = c:execute("insert into t values (2)")
            c:close()
            return err`)).toBe('LuaSQL: attempt to write a readonly database');
        await tick();
        expect(existsSync(`${PROFILE}/rm.db`)).toBe(false);
    });

    it('VACUUM INTO writes a profile file', async () => {
        t.run(`
            local c = luasql.sqlite3():connect(":memory:")
            c:execute("create table t(x)"); c:execute("insert into t values ('kept')")
            c:execute("vacuum into '"..${H}.."/vac.db'"); c:close()`);
        await tick();
        const bytes = readFileSync(`${PROFILE}/vac.db`) as unknown as Uint8Array;
        expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe('SQLite format 3');
        expect(t.run(`
            local c = luasql.sqlite3():connect(${H}.."/vac.db")
            local cu = c:execute("select x from t"); local v = cu:fetch(); cu:close(); c:close()
            return v`)).toBe('kept');
    });
});
