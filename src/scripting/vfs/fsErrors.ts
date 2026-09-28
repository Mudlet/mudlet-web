/**
 * Filesystem errors in the shape C's `strerror`/`errno` give them, so the Lua
 * `io`/`os`/`lfs` bindings can report failures the way stock Lua and
 * LuaFileSystem do on desktop Mudlet: `nil, "<message>", <errno>`.
 *
 * ZenFS already throws errors carrying Linux errno numbers and codes, but its
 * messages are its own ("EISDIR: File is a directory, open '/a'"), and scripts
 * that match on the text — or show it to the player — expect glibc's wording.
 */

/** glibc's `strerror` text, keyed by errno code. */
const STRERROR: Record<string, string> = {
    EPERM: 'Operation not permitted',
    ENOENT: 'No such file or directory',
    EIO: 'Input/output error',
    EBADF: 'Bad file descriptor',
    EACCES: 'Permission denied',
    EBUSY: 'Device or resource busy',
    EEXIST: 'File exists',
    EXDEV: 'Invalid cross-device link',
    ENOTDIR: 'Not a directory',
    EISDIR: 'Is a directory',
    EINVAL: 'Invalid argument',
    ENOSPC: 'No space left on device',
    EROFS: 'Read-only file system',
    ENAMETOOLONG: 'File name too long',
    ENOTEMPTY: 'Directory not empty',
    ENOTSUP: 'Operation not supported',
};

/** Linux errno numbers, for errors raised here rather than by ZenFS. */
const ERRNO: Record<string, number> = {
    EPERM: 1,
    ENOENT: 2,
    EIO: 5,
    EBADF: 9,
    EACCES: 13,
    EBUSY: 16,
    EEXIST: 17,
    EXDEV: 18,
    ENOTDIR: 20,
    EISDIR: 21,
    EINVAL: 22,
    ENOSPC: 28,
    EROFS: 30,
    ENAMETOOLONG: 36,
    ENOTEMPTY: 39,
    ENOTSUP: 95,
};

export type FsErrorCode = keyof typeof ERRNO & string;

/** An error thrown by ProfileVFS's own checks, shaped like ZenFS's. */
export class FsError extends Error {
    readonly errno: number;
    constructor(readonly code: FsErrorCode, readonly path?: string) {
        super(`${code}: ${STRERROR[code]}${path ? `, '${path}'` : ''}`);
        this.errno = ERRNO[code];
    }
}

export interface FsErrorDescription {
    /** The `strerror` text, or the error's own message when it has no errno code. */
    message: string;
    /** The errno number, when the error carries one. */
    errno?: number;
}

/** Reduce anything thrown by the VFS to `strerror` text and an errno. */
export function describeFsError(e: unknown): FsErrorDescription {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && code in STRERROR) {
        const raw = (e as { errno?: unknown }).errno;
        return { message: STRERROR[code], errno: typeof raw === 'number' ? raw : ERRNO[code] };
    }
    return { message: e instanceof Error ? e.message : String(e) };
}
