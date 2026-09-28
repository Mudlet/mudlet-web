// @vitest-environment node
//
// mudlet-web#238: desktop's tempButton / tempButtonToolbar return NO value when
// they refuse (name taken, toolbar missing), so `if tempButton(...) then` is
// false for a refusal. The engine reports a refusal as -1; the Bridge.lua
// wrappers must turn that into nothing rather than hand the script a truthy -1.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('tempButton / tempButtonToolbar refusals return no value', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => { env.dispose(); vi.restoreAllMocks(); });

    it('passes an id through and turns -1 into no value', () => {
        const tb = vi.spyOn(env.api, 'tempButtonToolbar').mockReturnValueOnce(7).mockReturnValueOnce(-1);
        const b = vi.spyOn(env.api, 'tempButton').mockReturnValueOnce(8).mockReturnValueOnce(-1);
        expect(env.run('return tempButtonToolbar("VT", 0, 0)')).toBe(7);
        expect(env.run('return select("#", tempButtonToolbar("VT", 0, 0))')).toBe(0);
        expect(env.run('return tempButton("VT", "VB", 0)')).toBe(8);
        expect(env.run('return select("#", tempButton("VT", "VB", 0))')).toBe(0);
        expect(tb).toHaveBeenCalledTimes(2);
        expect(b).toHaveBeenCalledTimes(2);
    });

    it('is falsy for a refusal from the default host', () => {
        // No engine is bound, so the default host refuses every creation.
        expect(env.run('return tempButton("VT", "VB", 0) and "made" or "refused"')).toBe('refused');
        expect(env.run('return tempButtonToolbar("VT", 0, 0) and "made" or "refused"')).toBe('refused');
    });
});
