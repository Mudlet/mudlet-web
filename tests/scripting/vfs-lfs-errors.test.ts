// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { configure, InMemory, mkdirSync, existsSync, statSync } from '@zenfs/core';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/**
 * io / os / lfs failures report the way stock Lua and LuaFileSystem do on
 * desktop Mudlet (issue #233): `nil, message, errno`, with glibc's strerror
 * wording, and lfs.rmdir / lfs.mkdir are the plain POSIX calls — rmdir never
 * takes a directory's contents (or a plain file) with it, and mkdir never
 * builds a missing chain. Driven through the real wasmoon runtime over a real
 * ProfileVFS on an in-memory ZenFS, so the error shapes are ZenFS's own.
 */

const PROFILE = '/profiles/lfs-errors';

describe('io/os/lfs error reporting (LuaFileSystem parity)', () => {
    let t: TestRuntime;
    let vfs: ProfileVFS;

    /** Run a chunk and return every value it returns, as a JS array (nil → null). */
    const all = (code: string): unknown[] => {
        t.run(`__lfs_test_out = (function(...) return { n = select('#', ...), ... } end)(${code})`);
        const n = t.run(`return __lfs_test_out.n`) as number;
        return Array.from({ length: n }, (_, i) => t.run(`return __lfs_test_out[${i + 1}]`) ?? null);
    };

    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        // The constructor is private: mount() insists on IndexedDB or a linked
        // folder, neither of which exists under node.
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        vfs = new Ctor('lfs-errors', {}, 'idb');
        t = await createTestRuntime({ vfs });
        t.run(`H = getMudletHomeDir()`);
    });

    afterAll(() => t.dispose());

    describe('lfs.rmdir', () => {
        it('refuses a non-empty directory and leaves its contents alone', () => {
            t.run(`
                lfs.mkdir(H .. '/keep')
                local f = io.open(H .. '/keep/save.txt', 'w'); f:write('x'); f:close()
            `);
            expect(all(`lfs.rmdir(H .. '/keep')`)).toEqual([null, 'Directory not empty', 39]);
            expect(existsSync(`${PROFILE}/keep/save.txt`)).toBe(true);
            expect(t.run(`return io.exists(H .. '/keep/save.txt')`)).toBe(true);
        });

        it('refuses a plain file and leaves it in place', () => {
            t.run(`local f = io.open(H .. '/plain.txt', 'w'); f:write('x'); f:close()`);
            expect(all(`lfs.rmdir(H .. '/plain.txt')`)).toEqual([null, 'Not a directory', 20]);
            expect(existsSync(`${PROFILE}/plain.txt`)).toBe(true);
        });

        it('reports a missing path', () => {
            expect(all(`lfs.rmdir(H .. '/missing')`)).toEqual([null, 'No such file or directory', 2]);
        });

        it('removes an empty directory', () => {
            t.run(`lfs.mkdir(H .. '/empty')`);
            expect(all(`lfs.rmdir(H .. '/empty')`)).toEqual([true]);
            expect(existsSync(`${PROFILE}/empty`)).toBe(false);
        });
    });

    describe('lfs.mkdir', () => {
        it('does not create a missing parent chain', () => {
            expect(all(`lfs.mkdir(H .. '/q/r')`)).toEqual([null, 'No such file or directory', 2]);
            expect(existsSync(`${PROFILE}/q`)).toBe(false);
        });

        it('reports an existing path', () => {
            t.run(`lfs.mkdir(H .. '/exists')`);
            expect(all(`lfs.mkdir(H .. '/exists')`)).toEqual([null, 'File exists', 17]);
        });

        it('reports a parent that is a file', () => {
            t.run(`local f = io.open(H .. '/afile', 'w'); f:write('x'); f:close()`);
            expect(all(`lfs.mkdir(H .. '/afile/sub')`)).toEqual([null, 'Not a directory', 20]);
        });

        it('creates a directory whose parent exists', () => {
            expect(all(`lfs.mkdir(H .. '/made')`)).toEqual([true]);
            expect(statSync(`${PROFILE}/made`).isDirectory()).toBe(true);
        });
    });

    describe('os.remove / os.rename', () => {
        it('os.remove removes an empty directory, as remove(3) does', () => {
            t.run(`lfs.mkdir(H .. '/rmme')`);
            expect(all(`os.remove(H .. '/rmme')`)).toEqual([true]);
            expect(existsSync(`${PROFILE}/rmme`)).toBe(false);
        });

        it('os.remove refuses a non-empty directory', () => {
            t.run(`
                lfs.mkdir(H .. '/full')
                local f = io.open(H .. '/full/x', 'w'); f:write('x'); f:close()
            `);
            const [ok, msg, errno] = all(`os.remove(H .. '/full')`);
            expect(ok).toBeNull();
            expect(msg).toBe(`${PROFILE}/full: Directory not empty`);
            expect(errno).toBe(39);
            expect(existsSync(`${PROFILE}/full/x`)).toBe(true);
        });

        it('os.remove of a missing file names the path, with the errno', () => {
            expect(all(`os.remove('nope.txt')`)).toEqual([null, 'nope.txt: No such file or directory', 2]);
        });

        it('os.rename of a missing file names the source, with the errno', () => {
            expect(all(`os.rename('nope.txt', 'other.txt')`)).toEqual([null, 'nope.txt: No such file or directory', 2]);
        });
    });

    describe('io.open', () => {
        it('a missing file carries the errno', () => {
            expect(all(`io.open('absent.txt')`)).toEqual([null, 'absent.txt: No such file or directory', 2]);
        });

        it('a missing directory carries the errno', () => {
            expect(all(`io.open('nodir/x.txt', 'w')`)).toEqual([null, 'nodir/x.txt: No such file or directory', 2]);
        });

        it('a directory is refused with strerror text rather than ZenFS text', () => {
            t.run(`lfs.mkdir(H .. '/adir')`);
            expect(all(`io.open(H .. '/adir', 'w')`)).toEqual([null, `${PROFILE}/adir: Is a directory`, 21]);
            expect(all(`io.open(H .. '/adir', 'r')`)).toEqual([null, `${PROFILE}/adir: Is a directory`, 21]);
        });
    });

    describe('lfs.touch', () => {
        it('reports a missing file and does not create it', () => {
            expect(all(`lfs.touch(H .. '/untouched')`)).toEqual([null, 'No such file or directory', 2]);
            expect(existsSync(`${PROFILE}/untouched`)).toBe(false);
        });

        it('sets the times of an existing file', () => {
            t.run(`local f = io.open(H .. '/stamp', 'w'); f:write('x'); f:close()`);
            expect(all(`lfs.touch(H .. '/stamp', 1000, 2000)`)).toEqual([true]);
            expect(t.run(`return lfs.attributes(H .. '/stamp', 'modification')`)).toBe(2000);
            expect(t.run(`return lfs.attributes(H .. '/stamp', 'access')`)).toBe(1000);
            // mtime defaults to atime
            t.run(`lfs.touch(H .. '/stamp', 3000)`);
            expect(t.run(`return lfs.attributes(H .. '/stamp', 'modification')`)).toBe(3000);
        });
    });

    describe('lfs.attributes', () => {
        it('reports a missing path with message and errno', () => {
            expect(all(`lfs.attributes(H .. '/ghost')`)).toEqual([
                null, `cannot obtain information from file '${PROFILE}/ghost': No such file or directory`, 2,
            ]);
            expect(all(`lfs.attributes(H .. '/ghost', 'mode')`)[0]).toBeNull();
        });

        it('carries the full LuaFileSystem field set', () => {
            t.run(`local f = io.open(H .. '/attrs', 'w'); f:write('hello'); f:close()`);
            const a = t.run(`return lfs.attributes(H .. '/attrs')`) as Record<string, unknown>;
            for (const k of ['mode', 'size', 'modification', 'access', 'change', 'permissions',
                'dev', 'ino', 'nlink', 'uid', 'gid', 'rdev', 'blocks', 'blksize']) {
                expect(a[k], k).not.toBeUndefined();
            }
            expect(a.mode).toBe('file');
            expect(a.size).toBe(5);
            expect(a.permissions).toMatch(/^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/);
            expect(t.run(`return lfs.attributes(H .. '/made', 'mode')`)).toBe('directory');
        });

        it('fills a table passed as the second argument', () => {
            expect(t.run(`
                local into = { keep = 1 }
                local r = lfs.attributes(H .. '/attrs', into)
                return r == into and into.keep == 1 and into.size == 5
            `)).toBe(true);
        });

        it('raises on an unknown attribute name', () => {
            expect(t.run(`
                local ok, err = pcall(lfs.attributes, H .. '/attrs', 'bogus')
                return (not ok) and err
            `)).toBe("invalid attribute name 'bogus'");
        });
    });

    it('the app\'s own recursive helpers still behave as before', () => {
        vfs.mkdir(`${PROFILE}/deep/a/b`);
        vfs.writeFile(`${PROFILE}/deep/a/b/f.txt`, 'x');
        vfs.rmdir(`${PROFILE}/deep`);
        expect(existsSync(`${PROFILE}/deep`)).toBe(false);
    });
});
