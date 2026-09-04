// @vitest-environment node
//
// The AND-trigger table, measured against a real desktop Mudlet rather than read
// off its source. Every `fired` below is what Mudlet 5.0.1 actually did.
//
// How it was taken: a throwaway profile (isolated via XDG_CONFIG_HOME so the
// tester's own config was untouched) whose `current/*.xml` held one multiline
// trigger per case — patterns written straight into `regexCodeList` with their
// kinds in `regexCodePropertyList`, REGEX_PERL 1 and REGEX_LINE_SPACER 5 — plus
// a script that fed each case's lines through `feedTriggers`, wrote the fire
// counts to a file and called `closeMudlet()`. Launched as
// `Mudlet.exe --profile=<name>`, which auto-opens the profile.
//
// Two things this settles, both of which mudix had wrong:
//   * a line spacer of N is a *minimum* gap, not an exact one — spacer 1 fires
//     whether the second condition arrives 1, 2 or 3 lines later (S1..S3), so
//     the expectation in mudlet-web#57 ("only the middle case fires") was not
//     desktop behaviour. Only middle-fires-alone is spacer 2 with delta 2.
//   * `conditonLineDelta` 0 is not "no limit": two conditions on separate lines
//     never complete under it (D0A), while two met on one line do (D0B).

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';

type Pattern = TriggerNode['patterns'][number];
const perl = (text: string): Pattern => ({ type: 'regex', text });
const spacer = (n: number): Pattern => ({ type: 'lineSpacer', text: String(n) });

/** tag, delta, patterns, lines fed one at a time, fires Mudlet 5.0.1 reported. */
const MEASURED: Array<[string, number, Pattern[], string[], number]> = [
  // A spacer of 1 with room to spare: all three fire on the desktop.
  ['S1', 3, [perl('^S1 ONE$'), spacer(1), perl('^S1 TWO$')], ['S1 ONE', 'S1 TWO'], 1],
  ['S2', 3, [perl('^S2 ONE$'), spacer(1), perl('^S2 TWO$')], ['S2 ONE', 'JUNK', 'S2 TWO'], 1],
  ['S3', 3, [perl('^S3 ONE$'), spacer(1), perl('^S3 TWO$')], ['S3 ONE', 'J1', 'J2', 'S3 TWO'], 1],
  // Spacer 2 with delta 2 — the only configuration where just the middle fires:
  // the spacer holds the second condition off until line 3, and the delta drops
  // the state before line 4.
  ['T1', 2, [perl('^T1 ONE$'), spacer(2), perl('^T1 TWO$')], ['T1 ONE', 'T1 TWO'], 0],
  ['T2', 2, [perl('^T2 ONE$'), spacer(2), perl('^T2 TWO$')], ['T2 ONE', 'JUNK', 'T2 TWO'], 1],
  ['T3', 2, [perl('^T3 ONE$'), spacer(2), perl('^T3 TWO$')], ['T3 ONE', 'J1', 'J2', 'T3 TWO'], 0],
  // A spacer of 0 is satisfied on the line it is reached on, so it neither
  // delays the next condition nor stops one line completing the whole chain.
  ['Z1', 3, [perl('^Z1 ONE$'), spacer(0), perl('^Z1 TWO$')], ['Z1 ONE', 'Z1 TWO'], 1],
  ['Z2', 3, [perl('^Z2 BOTH$'), spacer(0), perl('^Z2 BOTH$')], ['Z2 BOTH'], 1],
  // No spacer: the delta bound on its own. A state opened on line S completes on
  // S..S+delta and is gone by S+delta+1.
  ['D0A', 0, [perl('^D0A ONE$'), perl('^D0A TWO$')], ['D0A ONE', 'D0A TWO'], 0],
  ['D0B', 0, [perl('^D0B X$'), perl('^D0B X$')], ['D0B X'], 1],
  ['D1A', 1, [perl('^D1A ONE$'), perl('^D1A TWO$')], ['D1A ONE', 'D1A TWO'], 1],
  ['D1B', 1, [perl('^D1B ONE$'), perl('^D1B TWO$')], ['D1B ONE', 'PAD', 'D1B TWO'], 0],
  ['D2', 2, [perl('^D2 ONE$'), perl('^D2 TWO$')], ['D2 ONE', 'PAD', 'D2 TWO'], 1],
];

describe('AND trigger behaviour measured against Mudlet 5.0.1', () => {
  beforeEach(async () => { await TriggerEngine.ready(); });

  it.each(MEASURED)('%s fires %#', (tag, delta, patterns, lines, expected) => {
    const te = new TriggerEngine();
    te.loadPerm([{
      id: tag, name: tag, enabled: true, isGroup: false, parentId: null,
      code: 'x', language: 'lua', fireLength: 0, multipleMatches: false,
      multiline: true, delta, isFilter: false, patterns,
    } as TriggerNode]);

    let fired = 0;
    for (const line of lines) te.process(line, false, () => { fired++; });
    expect(fired).toBe(expected);
  });
});
