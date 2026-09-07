// @vitest-environment node
//
// Regression for GitHub issue #4: a permanent regex trigger that matches a
// URL *substring* of a line and does `selectString(matches[1], 1)` highlighted
// the WHOLE line instead of just the URL. Root cause: the perm-trigger dispatch
// passed the whole plain line as matches[1] (Lua) instead of the matched text,
// diverging from Mudlet (matches[1] = whole match) and from Mudlet Web's own temp
// trigger path. Anchored `^...$` test patterns hid it because there the whole
// match equals the whole line.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { TriggerEngine } from '../../src/mud/triggers/TriggerEngine';
import { AnsiAwareBuffer } from '../../src/mud/text/FormatState';

describe('issue 4 — perm regex trigger matches[1] is the match, not the line', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('matches[1] equals the matched URL substring for an unanchored regex', () => {
    // A standalone TriggerEngine matching the Clicker-style URL regex.
    const engine = new TriggerEngine();
    engine.loadPerm([
      {
        id: 't1', name: 'clicker', isGroup: false, parentId: null,
        enabled: true, language: 'lua', code: 'noop()',
        patterns: [{ type: 'regex', text: 'https?://[^\\s]+' }],
      } as never,
    ]);

    const line = 'Visit http://example.com today';
    const got = engine.matchPerm(line);
    expect(got.length).toBe(1);
    // The bug: code used `plain` (whole line) for matches[1]; the fix uses
    // matchedText. Confirm the engine reports the matched substring.
    expect(got[0].matchedText).toBe('http://example.com');

    // Now replicate exactly what ScriptingEngine.executePermTrigger feeds to
    // the Lua runtime (post-fix: [matchedText, ...captures]) and read matches[1].
    const m = got[0];
    let seen: unknown;
    env.run('__issue4 = nil');
    env.rt.runWithMatches(
      '__issue4 = matches[1]', 'clicker',
      [m.matchedText, ...m.captures],
      m.multimatches, m.namedGroups, m.captureSpans, m.namedSpans,
      m.matchStart !== undefined ? { start: m.matchStart, length: m.matchedText.length } : undefined,
    );
    seen = env.run('return __issue4');
    expect(seen).toBe('http://example.com');
  });

  it('selectString(matches[1]) highlights only the URL, not the whole line', () => {
    const buffer = new AnsiAwareBuffer('Visit http://example.com today');
    env.api.beginLine(buffer);
    env.rt.runWithMatches(
      [
        'selectString(matches[1], 1)',
        'setLink(function() end, "open")',
        'setBold(true); setUnderline(true)',
        'deselect(); setBold(false); setUnderline(false)',
      ].join('\n'),
      'clicker',
      ['http://example.com'],
    );
    env.api.endLine();
    const html = buffer.toHtml();
    // Only the URL run carries the link/bold/underline.
    expect(html).toBe(
      'Visit <span style="font-weight: bold; text-decoration: underline; cursor: pointer;" data-output-clickable="true" title="open">http://example.com</span> today',
    );
  });
});

// setMatches builds matches/multimatches/namedCaptures with raw lua_createtable
// pushes (≈2.4× cheaper than wasmoon's auto-converting global.set). Lock the full
// table shape so the optimization can't silently drop the named-capture merge or
// the multimatches nesting.
describe('setMatches — raw-stack table shape', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('exposes numeric + named captures on matches, plus namedCaptures and multimatches', () => {
    env.rt.runWithMatches(
      'R = { matches[1], matches[2], matches[3], matches.hp, namedCaptures.hp, multimatches[1][2] }',
      'shape',
      ['HP 137/200', '137', '200'],   // matches: whole match + 2 captures
      [['rowFull', 'rowCap']],        // multimatches: one row
      { hp: '137' },                  // named groups
    );
    expect(env.run('return R[1]')).toBe('HP 137/200');
    expect(env.run('return R[2]')).toBe('137');
    expect(env.run('return R[3]')).toBe('200');
    expect(env.run('return R[4]')).toBe('137');   // named merged onto matches
    expect(env.run('return R[5]')).toBe('137');   // separate namedCaptures table
    expect(env.run('return R[6]')).toBe('rowCap'); // multimatches[1][2]
  });

  it('leaves an unmatched optional group as nil (not empty string)', () => {
    env.rt.runWithMatches(
      'A = (matches[2] == nil); B = matches[3]',
      'optional',
      ['full', undefined, 'third'],
    );
    expect(env.run('return A')).toBe(true);
    expect(env.run('return B')).toBe('third');
  });
});
