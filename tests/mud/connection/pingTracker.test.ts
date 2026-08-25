import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PingTracker, type PingEventSource } from '../../../src/mud/connection/PingTracker';

/** Minimal stand-in for the session EventBus: records the handler registered
 *  for each event so a test can fire it directly. */
function makeSource() {
  const handlers: Record<string, () => void> = {};
  const source: PingEventSource = {
    on: ((event: string, handler: () => void) => {
      handlers[event] = handler;
      return () => { delete handlers[event]; };
    }) as PingEventSource['on'],
  };
  return { source, fire: (event: string) => handlers[event]?.() };
}

describe('PingTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('always sends a latency body, never a bare Core.Ping', () => {
    // A bare `Core.Ping` leaves an empty string after the module name, which
    // servers that unconditionally JSON-parse the body reject with a visible
    // parse error. The spec's `Core.Ping <latency>` form avoids it.
    const send = vi.fn();
    const { source, fire } = makeSource();
    const tracker = new PingTracker(send, () => {}, source);

    fire('gmcp.negotiated');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(0); // nothing measured yet
    tracker.destroy();
  });

  it('reports the previous round-trip on subsequent pings', () => {
    const send = vi.fn();
    const measured: Array<number | null> = [];
    const { source, fire } = makeSource();
    const nowSpy = vi.spyOn(performance, 'now');
    const tracker = new PingTracker(send, d => measured.push(d), source);

    nowSpy.mockReturnValue(1000);
    fire('gmcp.negotiated');
    nowSpy.mockReturnValue(1042);
    fire('gmcp.core.ping'); // 42ms round trip; starts the repeating interval

    expect(measured).toEqual([42]);

    nowSpy.mockReturnValue(5000);
    vi.advanceTimersByTime(3000);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(42);
    tracker.destroy();
    nowSpy.mockRestore();
  });

  // The round trip is timed to the moment the reply's handler RUNS, and that
  // handler queues behind every trigger and script body on the one thread. So a
  // reply that arrived promptly but waited behind a long Lua call used to be
  // published as network latency — Mudlet/Mudlet#10108, whose amplifier is the
  // shipped mapper's `mmp.setmovetimer(getNetworkLatency())`.
  describe('a client stall is not published as network latency', () => {
    /** Drive `ms` of wall clock during which the event loop DOES run, so the
     *  100ms beat is delivered on schedule. */
    const runResponsively = (nowSpy: { mockReturnValue: (n: number) => void }, from: number, ms: number) => {
      for (let t = 100; t <= ms; t += 100) {
        nowSpy.mockReturnValue(from + t);
        vi.advanceTimersByTime(100);
      }
    };

    it('drops a reading measured across a frozen event loop', () => {
      const measured: Array<number | null> = [];
      const { source, fire } = makeSource();
      const nowSpy = vi.spyOn(performance, 'now');
      const tracker = new PingTracker(vi.fn(), d => measured.push(d), source);

      // A clean round trip first, so there is a measured value to fall back on.
      nowSpy.mockReturnValue(1000);
      fire('gmcp.negotiated');
      nowSpy.mockReturnValue(1130);
      fire('gmcp.core.ping');
      expect(measured).toEqual([130]);

      // Next ping goes out at 4000, then the thread blocks for 3s: no beat is
      // delivered, and the reply is only read at 7000.
      nowSpy.mockReturnValue(4000);
      vi.advanceTimersByTime(3000);
      nowSpy.mockReturnValue(7000);
      fire('gmcp.core.ping');

      // Without the guard this publishes ~3000ms of "latency".
      expect(measured).toEqual([130]);
      tracker.destroy();
      nowSpy.mockRestore();
    });

    it('still publishes a slow round trip when the client kept up', () => {
      // The same 3s wait, but the event loop ran throughout — that is a genuinely
      // slow network and must be reported, or the guard would swallow real lag.
      const measured: Array<number | null> = [];
      const { source, fire } = makeSource();
      const nowSpy = vi.spyOn(performance, 'now');
      const tracker = new PingTracker(vi.fn(), d => measured.push(d), source);

      nowSpy.mockReturnValue(1000);
      fire('gmcp.negotiated');
      runResponsively(nowSpy, 1000, 3000);
      nowSpy.mockReturnValue(4000);
      fire('gmcp.core.ping');

      expect(measured).toEqual([3000]);
      tracker.destroy();
      nowSpy.mockRestore();
    });

    it('publishes a round trip shorter than a single beat', () => {
      // The common case: the reply lands before the first beat ever fires, so
      // the only gap to judge is send→reply. It must not read as a stall.
      const measured: Array<number | null> = [];
      const { source, fire } = makeSource();
      const nowSpy = vi.spyOn(performance, 'now');
      const tracker = new PingTracker(vi.fn(), d => measured.push(d), source);

      nowSpy.mockReturnValue(1000);
      fire('gmcp.negotiated');
      nowSpy.mockReturnValue(1012);
      fire('gmcp.core.ping');

      expect(measured).toEqual([12]);
      tracker.destroy();
      nowSpy.mockRestore();
    });

    it('drops a reading when the stall lands after the last beat', () => {
      // The stall begins after a beat was delivered and runs until the reply, so
      // it is invisible to the beats themselves — only the final
      // last-beat-to-reply stretch witnesses it.
      const measured: Array<number | null> = [];
      const { source, fire } = makeSource();
      const nowSpy = vi.spyOn(performance, 'now');
      const tracker = new PingTracker(vi.fn(), d => measured.push(d), source);

      nowSpy.mockReturnValue(1000);
      fire('gmcp.negotiated');
      runResponsively(nowSpy, 1000, 200);
      nowSpy.mockReturnValue(3200); // 3s of nothing since the beat at 1200
      fire('gmcp.core.ping');

      expect(measured).toEqual([]);
      tracker.destroy();
      nowSpy.mockRestore();
    });

    it('keeps the held-over reading as the body of the next Core.Ping', () => {
      // A dropped reading must not leave the client reporting a stall to the
      // server either — the last MEASURED value is what stands.
      const send = vi.fn();
      const { source, fire } = makeSource();
      const nowSpy = vi.spyOn(performance, 'now');
      const tracker = new PingTracker(send, () => {}, source);

      nowSpy.mockReturnValue(1000);
      fire('gmcp.negotiated');
      nowSpy.mockReturnValue(1130);
      fire('gmcp.core.ping');

      nowSpy.mockReturnValue(4000);
      vi.advanceTimersByTime(3000); // ping #2 goes out, thread then freezes
      nowSpy.mockReturnValue(7000);
      fire('gmcp.core.ping');       // dropped

      nowSpy.mockReturnValue(10000);
      vi.advanceTimersByTime(3000); // ping #3
      expect(send).toHaveBeenLastCalledWith(130);
      tracker.destroy();
      nowSpy.mockRestore();
    });
  });
});
