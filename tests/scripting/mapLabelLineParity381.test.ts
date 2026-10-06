// @vitest-environment node
// Map label and custom line behaviour pinned against desktop Mudlet (issue #381).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

let env: TestRuntime;
beforeEach(async () => { env = await createTestRuntime(); });
afterEach(() => env.dispose());

const keys = (room: number) =>
    env.run(`local t = {} for k in pairs(getCustomLines(${room})) do t[#t + 1] = k end table.sort(t) return table.concat(t, ",")`);

describe('removeSpecialExit drops the exit\'s custom line', () => {
    beforeEach(() => {
        env.run('addRoom(1); addRoom(2); addSpecialExit(1, 2, "climb")');
        expect(env.run('return addCustomLine(1, {{1,1,0}}, "climb", "solid line", {255,0,0}, false)')).toBe(true);
    });

    it('leaves no line behind', () => {
        expect(keys(1)).toBe('climb');
        expect(env.run('return removeSpecialExit(1, "climb")')).toBe(true);
        expect(keys(1)).toBe('');
    });

    it('does not bring the old line back when the exit is re-added', () => {
        env.run('removeSpecialExit(1, "climb"); addSpecialExit(1, 2, "climb")');
        expect(keys(1)).toBe('');
    });

    it('drops it when the destination room is deleted too', () => {
        env.run('deleteRoom(2)');
        expect(keys(1)).toBe('');
    });
});

describe('addCustomLine refusals', () => {
    it('refuses points on different z levels', () => {
        env.run('addRoom(5); addRoom(6); setExit(5, 6, "e")');
        expect(env.run('local ok, e = addCustomLine(5, {{1,1,0},{2,2,1}}, "e", "solid line", {255,0,0}, false) return tostring(ok) .. "|" .. e'))
            .toBe('nil|addCustomLine: the z values are not all on the same level (first wrong value is 1 at index 2)');
        expect(keys(5)).toBe('');
    });

    it('compares truncated z values', () => {
        env.run('addRoom(5); addRoom(6); setExit(5, 6, "e")');
        expect(env.run('return addCustomLine(5, {{1,1,0},{2,2,0.5}}, "e", "solid line", {255,0,0}, false)')).toBe(true);
    });

    it('refuses a direction that only has a stub', () => {
        env.run('addRoom(5); setExitStub(5, "n", true)');
        expect(env.run('local ok, e = addCustomLine(5, {{1,1,0}}, "n", "solid line", {255,0,0}, false) return tostring(ok) .. "|" .. e'))
            .toBe("nil|addCustomLine: roomID 5 does not have an exit in a direction that can be identified from 'n'");
        expect(keys(5)).toBe('');
    });
});

describe('addCustomLine stored data', () => {
    beforeEach(() => { env.run('addRoom(5); addRoom(6); setExit(5, 6, "e")'); });

    it('truncates a fractional colour', () => {
        expect(env.run('return addCustomLine(5, {{1,1,0}}, "e", "solid line", {10.9, 20.5, 30.1}, false)')).toBe(true);
        expect(env.run('local c = getCustomLines(5).e.attributes.color return c.r .. "," .. c.g .. "," .. c.b'))
            .toBe('10,20,30');
        expect(env.run('local c = getCustomLines1(5).e.attributes.color return table.concat(c, ",")'))
            .toBe('10,20,30');
    });

    it('keeps every point of a sparse list', () => {
        expect(env.run('return addCustomLine(5, {[1]={1,1,0}, [3]={3,3,0}}, "e", "solid line", {255,0,0}, false)')).toBe(true);
        expect(env.run('local p = getCustomLines1(5).e.points local t = {} for i, q in ipairs(p) do t[i] = q[1] .. ":" .. q[2] end return table.concat(t, ",")'))
            .toBe('1:1,3:3');
    });
});

describe('custom line getters and removal on failure', () => {
    it('removeCustomLine answers nil and a message for an unknown room', () => {
        expect(env.run('local ok, e = removeCustomLine(999, "e") return tostring(ok) .. "|" .. type(e)')).toBe('nil|string');
    });

    it('removeCustomLine answers nil and a message for a missing exit', () => {
        env.run('addRoom(5)');
        expect(env.run('local ok, e = removeCustomLine(5, "e") return tostring(ok) .. "|" .. type(e)')).toBe('nil|string');
    });

    it('removeCustomLine answers nil and a message for an exit without a line', () => {
        env.run('addRoom(5); addRoom(6); setExit(5, 6, "e")');
        expect(env.run('local ok, e = removeCustomLine(5, "e") return tostring(ok) .. "|" .. type(e)')).toBe('nil|string');
    });

    it('removeCustomLine answers true when it removes a line', () => {
        env.run('addRoom(5); addRoom(6); setExit(5, 6, "e")');
        env.run('addCustomLine(5, {{1,1,0}}, "e", "solid line", {255,0,0}, false)');
        expect(env.run('return removeCustomLine(5, "e")')).toBe(true);
        expect(keys(5)).toBe('');
    });

    it('getCustomLines(999) is nil and a message', () => {
        expect(env.run('local ok, e = getCustomLines(999) return tostring(ok) .. "|" .. e'))
            .toBe("nil|getCustomLines: room 999 doesn't exist");
    });
});

describe('map labels', () => {
    // createMapImageLabel needs no readable image for its flags; a missing file
    // still makes a (transparent) label.
    it('reads createMapImageLabel\'s tenth argument as temporary; image labels always scale', () => {
        const a = env.run('return (addAreaName("img381"))') as number;
        env.run(`createMapImageLabel(${a}, "nope.png", 0, 0, 0, 10, 10, 1, true, true)`);
        env.run(`createMapImageLabel(${a}, "nope.png", 0, 0, 0, 10, 10, 1, true, false)`);
        const flags = (id: number) => env.run(`local l = getMapLabel(${a}, ${id}) return tostring(l.Temporary) .. "," .. tostring(l.Scaling)`);
        expect(flags(0)).toBe('true,true');
        expect(flags(1)).toBe('false,true');
    });

    it('truncates a fractional label id in getMapLabel', () => {
        const a = env.run('return (addAreaName("lab381"))') as number;
        env.run(`createMapLabel(${a}, "hello", 0, 0, 0, 255, 255, 255, 0, 0, 0)`);
        expect(env.run(`return getMapLabel(${a}, 0.9).Text`)).toBe('hello');
    });
});
