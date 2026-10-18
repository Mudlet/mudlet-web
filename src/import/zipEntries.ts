import { inflateSync, strFromU8 } from 'fflate';
import { crc32 } from '../map/labelPixmap';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';

/**
 * A zip archive read entry by entry, the way libzip hands it to brimworks'
 * lua-zip (what desktop's `zip` global is).
 *
 * fflate's `unzipSync` is all or nothing: one entry that will not inflate and
 * the whole archive throws, it never checks a CRC, and it keys entries by name,
 * so two with the same name collapse into one. Desktop's `unzip()` reports each
 * entry it cannot read and carries on with the rest, so it needs an archive it
 * can walk by index and read one entry of at a time.
 */
export interface ZipEntry {
    /** The name as stored (Latin-1 unless the entry flags UTF-8, as fflate reads it). */
    name: string;
    /** The uncompressed size the archive records. */
    size: number;
    /** The entry's bytes, or throws with the reason they cannot be had. */
    read(): Uint8Array;
}

/** The archive's entries in central-directory order, or null when the bytes
 *  are not a zip this can read. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] | null {
    const u16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
    const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
    let e = bytes.length - 22;
    while (e >= 0 && u32(e) !== 0x06054b50) {
        if (bytes.length - e > 65557) return null;
        e--;
    }
    if (e < 0) return null;
    const count = u16(e + 10);
    let offset = u32(e + 16);
    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (offset + 46 > bytes.length || u32(offset) !== 0x02014b50) return null;
        const flags = u16(offset + 8);
        const method = u16(offset + 10);
        const crc = u32(offset + 16);
        const compressedSize = u32(offset + 20);
        const size = u32(offset + 24);
        const nameLen = u16(offset + 28);
        const extraLen = u16(offset + 30);
        const commentLen = u16(offset + 32);
        const localOffset = u32(offset + 42);
        // Bit 11 marks a UTF-8 name; fflate reads any other as Latin-1.
        const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLen), !(flags & 0x800));
        entries.push({
            name,
            size,
            read: () => {
                if (flags & 1) throw new Error('Encryption method not supported');
                if (localOffset + 30 > bytes.length || u32(localOffset) !== 0x04034b50) throw new Error('Not a zip archive');
                const start = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
                const raw = bytes.subarray(start, start + compressedSize);
                let data: Uint8Array;
                if (method === 0) data = raw;
                else if (method === 8) {
                    try { data = inflateSync(raw, { out: new Uint8Array(size) }); }
                    catch { throw new Error('Zlib error'); }
                } else throw new Error('Compression method not supported');
                // libzip's ZIP_ER_CRC, which lua-zip reports from read().
                if (data.length !== size || crc32(data) !== crc) throw new Error('CRC error');
                return data;
            },
        });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * An entry name's path components inside the folder it unpacks into, with "."
 * and ".." resolved, or null when the name is absolute or climbs out of it.
 * Both separators count, as on Windows, which honours either: desktop's own
 * `unzip()` reads names the same way, so an archive is judged identically
 * whichever platform made it.
 */
export function zipEntryComponents(name: string): string[] | null {
    if (/^[/\\]/.test(name) || /^[A-Za-z]:/.test(name)) return null;
    const parts: string[] = [];
    for (const part of name.split(/[/\\]+/)) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (parts.length === 0) return null;
            parts.pop();
        } else parts.push(part);
    }
    return parts;
}

/** `path` with any symbolic links standing at it followed to what they name,
 *  so a folder reached through a link can be written into. Left as it is when
 *  it is not a link, or the chain is too long to be anything but a loop. */
export function resolveLinkedDirectory(vfs: ProfileVFS, path: string): string {
    let current = path;
    for (let hops = 0; hops < 40; hops++) {
        let target: string;
        try {
            if (vfs.lstat(current).type !== 'link') return current;
            target = vfs.readlink(current);
        } catch { return current; }
        const parent = current.substring(0, current.lastIndexOf('/')) || '/';
        current = (target.startsWith('/') ? target : `${parent}/${target}`).replace(/\/+$/, '');
    }
    return path;
}

/**
 * Why the archive's entries cannot all be unpacked into `destDir`, or null when
 * they can. Checked over every entry before anything is written, so a refused
 * archive leaves nothing of itself behind:
 *  - a name that resolves outside `destDir`;
 *  - a symbolic link already inside `destDir` that an entry would pass through
 *    or write over, which would carry it outside.
 * `destDir` itself may be reached through a link: that is where the caller
 * asked for the files to go.
 */
export function zipExtractionProblem(vfs: ProfileVFS, destDir: string, names: string[]): string | null {
    const base = destDir.replace(/\/+$/, '');
    const isLink = (path: string): boolean => {
        try { return vfs.lstat(path).type === 'link'; } catch { return false; }
    };
    for (const name of names) {
        const parts = zipEntryComponents(name);
        if (!parts) return `refusing to extract ${name} outside of ${destDir}`;
        let path = base;
        for (const part of parts) {
            path = `${path}/${part}`;
            if (isLink(path)) return `refusing to extract ${name} through the symbolic link ${path}`;
        }
    }
    return null;
}
