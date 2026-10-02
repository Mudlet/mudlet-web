// @vitest-environment node
//
// Text operations on miniconsoles, user windows and buffers that answered
// differently from desktop Mudlet (mudlet-web#280). Every expectation below is
// what Mudlet 5.0 PTB printed for the same Lua, run against all three kinds.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Lua helpers: P packs a call's results (nils included) and S serialises a
// packed list or a getLines() table so a whole answer compares as one string.
const H = `
local function P(...) return { n = select('#', ...), ... } end
local function S(t)
  local o = {}
  for i = 1, (t.n or #t) do
    local v = t[i]
    o[#o + 1] = type(v) == 'string' and string.format('%q', v) or tostring(v)
  end
  return table.concat(o, ',')
end
local function all(w) return S(getLines(w, 0, getLineCount(w) + 1)) end
`;

const KINDS: Record<string, string> = {
    miniconsole: 'createMiniConsole("w", 0, 0, 300, 200)',
    userwindow: 'openUserWindow("w")',
    buffer: 'createBuffer("w")',
};

describe('writing to a window that does not exist (mudlet-web#280)', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('cecho/decho/hecho create nothing, and echo is refused', () => {
        env.run('cecho("ghost", "<red>hello\\n"); decho("ghost", "dd\\n"); hecho("ghost", "hh\\n")');
        // a style tag takes the per-segment xEcho path rather than the fast one
        env.run('cecho("ghost", "<b>bold</b>\\n"); cechoLink("ghost", "lnk", "", "")');
        expect(env.run(H + 'return S(P(getLineCount("ghost")))')).toBe('nil,"window \\"ghost\\" not found"');
        expect(env.run('return getLastLineNumber("ghost")')).toBe(-1);
        expect(env.run(H + 'return S(P(windowType("ghost")))')).toBe(
            'nil,"\'ghost\' is not a known label, any type of console, command line, text edit, nor scroll box"');
        expect(env.run(H + 'return S(P(echo("ghost", "plain\\n")))'))
            .toBe('nil,"console/label \'ghost\' does not exist"');
    });

    it('leaves a window created later under that name empty', () => {
        env.run('cecho("ghost", "<red>hello\\n"); echo("ghost", "plain\\n"); insertText("ghost", "ins")');
        env.run('createMiniConsole("ghost", 0, 0, 300, 200)');
        expect(env.run('return getLineCount("ghost")')).toBe(0);
        expect(env.run(H + 'return S(getLines("ghost", 0, 1))')).toBe('""');
    });
});

describe.each(Object.entries(KINDS))('text ops on a %s (mudlet-web#280)', (_kind, create) => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.run(create);
    });
    afterEach(() => env.dispose());

    it('deleteLine on the last, unterminated line deletes that line', () => {
        expect(env.run(H + 'echo("w", "A1\\nB1\\nC1"); moveCursor("w", 0, 2); deleteLine("w"); return all("w")'))
            .toBe('"A1","B1"');
        expect(env.run('return getLineCount("w")')).toBe(1);
        // B1 is the last line now, so the next echo carries on from it
        expect(env.run(H + 'echo("w", "x\\nnext"); return all("w")')).toBe('"A1","B1x","next"');
    });

    it('deleteLine on a middle line still deletes that one', () => {
        expect(env.run(H + 'echo("w", "A1\\nB1\\nC1"); moveCursor("w", 0, 1); deleteLine("w"); return all("w")'))
            .toBe('"A1","C1"');
    });

    it('paste at the end of the last, unterminated line appends onto it', () => {
        expect(env.run(H + `
            echo("w", "one two three\\nred rest\\n"); echo("w", "partial")
            moveCursor("w", 0, 0); selectString("w", "two", 1); copy("w")
            moveCursor("w", 7, 2); paste("w")
            return all("w")`)).toBe('"one two three","red rest","partialtwo",""');
    });

    it('appendBuffer writes onto the end of the unterminated line too', () => {
        expect(env.run(H + `
            echo("w", "abc\\n"); moveCursor("w", 0, 0); selectString("w", "b", 1); copy("w")
            echo("w", "tail"); appendBuffer("w")
            return all("w")`)).toBe('"abc","tailb",""');
    });

    it('insertLink moves the cursor past the link', () => {
        env.run('echo("w", "one two three\\n"); moveCursor("w", 2, 0); insertLink("w", "LL", "", "", true)');
        expect(env.run('return getColumnNumber("w")')).toBe(4);
        env.run('insertLink("w", "MM", "", "")');
        expect(env.run(H + 'return S(getLines("w", 0, 1))')).toBe('"onLLMMe two three"');
    });

    it('insertText after insertLink follows the link', () => {
        env.run('echo("w", "one two three\\n"); moveCursor("w", 2, 0); insertLink("w", "LL", "", "", true)');
        env.run('insertText("w", "ZZ")');
        expect(env.run(H + 'return S(getLines("w", 0, 1))')).toBe('"onLLZZe two three"');
    });

    it('setConsoleBufferSize trims as soon as the lines reach the limit', () => {
        expect(env.run(`
            setConsoleBufferSize("w", 20, 5)
            local r = {}
            for i = 1, 130 do
              echo("w", "line" .. i .. "\\n")
              if i == 99 or i == 100 or i == 101 or i == 110 or i == 130 then r[#r + 1] = getLineCount("w") end
            end
            return table.concat(r, "/") .. " " .. getLines("w", 0, 1)[1]`)).toBe('99/95/96/95/95 line36');
    });

    it('setConsoleBufferSize with a batch of 0 holds one under the limit', () => {
        expect(env.run(`
            setConsoleBufferSize("w", 150, 0)
            local m = 0
            for i = 1, 400 do echo("w", "line" .. i .. "\\n"); m = math.max(m, getLineCount("w")) end
            return m`)).toBe(149);
    });

    it('moveCursor past the end of a line keeps the column', () => {
        env.run('echo("w", "short\\n"); moveCursor("w", 20, 0)');
        expect(env.run('return getColumnNumber("w")')).toBe(20);
        env.run('insertText("w", "INS")');
        expect(env.run(H + 'return S(getLines("w", 0, 1))')).toBe('"short               INS"');
    });

    it('insertText answers true and selectCurrentLine answers nothing', () => {
        env.run('echo("w", "abc\\n"); moveCursor("w", 0, 0)');
        expect(env.run(H + 'return S(P(insertText("w", "x")))')).toBe('true');
        expect(env.run('return select("#", selectCurrentLine("w"))')).toBe(0);
        expect(env.run(H + 'return S(P(selectCurrentLine("nosuch")))')).toBe('nil,"window \\"nosuch\\" not found"');
    });
});
