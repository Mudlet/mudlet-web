// @vitest-environment node
//
// mudlet-web#374, checked against desktop Mudlet PTB: the Lua global
// environment Mudlet Web's own Lua leans on, against desktop's C.
//   1. a script's own global select/type/unpack must not break the API;
//   2. a script's own `echo` is what decho/cecho/hecho call, and what
//      echoUserWindow does not;
//   3. there is no `namedCaptures` global;
//   4. matches/multimatches are assigned, so a __newindex on _G sees them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('Lua global environment drift vs desktop (#374)', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    const mainLines = (): string =>
        env.run('return (table.concat(getLines("main", 0, getLineCount()), "/"))') as string;

    describe('a script global shadowing a builtin', () => {
        let sent: string[];
        beforeEach(() => {
            sent = [];
            vi.spyOn(env.api, 'send').mockImplementation((text: string) => { sent.push(text); });
        });

        const calls = `
            local results = {}
            local function try(name, f)
                local ok, err = pcall(f)
                results[#results + 1] = name .. "=" .. (ok and "ok" or tostring(err))
            end
            try("echo", function() echo("plain\\n") end)
            try("send", function() send("north", false) end)
            try("insertText", function() insertText("") end)
            try("expandAlias", function() expandAlias("look", false) end)
            try("tempTrigger", function() killTrigger(tempTrigger("never matches", function() end)) end)
            try("tempTimer", function() killTimer(tempTimer(100, function() end)) end)
            try("raiseEvent", function() raiseEvent("issue374") end)
            try("createLabel", function() createLabel("issue374", 0, 0, 10, 10, 1) end)
            try("sendGMCP", function() sendGMCP("Core.Ping") end)
            try("echoUserWindow", function() echoUserWindow("main", "x\\n") end)
            return table.concat(results, ";")`;

        const allOk = 'echo=ok;send=ok;insertText=ok;expandAlias=ok;tempTrigger=ok;tempTimer=ok;'
            + 'raiseEvent=ok;createLabel=ok;sendGMCP=ok;echoUserWindow=ok';

        it('leaves the API working under a global select', () => {
            env.run('select = function(who) return "target " .. tostring(who) end');
            expect(env.run(calls)).toBe(allOk);
            expect(sent).toContain('north');
        });

        it('leaves the API working under a global type', () => {
            env.run('type = function() return "thing" end');
            expect(env.run(calls)).toBe(allOk);
            expect(sent).toContain('north');
        });

        it('leaves the API working with unpack, tonumber and getfenv gone', () => {
            env.run('unpack, tonumber, getfenv = nil, nil, nil');
            expect(env.run(calls)).toBe(allOk);
        });

        it('leaves tostring and cecho working under a global select', () => {
            // desktop: both C, or (cecho) vendored Lua that does not call select
            env.run('select = function() return 0 end');
            expect(env.run('return tostring(12)')).toBe('12');
            env.run('cecho("<red>red\\n")');
            expect(mainLines()).toContain('red');
        });
    });

    describe('a script that wraps echo', () => {
        beforeEach(() => {
            env.run(`ECHO_CALLS = 0
                ECHO_STOCK = echo
                local stock = echo
                echo = function(...)
                    ECHO_CALLS = ECHO_CALLS + 1
                    local n = select("#", ...)
                    local a, b = ...
                    if n >= 2 then return stock(a, string.upper(b)) end
                    return stock(string.upper(a))
                end`);
        });

        it('has decho/hecho/cecho call it, for main and a miniconsole', () => {
            env.run('createBuffer("mc")');
            for (const call of [
                'cecho("<red>abc")', 'decho("<255,0,0>abc")', 'hecho("#ff0000abc")',
                'cecho("mc", "<red>abc")', 'decho("mc", "<255,0,0>abc")', 'hecho("mc", "#ff0000abc")',
            ]) {
                env.run('ECHO_CALLS = 0');
                env.run(call);
                expect(env.run('return ECHO_CALLS'), call).toBeGreaterThan(0);
            }
            env.run('echo("\\n")');
            expect(mainLines()).toContain('ABCABCABC');
            expect(env.run('return (table.concat(getLines("mc", 0, 1), "/"))')).toBe('ABCABCABC');
        });

        it('is not called by echoUserWindow', () => {
            env.run('ECHO_CALLS = 0');
            env.run('echoUserWindow("main", "abc\\n")');
            expect(env.run('return ECHO_CALLS')).toBe(0);
            expect(mainLines()).toContain('abc');
        });

        it('stops being called once the stock echo is put back', () => {
            env.run('echo = ECHO_STOCK');
            env.run('ECHO_CALLS = 0');
            env.run('cecho("<red>def\\n")');
            expect(env.run('return ECHO_CALLS')).toBe(0);
            expect(mainLines()).toContain('def');
        });
    });

    describe('named captures', () => {
        it('live in matches only, with no namedCaptures global', () => {
            expect(env.run('return rawget(_G, "namedCaptures") == nil')).toBe(true);
            env.rt.runWithMatches(
                'SEEN = { matches.who, rawget(_G, "namedCaptures") == nil }',
                'named', ['hello bob', 'bob'], undefined, { who: 'bob' },
            );
            expect(env.run('return SEEN[1]')).toBe('bob');
            expect(env.run('return SEEN[2]')).toBe(true);
            expect(env.run('return rawget(_G, "namedCaptures") == nil')).toBe(true);
        });

        it('leave a script global of that name alone', () => {
            env.run('namedCaptures = "my own value"');
            env.rt.runWithMatches('SEEN = namedCaptures', 'named', ['hello bob', 'bob'], undefined, { who: 'bob' });
            expect(env.run('return SEEN')).toBe('my own value');
            expect(env.run('return namedCaptures')).toBe('my own value');
        });
    });

    describe('matches and multimatches under a proxy globals table', () => {
        // The probe's proxy: every global moved into a backing table, _G left
        // empty, and __index/__newindex logging what goes through them.
        const installProxy = `
            WRITES = {}
            local G, rawset, pairs, setmetatable = _G, rawset, pairs, setmetatable
            local store = {}
            for k, v in pairs(G) do store[k] = v end
            for k in pairs(store) do rawset(G, k, nil) end
            setmetatable(G, {
                __index = store,
                __newindex = function(_, k, v)
                    if k == "matches" or k == "multimatches" then
                        local w = store.WRITES
                        w[#w + 1] = k
                    end
                    store[k] = v
                end,
            })`;

        it('are assigned through __newindex, not rawset', () => {
            env.run(installProxy);
            env.rt.runWithMatches(
                'SEEN = { matches[2], rawget(_G, "matches") == nil }', 'fire', ['hello bob', 'bob'],
            );
            expect(env.run('return SEEN[1]')).toBe('bob');
            expect(env.run('return SEEN[2]')).toBe(true);
            expect(env.run('return table.concat(WRITES, ",")')).toBe('matches,matches,multimatches');
            expect(env.run('return rawget(_G, "matches") == nil and rawget(_G, "multimatches") == nil')).toBe(true);
        });

        it('hands a multiline fire its multimatches through __newindex too', () => {
            env.run(installProxy);
            env.rt.runWithMatches(
                'SEEN = multimatches[1][2]', 'multi', ['unused'], [['row one', 'one']],
            );
            expect(env.run('return SEEN')).toBe('one');
            expect(env.run('return table.concat(WRITES, ",")')).toBe('multimatches,matches,multimatches');
        });

        it('still hands a fire its captures when __newindex raises', () => {
            const errors: string[] = [];
            vi.spyOn(env.api, 'printError').mockImplementation((msg: string) => { errors.push(msg); });
            env.run(`local G, rawset, pairs, setmetatable, error = _G, rawset, pairs, setmetatable, error
                local store = {}
                for k, v in pairs(G) do store[k] = v end
                for k in pairs(store) do rawset(G, k, nil) end
                setmetatable(G, { __index = store, __newindex = function(_, k, v)
                    if k == "matches" then error("no writes here") end
                    store[k] = v
                end })`);
            env.rt.runWithMatches('SEEN = matches[2]', 'fire', ['hello bob', 'bob']);
            expect(env.run('return SEEN')).toBe('bob');
            expect(errors.some(e => e.includes('no writes here'))).toBe(true);
            // the runtime is still alive
            expect(env.run('return 1 + 1')).toBe(2);
        });
    });
});
