// @vitest-environment node
//
// A multiline (AND) trigger's line delta — Mudlet's `conditonLineDelta`.
//
// The delta bounds how far a part-way match state may travel: one opened on
// line S can still complete on lines S..S+delta and is gone by S+delta+1.
// Mudlet arrives there via TMatchState — mLineCount starts at 1 on the opening
// line, and `newLine()` (`!(mLineCount > mDelta)`) drops the state at the end of
// a line, after that line's completion check. So delta 0 is not "no limit": it
// means every condition has to be met on the one line that opened the state.
// mudix read 0 as unlimited, which made every AND trigger unbounded (its editor
// defaults the field to 0) and broke the XML round-trip in both directions.

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';

function andTrigger(delta: number, patterns: string[]): TriggerNode {
  return {
    id: 'and',
    name: 'and',
    enabled: true,
    isGroup: false,
    parentId: null,
    code: 'x',
    language: 'lua',
    fireLength: 0,
    multipleMatches: false,
    multiline: true,
    delta,
    isFilter: false,
    patterns: patterns.map(text => ({ type: 'regex', text })),
  } as TriggerNode;
}

/** Feed `lines` one at a time into a fresh engine and count the fires. */
async function fireCount(delta: number, patterns: string[], lines: string[]): Promise<number> {
  await TriggerEngine.ready();
  const te = new TriggerEngine();
  te.loadPerm([andTrigger(delta, patterns)]);
  let fired = 0;
  for (const line of lines) te.process(line, false, () => { fired++; });
  return fired;
}

const TWO = ['^one$', '^two$'];

describe('multiline trigger line delta', () => {
  beforeEach(async () => { await TriggerEngine.ready(); });

  it('completes a state on the line that opened it when the delta is 0', async () => {
    // Both conditions on one line is the only thing a 0 delta can complete, and
    // two different patterns can never match the same line — which is exactly
    // why Mudlet's 0 makes a two-condition trigger inert.
    expect(await fireCount(0, TWO, ['one', 'two'])).toBe(0);
    expect(await fireCount(0, ['^same$', '^same$'], ['same'])).toBe(1);
  });

  it('allows the remaining conditions up to delta lines after the first', async () => {
    expect(await fireCount(1, TWO, ['one', 'two'])).toBe(1);
    expect(await fireCount(2, TWO, ['one', 'pad', 'two'])).toBe(1);
    expect(await fireCount(3, TWO, ['one', 'pad', 'pad', 'two'])).toBe(1);
  });

  it('drops a state that reaches the line after its delta', async () => {
    expect(await fireCount(1, TWO, ['one', 'pad', 'two'])).toBe(0);
    expect(await fireCount(2, TWO, ['one', 'pad', 'pad', 'two'])).toBe(0);
  });

  it('lets a later first-condition match open a state the expired one could not finish', async () => {
    // The expiring state must not take the trigger with it: `one` on line 3
    // opens a fresh state that `two` on line 4 completes.
    expect(await fireCount(1, TWO, ['one', 'pad', 'one', 'two'])).toBe(1);
  });
});
