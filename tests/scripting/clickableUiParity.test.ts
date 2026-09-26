// @vitest-environment node
//
// Issue #186: the Lua side of clickable-UI drift against desktop Mudlet —
// what a script sees from getButtonState() with no argument and from a label's
// leave callback.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

let env: TestRuntime;
beforeEach(async () => { env = await createTestRuntime(); });
afterEach(() => env.dispose());

describe('getButtonState() with no argument', () => {
    // Mudlet answers the console's mButtonState, written by the button click
    // being handled: 2 when a push-down button went down, 1 otherwise. It used
    // to be hard-wired to 1, breaking `if getButtonState() == 2 then`.
    it('reports the state of the click being handled', () => {
        expect(env.run('return getButtonState()')).toBe(1);
        env.api.clickedButtonState = 2;
        expect(env.run('return getButtonState()')).toBe(2);
        env.api.clickedButtonState = 1;
        expect(env.run('return getButtonState()')).toBe(1);
    });
});

describe('label leave callback', () => {
    const fireLeave = () => {
        const l = env.api.labels.get('L')!;
        l.onMouseLeave!({
            button: 'NoButton', buttons: [], x: 0, y: 0, globalX: 0, globalY: 0,
            alt: false, ctrl: false, shift: false, meta: false,
        });
    };

    // TLabel::leaveEvent calls the callback with its own arguments only — there
    // is no event table, unlike enter/click/move.
    it('gets the bound arguments and no event', () => {
        env.run('createLabel("L", 0, 0, 10, 10, 1)');
        env.run('got = nil; setLabelOnLeave("L", function(...) got = {n = select("#", ...), ...} end, "a", "b")');
        fireLeave();
        expect(env.run('return got.n')).toBe(2);
        expect(env.run('return got[1] .. got[2]')).toBe('ab');
    });

    it('gets no arguments at all when none were bound', () => {
        env.run('createLabel("L", 0, 0, 10, 10, 1)');
        env.run('got = nil; setLabelOnLeave("L", function(...) got = select("#", ...) end)');
        fireLeave();
        expect(env.run('return got')).toBe(0);
    });
});

describe('label mouse event shape', () => {
    // Desktop hands `buttons` as a Lua list of Qt button names, and wheel
    // deltas flat on the event as angleDeltaX / angleDeltaY.
    it('carries buttons as a 1-indexed list', () => {
        env.run('createLabel("L", 0, 0, 10, 10, 1)');
        env.run('got = nil; setLabelClickCallback("L", function(e) got = #e.buttons .. ":" .. tostring(e.buttons[1]) end)');
        env.api.labels.get('L')!.onClick!({
            button: 'LeftButton', buttons: ['LeftButton'], x: 0, y: 0, globalX: 0, globalY: 0,
            alt: false, ctrl: false, shift: false, meta: false,
        });
        expect(env.run('return got')).toBe('1:LeftButton');
    });

    it('carries wheel deltas as angleDeltaX / angleDeltaY', () => {
        env.run('createLabel("L", 0, 0, 10, 10, 1)');
        env.run('got = nil; setLabelWheelCallback("L", function(e) got = e.angleDeltaX .. "," .. e.angleDeltaY .. "," .. #e.buttons end)');
        env.api.labels.get('L')!.onWheel!({
            button: 'NoButton', buttons: [], x: 0, y: 0, globalX: 0, globalY: 0,
            alt: false, ctrl: false, shift: false, meta: false,
            angleDeltaX: 0, angleDeltaY: -120, angleDelta: { x: 0, y: -120 },
        });
        expect(env.run('return got')).toBe('0,-120,0');
    });
});
