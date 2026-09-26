// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/**
 * Issue #173: four places where Mudlet Web answered differently from desktop
 * Mudlet 5.0 for the same Lua probe.
 */
describe('mapper return contracts (#173)', () => {
    let t: TestRuntime;

    beforeEach(async () => { t = await createTestRuntime(); });
    afterEach(() => { t.dispose(); });

    it('addRoom without an area files the room in the default area -1, environment -1', () => {
        t.run('addRoom(50)');
        expect(t.run('return getRoomArea(50)')).toBe(-1);
        expect(t.run('return getRoomEnv(50)')).toBe(-1);
        expect(t.run('return getAreaTableSwap()[getRoomArea(50)]')).toBe('Default Area');
        // Listed under the area, not orphaned in a non-existent area 0.
        expect(t.run('for _, id in pairs(getAreaRooms(-1) or {}) do if id == 50 then return true end end return false'))
            .toBe(true);
    });

    it('addRoom into an unknown area also lands in the default area\'s room list', () => {
        expect(t.run('local ok, err = addRoom(51, 999); return err')).toMatch(/placed in areaID -1/);
        expect(t.run('return getRoomArea(51)')).toBe(-1);
        expect(t.run('for _, id in pairs(getAreaRooms(-1) or {}) do if id == 51 then return true end end return false'))
            .toBe(true);
    });

    it('addRoom into a known area still places it there', () => {
        const area = t.run('return (addAreaName("Known"))') as number;
        t.run(`addRoom(52, ${area})`);
        expect(t.run('return getRoomArea(52)')).toBe(area);
        expect(t.run('return getRoomEnv(52)')).toBe(-1);
    });

    it('getPlayerRoom returns nil plus a reason when there is no player room', () => {
        expect(t.run('local a, b = getPlayerRoom(); return a == nil and b')).toBe("you haven't opened a map yet");
        t.run('addRoom(60)');
        expect(t.run('local a, b = getPlayerRoom(); return a == nil and b'))
            .toBe('the player does not have a valid roomID set');
        t.run('centerview(60)');
        expect(t.run('return getPlayerRoom()')).toBe(60);
    });

    it('getPath raises a Lua argument error on a non-number roomID', () => {
        t.run('addRoom(70)');
        expect(t.run('local ok, e = pcall(getPath, nil, 70); return tostring(ok) .. "|" .. e'))
            .toBe('false|getPath: bad argument #1 type (starting roomID as number expected, got nil!)');
        expect(t.run('local ok, e = pcall(getPath, 70, {}); return tostring(ok) .. "|" .. e'))
            .toBe('false|getPath: bad argument #2 type (target roomID as number expected, got table!)');
        // An unknown (but numeric) room is still a soft (nil, errMsg) failure.
        expect(t.run('local a, b = getPath(70, 9999); return a == nil and b'))
            .toBe('getPath: number 9999 is not a valid target roomID');
    });
});

/** Directories-aware in-memory stand-in for the ProfileVFS methods io uses. */
class DirStubVFS {
    profilePath = '/profiles/test';
    files = new Map<string, Uint8Array>();
    dirs = new Set<string>(['/', '/profiles', '/profiles/test']);
    resolvePath(p: string): string { return p.startsWith('/') ? p : `${this.profilePath}/${p}`; }
    exists(p: string): boolean { const a = this.resolvePath(p); return this.files.has(a) || this.dirs.has(a); }
    stat(p: string): { type: 'file' | 'dir' } | null {
        const a = this.resolvePath(p);
        if (this.files.has(a)) return { type: 'file' };
        return this.dirs.has(a) ? { type: 'dir' } : null;
    }
    readBinaryFile(p: string): Uint8Array {
        const bytes = this.files.get(this.resolvePath(p));
        if (!bytes) throw new Error(`ENOENT: ${p}`);
        return bytes;
    }
    writeBinaryFile(p: string, data: Uint8Array): void { this.files.set(this.resolvePath(p), data); }
}

describe('io.open does not create missing directories (#173)', () => {
    let t: TestRuntime;
    let vfs: DirStubVFS;

    beforeEach(async () => {
        vfs = new DirStubVFS();
        t = await createTestRuntime({ vfs: vfs as unknown as ProfileVFS });
    });
    afterEach(() => { t.dispose(); });

    it.each(['w', 'a', 'w+', 'a+'])('io.open(missing/dir/file, %s) fails with ENOENT', (mode) => {
        expect(t.run(`local f, e = io.open(getMudletHomeDir() .. "/nodir/x.txt", "${mode}"); return f == nil and e`))
            .toBe('/profiles/test/nodir/x.txt: No such file or directory');
        expect(vfs.files.size).toBe(0);
    });

    it('io.open under a file fails with ENOTDIR', () => {
        vfs.files.set('/profiles/test/plain', new Uint8Array());
        expect(t.run('local f, e = io.open(getMudletHomeDir() .. "/plain/x.txt", "w"); return f == nil and e'))
            .toBe('/profiles/test/plain/x.txt: Not a directory');
    });

    it('table.save into a missing directory returns nil, err', () => {
        expect(t.run('local ok, e = table.save(getMudletHomeDir() .. "/nodir/t.lua", {1}); return ok == nil and e'))
            .toBe('/profiles/test/nodir/t.lua: No such file or directory');
    });

    it('still creates a file in an existing directory', () => {
        vfs.dirs.add('/profiles/test/sub');
        expect(t.run('local f = assert(io.open(getMudletHomeDir() .. "/sub/x.txt", "w")); f:write("hi"); f:close(); return true'))
            .toBe(true);
        expect(new TextDecoder().decode(vfs.files.get('/profiles/test/sub/x.txt'))).toBe('hi');
    });
});
