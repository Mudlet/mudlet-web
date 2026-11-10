// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  codePointWidth,
  clusterWidth,
  stringWidth,
  segmentCells,
  isPlainAscii,
} from '../../../src/mud/text/wcwidth';

describe('codePointWidth', () => {
  it('treats printable ASCII as width 1', () => {
    expect(codePointWidth('A'.codePointAt(0)!)).toBe(1);
    expect(codePointWidth(' '.codePointAt(0)!)).toBe(1);
    expect(codePointWidth('~'.codePointAt(0)!)).toBe(1);
  });

  it('treats control characters as width 0', () => {
    expect(codePointWidth(0x00)).toBe(0);
    expect(codePointWidth(0x1b)).toBe(0); // ESC
    expect(codePointWidth(0x7f)).toBe(0); // DEL
  });

  it('treats combining diacritical marks as width 0', () => {
    expect(codePointWidth(0x0301)).toBe(0); // combining acute accent
    expect(codePointWidth(0x0323)).toBe(0); // combining dot below
  });

  it('treats zero-width spaces and joiners as width 0', () => {
    expect(codePointWidth(0x200b)).toBe(0); // zero-width space
    expect(codePointWidth(0x200d)).toBe(0); // zero-width joiner
    expect(codePointWidth(0xfeff)).toBe(0); // BOM
  });

  it('treats CJK ideographs and Hangul as width 2', () => {
    expect(codePointWidth(0x4e00)).toBe(2); // 一
    expect(codePointWidth(0x3042)).toBe(2); // あ
    expect(codePointWidth(0xac00)).toBe(2); // 가
  });

  it('treats supplementary-plane emoji as width 2', () => {
    expect(codePointWidth(0x1f600)).toBe(2); // 😀
    expect(codePointWidth(0x1f680)).toBe(2); // 🚀
  });

  it('keeps runic letters at width 1', () => {
    expect(codePointWidth(0x16b1)).toBe(1); // ᚱ
    expect(codePointWidth(0x16a0)).toBe(1); // ᚠ
  });

  it('keeps BMP dingbats / misc symbols narrow (width 1)', () => {
    expect(codePointWidth(0x260e)).toBe(1); // ☎
    expect(codePointWidth(0x2605)).toBe(1); // ★
    expect(codePointWidth(0x2660)).toBe(1); // ♠
    expect(codePointWidth(0x20ac)).toBe(1); // €
  });
});

describe('clusterWidth', () => {
  it('folds a base + combining mark into the base width', () => {
    expect(clusterWidth('é')).toBe(1); // é (decomposed)
    expect(clusterWidth('ọ̌')).toBe(1); // o with two marks
  });

  it('keeps a precomposed accented letter at width 1', () => {
    expect(clusterWidth('ü')).toBe(1);
    expect(clusterWidth('ñ')).toBe(1);
  });
});

describe('stringWidth', () => {
  it('counts ASCII by length', () => {
    expect(stringWidth('hello')).toBe(5);
  });

  it('ignores combining marks', () => {
    // "Ï çån ëát" base letters only — combining marks add no width
    expect(stringWidth('áb́ć')).toBe(3);
  });

  it('counts CJK as two cells each', () => {
    expect(stringWidth('日本語')).toBe(6);
  });
});

describe('segmentCells', () => {
  it('groups combining marks with their base grapheme', () => {
    const cells = segmentCells('áz');
    expect(cells.map((c) => c.text)).toEqual(['á', 'z']);
    expect(cells.map((c) => c.width)).toEqual([1, 1]);
  });
});

describe('isPlainAscii', () => {
  it('is true for printable ASCII only', () => {
    expect(isPlainAscii('The quick brown fox')).toBe(true);
    expect(isPlainAscii('Übung')).toBe(false);
    expect(isPlainAscii('a\tb')).toBe(false);
  });
});

describe('clusterWidth with VS16 (graphemeInfo::withPresentation)', () => {
  it('draws a one column symbol VS16 selects the emoji form of as two columns', () => {
    expect(clusterWidth('☠')).toBe(1);
    expect(clusterWidth('☠️')).toBe(2);
    expect(clusterWidth('\u{1F56F}️')).toBe(2);
    expect(clusterWidth('#️⃣')).toBe(2);
  });

  it('leaves a keycap base without U+20E3, or a letter, one column', () => {
    expect(clusterWidth('#️')).toBe(1);
    expect(clusterWidth('é️')).toBe(1);
  });
});
