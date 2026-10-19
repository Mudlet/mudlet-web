// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #457: ZenFS keeps a file as one value in its store, so every append read the
 * whole file back and wrote all of it again — EMCO's chat log, appended to a
 * line at a time, cost 30 ms a line at 5 MB. ProfileVFS now holds the bytes
 * appended to an existing file and writes them out together. These pin that
 * the store is not touched per append, and that nothing reading the file
 * through the VFS can tell the tail is held.
 *
 * The IndexedDB backend is swapped for ZenFS's InMemory store, as in
 * vfsLogDirectory440: what is under test is ProfileVFS's own buffering.
 */

vi.mock('@zenfs/dom', async () => {
    const { InMemory } = await import('@zenfs/core');
    return { IndexedDB: InMemory, WebAccess: InMemory };
});
vi.mock('../../src/scripting/vfs/folderHandleStore', () => ({
    loadFolderHandle: async () => null,
    checkFolderPermission: async () => 'denied',
}));
vi.mock('../../src/storage/storageMigration', () => ({
    whenIdbNamesMigrated: async () => undefined,
}));

const zen = await import('@zenfs/core');
const { ProfileVFS, APPEND_FLUSH_MS, APPEND_FLUSH_BYTES } = await import('../../src/scripting/vfs/ProfileVFS');

const bytes = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

let n = 0;
async function mounted() {
    const vfs = await ProfileVFS.mount(`append-${++n}`);
    const file = `${vfs.profilePath}/log/chat.html`;
    vfs.writeFile(file, '<html>');
    /** The file as the store holds it, behind ProfileVFS's back. */
    const stored = () => zen.readFileSync(file, 'utf8') as string;
    return { vfs, file, stored };
}

describe('io.open(f, "a") appends (#457)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('does not rewrite the file in the store on every append', async () => {
        const { vfs, file, stored } = await mounted();
        for (let i = 0; i < 50; i++) vfs.appendBinaryFile(file, bytes(`<p>${i}</p>`));
        // Nothing in the store yet: 50 appends, no whole-file rewrite.
        expect(stored()).toBe('<html>');
        vi.advanceTimersByTime(APPEND_FLUSH_MS);
        // One write, everything in order.
        const expected = '<html>' + Array.from({ length: 50 }, (_, i) => `<p>${i}</p>`).join('');
        expect(stored()).toBe(expected);
        vfs.unmount();
    });

    it('is invisible to every reader through the VFS', async () => {
        const { vfs, file } = await mounted();
        vfs.appendBinaryFile(file, bytes('<p>a</p>'));
        // What io.open(f, "a") asks on every open, answered without a flush.
        expect(vfs.exists(file)).toBe(true);
        expect(vfs.stat(file)?.size).toBe('<html><p>a</p>'.length);
        vfs.appendBinaryFile(file, bytes('<p>b</p>'));
        expect(decode(vfs.readBinaryFile(file))).toBe('<html><p>a</p><p>b</p>');
        vfs.appendBinaryFile(file, bytes('<p>c</p>'));
        expect(vfs.readFile(file)).toBe('<html><p>a</p><p>b</p><p>c</p>');
        vfs.unmount();
    });

    it('lets a rewrite, a rename or a removal see the tail first', async () => {
        const { vfs, file, stored } = await mounted();
        vfs.appendBinaryFile(file, bytes('<p>a</p>'));
        vfs.writeFile(file, 'fresh');
        vi.advanceTimersByTime(APPEND_FLUSH_MS);
        expect(stored()).toBe('fresh');

        vfs.appendBinaryFile(file, bytes('+1'));
        const moved = `${vfs.profilePath}/log/moved.html`;
        vfs.rename(file, moved);
        expect(vfs.readFile(moved)).toBe('fresh+1');

        vfs.appendBinaryFile(moved, bytes('+2'));
        vfs.deleteFile(moved);
        vi.advanceTimersByTime(APPEND_FLUSH_MS);
        expect(vfs.exists(moved)).toBe(false);

        // A directory going takes the held tails under it first.
        const sub = `${vfs.profilePath}/logs2`;
        vfs.writeFile(`${sub}/x.txt`, 'x');
        vfs.appendBinaryFile(`${sub}/x.txt`, bytes('y'));
        vfs.rename(sub, `${vfs.profilePath}/logs3`);
        expect(vfs.readFile(`${vfs.profilePath}/logs3/x.txt`)).toBe('xy');
        vfs.unmount();
    });

    it('writes a large tail out at once, and everything on flush()', async () => {
        const { vfs, file, stored } = await mounted();
        vfs.appendBinaryFile(file, new Uint8Array(APPEND_FLUSH_BYTES).fill(0x61));
        expect(stored().length).toBe('<html>'.length + APPEND_FLUSH_BYTES);

        vfs.appendBinaryFile(file, bytes('!'));
        await vfs.flush();
        expect(stored().endsWith('a!')).toBe(true);
        vfs.unmount();
    });

    it('writes through a new file, as before', async () => {
        const { vfs } = await mounted();
        const fresh = `${vfs.profilePath}/log/new.txt`;
        vfs.appendBinaryFile(fresh, bytes('first'));
        expect(zen.readFileSync(fresh, 'utf8')).toBe('first');
        vfs.unmount();
    });

    it('does not keep the caller\'s buffer', async () => {
        const { vfs, file } = await mounted();
        const buf = bytes('abc');
        vfs.appendBinaryFile(file, buf);
        buf.fill(0x7a);
        expect(vfs.readFile(file)).toBe('<html>abc');
        vfs.unmount();
    });
});
