// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { AnsiAwareBuffer } from '../../../src/mud/text/FormatState';
import { setExpectColorSpaceId, getExpectColorSpaceId } from '../../../src/mud/text/colorSpaceId';

const ESC = '\x1b';

// Module state, like the control-character mode — reset so a leaked `true`
// cannot mis-colour every other suite.
afterEach(() => setExpectColorSpaceId(false));

describe('SGR 24-bit colour with a colour space id', () => {
    it('reads 38;2;r;g;b by default', () => {
        expect(getExpectColorSpaceId()).toBe(false);
        const buf = new AnsiAwareBuffer(`${ESC}[38;2;10;20;30mX${ESC}[0m`);
        expect(buf.getStateAt(0)?.foreground).toMatchObject({ space: 'rgb', r: 10, g: 20, b: 30 });
    });

    it('reads 38;2;id;r;g;b once the preference is on', () => {
        setExpectColorSpaceId(true);
        const buf = new AnsiAwareBuffer(`${ESC}[38;2;1;10;20;30mX${ESC}[0m`);
        expect(buf.getStateAt(0)?.foreground).toMatchObject({ space: 'rgb', r: 10, g: 20, b: 30 });
    });

    it('is the misreading the preference exists to fix', () => {
        // The same T.416 escape read the default way shifts every channel — the
        // colour-space id becomes red — and then the leftover parameter is read
        // as its own SGR code, so `…;30m` sets black over the top. The colour a
        // player on such a server actually gets is unrelated to the one sent.
        const buf = new AnsiAwareBuffer(`${ESC}[38;2;1;10;20;30mX${ESC}[0m`);
        const fg = buf.getStateAt(0)?.foreground;
        expect(fg).not.toMatchObject({ space: 'rgb', r: 10, g: 20, b: 30 });
        expect(fg).toMatchObject({ space: 'hex' }); // the stray 30, as SGR black
    });

    it('applies to background colour (48) too', () => {
        setExpectColorSpaceId(true);
        const buf = new AnsiAwareBuffer(`${ESC}[48;2;0;5;6;7mX${ESC}[0m`);
        expect(buf.getStateAt(0)?.background).toMatchObject({ space: 'rgb', r: 5, g: 6, b: 7 });
    });

    it('leaves the 256-colour form alone in both modes', () => {
        for (const expectId of [false, true]) {
            setExpectColorSpaceId(expectId);
            const buf = new AnsiAwareBuffer(`${ESC}[38;5;196mX${ESC}[0m`);
            expect(buf.getStateAt(0)?.foreground).toMatchObject({ space: 'hex' });
        }
    });

    it('ignores a truncated sequence rather than inventing a colour', () => {
        setExpectColorSpaceId(true);
        // Only three parameters after the mode — not enough once the id eats one.
        const buf = new AnsiAwareBuffer(`${ESC}[38;2;1;10;20mX${ESC}[0m`);
        expect(buf.getStateAt(0)?.foreground).not.toMatchObject({ space: 'rgb' });
    });
});
