// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createTestRuntime } from '../createTestRuntime';

/**
 * Lua calls `exit(EXIT_FAILURE)` from `luaD_throw` when an error is raised with
 * no protected frame to catch it, which Emscripten surfaces as an `ExitStatus`
 * and latches with its own ABORT flag. The module is then gone for good: every
 * later call throws the identical value, so the old per-entity reporting filled
 * the script log with one line per timer tick forever.
 */
function exitStatus(status = 1): object {
    return { name: 'ExitStatus', message: `Program terminated with exit(${status})`, status };
}

describe('a terminated Lua WASM module', () => {
    it('is reported once, then the runtime goes inert', async () => {
        const t = await createTestRuntime();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logs: string[] = [];
        t.session.events.on('script.log', (text: string) => { logs.push(text); });

        // Stand in for the dead module: every entry into wasmoon throws the
        // ExitStatus that Emscripten's proc_exit import produced.
        const g = (t.rt as unknown as { lua: { global: { newThread: () => unknown } } }).lua.global;
        g.newThread = () => { throw exitStatus(); };

        let fatalNotices = 0;
        t.rt.onFatalError = () => { fatalNotices++; };

        // Ten ticks of the "Update top bar" timer against a dead engine.
        for (let i = 0; i < 10; i++) t.rt.run('ui.updateTopBar()', 'timer "Update top bar"');
        // …and an event dispatch, which funnels through runChunk instead.
        t.rt.emitEvent('sysWindowMousePressEvent', []);

        expect(logs).toEqual([
            '[scripting] the Lua engine stopped (Program terminated with exit(1)). '
            + 'Scripts, triggers, aliases and timers are disabled until this profile is reopened.',
        ]);
        expect(fatalNotices).toBe(1);
        expect(spy).toHaveBeenCalledWith('[mudix] the Lua WASM module terminated:', exitStatus());

        spy.mockRestore();
        t.dispose();
    }, 60000);

    it('lets an ordinary script error through untouched', async () => {
        const t = await createTestRuntime();
        expect(() => t.rt.run('error("still a normal failure")', 'timer "t"'))
            .toThrow(/still a normal failure/);
        t.dispose();
    }, 60000);
});

describe('Lua memory pressure', () => {
    it('warns once per threshold as the heap climbs toward the 2 GiB ceiling', async () => {
        const t = await createTestRuntime();
        const logs: string[] = [];
        t.session.events.on('script.log', (text: string) => { logs.push(text); });

        // Stand in for lua_gc(L, LUA_GCCOUNT, 0) rather than allocating the real
        // hundreds of megabytes; `reported` is what Lua would answer, in KB.
        const api = (t.rt as unknown as { lua: { global: { luaApi: { lua_gc: unknown } } } })
            .lua.global.luaApi;
        let reportedKb = 100 * 1024;
        api.lua_gc = () => reportedKb;

        const tick = (n: number) => { for (let i = 0; i < n; i++) t.rt.run('local a = 1', 'timer "t"'); };

        tick(2500);                       // 100 MB — nothing to say
        expect(logs).toEqual([]);

        reportedKb = 600 * 1024;
        tick(2500);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('holding 600 MB');

        tick(2500);                       // still 600 MB — already said
        expect(logs).toHaveLength(1);

        reportedKb = 1600 * 1024;         // skips straight past the 1024 step
        tick(2500);
        expect(logs).toHaveLength(2);
        expect(logs[1]).toContain('holding 1600 MB');

        reportedKb = 1900 * 1024;         // every threshold used up
        tick(2500);
        expect(logs).toHaveLength(2);

        t.dispose();
    }, 60000);
});
