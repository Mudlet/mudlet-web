import { describe, it, expect, afterEach } from 'vitest';
import { codePointWidth, stringWidth, setAmbiguousWidthWide, isAmbiguousWidthWide } from '../../src/mud/text/wcwidth';

// Module state — restore it so a leaked `true` cannot widen every other suite.
afterEach(() => setAmbiguousWidthWide(false));

const cp = (ch: string) => ch.codePointAt(0)!;

describe('ambiguous East Asian width', () => {
    it('is narrow by default, which is the Western terminal rendering', () => {
        expect(isAmbiguousWidthWide()).toBe(false);
        expect(codePointWidth(cp('★'))).toBe(1);
        expect(codePointWidth(cp('│'))).toBe(1);
        expect(codePointWidth(cp('α'))).toBe(1);
    });

    it('renders the ambiguous set two cells wide once turned on', () => {
        setAmbiguousWidthWide(true);
        expect(codePointWidth(cp('★'))).toBe(2); // dingbat
        expect(codePointWidth(cp('│'))).toBe(2); // box drawing
        expect(codePointWidth(cp('█'))).toBe(2); // block element
        expect(codePointWidth(cp('α'))).toBe(2); // Greek
        expect(codePointWidth(cp('Ж'))).toBe(2); // Cyrillic
        expect(codePointWidth(cp('①'))).toBe(2); // enclosed alphanumeric
    });

    it('leaves plain ASCII alone either way', () => {
        for (const wide of [false, true]) {
            setAmbiguousWidthWide(wide);
            expect(stringWidth('hello world')).toBe(11);
            expect(codePointWidth(cp('A'))).toBe(1);
            expect(codePointWidth(cp('~'))).toBe(1);
        }
    });

    it('leaves unambiguously wide and zero-width characters alone', () => {
        for (const wide of [false, true]) {
            setAmbiguousWidthWide(wide);
            expect(codePointWidth(cp('漢'))).toBe(2); // always wide
            expect(codePointWidth(0x0301)).toBe(0);   // combining acute
        }
    });

    it('changes the measured width of a box-drawn frame', () => {
        const frame = '┌────┐';
        setAmbiguousWidthWide(false);
        expect(stringWidth(frame)).toBe(6);
        setAmbiguousWidthWide(true);
        expect(stringWidth(frame)).toBe(12);
    });
});
