import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimerEngine } from '../../../src/mud/timers/TimerEngine';

// mudlet-web#257: TTimer::execute runs a one-shot's script first and only then
// stops it and marks it for cleanup, which TimerUnit::timerFired flushes once
// the script returns. So inside its own callback the timer still exists and is
// active; afterwards it is gone.
describe('TimerEngine one-shot temp timer inside its own callback', () => {
  let engine: TimerEngine;

  beforeEach(() => { vi.useFakeTimers(); engine = new TimerEngine(); });
  afterEach(() => { engine.destroy(); vi.useRealTimers(); });

  it('exists and is active while its body runs, and is freed after', () => {
    const seen: unknown[] = [];
    const id = engine.addTemp(1, () => {
      seen.push(engine.hasTemp(id), engine.tempIsActive(id), engine.tempCount);
    });
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true, true, 1]);
    expect(engine.hasTemp(id)).toBe(false);
    expect(engine.tempCount).toBe(0);
  });

  it('killTimer on itself answers true once, then false', () => {
    const seen: unknown[] = [];
    const id = engine.addTemp(1, () => {
      seen.push(engine.killTimer(id), engine.killTimer(id), engine.hasTemp(id), engine.tempIsActive(id));
    });
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true, false, true, false]);
    expect(engine.hasTemp(id)).toBe(false);
  });

  it('a disable + enable inside the body does not keep it alive', () => {
    const fn = vi.fn();
    const id: number = engine.addTemp(1, () => {
      fn();
      expect(engine.setTempEnabled(id, false)).toBe(true);
      expect(engine.setTempEnabled(id, true)).toBe(true);
    });
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(engine.hasTemp(id)).toBe(false);
  });

  it('is not fired a second time by a pump from inside its own body', () => {
    const fn = vi.fn();
    engine.addTemp(1, () => {
      fn();
      engine.pumpDue(Date.now() + 10_000);
    });
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('frees what the body killed once no timer body is left on the stack', () => {
    const other = engine.addTemp(100, () => {});
    let seenInside: boolean | undefined;
    engine.addTemp(1, () => {
      engine.killTimer(other);
      seenInside = engine.hasTemp(other);
    });
    vi.advanceTimersByTime(1000);
    expect(seenInside).toBe(true);
    expect(engine.hasTemp(other)).toBe(false);
  });
});
