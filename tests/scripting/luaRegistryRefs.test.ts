// @vitest-environment node
//
// Two pieces of the Lua state a dispatch depends on that live below the
// scripts: the registry refs it parks values under, and which globals table
// it writes to.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LUA_REGISTRYINDEX } from 'wasmoon-lua5.1';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('pushing a nested JS object into Lua', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    // wasmoon freed every table ref at each level of a nested push, so the
    // parent's was freed twice and luaL_ref later handed one slot out twice —
    // and a value parked under the first ref was replaced by the second.
    it('leaves no registry slot to be handed out twice', () => {
        const g = (env.rt as unknown as { lua: { global: import('wasmoon-lua5.1').LuaGlobal } }).lua.global;
        g.set('NESTED', { a: { b: { c: [1, 2, { d: 3 }] } }, e: [{ f: 4 }] });
        // JS arrays arrive 0-indexed
        expect(env.run('return NESTED.a.b.c[2].d')).toBe(3);

        const api = g.luaApi;
        const L = g.address;
        const refs: number[] = [];
        for (let i = 0; i < 8; i++) {
            api.lua_createtable(L, 0, 0);
            refs.push(api.luaL_ref(L, LUA_REGISTRYINDEX));
        }
        expect(new Set(refs).size).toBe(refs.length);
        for (const ref of refs) api.luaL_unref(L, LUA_REGISTRYINDEX, ref);
    });

    it('still pushes a table that refers to itself', () => {
        const g = (env.rt as unknown as { lua: { global: import('wasmoon-lua5.1').LuaGlobal } }).lua.global;
        const cyclic: Record<string, unknown> = { name: 'loop' };
        cyclic.self = cyclic;
        g.set('CYCLIC', cyclic);
        expect(env.run('return rawequal(CYCLIC, CYCLIC.self) and CYCLIC.self.name')).toBe('loop');
    });
});

// Mudlet runs every script on one lua_State, so setfenv(0, t) in a script is
// the interpreter's globals table from then on. Here each script has a
// coroutine of its own; the table it switched to is carried over.
describe('setfenv(0) from a script', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => {
        env.run('if __ORIGINAL then setfenv(0, __ORIGINAL) end');
        env.dispose();
    });

    it('is the globals table the next script runs with, and the one a dispatch writes to', () => {
        // Through rt.run, which runs the script the way a dispatch does: on a
        // thread of its own, inside a coroutine of its own
        env.run('__ORIGINAL = getfenv(0)');
        env.rt.run('setfenv(0, setmetatable({SWAPPED = true}, {__index = __ORIGINAL}))', 'swap');
        expect(env.run('return SWAPPED')).toBe(true);
        env.rt.runWithMatches('SEEN = matches[2]', 'swapped', ['full', 'cap']);
        expect(env.run('return rawget(getfenv(0), "SEEN")')).toBe('cap');
        expect(env.run('return rawget(__ORIGINAL, "SEEN")')).toBe(null);
        env.run('setfenv(0, __ORIGINAL)');
        expect(env.run('return SWAPPED')).toBe(null);
    });
});
