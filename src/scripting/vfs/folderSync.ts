// Helpers for the link/unlink flow in FileBrowserModal: walk a linked folder
// directly via FileSystemDirectoryHandle, walk the currently-mounted profile
// VFS, diff them, and copy files between the two sides without disturbing the
// active mount.
//
// The folder is read/written through the raw File System Access API (not
// through ZenFS), so we can inspect a folder before it becomes the active
// profile mount. The IDB side either reuses the currently-mounted VFS (for
// link operations, when the profile is still IDB-backed) or side-mounts a
// fresh IDB backend at a temporary path (for unlink, when the active mount
// is the folder).
//
// All paths used here are *relative* to the profile root (no leading slash,
// no profile prefix). The two sides only share files when their relative
// paths match.

import {
    configure,
    InMemory,
    mount,
    mounts,
    umount,
    resolveMountConfig,
    readFileSync,
    writeFileSync,
    mkdirSync,
    statSync,
    existsSync,
    type FileSystem,
} from '@zenfs/core';
import { IndexedDB } from '@zenfs/dom';
import type { ProfileVFS } from './ProfileVFS';

export type SideKind = 'local' | 'folder';

export interface FileEntry {
    /** Relative path from the profile root, e.g. "scripts/foo.lua". No leading slash. */
    path: string;
    size: number;
    mtimeMs: number;
}

export interface DiffResult {
    /** Files present only in the local (IDB) side. */
    onlyLocal: FileEntry[];
    /** Files present only in the linked folder. */
    onlyFolder: FileEntry[];
    /** Files at the same path on both sides (need user resolution). */
    conflicts: { path: string; local: FileEntry; folder: FileEntry }[];
}

// ─── Folder walking (raw File System Access API) ─────────────────────────

interface DirEntries {
    entries(): AsyncIterable<[string, FileSystemHandle]>;
}

export async function walkFolderHandle(root: FileSystemDirectoryHandle): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    async function recurse(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
        for await (const [name, handle] of (dir as unknown as DirEntries).entries()) {
            const rel = prefix ? `${prefix}/${name}` : name;
            if (handle.kind === 'directory') {
                await recurse(handle as FileSystemDirectoryHandle, rel);
            } else {
                const file = await (handle as FileSystemFileHandle).getFile();
                out.push({ path: rel, size: file.size, mtimeMs: file.lastModified });
            }
        }
    }
    await recurse(root, '');
    return out;
}

// ─── VFS walking ─────────────────────────────────────────────────────────

/** Walk every file under the mounted profile, returning paths relative to the profile root. */
export function walkVfsTree(vfs: ProfileVFS): FileEntry[] {
    const root = vfs.profilePath;
    const out: FileEntry[] = [];
    function recurse(absDir: string, prefix: string): void {
        let names: string[];
        try { names = vfs.readdir(absDir); }
        catch { return; }
        for (const name of names) {
            const abs = `${absDir}/${name}`;
            const rel = prefix ? `${prefix}/${name}` : name;
            const info = vfs.stat(abs);
            if (!info) continue;
            if (info.type === 'dir') {
                recurse(abs, rel);
            } else {
                out.push({ path: rel, size: info.size, mtimeMs: info.mtime.getTime() });
            }
        }
    }
    recurse(root, '');
    return out;
}

// ─── Diff ────────────────────────────────────────────────────────────────

/**
 * A file is considered "conflicting" if it exists at the same relative path on
 * both sides, regardless of whether the bytes match. Comparing mtime/size is
 * unreliable across filesystems (folder-backed mtime comes from disk,
 * IDB-backed mtime comes from the inode index), so we let the user resolve.
 */
export function diffSides(local: FileEntry[], folder: FileEntry[]): DiffResult {
    const localMap = new Map(local.map(f => [f.path, f]));
    const folderMap = new Map(folder.map(f => [f.path, f]));
    const onlyLocal: FileEntry[] = [];
    const onlyFolder: FileEntry[] = [];
    const conflicts: DiffResult['conflicts'] = [];
    for (const [path, l] of localMap) {
        const f = folderMap.get(path);
        if (f) conflicts.push({ path, local: l, folder: f });
        else onlyLocal.push(l);
    }
    for (const [path, f] of folderMap) {
        if (!localMap.has(path)) onlyFolder.push(f);
    }
    return { onlyLocal, onlyFolder, conflicts };
}

// ─── Folder writes (raw File System Access API) ──────────────────────────

async function ensureFolderDir(root: FileSystemDirectoryHandle, segments: string[]): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const seg of segments) {
        dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    return dir;
}

async function writeBytesToFolder(root: FileSystemDirectoryHandle, relPath: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const parts = relPath.split('/');
    const fileName = parts.pop()!;
    const dir = await ensureFolderDir(root, parts);
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
        await writable.write(bytes);
    } finally {
        await writable.close();
    }
}

// ─── Copy operations ─────────────────────────────────────────────────────

/**
 * Copy the listed relative paths from the mounted profile into the linked
 * folder. Used on link to materialize IDB-only files (and "use local"
 * resolutions) before the next mount picks up the folder as the source.
 */
export async function copyVfsToFolder(
    vfs: ProfileVFS,
    handle: FileSystemDirectoryHandle,
    relPaths: string[],
): Promise<{ copied: number; failed: { path: string; reason: string }[] }> {
    const failed: { path: string; reason: string }[] = [];
    let copied = 0;
    for (const rel of relPaths) {
        try {
            const abs = `${vfs.profilePath}/${rel}`;
            const bytes = vfs.readBinaryFile(abs);
            // Defensive copy: ZenFS may return a Buffer view with non-zero
            // byteOffset, which the writable stream still accepts but copying
            // makes the lifetime independent of the source buffer.
            const owned = new Uint8Array(bytes.byteLength);
            owned.set(bytes);
            await writeBytesToFolder(handle, rel, owned);
            copied++;
        } catch (e) {
            failed.push({ path: rel, reason: e instanceof Error ? e.message : String(e) });
        }
    }
    return { copied, failed };
}

/**
 * Side-mount a fresh IDB backend for the given connection at a temporary
 * profile path, copy every file from the linked folder into it, then unmount.
 * Used on unlink so the user's next mount (now IDB-backed because the handle
 * is cleared) sees the folder's content. Idempotent: any prior data in the
 * IDB store gets overwritten when paths collide.
 */
export async function copyFolderToIdb(
    handle: FileSystemDirectoryHandle,
    connectionId: string,
): Promise<{ copied: number; failed: { path: string; reason: string }[] }> {
    // Ensure the global root is configured (matches ProfileVFS's lazy init).
    if (!mounts.has('/')) {
        await configure({ mounts: { '/': InMemory } });
    }
    const sidePath = `/_swap/${connectionId}_${Date.now()}`;
    type Syncable = FileSystem & { sync?: () => Promise<void> };
    const fs = await resolveMountConfig({
        backend: IndexedDB,
        storeName: `mudix_vfs_${connectionId}`,
    }) as Syncable;
    // Tear down any leftover mount at this path (shouldn't happen, but defensive).
    if (mounts.has(sidePath)) {
        try { umount(sidePath); } catch { /* not mounted */ }
    }
    mount(sidePath, fs);
    if (!existsSync(sidePath)) mkdirSync(sidePath, { recursive: true });
    const failed: { path: string; reason: string }[] = [];
    let copied = 0;
    try {
        async function recurse(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
            for await (const [name, h] of (dir as unknown as DirEntries).entries()) {
                const rel = prefix ? `${prefix}/${name}` : name;
                const absTarget = `${sidePath}/${rel}`;
                if (h.kind === 'directory') {
                    try { mkdirSync(absTarget, { recursive: true }); }
                    catch (e) { failed.push({ path: rel, reason: e instanceof Error ? e.message : String(e) }); }
                    await recurse(h as FileSystemDirectoryHandle, rel);
                } else {
                    try {
                        const file = await (h as FileSystemFileHandle).getFile();
                        const buf = await file.arrayBuffer();
                        // Ensure parent exists on disk in case readdir order
                        // delivered the file before the dir (it usually doesn't,
                        // but the API doesn't guarantee order).
                        const lastSlash = absTarget.lastIndexOf('/');
                        const parent = absTarget.substring(0, lastSlash);
                        if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
                        writeFileSync(absTarget, new Uint8Array(buf));
                        copied++;
                    } catch (e) {
                        failed.push({ path: rel, reason: e instanceof Error ? e.message : String(e) });
                    }
                }
            }
        }
        await recurse(handle, '');
        // Drain any queued async writes before we tear the mount down.
        if (typeof fs.sync === 'function') {
            try { await fs.sync(); } catch (e) { console.warn('[folderSync] flush failed:', e); }
        }
    } finally {
        try { umount(sidePath); } catch { /* already gone */ }
    }
    return { copied, failed };
}

// ─── Utility used by callers for "is this side non-empty" probing ────────

export function hasAnyFile(entries: FileEntry[]): boolean {
    return entries.length > 0;
}

// Re-exports of read helpers so callers don't have to import @zenfs/core.
export { readFileSync, statSync };
