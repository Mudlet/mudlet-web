// A timer nested under another *timer* (not a folder) is an offset timer in
// Mudlet (TTimer.h:75-84): it never runs on its own clock, and each time its
// parent fires it is started once, due its own interval later
// (TTimer.cpp:255-265). Mudlet Web scheduled it as an independent repeating
// timer, so a 0.5 s child under a 2 s parent fired ten times in five seconds —
// before the parent had fired at all — instead of twice (mudlet-web#181).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerEngine, type TimerNode } from '../../../src/mud/timers/TimerEngine';

function timer(over: Partial<TimerNode> & Pick<TimerNode, 'id' | 'name' | 'seconds'>): TimerNode {
    return { parentId: null, isGroup: false, enabled: true, code: 'x', language: 'lua', repeat: true, ...over } as TimerNode;
}

describe('TimerEngine — offset timers', () => {
    let engine: TimerEngine;
    let log: string[];
    const run = (t: TimerNode) => { log.push(`${t.name} ${(Date.now() / 1000).toFixed(1)}`); };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        engine = new TimerEngine();
        log = [];
    });
    afterEach(() => {
        engine.destroy();
        vi.useRealTimers();
    });

    it('fires the child once, its own interval after each parent firing', () => {
        engine.loadPerm([
            timer({ id: 'p', name: 'Parent', seconds: 2 }),
            timer({ id: 'o', name: 'Offset', seconds: 0.5, parentId: 'p' }),
        ], run);
        vi.advanceTimersByTime(5000);
        // The desktop column of the issue's table.
        expect(log).toEqual(['Parent 2.0', 'Offset 2.5', 'Parent 4.0', 'Offset 4.5']);
    });

    it('chains offset timers nested under offset timers', () => {
        engine.loadPerm([
            timer({ id: 'p', name: 'A', seconds: 2 }),
            timer({ id: 'b', name: 'B', seconds: 0.5, parentId: 'p' }),
            timer({ id: 'c', name: 'C', seconds: 0.5, parentId: 'b' }),
        ], run);
        vi.advanceTimersByTime(3500);
        expect(log).toEqual(['A 2.0', 'B 2.5', 'C 3.0']);
    });

    it('still runs a timer inside a folder on its own clock', () => {
        engine.loadPerm([
            timer({ id: 'g', name: 'Folder', seconds: 0, isGroup: true, code: '' }),
            timer({ id: 't', name: 'Plain', seconds: 1, parentId: 'g' }),
        ], run);
        vi.advanceTimersByTime(2000);
        expect(log).toEqual(['Plain 1.0', 'Plain 2.0']);
    });

    it('does not arm a disabled offset child', () => {
        engine.loadPerm([
            timer({ id: 'p', name: 'Parent', seconds: 1 }),
            timer({ id: 'o', name: 'Offset', seconds: 0.5, parentId: 'p', enabled: false }),
        ], run);
        vi.advanceTimersByTime(2000);
        expect(log).toEqual(['Parent 1.0', 'Parent 2.0']);
    });

    it('cancels a pending child when a reload disables it', () => {
        const nodes = [
            timer({ id: 'p', name: 'Parent', seconds: 1 }),
            timer({ id: 'o', name: 'Offset', seconds: 0.5, parentId: 'p' }),
        ];
        engine.loadPerm(nodes, run);
        vi.advanceTimersByTime(1000);
        expect(engine.remainingTime('Offset')).toBeCloseTo(0.5);
        engine.loadPerm([nodes[0], { ...nodes[1], enabled: false }], run);
        vi.advanceTimersByTime(900);
        expect(log).toEqual(['Parent 1.0']);
        expect(engine.remainingTime('Offset')).toBe(-1);
    });

    it('keeps a pending child across an unrelated reload', () => {
        const nodes = [
            timer({ id: 'p', name: 'Parent', seconds: 1 }),
            timer({ id: 'o', name: 'Offset', seconds: 0.5, parentId: 'p' }),
        ];
        engine.loadPerm(nodes, run);
        vi.advanceTimersByTime(1000);
        engine.loadPerm([...nodes, timer({ id: 'x', name: 'Other', seconds: 10 })], run);
        vi.advanceTimersByTime(500);
        expect(log).toEqual(['Parent 1.0', 'Offset 1.5']);
    });
});
