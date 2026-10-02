// @vitest-environment node
//
// The Lua host environment against desktop Mudlet PTB (mudlet-web#276): the
// bundled C modules require by name, the io library is the whole of Lua 5.1's,
// luautf8 / lrexlib / LuaFileSystem / LPeg carry the functions and
// constants desktop's builds of them do, lfs.dir raises on a missing folder,
// Mudlet Web's own Lua reads as C in tracebacks and debug.getinfo, and
// math.randomseed drives glibc's rand().
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { configure, InMemory, mkdirSync } from '@zenfs/core';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

const PROFILE = '/profiles/host-env';

describe('Lua host environment parity (#276)', () => {
    let t: TestRuntime;

    /** Every value a chunk returns, as a JS array (nil → null). */
    const all = (code: string): unknown[] => {
        t.run(`__host_out = (function(...) return { n = select('#', ...), ... } end)(${code})`);
        const n = t.run('return __host_out.n') as number;
        return Array.from({ length: n }, (_, i) => t.run(`return __host_out[${i + 1}]`) ?? null);
    };

    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        t = await createTestRuntime({ vfs: new Ctor('host-env', {}, 'idb') });
        t.run('H = getMudletHomeDir()');
    });

    afterAll(() => t?.dispose());

    describe('1. require of the bundled modules', () => {
        it.each(['lfs', 'utf8', 'lua-utf8', 'yajl', 'brimworks.zip', 'lpeg', 'rex_pcre2', 'luasql.sqlite3', 'io'])(
            'require "%s" succeeds', name => {
                expect(t.run(`return (pcall(require, ${JSON.stringify(name)}))`)).toBe(true);
            });

        it('hands back the same tables as the globals', () => {
            expect(t.run(`return require("lfs") == lfs and require("lua-utf8") == utf8
                and require("utf8") == utf8 and require("yajl") == yajl
                and require("brimworks.zip") == zip and require("io") == io`)).toBe(true);
        });

        it('package.loaded matches desktop, with no rex_pcre module', () => {
            expect(t.run(`
                local names = {}
                for k in pairs(package.loaded) do names[#names + 1] = k end
                table.sort(names)
                return table.concat(names, ",")
            `)).toBe('_G,brimworks.zip,coroutine,debug,gmod,io,lfs,lpeg,lua-utf8,luasql.sqlite3,math,os,package,rex_pcre2,string,table,utf8,yajl');
            expect(t.run('return (pcall(require, "rex_pcre"))')).toBe(false);
            expect(t.run('return rex_pcre == rex')).toBe(true);
        });
    });

    describe('2. the io library', () => {
        it('has the standard files', () => {
            expect(all('io.type(io.stdout), io.type(io.stderr), io.type(io.stdin), type(io.stdout)'))
                .toEqual(['file', 'file', 'file', 'userdata']);
        });

        it('io.write and io.stderr:write go to the process streams and answer true', () => {
            expect(all('io.write("x\\n")')).toEqual([true]);
            expect(all('io.stderr:write("dbg\\n")')).toEqual([true]);
            expect(all('io.flush()')).toEqual([true]);
            expect(all('io.output() == io.stdout, io.input() == io.stdin')).toEqual([true, true]);
        });

        it('io.tmpfile reads back what was written', () => {
            expect(t.run(`
                local f = io.tmpfile()
                f:write("abc")
                f:seek("set")
                local s = f:read("*a")
                f:close()
                return s
            `)).toBe('abc');
        });

        it('io.open rejects a mode glibc rejects', () => {
            expect(all(`io.open(H .. "/m.txt", "z")`)).toEqual([null, `${PROFILE}/m.txt: Invalid argument`, 22]);
        });

        it('io.open accepts the modes glibc accepts', () => {
            expect(t.run(`
                local f = assert(io.open(H .. "/rt.txt", "wb")); f:write("1"); f:close()
                f = assert(io.open(H .. "/rt.txt", "rt")); local s = f:read("*a"); f:close()
                return s
            `)).toBe('1');
            expect(all(`io.open(H .. "/rt.txt", "wx")`)).toEqual([null, `${PROFILE}/rt.txt: File exists`, 17]);
        });

        it('io.type tells open, closed and other values apart', () => {
            expect(all(`(function()
                local f = io.open(H .. "/t.txt", "w")
                local open = io.type(f)
                f:close()
                return open, io.type(f), io.type({}), io.type(1), tostring(f)
            end)()`)).toEqual(['file', 'closed file', null, null, 'file (closed)']);
        });

        it('a standard file cannot be closed, and a closed file cannot be used', () => {
            expect(all('io.stdout:close()')).toEqual([null, 'cannot close standard file']);
            expect(t.run(`
                local f = io.open(H .. "/c.txt", "w"); f:close()
                local ok, e = pcall(f.write, f, "x")
                return e
            `)).toBe('attempt to use a closed file');
        });

        it('write takes numbers and strings only', () => {
            expect(t.run(`
                local f = io.tmpfile(); f:write(1.5, " ", 10); f:seek("set")
                return f:read("*a")
            `)).toBe('1.5 10');
            expect(t.run('return select(2, pcall(io.write, {}))'))
                .toBe("bad argument #1 to 'write' (string expected, got table)");
        });

        it('read stops at the first format that fails', () => {
            expect(all(`(function()
                local f = io.tmpfile(); f:write("one\\ntwo"); f:seek("set")
                return f:read("*l", "*l", "*l", "*l")
            end)()`)).toEqual(['one', 'two', null]);
        });

        it('io.popen is reported unsupported', () => {
            expect(t.run('return select(2, pcall(io.popen, "ls"))')).toBe("'popen' not supported");
        });
    });

    describe('3. library functions and constants', () => {
        it('utf8 carries luautf8 0.2.1', () => {
            expect(t.run('return utf8.version')).toBe('0.2.1');
            expect(t.run('return utf8.title("élan")')).toBe('ÉLAN');
            expect(t.run('return utf8.title("ǆungla")')).toBe('ǅUNGLA');
            expect(t.run(`
                local out = {}
                for p, c in utf8.codes("aé") do out[#out + 1] = p .. ":" .. c end
                return table.concat(out, ",")
            `)).toBe('1:97,2:233');
            expect(all('utf8.isvalid("aé"), utf8.isvalid("a\\255")')).toEqual([true, false]);
            expect(all('utf8.invalidoffset("ab\\255c"), utf8.invalidoffset("abc")')).toEqual([3, null]);
            expect(all('utf8.clean("a\\255\\254b")')).toEqual(['a\u{fffd}b', false]);
            expect(all('utf8.clean("ab")')).toEqual(['ab', true]);
            expect(all('utf8.normalize_nfc("e\\204\\129")')).toEqual(['é', false]);
            expect(all('utf8.isnfc("é"), utf8.isnfc("e\\204\\129")')).toEqual([true, false]);
            expect(all('utf8.widthlimit("abcdef", 3)')).toEqual([3, 0]);
            expect(all('utf8.widthlimit("abcdef", -2)')).toEqual([5, 0]);
            expect(t.run(`
                local out = {}
                for i, j in utf8.grapheme_indices("ae\\204\\129b") do out[#out + 1] = i .. "-" .. j end
                return table.concat(out, ",")
            `)).toBe('1-1,2-4,5-5');
            expect(t.run('return utf8.title(233)')).toBe(201);
        });

        it('rex carries lrexlib\'s version, config and maketables', () => {
            expect(t.run('return rex._VERSION')).toBe('Lrexlib 2.9.4 (for PCRE2)');
            expect(t.run('return rex.version()')).toMatch(/^10\.\d+ /);
            expect(t.run('return rex.config().PCRE2_CONFIG_UNICODE')).toBe(1);
            expect(t.run('return type(rex.maketables())')).toBe('userdata');
            expect(t.run('return tostring(rex.maketables())')).toMatch(/^chartables \(0x/);
        });

        it('lfs carries LuaFileSystem 1.9.0', () => {
            expect(t.run('return lfs._VERSION')).toBe('LuaFileSystem 1.9.0');
            for (const fn of ['symlinkattributes', 'lock', 'unlock', 'lock_dir', 'setmode', 'link']) {
                expect(t.run(`return type(lfs.${fn})`)).toBe('function');
            }
            expect(all(`(function()
                local f = io.open(H .. "/lk.txt", "w")
                local a = lfs.lock(f, "w")
                local b = lfs.unlock(f)
                local c, d = lfs.setmode(f, "binary")
                f:close()
                return a, b, c, d
            end)()`)).toEqual([true, true, true, 'binary']);
            expect(t.run(`local f = io.open(H .. "/lk.txt", "r"); f:close()
                return select(2, pcall(lfs.lock, f, "r"))`)).toBe('lock: closed file');
        });

        it('lfs.link / symlinkattributes / lock_dir work over the VFS', () => {
            expect(all(`(function()
                local f = io.open(H .. "/target.txt", "w"); f:write("t"); f:close()
                local ok = lfs.link("target.txt", H .. "/sym.txt", true)
                local a = lfs.symlinkattributes(H .. "/sym.txt")
                return ok, a.mode, a.target, lfs.symlinkattributes(H .. "/sym.txt", "target")
            end)()`)).toEqual([true, 'link', 'target.txt', 'target.txt']);
            expect(all(`(function()
                lfs.mkdir(H .. "/locked")
                local l = lfs.lock_dir(H .. "/locked")
                local again, err = lfs.lock_dir(H .. "/locked")
                l:free()
                local l2 = lfs.lock_dir(H .. "/locked")
                l2:free()
                return type(l), again, err, type(l2)
            end)()`)).toEqual(['userdata', null, 'File exists', 'userdata']);
        });

        it('lpeg carries LPeg 1.1.0\'s version string and utfR', () => {
            expect(t.run('return lpeg.version')).toBe('LPeg 1.1.0');
            expect(all('lpeg.match(lpeg.utfR(0x80, 0x10FFFF), "é"), lpeg.match(lpeg.utfR(0x80, 0x10FFFF), "e")'))
                .toEqual([3, null]);
            expect(all('lpeg.match(lpeg.utfR(0xE0, 0xE9) ^ 1, "àéx"), lpeg.match(lpeg.utfR(0x4E00, 0x9FFF), "中")'))
                .toEqual([5, 4]);
            expect(t.run('return lpeg.match(lpeg.utfR(65, 90), "Q")')).toBe(2);
            expect(t.run('return select(2, pcall(lpeg.utfR, 5, 1))')).toBe("bad argument #2 to 'utfR' (empty range)");
        });

        it('zip carries lua-zip\'s constants', () => {
            expect(all('zip.CREATE, zip.EXCL, zip.CHECKCONS, zip.FL_NOCASE, zip.OR(zip.CREATE, zip.EXCL)'))
                .toEqual([1, 2, 4, 1, 3]);
        });

        it('the globals desktop sets and registers exist', () => {
            expect(all('SCRIPT_NAME, SCRIPT_ID, SESSION')).toEqual(['Global Lua Session Interpreter', -1, 1]);
            for (const fn of ['setActiveProfile', 'setMapPerspective', 'shiftMapPerspective']) {
                expect(t.run(`return type(${fn})`)).toBe('function');
            }
            expect(all('setMapPerspective(1, 2, 3)')).toEqual([null, "you haven't opened a map yet"]);
            expect(all('setActiveProfile("")')).toEqual([false, 'setActiveProfile: profile name cannot be empty']);
            expect(all('setActiveProfile("no such profile")'))
                .toEqual([false, "setActiveProfile: profile 'no such profile' does not exist"]);
        });
    });

    describe('4. lfs.dir on a missing directory', () => {
        it('raises "cannot open"', () => {
            expect(all(`pcall(lfs.dir, H .. "/nonexist")`))
                .toEqual([false, `cannot open ${PROFILE}/nonexist: No such file or directory`]);
        });

        it('returns an iterator and a directory object', () => {
            expect(all(`(function()
                lfs.mkdir(H .. "/d"); local f = io.open(H .. "/d/x", "w"); f:close()
                local names = {}
                for name in lfs.dir(H .. "/d") do names[#names + 1] = name end
                table.sort(names)
                local iter, d = lfs.dir(H .. "/d")
                local first = d:next()
                d:close()
                return table.concat(names, ","), type(d), first
            end)()`)).toEqual(['.,..,x', 'userdata', '.']);
        });
    });

    describe('5. Mudlet Web\'s own Lua reads as C', () => {
        it('debug.getinfo of an API function reports C', () => {
            expect(all('debug.getinfo(send, "S").what, debug.getinfo(send, "S").short_src, debug.getinfo(send, "S").source'))
                .toEqual(['C', '[C]', '=[C]']);
            expect(all('debug.getinfo(tempTimer).what, debug.getinfo(io.open).what, debug.getinfo(utf8.len).what'))
                .toEqual(['C', 'C', 'C']);
        });

        it('API argument errors carry no internal position', () => {
            expect(t.run('return select(2, pcall(tempTimer, "x", "y"))'))
                .toBe('tempTimer: bad argument #1 type (time in seconds {maybe decimal} as number expected, got string!)');
        });

        it('positions errors the way the C they stand in for does', () => {
            // Mudlet's API raises with lua_error: never a position.
            t.rt.load('local ok, e = pcall(function()\ntempTimer("x", "y")\nend)\n__probe = e', 'pos1');
            expect(t.run('return __probe'))
                .toBe('tempTimer: bad argument #1 type (time in seconds {maybe decimal} as number expected, got string!)');
            // The C libraries raise with luaL_error: the calling script line.
            t.rt.load('local ok, e = pcall(function()\nlfs.dir(getMudletHomeDir() .. "/nope")\nend)\n__probe = e', 'pos2');
            expect(t.run('return __probe'))
                .toBe(`[string "Script: pos2"]:2: cannot open ${PROFILE}/nope: No such file or directory`);
            t.rt.load('local ok, e = pcall(function()\nmath.random(0)\nend)\n__probe = e', 'pos3');
            expect(t.run('return __probe')).toBe('[string "Script: pos3"]:2: bad argument #1 to \'random\' (interval is empty)');
        });

        it('error() from user code still carries its position', () => {
            t.rt.load('local ok, e = pcall(function() error("lvl1") end)\n__probe = e', 'probe');
            expect(t.run('return __probe')).toBe('[string "Script: probe"]:1: lvl1');
            t.rt.load('local function f() error("up", 2) end\nlocal ok, e = pcall(function()\nf()\nend)\n__probe = e', 'probe2');
            expect(t.run('return __probe')).toBe('[string "Script: probe2"]:3: up');
        });

        it('a script\'s traceback has nothing of the entry plumbing under it', () => {
            t.rt.load('__tb = debug.traceback()', 'probe');
            expect(t.run('return __tb')).toBe('stack traceback:\n\t[string "Script: probe"]:1: in main chunk');
        });

        it('a traceback through an API function shows it as one C frame', () => {
            t.rt.load([
                'local tb',
                'local co = coroutine.create(function() tb = debug.traceback() end)',
                'coroutine.resume(co)',
                '__tb = tb',
            ].join('\n'), 'probe');
            expect(t.run('return __tb')).toBe('stack traceback:\n\t[string "Script: probe"]:2: in function <[string "Script: probe"]:2>');
            t.rt.load('__tb = select(2, xpcall(function() tempTimer("x", "y") end, debug.traceback))', 'probe3');
            expect(t.run('return __tb')).toBe([
                'tempTimer: bad argument #1 type (time in seconds {maybe decimal} as number expected, got string!)',
                'stack traceback:',
                "\t[C]: in function 'tempTimer'",
                '\t[string "Script: probe3"]:1: in function <[string "Script: probe3"]:1>',
                "\t[C]: in function 'xpcall'",
                '\t[string "Script: probe3"]:1: in main chunk',
            ].join('\n'));
            t.rt.load('__tb = select(2, xpcall(function() error("boom") end, debug.traceback))', 'probe4');
            expect(t.run('return __tb')).toBe([
                '[string "Script: probe4"]:1: boom',
                'stack traceback:',
                "\t[C]: in function 'error'",
                '\t[string "Script: probe4"]:1: in function <[string "Script: probe4"]:1>',
                "\t[C]: in function 'xpcall'",
                '\t[string "Script: probe4"]:1: in main chunk',
            ].join('\n'));
        });

        it('a timer callback runs with nothing under it, as desktop calls it from C', () => {
            t.rt.load([
                '__cb = __mudlet_register_cb(function()',
                '  __tb = debug.traceback()',
                '  local n = 0',
                '  while debug.getinfo(n) do n = n + 1 end',
                '  __depth = n',
                'end)',
            ].join('\n'), 'probe');
            (t.rt as unknown as { dispatchCb(id: number, label: string): void })
                .dispatchCb(t.run('return __cb') as number, 'tempTimer');
            expect(t.run('return __tb'))
                .toBe('stack traceback:\n\t[string "Script: probe"]:2: in function <[string "Script: probe"]:1>');
            expect(t.run('return __depth')).toBe(2);
        });

        it('getlocal counts levels as getinfo does, so f() still reads locals', () => {
            t.rt.load('local who = "bob"\n__s = f("hi {who}")', 'probe');
            expect(t.run('return __s')).toBe('hi bob');
            t.rt.load([
                'local function inner() local n, v = debug.getlocal(2, 1); return n, v end',
                'local function outer() local marker = 42; local n, v = inner(); return n, v end',
                '__name, __value = outer()',
            ].join('\n'), 'probe');
            expect(all('__name, __value')).toEqual(['marker', 42]);
        });

        it('a tail-called error still carries its caller\'s position', () => {
            t.rt.load([
                'local function fail() return error("tail") end',
                'local ok, e = pcall(fail)',
                '__probe = e',
            ].join('\n'), 'probe5');
            expect(t.run('return __probe')).toBe('[string "Script: probe5"]:1: tail');
            expect(t.run('return debug.getinfo(error, "S").what')).toBe('C');
        });

        it('stack depth inside a script matches desktop', () => {
            t.rt.load('local n = 0\nwhile debug.getinfo(n) do n = n + 1 end\n__depth = n', 'probe');
            expect(t.run('return __depth')).toBe(2);
        });
    });

    describe('6. math.randomseed drives glibc\'s rand()', () => {
        it('seed 1234 gives desktop\'s sequence', () => {
            expect(all('(function() math.randomseed(1234); return math.random(), math.random(100) end)()'))
                .toEqual([expect.closeTo(0.22311807341088, 12), 22]);
        });

        it('keeps math.random\'s argument rules', () => {
            expect(t.run('return select(2, pcall(math.random, 0))')).toBe("bad argument #1 to 'random' (interval is empty)");
            expect(t.run('return select(2, pcall(math.random, 1, 2, 3))')).toBe('wrong number of arguments');
            expect(t.run('math.randomseed(7); local a = math.random(5, 9); return a >= 5 and a <= 9')).toBe(true);
        });
    });
});
