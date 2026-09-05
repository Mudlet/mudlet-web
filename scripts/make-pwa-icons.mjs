// Regenerate the raster PWA icons in public/ from the one master raster.
//
//   node scripts/make-pwa-icons.mjs
//
// The master is `public/icon-512.png` — Mudlet's own `mudlet.png` (the 512px
// export of `mudlet.svg`), vendored byte-for-byte, GPL-2.0-or-later, copyright
// the Mudlet contributors. It is also the `apple-touch-icon`, since Safari
// ignores the SVG favicon. Two files are derived from it:
//
//   icon-192.png           the same logo at 192px, on transparency
//   icon-maskable-512.png  the logo at 80% over the app background, so a
//                          launcher may crop it to whatever shape it likes
//                          without eating into the artwork (the raster twin of
//                          icon-maskable.svg, whose inset this copies exactly)
//
// The SVG icons stay in the manifest and are preferred where they are honoured;
// these exist because Android's install banner and several OS launchers only
// take PNGs with concrete `sizes`, and fall back to a screenshot of the page
// without them (issue #71).
//
// Written against Node's zlib alone rather than an image library: the input is
// one known file — 8-bit RGBA, non-interlaced — and a dependency added for a
// script that runs about once a decade is a dependency to keep patched forever.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PUBLIC = new URL('../public/', import.meta.url);
const path = (name) => fileURLToPath(new URL(name, PUBLIC));

/** The app background, matching manifest `background_color` and icon-maskable.svg. */
const MASK_BG = [0x09, 0x09, 0x09];
/** Fraction of a maskable icon guaranteed not to be cropped. */
const SAFE_ZONE = 0.8;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── PNG decode ────────────────────────────────────────────────────────────────

/** Decode an 8-bit RGBA, non-interlaced PNG to `{width, height, data}` with
 *  `data` as straight (non-premultiplied) RGBA bytes. Throws on anything else —
 *  this reads one vendored file, not the wild. */
function decodePng(buf) {
    if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');
    let width = 0, height = 0;
    const idat = [];
    for (let at = 8; at < buf.length;) {
        const len = buf.readUInt32BE(at);
        const type = buf.toString('ascii', at + 4, at + 8);
        const body = buf.subarray(at + 8, at + 8 + len);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
            if (depth !== 8 || color !== 6 || interlace !== 0) {
                throw new Error(`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})`);
            }
        } else if (type === 'IDAT') idat.push(body);
        else if (type === 'IEND') break;
        at += 12 + len;
    }
    return { width, height, data: unfilter(inflateSync(Buffer.concat(idat)), width, height) };
}

/** Undo the per-scanline filters PNG applies before compression (spec §9). */
function unfilter(raw, width, height) {
    const stride = width * 4;
    const out = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const type = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let x = 0; x < stride; x++) {
            const a = x >= 4 ? out[y * stride + x - 4] : 0;      // left
            const b = y > 0 ? out[(y - 1) * stride + x] : 0;     // up
            const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0; // up-left
            let v = line[x];
            if (type === 1) v += a;
            else if (type === 2) v += b;
            else if (type === 3) v += (a + b) >> 1;
            else if (type === 4) v += paeth(a, b, c);
            else if (type !== 0) throw new Error(`unknown filter ${type} on row ${y}`);
            out[y * stride + x] = v & 0xff;
        }
    }
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

// ── PNG encode ────────────────────────────────────────────────────────────────

function chunk(type, body) {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Encode straight RGBA bytes as an 8-bit RGBA PNG. Every scanline is written
 *  with filter 0 (none) and left to deflate — these are small, flat-coloured
 *  images, and picking filters per row would buy bytes nobody counts. */
function encodePng(width, height, data) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    return Buffer.concat([
        PNG_MAGIC,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── resampling ────────────────────────────────────────────────────────────────

/**
 * Box-filter downscale, averaging in premultiplied space so a transparent
 * neighbour can't drag colour into an opaque pixel's average (the halo you get
 * from averaging straight RGBA around an antialiased edge).
 */
function resize(src, size) {
    const out = Buffer.alloc(size * size * 4);
    const scale = src.width / size;
    for (let y = 0; y < size; y++) {
        const y0 = Math.floor(y * scale), y1 = Math.min(src.height, Math.ceil((y + 1) * scale));
        for (let x = 0; x < size; x++) {
            const x0 = Math.floor(x * scale), x1 = Math.min(src.width, Math.ceil((x + 1) * scale));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const i = (sy * src.width + sx) * 4;
                    const alpha = src.data[i + 3] / 255;
                    r += src.data[i] * alpha;
                    g += src.data[i + 1] * alpha;
                    b += src.data[i + 2] * alpha;
                    a += src.data[i + 3];
                    n++;
                }
            }
            const o = (y * size + x) * 4;
            const alpha = a / n;
            const un = alpha > 0 ? 255 / alpha : 0;
            out[o] = Math.round((r / n) * un);
            out[o + 1] = Math.round((g / n) * un);
            out[o + 2] = Math.round((b / n) * un);
            out[o + 3] = Math.round(alpha);
        }
    }
    return { width: size, height: size, data: out };
}

/** Source-over `logo` onto an opaque `bg` canvas of `size`, inset to the safe zone. */
function maskable(src, size) {
    const inner = Math.round(size * SAFE_ZONE);
    const logo = resize(src, inner);
    const offset = Math.round((size - inner) / 2);
    const out = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        out[i * 4] = MASK_BG[0];
        out[i * 4 + 1] = MASK_BG[1];
        out[i * 4 + 2] = MASK_BG[2];
        out[i * 4 + 3] = 255;
    }
    for (let y = 0; y < inner; y++) {
        for (let x = 0; x < inner; x++) {
            const i = (y * inner + x) * 4;
            const alpha = logo.data[i + 3] / 255;
            if (alpha === 0) continue;
            const o = ((y + offset) * size + (x + offset)) * 4;
            for (let c = 0; c < 3; c++) {
                out[o + c] = Math.round(logo.data[i + c] * alpha + out[o + c] * (1 - alpha));
            }
        }
    }
    return { width: size, height: size, data: out };
}

// ── run ───────────────────────────────────────────────────────────────────────

const master = decodePng(readFileSync(path('icon-512.png')));
if (master.width !== 512 || master.height !== 512) {
    throw new Error(`icon-512.png is ${master.width}x${master.height}, expected 512x512`);
}

for (const [name, image] of [
    ['icon-192.png', resize(master, 192)],
    ['icon-maskable-512.png', maskable(master, 512)],
]) {
    const png = encodePng(image.width, image.height, image.data);
    writeFileSync(path(name), png);
    console.log(`wrote public/${name} (${image.width}x${image.height}, ${png.length} bytes)`);
}
