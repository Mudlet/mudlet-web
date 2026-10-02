import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderLabelPixmap } from '../../src/map/labelPixmap';
import { MapStore } from '../../src/map/MapStore';

// Issue #285 item 4: desktop's createMapLabel draws the label into a pixmap,
// and that pixmap is what the map file carries and what desktop's mapper
// paints. A label created here used to be saved with none.

interface Call { op: string; args: unknown[]; fillStyle?: string }

function fakeCanvas(textWidth = 100) {
    const calls: Call[] = [];
    const ctx = {
        font: '',
        fillStyle: '',
        textBaseline: '',
        measureText: (s: string) => ({
            width: s === 'Mg' ? 10 : textWidth,
            fontBoundingBoxAscent: 16,
            fontBoundingBoxDescent: 4,
        }),
        fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args, fillStyle: ctx.fillStyle }),
        fillText: (...args: unknown[]) => calls.push({ op: 'fillText', args, fillStyle: ctx.fillStyle }),
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
    };
    return { canvas, ctx, calls };
}

function installCanvas(fake: ReturnType<typeof fakeCanvas>) {
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
        tag === 'canvas' ? fake.canvas : real(tag)) as typeof document.createElement);
}

afterEach(() => { vi.restoreAllMocks(); });

const white = { r: 255, g: 255, b: 255, a: 255 };
const clear = { r: 0, g: 0, b: 0, a: 50 };

describe('renderLabelPixmap', () => {
    it('fills the background, then draws the text, cropped to the text box', () => {
        const fake = fakeCanvas(100);
        installCanvas(fake);
        const out = renderLabelPixmap({ text: 'Hello', fontSize: 12, fg: white, bg: clear, outline: white });
        expect(out).toEqual({ base64: 'iVBORw0KGgo=', width: 100, height: 20 });
        expect(fake.canvas.width).toBe(100);
        expect(fake.canvas.height).toBe(20);
        // 12pt at 96 dpi.
        expect(fake.ctx.font).toBe('16px sans-serif');
        expect(fake.calls.map(c => c.op)).toEqual(['fillRect', 'fillText']);
        expect(fake.calls[0].fillStyle).toBe('rgba(0, 0, 0, 0.19607843137254902)');
    });

    it('draws four offset outline copies first when the outline differs', () => {
        const fake = fakeCanvas();
        installCanvas(fake);
        renderLabelPixmap({ text: 'X', fontSize: 12, fg: white, bg: clear, outline: { r: 255, g: 0, b: 0, a: 255 } });
        const texts = fake.calls.filter(c => c.op === 'fillText');
        expect(texts).toHaveLength(5);
        expect(texts.slice(0, 4).every(c => c.fillStyle === 'rgba(255, 0, 0, 1)')).toBe(true);
        expect(texts[4].fillStyle).toBe('rgba(255, 255, 255, 1)');
    });

    it('returns null when no 2D canvas is available', () => {
        vi.spyOn(document, 'createElement').mockImplementation((() => ({ getContext: () => null })) as unknown as typeof document.createElement);
        expect(renderLabelPixmap({ text: 'X', fontSize: 12, fg: white, bg: clear, outline: white })).toBeNull();
    });
});

describe('createMapLabel', () => {
    it('stores the rendered pixmap and sizes the label from it, as desktop does', () => {
        installCanvas(fakeCanvas(90));
        const store = new MapStore();
        store.newEmptyMap();
        const a = store.addAreaName('A') as number;
        const id = store.createMapLabel(a, 'Label A', 1, 1, 0, 255, 0, 0, 0, 0, 0, { zoom: 30, fontSize: 12 });
        const info = store.getMapLabel(a, id);
        expect(info.ok && 'single' in info && info.single.Pixmap).toBe('iVBORw0KGgo=');
        expect(info.ok && 'single' in info && [info.single.Width, info.single.Height]).toEqual([3, 20 / 30]);
    });
});
