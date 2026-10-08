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
    utimesSync,
    lstatSync,
    readlinkSync,
    symlinkSync,
    linkSync,
    type FileSystem,
} from '@zenfs/core';
import { IndexedDB, WebAccess } from '@zenfs/dom';
import { checkFolderPermission, loadFolderHandle } from './folderHandleStore';
import { invalidateVfsPath } from './vfsBridge';
import { FsError } from './fsErrors';
import { commitSyncWritesImmediately } from './idbCommit';
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

/** How long an appended tail waits in memory before it is written out. */
export const APPEND_FLUSH_MS = 500;
/** A tail that has grown this large is written out at once. */
export const APPEND_FLUSH_BYTES = 256 * 1024;

/** A file's appended bytes not yet in the store (see appendBinaryFile). */
interface PendingAppend {
    chunks: Uint8Array[];
    bytes: number;
    mtimeMs: number;
}

/** The mounts holding an appended tail, so the page going away writes them
 *  all out. */
const vfsWithAppends = new Set<ProfileVFS>();
/** The page is being hidden or unloaded: no timer may be counted on now, so
 *  an append goes straight to the store. */
let pageHiding = false;
let pageListenersInstalled = false;

function installPageListeners(): void {
    if (pageListenersInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    pageListenersInstalled = true;
    const flushAll = () => { for (const vfs of vfsWithAppends) vfs.flushAppends(); };
    // Whichever order this runs in against the sysExitEvent handler (#438),
    // nothing is left behind: an append made before it is flushed here, one
    // made after it finds pageHiding set and is written through.
    window.addEventListener('pagehide', () => { pageHiding = true; flushAll(); }, { capture: true });
    window.addEventListener('pageshow', () => { pageHiding = false; });
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushAll();
        });
        // A hidden tab can be frozen and then discarded without a pagehide;
        // frozen, it runs no timer, so a tail appended while hidden would
        // never be written out.
        document.addEventListener('freeze', flushAll);
    }
}

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
 * — and a store write on *every* file read thereafter. Mudlet Web never relies on
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

/** {@link ProfileVFS.lstat}: a stat that can also be about a symbolic link. */
export type VfsLstat = Omit<VfsStat, 'type'> & { type: VfsStat['type'] | 'link' };

export interface VfsStat {
    type: 'file' | 'dir';
    size: number;
    mtime: Date;
    atime: Date;
    /** Inode change time — what `lfs.attributes` reports as `change`. */
    ctime: Date;
    /** The full `st_mode`: file type bits and permission bits. */
    mode: number;
    dev: number;
    ino: number;
    nlink: number;
    uid: number;
    gid: number;
    rdev: number;
    blocks: number;
    blksize: number;
}

export class ProfileVFS {
    readonly profilePath: string;
    private _cwd: string;
    private _fs: Syncable;
    private _handle?: FileSystemDirectoryHandle;
    readonly source: VFSSource;
    readonly folderName?: string;
    private readBarrier: ((absPath: string) => void) | null = null;
    private writeObserver: ((absPath: string, kind: 'write' | 'remove') => void) | null = null;
    /** See {@link writeGeneration}. Bumped in afterWrite, the one place every
     *  write, removal and rename already reports through. */
    private readonly writeGenerations = new Map<string, number>();
    /** See {@link appendBinaryFile}. Keyed by absolute path. */
    private readonly pendingAppends = new Map<string, PendingAppend>();
    private appendFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
                    ensureProfileDirs(profilePath);
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
        // So a file written as the page closes (sysExitEvent) is kept — #438.
        commitSyncWritesImmediately(fs);
        claimSlot();
        mount(profilePath, fs);
        ensureProfileDirs(profilePath);
        return new ProfileVFS(connectionId, fs, 'idb');
    }

    get cwd(): string { return this._cwd; }

    /**
     * Run `barrier` with a file's absolute path before anything reads it.
     * The sql bridge uses it to write a database's pending changes out first,
     * so a file a script (or the file browser, or an upload) reads right after
     * a db:add holds that row, as desktop's database file would. Null removes it.
     */
    setReadBarrier(barrier: ((absPath: string) => void) | null): void {
        this.readBarrier = barrier;
    }

    /**
     * Install (or clear, with null) a hook told after a file has been written
     * ('write') or removed, renamed away or replaced by a rename, or had its
     * directory removed ('remove'). The sql bridge uses it so a database file
     * changed underneath an open connection is changed for that connection
     * too, as a file on disk is.
     */
    setWriteObserver(observer: ((absPath: string, kind: 'write' | 'remove') => void) | null): void {
        this.writeObserver = observer;
    }

    private afterWrite(abs: string, kind: 'write' | 'remove'): void {
        this.writeGenerations.set(abs, (this.writeGenerations.get(abs) ?? 0) + 1);
        if (this.writeObserver) {
            try { this.writeObserver(abs, kind); } catch (e) { console.warn('[ProfileVFS] write observer failed:', e); }
        }
    }

    private beforeRead(abs: string): string {
        if (this.readBarrier) {
            try { this.readBarrier(abs); } catch (e) { console.warn('[ProfileVFS] read barrier failed:', e); }
        }
        return abs;
    }

    resolvePath(path: string): string {
        const abs = path.startsWith('/') ? path : `${this._cwd}/${path}`;
        return normalizePath(abs);
    }

    exists(path: string): boolean {
        try {
            const abs = this.resolvePath(path);
            // Only a file already in the store gets a held tail, so it exists
            // — answered without writing the tail out, since io.open(f, "a")
            // asks on every close.
            return this.pendingAppends.has(abs) || existsSync(abs);
        } catch { return false; }
    }

    readFile(path: string): string {
        return readFileSync(this.settle(this.beforeRead(this.resolvePath(path))), 'utf8') as string;
    }

    readBinaryFile(path: string): Uint8Array {
        return readFileSync(this.settle(this.beforeRead(this.resolvePath(path)))) as unknown as Uint8Array;
    }

    /**
     * A count that moves whenever the file at `path` is written, removed or
     * renamed through this VFS, and never otherwise. For a reader that holds a
     * file's bytes and must notice when they have gone stale, without reading
     * the whole file again to find out — a replay being played comes back to
     * its file once a chunk. A stat cannot stand in for it: mtime is in
     * milliseconds, and a rewrite in place keeps the size.
     */
    writeGeneration(path: string): number {
        return this.writeGenerations.get(this.resolvePath(path)) ?? 0;
    }

    writeFile(path: string, content: string): void {
        const abs = this.settle(this.resolvePath(path));
        ensureParentDir(abs);
        this.clearForOverwrite(abs);
        writeFileSync(abs, content, 'utf8');
        this.invalidate(abs);
        this.afterWrite(abs, 'write');
    }

    /** `createParents: false` writes only into a directory that already exists,
     *  throwing as open(2) would otherwise — what a download's QFile does. */
    writeBinaryFile(path: string, data: Uint8Array, { createParents = true }: { createParents?: boolean } = {}): void {
        const abs = this.settle(this.resolvePath(path));
        if (createParents) ensureParentDir(abs);
        this.clearForOverwrite(abs);
        writeFileSync(abs, data);
        this.invalidate(abs);
        this.afterWrite(abs, 'write');
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
        this.appendBinaryFile(path, new TextEncoder().encode(content));
    }

    /**
     * Add `data` to the end of a file, creating it when missing — what Lua's
     * io.open(f, "a") writes through. The read barrier runs first so the bytes
     * land after anything a database still has pending for that file.
     *
     * ZenFS keeps a file as one value in its store, and an append reads that
     * value, copies it one longer and puts the whole of it back, so every
     * append cost the size of the file: a chat log EMCO appends a line to
     * per message took 30 ms a line at 5 MB (#457), where desktop's write is
     * the line's bytes. So the bytes appended to a file already in the store
     * are held here and written out together — after APPEND_FLUSH_MS, once
     * they reach APPEND_FLUSH_BYTES, or as soon as anything reads, stats,
     * rewrites, moves or removes the file (every such path goes through
     * {@link settle}), and when the page is hidden or goes away. One write per
     * window instead of one per line, and nothing can see the file without
     * the tail: {@link stat} counts it into the size and {@link exists} knows
     * the file is there.
     *
     * A file that is not there yet, a link, or an append while the page is
     * going away is written straight through, as before.
     */
    appendBinaryFile(path: string, data: Uint8Array): void {
        const abs = this.beforeRead(this.resolvePath(path));
        let pending = this.pendingAppends.get(abs);
        if (!pending && !pageHiding && this.isPlainFile(abs)) {
            pending = { chunks: [], bytes: 0, mtimeMs: 0 };
            this.pendingAppends.set(abs, pending);
            vfsWithAppends.add(this);
            installPageListeners();
        }
        if (pending) {
            // Held past the call, so not the caller's buffer to reuse.
            pending.chunks.push(data.slice());
            pending.bytes += data.byteLength;
            pending.mtimeMs = Date.now();
            if (pending.bytes >= APPEND_FLUSH_BYTES || pageHiding) this.flushAppends(abs);
            else this.scheduleAppendFlush();
        } else {
            ensureParentDir(abs);
            appendFileSync(abs, data);
        }
        this.invalidate(abs);
        this.afterWrite(abs, 'write');
    }

    /** A regular file in the store with only this one name — the only kind
     *  whose appends can be held: a held tail is found again by its path. */
    private isPlainFile(abs: string): boolean {
        try {
            const s = lstatSync(abs);
            return s.isFile() && s.nlink <= 1;
        } catch { return false; }
    }

    private scheduleAppendFlush(): void {
        if (this.appendFlushTimer !== null) return;
        this.appendFlushTimer = setTimeout(() => {
            this.appendFlushTimer = null;
            this.flushAppends();
        }, APPEND_FLUSH_MS);
    }

    /**
     * Write out the appended bytes held for `scope` — that file, or every
     * file under it when it is a directory — or for every file when omitted.
     * Returns `scope`, so a path can be settled on its way into a call.
     */
    flushAppends(scope?: string): string | undefined {
        if (this.pendingAppends.size === 0) return scope;
        const prefix = scope === undefined ? '' : `${scope}/`;
        for (const [abs, pending] of [...this.pendingAppends]) {
            if (scope !== undefined && abs !== scope && !abs.startsWith(prefix)) continue;
            this.pendingAppends.delete(abs);
            const data = pending.chunks.length === 1 ? pending.chunks[0] : concatBytes(pending.chunks, pending.bytes);
            try {
                ensureParentDir(abs);
                appendFileSync(abs, data);
            } catch (e) {
                console.error(`[ProfileVFS] could not write appended data to ${abs}:`, e);
            }
        }
        if (this.pendingAppends.size === 0) {
            vfsWithAppends.delete(this);
            if (this.appendFlushTimer !== null) {
                clearTimeout(this.appendFlushTimer);
                this.appendFlushTimer = null;
            }
        }
        return scope;
    }

    /** {@link flushAppends} for one absolute path, returned for chaining. */
    private settle(abs: string): string {
        if (this.pendingAppends.size > 0) this.flushAppends(abs);
        return abs;
    }

    deleteFile(path: string): void {
        const abs = this.settle(this.resolvePath(path));
        unlinkSync(abs);
        this.invalidate(abs);
        this.afterWrite(abs, 'remove');
    }

    /**
     * Move a file or directory. By default a missing parent of the target is
     * created, which the app's own callers rely on. `{ posix: true }` is
     * `rename(2)`, what Lua's `os.rename` is on desktop: the target's directory
     * must already exist (ENOENT, or ENOTDIR under a file), a directory may
     * replace only an empty directory (ENOTEMPTY otherwise, ENOTDIR for a
     * file) and never move into itself (EINVAL), and a file never replaces a
     * directory (EISDIR).
     */
    rename(oldPath: string, newPath: string, { posix = false }: { posix?: boolean } = {}): void {
        const absOld = this.settle(this.beforeRead(this.resolvePath(oldPath)));
        const absNew = this.settle(this.resolvePath(newPath));
        if (posix) {
            this.checkPosixPath(oldPath, 'EBUSY');
            this.checkPosixPath(newPath, 'EBUSY');
            const from = this.stat(absOld)?.type;
            if (!from) throw new FsError('ENOENT', absOld);
            if (from !== 'dir' && (/\/$/.test(oldPath) || /\/$/.test(newPath))) throw new FsError('ENOTDIR', absNew);
            if (absOld === absNew) return;
            const parent = absNew.substring(0, absNew.lastIndexOf('/')) || '/';
            const parentType = this.stat(parent)?.type;
            if (!parentType) throw new FsError('ENOENT', absNew);
            if (parentType !== 'dir') throw new FsError('ENOTDIR', absNew);
            const to = this.stat(absNew)?.type;
            if (from === 'dir') {
                if (absNew.startsWith(absOld + '/')) throw new FsError('EINVAL', absNew);
                if (to && to !== 'dir') throw new FsError('ENOTDIR', absNew);
                if (to === 'dir') {
                    if (readdirSync(absNew).length > 0) throw new FsError('ENOTEMPTY', absNew);
                    rmdirSync(absNew);
                }
            } else if (to === 'dir') {
                throw new FsError('EISDIR', absNew);
            }
        } else {
            ensureParentDir(absNew);
        }
        renameSync(absOld, absNew);
        this.invalidate(absOld);
        this.invalidate(absNew);
        this.afterWrite(absOld, 'remove');
        this.afterWrite(absNew, 'remove');
    }

    /**
     * Create a directory. By default the whole chain is created and an existing
     * directory is not an error, which is what the app's own callers want.
     * `{ recursive: false }` is POSIX `mkdir(2)` — what LuaFileSystem's
     * `lfs.mkdir` does on desktop: a missing parent is ENOENT, a parent that is
     * a file is ENOTDIR, and an existing path is EEXIST.
     */
    mkdir(path: string, { recursive = true }: { recursive?: boolean } = {}): void {
        const abs = this.resolvePath(path);
        if (recursive) {
            mkdirSync(abs, { recursive: true });
            return;
        }
        if (existsSync(abs)) throw new FsError('EEXIST', abs);
        const parent = abs.substring(0, abs.lastIndexOf('/')) || '/';
        // Checked here rather than left to ZenFS, which fails a mkdir under a
        // plain file with a JSON parse error instead of ENOTDIR.
        const parentType = this.stat(parent)?.type;
        if (!parentType) throw new FsError('ENOENT', abs);
        if (parentType !== 'dir') throw new FsError('ENOTDIR', abs);
        mkdirSync(abs);
    }

    /**
     * Remove a directory. By default it goes with everything in it — the app's
     * own callers (the file browser, package reinstalls) mean exactly that.
     * `{ recursive: false }` is POSIX `rmdir(2)`, what `lfs.rmdir` does on
     * desktop: only an empty directory is removed, and a non-empty directory
     * (ENOTEMPTY), a plain file (ENOTDIR) or a missing path (ENOENT) is left
     * alone and reported. A script must never be able to wipe a folder of
     * saved data with a call that desktop refuses.
     */
    rmdir(path: string, { recursive = true }: { recursive?: boolean } = {}): void {
        const abs = this.settle(this.resolvePath(path));
        if (recursive) {
            try {
                rmdirSync(abs);
            } catch {
                rmSync(abs, { recursive: true, force: true });
            }
            this.afterWrite(abs, 'remove');
            return;
        }
        const type = this.stat(abs)?.type;
        if (!type) throw new FsError('ENOENT', abs);
        if (type !== 'dir') throw new FsError('ENOTDIR', abs);
        if (readdirSync(abs).length > 0) throw new FsError('ENOTEMPTY', abs);
        // The profile root is this VFS's mount point; removing it would leave
        // the profile with nowhere to write.
        if (abs === this.profilePath) throw new FsError('EBUSY', abs);
        rmdirSync(abs);
    }

    /**
     * C's `remove(3)`, which Lua's `os.remove` is: a file is unlinked and an
     * empty directory is removed, as `rmdir(2)` would.
     */
    remove(path: string): void {
        // glibc's remove() unlinks, and only on EISDIR tries rmdir — which
        // refuses a path ending in "." (EINVAL).
        this.checkPosixPath(path, 'EINVAL');
        const abs = this.settle(this.resolvePath(path));
        // A symbolic link goes itself, whatever (if anything) it points at.
        let isLink = false;
        try { isLink = lstatSync(abs).isSymbolicLink(); } catch { /* not there */ }
        if (isLink) {
            unlinkSync(abs);
            this.invalidate(abs);
            this.afterWrite(abs, 'remove');
            return;
        }
        const type = this.stat(abs)?.type;
        if (!type) throw new FsError('ENOENT', abs);
        if (type !== 'dir' && /\/$/.test(path)) throw new FsError('ENOTDIR', abs);
        if (type === 'dir') {
            this.rmdir(abs, { recursive: false });
        } else {
            unlinkSync(abs);
        }
        this.invalidate(abs);
        this.afterWrite(abs, 'remove');
    }

    /**
     * The parts of the kernel's path walk that `resolvePath`'s normalising
     * would hide: an empty path names nothing (ENOENT), a plain file can't
     * have anything under it (ENOTDIR), and a path ending in "." or ".." is
     * refused with `dotErrno` — the profile root is not what `os.remove(".")`
     * means.
     */
    private checkPosixPath(path: string, dotErrno: 'EINVAL' | 'EBUSY'): void {
        if (path === '') throw new FsError('ENOENT');
        const last = path.replace(/\/+$/, '').split('/').pop();
        if (last === '.' || last === '..') throw new FsError(dotErrno, path);
        const parts = this.resolvePath(path).split('/').filter(Boolean);
        let dir = '';
        for (let i = 0; i < parts.length - 1; i++) {
            dir += '/' + parts[i];
            const type = this.stat(dir)?.type;
            if (!type) return;
            if (type !== 'dir') throw new FsError('ENOTDIR', path);
        }
    }

    /**
     * Set a path's access and modification times (`utime(2)`), which is all
     * `lfs.touch` does — it never creates a file.
     */
    touch(path: string, atime: Date, mtime: Date): void {
        const abs = this.settle(this.resolvePath(path));
        if (!existsSync(abs)) throw new FsError('ENOENT', abs);
        utimesSync(abs, atime, mtime);
    }

    readdir(path: string): string[] {
        return readdirSync(this.resolvePath(path)) as string[];
    }

    stat(path: string): VfsStat | null {
        try {
            const abs = this.beforeRead(this.resolvePath(path));
            const s = statSync(abs);
            // A held tail is part of the file: io.open(f, "a") starts its
            // handle at this size on every open.
            const pending = this.pendingAppends.get(abs);
            return {
                type: s.isDirectory() ? 'dir' : 'file',
                size: s.size + (pending?.bytes ?? 0),
                mtime: new Date(pending ? Math.max(pending.mtimeMs, s.mtimeMs) : s.mtimeMs),
                atime: new Date(s.atimeMs),
                ctime: new Date(s.ctimeMs),
                mode: s.mode,
                dev: s.dev,
                ino: s.ino,
                nlink: s.nlink,
                uid: s.uid,
                gid: s.gid,
                rdev: s.rdev,
                blocks: s.blocks,
                blksize: s.blksize,
            };
        } catch { return null; }
    }

    /** `lstat(2)`: like {@link stat}, but about a symbolic link itself, which
     *  reports as type `link`. Throws the filesystem's error (ENOENT …). */
    lstat(path: string): VfsLstat {
        const s = lstatSync(this.settle(this.resolvePath(path)));
        return {
            type: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file',
            size: s.size,
            mtime: new Date(s.mtimeMs),
            atime: new Date(s.atimeMs),
            ctime: new Date(s.ctimeMs),
            mode: s.mode,
            dev: s.dev,
            ino: s.ino,
            nlink: s.nlink,
            uid: s.uid,
            gid: s.gid,
            rdev: s.rdev,
            blocks: s.blocks,
            blksize: s.blksize,
        };
    }

    /** `readlink(2)`: a symbolic link's target, as stored. */
    readlink(path: string): string {
        return String(readlinkSync(this.resolvePath(path)));
    }

    /** `link(2)` / `symlink(2)` — what `lfs.link` makes. A symbolic link's
     *  target is stored as given (it may be relative, or dangle); a hard link's
     *  must exist. Throws the filesystem's error (EEXIST, ENOENT, ENOTSUP …). */
    link(target: string, path: string, symbolic: boolean): void {
        // A hard link would give a held tail a second name it is not found by.
        if (!symbolic) this.settle(this.resolvePath(target));
        const abs = this.resolvePath(path);
        let present = false;
        try { lstatSync(abs); present = true; } catch { /* free */ }
        if (present) throw new FsError('EEXIST', abs);
        const parent = abs.substring(0, abs.lastIndexOf('/')) || '/';
        const parentType = this.stat(parent)?.type;
        if (!parentType) throw new FsError('ENOENT', abs);
        if (parentType !== 'dir') throw new FsError('ENOTDIR', abs);
        if (symbolic) {
            symlinkSync(target, abs);
        } else {
            const from = this.resolvePath(target);
            if (!existsSync(from)) throw new FsError('ENOENT', from);
            linkSync(from, abs);
        }
        this.invalidate(abs);
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
        this.flushAppends();
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
        this.flushAppends();
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

/**
 * The directories desktop makes every time a profile loads: the profile root
 * and its `log` folder (Host's constructor mkpaths `<profile>/log`). Scripts
 * write `getMudletHomeDir() .. "/log/..."` straight away, and `io.open` —
 * rightly — won't create a missing parent, so the folder has to be there.
 */
function ensureProfileDirs(profilePath: string): void {
    if (!existsSync(profilePath)) mkdirSync(profilePath, { recursive: true });
    const log = `${profilePath}/log`;
    // A file the user left named `log` is theirs; desktop's mkpath fails
    // quietly over it too, and the profile still opens.
    try {
        if (!existsSync(log)) mkdirSync(log);
    } catch (err) {
        console.warn('[ProfileVFS] could not create the log directory:', err);
    }
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
}

function ensureParentDir(absPath: string): void {
    const parent = absPath.substring(0, absPath.lastIndexOf('/'));
    if (parent && !existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
    }
}
