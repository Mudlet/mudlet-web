// @vitest-environment node
//
// Regression for the `line spacer` pattern type (Mudlet's REGEX_LINE_SPACER).
//
// Two defects, both of which made the type a no-op:
//   * `compileItem` dropped every pattern with a blank `text`, taking a spacer
//     with it — and the editor could never write a count into that field, so a
//     spacer was *always* blank. Mudlet keeps a blank REGEX_LINE_SPACER
//     (dlgTriggerEditor.cpp:5807) and stores the spin box value as the pattern
//     string (:5829-5830).
//   * the count was clamped to a minimum of 1. Mudlet parses it with
//     QString::toInt() (TTrigger.cpp:776) and 0 is a legal value — the spin box
//     defaults to it — meaning "already satisfied on the line the spacer is
//     reached" (TMatchState::lineSpacerMatch, TMatchState.h:68).

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';

function andTrigger(patterns: TriggerNode['patterns']): TriggerNode {
  return {
    id: 'spacer',
    name: 'spacer',
    enabled: true,
    isGroup: false,
    parentId: null,
    code: 'x',
    language: 'lua',
    fireLength: 0,
    multipleMatches: false,
    multiline: true,
    delta: 0,
    isFilter: false,
    patterns,
  } as TriggerNode;
}

/** Feed `lines` one at a time and count how many times the trigger fired. */
function fireCount(te: TriggerEngine, lines: string[]): number {
  let fired = 0;
  for (const line of lines) te.process(line, false, () => { fired++; });
  return fired;
}

describe('line spacer pattern', () => {
  let te: TriggerEngine;
  beforeEach(async () => { await TriggerEngine.ready(); te = new TriggerEngine(); });

  it('treats a 0 count as "no gap" rather than clamping it up to 1', () => {
    te.loadPerm([andTrigger([
      { type: 'regex', text: '^X$' },
      { type: 'lineSpacer', text: '0' },
      { type: 'regex', text: '^X$' },
    ])]);
    // Mudlet's lineSpacerMatch(0) is true on its first call, so both conditions
    // are satisfied by the one line. The old `n < 1 ? 1 : n` clamp turned this
    // into a one-line gap, and a single line could no longer complete it.
    expect(fireCount(te, ['X'])).toBe(1);
  });

  it('makes the next condition wait out the requested number of lines', () => {
    const patterns: TriggerNode['patterns'] = [
      { type: 'regex', text: '^SP ONE$' },
      { type: 'lineSpacer', text: '2' },
      { type: 'regex', text: '^SP TWO$' },
    ];
    te.loadPerm([andTrigger(patterns)]);
    expect(fireCount(te, ['SP ONE', 'SP TWO'])).toBe(0);

    te = new TriggerEngine();
    te.loadPerm([andTrigger(patterns)]);
    expect(fireCount(te, ['SP ONE', 'J1', 'SP TWO'])).toBe(1);
  });

  it('keeps a spacer whose count was never written into the pattern text', () => {
    // A spacer is the first condition, so — exactly as in Mudlet, where only
    // updateMultistates(0) opens a match state and match_line_spacer never
    // does — no state is ever opened and the trigger is inert. Before the fix
    // the blank spacer was compacted away, leaving `^X$` as condition 0 and
    // making the trigger fire.
    te.loadPerm([andTrigger([
      { type: 'lineSpacer', text: '' },
      { type: 'regex', text: '^X$' },
    ])]);
    expect(fireCount(te, ['X', 'X', 'X'])).toBe(0);
  });
});
