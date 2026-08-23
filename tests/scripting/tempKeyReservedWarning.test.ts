// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Lua tempKey(modifier, keyCode, fn): modifier is a Qt::KeyboardModifier bitmask
// (Ctrl = 0x04000000, Meta/Cmd = 0x10000000), keyCode a Qt::Key int
// (Key_T = 0x54, Key_R = 0x52).
const CTRL = 0x04000000;
const META = 0x10000000;

// Which combo the browser owns depends on the platform: Ctrl+T opens a tab on
// Windows/Linux, Cmd+T on macOS. `detectAccel` reads `navigator.platform`, and
// the node test environment supplies a real one — so leaving it to the host
// makes these tests pass on CI and fail on a Mac. Pin it, and cover both.
const PLATFORMS = [
  { name: 'Windows/Linux', platform: 'Linux x86_64', accelMod: CTRL, accelLabel: 'Ctrl' },
  { name: 'macOS', platform: 'MacIntel', accelMod: META, accelLabel: 'Cmd' },
];

describe.each(PLATFORMS)('tempKey browser-reserved warning on $name', ({ platform, accelMod, accelLabel }) => {
  let env: TestRuntime;
  let realNavigator: PropertyDescriptor | undefined;

  beforeEach(async () => {
    realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true });
    env = await createTestRuntime();
  });
  afterEach(() => {
    env.dispose();
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
  });

  const combo = `${accelLabel}+T`;

  it(`warns when a script binds a browser-owned combo (${combo})`, () => {
    env.run(`tempKey(${accelMod}, 0x54, function() end)`);
    const out = env.mainOutput.join('\n');
    expect(out).toContain(combo);
    expect(out).toContain("can't reach mudix");
  });

  it('reports the call site (script:line) that registered the key', () => {
    // Run a named chunk so debug.getinfo has a source to report.
    env.rt.run(`tempKey(${accelMod}, 0x54, function() end)`, 'MyMapper');
    const line = env.mainOutput.find(l => l.includes(combo));
    expect(line).toContain('from MyMapper');
  });

  it(`does not warn for a page-capturable combo (${accelLabel}+R)`, () => {
    // Reload is the browser's, but a page can preventDefault it, so mudix binds
    // it like Mudlet does — while the client has focus.
    env.run(`tempKey(${accelMod}, 0x52, function() end)`);
    expect(env.mainOutput.join('\n')).not.toContain('WARN');
  });

  it('warns only once per combo, even if re-registered', () => {
    env.run(`tempKey(${accelMod}, 0x54, function() end)`);
    env.run(`tempKey(${accelMod}, 0x54, function() end)`);
    expect(env.mainOutput.filter(l => l.includes(combo))).toHaveLength(1);
  });

  it('does not warn for the other platform\'s accelerator', () => {
    // The whole point of the accel indirection: Ctrl+T is an ordinary binding
    // on macOS, and Cmd+T is an ordinary binding everywhere else.
    const otherMod = accelMod === CTRL ? META : CTRL;
    env.run(`tempKey(${otherMod}, 0x54, function() end)`);
    expect(env.mainOutput.join('\n')).not.toContain('WARN');
  });
});
