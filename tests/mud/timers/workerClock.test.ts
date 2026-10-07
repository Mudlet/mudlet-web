import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerClock, workerClock, type ClockWorker, type ClockWorkerRequest } from '../../../src/mud/timers/workerClock';
import { TimerEngine } from '../../../src/mud/timers/TimerEngine';
import type { TimerNode } from '../../../src/storage/schema';

// mudlet-web#441: Chrome throttles main-thread setTimeout chains in a hidden
// tab to once a minute, so every Lua timer keeps its time in a dedicated
// worker instead and only runs its callback on the main thread.

/** Stands in for the inline clock worker. Its own timers run on the (fake)
 *  global setTimeout, as the real worker's run on the worker's. */
class FakeWorker implements ClockWorker {
  readonly posted: ClockWorkerRequest[] = [];
  terminated = false;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private onMessage: ((e: { data: unknown }) => void) | null = null;
  private onError: (() => void) | null = null;

  postMessage(msg: ClockWorkerRequest): void {
    this.posted.push(msg);
    if (msg.op === 'set') {
      this.timers.set(msg.id, setTimeout(() => {
        this.timers.delete(msg.id);
        this.onMessage?.({ data: msg.id });
      }, msg.ms));
    } else {
      clearTimeout(this.timers.get(msg.id));
      this.timers.delete(msg.id);
    }
  }
  addEventListener(type: 'message' | 'error', fn: never): void {
    if (type === 'message') this.onMessage = fn;
    else this.onError = fn;
  }
  terminate(): void {
    this.terminated = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
  /** Deliver a tick for `id` regardless of its timer — a post already in flight. */
  tick(id: number): void { this.onMessage?.({ data: id }); }
  fail(): void { this.onError?.(); }
  get armed(): number { return this.timers.size; }
}

describe('WorkerClock', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('without a Worker (fallback)', () => {
    it('the shared clock falls back to the global setTimeout here', () => {
      const fn = vi.fn();
      workerClock.setTimeout(fn, 100);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect((workerClock as WorkerClock).usingWorker).toBe(false);
    });

    it('clearTimeout cancels, and tolerates null, unknown and repeated handles', () => {
      const clock = new WorkerClock(() => null);
      const fn = vi.fn();
      const h = clock.setTimeout(fn, 50);
      clock.clearTimeout(h);
      clock.clearTimeout(h);
      clock.clearTimeout(null);
      clock.clearTimeout(undefined);
      clock.clearTimeout(12345);
      vi.advanceTimersByTime(100);
      expect(fn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('fires in due order, ties in the order they were set', () => {
      const clock = new WorkerClock(() => null);
      const order: string[] = [];
      clock.setTimeout(() => order.push('b'), 20);
      clock.setTimeout(() => order.push('a'), 10);
      clock.setTimeout(() => order.push('c'), 20);
      vi.advanceTimersByTime(20);
      expect(order).toEqual(['a', 'b', 'c']);
    });
  });

  describe('with a Worker', () => {
    let worker: FakeWorker;
    let clock: WorkerClock;
    beforeEach(() => {
      worker = new FakeWorker();
      clock = new WorkerClock(() => worker);
    });

    it('arms the timeout in the worker and runs the callback when it posts back', () => {
      const fn = vi.fn();
      const h = clock.setTimeout(fn, 250);
      expect(clock.usingWorker).toBe(true);
      expect(worker.posted).toEqual([{ op: 'set', id: h, ms: 250 }]);
      vi.advanceTimersByTime(249);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      // Delivered once only: a duplicate post finds nothing.
      worker.tick(h);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('clearTimeout tells the worker, and ignores a tick already in flight', () => {
      const fn = vi.fn();
      const h = clock.setTimeout(fn, 100);
      clock.clearTimeout(h);
      expect(worker.posted[1]).toEqual({ op: 'clear', id: h });
      expect(worker.armed).toBe(0);
      worker.tick(h);
      vi.advanceTimersByTime(200);
      expect(fn).not.toHaveBeenCalled();
    });

    it('clamps a negative or non-numeric delay to 0, as setTimeout does', () => {
      clock.setTimeout(() => {}, -5);
      clock.setTimeout(() => {}, NaN);
      expect(worker.posted.map((m) => (m.op === 'set' ? m.ms : -1))).toEqual([0, 0]);
    });

    it('a worker that fails to start moves its timeouts to the main thread, keeping their due time', () => {
      const early = vi.fn();
      const late = vi.fn();
      const cleared = vi.fn();
      clock.setTimeout(early, 100);
      clock.setTimeout(late, 500);
      clock.clearTimeout(clock.setTimeout(cleared, 300));
      vi.advanceTimersByTime(40);
      worker.fail();
      expect(worker.terminated).toBe(true);
      expect(clock.usingWorker).toBe(false);
      expect(vi.getTimerCount()).toBe(2);
      vi.advanceTimersByTime(59);
      expect(early).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(early).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(400);
      expect(late).toHaveBeenCalledTimes(1);
      expect(cleared).not.toHaveBeenCalled();
      // Later timeouts stay on the main thread.
      const after = vi.fn();
      clock.setTimeout(after, 10);
      expect(worker.posted.filter((m) => m.op === 'set')).toHaveLength(3);
      vi.advanceTimersByTime(10);
      expect(after).toHaveBeenCalledTimes(1);
    });
  });
});

describe('TimerEngine on the worker clock', () => {
  let worker: FakeWorker;
  let clock: WorkerClock;
  let engine: TimerEngine;
  beforeEach(() => {
    vi.useFakeTimers();
    worker = new FakeWorker();
    clock = new WorkerClock(() => worker);
    engine = new TimerEngine(clock);
  });
  afterEach(() => { engine.destroy(); vi.useRealTimers(); });

  it('uses the shared worker clock by default', () => {
    const fn = vi.fn();
    const spy = vi.spyOn(workerClock, 'setTimeout');
    const fresh = new TimerEngine();
    fresh.addTemp(1, fn);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 1000);
    fresh.destroy();
    spy.mockRestore();
  });

  it('arms temp timers in the worker and fires a repeat every interval', () => {
    const fn = vi.fn();
    const id = engine.addTemp(1, fn, true);
    expect(worker.posted).toEqual([{ op: 'set', id: expect.any(Number), ms: 1000 }]);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    // Each tick re-armed from its own callback, through the worker.
    expect(worker.posted.filter((m) => m.op === 'set')).toHaveLength(4);
    expect(engine.killTimer(id)).toBe(true);
    expect(worker.posted.at(-1)).toMatchObject({ op: 'clear' });
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('pumpDue fires a due timer early and cancels its worker tick', () => {
    const fn = vi.fn();
    engine.addTemp(1, fn);
    vi.setSystemTime(Date.now() + 1000);
    expect(engine.pumpDue()).toBe(1);
    expect(worker.posted.at(-1)).toMatchObject({ op: 'clear' });
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs permanent timers on it, and stops them on destroy', () => {
    const fired: string[] = [];
    const timer = {
      id: 't1', name: 'tick', isGroup: false, parentId: null, enabled: true,
      seconds: 0.5, code: '', language: 'lua', repeat: true,
    } as unknown as TimerNode;
    engine.loadPerm([timer], (t) => fired.push(t.name));
    vi.advanceTimersByTime(1500);
    expect(fired).toEqual(['tick', 'tick', 'tick']);
    engine.destroy();
    expect(worker.armed).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(fired).toHaveLength(3);
  });
});

