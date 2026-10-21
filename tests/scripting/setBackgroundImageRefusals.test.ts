// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * TLuaInterpreter::setBackgroundImage refuses, in this order, before it looks
 * anything up: a mode outside 1..5; mode 5 ('cover') without the fullWindow
 * flag, whatever the window — the cover mode is only ever the full window's;
 * and the flag on anything but the main console. The path-first form
 * `(path, mode, fullWindow)` is the main console's.
 */
describe('setBackgroundImage refusals, as desktop', () => {
  let t: TestRuntime;
  const err = (call: string) => t.run(`local ok, e = ${call} return (ok == nil) and e or "accepted"`);
  const cover = "mode 'cover' is not supported for the main display - pass true as the 4th argument to apply it to the full window background instead";

  beforeAll(async () => {
    t = await createTestRuntime();
    t.run('createMiniConsole("bgMC", 0, 0, 400, 200)');
  });

  afterAll(() => t?.dispose());

  it('refuses cover without the full-window flag on the main console too', () => {
    expect(err('setBackgroundImage("main", "x.png", 5)')).toBe(cover);
    expect(err('setBackgroundImage("main", "x.png", "cover")')).toBe(cover);
    expect(err('setBackgroundImage("bgMC", "x.png", 5)')).toBe(cover);
    expect(err('setBackgroundImage("x.png", 5)')).toBe(cover);
  });

  it('refuses a mode outside 1 to 5', () => {
    expect(err('setBackgroundImage("main", "x.png", 6)'))
      .toBe("6 is not a valid mode! Valid modes are 1 'border', 2 'center', 3 'tile', 4 'style', 5 'cover'");
    expect(err('setBackgroundImage("bgMC", "x.png", 0)')).toMatch(/^0 is not a valid mode!/);
  });

  it('keeps the full window to the main console', () => {
    expect(err('setBackgroundImage("bgMC", "x.png", 5, true)'))
      .toBe('the full window background can only be used with the main console');
  });

  it('reads the path-first form with a flag as the main console\'s full window', () => {
    // Reaches the image check, which a missing file fails.
    expect(err('setBackgroundImage("missing.png", 5, true)'))
      .toBe("could not use 'missing.png' as a full window background image");
    expect(err('setBackgroundImage("main", "missing.png", 5, true)'))
      .toBe("could not use 'missing.png' as a full window background image");
  });
});
