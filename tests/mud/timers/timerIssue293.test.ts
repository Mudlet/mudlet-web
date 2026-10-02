// @vitest-environment node
//
// mudlet-web#293, two timer drifts against Mudlet desktop:
//
// 1. TimerUnit::killTimer looks its argument up by *name*, and a temp timer's
//    name is the id tempTimer returned, so `killTimer(tostring(id))` kills it.
// 2. A repeating timer whose own body runs longer than its interval does not
//    fire again the moment the body returns: desktop's next tick comes at least
//    one interval later (0.2s timer, 0.5s body: ticks at 0.2, 0.9, 1.1, ...).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { TimerEngine } from '../../../src/mud/timers/TimerEngine';
import type { TimerNode } from '../../../src/storage/schema';
import { createTestRuntime, type TestRuntime } from '../../createTestRuntime';

describe('killTimer(tostring(id)) on a temp timer (#293 item 1)', () => {
    let t: TestRuntime;
    beforeAll(async () => { t = await createTestRuntime(); });
    afterAll(() => t.dispose());

    // `exists`/`isActive` are answered by ScriptingEngine, which this runtime
    // doesn't construct; the TimerEngine behind them is asked directly.
    it('kills it, as desktop does', () => {
        const a = t.run('__issue293_a = tempTimer(2, function() end) return __issue293_a') as number;
        expect(t.run('return killTimer(tostring(__issue293_a))')).toBe(true);
        expect(t.run('return killTimer(tostring(__issue293_a))')).toBe(false);
        // Found but stopped until the reap: desktop's exists 1, isActive 0.
        expect(t.api.timers.hasTemp(a)).toBe(true);
        expect(t.api.timers.tempIsActive(a)).toBe(false);
    });

    it('only matches the exact spelling of the id', () => {
        const a = t.run('__issue293_b = tempTimer(2, function() end) return __issue293_b') as number;
        expect(t.run('return killTimer("0" .. tostring(__issue293_b))')).toBe(false);
        expect(t.api.timers.tempIsActive(a)).toBe(true);
        t.run('killTimer(__issue293_b)');
    });

    it('still answers false for a name nothing has', () => {
        expect(t.run('return killTimer("no such timer")')).toBe(false);
        expect(t.run('return killTimer("987654321")')).toBe(false);
    });

    it('the killed timer never fires', () => {
        vi.useFakeTimers();
        try {
            t.run(`
                __issue293_fired = false
                local a = tempTimer(1, function() __issue293_fired = true end)
                killTimer(tostring(a))
            `);
            vi.advanceTimersByTime(5000);
            expect(t.run('return __issue293_fired')).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('repeating timer with a body slower than its interval (#293 item 2)', () => {
    // vi's fake timers can't model a busy body: moving the clock from inside a
    // callback either fires timers re-entrantly (advanceTimersByTime) or skews
    // Date.now() off the timer timeline (setSystemTime). So this is a minimal
    // single-threaded event loop: one clock, a timeout queue, and a callback
    // that runs to completion while the clock moves under it — what a slow
    // body on the real main thread does.
    let now = 0;
    let seq = 0;
    let queue: Array<{ id: number; due: number; fn: () => void }> = [];
    const busy = (ms: number) => { now += ms; };
    const runUntil = (end: number) => {
        for (;;) {
            queue.sort((a, b) => a.due - b.due || a.id - b.id);
            const next = queue[0];
            if (!next || next.due > end) break;
            queue.shift();
            now = Math.max(now, next.due);
            next.fn();
        }
        now = Math.max(now, end);
    };

    let engine: TimerEngine;
    beforeEach(() => {
        now = 0; seq = 0; queue = [];
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
            const id = ++seq;
            queue.push({ id, due: now + (ms ?? 0), fn });
            return id;
        }) as unknown as typeof setTimeout);
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
            queue = queue.filter(t => t.id !== id);
        }) as unknown as typeof clearTimeout);
        engine = new TimerEngine();
    });
    afterEach(() => { engine.destroy(); vi.restoreAllMocks(); });

    it('temp: the next tick comes a full interval after a slow first body', () => {
        const fired: number[] = [];
        engine.addTemp(0.2, () => {
            fired.push(Date.now());
            if (fired.length === 1) busy(500);
        }, true);
        runUntil(1400);
        // desktop: 0.201 0.901 1.103 1.303
        expect(fired).toEqual([200, 900, 1100, 1300]);
    });

    it('temp: same for a slow second body', () => {
        const fired: number[] = [];
        engine.addTemp(0.2, () => {
            fired.push(Date.now());
            if (fired.length === 2) busy(700);
        }, true);
        runUntil(1550);
        // desktop: 0.201 0.403 1.303 1.504
        expect(fired).toEqual([200, 400, 1300, 1500]);
    });

    it('temp: a tick held up by another timer\'s slow body fires when it returns', () => {
        const fired: number[] = [];
        engine.addTemp(0.2, () => { fired.push(Date.now()); }, true);
        engine.addTemp(0.3, () => busy(500));
        runUntil(1050);
        expect(fired).toEqual([200, 800, 1000]);
    });

    it('temp: a slow body that kills its own timer still stays dead', () => {
        const fn = vi.fn();
        const id: number = engine.addTemp(0.2, () => { fn(); busy(500); engine.killTimer(id); }, true);
        runUntil(3000);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('temp: a slow body that disables its own timer leaves it disabled', () => {
        const fn = vi.fn();
        const id: number = engine.addTemp(0.2, () => { fn(); busy(500); engine.setTempEnabled(id, false); }, true);
        runUntil(3000);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(engine.remainingTime(id)).toBe(-1);
    });

    it('permanent: the next tick comes a full interval after a slow body', () => {
        const fired: number[] = [];
        const node = {
            id: 'p1', name: 'slow', isGroup: false, parentId: null, enabled: true,
            seconds: 0.2, repeat: true, code: 'x', command: '', language: 'lua',
        } as unknown as TimerNode;
        engine.loadPerm([node], () => {
            fired.push(Date.now());
            if (fired.length === 1) busy(500);
        });
        runUntil(1400);
        expect(fired).toEqual([200, 900, 1100, 1300]);
    });
});
