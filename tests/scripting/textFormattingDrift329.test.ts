// @vitest-environment node
//
// Text formatting that answered differently from desktop Mudlet PTB
// (mudlet-web#329). Every expectation is what desktop printed for the same
// Lua: formats are read back one character at a time with selectSection +
// getFgColor/getBgColor/getTextFormat and grouped into `"text"@fg/bg/flags`
// runs, where B = bold, I = italic, U = underline, S = strikeout, R = reverse.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

/** The per-line sequence ScriptingEngine.processFlushBatch runs. */
function feedLine(env: TestRuntime, text: string, triggerBody?: string): void {
    const buffer = new AnsiAwareBuffer(text);
    env.api.beginLine(buffer);
    if (triggerBody) env.run(triggerBody);
    env.api.endLine();
    if (!buffer.deleted) env.session.events.emit('message', buffer, 'mud', Date.now());
    env.api.flushDeferredEcho();
}

const RUNS = `
function runs(w, from, to)
  local line = getCurrentLine(w)
  from = from or 0
  to = to or #line
  local out, last = {}, nil
  for i = from, to - 1 do
    selectSection(w, i, 1)
    local fr, fg, fb = getFgColor(w)
    local br, bg, bb = getBgColor(w)
    local t = getTextFormat(w)
    local flags = (t.bold and "B" or "") .. (t.italic and "I" or "") .. (t.underline and "U" or "")
      .. (t.strikeout and "S" or "") .. (t.reverse and "R" or "")
    local key = string.format("@%d,%d,%d/%d,%d,%d", fr, fg, fb, br, bg, bb) .. (flags ~= "" and "/" .. flags or "")
    if last and last.key == key then
      last.text = last.text .. line:sub(i + 1, i + 1)
    else
      last = { key = key, text = line:sub(i + 1, i + 1) }
      out[#out + 1] = last
    end
  end
  deselect(w)
  local s = {}
  for _, r in ipairs(out) do s[#s + 1] = string.format("%q", r.text) .. r.key end
  return table.concat(s, " ")
end
`;

describe('set* on a mixed selection keeps each character\'s other attributes (mudlet-web#329)', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.run(RUNS);
    });
    afterEach(() => env.dispose());

    it('setBold over coloured server text keeps the colours', () => {
        feedLine(env, 'X1 \x1b[31mred\x1b[32mgreen\x1b[0m plain',
            'selectCurrentLine() setBold(true) deselect() result = runs("main")');
        expect(env.run('return result')).toBe(
            '"X1 "@192,192,192/0,0,0/B "red"@128,0,0/0,0,0/B "green"@0,128,0/0,0,0/B " plain"@192,192,192/0,0,0/B');
    });

    it('setFgColor keeps per-character backgrounds', () => {
        feedLine(env, 'X3 \x1b[41mA\x1b[44mB\x1b[0m C',
            'selectCurrentLine() setFgColor(1, 2, 3) deselect() result = runs("main")');
        expect(env.run('return result')).toBe(
            '"X3 "@1,2,3/0,0,0 "A"@1,2,3/128,0,0 "B"@1,2,3/0,0,128 " C"@1,2,3/0,0,0');
    });

    it('setItalics keeps bold and underline where they were', () => {
        feedLine(env, 'X4 \x1b[1mbold\x1b[0m norm \x1b[4munder\x1b[0m',
            'selectCurrentLine() setItalics(true) deselect() result = runs("main")');
        expect(env.run('return result')).toBe(
            '"X4 "@192,192,192/0,0,0/I "bold"@192,192,192/0,0,0/BI " norm "@192,192,192/0,0,0/I'
            + ' "under"@192,192,192/0,0,0/IU');
    });

    it('setStrikeOut on a selectString span keeps its colours', () => {
        feedLine(env, 'X7 \x1b[31mred\x1b[0m and \x1b[44mblue\x1b[0m',
            'selectString("red and blue", 1) setStrikeOut(true) deselect() result = runs("main", 3)');
        expect(env.run('return result')).toBe(
            '"red"@128,0,0/0,0,0/S " and "@192,192,192/0,0,0/S "blue"@192,192,192/0,0,128/S');
    });

    it('a miniconsole selection keeps its cecho colours and bold', () => {
        env.run('createMiniConsole("mc", 0, 0, 300, 200)');
        env.run('cecho("mc", "M1 <red>red<green>green<reset> <b>bold</b> plain")');
        env.run('selectSection("mc", 3, 12) setUnderline("mc", true) deselect("mc")');
        expect(env.run('return runs("mc", 3, 15)')).toBe(
            '"red"@255,0,0/0,0,0/U "green"@0,255,0/0,0,0/U " "@192,192,192/0,0,0/U "bol"@192,192,192/0,0,0/BU');
    });
});

describe('each window keeps its own selection (mudlet-web#329)', () => {
    let env: TestRuntime;
    beforeEach(async () => {
        env = await createTestRuntime();
        env.run(RUNS);
        env.run('createMiniConsole("mc", 0, 0, 300, 200)');
        env.run('echo("mc", "one two three\\nred green blue\\nfour five\\n")');
    });
    afterEach(() => env.dispose());

    it('selecting in a miniconsole leaves the main selection standing', () => {
        feedLine(env, 'Q01 alpha beta gamma', `
            selectString("beta", 1)
            moveCursor("mc", 0, 1) selectString("mc", "green", 1)
            sel = getSelection()
            setBold(true) setFgColor(255, 0, 0)
            deselect() result = runs("main", 10, 14)`);
        expect(env.run('return sel')).toBe('beta');
        expect(env.run('return result')).toBe('"beta"@255,0,0/0,0,0/B');
        expect(env.run('return (getSelection("mc"))')).toBe('green');
    });

    it('deselecting a miniconsole leaves the main selection standing', () => {
        feedLine(env, 'Q02 one two three', `
            selectString("two", 1)
            moveCursor("mc", 0, 1) selectString("mc", "red", 1)
            deselect("mc")
            sel = getSelection()`);
        expect(env.run('return sel')).toBe('two');
    });

    it('selecting in main leaves the miniconsole selection for set*', () => {
        feedLine(env, 'Q03 four five six', `
            moveCursor("mc", 0, 1) selectString("mc", "red", 1)
            selectString("five", 1)
            setFgColor("mc", 0, 255, 0)
            result = runs("mc", 0, 3)`);
        expect(env.run('return result')).toBe('"red"@0,255,0/0,0,0');
    });
});

describe('insertText with a newline leaves the cursor where it was (mudlet-web#329)', () => {
    let env: TestRuntime;
    beforeEach(async () => { env = await createTestRuntime(); });
    afterEach(() => env.dispose());

    it('on a history line', () => {
        feedLine(env, 'K04 before');
        feedLine(env, 'K05 abc');
        feedLine(env, 'K06 after');
        env.run(`
            l = getLineNumber() - 1
            moveCursor(3, l) insertText("p\\nq")
            result = (getLineNumber() - l) .. " " .. getColumnNumber() .. " " .. getCurrentLine()
            insertText("W")`);
        expect(env.run('return result')).toBe('0 3 K05p');
        expect(env.run('return table.concat(getLines(l, l + 3), "|")')).toBe('K05Wp|q abc|K06 after');
    });

    it('on the line a trigger is processing', () => {
        feedLine(env, 'K03 abc', 'moveCursor(3, getLineNumber()) insertText("x\\ny\\nz") insertText("W")'
            + ' l = getLineNumber()');
        expect(env.run('return table.concat(getLines(l, l + 3), "|")')).toBe('K03Wx|y|z abc');
    });

    it('on a miniconsole\'s open line the cursor was moved to', () => {
        env.run('createMiniConsole("mc", 0, 0, 300, 200) echo("mc", "A1\\nK07 abc")');
        env.run('moveCursor("mc", 3, 1) insertText("mc", "p\\nq")');
        expect(env.run('return getLineNumber("mc") .. " " .. getColumnNumber("mc") .. " " .. getCurrentLine("mc")'))
            .toBe('1 3 K07p');
    });
});
