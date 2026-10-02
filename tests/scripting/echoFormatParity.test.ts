// @vitest-environment node
//
// Formatted-echo drift against desktop Mudlet (mudlet-web#289), each case
// measured on Mudlet 5.0.0 PTB by dumping the buffer per character:
//  1. an ESC inside echoed text is stored as text — echo/cecho/decho/hecho
//     never decode escape sequences, in main or in a miniconsole;
//  2. TConsole::echo drops \r on the way into the main console only;
//  3. cecho reads the live color_table, so a script's override wins — on the
//     native fast path as much as on the Lua one;
//  4. a link or popup with useCurrentFormat=false gets Mudlet's standard link
//     format (link blue, default background, underline only), not the pen.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Lua that dumps every line of window `w` as runs of `"text"@fg/bg/flags`,
// read back through the same getters the desktop measurement used.
const DUMP = `
local function dump(w)
  local n = getLineCount(w)
  local lines = getLines(w, 0, n + 1)
  local out = {}
  for y = 0, #lines - 1 do
    local text = lines[y + 1]
    local runs, cur, curText = {}, nil, ''
    for x = 0, #text - 1 do
      moveCursor(w, x, y)
      selectSection(w, x, 1)
      local fr, fgc, fb = getFgColor(w)
      local br, bgc, bb = getBgColor(w)
      local f = getTextFormat(w) or {}
      local flags = (f.bold and 'B' or '') .. (f.italic and 'I' or '') .. (f.underline and 'U' or '')
        .. (f.strikeout and 'S' or '') .. (f.reverse and 'R' or '')
      local key = fr .. ',' .. fgc .. ',' .. fb .. '/' .. br .. ',' .. bgc .. ',' .. bb .. '/' .. flags
      if key ~= cur then
        if cur then runs[#runs + 1] = string.format('%q', curText) .. '@' .. cur end
        cur, curText = key, ''
      end
      curText = curText .. text:sub(x + 1, x + 1)
    end
    if cur then runs[#runs + 1] = string.format('%q', curText) .. '@' .. cur end
    if #runs > 0 then out[#out + 1] = table.concat(runs, ' + ') end
  end
  deselect(w)
  return table.concat(out, '\\n')
end
return dump(...)
`;

describe('formatted echo parity with desktop (mudlet-web#289)', () => {
    let env: TestRuntime;
    const dump = (w: string): string[] => {
        env.run(`__dumpFn = function(...) ${DUMP} end`);
        const s = env.run(`return __dumpFn(${JSON.stringify(w)})`) as string;
        return s ? s.split('\n') : [];
    };
    const lines = (w: string): string[] => {
        const s = env.run(`return table.concat(getLines(${JSON.stringify(w)}, 0, getLineCount(${JSON.stringify(w)}) + 1), "\\n")`) as string;
        return s.split('\n').filter(l => l !== '');
    };

    beforeEach(async () => {
        env = await createTestRuntime();
        env.run('createMiniConsole("m", 0, 0, 400, 200)');
        env.run('clearWindow()');
    });
    afterEach(() => env.dispose());

    describe('1. an ESC in echoed text stays text', () => {
        it('echo keeps the sequence and the pen', () => {
            env.run('echo("A\\27[31mB\\n")');
            expect(lines('main')).toEqual(['A\x1b[31mB']);
            expect(dump('main')).toEqual(['"A\x1b[31mB"@192,192,192/0,0,0/']);
        });

        it('cecho keeps it (and takes the Lua path for it)', () => {
            env.run('cecho("<green>C\\27[1;34mD\\27[0mE\\n")');
            expect(dump('main')).toEqual(['"C\x1b[1;34mD\x1b[0mE"@0,255,0/0,0,0/']);
        });

        it('decho and hecho keep it', () => {
            env.run('decho("F\\27[42mG\\n"); hecho("H\\27[4mI\\n")');
            expect(dump('main')).toEqual([
                '"F\x1b[42mG"@192,192,192/0,0,0/',
                '"H\x1b[4mI"@192,192,192/0,0,0/',
            ]);
        });

        it('in a miniconsole too', () => {
            env.run('cecho("m", "J\\27[31mK\\n"); echo("m", "L\\27[1mM\\n")');
            expect(lines('m')).toEqual(['J\x1b[31mK', 'L\x1b[1mM']);
        });
    });

    describe('2. \\r in echoes', () => {
        it('is dropped in main', () => {
            env.run('echo("one\\rtwo\\n"); cecho("<red>three\\rfour\\n"); decho("<0,0,255>five\\r\\nsix\\n")');
            expect(lines('main')).toEqual(['onetwo', 'threefour', 'five', 'six']);
        });

        it('is kept in a miniconsole', () => {
            env.run('echo("m", "one\\rtwo\\n"); cecho("m", "<red>three\\rfour\\n")');
            expect(lines('m')).toEqual(['one\rtwo', 'three\rfour']);
        });
    });

    describe('3. cecho honours color_table overrides', () => {
        it('in main', () => {
            env.run('color_table.red = {0,0,255}; color_table.green = {255,0,255}');
            env.run('cecho("<red>mainred<green>maingreen\\n")');
            expect(dump('main')).toEqual(['"mainred"@0,0,255/0,0,0/ + "maingreen"@255,0,255/0,0,0/']);
        });

        it('in a miniconsole, and an in-place edit counts', () => {
            env.run('color_table.red[2] = 128');
            env.run('cecho("m", "<red>r<blue>b\\n")');
            expect(dump('m')).toEqual(['"r"@255,128,0/0,0,0/ + "b"@0,0,255/0,0,0/']);
        });

        it('an untouched palette still renders the built-in colours, natively', () => {
            const spy = vi.spyOn(env.api, 'fastColorEcho');
            env.run('cecho("<red>r<green>g\\n")');
            expect(spy).toHaveReturnedWith(true);
            expect(dump('main')).toEqual(['"r"@255,0,0/0,0,0/ + "g"@0,255,0/0,0,0/']);
        });

        it('only an overridden name leaves the fast path', () => {
            const spy = vi.spyOn(env.api, 'fastColorEcho');
            env.run('color_table.red = {0,0,255}');
            env.run('cecho("<green>g\\n")');
            expect(spy).toHaveBeenCalledTimes(1);
            env.run('cecho("<green>g<red>r\\n")');
            expect(spy).toHaveBeenCalledTimes(1);
        });
    });

    describe('4. links and popups use the standard link format', () => {
        const LINK = '"LNK"@80,160,255/0,0,0/U';

        it('echoLink drops bold, italics and the background', () => {
            env.run('setBold("m", true); setItalics("m", true); setBgColor("m", 0, 0, 255)');
            env.run('echoLink("m", "LNK", "send(\'x\')", "h"); echo("m", "\\n")');
            expect(dump('m')[0].startsWith(LINK)).toBe(true);
        });

        it('echoLink drops strikeout and reverse', () => {
            env.run('setStrikeOut("m", true); echoLink("m", "LNK", "send(\'x\')", "h"); resetFormat("m"); echo("m", "\\n")');
            env.run('setReverse("m", true); echoLink("m", "LNK", "send(\'x\')", "h"); resetFormat("m"); echo("m", "\\n")');
            expect(dump('m')).toEqual([LINK, LINK]);
        });

        it('the pen survives the link', () => {
            env.run('setBold("m", true); setFgColor("m", 1, 2, 3); echoLink("m", "LNK", "", "h"); echo("m", "after\\n")');
            expect(dump('m')).toEqual([`${LINK} + "after"@1,2,3/0,0,0/B`]);
        });

        it('cechoPopup ignores <b> and a background', () => {
            env.run('setBgColor("m", 0, 0, 255); cechoPopup("m", "<b><:blue>POP", {"send(\'x\')"}, {"h"}); echo("m", "\\n")');
            expect(dump('m')).toEqual(['"POP"@80,160,255/0,0,0/U']);
        });

        it('cechoLink with style tags is one plain link run', () => {
            env.run('cechoLink("m", "<red>lk<b>bo<r>rs", "send(\'x\')", "h"); echo("m", "\\n")');
            expect(dump('m')).toEqual(['"lkbors"@80,160,255/0,0,0/U']);
        });

        it('insertLink and insertPopup too', () => {
            env.run('echo("m", "ab\\ncd\\n"); setBold("m", true); setBgColor("m", 0, 0, 255)');
            env.run('moveCursor("m", 1, 0); insertLink("m", "L", "", "h")');
            env.run('moveCursor("m", 1, 1); insertPopup("m", "P", {""}, {"h"})');
            const [first, second] = dump('m');
            expect(first).toContain('"L"@80,160,255/0,0,0/U +');
            expect(second).toContain('"P"@80,160,255/0,0,0/U +');
        });

        it('useCurrentFormat=true keeps the pen', () => {
            env.run('setBold("m", true); setFgColor("m", 1, 2, 3); echoLink("m", "LNK", "", "h", true); echo("m", "\\n")');
            expect(dump('m')).toEqual(['"LNK"@1,2,3/0,0,0/B']);
        });
    });
});
