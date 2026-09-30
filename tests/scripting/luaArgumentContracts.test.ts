// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Argument contracts the busted corpus pins (Media, Miscallaneous, Mapper and
// Networking specs, issue #256), checked here at the runtime layer so a
// regression shows up without a browser.

/** pcall(chunk) → the error message, or null when it did not raise. */
function raised(t: TestRuntime, chunk: string): string | null {
    return t.run(`local ok, err = pcall(function() ${chunk} end)
        if ok then return nil end
        return tostring(err)`) as string | null;
}

describe('echo', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t.dispose());

    it('raises on a missing or wrongly typed argument, naming it', () => {
        expect(raised(t, 'echo()')).toContain('echo: bad argument #1 type (text as string expected, got no value!)');
        expect(raised(t, 'echo({}, "x")')).toContain('echo: bad argument #1 type');
        expect(raised(t, 'echo("main", {})')).toContain('echo: bad argument #2 type');
    });

    it('answers true for main, named or not', () => {
        expect(t.run('return echo("unit-echo-a ")')).toBe(true);
        expect(t.run('return echo("main", "unit-echo-b ")')).toBe(true);
        expect(t.run('return echo("", "unit-echo-c\\n")')).toBe(true);
        expect(t.mainOutput.join('')).toContain('unit-echo-a unit-echo-b unit-echo-c');
    });

    it('answers nil and a message for a console that does not exist', () => {
        expect(t.run('local ok, err = echo("unit-echo-nowhere", "x"); return tostring(ok) .. "|" .. err'))
            .toBe("nil|console/label 'unit-echo-nowhere' does not exist");
    });
});

describe('media argument contracts', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t.dispose());

    it('names the ordered position that has the wrong type, even with the name left out', () => {
        expect(raised(t, 'playSoundFile(true)'))
            .toContain('playSoundFile: bad argument #1 type (name as string expected, got boolean!)');
        expect(raised(t, 'playMusicFile(nil, nil, nil, nil, nil, nil, nil, nil, "x")'))
            .toContain('playMusicFile: bad argument #9 type (continue as boolean expected, got string!)');
        expect(raised(t, 'loadSoundFile(true)'))
            .toContain('loadSoundFile: bad argument #1 type (name as string expected, got boolean!)');
        expect(raised(t, 'stopMusic(nil, nil, nil, "x")'))
            .toContain('stopMusic: bad argument #4 type (fadeaway as boolean expected, got string!)');
        expect(raised(t, 'getPlayingSounds(nil, nil, nil, "x")'))
            .toContain('getPlayingSounds: bad argument #4 type (priority as number expected, got string!)');
    });

    it('keeps the soft answer for an ordered call with no name', () => {
        expect(t.run('local ok, err = playSoundFile(nil); return tostring(ok) .. "|" .. err'))
            .toBe('nil|playSoundFile: missing argument 1 (file to play)');
    });

    it('refuses a table key that is neither a name nor a number', () => {
        for (const fn of ['playSoundFile', 'loadMusicFile', 'stopSounds', 'getPausedVideos', 'playVideoFile']) {
            expect(raised(t, `${fn}({[true] = "x"})`))
                .toContain(`${fn}: bad argument #1 type (table keys as string expected, got boolean!)`);
        }
    });

    it('takes playVideoFile in the table form only', () => {
        expect(raised(t, 'playVideoFile()')).toContain('playVideoFile: need at least one argument');
        expect(raised(t, 'playVideoFile("clip.mp4")')).toContain('playVideoFile: needs to be a table');
    });
});

describe('hasExitLock', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); t.run('addRoom(1)'); });
    afterAll(() => t.dispose());

    it('names the type of a direction it cannot use', () => {
        const msg = (type: string) =>
            `hasExitLock: bad argument #2 type (direction as number or string expected, got ${type}!)`;
        expect(raised(t, 'hasExitLock(1, {})')).toContain(msg('table'));
        expect(raised(t, 'hasExitLock(1, nil)')).toContain(msg('nil'));
        expect(raised(t, 'hasExitLock(1, 0)')).toContain(msg('number'));
        expect(t.run('return hasExitLock(1, "east")')).toBe(false);
    });
});

describe('mmcp.displayClientList', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t.dispose());

    it('prints the empty client table as a System chat message', () => {
        expect(t.run(`
            local got = {}
            local id = registerAnonymousEventHandler("sysMMCPChatMessage", function(_, from, msg)
                got[#got + 1] = from .. "|" .. msg
            end)
            local ok = mmcp.displayClientList()
            killAnonymousEventHandler(id)
            return tostring(ok) .. "#" .. #got .. "#" .. (got[1] or "")`))
            .toMatch(/^true#1#System\|.*ChatClient.*Being Snooped/s);
    });
});
