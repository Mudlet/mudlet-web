// @vitest-environment node
//
// mudlet-web#443 item 3: a db:add exported the whole database and rewrote its
// whole file at the end of every task that wrote, so a script writing a row
// per incoming line paid a full export per line. Writes now coalesce: the file
// is written once they settle (or at the latest SNAPSHOT_MAX_WAIT_MS after the
// first), and anything that needs the file sooner — a read of it, the runtime
// going — still gets every committed row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { SNAPSHOT_DELAY_MS, SNAPSHOT_MAX_WAIT_MS } from '../../src/db/sqliteClient';

/** In-memory ProfileVFS stand-in (as luasqlConnections.test.ts) that counts
 *  every write of each file. */
class StubVFS {
    profilePath = '/profiles/test';
    files = new Map<string, Uint8Array>();
    writes = new Map<string, number>();
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
    writeBinaryFile(p: string, data: Uint8Array): void {
        const abs = this.resolvePath(p);
        this.files.set(abs, new Uint8Array(data));
        this.writes.set(abs, (this.writes.get(abs) ?? 0) + 1);
    }
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

const FILE = '/profiles/test/Database_log.db';

describe('mudlet-web#443: db writes coalesce into one export', () => {
    let vfs: StubVFS;
    let env: TestRuntime;
    let disposed = false;
    beforeEach(async () => {
        vfs = new StubVFS();
        disposed = false;
        env = await createTestRuntime({ vfs: vfs as unknown as ProfileVFS });
        vi.useFakeTimers();
        env.run(`_G.d = db:create("log", {lines={n=0}})`);
        vi.advanceTimersByTime(SNAPSHOT_MAX_WAIT_MS);
    });
    afterEach(() => {
        vi.useRealTimers();
        if (!disposed) env.dispose();
    });

    const writes = () => vfs.writes.get(FILE) ?? 0;
    /** The rows a fresh runtime reads from the file as it was last written,
     *  with nothing of the first runtime's connections behind it. */
    const rowsInFile = async (): Promise<number> => {
        const copy = new StubVFS();
        copy.files.set(FILE, vfs.files.get(FILE)!);
        vi.useRealTimers();
        const other = await createTestRuntime({ vfs: copy as unknown as ProfileVFS });
        try {
            return other.run(`
                local c = luasql.sqlite3():connect(getMudletHomeDir().."/Database_log.db")
                local cu = c:execute("select count(*) from lines")
                local n = cu:fetch(); cu:close(); c:close(); return n`) as number;
        } finally {
            other.dispose();
        }
    };

    it('a db:add per line, one line per task, writes the file once when they stop', () => {
        const before = writes();
        for (let i = 1; i <= 50; i++) {
            env.run(`db:add(d.lines, {n=${i}})`);
            vi.advanceTimersByTime(20);
        }
        expect(writes()).toBe(before);
        vi.advanceTimersByTime(SNAPSHOT_DELAY_MS);
        expect(writes()).toBe(before + 1);
    });

    it('a stream that never pauses is still written out by the max wait', () => {
        const before = writes();
        const step = Math.floor(SNAPSHOT_DELAY_MS / 4);
        for (let t = 0; t <= SNAPSHOT_MAX_WAIT_MS; t += step) {
            env.run(`db:add(d.lines, {n=1})`);
            vi.advanceTimersByTime(step);
        }
        expect(writes()).toBe(before + 1);
    });

    it('a read of the file right after the write sees the row', async () => {
        env.run(`db:add(d.lines, {n=7})`);
        const before = writes();
        // io reads through the VFS read barrier, which writes the file first.
        expect(env.run(`
            local f = io.open(getMudletHomeDir().."/Database_log.db", "rb")
            local s = f:read(15); f:close(); return s`)).toBe('SQLite format 3');
        expect(writes()).toBe(before + 1);
        expect(await rowsInFile()).toBe(1);
    });

    it('closing the runtime writes out what is still waiting', async () => {
        env.run(`for i = 1, 5 do db:add(d.lines, {n=i}) end`);
        const before = writes();
        env.dispose();
        disposed = true;
        expect(writes()).toBe(before + 1);
        expect(await rowsInFile()).toBe(5);
    });

    it('db:close writes out what is still waiting', async () => {
        env.run(`for i = 1, 3 do db:add(d.lines, {n=i}) end; db:close()`);
        expect(await rowsInFile()).toBe(3);
    });
});
