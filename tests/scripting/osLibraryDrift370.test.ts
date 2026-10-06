// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { configure, InMemory, mkdirSync, existsSync, readFileSync } from '@zenfs/core';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { timeZoneAbbreviation } from '../../src/utils/timeZone';

/**
 * Lua's os library as desktop Mudlet (Lua 5.1 over glibc) has it (issue #370):
 * %z in zones off the whole hour, os.time for the years 0–99, %E/%O printed as
 * written, tzdata's %Z names, a usable os.tmpname, rename(2)/remove(3) errors,
 * and os.setlocale refusing locales that don't exist.
 *
 * The zone tests set TZ themselves — node follows a change to process.env.TZ
 * — so they don't depend on the machine's zone.
 */

const PROFILE = '/profiles/os-drift';

describe('os library parity with desktop (issue #370)', () => {
    let t: TestRuntime;
    const savedTz = process.env.TZ;

    /** Run a chunk and return every value it returns, as a JS array (nil → null). */
    const all = (code: string): unknown[] => {
        t.run(`__os_test_out = (function(...) return { n = select('#', ...), ... } end)(${code})`);
        const n = t.run(`return __os_test_out.n`) as number;
        return Array.from({ length: n }, (_, i) => t.run(`return __os_test_out[${i + 1}]`) ?? null);
    };
    const inZone = (zone: string, code: string): unknown => {
        process.env.TZ = zone;
        return t.run(code);
    };

    beforeAll(async () => {
        process.env.TZ = 'UTC';
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        // The constructor is private: mount() insists on IndexedDB or a linked
        // folder, neither of which exists under node.
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        const vfs = new Ctor('os-drift', {}, 'idb');
        t = await createTestRuntime({ vfs });
        t.run(`H = getMudletHomeDir()`);
    });

    afterEach(() => { process.env.TZ = 'UTC'; });

    afterAll(() => {
        if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
        t.dispose();
    });

    describe('os.date("%z")', () => {
        // 2026-01-15 and 2026-07-15, 12:00 UTC.
        const jan = Date.UTC(2026, 0, 15, 12) / 1000;
        const jul = Date.UTC(2026, 6, 15, 12) / 1000;

        it('prints the minutes of a zone off the whole hour', () => {
            expect(inZone('Asia/Kolkata', `return os.date("%z", ${jan})`)).toBe('+0530');
            expect(inZone('Asia/Kathmandu', `return os.date("%z", ${jan})`)).toBe('+0545');
            expect(inZone('America/St_Johns', `return os.date("%z", ${jan})`)).toBe('-0330');
            expect(inZone('America/St_Johns', `return os.date("%z", ${jul})`)).toBe('-0230');
            expect(inZone('Australia/Adelaide', `return os.date("%z", ${jul})`)).toBe('+0930');
            expect(inZone('Australia/Adelaide', `return os.date("%z", ${jan})`)).toBe('+1030');
        });

        it('keeps whole-hour zones and UTC as they were', () => {
            expect(inZone('America/New_York', `return os.date("%z", ${jan})`)).toBe('-0500');
            expect(inZone('Europe/Berlin', `return os.date("%z", ${jul})`)).toBe('+0200');
            expect(inZone('Asia/Kolkata', `return os.date("!%z", ${jan})`)).toBe('+0000');
            expect(inZone('Asia/Kolkata', `return os.date("%H:%M %z", ${jan})`)).toBe('17:30 +0530');
        });
    });

    describe('os.time for the years 0 to 99', () => {
        it('is that year, not 1900 plus it', () => {
            expect(inZone('UTC', 'return os.time{year=50, month=6, day=15, hour=12}')).toBe(-60574996800);
            expect(inZone('UTC', 'return os.time{year=0, month=1, day=1, hour=0}')).toBe(-62167219200);
            expect(inZone('UTC', 'local d = os.date("!*t", os.time{year=99, month=12, day=31, hour=23}) '
                + 'return table.concat({d.year, d.month, d.day, d.hour}, "-")')).toBe('99-12-31-23');
        });

        it('normalises out-of-range fields across the boundary', () => {
            expect(inZone('UTC', 'local d = os.date("!*t", os.time{year=99, month=13, day=1, hour=12}) '
                + 'return table.concat({d.year, d.month, d.day}, "-")')).toBe('100-1-1');
        });

        it('leaves the table it was given alone and other years as they were', () => {
            expect(inZone('UTC', 'local t = {year=50, month=6, day=15, hour=12}; os.time(t); return t.year')).toBe(50);
            expect(inZone('UTC', 'return os.time{year=1950, month=6, day=15, hour=12}')).toBe(-616852800);
            expect(inZone('UTC', 'return os.time{year=100, month=1, day=1, hour=0}')).toBe(-59011459200);
        });
    });

    describe('%E and %O modifiers', () => {
        it('are printed as written, the conversion after them as plain text', () => {
            expect(t.run('return os.date("%Ec", 0)')).toBe('%Ec');
            expect(t.run('return os.date("!time=%EH:%OM", 0)')).toBe('time=%EH:%OM');
            for (const spec of ['Ec', 'EC', 'Ex', 'EX', 'Ey', 'EY', 'Od', 'Oe', 'OH', 'OI', 'Om', 'OM', 'OS', 'Ou',
                'OU', 'OV', 'Ow', 'OW', 'Oy']) {
                expect(t.run(`return os.date("!%${spec}", 0)`)).toBe(`%${spec}`);
            }
        });

        it('leave a conversion after them alone', () => {
            expect(t.run('return os.date("!%E%Y", 0)')).toBe('%E1970');
            expect(t.run('return os.date("!%%Ec", 0)')).toBe('%Ec');
        });
    });

    describe('os.date("%Z")', () => {
        it('prints tzdata\'s abbreviations', () => {
            // London kept BST all year from 1968 to 1971.
            expect(inZone('Europe/London', 'return os.date("%Z", 0)')).toBe('BST');
            // New York before 1970.
            const winter1960 = Date.UTC(1960, 0, 15, 12) / 1000;
            const summer1960 = Date.UTC(1960, 6, 15, 12) / 1000;
            expect(inZone('America/New_York', `return os.date("%Z", ${winter1960})`)).toBe('EST');
            expect(inZone('America/New_York', `return os.date("%Z", ${summer1960})`)).toBe('EDT');
            // tzdata names Kathmandu by its offset, not CLDR's "NPT".
            const now = Date.UTC(2026, 0, 15, 12) / 1000;
            expect(inZone('Asia/Kathmandu', `return os.date("%Z", ${now})`)).toBe('+0545');
            expect(inZone('Asia/Dubai', `return os.date("%Z", ${now})`)).toBe('+04');
            expect(inZone('Asia/Kolkata', `return os.date("%Z", ${now})`)).toBe('IST');
            expect(inZone('Europe/Berlin', `return os.date("%Z", ${now})`)).toBe('CET');
            expect(inZone('UTC', `return os.date("%Z", ${now})`)).toBe('UTC');
        });

        it('names a time before standard time by local mean time', () => {
            expect(timeZoneAbbreviation(new Date(Date.UTC(1850, 0, 1)), 'America/New_York')).toBe('LMT');
        });

        it('tells standard from daylight time where a zone has used both offsets', () => {
            const winter = new Date(Date.UTC(2026, 0, 15, 12));
            const summer = new Date(Date.UTC(2026, 6, 15, 12));
            expect(timeZoneAbbreviation(winter, 'America/Indiana/Indianapolis')).toBe('EST');
            expect(timeZoneAbbreviation(summer, 'America/Indiana/Indianapolis')).toBe('EDT');
            expect(timeZoneAbbreviation(summer, 'America/Chicago')).toBe('CDT');
            expect(timeZoneAbbreviation(winter, 'Australia/Sydney')).toBe('AEDT');
            expect(timeZoneAbbreviation(summer, 'Europe/Dublin')).toBe('IST');
            expect(timeZoneAbbreviation(winter, 'Europe/Dublin')).toBe('GMT');
            expect(timeZoneAbbreviation(winter, 'Asia/Singapore')).toBe('+08');
        });
    });

    describe('os.tmpname', () => {
        it('returns a new, empty file in /tmp that io.open and os.remove can use', () => {
            // The name stays in a Lua global rather than being spliced back
            // into the Lua source.
            const name = t.run('__tmp_name = os.tmpname() return __tmp_name') as string;
            expect(name).toMatch(/^\/tmp\/lua_[A-Za-z0-9]{6}$/);
            expect(existsSync(name)).toBe(true);
            expect(readFileSync(name).length).toBe(0);
            t.run(`
                local f = assert(io.open(__tmp_name, "w"))
                f:write("hello") f:close()
            `);
            expect(t.run('local f = io.open(__tmp_name) local s = f:read("*a") f:close() return s'))
                .toBe('hello');
            expect(all('os.remove(__tmp_name)')).toEqual([true]);
            expect(existsSync(name)).toBe(false);
        });

        it('never hands out the same name twice', () => {
            expect(t.run('return os.tmpname() ~= os.tmpname()')).toBe(true);
        });
    });

    describe('os.rename', () => {
        const write = (path: string) => t.run(`local f = io.open(H .. '/${path}', 'w'); f:write('x'); f:close()`);

        it('refuses a target whose directory is missing, and leaves the file put', () => {
            write('a.txt');
            expect(all(`os.rename(H .. '/a.txt', H .. '/nodir/deeper/a.txt')`))
                .toEqual([null, `${PROFILE}/a.txt: No such file or directory`, 2]);
            expect(existsSync(`${PROFILE}/a.txt`)).toBe(true);
            expect(existsSync(`${PROFILE}/nodir`)).toBe(false);
        });

        it('refuses a target under a plain file', () => {
            write('b.txt');
            write('plain.txt');
            const [ok, , errno] = all(`os.rename(H .. '/b.txt', H .. '/plain.txt/b.txt')`);
            expect([ok, errno]).toEqual([null, 20]);
        });

        it('lets a directory replace an empty directory', () => {
            t.run(`lfs.mkdir(H .. '/src1'); lfs.mkdir(H .. '/empty1')`);
            write('src1/f.txt');
            expect(all(`os.rename(H .. '/src1', H .. '/empty1')`)).toEqual([true]);
            expect(existsSync(`${PROFILE}/empty1/f.txt`)).toBe(true);
            expect(existsSync(`${PROFILE}/src1`)).toBe(false);
        });

        it('refuses to replace a non-empty directory with ENOTEMPTY', () => {
            t.run(`lfs.mkdir(H .. '/src2'); lfs.mkdir(H .. '/full2')`);
            write('full2/keep.txt');
            const [ok, , errno] = all(`os.rename(H .. '/src2', H .. '/full2')`);
            expect([ok, errno]).toEqual([null, 39]);
            expect(existsSync(`${PROFILE}/full2/keep.txt`)).toBe(true);
        });

        it('refuses a file over a directory, and a directory over a file', () => {
            write('c.txt');
            t.run(`lfs.mkdir(H .. '/dir3')`);
            expect(all(`os.rename(H .. '/c.txt', H .. '/dir3')`)[2]).toBe(21);
            expect(all(`os.rename(H .. '/dir3', H .. '/c.txt')`)[2]).toBe(20);
        });

        it('refuses to move a directory into itself with EINVAL', () => {
            t.run(`lfs.mkdir(H .. '/dir4')`);
            expect(all(`os.rename(H .. '/dir4', H .. '/dir4/sub')`)[2]).toBe(22);
            expect(existsSync(`${PROFILE}/dir4`)).toBe(true);
        });

        it('still renames a file, replacing a file that is there', () => {
            write('d.txt');
            write('e.txt');
            expect(all(`os.rename(H .. '/d.txt', H .. '/e.txt')`)).toEqual([true]);
            expect(existsSync(`${PROFILE}/d.txt`)).toBe(false);
        });
    });

    describe('os.remove', () => {
        const write = (path: string) => t.run(`local f = io.open(H .. '/${path}', 'w'); f:write('x'); f:close()`);

        it('refuses a file named with a trailing slash', () => {
            write('slash.txt');
            expect(all(`os.remove(H .. '/slash.txt/')`)).toEqual([null, `${PROFILE}/slash.txt/: Not a directory`, 20]);
            expect(existsSync(`${PROFILE}/slash.txt`)).toBe(true);
        });

        it('refuses a path through a file with ENOTDIR', () => {
            write('f.txt');
            expect(all(`os.remove(H .. '/f.txt/x')`)[2]).toBe(20);
        });

        it('refuses "" with ENOENT and "." with EINVAL, never touching the profile root', () => {
            expect(all(`os.remove("")`)).toEqual([null, ': No such file or directory', 2]);
            expect(all(`os.remove(".")`)).toEqual([null, '.: Invalid argument', 22]);
            expect(existsSync(PROFILE)).toBe(true);
        });

        it('still removes an empty directory named with a trailing slash', () => {
            t.run(`lfs.mkdir(H .. '/rmdir5')`);
            expect(all(`os.remove(H .. '/rmdir5/')`)).toEqual([true]);
        });
    });

    describe('os.setlocale', () => {
        it('refuses a locale that does not exist', () => {
            expect(all('os.setlocale("xx_YY.bogus")')).toEqual([null]);
        });

        it('names a uniform locale by its one name', () => {
            expect(t.run('return os.setlocale("C.UTF-8")')).toBe('C.UTF-8');
            expect(t.run('return os.setlocale()')).toBe('C.UTF-8');
            expect(t.run('return os.setlocale("C")')).toBe('C');
        });

        it('sets and reads one category, and lists them all once they differ', () => {
            expect(t.run('return os.setlocale("C.UTF-8", "numeric")')).toBe('C.UTF-8');
            expect(t.run('return os.setlocale(nil, "numeric")')).toBe('C.UTF-8');
            expect(t.run('return os.setlocale(nil, "time")')).toBe('C');
            expect(t.run('return os.setlocale(nil, "all")')).toBe(
                'LC_CTYPE=C;LC_NUMERIC=C.UTF-8;LC_TIME=C;LC_COLLATE=C;LC_MONETARY=C;LC_MESSAGES=C;'
                + 'LC_PAPER=C;LC_NAME=C;LC_ADDRESS=C;LC_TELEPHONE=C;LC_MEASUREMENT=C;LC_IDENTIFICATION=C');
            t.run('os.setlocale("C")');
        });

        it('raises for an unknown category', () => {
            expect(() => t.run('os.setlocale("C", "bogus")')).toThrow(/bad argument #2 to 'setlocale' \(invalid option 'bogus'\)/);
        });
    });
});
