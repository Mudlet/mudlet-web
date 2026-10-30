// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { createTestRuntime } from '../createTestRuntime';

/**
 * lua_close() runs every __gc finaliser, and one of them can call tempTimer().
 * The timer engine outlives the state (a reset reuses it), so a timer made then
 * would later fire a callback into a state that is gone — desktop's
 * "never runs another function for a timer made while its state closed".
 */
describe('a timer made while the Lua state closes', () => {
    it('is never handed to the timer engine', async () => {
        const t = await createTestRuntime();
        t.run(`
            local keep = newproxy(true)
            getmetatable(keep).__gc = function() tempTimer(0.2, function() end) end
            __keep = keep
        `);
        const added: number[] = [];
        const timers = t.api.timers;
        const addTemp = timers.addTemp.bind(timers);
        timers.addTemp = (...args: Parameters<typeof addTemp>) => {
            const id = addTemp(...args);
            added.push(id);
            return id;
        };
        t.rt.destroy();
        expect(added).toEqual([]);
        t.dispose();
    });
});
