// @vitest-environment node
//
// mudlet-web#373: the non-function globals a fresh profile has, against desktop
// Mudlet PTB — color_table's base colours as separate tables, the io file
// metatable in liolib's shape, the Mudlet API level getMudletVersion reports,
// and no speedWalk*/namedCaptures globals until something sets them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { configure, InMemory, mkdirSync } from '@zenfs/core';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

const PROFILE = '/profiles/drift-373';

describe('global-table drift vs Mudlet PTB (#373)', () => {
    let t: TestRuntime;

    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        t = await createTestRuntime({ vfs: new Ctor('drift-373', {}, 'idb') });
        t.run('H = getMudletHomeDir()');
    });

    afterAll(() => t?.dispose());

    describe('1. color_table base colours are three separate tables each', () => {
        it('no name shares its table with another', () => {
            expect(t.run('return color_table.ansi_001 == color_table.ansiRed')).toBe(false);
            expect(t.run('return color_table.ansi_001 == color_table.ansi_red')).toBe(false);
            expect(t.run(`
                local seen, shared = {}, 0
                for _, v in pairs(color_table) do
                    if type(v) == "table" then
                        if seen[v] then shared = shared + 1 end
                        seen[v] = true
                    end
                end
                return shared
            `)).toBe(0);
        });

        it('editing one name leaves the other two alone', () => {
            expect(t.run(`
                local saved = color_table.ansi_002[2]
                color_table.ansi_002[2] = 1
                local r = color_table.ansiGreen[2] .. "," .. color_table.ansi_green[2]
                color_table.ansi_002[2] = saved
                return r
            `)).toBe('128,128');
        });

        it('a pairs() loop changes each base colour once', () => {
            expect(t.run(`
                local copy = {}
                for k, v in pairs(color_table) do
                    if type(v) == "table" then copy[k] = { v[1], v[2], v[3] } end
                end
                for _, v in pairs(color_table) do
                    if type(v) == "table" then v[1] = math.floor(v[1] / 2) end
                end
                local r = color_table.ansiRed[1]
                for k, v in pairs(copy) do color_table[k][1] = v[1] end
                return r
            `)).toBe(64);
        });
    });

    describe('2. the io file metatable is liolib\'s shape', () => {
        it('holds the methods itself and indexes itself', () => {
            expect(t.run(`
                local mt = getmetatable(io.stdout)
                return tostring(mt.__index == mt) .. "," .. type(mt.write) .. "," .. type(mt.read)
                    .. "," .. type(mt.lines) .. "," .. type(mt.close) .. "," .. type(mt.seek)
                    .. "," .. type(mt.flush) .. "," .. type(mt.setvbuf)
                    .. "," .. type(mt.__gc) .. "," .. type(mt.__tostring)
            `)).toBe('true,function,function,function,function,function,function,function,function,function');
        });

        it('a method added to the metatable reaches every handle', () => {
            expect(t.run(`
                local mt = getmetatable(io.stdout)
                mt.writeln = function(self, s) return self:write(s, "\\n") end
                local f = io.open(H .. "/x.txt", "w")
                f:writeln("hello")
                f:close()
                mt.writeln = nil
                local g = io.open(H .. "/x.txt", "r")
                local s = g:read("*a")
                g:close()
                return s
            `)).toBe('hello\n');
        });

        it('a handle collected while open is closed, writing what it held', () => {
            expect(t.run(`
                do
                    local f = io.open(H .. "/gc.txt", "w")
                    f:write("kept")
                end
                collectgarbage("collect")
                collectgarbage("collect")
                local g = io.open(H .. "/gc.txt", "r")
                local s = g and g:read("*a")
                if g then g:close() end
                return s
            `)).toBe('kept');
        });

        it('collecting the standard files closes nothing', () => {
            expect(t.run(`
                getmetatable(io.stdout).__gc(io.stdout)
                return io.type(io.stdout)
            `)).toBe('file');
        });
    });

    describe('3. getMudletVersion reports the 5.0 API level', () => {
        it('reports 5.0.0', () => {
            expect(t.run('return getMudletVersion("string")')).toBe('5.0.0');
            expect(t.run('return getMudletVersion("major")')).toBe(5);
        });

        it('so mudletOlderThan(5) and (4, 22) are false', () => {
            expect(t.run('return mudletOlderThan(5)')).toBe(false);
            expect(t.run('return mudletOlderThan(4, 22)')).toBe(false);
        });
    });

    describe('4. speedWalk* and namedCaptures are not preset', () => {
        it('the speedWalk globals are nil on a fresh profile', () => {
            expect(t.run('return speedWalkDir == nil and speedWalkPath == nil and speedWalkWeight == nil')).toBe(true);
        });

        it('namedCaptures is nil, and nil again after a fire', () => {
            expect(t.run('return namedCaptures == nil')).toBe(true);
            t.rt.runWithMatches('R373 = namedCaptures and namedCaptures.hp', 'drift', ['HP 137', '137'], undefined, { hp: '137' });
            expect(t.run('return R373')).toBe('137');
            expect(t.run('return namedCaptures == nil')).toBe(true);
        });
    });
});
