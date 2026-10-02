import { Buffer } from 'buffer';
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
 * A string that is not a base64 PNG — createMapImageLabel keeps the image's
 * path there — is written as no image: decoded, it would be junk bytes the
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
const isPng = (b: Uint8Array) => b.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((v, i) => b[i] === v);
