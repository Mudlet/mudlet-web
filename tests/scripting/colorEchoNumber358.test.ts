// @vitest-environment node
//
// mudlet-web#358 item 1: cecho/decho/hecho(window, number), measured against
// the Mudlet PTB. Desktop's xEcho reads the second argument as the text,
// whatever its type, so `cecho("win", hp)` writes the number into "win". The
// fast colour-echo wrapper only took the two-argument form when both were
// strings, and otherwise echoed the WINDOW NAME into main.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('mudlet-web#358 — colour echo of a number into a named window', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    const mainLines = (): string =>
        env.run('return (table.concat(getLines("main", 0, getLineCount()), "/"))') as string;

    it('writes the number into main, not the word "main"', () => {
        env.run('cecho("main", 7) echo("|") decho("main", 8) echo("|") hecho("main", 9) echo("|") echo("main", 10) echo("\\n")');
        // Desktop: 7|8|9|10
        expect(mainLines()).toBe('7|8|9|10');
    });

    it('writes the number into the named buffer, and nothing into main', () => {
        env.run('createBuffer("mc")');
        env.run('cecho("mc", 11) decho("mc", 12.5) hecho("mc", 13) echo("mc", "\\n")');
        expect(env.run('return (table.concat(getLines("mc", 0, 1), "/"))')).toBe('1112.513');
        expect(env.mainOutput.join('/')).not.toContain('mc');
    });

    it('still reads a single string as text for main', () => {
        env.run('cecho("<red>solo\\n")');
        expect(mainLines()).toBe('solo');
    });
});
