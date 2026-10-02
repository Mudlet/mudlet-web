// @vitest-environment node
//
// When sqlite-wasm fails to load (a blocked wasm fetch, say), only the database
// API goes with it: the Lua runtime still starts and runs scripts, and
// luasql/db:* fail with a LuaSQL-shaped answer instead of taking init down.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sqlite.org/sqlite-wasm', () => ({
    default: () => Promise.reject(new Error('Aborted(both async and sync fetching of the wasm failed)')),
}));

import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('a failed sqlite load leaves the runtime working', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('runs plain Lua', () => {
        expect(env.run('return string.rep("a", 3) .. tostring(1 + 1)')).toBe('aaa2');
    });

    it('luasql connect answers nil and the reason', () => {
        expect(env.run(`
            local c, err = luasql.sqlite3():connect(":memory:")
            local c2, err2 = luasql.sqlite3():connect(getMudletHomeDir() .. "/x.db")
            return tostring(c) .. "|" .. err .. "|" .. tostring(c2) .. "|" .. tostring(err2 == err)`))
            .toBe('nil|LuaSQL: sqlite init failed: Aborted(both async and sync fetching of the wasm failed)|nil|true');
    });

    it('db:create raises a clean error', () => {
        expect(() => env.run('db:create("nosqlite", {k={a=0}})'))
            .toThrow(/could not open the database file for nosqlite: LuaSQL: sqlite init failed/);
    });
});
