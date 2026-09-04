// Right-click "Select all / Copy / Copy as HTML / Copy as image" for output
// windows. Works against any output container (the main console or a script
// TextPanel) — every rendered line is a `.output-msg` wrapper carrying its
// AnsiAwareBuffer in the shared `elementBuffers` WeakMap, so we can recover the
// styled buffers for the lines a selection touches and re-serialise them.

import type { AnsiAwareBuffer } from '../../mud/text/FormatState';
import { getBrand } from '../../branding';
import { CLIENT_VERSION } from '../../version';
import { SEARCH_ENGINES, resolveSearchEngine } from '../../storage/schema';
import { elementBuffers } from './OutputRenderer';

/** Resolved console styling read from a live output container. */
interface ConsoleStyle {
    background: string;
    color: string;
    fontFamily: string;
    fontSize: number;
}

function readConsoleStyle(container: HTMLElement): ConsoleStyle {
    const cs = getComputedStyle(container);
    const consoleBg = cs.getPropertyValue('--console-bg').trim();
    const consoleText = cs.getPropertyValue('--console-text').trim();
    const bg = cs.backgroundColor;
    const opaque = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    return {
        background: (opaque ? bg : consoleBg) || '#1a1a1a',
        color: cs.color || consoleText || '#c0c0c0',
        fontFamily: cs.fontFamily || 'monospace',
        fontSize: parseFloat(cs.fontSize) || 14,
    };
}

/** True when the current selection touches any line inside `container`. */
export function hasSelectionIn(container: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    return range.intersectsNode(container);
}

interface SelectedLine {
    buffer: AnsiAwareBuffer;
    /** Visible timestamp text for this line, or null when timestamps are hidden.
     *  The timestamp lives in a `user-select: none` span so it never lands in the
     *  native selection — copy-as-HTML/image re-add it here when it's shown. */
    timestamp: string | null;
}

/** The rendered lines `keep` accepts, in document order, each with its
 *  timestamp (when the timestamp column is currently visible). */
function collectLines(container: HTMLElement, keep: (el: Element) => boolean): SelectedLine[] {
    const out: SelectedLine[] = [];
    const showTimestamps = container.classList.contains('output-show-timestamps');
    container.querySelectorAll('.output-msg').forEach(el => {
        if (!keep(el)) return;
        const buffer = elementBuffers.get(el);
        if (!buffer) return;
        const timestamp = showTimestamps
            ? (el.querySelector('.output-timestamp')?.textContent || null)
            : null;
        out.push({ buffer, timestamp });
    });
    return out;
}

/** Every line whose element the selection intersects. */
function selectedLines(container: HTMLElement): SelectedLine[] {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    return collectLines(container, el => range.intersectsNode(el));
}

/** Every line currently on screen. `.output-wrapper` is itself the scroller, so
 *  its own box is the viewport to test each row against. */
function visibleLines(container: HTMLElement): SelectedLine[] {
    const view = container.getBoundingClientRect();
    return collectLines(container, el => {
        const r = el.getBoundingClientRect();
        return r.bottom > view.top && r.top < view.bottom;
    });
}

/** True when this console holds any line at all — what separates "nothing is
 *  selected" from "there is nothing here to copy". */
export function hasCopyableLines(container: HTMLElement): boolean {
    for (const el of container.querySelectorAll('.output-msg')) {
        if (elementBuffers.get(el)) return true;
    }
    return false;
}

/** Open a web search for the selected text, the way Mudlet's
 *  `TTextEdit::searchSelectionOnline` does. `engine` is a {@link SEARCH_ENGINES}
 *  key; an unknown one falls back to the default engine. */
export function searchSelectionOnline(engine: string | undefined): void {
    // Desktop joins the selected lines with spaces rather than newlines
    // (`getSelectedText(QChar::Space)`), which is what a search box wants.
    const text = (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const prefix = SEARCH_ENGINES[resolveSearchEngine(engine)];
    window.open(prefix + encodeURIComponent(text), '_blank', 'noopener,noreferrer');
}

/** The console's dim timestamp colour, read from a live timestamp element. */
function timestampColor(container: HTMLElement, fallback: string): string {
    const el = container.querySelector('.output-timestamp');
    return (el && getComputedStyle(el).color) || fallback;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Select every line in the container (Range over its contents). */
export function selectAll(container: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(container);
    sel.removeAllRanges();
    sel.addRange(range);
}

/** Copy the native selection text verbatim (character-precise). */
export async function copySelectionText(): Promise<void> {
    const text = window.getSelection()?.toString() ?? '';
    if (text) await navigator.clipboard.writeText(text);
}

/** Build a complete, self-contained HTML document for `selected`. Reuses each
 *  buffer's `toHtml()` so colours/links match the on-screen rendering, and
 *  carries the console `--console-*` vars so reverse-video spans resolve in the
 *  standalone document. */
function buildSelectionHtmlDoc(
    container: HTMLElement,
    selected: SelectedLine[],
    sourceName: string | undefined,
): string | null {
    if (selected.length === 0) return null;
    const style = readConsoleStyle(container);
    const cs = getComputedStyle(container);
    const consoleBg = cs.getPropertyValue('--console-bg').trim() || style.background;
    const consoleText = cs.getPropertyValue('--console-text').trim() || style.color;
    const tsColor = timestampColor(container, '#888888');

    // Desktop titles the document "Mudlet, main console extract from <profile>"
    // (`TTextEdit::slot_copySelectionToClipboardHTML`); do the same, but let a
    // white-label build name itself.
    const brandName = getBrand().appName;
    const docTitle = sourceName
        ? `${brandName}, console extract from ${sourceName}`
        : `${brandName} console extract`;

    const lines = selected
        .map(({ buffer, timestamp }) => {
            const ts = timestamp
                ? `<span class="ts">${escapeHtml(timestamp)} </span>`
                : '';
            return `<div class="line">${ts}${buffer.toHtml() || '&nbsp;'}</div>`;
        })
        .join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(docTitle)}</title>
<meta name="generator" content="${escapeHtml(`${brandName} version: ${CLIENT_VERSION}`)}">
<style>
  :root { --console-bg: ${consoleBg}; --console-text: ${consoleText}; }
  body { margin: 0; padding: 12px 16px;
    background: ${style.background}; color: ${style.color};
    font-family: ${style.fontFamily}; font-size: ${style.fontSize}px; line-height: 1.4; }
  .line { white-space: pre-wrap; word-break: break-word; }
  .ts { color: ${tsColor}; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
${lines}
</body>
</html>`;
}

/**
 * Copy the selected lines as a complete, self-contained HTML document. The full
 * document source goes on the clipboard as both `text/html` (so rich targets
 * paste it rendered) and `text/plain` (so plain targets paste the HTML markup
 * itself), with a `writeText` fallback for browsers without ClipboardItem.
 */
export async function copySelectionAsHtml(container: HTMLElement, sourceName?: string): Promise<void> {
    const html = buildSelectionHtmlDoc(container, selectedLines(container), sourceName);
    if (html === null) return;

    const ClipboardItemCtor = (window as Window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (navigator.clipboard?.write && typeof ClipboardItemCtor !== 'undefined') {
        await navigator.clipboard.write([
            new ClipboardItemCtor({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([html], { type: 'text/plain' }),
            }),
        ]);
    } else {
        await navigator.clipboard.writeText(html);
    }
}

/** Render `selected` to a canvas matching the console's look. */
function linesToCanvas(container: HTMLElement, selected: SelectedLine[]): HTMLCanvasElement | null {
    if (selected.length === 0) return null;
    const style = readConsoleStyle(container);
    const { background, color, fontFamily, fontSize } = style;
    const tsColor = timestampColor(container, '#888888');

    const lineHeight = 1.4;
    const padding = 10;
    const scale = Math.min(window.devicePixelRatio || 1, 2) * 2;
    const fontFor = (bold: boolean, italic: boolean) =>
        `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
    // Reverse-video on default colours hands back CSS vars; resolve to the
    // opposite-role console default for the canvas.
    const resolve = (c: string | undefined, role: 'fg' | 'bg'): string => {
        if (!c) return role === 'fg' ? color : background;
        if (c === 'var(--console-bg)') return background;
        if (c === 'var(--console-text)') return color;
        return c;
    };

    // Each buffer is one logical line; split defensively on any embedded
    // newline, and prepend the timestamp (when shown) to the line's first row.
    const lines = selected.map(({ buffer, timestamp }) => {
        const runs = buffer.toStyledRuns();
        const rows: typeof runs[] = [[]];
        if (timestamp) rows[0].push({ text: `${timestamp} `, color: tsColor, bold: false, italic: false, underline: false });
        for (const run of runs) {
            const parts = run.text.split('\n');
            parts.forEach((p, i) => {
                if (i > 0) rows.push([]);
                if (p) rows[rows.length - 1].push({ ...run, text: p });
            });
        }
        return rows;
    }).flat();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let maxWidth = 0;
    for (const row of lines) {
        let w = 0;
        for (const run of row) { ctx.font = fontFor(run.bold, run.italic); w += ctx.measureText(run.text).width; }
        maxWidth = Math.max(maxWidth, w);
    }

    const lineHeightPx = fontSize * lineHeight;
    const width = Math.max(48, Math.ceil(maxWidth) + padding * 2);
    const height = Math.ceil(padding * 2 + lines.length * lineHeightPx);
    canvas.width = width * scale;
    canvas.height = height * scale;
    ctx.scale(scale, scale);

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = 'top';

    for (let i = 0; i < lines.length; i++) {
        const y = padding + i * lineHeightPx + (lineHeightPx - fontSize) / 2;
        let x = padding;
        for (const run of lines[i]) {
            ctx.font = fontFor(run.bold, run.italic);
            const w = ctx.measureText(run.text).width;
            const bg = run.background ? resolve(run.background, 'bg') : undefined;
            if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, y - 1, w, fontSize + 2); }
            const fg = resolve(run.color, 'fg');
            ctx.fillStyle = fg;
            ctx.fillText(run.text, x, y);
            if (run.underline) {
                ctx.strokeStyle = fg;
                ctx.lineWidth = 1;
                const uy = Math.round(y + fontSize + 1) + 0.5;
                ctx.beginPath();
                ctx.moveTo(x, uy);
                ctx.lineTo(x + w, uy);
                ctx.stroke();
            }
            x += w;
        }
    }
    return canvas;
}

/** Copy the selection to the clipboard as a PNG image, falling back to a
 *  picture of the visible area when nothing is selected — unlike Copy and Copy
 *  as HTML, "as image" has an obvious default (Mudlet #9715). */
export async function copySelectionAsImage(container: HTMLElement): Promise<void> {
    const selected = selectedLines(container);
    const canvas = linesToCanvas(container, selected.length ? selected : visibleLines(container));
    if (!canvas) return;
    const ClipboardItemCtor = (window as Window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!navigator.clipboard?.write || typeof ClipboardItemCtor === 'undefined') {
        throw new Error('Copying images to the clipboard requires a secure (HTTPS) context');
    }
    // Build the Blob promise inside ClipboardItem so write() stays in the user
    // gesture (Safari requirement).
    await navigator.clipboard.write([
        new ClipboardItemCtor({
            'image/png': new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(b => b ? resolve(b) : reject(new Error('Failed to encode image')), 'image/png');
            }),
        }),
    ]);
}
