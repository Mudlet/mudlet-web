// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { OSC8_DOCS_PHRASE, osc8DocumentationExamples } from '../../src/mud/text/osc8Docs';

// Mudlet's `!osc8-docs` easter egg (TBuffer::appendLine): a line printed through
// the echo family that carries the phrase is swallowed whole and a banner of
// worked OSC 8 examples goes into the MAIN console instead. Debounced to a
// second so an echo and the server response repeating it print it once.
describe('!osc8-docs documentation banner', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  const shown = (): string => env.mainOutput.join('\n');

  it('swallows the whole echo and prints the examples instead', () => {
    env.run(`echo("DOCS1 " .. ${JSON.stringify(OSC8_DOCS_PHRASE)} .. " DOCS2")`);
    expect(shown()).toContain('OSC 8 Hyperlink Examples');
    expect(shown()).toContain('wiki.mudlet.org');
    // The call is dropped whole, not just the phrase out of the middle of it.
    expect(shown()).not.toContain('DOCS1');
    expect(shown()).not.toContain('DOCS2');
  });

  it('prints into main however the echo was addressed', () => {
    env.run(`createMiniConsole("docsWin", 0, 0, 200, 100)
      echo("docsWin", ${JSON.stringify(OSC8_DOCS_PHRASE)})`);
    expect(shown()).toContain('OSC 8 Hyperlink Examples');
    // Nothing at all in the window the phrase was written to.
    expect(env.run('return getLines("docsWin", 0, 1)[1] or ""')).toBe('');
  });

  it('prints once within the debounce window', () => {
    env.run(`echo(${JSON.stringify(OSC8_DOCS_PHRASE)})`);
    const after = env.mainOutput.length;
    env.run(`echo(${JSON.stringify(OSC8_DOCS_PHRASE)})`);
    // Still swallowed — the phrase never belongs on screen — but not reprinted.
    expect(env.mainOutput.length).toBe(after);
    expect(shown()).not.toContain(OSC8_DOCS_PHRASE);
  });

  it('the banner is a real page of examples, not a stub', () => {
    const banner = osc8DocumentationExamples();
    expect(banner.split('\n').length).toBeGreaterThan(50);
    // Every section a reader is pointed at has to actually be in there.
    for (const heading of ['FUNDAMENTALS', 'JSON CONFIG', 'STYLING', 'MENUS & TOOLTIPS',
      'VISIBILITY', 'SPOILERS', 'DISABLED LINKS', 'SELECTION', 'COMPACT SYNTAX', 'PRESETS']) {
      expect(banner).toContain(heading);
    }
  });
});
