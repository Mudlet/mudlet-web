// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Issue #283: window/Geyser drift found by running the Mudlet PTB side by side
// with Mudlet Web. Each block below is one row of that report, pinned to the
// numbers desktop gave.

describe('issue #283 — window and Geyser parity with desktop', () => {
    let rt: TestRuntime;

    beforeAll(async () => {
        rt = await createTestRuntime();
    });
    afterAll(() => rt.dispose());

    // Every return value, as a list: doStringSync alone keeps only the first, and
    // a Lua table comes back as a proxy, so they cross as one joined string.
    const ask = (code: string) => String(rt.run(
        `local t = {${code}} for i = 1, #t do t[i] = tostring(t[i]) end return table.concat(t, '|')`,
    )).split('|').map(v => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : v));

    describe('a partial echoed line is wrapped as soon as it is echoed', () => {
        it('splits a miniconsole echo past its wrap width without waiting for the newline', () => {
            rt.run('createMiniConsole("pw_rmc", 10, 10, 300, 100); setWindowWrap("pw_rmc", 20)');
            rt.run('echo("pw_rmc", string.rep("z", 50))');
            // TBuffer::append wraps the last line after every echo: 20 + 20 + 10.
            expect(ask('getLineCount("pw_rmc")')).toEqual([2]);
            expect(ask('getLastLineNumber("pw_rmc")')).toEqual([2]);
            rt.run('moveCursor("pw_rmc", 0, 1)');
            expect(ask('getCurrentLine("pw_rmc")')).toEqual(['z'.repeat(20)]);
            // The next echo carries on from the last piece, and the newline
            // finishing it leaves the count desktop reports after it too.
            rt.run('echo("pw_rmc", "\\n")');
            expect(ask('getLineCount("pw_rmc")')).toEqual([3]);
            expect(ask('unpack(getLines("pw_rmc", 0, 3))')).toEqual(['z'.repeat(20), 'z'.repeat(20), 'z'.repeat(10)]);
        });

        it('a later echo onto the open piece wraps on from where it left off', () => {
            rt.run('createMiniConsole("pw_more", 10, 10, 300, 100); setWindowWrap("pw_more", 10)');
            rt.run('echo("pw_more", string.rep("a", 15))');
            rt.run('echo("pw_more", string.rep("b", 10))');
            expect(ask('unpack(getLines("pw_more", 0, 3))')).toEqual(['a'.repeat(10), 'aaaaabbbbb', 'bbbbb']);
        });

        it('wraps a long partial echo on the main console straight away', () => {
            rt.run('setWindowWrap("main", 100)');
            const before = ask('getLineCount()')[0] as number;
            rt.run('echo(string.rep("m", 250))');
            // Main wraps at 100: 100 + 100 + 50.
            expect((ask('getLineCount()')[0] as number) - before).toBe(2);
        });
    });

    describe('docked user windows', () => {
        it('openUserWindow lays the dock out before it returns', () => {
            // The DOM half of this (that settling really commits the layout) is
            // tests/ui/windowGeometryParity.test.ts; here, that the binding asks.
            const settle = vi.spyOn(rt.session.windows, 'settleLayout');
            rt.run('openUserWindow("dk_uw2", false, true, "right")');
            expect(settle).toHaveBeenCalled();
            settle.mockRestore();
        });

        it('a window opened floating settles nothing, so the main size a constructor measured holds', () => {
            // Geyser.UserWindow:new reads getMainWindowSize before openUserWindow
            // and resolves its percentages after it; flushing an unrelated
            // pending layout change in between would move the goalposts.
            const settle = vi.spyOn(rt.session.windows, 'settleLayout');
            rt.run('openUserWindow("dk_float", false, true, "floating")');
            expect(settle).not.toHaveBeenCalled();
            settle.mockRestore();
        });

        it('resizeWindow and moveWindow float a docked user window first, as Host::resizeWindow does', () => {
            rt.run('openUserWindow("dk_rs", false, true, "right")');
            expect(rt.session.windows.isDocked('dk_rs')).toBe(true);
            rt.run('resizeWindow("dk_rs", 400, 200)');
            expect(rt.session.windows.isDocked('dk_rs')).toBe(false);
            expect(ask('getWindowGeometry("dk_rs")').slice(2)).toEqual([400, 200]);

            rt.run('openUserWindow("dk_mv", false, true, "left")');
            rt.run('moveWindow("dk_mv", 33, 44)');
            expect(rt.session.windows.isDocked('dk_mv')).toBe(false);
            expect(ask('getWindowGeometry("dk_mv")').slice(0, 2)).toEqual([33, 44]);
        });

        it('a hidden docked window floated by resizeWindow stays hidden, as setFloating leaves it', () => {
            rt.run('openUserWindow("dk_hid", false, true, "right"); hideWindow("dk_hid")');
            rt.run('resizeWindow("dk_hid", 300, 150)');
            expect(rt.session.windows.isDocked('dk_hid')).toBe(false);
            expect(rt.session.windows.isVisible('dk_hid')).toBe(false);
        });
    });

    describe('getUserWindowSize', () => {
        it('answers a miniconsole with the main window size, as for any name with no dock', () => {
            rt.run('createMiniConsole("gu_rmc", 10, 10, 300, 100)');
            expect(ask('getUserWindowSize("gu_rmc")')).toEqual(ask('getMainWindowSize()'));
        });
    });

    describe('negative and fractional sizes', () => {
        it('clamps a label resized below zero to 0, as QWidget::resize does', () => {
            rt.run('createLabel("ng_lbl", 5, 5, 50, 50, 1)');
            rt.run('resizeWindow("ng_lbl", 0, -5)');
            expect(ask('getWindowGeometry("ng_lbl")')).toEqual([5, 5, 0, 0]);
            rt.run('resizeWindow("ng_lbl", -20, 30)');
            expect(ask('getWindowGeometry("ng_lbl")')).toEqual([5, 5, 0, 30]);
        });

        it('clamps a label created with a negative size to 0', () => {
            rt.run('createLabel("ng_neg", 5, 5, -10, -10, 1)');
            expect(ask('getWindowGeometry("ng_neg")')).toEqual([5, 5, 0, 0]);
        });

        it('truncates fractional border sizes rather than rounding them', () => {
            rt.run('setBorderTop(194.8)');
            expect(ask('getBorderTop()')).toEqual([194]);
            rt.run('setBorderLeft(10.5)');
            expect(ask('getBorderLeft()')).toEqual([10]);
            rt.run('setBorderSizes(0)');
        });
    });
});
