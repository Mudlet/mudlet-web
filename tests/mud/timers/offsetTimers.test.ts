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

    // TimerUnit::enableTimer → TTimer::enableTimer(): enabling an offset timer
    // starts it once on its own, when it and every ancestor are switched on;
    // the parent's next fire then re-arms it as usual.
    describe('enableTimer on an offset child under a permanent parent', () => {
        const tree = (childOn: boolean, over: Partial<TimerNode> = {}, parentOn = true) => [
            timer({ id: 'p', name: 'Pulse', seconds: 10, enabled: parentOn }),
            timer({ id: 'o', name: 'Echo', seconds: 2, parentId: 'p', enabled: childOn, ...over }),
        ];

        it('starts the child once, its own interval from the enable', () => {
            const timers = tree(true);
            engine.loadPerm(timers, run);
            vi.advanceTimersByTime(1000);
            engine.applyPermSwitch(['o'], true, timers);
            vi.advanceTimersByTime(11_500);
            expect(log).toEqual(['Echo 3.0', 'Pulse 10.0', 'Echo 12.0']);
        });

        it('fires once when the switch flips, whichever of the reload and the switch comes first', () => {
            engine.loadPerm(tree(false), run);
            vi.advanceTimersByTime(1000);
            const on = tree(true);
            engine.loadPerm(on, run);
            engine.applyPermSwitch(['o'], true, on);
            vi.advanceTimersByTime(4000);
            expect(log).toEqual(['Echo 3.0']);

            engine.destroy();
            engine = new TimerEngine();
            log = [];
            vi.setSystemTime(0);
            engine.loadPerm(tree(false), run);
            engine.applyPermSwitch(['o'], true, tree(true));
            engine.loadPerm(tree(true), run);
            vi.advanceTimersByTime(4000);
            expect(log).toEqual(['Echo 2.0']);
        });

        it('leaves it alone while the parent is switched off', () => {
            const timers = tree(true, {}, false);
            engine.loadPerm(timers, run);
            engine.applyPermSwitch(['o'], true, timers);
            vi.advanceTimersByTime(12_000);
            expect(log).toEqual([]);
        });

        it('leaves a command-only child to its parent', () => {
            const timers = tree(true, { code: '', command: 'look' });
            engine.loadPerm(timers, run);
            engine.applyPermSwitch(['o'], true, timers);
            vi.advanceTimersByTime(12_500);
            expect(log).toEqual(['Pulse 10.0', 'Echo 12.0']);
        });
    });
});
