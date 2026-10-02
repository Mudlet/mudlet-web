import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimerEngine } from '../../../src/mud/timers/TimerEngine';

// Issue #282 item 4. Every temp timer is a single-shot QTimer on desktop
// (TTimer.cpp: setSingleShot(isTemporary())). Qt stops it before delivering the
// timeout, and a repeat is only restarted by TimerUnit::timerFired after the
// body returns, so inside its own callback QTimer::remainingTime() is -1 and
// remainingTime() answers nil, "timer is inactive or expired".
describe('remainingTime inside a temp timer\'s own callback', () => {
  let engine: TimerEngine;

  beforeEach(() => { vi.useFakeTimers(); engine = new TimerEngine(); });
  afterEach(() => { engine.destroy(); vi.useRealTimers(); });

  it('a one-shot reports itself inactive', () => {
    const seen: number[] = [];
    const id: number = engine.addTemp(0.5, () => { seen.push(engine.remainingTime(id)); });
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([-1]);
  });

  it('a repeating timer reports itself inactive on every tick, and running between them', () => {
    const seen: number[] = [];
    const id: number = engine.addTemp(0.5, () => { seen.push(engine.remainingTime(id)); }, true);
    vi.advanceTimersByTime(1500);
    expect(seen).toEqual([-1, -1, -1]);
    vi.advanceTimersByTime(100);
    expect(engine.remainingTime(id)).toBeCloseTo(0.4, 5);
  });

  it('a repeat re-enabled from its own callback is running again', () => {
    // enableTimer restarts the QTimer on desktop, so it has time left.
    const seen: number[] = [];
    const id: number = engine.addTemp(0.5, () => {
      engine.setTempEnabled(id, false);
      engine.setTempEnabled(id, true);
      seen.push(engine.remainingTime(id));
    }, true);
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([0.5]);
  });

  it('another timer still sees it running', () => {
    let fromOther = NaN;
    const target = engine.addTemp(2, () => {});
    engine.addTemp(0.5, () => { fromOther = engine.remainingTime(target); });
    vi.advanceTimersByTime(500);
    expect(fromOther).toBeCloseTo(1.5, 5);
  });
});
