// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { parseReplay, replayBytesToLatin1 } from '../../src/mud/replay/replayFormat';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/**
 * Binary safety of the Lua io.* ↔ VFS bridge. The wasmoon string boundary is
 * UTF-8-based (truncates at NUL, mangles 0x80–0xFF), which used to corrupt any
 * binary file written or read from Lua — a replay file's int32 headers lost
 * every \0 byte. VFS.lua and LuaRuntime.setupVFS now "armor" payloads crossing
 * the bridge (%XX escapes behind a marker byte); these tests drive the real
 * wasmoon runtime against a stub VFS to pin byte-accuracy end to end.
 */

/** In-memory stand-in for ProfileVFS covering the methods the io hooks use. */
class StubVFS {
    profilePath = '/profiles/test';
    files = new Map<string, Uint8Array>();
    resolvePath(p: string): string { return p.startsWith('/') ? p : `${this.profilePath}/${p}`; }
    exists(p: string): boolean { return this.files.has(this.resolvePath(p)); }
    readBinaryFile(p: string): Uint8Array {
        const bytes = this.files.get(this.resolvePath(p));
        if (!bytes) throw new Error(`ENOENT: ${p}`);
        return bytes;
    }
    writeBinaryFile(p: string, data: Uint8Array): void { this.files.set(this.resolvePath(p), data); }
    readFile(p: string): string { return new TextDecoder().decode(this.readBinaryFile(p)); }
    writeFile(p: string, content: string): void { this.writeBinaryFile(p, new TextEncoder().encode(content)); }
    deleteFile(p: string): void { this.files.delete(this.resolvePath(p)); }
    /** io.open checks the parent directory exists before creating a file;
     *  the profile root and everything above it are the only directories. */
    stat(p: string): { type: 'file' | 'dir' } | null {
        const abs = this.resolvePath(p);
        if (this.files.has(abs)) return { type: 'file' };
        return this.profilePath === abs || this.profilePath.startsWith(`${abs}/`) || abs === '/'
            ? { type: 'dir' } : null;
    }
}

describe('VFS binary-safe Lua io', () => {
    let t: TestRuntime;
    const stub = new StubVFS();

    beforeAll(async () => {
        t = await createTestRuntime({ vfs: stub as unknown as ProfileVFS });
    });

    afterAll(() => t.dispose());

    it('round-trips all 256 byte values through io write → close → open → read', () => {
        const result = t.run(`
            local data = {}
            for i = 0, 255 do data[i + 1] = string.char(i) end
            data = table.concat(data)
            local f = assert(io.open(getMudletHomeDir() .. '/bin.dat', 'wb'))
            f:write(data)
            f:close()
            local r = assert(io.open(getMudletHomeDir() .. '/bin.dat', 'rb'))
            local back = r:read('*a')
            r:close()
            if back == data then return #back end
            return 'mismatch: got ' .. #back .. ' bytes'
        `);
        expect(result).toBe(256);
        // The stored bytes must be the literal 0..255 sequence — no UTF-8
        // expansion, no dropped NULs.
        const stored = stub.files.get('/profiles/test/bin.dat')!;
        expect(Array.from(stored)).toEqual(Array.from({ length: 256 }, (_, i) => i));
    });

    it('a replay file hand-written from Lua parses (the bug that surfaced this)', () => {
        t.run(`
            local f = assert(io.open(getMudletHomeDir() .. '/from-lua.dat', 'wb'))
            f:write(string.char(0, 0, 3, 232)) -- offset 1000ms, big-endian int32
            f:write(string.char(0, 0, 0, 2))   -- length 2
            f:write('hi')
            f:close()
        `);
        const parsed = parseReplay(stub.files.get('/profiles/test/from-lua.dat')!);
        expect(parsed).not.toBeNull();
        expect(parsed!.length).toBe(1);
        expect(parsed![0].offsetMs).toBe(1000);
        expect(replayBytesToLatin1(parsed![0].data)).toBe('hi');
    });

    it('keeps UTF-8 text byte-identical through write and line reads', () => {
        const result = t.run(`
            local f = assert(io.open(getMudletHomeDir() .. '/text.txt', 'w'))
            f:write('héllo wörld\\nsecond zäile\\n')
            f:close()
            local r = assert(io.open(getMudletHomeDir() .. '/text.txt', 'r'))
            local l1, l2 = r:read('*l', '*l')
            r:close()
            return (l1 == 'héllo wörld') and (l2 == 'second zäile')
        `);
        expect(result).toBe(true);
        // On disk it must be plain UTF-8 (not double-encoded).
        expect(stub.readFile('/profiles/test/text.txt')).toBe('héllo wörld\nsecond zäile\n');
    });

    it('appends binary without corrupting existing bytes', () => {
        const result = t.run(`
            local h = getMudletHomeDir() .. '/append.bin'
            local f = assert(io.open(h, 'wb'))
            f:write(string.char(0, 255, 0))
            f:close()
            local a = assert(io.open(h, 'ab'))
            a:write(string.char(128, 0, 37)) -- high byte, NUL, '%' (the escape char)
            a:close()
            local r = assert(io.open(h, 'rb'))
            local back = r:read('*a')
            r:close()
            return back == string.char(0, 255, 0, 128, 0, 37)
        `);
        expect(result).toBe(true);
    });

    it('reads binary chunks by byte count with correct seek positions', () => {
        const result = t.run(`
            local h = getMudletHomeDir() .. '/seek.bin'
            local f = assert(io.open(h, 'wb'))
            f:write(string.char(1, 0, 2, 0, 3, 0, 4, 0))
            f:close()
            local r = assert(io.open(h, 'rb'))
            local first = r:read(4)             -- \\1\\0\\2\\0
            local pos = r:seek('cur', 0)        -- byte offset, not char offset
            local rest = r:read('*a')           -- \\3\\0\\4\\0
            r:close()
            return (first == string.char(1, 0, 2, 0)) and pos == 4 and (rest == string.char(3, 0, 4, 0))
        `);
        expect(result).toBe(true);
    });
});
