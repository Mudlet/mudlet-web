// @vitest-environment node
//
// Regression for trigger `cecho`/`echo` placement during a multi-line flush
// batch. Mudlet inserts a trigger's echoed text right after the line it fired
// on (the cursor sits on the matching line). Mudlet Web used to defer EVERY echo in
// a flush batch to the very end of the batch, so an echo from a trigger on the
// 6th line of a 10-line block landed below the 10th line instead of after the
// 6th. This drove the Arkadia "package board" bug: `mail.lua:check_table`
// does `cecho("\n |  Winiarnia |")` while the package-6 line is processed, and
// the inserted line showed up below the whole table.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

/**
 * Replays the per-line sequence ScriptingEngine.processFlushBatch performs for
 * each network line: append + open trigger processing (beginLine), run the
 * trigger body, close it (endLine), render the line, then flush that line's
 * deferred echoes. `triggerBody` (Lua) stands in for the matched trigger's
 * script and runs while the cursor is on `text`.
 */
function feedLine(env: TestRuntime, text: string, triggerBody?: string): void {
  const buffer = new AnsiAwareBuffer(text);
  env.api.beginLine(buffer);
  if (triggerBody) env.run(triggerBody);
  env.api.endLine();
  if (!buffer.deleted) env.session.events.emit('message', buffer, 'mud', Date.now());
  env.api.flushDeferredEcho();
}

describe('trigger echo placement within a flush batch', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('places a trigger cecho right after the line it fired on, not at batch end', () => {
    feedLine(env, '| 5. Harmut Kenntemich, Ubersreik |');
    feedLine(env, '| 6. Laurent Noiret, Quenelles |', 'cecho("\\n |      Winiarnia |")');
    feedLine(env, '| Symbolem * oznaczono przesylki ciezkie. |');

    expect(env.mainOutput).toEqual([
      '| 5. Harmut Kenntemich, Ubersreik |',
      '| 6. Laurent Noiret, Quenelles |',
      ' |      Winiarnia |',
      '| Symbolem * oznaczono przesylki ciezkie. |',
    ]);
  });

  it('does not emit a spurious blank line for a leading-newline trigger echo', () => {
    feedLine(env, 'package line', 'cecho("\\nINSERTED")');
    expect(env.mainOutput).toEqual(['package line', 'INSERTED']);
  });

  it('keeps later lines numbered correctly after an inserted echo line', () => {
    feedLine(env, 'first');
    feedLine(env, 'second', 'cecho("\\nINSERT")');
    // After "first", "second", and the inserted "INSERT", the next appended
    // line must be line index 3 (0-based) — proving the inserted echo line was
    // promoted into history rather than wiping the buffer.
    let lineNo = -1;
    feedLine(env, 'third', 'lineNoSeen = getLineNumber()');
    lineNo = env.run('return lineNoSeen') as number;
    expect(lineNo).toBe(3);
  });

  it('multiple per-line echoes each land after their own line', () => {
    feedLine(env, 'A', 'cecho("\\nafterA")');
    feedLine(env, 'B');
    feedLine(env, 'C', 'cecho("\\nafterC")');

    expect(env.mainOutput).toEqual(['A', 'afterA', 'B', 'C', 'afterC']);
  });

  // Mudlet's echo/cecho WITHOUT a leading newline appends to the matched line at
  // the output cursor (end of line), not a fresh line. The Arkadia `value.lua`
  // grade trigger does `replace(""); cecho("390 miedziakow, czyli ...")` — the
  // appended money string was landing on the next row in mudlet.
  it('appends a leading-newline-less trigger cecho to the matched line', () => {
    feedLine(
      env,
      'Wydaje ci sie, ze sa warte okolo 390 miedziakow.',
      'selectString("390 miedziakow.", 1); replace(""); ' +
        'cecho("390 miedziakow, czyli 1 zl, 12 sr, 6 mdz.")',
    );
    expect(env.mainOutput).toEqual([
      'Wydaje ci sie, ze sa warte okolo 390 miedziakow, czyli 1 zl, 12 sr, 6 mdz.',
    ]);
  });

  it('appends across multiple no-newline echoes onto the same matched line', () => {
    feedLine(env, 'base', 'echo(" foo"); echo(" bar")');
    expect(env.mainOutput).toEqual(['base foo bar']);
  });

  // suffix() is exactly this pattern: append decoration to the end of the line.
  it('keeps a prefix + trailing echo on the matched line (Arkadia grade trigger)', () => {
    feedLine(
      env,
      'Oceniasz starannie ciemnoblekitne lniane spodnie.',
      'prefix("======= "); echo(" ========")',
    );
    expect(env.mainOutput).toEqual([
      '======= Oceniasz starannie ciemnoblekitne lniane spodnie. ========',
    ]);
  });
});
