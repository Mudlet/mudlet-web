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
    /** Every path readBinaryFile was asked for, in order. */
    reads: string[] = [];
    resolvePath(p: string): string { return p.startsWith('/') ? p : `${this.profilePath}/${p}`; }
    exists(p: string): boolean { return this.files.has(this.resolvePath(p)); }
    readBinaryFile(p: string): Uint8Array {
        this.reads.push(this.resolvePath(p));
        const bytes = this.files.get(this.resolvePath(p));
        if (!bytes) throw new Error(`ENOENT: ${p}`);
        return bytes;
    }
    writeBinaryFile(p: string, data: Uint8Array): void { this.files.set(this.resolvePath(p), data); }
    appendBinaryFile(p: string, data: Uint8Array): void {
        const abs = this.resolvePath(p);
        const old = this.files.get(abs) ?? new Uint8Array(0);
        const next = new Uint8Array(old.length + data.length);
        next.set(old);
        next.set(data, old.length);
        this.files.set(abs, next);
    }
    readFile(p: string): string { return new TextDecoder().decode(this.readBinaryFile(p)); }
    writeFile(p: string, content: string): void { this.writeBinaryFile(p, new TextEncoder().encode(content)); }
    deleteFile(p: string): void { this.files.delete(this.resolvePath(p)); }
    /** io.open checks the parent directory exists before creating a file;
     *  the profile root and everything above it are the only directories. */
    stat(p: string): { type: 'file' | 'dir'; size?: number } | null {
        const abs = this.resolvePath(p);
        const file = this.files.get(abs);
        if (file) return { type: 'file', size: file.length };
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

    // mudlet-web#439: an append handle used to read the whole file on open and
    // write all of it back on close, so each line a chat log appended cost more
    // the longer the log was.
    describe('append modes', () => {
        const home = '/profiles/test';
        const seed = (name: string, text: string) =>
            stub.files.set(`${home}/${name}`, new TextEncoder().encode(text));
        const stored = (name: string) => new TextDecoder().decode(stub.files.get(`${home}/${name}`));

        it('"a" adds to the file without reading it', () => {
            seed('log.txt', 'x'.repeat(100_000));
            stub.reads = [];
            const result = t.run(`
                local p = getMudletHomeDir() .. '/log.txt'
                for i = 1, 50 do
                    local f = assert(io.open(p, 'a'))
                    f:write('line ', i, '\\n')
                    f:close()
                end
                return true
            `);
            expect(result).toBe(true);
            expect(stub.reads).toEqual([]);
            const text = stored('log.txt');
            expect(text.length).toBe(100_000 + Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join('').length);
            expect(text.endsWith('line 49\nline 50\n')).toBe(true);
        });

        it('"a" reports positions that count what the file already held', () => {
            seed('pos.txt', 'hello');
            const result = t.run(`
                local f = assert(io.open(getMudletHomeDir() .. '/pos.txt', 'a'))
                local atOpen = f:seek('cur')
                f:write('abc')
                local afterWrite = f:seek('cur')
                local atEnd = f:seek('end')
                -- A write in append mode goes to the end wherever the position is.
                f:seek('set', 0)
                f:write('!')
                local afterSeekWrite = f:seek('cur')
                local readable = f:read('*a')
                f:close()
                return table.concat({atOpen, afterWrite, atEnd, afterSeekWrite, tostring(readable)}, ',')
            `);
            expect(result).toBe('5,8,8,9,nil');
            expect(stored('pos.txt')).toBe('helloabc!');
        });

        it('"a" creates a missing file on open, as fopen does, even when nothing is written', () => {
            const result = t.run(`
                local home = getMudletHomeDir()
                local f = assert(io.open(home .. '/new.txt', 'a'))
                f:write('first')
                f:close()
                local g = assert(io.open(home .. '/untouched.txt', 'a'))
                local whileOpen = io.open(home .. '/untouched.txt', 'r') ~= nil
                g:close()
                return tostring(whileOpen) .. ',' .. tostring(io.open(home .. '/untouched.txt', 'r') ~= nil)
            `);
            expect(result).toBe('true,true');
            expect(stored('new.txt')).toBe('first');
            expect(stored('untouched.txt')).toBe('');
        });

        it('two "a" handles open at once both land', () => {
            seed('both.txt', '0');
            t.run(`
                local p = getMudletHomeDir() .. '/both.txt'
                local a = assert(io.open(p, 'a'))
                local b = assert(io.open(p, 'a'))
                a:write('a')
                b:write('b')
                a:close()
                b:close()
            `);
            expect(stored('both.txt')).toBe('0ab');
        });

        it('"a+" reads the old content only once it reads, from the start', () => {
            seed('plus.txt', 'one\ntwo\n');
            stub.reads = [];
            const writeOnly = t.run(`
                local f = assert(io.open(getMudletHomeDir() .. '/plus.txt', 'a+'))
                f:write('three\\n')
                local atEnd = f:seek('end')
                f:close()
                return atEnd
            `);
            expect(writeOnly).toBe(14);
            expect(stub.reads).toEqual([]);
            expect(stored('plus.txt')).toBe('one\ntwo\nthree\n');

            const result = t.run(`
                local f = assert(io.open(getMudletHomeDir() .. '/plus.txt', 'a+'))
                f:write('four\\n')
                -- The write left the position at the end, as O_APPEND does.
                local afterWrite = f:read('*a')
                f:seek('set', 0)
                local lines = {}
                for line in f:lines() do lines[#lines + 1] = line end
                f:seek('set', 4)
                local second = f:read('*l')
                f:write('five\\n')
                f:seek('set', 0)
                local all = f:read('*a')
                f:close()
                return afterWrite .. ';' .. table.concat(lines, '|') .. ';' .. second .. ';' .. all
            `);
            expect(result).toBe(';one|two|three|four;two;one\ntwo\nthree\nfour\nfive\n');
            expect(stored('plus.txt')).toBe('one\ntwo\nthree\nfour\nfive\n');
        });
    });
});
