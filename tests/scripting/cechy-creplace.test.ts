// @vitest-environment node
//
// Regression for selectString + creplace gauge injection (Arkadia lvl_calc
// `cechy`). The script selects a stat word and replaces it with the word plus a
// colour-tagged "[value/10]" gauge via creplace (→ GUIUtils xReplace →
// delete selection, moveCursor(start), cinsertText). cinsertText's xEcho loop
// advances the cursor itself with moveCursor(getColumnNumber + len) after each
// colour segment; Mudlet Web's Console.insertText ALSO advanced the cursor, so every
// segment after the first landed one segment-length too far right — the gauge
// ended up inside the *next* word ("troch[8/10]e", "Jest es"). Console.insertText
// now leaves the cursor at the insertion point (Mudlet's native behavior), so the
// gauges land immediately after their matched word.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

function feedLine(env: TestRuntime, text: string, triggerBody?: string): void {
  const buffer = new AnsiAwareBuffer(text);
  env.api.beginLine(buffer);
  if (triggerBody) env.run(triggerBody);
  env.api.endLine();
  if (!buffer.deleted) env.session.events.emit('message', buffer, 'mud', Date.now());
  env.api.flushDeferredEcho();
}

// Mirrors misc.lvl_calc:cechy_replace — select stat word + val_to_next word,
// inject coloured gauges, then prefix the running sum.
const cechyBody = (m1: string, v1: number, m2: string, v2: number, sum: number) =>
  `if selectString("${m1}", 1) > -1 then creplace("${m1} <green>[${v1}/10]") end
   if selectString("${m2}", 1) > -1 then creplace("${m2} <green>[${v2}/5]") end
   prefix("<green>[${sum}]<reset> ", cecho)`;

describe('arkadia cechy creplace gauges', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('single-word val_to_next ("troche")', () => {
    feedLine(
      env,
      'Jestes mocarny i troche ci brakuje, zebys mogl wyzej ocenic swa sile.',
      cechyBody('mocarny', 8, 'troche', 2, 37),
    );
    expect(env.mainOutput).toEqual([
      '[37] Jestes mocarny [8/10] i troche [2/5] ci brakuje, zebys mogl wyzej ocenic swa sile.',
    ]);
  });

  it('multi-word val_to_next ("bardzo duzo")', () => {
    feedLine(
      env,
      'Jestes bystry i bardzo duzo ci brakuje, zebys mogl wyzej ocenic swoj intelekt.',
      cechyBody('bystry', 6, 'bardzo duzo', 0, 25),
    );
    expect(env.mainOutput).toEqual([
      '[25] Jestes bystry [6/10] i bardzo duzo [0/5] ci brakuje, zebys mogl wyzej ocenic swoj intelekt.',
    ]);
  });

  it('handles a stat with no val_to_next replacement collision', () => {
    feedLine(
      env,
      'Jestes dzielny i troche ci brakuje, zebys mogl wyzej ocenic swa odwage.',
      cechyBody('dzielny', 6, 'troche', 2, 27),
    );
    expect(env.mainOutput).toEqual([
      '[27] Jestes dzielny [6/10] i troche [2/5] ci brakuje, zebys mogl wyzej ocenic swa odwage.',
    ]);
  });
});
