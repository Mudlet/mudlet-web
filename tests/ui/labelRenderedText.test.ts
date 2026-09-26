import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderedText, stripTagsNoDom } from '../../src/ui/labels/LabelManager';

// What renderedText's no-DOM fallback returned before it became a scanner —
// `html.replace(/<[^>]*>/g, '')` — kept here as the reference the scanner must
// reproduce exactly. Written as split/join, which gives the same string, so
// the reference itself is not read as a sanitizer.
const legacyStrip = (html: string): string => html.split(/<[^>]*>/).join('');

// What the DOM path renders the same markup to.
const domText = (html: string): string => {
    const probe = document.createElement('div');
    probe.innerHTML = html;
    return (probe.textContent ?? '').trim();
};

const noDom = (html: string): string => {
    vi.stubGlobal('document', undefined);
    try {
        return renderedText(html);
    } finally {
        vi.unstubAllGlobals();
    }
};

afterEach(() => vi.unstubAllGlobals());

// Markup whose emptiness the DOM and the no-DOM fallback agree on.
const CASES: Array<[string, boolean]> = [
    ['hello', false],
    ['  hello  ', false],
    ['<b>bold</b>', false],
    ['<div><span><i>deep</i></span></div>', false],
    ['<b>unclosed element', false],
    ['<div><span>', true],
    ['<scr<script>ipt>alert(1)</script>', false],
    ['<scr<script>ipt>', false],
    ['<<b>>', false],
    ['<div style="x"></div>', true],
    ['<center></center>', true],
    ['   <div>  \n\t </div>   ', true],
    ['<p> </p><br><p>\n</p>', true],
    ['<img src="a.png">', true],
    ['a < b', false],
    ['>', false],
    ['text>', false],
];

describe('renderedText — no-DOM fallback', () => {
    it('gives the same emptiness answer as the DOM path', () => {
        for (const [html, empty] of CASES) {
            expect(noDom(html) === '', `no-DOM: ${JSON.stringify(html)}`).toBe(empty);
            expect(domText(html) === '', `DOM: ${JSON.stringify(html)}`).toBe(empty);
            expect(renderedText(html) === '', `renderedText: ${JSON.stringify(html)}`).toBe(empty);
        }
    });

    it('reads plain text and strips nested tags', () => {
        expect(noDom('  plain  ')).toBe('plain');
        expect(noDom('<div><b>a</b><i>b</i></div>')).toBe('ab');
        expect(noDom('')).toBe('');
    });

    it('keeps text after a `<` that never closes, as it always did', () => {
        // The DOM drops an unterminated tag at end of input; the fallback never
        // did, and this change leaves that alone.
        expect(noDom('<abc')).toBe('<abc');
        expect(noDom('x<abc')).toBe('x<abc');
        expect(noDom('<')).toBe('<');
    });

    it('does not leave a tag formed from the pieces of another', () => {
        expect(noDom('<scr<script>ipt>')).toBe('ipt>');
        expect(noDom('<<b>>')).toBe('>');
    });
});

describe('stripTagsNoDom — identical to the regex it replaces', () => {
    it('matches on hand-picked inputs', () => {
        for (const [html] of CASES) expect(stripTagsNoDom(html)).toBe(legacyStrip(html));
        for (const html of ['', '<', '>', '<>', '><', 'a<b', 'a>b<c>d', '<a<b<c>', '>>><<<', '<a>b<c'])
            expect(stripTagsNoDom(html)).toBe(legacyStrip(html));
    });

    it('matches on every short string over the characters that matter', () => {
        const alphabet = ['<', '>', 'a', ' '];
        const walk = (prefix: string, depth: number): void => {
            expect(stripTagsNoDom(prefix), JSON.stringify(prefix)).toBe(legacyStrip(prefix));
            if (depth === 0) return;
            for (const c of alphabet) walk(prefix + c, depth - 1);
        };
        walk('', 7);
    });
});
