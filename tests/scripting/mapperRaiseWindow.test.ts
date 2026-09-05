// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { MAPPER_WIDGET_ID } from '../../src/ui/windows/types';

// The embedded mapper has no name of its own — `createMapper` takes only a
// parent and a rectangle — so Mudlet lets the literal word "mapper" address it
// in raiseWindow/lowerWindow (TMainConsole::raiseWindow: `pM && !name.compare(
// QLatin1String("mapper"), Qt::CaseInsensitive)`). Geyser.Mapper:raise() is
// nothing but `raiseWindow("mapper")`, so a UI that restacks its own widgets —
// background label first, contents after — silently loses the map behind that
// background if the word resolves to nothing.
describe('raiseWindow/lowerWindow("mapper") — the embedded mapper', () => {
  let env: TestRuntime;
  beforeEach(async () => { env = await createTestRuntime(); });
  afterEach(() => env.dispose());

  it('is false while no embedded mapper exists', () => {
    expect(env.run('return (raiseWindow("mapper"))')).toBe(false);
    expect(env.run('return (lowerWindow("mapper"))')).toBe(false);
  });

  it('raises the mapper above a label created after it', () => {
    env.run('createMapper(0, 0, 300, 200)');
    env.run('createLabel("bg", 0, 0, 300, 200, 1)');
    const z = env.session.windows.overlayZ;
    // Creation order alone leaves the later label on top, as in Qt.
    expect(z.getZ('main', 'labels', 'bg'))
      .toBeGreaterThan(z.getZ('main', 'windows', MAPPER_WIDGET_ID));

    expect(env.run('return (raiseWindow("mapper"))')).toBe(true);
    expect(z.getZ('main', 'windows', MAPPER_WIDGET_ID))
      .toBeGreaterThan(z.getZ('main', 'labels', 'bg'));
  });

  it('lowers the mapper below a label created before it', () => {
    env.run('createLabel("bg2", 0, 0, 300, 200, 1)');
    env.run('createMapper(0, 0, 300, 200)');
    const z = env.session.windows.overlayZ;
    expect(env.run('return (lowerWindow("mapper"))')).toBe(true);
    expect(z.getZ('main', 'windows', MAPPER_WIDGET_ID))
      .toBeLessThan(z.getZ('main', 'labels', 'bg2'));
  });

  it('matches the name case-insensitively, as Qt::CaseInsensitive does', () => {
    env.run('createMapper(0, 0, 300, 200)');
    expect(env.run('return (raiseWindow("Mapper"))')).toBe(true);
    expect(env.run('return (lowerWindow("MAPPER"))')).toBe(true);
  });

  it('still lets a widget actually named "mapper" win the name', () => {
    env.run('createMapper(0, 0, 300, 200)');
    env.run('createLabel("mapper", 0, 0, 100, 100, 1)');
    const z = env.session.windows.overlayZ;
    const before = z.getZ('main', 'windows', MAPPER_WIDGET_ID);
    expect(env.run('return (raiseWindow("mapper"))')).toBe(true);
    // The label took the raise; the map widget did not move.
    expect(z.getZ('main', 'windows', MAPPER_WIDGET_ID)).toBe(before);
    expect(z.getZ('main', 'labels', 'mapper'))
      .toBeGreaterThan(z.getZ('main', 'windows', MAPPER_WIDGET_ID));
  });
});
