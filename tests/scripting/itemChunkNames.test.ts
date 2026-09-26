// @vitest-environment node
//
// Item code runs under Mudlet's chunk names (mudlet-web#192): "Script: <name>",
// "Trigger: <name>", "Alias: <name>", "Timer: <name>", "Key: <name>", with no
// "@", so an error reads `[string "Trigger: probe"]:3: msg` and
// debug.getinfo(1, "S").source is the bare name — as scripts that parse their
// own errors or look up their own name expect. Without a chunk name the old
// file-style "@name" stays, for Mudlet Web's own internal chunks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

const PROBE = [
    '',
    '',
    'local ok, e = pcall(function() error("lvl1") end)',
    '__probe_err = e',
    '__probe_src = debug.getinfo(1, "S").source',
].join('\n');

describe('item chunk names', () => {
    let t: TestRuntime;

    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t?.dispose());

    const read = () => [t.run('return __probe_err'), t.run('return __probe_src')];

    it('a script runs as "Script: <name>"', () => {
        t.rt.load(PROBE, 'probe');
        expect(read()).toEqual(['[string "Script: probe"]:3: lvl1', 'Script: probe']);
    });

    it('trigger and alias code runs under the chunk name it is given', () => {
        t.rt.runWithMatches(PROBE, 'tr1', ['x'], undefined, undefined,
            undefined, undefined, undefined, undefined, 'Trigger: tr1');
        expect(read()).toEqual(['[string "Trigger: tr1"]:3: lvl1', 'Trigger: tr1']);

        t.rt.runWithMatches(PROBE, 'al1', ['x'], undefined, undefined,
            undefined, undefined, undefined, undefined, 'Alias: al1');
        expect(read()).toEqual(['[string "Alias: al1"]:3: lvl1', 'Alias: al1']);
    });

    it('timer and key code likewise', () => {
        t.rt.run(PROBE, 'timer "tmA"', 'Timer: tmA');
        expect(read()).toEqual(['[string "Timer: tmA"]:3: lvl1', 'Timer: tmA']);

        t.rt.run(PROBE, 'key "kF6"', 'Key: kF6');
        expect(read()).toEqual(['[string "Key: kF6"]:3: lvl1', 'Key: kF6']);
    });

    it('an error that escapes is reported under the chunk name', () => {
        expect(() => t.rt.run('\nerror("boom")', 'timer "tmB"', 'Timer: tmB'))
            .toThrow('[string "Timer: tmB"]:2: boom');
    });

    it('keeps "@name" when no chunk name is given', () => {
        t.rt.run(PROBE, 'internal');
        expect(read()).toEqual(['internal:3: lvl1', '@internal']);
    });
});
