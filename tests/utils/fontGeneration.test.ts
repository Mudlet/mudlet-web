// A font measurement has to be memoised — Geyser reaches calcFontSize thousands
// of times per reflow — but canvas resolves a family against the faces the
// document holds *at that moment*. Measure "Fira Code Willowdale" before the
// profile's own face has been registered and you get the fallback's advance
// (8.83px at 11pt instead of 9.02px), which under a plain family+size cache key
// is then the answer for the rest of the page's life. Every script that turns a
// cell width into a column count (`math.floor(width / cellW)`) inherits a column
// that does not exist, and each padded row folds its right-hand value onto the
// next line.
//
// The generation counter is what lets those caches expire: it moves whenever a
// family becomes usable that wasn't before. This covers the seam — that
// registering a font actually moves it — since the consumers key (or clear) on
// the value alone.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFontGeneration, bumpFontGeneration, loadFontFromVfs } from '../../src/utils/fontLoader';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

/** A VFS that hands back one byte for any path — the bytes never reach a real
 *  parser here, FontFace is stubbed. */
const stubVfs = (profilePath: string) => ({
    profilePath,
    readBinaryFile: () => new Uint8Array([1]),
}) as unknown as ProfileVFS;

beforeEach(() => {
    vi.stubGlobal('FontFace', class {
        constructor(readonly family: string, readonly source: unknown) {}
        load() { return Promise.resolve(this); }
    });
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { add: () => {}, addEventListener: () => {} },
    });
});

describe('font generation', () => {
    it('moves on every bump, so a stale measurement can be detected', () => {
        const before = getFontGeneration();
        bumpFontGeneration();
        expect(getFontGeneration()).toBe(before + 1);
    });

    it('moves when a VFS font is registered', async () => {
        const before = getFontGeneration();
        await loadFontFromVfs('Fira Code Willowdale', 'fonts/fira.ttf', stubVfs('/profiles/a'));
        expect(getFontGeneration()).toBeGreaterThan(before);
    });

    it('does not move for a font already registered — nothing became usable', async () => {
        const vfs = stubVfs('/profiles/b');
        await loadFontFromVfs('Ubuntu Mono', 'fonts/ubuntu.ttf', vfs);
        const after = getFontGeneration();
        await loadFontFromVfs('Ubuntu Mono', 'fonts/ubuntu.ttf', vfs);
        expect(getFontGeneration()).toBe(after);
    });
});
