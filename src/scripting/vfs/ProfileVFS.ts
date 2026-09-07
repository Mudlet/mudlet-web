import {
    configure,
    InMemory,
    mount,
    mounts,
    umount,
    resolveMountConfig,
    readFileSync,
    writeFileSync,
    appendFileSync,
    mkdirSync,
    rmdirSync,
    readdirSync,
    statSync,
    existsSync,
    unlinkSync,
    rmSync,
    renameSync,
    type FileSystem,
} from '@zenfs/core';
import { IndexedDB, WebAccess } from '@zenfs/dom';
import { checkFolderPermission, loadFolderHandle } from './folderHandleStore';
import { invalidateVfsPath } from './vfsBridge';
import { profileVfsDatabaseName } from '../../storage/profileStorage';
import { whenIdbNamesMigrated } from '../../storage/storageMigration';

let rootReady: Promise<void> | null = null;

function ensureRoot(): Promise<void> {
    if (!rootReady) {
        rootReady = configure({ mounts: { '/': InMemory } });
    }
    return rootReady;
}

// Per-connection serialization chain for ProfileVFS.mount() — see comment on
// ProfileVFS.mount for why this is needed.
const mountChain = new Map<string, Promise<unknown>>();

export type VFSSource = 'folder' | 'idb';

// AsyncMixin exposes sync(), but it isn't on FileSystem's public type.
type Syncable = FileSystem & { sync?: () => Promise<void> };

/**
 * Disable access-time tracking on a freshly resolved mount.
 *
 * ZenFS bumps a file's atime on every read and marks the handle dirty, so
 * closing the handle flushes the inode back to the backing store
 * (vfs/file.js: readSync → closeSync → syncSync → touchSync → store write).
 * Boot scripts read many data files through `io.open`, which turned that
 * atime write-back into ~175ms of synchronous IndexedDB writes during startup
 * — and a store write on *every* file read thereafter. mudix never relies on
 * atime (stat() and the Lua `lfs` `access` field only surface it), so we opt
 * out, the same trade-off as mounting a real filesystem `noatime`. The
 * `attributes` map is shared across the mixin stack (MutexedFS delegates to
 * its inner fs; AsyncFS inherits the instance field), so setting it once here
 * reaches the file handle that checks `fs.attributes.has('no_atime')`.
 */
function disableAtime(fs: Syncable): Syncable {
    fs.attributes.set('no_atime');
    return fs;
}

export class ProfileVFS {
    readonly profilePath: string;
    private _cwd: string;
    private _fs: Syncable;
    private _handle?: FileSystemDirectoryHandle;
    readonly source: VFSSource;
    readonly folderName?: string;

    private constructor(
        readonly connectionId: string,
        fs: Syncable,
        source: VFSSource,
        handle?: FileSystemDirectoryHandle,
    ) {
        this.profilePath = `/profiles/${connectionId}`;
        this._cwd = this.profilePath;
        this._fs = fs;
        this._handle = handle;
        this.source = source;
        this.folderName = handle?.name;
    }

    static mount(connectionId: string): Promise<ProfileVFS> {
        // Serialize concurrent mounts for the same connectionId. Without this,
        // two in-flight mount() calls (StrictMode synthetic remount, quick
        // profile re-open) race past the `mounts.has()` check and both reach
        // the synchronous `mount(path, fs)` — one wins, the other throws
        // "Mount point is already in use". Chaining them ensures the second
        // call observes the first's mount and tears it down before claiming.
        const prev = mountChain.get(connectionId) ?? Promise.resolve();
        const next = prev
            .catch(() => { /* prior mount failed — proceed anyway */ })
            .then(() => ProfileVFS.doMount(connectionId));
        mountChain.set(connectionId, next.then(() => undefined, () => undefined));
        return next;
    }

    private static async doMount(connectionId: string): Promise<ProfileVFS> {
        await ensureRoot();
        const profilePath = `/profiles/${connectionId}`;

        // A previous mount at this path may still be present if the prior
        // session's destroy() kicked off `flush().finally(unmount)` and the
        // new mount races ahead of it. Tear it down right before claiming
        // the slot so the fresh mount succeeds; the older flush still
        // resolves against its captured fs ref, and its scheduled unmount
        // is a no-op thanks to the ownership check in unmount().
        const claimSlot = () => {
            if (mounts.has(profilePath)) {
                try { umount(profilePath); } catch { /* not mounted */ }
            }
        };

        // Prefer a linked folder if the user previously picked one and the
        // browser still grants us readwrite permission without a fresh prompt.
        // Permission prompts require a user gesture, so on cold start we can
        // only use the folder when the grant is already 'granted'. Anything
        // else falls back silently to IDB; the UI surfaces a re-link affordance.
        const handle = await loadFolderHandle(connectionId).catch(() => null);
        if (handle) {
            const perm = await checkFolderPermission(handle);
            if (perm === 'granted') {
                try {
                    const fs = disableAtime(await resolveMountConfig({ backend: WebAccess, handle }) as Syncable);
                    claimSlot();
                    mount(profilePath, fs);
                    return new ProfileVFS(connectionId, fs, 'folder', handle);
                } catch (err) {
                    console.warn('[ProfileVFS] folder mount failed, falling back to IDB:', err);
                }
            }
        }

        // The profile databases were named `mudix_vfs_<id>` until the storage
        // namespace rename; mounting before that has been moved would create a
        // fresh, empty filesystem alongside the real one.
        await whenIdbNamesMigrated();
        const fs = disableAtime(await resolveMountConfig({ backend: IndexedDB, storeName: profileVfsDatabaseName(connectionId) }) as Syncable);
        claimSlot();
        mount(profilePath, fs);
        if (!existsSync(profilePath)) {
            mkdirSync(profilePath, { recursive: true });
        }
        return new ProfileVFS(connectionId, fs, 'idb');
    }

    get cwd(): string { return this._cwd; }

    resolvePath(path: string): string {
        const abs = path.startsWith('/') ? path : `${this._cwd}/${path}`;
        return normalizePath(abs);
    }

    exists(path: string): boolean {
        try { return existsSync(this.resolvePath(path)); } catch { return false; }
    }

    readFile(path: string): string {
        return readFileSync(this.resolvePath(path), 'utf8') as string;
    }

    readBinaryFile(path: string): Uint8Array {
        return readFileSync(this.resolvePath(path)) as unknown as Uint8Array;
    }

    writeFile(path: string, content: string): void {
        const abs = this.resolvePath(path);
        ensureParentDir(abs);
        this.clearForOverwrite(abs);
        writeFileSync(abs, content, 'utf8');
        this.invalidate(abs);
    }

    writeBinaryFile(path: string, data: Uint8Array): void {
        const abs = this.resolvePath(path);
        ensureParentDir(abs);
        this.clearForOverwrite(abs);
        writeFileSync(abs, data);
        this.invalidate(abs);
    }

    /**
     * The linked-folder (WebAccess / FileSystemDirectoryHandle) backend overwrites
     * a file from offset 0 but does NOT shrink it, so writing shorter content over
     * longer leaves stale tail bytes — silently corrupting Lua `table.save` data,
     * JSON, and the profile XML. Removing the file first forces a fresh,
     * correctly-sized write. IndexedDB truncates on the `w` flag correctly, so it's
     * left untouched (no extra op per save).
     */
    private clearForOverwrite(abs: string): void {
        if (this.source !== 'folder') return;
        try { unlinkSync(abs); } catch { /* nothing to remove */ }
    }

    appendFile(path: string, content: string): void {
        const abs = this.resolvePath(path);
        ensureParentDir(abs);
        appendFileSync(abs, content, 'utf8');
        this.invalidate(abs);
    }

    deleteFile(path: string): void {
        const abs = this.resolvePath(path);
        unlinkSync(abs);
        this.invalidate(abs);
    }

    rename(oldPath: string, newPath: string): void {
        const absOld = this.resolvePath(oldPath);
        const absNew = this.resolvePath(newPath);
        ensureParentDir(absNew);
        renameSync(absOld, absNew);
        this.invalidate(absOld);
        this.invalidate(absNew);
    }

    mkdir(path: string): void {
        mkdirSync(this.resolvePath(path), { recursive: true });
    }

    rmdir(path: string): void {
        const abs = this.resolvePath(path);
        try {
            rmdirSync(abs);
        } catch {
            rmSync(abs, { recursive: true, force: true });
        }
    }

    readdir(path: string): string[] {
        return readdirSync(this.resolvePath(path)) as string[];
    }

    stat(path: string): { type: 'file' | 'dir'; size: number; mtime: Date; atime: Date } | null {
        try {
            const s = statSync(this.resolvePath(path));
            return {
                type: s.isDirectory() ? 'dir' : 'file',
                size: s.size,
                mtime: new Date(s.mtimeMs),
                atime: new Date(s.atimeMs),
            };
        } catch { return null; }
    }

    chdir(path: string): string | null {
        const abs = this.resolvePath(path);
        try {
            const s = statSync(abs);
            if (!s.isDirectory()) return 'not a directory';
            this._cwd = abs;
            return null;
        } catch { return 'no such directory'; }
    }

    /**
     * Drain queued async writes to the underlying backend. For folder-backed
     * mounts this writes RAM-cached changes through to disk; for IDB mounts
     * it persists to IndexedDB. Safe to call on any source.
     */
    async flush(): Promise<void> {
        if (typeof this._fs.sync === 'function') {
            try { await this._fs.sync(); } catch (err) { console.warn('[ProfileVFS] flush failed:', err); }
        }
    }

    /**
     * Re-walk the linked directory and rebuild the in-memory cache. Use after
     * external edits (file added/changed in the OS file manager). No-op for
     * IDB-backed profiles since their state is owned by the browser.
     *
     * Any Lua file handles opened before resync become invalid: ZenFS replaces
     * the underlying FS instance, so subsequent reads on those handles will
     * error. New `io.open` calls work normally.
     */
    async resync(): Promise<void> {
        if (this.source !== 'folder' || !this._handle) return;
        await this.flush();
        try { umount(this.profilePath); } catch { /* not mounted */ }
        const fs = disableAtime(await resolveMountConfig({ backend: WebAccess, handle: this._handle }) as Syncable);
        mount(this.profilePath, fs);
        this._fs = fs;
        // We don't know which files changed on disk — drop everything cached
        // for this connection rather than serving stale bytes for some of them.
        invalidateVfsPath(this.connectionId, '');
    }

    /** Tell the VFS service worker to drop its cached copy of a file, keyed
     *  by its path relative to the profile root (matches vfsUrlFor's scheme). */
    private invalidate(abs: string): void {
        const rel = abs.startsWith(`${this.profilePath}/`) ? abs.slice(this.profilePath.length + 1) : abs;
        invalidateVfsPath(this.connectionId, rel);
    }

    unmount(): void {
        // Only tear down the mount if we still own it. A fresh ProfileVFS may
        // have replaced us at this path before our destroy()'s fire-and-forget
        // flush() resolved; unmounting then would kill the replacement.
        if (mounts.get(this.profilePath) !== this._fs) return;
        try { umount(this.profilePath); } catch { /* already unmounted */ }
    }
}

function normalizePath(path: string): string {
    const parts = path.split('/');
    const out: string[] = [];
    for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') { out.pop(); continue; }
        out.push(p);
    }
    return '/' + out.join('/');
}

function ensureParentDir(absPath: string): void {
    const parent = absPath.substring(0, absPath.lastIndexOf('/'));
    if (parent && !existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
    }
}
