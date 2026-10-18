import { strFromU8 } from 'fflate';

// Desktop keeps a profile's connection details (`encoding`, `ssl_tsl`, `login`,
// `password`, …) one per file, each a single `QString` serialised by
// `QDataStream` at `Qt_5_12` (`MudletApp::writeProfileData`/`readProfileData`):
// a big-endian uint32 byte length — 0xFFFFFFFF for a null string — then that
// many bytes of UTF-16BE. Read as plain text that is NULs and a length prefix
// around the value (issue #455).

const NULL_QSTRING = 0xffffffff;

/**
 * The string a desktop profile-data file holds. Bytes that are not a whole
 * serialised `QString` are read as UTF-8 text instead, so a file written by
 * hand (or by an older Mudlet Web export) still reads; such text cannot pass
 * as the binary form, whose first byte is always 0x00 or 0xFF for any length
 * a file this small can carry.
 */
export function decodeProfileData(bytes: Uint8Array): string {
    if (bytes.length >= 4) {
        const len = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
        if (len === NULL_QSTRING) {
            if (bytes.length === 4) return '';
        } else if (len % 2 === 0 && 4 + len === bytes.length) {
            let out = '';
            for (let i = 4; i < bytes.length; i += 2) {
                out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
            }
            return out;
        }
    }
    return strFromU8(bytes);
}

/** `text` as desktop's `writeProfileData` writes it, so desktop reads it back. */
export function encodeProfileData(text: string): Uint8Array {
    const len = text.length * 2;
    const out = new Uint8Array(4 + len);
    out[0] = (len >>> 24) & 0xff;
    out[1] = (len >>> 16) & 0xff;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[4 + i * 2] = c >>> 8;
        out[5 + i * 2] = c & 0xff;
    }
    return out;
}
