import { describe, it, expect } from 'vitest';
import { LabelManager } from '../../src/ui/labels/LabelManager';
import { isSvgCandidate, svgIntrinsicSizeFromBytes } from '../../src/ui/labels/backgroundImageSize';
import { parseQColor } from '../../src/ui/labels/qColor';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('isSvgCandidate — TLabel::svgCandidate', () => {
    it('reads a document by its content, past a byte order mark and whitespace', () => {
        expect(isSvgCandidate(bytes('  \n<svg/>'))).toBe(true);
        expect(isSvgCandidate(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]))).toBe(true);
        expect(isSvgCandidate(new Uint8Array([0xff, 0xfe, 0x20, 0x00, 0x3c, 0x00]))).toBe(true);
        expect(isSvgCandidate(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
    });

    it('turns a raster away whatever it is called', () => {
        expect(isSvgCandidate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
        expect(isSvgCandidate(bytes('GIF89a'))).toBe(false);
    });
});

describe('svgIntrinsicSizeFromBytes', () => {
    it('answers the document size synchronously', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"/>';
        expect(svgIntrinsicSizeFromBytes(bytes(svg))).toEqual({ width: 10, height: 10 });
    });

    it('has nothing to say about a raster', () => {
        expect(svgIntrinsicSizeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    });
});

describe('parseQColor — QColor(QString)', () => {
    it('takes the hex forms Qt does, alpha first in the eight-digit one', () => {
        expect(parseQColor('#f00')).toEqual([255, 0, 0]);
        expect(parseQColor('#00ff00')).toEqual([0, 255, 0]);
        expect(parseQColor('#800000ff')).toEqual([0, 0, 255]);
        expect(parseQColor('#fff000000')).toEqual([255, 0, 0]);
        expect(parseQColor('#ffff00000000')).toEqual([255, 0, 0]);
    });

    it('takes SVG colour names in any case', () => {
        expect(parseQColor('aliceblue')).toEqual([240, 248, 255]);
        expect(parseQColor('AliceBlue')).toEqual([240, 248, 255]);
    });

    it('refuses what QColor calls invalid, including CSS-only forms', () => {
        expect(parseQColor('#ff')).toBeNull();
        expect(parseQColor('notacolor')).toBeNull();
        expect(parseQColor('rgb(1, 2, 3)')).toBeNull();
        expect(parseQColor('alice_blue')).toBeNull();
    });
});

describe('LabelManager SVG tint and transforms', () => {
    const make = () => {
        const m = new LabelManager();
        m.create('sigil', { x: 0, y: 0, width: 48, height: 48, fillBackground: false });
        return m;
    };
    const state = (m: LabelManager) => m.list('main').find(l => l.name === 'sigil')!;

    it('keeps them on the label across a reset and a new image', () => {
        const m = make();
        expect(m.setSvgTint('sigil', 'rgb(0, 0, 255)')).toBe(true);
        expect(m.setSvgRotation('sigil', 45)).toBe(true);
        m.setBackgroundImage('sigil', 'vfs://a.svg', true, { width: 10, height: 10 });
        m.resetBackgroundImage('sigil');
        m.setBackgroundImage('sigil', 'vfs://b.svg', true, { width: 10, height: 10 });
        expect(state(m)).toMatchObject({ svgTint: 'rgb(0, 0, 255)', svgRotation: 45 });
    });

    it('resetSvgTransform clears the rotation and shear but leaves the tint', () => {
        const m = make();
        m.setSvgTint('sigil', 'red');
        m.setSvgRotation('sigil', 30);
        m.setSvgShear('sigil', 0.3, 0.1);
        expect(m.resetSvgTransform('sigil')).toBe(true);
        const s = state(m);
        expect([s.svgTint, s.svgRotation, s.svgShearX, s.svgShearY]).toEqual(['red', undefined, undefined, undefined]);
    });

    it('answers false for a label that is not there', () => {
        const m = make();
        expect(m.setSvgTint('missing', 'red')).toBe(false);
        expect(m.resetSvgTransform('missing')).toBe(false);
    });

    it('hints a label showing only an SVG at the document size', () => {
        const m = make();
        m.setBackgroundImage('sigil', 'vfs://a.svg', true, { width: 10, height: 12 });
        m.setHtml('sigil', '<div></div>');
        expect(m.getSizeHint('sigil')).toEqual({ width: 10, height: 12 });
    });
});
