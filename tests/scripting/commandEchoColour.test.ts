// @vitest-environment node
//
// setCommandForegroundColor/setCommandBackgroundColor without a window name set
// the profile's command colours (Host::mCommandFgColor/mCommandBgColor), and
// the very next echoed command is drawn in them — upstream UI_spec "main
// console colours" (Mudlet/mudlet-web#256).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

describe('command echo colours', () => {
    let t: TestRuntime;
    beforeEach(async () => { t = await createTestRuntime(); });
    afterEach(() => t.dispose());

    it('colour the next echoed command at once', () => {
        expect(t.api.setCommandForegroundColor(10, 20, 30)).toBe(true);
        expect(t.api.setCommandBackgroundColor(40, 50, 60)).toBe(true);
        t.session.echoCommand('mccCommand');
        const format = t.run(`
            -- The command is the last complete line; getLastLineNumber is the
            -- empty open line after it, which reads as '' (mudlet-web#331).
            moveCursor("main", 0, getLastLineNumber("main") - 1)
            selectString("mccCommand", 1)
            local f = getTextFormat("main")
            return table.concat(f.foreground, ",") .. "/" .. table.concat(f.background, ",")
        `);
        expect(format).toBe('10,20,30/40,50,60');
    });
});
