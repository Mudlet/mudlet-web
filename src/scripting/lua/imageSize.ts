import { isSvgCandidate } from '../../ui/labels/backgroundImageSize';

// Synchronous image-dimension parser for Mudlet's getImageSize(path). The
// browser's natural way to read image dimensions (new Image()) is async, which
// can't satisfy Mudlet's synchronous `local w, h = getImageSize(path)` shape.
// Instead we read the dimensions straight out of the file header — every common
// raster format encodes width/height in a fixed-offset header, so no decode is
// needed. Returns null for formats we don't recognise or truncated data.
export function parseImageSize(b: Uint8Array): { width: number; height: number } | null {
    if (b.length < 24) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    // PNG — 8-byte signature, then IHDR with width/height as big-endian uint32.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }

    // GIF — "GIF87a"/"GIF89a", logical screen width/height little-endian uint16.
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    }

    // BMP — "BM", then the DIB header carries width (offset 18) / height (22).
    if (b[0] === 0x42 && b[1] === 0x4d) {
        return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
    }

    // WebP — "RIFF"…"WEBP" then a VP8 / VP8L / VP8X chunk.
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (fmt === 'VP8 ' && b.length >= 30) {
            return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
        }
        if (fmt === 'VP8L' && b.length >= 25) {
            const bits = dv.getUint32(21, true);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (fmt === 'VP8X' && b.length >= 30) {
            const width = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
            const height = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
            return { width, height };
        }
    }

    // JPEG — scan for a Start-Of-Frame (SOFn) marker; it holds height then width.
    if (b[0] === 0xff && b[1] === 0xd8) {
        let off = 2;
        while (off + 9 <= b.length) {
            if (b[off] !== 0xff) { off++; continue; }
            const marker = b[off + 1];
            // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { width: dv.getUint16(off + 7), height: dv.getUint16(off + 5) };
            }
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
                off += 2; // markers with no length payload
                continue;
            }
            off += 2 + dv.getUint16(off + 2);
        }
    }

    return null;
}

/**
 * Whether `bytes` hold something a QPixmap or QSvgRenderer would load, judged
 * by content the way Qt's image readers are: a recognised raster header, an
 * ICO/CUR or TIFF signature, or an SVG candidate (markup or gzip). A missing
 * file, a text file, or an empty one is not an image.
 */
export function looksLikeImage(b: Uint8Array): boolean {
    if (b.length < 4) return false;
    if (parseImageSize(b) !== null) return true;
    // ICO / CUR — reserved 0, then type 1 (icon) or 2 (cursor).
    if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return true;
    // TIFF — "II*\0" or "MM\0*".
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0)
        || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return true;
    return isSvgCandidate(b);
}
