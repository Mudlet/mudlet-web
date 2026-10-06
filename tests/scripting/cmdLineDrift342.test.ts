// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { tabCompletionMatches } from '../../src/ui/tabCompletion';

// Issue #342, the scripting half: which command line the suggestion and
// blacklist calls reach, what Tab draws from, and which consoles have a
// command line at all.

describe('command-line drift vs Mudlet (#342)', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    const tab = (typed: string, cmdLine = 'main') => {
        const found = tabCompletionMatches(typed, env.api.cmdLineCompletionWords(cmdLine));
        return found ? found.userWords + found.matches[0] : typed;
    };

    describe('item 2: the Tab pool is the main console as it is now', () => {
        it('completes from what was echoed, and not after clearWindow()', () => {
            env.run('echo("zqclr\\n")');
            expect(tab('zqc')).toBe('zqclr');
            env.run('clearWindow()');
            expect(tab('zqc')).toBe('zqc');
        });

        it('stops 500 lines back', () => {
            env.run('echo("zqold\\n") for i = 1, 600 do echo("-\\n") end echo("zqcase ZQCASE\\n")');
            expect(tab('zqo')).toBe('zqo');
            expect(tab('zqc')).toBe('ZQCASE');
        });

        it('feeds a named command line from the main console too', () => {
            env.run('createCommandLine("cl1", 0, 0, 100, 20) echo("zqcase ZQCASE\\n")');
            expect(tab('zqc', 'cl1')).toBe('ZQCASE');
        });
    });

    describe('item 3: suggestions and the blacklist belong to the command line named', () => {
        beforeEach(() => {
            env.run('createCommandLine("cl1", 0, 0, 100, 20) echo("zqblack\\n")');
            env.run('addCmdLineSuggestion("cl1", "zqsugg") addCmdLineBlacklist("cl1", "zqblack")');
        });

        it('leaves the main command line alone', () => {
            expect(env.api.getCmdLineSuggestions('main')).toEqual([]);
            expect(env.api.getCmdLineBlacklist('main')).toEqual([]);
            expect(tab('zqs')).toBe('zqs');
            expect(tab('zqb')).toBe('zqblack');
        });

        it('applies to the line that was named', () => {
            expect(tab('zqs', 'cl1')).toBe('zqsugg');
            expect(tab('zqb', 'cl1')).toBe('zqb');
        });

        it('goes with the command line when it is deleted', () => {
            env.run('deleteCommandLine("cl1") createCommandLine("cl1", 0, 0, 100, 20)');
            expect(env.api.getCmdLineSuggestions('cl1')).toEqual([]);
            expect(env.api.getCmdLineBlacklist('cl1')).toEqual([]);
        });

        it('reaches a miniconsole\'s own command line', () => {
            env.run('createMiniConsole("mc1", 0, 0, 100, 100) enableCommandLine("mc1")');
            expect(env.run('return addCmdLineSuggestion("mc1", "zqmini") == nil')).toBe(true);
            expect(env.api.getCmdLineSuggestions('mc1')).toEqual(['zqmini']);
        });
    });

    describe('item 8: a console without a command line has none', () => {
        beforeEach(() => {
            env.run('createMiniConsole("mc1", 0, 0, 100, 100) openUserWindow("uw1")');
        });

        it('refuses getCmdLine, printCmdLine and setCmdLineAction before enableCommandLine', () => {
            expect(env.run('local ok, err = getCmdLine("mc1"); return ok == nil and err'))
                .toBe('command line "mc1" not found');
            expect(env.run('local ok, err = printCmdLine("mc1", "x"); return ok == nil and err'))
                .toBe('command line "mc1" not found');
            expect(env.run('local ok, err = setCmdLineAction("mc1", function() end); return ok == nil and err'))
                .toBe("command line name 'mc1' not found");
            expect(env.run('local ok, err = getCmdLine("uw1"); return ok == nil and err'))
                .toBe('command line "uw1" not found');
        });

        it('answers once enableCommandLine made one, and keeps it while hidden', () => {
            env.run('enableCommandLine("mc1") printCmdLine("mc1", "typed")');
            expect(env.run('return (getCmdLine("mc1"))')).toBe('typed');
            expect(env.run('return (setCmdLineAction("mc1", function() end))')).toBe(true);
            env.run('disableCommandLine("mc1")');
            expect(env.run('return (getCmdLine("mc1"))')).toBe('typed');
        });

        it('deleteCommandLine removes a miniconsole\'s line and raises sysCommandLineDeleted', () => {
            env.run('enableCommandLine("mc1")');
            env.run('deleted = nil registerAnonymousEventHandler("sysCommandLineDeleted", function(_, n) deleted = n end)');
            expect(env.run('return (deleteCommandLine("mc1"))')).toBe(true);
            expect(env.run('return deleted')).toBe('mc1');
            expect(env.run('local ok, err = getCmdLine("mc1"); return ok == nil and err'))
                .toBe('command line "mc1" not found');
            // The console itself stays, and can be given a new line.
            expect(env.session.windows.isMiniConsole('mc1')).toBe(true);
            env.run('enableCommandLine("mc1")');
            expect(env.run('return (getCmdLine("mc1"))')).toBe('');
        });
    });
});
