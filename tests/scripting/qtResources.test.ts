// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
    isQtResourcePath,
    qtResourceUrl,
    qtResourceBytes,
    qtResourcePaths,
} from '../../src/assets/qt-resources';
import { parseImageSize } from '../../src/scripting/lua/imageSize';

/**
 * Mudlet scripts address its compiled-in Qt resources as `:/icons/mudlet.png`.
 * A browser has no such bundle, so mudix vendors a deliberate subset — see
 * src/assets/qt-resources for why it is a subset and not the whole 9.6 MB.
 *
 * These pin the two things the rest of the code assumes: that a vendored path
 * yields synchronously-decodable bytes (getImageSize cannot await a fetch), and
 * that a path outside the set fails cleanly rather than resolving to something
 * wrong.
 */
describe('Qt resource namespace', () => {
    it('recognises both spellings Mudlet accepts, and nothing else', () => {
        expect(isQtResourcePath(':/icons/mudlet.png')).toBe(true);
        expect(isQtResourcePath('qrc:///icons/mudlet.png')).toBe(true);
        expect(isQtResourcePath('/tmp/local.png')).toBe(false);
        expect(isQtResourcePath('https://example.com/x.png')).toBe(false);
    });

    it('resolves a vendored resource to a usable data URI', () => {
        const url = qtResourceUrl(':/icons/mudlet.png');
        expect(url).toMatch(/^data:image\/png;base64,/);
        // The qrc:/// spelling has to land on the same resource.
        expect(qtResourceUrl('qrc:///icons/mudlet.png')).toBe(url);
    });

    it('decodes bytes synchronously, and they parse as a real image', () => {
        const bytes = qtResourceBytes(':/icons/mudlet.png');
        expect(bytes).toBeInstanceOf(Uint8Array);
        // PNG magic — proves the base64 round trip did not mangle the bytes.
        expect(Array.from(bytes!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
        const size = parseImageSize(bytes!);
        expect(size?.width).toBeGreaterThan(0);
        expect(size?.height).toBeGreaterThan(0);
    });

    it('reports a path outside the vendored set instead of guessing', () => {
        expect(qtResourceUrl(':/icons/no-such-icon.png')).toBeNull();
        expect(qtResourceBytes(':/icons/no-such-icon.png')).toBeNull();
    });

    it('lists what is vendored, in Qt form', () => {
        expect(qtResourcePaths()).toContain(':/icons/mudlet.png');
    });
});
