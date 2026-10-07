// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #440: desktop's Host constructor mkpaths `<profile>/log` every time a
 * profile loads, so scripts (simple-logger among them) write
 * `getMudletHomeDir() .. "/log/..."` without creating it — and `io.open`
 * won't create a missing parent. Both VFS backends must make it on mount.
 *
 * The browser backends are swapped for ZenFS's InMemory store: what is under
 * test is ProfileVFS.mount's own setup, not IndexedDB or the File System
 * Access API.
 */

const folder = vi.hoisted(() => ({ handle: null as unknown }));

vi.mock('@zenfs/dom', async () => {
    const { InMemory } = await import('@zenfs/core');
    return { IndexedDB: InMemory, WebAccess: InMemory };
});
vi.mock('../../src/scripting/vfs/folderHandleStore', () => ({
    loadFolderHandle: async () => folder.handle,
    checkFolderPermission: async () => 'granted',
}));
vi.mock('../../src/storage/storageMigration', () => ({
    whenIdbNamesMigrated: async () => undefined,
}));

const { ProfileVFS } = await import('../../src/scripting/vfs/ProfileVFS');

describe('profile log directory (#440)', () => {
    beforeEach(() => { folder.handle = null; });

    it('is created when an IndexedDB-backed profile mounts', async () => {
        const vfs = await ProfileVFS.mount('log-idb');
        expect(vfs.source).toBe('idb');
        expect(vfs.stat(`${vfs.profilePath}/log`)?.type).toBe('dir');
        vfs.writeFile(`${vfs.profilePath}/log/session.txt`, 'hello');
        expect(vfs.readFile(`${vfs.profilePath}/log/session.txt`)).toBe('hello');
        vfs.unmount();
    });

    it('is created when a linked-folder profile mounts', async () => {
        folder.handle = { name: 'linked' };
        const vfs = await ProfileVFS.mount('log-folder');
        expect(vfs.source).toBe('folder');
        expect(vfs.stat(`${vfs.profilePath}/log`)?.type).toBe('dir');
        vfs.unmount();
    });
});
