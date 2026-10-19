// @vitest-environment node
//
// mudlet-web#238: desktop's tempButton / tempButtonToolbar answer nil and a
// message (warnArgumentValue) when they refuse (name taken, toolbar missing),
// so `if tempButton(...) then` is false for a refusal. The engine reports a
// refusal as a negative code; the Bridge.lua wrappers must turn that into nil
// and the message rather than hand the script a truthy -1.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('tempButton / tempButtonToolbar refusals answer nil and a message', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => { env.dispose(); vi.restoreAllMocks(); });

    it('passes an id through and turns each refusal code into nil and a message', () => {
        const tb = vi.spyOn(env.api, 'tempButtonToolbar').mockReturnValueOnce(7).mockReturnValueOnce(-1);
        const b = vi.spyOn(env.api, 'tempButton').mockReturnValueOnce(8)
            .mockReturnValueOnce(-1).mockReturnValueOnce(-2).mockReturnValueOnce(-3);
        expect(env.run('return tempButtonToolbar("VT", 0, 0)')).toBe(7);
        expect(env.run('local id, msg = tempButtonToolbar("VT", 0, 0); return tostring(id) .. "|" .. msg'))
            .toBe("nil|a button or toolbar named 'VT' already exists");
        expect(env.run('return tempButton("VT", "VB", 0)')).toBe(8);
        expect(env.run('local id, msg = tempButton("VT", "VB", 0); return tostring(id) .. "|" .. msg'))
            .toBe("nil|toolbar 'VT' not found");
        expect(env.run('local id, msg = tempButton("VT", "VB", 0); return tostring(id) .. "|" .. msg'))
            .toBe("nil|'VT' is a button, not a toolbar or menu");
        expect(env.run('local id, msg = tempButton("VT", "VB", 0); return tostring(id) .. "|" .. msg'))
            .toBe("nil|a button or toolbar named 'VB' already exists");
        expect(tb).toHaveBeenCalledTimes(2);
        expect(b).toHaveBeenCalledTimes(4);
    });

    it('is falsy for a refusal from the default host', () => {
        // No engine is bound, so the default host refuses every creation.
        expect(env.run('return tempButton("VT", "VB", 0) and "made" or "refused"')).toBe('refused');
        expect(env.run('return tempButtonToolbar("VT", 0, 0) and "made" or "refused"')).toBe('refused');
    });
});
