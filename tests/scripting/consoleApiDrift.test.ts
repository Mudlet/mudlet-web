// @vitest-environment node
//
// Console APIs that answered differently from desktop Mudlet (mudlet-web#189):
// setTextFormat recoloured the selection, fractional font sizes were rounded,
// and getLines on a window that doesn't exist handed back an empty table.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('console API parity (mudlet-web#189)', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.run('createMiniConsole("drift", 0, 0, 400, 200)');
    });
    afterEach(() => env.dispose());

    it('setTextFormat sets the pen and leaves the selection alone', () => {
        const fg = 'local r, g, b = getFgColor("drift"); return r .. "," .. g .. "," .. b';
        env.run(`
            echo("drift", "alpha beta\\n")
            moveCursor("drift", 0, 0)
            selectString("drift", "beta", 1)
        `);
        const before = env.run(fg);
        expect(before).not.toBe('255,0,0');
        env.run('setTextFormat("drift", 0, 0, 0, 255, 0, 0, true, false, false)');
        expect(env.run(fg)).toBe(before);
        // Text written afterwards does carry the new format.
        env.run('echo("drift", "red\\n"); moveCursor("drift", 0, 1); selectString("drift", "red", 1)');
        expect(env.run('local r, g, b = getFgColor("drift"); return r .. "," .. g .. "," .. b'))
            .toBe('255,0,0');
    });

    it('truncates a fractional font size as getVerifiedInt does', () => {
        for (const [given, kept] of [[11.5, 11], [11.9, 11], [12.5, 12]] as const) {
            expect(env.run(`return setMiniConsoleFontSize("drift", ${given})`)).toBe(true);
            expect(env.run('return getFontSize("drift")')).toBe(kept);
        }
        expect(env.run('return setFontSize("drift", 13.7)')).toBe(true);
        expect(env.run('return getFontSize("drift")')).toBe(13);
    });

    it('takes a font size of 100', () => {
        expect(env.run('return setMiniConsoleFontSize("drift", 100)')).toBe(true);
        expect(env.run('return getFontSize("drift")')).toBe(100);
    });

    it('answers getLines on a missing window with nil and a message', () => {
        expect(env.run('local t, e = getLines("nosuch", 0, 1); return type(t) .. " " .. tostring(e)'))
            .toBe("nil mini console, user window or buffer 'nosuch' not found");
        expect(env.run('return type(getLines("drift", 0, 1))')).toBe('table');
        expect(env.run('return type(getLines(0, 1))')).toBe('table');
    });
});
