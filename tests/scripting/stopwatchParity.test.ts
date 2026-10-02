// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { StopwatchManager, type StopwatchStore } from '../../src/scripting/StopwatchManager';

// Issue #278, item 1: stopwatch ids, argument checks and the broken-down table,
// each as the Mudlet PTB answers it.

describe('stopwatch ids — Host::createStopWatch takes the lowest free id', () => {
    it('reuses the ids of deleted watches, lowest first', () => {
        const sw = new StopwatchManager();
        expect(sw.create('a', false)).toBe(1);
        expect(sw.create('b', false)).toBe(2);
        expect(sw.create('c', false)).toBe(3);
        expect(sw.delete('b')).toBe(true);
        expect(sw.create('d', false)).toBe(2);
        expect(sw.delete('a')).toBe(true);
        expect(sw.create('e', false)).toBe(1);
        expect(sw.create('f', false)).toBe(4);
    });

    it('hands out the id of a non-persistent watch a reload dropped', () => {
        let saved: string | null = null;
        const store: StopwatchStore = { load: () => saved, save: (d) => { saved = d; } };
        const before = new StopwatchManager(store);
        before.create('one', false);
        before.create('two', false);
        before.create('three', false);
        before.create('four', false);
        before.setPersistence(1, true);
        before.setPersistence(2, true);
        before.setPersistence(4, true);

        const after = new StopwatchManager(store);
        expect(after.create('next', false)).toBe(3);
        expect(after.create('later', false)).toBe(5);
    });
});

describe('stopwatches from Lua', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    const second = (call: string) => env.run(`return select(2, ${call})`);

    it('matches the issue sequence: d=2, e=1, f=4', () => {
        expect(env.run(`
            createStopWatch("a"); createStopWatch("b"); createStopWatch("c")
            deleteStopWatch("b")
            local d = createStopWatch("d")
            deleteStopWatch("a")
            local e = createStopWatch("e")
            local f = createStopWatch("f")
            return d .. "," .. e .. "," .. f
        `)).toBe('2,1,4');
    });

    it('adjustStopWatch raises on a missing or non-numeric modification', () => {
        env.run('createStopWatch("c")');
        expect(() => env.run('adjustStopWatch("c")'))
            .toThrow('adjustStopWatch: bad argument #2 type (modification in seconds as number expected, got no value!)');
        expect(() => env.run('adjustStopWatch("c", nil)'))
            .toThrow('got nil!)');
        expect(() => env.run('adjustStopWatch("c", {})'))
            .toThrow('got table!)');
        // getVerifiedDouble is lua_isnumber, which a numeric string passes.
        expect(env.run('return (adjustStopWatch("c", "2.5"))')).toBe(true);
        expect(env.run('return (getStopWatchTime("c"))')).toBe(2.5);
    });

    it('a name that is not found is still (nil, errMsg) before the second argument is read', () => {
        expect(second('adjustStopWatch("nope")')).toBe("stopwatch with name 'nope' not found");
        expect(second('setStopWatchPersistence("nope")')).toBe("stopwatch with name 'nope' not found");
        // A numeric id getWatchId passes straight through, so it raises instead.
        expect(() => env.run('adjustStopWatch(900)')).toThrow('got no value!)');
        expect(second('adjustStopWatch(900, 1)')).toBe('stopwatch with ID 900 not found');
    });

    it('createStopWatch raises on a non-boolean autostart', () => {
        expect(() => env.run('createStopWatch("x", 1)'))
            .toThrow('createStopWatch: bad argument #2 type (autostart as boolean is optional, got number!)');
        // lua_gettop counts a trailing nil, so it is checked too.
        expect(() => env.run('createStopWatch("x", nil)')).toThrow('got nil!)');
        // Nothing was created by the refused calls.
        expect(env.run('return (createStopWatch("x", true))')).toBe(1);
    });

    it('setStopWatchPersistence raises unless the state is a boolean', () => {
        const id = env.run('return createStopWatch()') as number;
        expect(() => env.run(`setStopWatchPersistence(${id})`))
            .toThrow('setStopWatchPersistence: bad argument #2 type (persistence as boolean expected, got no value!)');
        expect(() => env.run(`setStopWatchPersistence(${id}, "yes")`))
            .toThrow('setStopWatchPersistence: bad argument #2 type (persistence as boolean expected, got string!)');
        expect(env.run(`return (setStopWatchPersistence(${id}, true))`)).toBe(true);
        expect(env.run(`return getStopWatches()[${id}].isPersistent`)).toBe(true);
        // Persistence outlives the runtime; don't leave the watch for the next test.
        env.run(`setStopWatchPersistence(${id}, false)`);
    });

    it('getStopWatchBrokenDownTime has no decimalSeconds; getStopWatches keeps it', () => {
        const id = env.run('local id = createStopWatch("w"); adjustStopWatch("w", 5); return id') as number;
        expect(env.run(`
            local keys = {}
            for k in pairs(getStopWatchBrokenDownTime("w")) do keys[#keys + 1] = k end
            table.sort(keys)
            return table.concat(keys, ",")
        `)).toBe('days,hours,milliSeconds,minutes,negative,seconds');
        expect(env.run(`return getStopWatches()[${id}].elapsedTime.decimalSeconds`)).toBe(5);
    });
});
