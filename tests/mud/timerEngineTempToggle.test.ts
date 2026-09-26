import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimerEngine } from '../../src/mud/timers/TimerEngine';

// Issue #172: a disabled temp timer must stop firing, and enabling it re-arms
// it for a full interval (Mudlet restarts the QTimer).
describe('TimerEngine temp timer enable/disable', () => {
  let engine: TimerEngine;

  beforeEach(() => { vi.useFakeTimers(); engine = new TimerEngine(); });
  afterEach(() => { engine.destroy(); vi.useRealTimers(); });

  it('a disabled repeating timer stops firing until re-enabled', () => {
    const fn = vi.fn();
    const id = engine.addTemp(0.1, fn, true);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(2);

    expect(engine.setTempEnabled(id, false)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(engine.tempIsActive(id)).toBe(false);
    expect(engine.remainingTime(id)).toBe(-1);
    expect(engine.pumpDue(Date.now() + 10_000)).toBe(0);

    expect(engine.setTempEnabled(id, true)).toBe(true);
    expect(engine.tempIsActive(id)).toBe(true);
    vi.advanceTimersByTime(99);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('a disabled one-shot does not fire, and fires a full interval after re-enabling', () => {
    const fn = vi.fn();
    const id = engine.addTemp(1, fn);
    vi.advanceTimersByTime(500);
    engine.setTempEnabled(id, false);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    engine.setTempEnabled(id, true);
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(engine.hasTemp(id)).toBe(false);
  });

  it('refuses unknown and killed timers', () => {
    expect(engine.setTempEnabled(12345, false)).toBe(false);
    const id = engine.addTemp(1, () => {});
    engine.killTimer(id);
    expect(engine.setTempEnabled(id, true)).toBe(false);
  });
});
