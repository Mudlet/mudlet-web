// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { StopwatchManager, isRefusal } from '../../src/scripting/StopwatchManager';

// The refusals below are Mudlet's own words, returned as (nil, message) with no
// function name in front — scripts branch on them, and the busted corpus pins
// each one verbatim.

/** The message a refused call hands back as its second value. */
const second = (env: TestRuntime, call: string) => env.run(`return select(2, ${call})`);

describe('stopwatches — Host.cpp semantics', () => {
    it('tracks a never-started watch: already reset, already stopped, reads 0', () => {
        const sw = new StopwatchManager();
        const id = sw.create('', false) as number;
        expect(sw.reset(id)).toEqual({ refused: `stopwatch with id ${id} was already reset` });
        expect(sw.stop(id)).toEqual({ refused: `stopwatch with id ${id} was already stopped` });
        expect(sw.getTime(id)).toBe(0);
    });

    it('resetting a stopped watch makes it never-started again', () => {
        const sw = new StopwatchManager();
        const id = sw.create('', false) as number;
        expect(sw.adjust(id, 7)).toBe(true);
        expect(sw.getTime(id)).toBe(7);
        expect(sw.reset('')).toBe(true);
        expect(sw.getTime(id)).toBe(0);
        expect(sw.reset('')).toEqual({ refused: `the first unnamed stopwatch (id:${id}) was already reset` });
    });

    it('says ID or id as the function whose message it is does', () => {
        const sw = new StopwatchManager();
        expect(sw.getTime(900)).toEqual({ refused: 'stopwatch with ID 900 not found' });
        expect(sw.start(900, false)).toEqual({ refused: 'stopwatch with id 900 not found' });
    });

    it('lets the empty new name take a name away again', () => {
        const sw = new StopwatchManager();
        const id = sw.create('named', false) as number;
        expect(sw.setName(id, '')).toBe(true);
        expect(isRefusal(sw.setName('named', 'x'))).toBe(true);
        expect(sw.setName('', 'again')).toBe(true);
    });
});

describe('Mudlet refusals from Lua', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('stopwatches: refusals carry no function name, and "5" is a name', () => {
        const id = env.run('return createStopWatch("sw1")') as number;
        expect(env.run('return (startStopWatch("sw1"))')).toBe(true);
        expect(second(env, 'startStopWatch("sw1")'))
            .toBe(`stopwatch with name 'sw1' (id:${id}) was already running`);
        expect(second(env, `deleteStopWatch("${id}")`)).toBe(`stopwatch with name '${id}' not found`);
        expect(second(env, 'getStopWatchTime("nope")')).toBe("stopwatch with name 'nope' not found");
        expect(second(env, 'createStopWatch("sw1")'))
            .toBe(`stopwatch with id ${id} called 'sw1' already exists`);
    });

    it('feedTelnet("") answers the tag table version and feeds nothing', () => {
        expect(env.run('return (feedTelnet(""))')).toBe(true);
        expect(second(env, 'feedTelnet("")')).toBe('feedTelnet: using table version 1');
        expect(env.mainOutput.join('')).not.toContain('1');
    });

    it('createLabel names the flag it could not read', () => {
        expect(() => env.run('createLabel("lbl", 0, 0, 10, 10, 1, "yes")'))
            .toThrow('createLabel: bad argument #7 type (label clickthrough as boolean/number (0/1) expected, got string!)');
        expect(env.run('return (createLabel("lbl", 0, 0, 10, 10, "1", 0))')).toBe(true);
    });

    it('expandAlias raises for text that is not a string', () => {
        expect(() => env.run('expandAlias({})'))
            .toThrow('expandAlias: bad argument #1 type (text to parse as string expected, got table!)');
    });

    it('openUserWindow refuses an empty name, a miniconsole and an unknown area', () => {
        expect(second(env, 'openUserWindow("")')).toBe('an userwindow cannot have an empty string as its name');
        env.run('createMiniConsole("mini", 0, 0, 50, 50)');
        expect(second(env, 'openUserWindow("mini", false)')).toBe("userwindow 'mini' already exists");
        expect(second(env, 'openUserWindow("uw", false, true, "Middle")')).toBe(
            'docking option "middle" not available. available docking options are'
            + ' "t" top, "b" bottom, "r" right, "l" left and "f" floating');
        // opened all the same, as Host::openWindow opens it before looking for the side
        expect(env.api.windows.has('uw')).toBe(true);
    });

    it('command lines and text edits refuse the empty name and one already taken', () => {
        expect(second(env, 'createCommandLine("", 0, 0, 10, 10)')).toBe('a commandLine cannot have an empty string as its name');
        expect(second(env, 'createTextEdit("", 0, 0, 10, 10)')).toBe('a text edit cannot have an empty string as its name');
        expect(env.run('return (createTextEdit("te", 0, 0, 10, 10))')).toBe(true);
        expect(second(env, 'createTextEdit("te", 0, 0, 10, 10)')).toBe("couldn't create text edit");
        expect(env.run('return (raiseWindow("te"))')).toBe(true);
    });

    it('deleting the empty name says so', () => {
        expect(second(env, 'deleteMiniConsole("")')).toBe('a miniconsole cannot have an empty string as its name');
        expect(second(env, 'deleteLabel("")')).toBe('a label cannot have an empty string as its name');
    });

    it('setLabelCustomCursor refuses in desktop order', () => {
        env.run('createLabel("cur", 0, 0, 10, 10, 1)');
        expect(second(env, 'setLabelCustomCursor("", "x.png")')).toBe('a label cannot have an empty string as its name');
        expect(second(env, 'setLabelCustomCursor("cur", "")')).toBe('custom cursor location cannot be an empty string');
        expect(second(env, 'setLabelCustomCursor("nolabel", "x.png")')).toBe("label name 'nolabel' not found");
    });

    it('setUserWindowTitle refuses the empty name and a miniconsole', () => {
        expect(second(env, 'setUserWindowTitle("", "t")')).toBe('a user window cannot have an empty string as its name');
        env.run('createMiniConsole("m2", 0, 0, 50, 50)');
        expect(second(env, 'setUserWindowTitle("m2", "t")')).toBe('"m2" is not a user window');
    });
});
