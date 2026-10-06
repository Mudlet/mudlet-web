import { Buffer } from 'buffer';
import { zlibSync } from 'fflate';
import type { MudletLabel, MudletMap } from 'mudlet-map-binary-reader';

/**
 * The image a text map label carries, drawn the way TMap::createMapLabel draws
 * it. Desktop renders the label once, at creation, into a pixmap — background
 * fill, a one-pixel outline made of four offset copies of the text when the
 * outline colour differs from the foreground, then the text — crops it to the
 * text's bounding rectangle, and stores that pixmap in the map file. Its 2D map
 * paints labels from the pixmap alone, so a label saved without one opens blank
 * on desktop.
 */

export interface LabelPixmapInput {
    text: string;
    /** Point size, as passed to createMapLabel. */
    fontSize: number;
    /** Font family; empty means the default face. */
    fontName?: string;
    fg: { r: number; g: number; b: number; a: number };
    bg: { r: number; g: number; b: number; a: number };
    outline: { r: number; g: number; b: number; a: number };
}

export interface LabelPixmap {
    /** The PNG, base64-encoded — how MapStore holds every label pixmap. */
    base64: string;
    /** The pixmap's size in pixels — desktop's label box before the zoom divide. */
    width: number;
    height: number;
}

// Qt measures point sizes at the screen's logical DPI; 96 is the X11/Windows
// default and what desktop runs at unless told otherwise.
const PX_PER_POINT = 96 / 72;

const css = (c: { r: number; g: number; b: number; a: number }) =>
    `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(255, c.a)) / 255})`;

/**
 * Render a label's pixmap, or null when there is no canvas to draw with (a
 * worker, a test DOM) — the label then keeps an empty pixmap, as before.
 */
export function renderLabelPixmap(input: LabelPixmapInput): LabelPixmap | null {
    if (typeof document === 'undefined') return null;
    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null;
    try {
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d');
    } catch { return null; }
    if (!ctx || typeof ctx.measureText !== 'function') return null;

    const px = Math.max(1, input.fontSize * PX_PER_POINT);
    const family = input.fontName ? `"${input.fontName.replace(/["\\]/g, '')}", sans-serif` : 'sans-serif';
    const font = `${px}px ${family}`;
    ctx.font = font;
    const lines = input.text.split('\n');
    const metrics = ctx.measureText('Mg');
    const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || px * 0.8;
    const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || px * 0.2;
    const lineHeight = Math.ceil(ascent + descent);
    const width = Math.max(1, Math.ceil(Math.max(...lines.map(l => ctx!.measureText(l).width))));
    const height = Math.max(1, lineHeight * lines.length);

    // Resizing a canvas resets its state, so the font is set again after.
    canvas.width = width;
    canvas.height = height;
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = css(input.bg);
    ctx.fillRect(0, 0, width, height);
    const draw = (dx: number, dy: number) => {
        lines.forEach((line, i) => ctx!.fillText(line, dx, dy + i * lineHeight + ascent));
    };
    const { fg, outline } = input;
    if (fg.r !== outline.r || fg.g !== outline.g || fg.b !== outline.b || fg.a !== outline.a) {
        ctx.fillStyle = css(outline);
        draw(-1, 0); draw(1, 0); draw(0, -1); draw(0, 1);
    }
    ctx.fillStyle = css(fg);
    draw(0, 0);

    let url: string;
    try { url = canvas.toDataURL('image/png'); } catch { return null; }
    const comma = url.indexOf(',');
    if (!url.startsWith('data:image/png') || comma < 0) return null;
    return { base64: url.slice(comma + 1), width, height };
}

/**
 * The map with every label pixmap as raw bytes, which is what
 * `writeMapToBuffer` needs. MapStore holds pixmaps as base64 strings (cheap to
 * clone and to JSON); handed one, the writer emits the string's characters in
 * place of the PNG and the file no longer reads back — in Mudlet or here.
 * Labels are copied, never changed in place, so the store keeps its strings.
 *
 * A string that is not a base64 PNG (a pixmap from a map written before image
 * labels carried their image, which kept the file's path there) is written as no image: decoded, it would be junk bytes the
 * reader cannot find the end of, and every record after it would misparse.
 */
export function withLabelPixmapBytes(map: MudletMap): MudletMap {
    const labels: Record<number, MudletLabel[]> = {};
    for (const [areaId, arr] of Object.entries(map.labels ?? {})) {
        labels[Number(areaId)] = arr.map(label => {
            if (typeof label.pixMap !== 'string') return label;
            const bytes = Buffer.from(label.pixMap, 'base64');
            return { ...label, pixMap: isPng(bytes) ? bytes : '' };
        });
    }
    return { ...map, labels };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (b: Uint8Array) => b.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((v, i) => b[i] === v);

/** TMap.cpp's cMaxImageLabelPixels: the most pixels an image label's pixmap
 *  may hold, so a huge label (or zoom) cannot ask for gigabytes of image. */
const MAX_IMAGE_LABEL_PIXELS = 4096 * 4096;

/** Desktop's image-label pixmap size: the label's map size times the zoom it
 *  was made at, shrunk to MAX_IMAGE_LABEL_PIXELS keeping its aspect ratio
 *  when it is over that (TMap::createMapImageLabel), and rounded as
 *  QSizeF::toSize does. */
function imageLabelSize(width: number, height: number, zoom: number): { w: number; h: number } {
    let w = width * zoom;
    let h = height * zoom;
    const pixels = w * h;
    if (Number.isFinite(pixels) && pixels > MAX_IMAGE_LABEL_PIXELS) {
        const scale = Math.sqrt(MAX_IMAGE_LABEL_PIXELS / pixels);
        w *= scale;
        h *= scale;
    }
    return { w: Math.round(w), h: Math.round(h) };
}

/**
 * The pixmap an image label is created with, the way TMap::createMapImageLabel
 * makes it: a transparent `width * zoom` by `height * zoom` pixmap with the image
 * painted over it, kept as a base64 PNG — so getMapLabel, the map file and
 * saveJsonMap carry the picture and never the path.
 *
 * Built synchronously, since createMapImageLabel answers at once:
 *  - a PNG file is that data already and is kept as it is;
 *  - an XPM (text, so a script can write one) is read and scaled here;
 *  - a missing or empty file is the bare transparent pixmap, as on desktop.
 * Any other format needs the browser to decode it, which is asynchronous:
 * `pending` then resolves to the finished pixmap (null where there is no canvas
 * to draw with), and until it does the label holds the transparent one.
 */
export function imageLabelPixmap(
    bytes: Uint8Array | null, width: number, height: number, zoom: number,
): { pixmap: string; pending?: Promise<string | null> } {
    if (bytes && isPng(bytes)) return { pixmap: Buffer.from(bytes).toString('base64') };
    const { w, h } = imageLabelSize(width, height, zoom);
    // A null QPixmap: nothing to draw into, and nothing written for it.
    if (!(w >= 1 && h >= 1)) return { pixmap: '' };
    const xpm = bytes ? readXpm(bytes) : null;
    if (xpm) return { pixmap: encodePngBase64(scaleRgba(xpm, w, h), w, h) };
    const blank = encodePngBase64(new Uint8Array(w * h * 4), w, h);
    if (!bytes || bytes.length === 0) return { pixmap: blank };
    return { pixmap: blank, pending: decodeImageLabelPixmap(bytes, w, h) };
}

/** Draw an image the browser decodes onto a `w` by `h` canvas, as a base64
 *  PNG; null when there is no canvas, or when the bytes are not an image the
 *  browser reads (the transparent pixmap then stands, as on desktop). */
async function decodeImageLabelPixmap(bytes: Uint8Array, w: number, h: number): Promise<string | null> {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
    try {
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
        const url = canvas.toDataURL('image/png');
        const comma = url.indexOf(',');
        return url.startsWith('data:image/png') && comma >= 0 ? url.slice(comma + 1) : null;
    } catch { return null; }
}

interface Rgba { width: number; height: number; data: Uint8Array }

/** Nearest-neighbour scale, as QPixmap::scaled does by default (Qt::FastTransformation). */
function scaleRgba(src: Rgba, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const sy = Math.min(src.height - 1, Math.floor(y * src.height / h));
        for (let x = 0; x < w; x++) {
            const sx = Math.min(src.width - 1, Math.floor(x * src.width / w));
            const from = (sy * src.width + sx) * 4;
            out.set(src.data.subarray(from, from + 4), (y * w + x) * 4);
        }
    }
    return out;
}

const XPM_NAMED: Record<string, [number, number, number]> = {
    black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 255, 0],
    blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
    gray: [190, 190, 190], grey: [190, 190, 190],
};

/** An XPM color: `None`, `#rgb`…`#rrrrggggbbbb`, or one of the common X11
 *  names. Null for anything else. */
function xpmColor(spec: string): [number, number, number, number] | null {
    if (/^none$/i.test(spec)) return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]+)$/i.exec(spec)?.[1];
    if (hex && hex.length % 3 === 0 && hex.length <= 12) {
        const n = hex.length / 3;
        const part = (i: number) => {
            const v = parseInt(hex.slice(i * n, i * n + n), 16);
            return Math.round(v * 255 / (16 ** n - 1));
        };
        return [part(0), part(1), part(2), 255];
    }
    const named = XPM_NAMED[spec.toLowerCase()];
    return named ? [...named, 255] : null;
}

/** An XPM (version 3) image as RGBA, or null when the bytes are not one. */
export function readXpm(bytes: Uint8Array): Rgba | null {
    const head = Buffer.from(bytes.subarray(0, 9)).toString('latin1');
    if (head !== '/* XPM */') return null;
    const strings = [...Buffer.from(bytes).toString('latin1').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
    const values = strings[0]?.trim().split(/\s+/).map(Number);
    if (!values || values.length < 4 || values.slice(0, 4).some(v => !Number.isInteger(v) || v <= 0)) return null;
    const [width, height, ncolors, cpp] = values;
    if (strings.length < 1 + ncolors + height || width * height > 1 << 24) return null;
    const palette = new Map<string, [number, number, number, number]>();
    for (let i = 1; i <= ncolors; i++) {
        const line = strings[i];
        const key = line.slice(0, cpp);
        const words = line.slice(cpp).trim().split(/\s+/);
        // Visual-class keys (c, m, g4, g, s) each followed by a colour; the
        // colour visual is preferred, as Qt does.
        let chosen: string | undefined;
        for (let k = 0; k + 1 < words.length; k += 2) {
            if (words[k] === 'c') { chosen = words[k + 1]; break; }
            if (chosen === undefined && words[k] !== 's') chosen = words[k + 1];
        }
        const color = chosen === undefined ? null : xpmColor(chosen);
        if (!color) return null;
        palette.set(key, color);
    }
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = strings[1 + ncolors + y];
        if (row.length < width * cpp) return null;
        for (let x = 0; x < width; x++) {
            const color = palette.get(row.slice(x * cpp, x * cpp + cpp));
            if (!color) return null;
            data.set(color, (y * width + x) * 4);
        }
    }
    return { width, height, data };
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** RGBA pixels as a base64 PNG, encoded synchronously — what a pixmap has to
 *  be before a label can hold it, without waiting on a canvas. */
export function encodePngBase64(rgba: Uint8Array, width: number, height: number): string {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
        return out;
    };
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
    const parts = [
        Uint8Array.from(PNG_SIGNATURE),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlibSync(raw)),
        chunk('IEND', new Uint8Array(0)),
    ];
    return Buffer.concat(parts).toString('base64');
}
