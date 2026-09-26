// A timer's runtime *active* flag is not its switch. Desktop Mudlet answers
// isActive(name, "timer") from TTimer::isActive() — Tree::mActive — which the
// loader, enableTimer/disableTimer and the folder walks move on their own, apart
// from the user's switch (mUserActiveState, Mudlet Web's `enabled`). The two
// disagree exactly where mudlet-web#217 found them to:
//   - a timer imported switched on under a switched-off TimerGroup is left
//     inactive, so it reports 0;
//   - an explicit enableTimer() on it raises the flag anyway, so it reports 1,
//     though the folder still keeps it from running (Other_spec.lua).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerEngine, type TimerNode } from '../../../src/mud/timers/TimerEngine';

function timer(over: Partial<TimerNode> & Pick<TimerNode, 'id' | 'name'>): TimerNode {
    return { parentId: null, isGroup: false, enabled: true, seconds: 1, code: 'x', language: 'lua', repeat: true, ...over } as TimerNode;
}
function folder(over: Partial<TimerNode> & Pick<TimerNode, 'id' | 'name'>): TimerNode {
    return timer({ isGroup: true, seconds: 0, code: '', ...over });
}

describe('TimerEngine — runtime active flag', () => {
    let engine: TimerEngine;
    let nodes: TimerNode[];
    const noop = () => {};
    const active = (id: string, checkAncestors = false) =>
        engine.permReportsActive(nodes.find(n => n.id === id)!, nodes, checkAncestors);
    /** What ScriptingEngine.toggleTimerByName does: write the named timers'
     *  switches (the store write reloads the engine), then apply the switch. */
    const toggle = (name: string, on: boolean) => {
        const ids = nodes.filter(n => n.name === name).map(n => n.id);
        nodes = nodes.map(n => (ids.includes(n.id) ? { ...n, enabled: on } : n));
        engine.loadPerm(nodes, noop);
        engine.applyPermSwitch(ids, on, nodes);
    };
    /** A switch flipped without enable/disableTimer — the editor's checkbox. */
    const edit = (id: string, patch: Partial<TimerNode>) => {
        nodes = nodes.map(n => (n.id === id ? { ...n, ...patch } : n));
        engine.loadPerm(nodes, noop);
    };

    beforeEach(() => {
        vi.useFakeTimers();
        engine = new TimerEngine();
    });
    afterEach(() => {
        engine.destroy();
        vi.useRealTimers();
    });

    describe('on load', () => {
        it('leaves a switched-on timer under a switched-off folder inactive (#217)', () => {
            nodes = [
                folder({ id: 'f', name: 'Folder', enabled: false }),
                timer({ id: 't', name: 'InOffFolder', parentId: 'f' }),
            ];
            engine.loadPerm(nodes, noop);
            expect(active('t')).toBe(false);
            expect(engine.remainingTime('InOffFolder')).toBe(-1);
        });

        it('activates a timer whose whole ancestry is switched on', () => {
            nodes = [
                folder({ id: 'f', name: 'Folder' }),
                folder({ id: 'g', name: 'Inner', parentId: 'f' }),
                timer({ id: 't', name: 'Deep', parentId: 'g' }),
            ];
            engine.loadPerm(nodes, noop);
            expect(active('f')).toBe(true);
            expect(active('g')).toBe(true);
            expect(active('t', true)).toBe(true);
        });

        it('leaves a switched-off timer inactive', () => {
            nodes = [timer({ id: 't', name: 'Off', enabled: false })];
            engine.loadPerm(nodes, noop);
            expect(active('t')).toBe(false);
        });

        it('keeps the flag an enableTimer raised before the first load', () => {
            // A script run at profile load can enableTimer() before the timer
            // engine has been handed the node list for the first time.
            nodes = [
                folder({ id: 'f', name: 'Folder', enabled: false }),
                timer({ id: 't', name: 'InOffFolder', parentId: 'f' }),
            ];
            engine.applyPermSwitch(['t'], true, nodes);
            engine.loadPerm(nodes, noop);
            expect(active('t')).toBe(true);
        });
    });

    describe('enableTimer / disableTimer', () => {
        it('reports a timer inside a disabled folder active after enableTimer, without running it (#217)', () => {
            nodes = [
                folder({ id: 'f', name: 'Folder', enabled: false }),
                timer({ id: 't', name: 'InOffFolder', parentId: 'f' }),
            ];
            engine.loadPerm(nodes, noop);
            toggle('InOffFolder', true);
            expect(active('t')).toBe(true);
            expect(active('t', true)).toBe(false);
            expect(engine.remainingTime('InOffFolder')).toBe(-1);
        });

        it('raises the flag of a freshly created, switched-off timer in a disabled folder (Other_spec)', () => {
            // permTimer creates the timer switched off; enableTimer switches it on.
            nodes = [
                folder({ id: 'f', name: 'Group', enabled: false }),
                timer({ id: 't', name: 'InGroup', parentId: 'f', enabled: false, repeat: false, seconds: 30 }),
            ];
            engine.loadPerm(nodes, noop);
            expect(active('t')).toBe(false);
            toggle('InGroup', true);
            expect(active('t')).toBe(true);
            expect(active('t', true)).toBe(false);
            expect(engine.remainingTime('InGroup')).toBe(-1);
            toggle('Group', true);
            expect(active('t', true)).toBe(true);
            expect(engine.remainingTime('InGroup')).toBeCloseTo(30);
        });

        it('enabling a folder activates the descendants whose ancestry is switched on', () => {
            nodes = [
                folder({ id: 'top', name: 'Top', enabled: false }),
                folder({ id: 'mid', name: 'Mid', parentId: 'top' }),
                timer({ id: 'leaf', name: 'Leaf', parentId: 'mid' }),
                timer({ id: 'off', name: 'Off', parentId: 'mid', enabled: false }),
            ];
            engine.loadPerm(nodes, noop);
            expect(active('leaf')).toBe(false);
            toggle('Top', true);
            expect(active('mid')).toBe(true);
            expect(active('leaf', true)).toBe(true);
            // A child the user switched off stays off: only the named folder's
            // own switch is written.
            expect(nodes.find(n => n.id === 'off')!.enabled).toBe(false);
            expect(active('off')).toBe(false);
        });

        it('enabling a folder under a disabled folder raises only its own flag', () => {
            nodes = [
                folder({ id: 'top', name: 'Top', enabled: false }),
                folder({ id: 'mid', name: 'Mid', parentId: 'top', enabled: false }),
                timer({ id: 'leaf', name: 'Leaf', parentId: 'mid' }),
            ];
            engine.loadPerm(nodes, noop);
            toggle('Mid', true);
            expect(active('mid')).toBe(true);
            expect(active('leaf')).toBe(false);
            toggle('Top', true);
            expect(active('leaf', true)).toBe(true);
        });

        it('disabling a folder lowers every descendant flag but leaves their switches (TreeLinkage_spec)', () => {
            nodes = [
                folder({ id: 'top', name: 'Top' }),
                folder({ id: 'mid', name: 'Mid', parentId: 'top' }),
                timer({ id: 'leaf', name: 'Leaf', parentId: 'mid', seconds: 60 }),
                timer({ id: 'sib', name: 'Sibling', parentId: 'top', seconds: 60 }),
            ];
            engine.loadPerm(nodes, noop);
            toggle('Top', false);
            expect(active('mid')).toBe(false);
            expect(active('leaf')).toBe(false);
            expect(active('sib')).toBe(false);
            expect(nodes.filter(n => n.enabled).map(n => n.id)).toEqual(['mid', 'leaf', 'sib']);
            expect(engine.remainingTime('Leaf')).toBe(-1);
            toggle('Top', true);
            expect(active('leaf', true)).toBe(true);
            expect(active('sib', true)).toBe(true);
            expect(engine.remainingTime('Leaf')).toBeCloseTo(60);
        });

        it('disabling an already switched-off folder still lowers a flag raised beneath it', () => {
            nodes = [
                folder({ id: 'f', name: 'Folder', enabled: false }),
                timer({ id: 't', name: 'InOffFolder', parentId: 'f' }),
            ];
            engine.loadPerm(nodes, noop);
            toggle('InOffFolder', true);
            expect(active('t')).toBe(true);
            toggle('Folder', false);
            expect(active('t')).toBe(false);
        });

        it('disableTimer lowers the flag of the timer itself', () => {
            nodes = [timer({ id: 't', name: 'T' })];
            engine.loadPerm(nodes, noop);
            expect(active('t')).toBe(true);
            toggle('T', false);
            expect(active('t')).toBe(false);
            toggle('T', true);
            expect(active('t')).toBe(true);
        });
    });

    describe('switches flipped outside enable/disableTimer', () => {
        it('applies the same transitions when the editor flips a switch', () => {
            nodes = [
                folder({ id: 'f', name: 'Folder', enabled: false }),
                timer({ id: 't', name: 'InOffFolder', parentId: 'f' }),
            ];
            engine.loadPerm(nodes, noop);
            edit('f', { enabled: true });
            expect(active('t', true)).toBe(true);
            edit('f', { enabled: false });
            expect(active('t')).toBe(false);
        });

        it('re-seeds a timer moved under another parent from where it now sits', () => {
            nodes = [
                folder({ id: 'on', name: 'On' }),
                folder({ id: 'off', name: 'Off', enabled: false }),
                timer({ id: 't', name: 'Mover', parentId: 'on' }),
            ];
            engine.loadPerm(nodes, noop);
            expect(active('t')).toBe(true);
            edit('t', { parentId: 'off' });
            expect(active('t')).toBe(false);
            edit('t', { parentId: 'on' });
            expect(active('t')).toBe(true);
        });

        it('forgets a removed timer', () => {
            nodes = [timer({ id: 't', name: 'Gone' })];
            engine.loadPerm(nodes, noop);
            nodes = [];
            engine.loadPerm(nodes, noop);
            nodes = [timer({ id: 't', name: 'Gone', enabled: false })];
            engine.loadPerm(nodes, noop);
            expect(active('t')).toBe(false);
        });
    });

    describe('offset timers', () => {
        it('reports an offset timer by its switch, and keeps the chain running', () => {
            const log: string[] = [];
            vi.setSystemTime(0);
            nodes = [
                timer({ id: 'p', name: 'Parent', seconds: 2 }),
                timer({ id: 'o', name: 'Offset', seconds: 0.5, parentId: 'p' }),
            ];
            engine.loadPerm(nodes, t => { log.push(`${t.name} ${(Date.now() / 1000).toFixed(1)}`); });
            // Not yet armed by its parent, but switched on — Mudlet reports
            // shouldBeActive() for an offset timer.
            expect(active('o')).toBe(true);
            expect(active('o', true)).toBe(true);
            vi.advanceTimersByTime(3000);
            expect(log).toEqual(['Parent 2.0', 'Offset 2.5']);
            expect(active('o')).toBe(true);
        });

        it('reports a switched-off offset timer inactive', () => {
            nodes = [
                timer({ id: 'p', name: 'Parent', seconds: 2 }),
                timer({ id: 'o', name: 'Offset', seconds: 0.5, parentId: 'p', enabled: false }),
            ];
            engine.loadPerm(nodes, noop);
            expect(active('o')).toBe(false);
        });
    });

    it('counts active timers by the same rule for getProfileStats', () => {
        nodes = [
            folder({ id: 'f', name: 'Folder', enabled: false }),
            timer({ id: 'a', name: 'A', parentId: 'f' }),
            timer({ id: 'b', name: 'B' }),
        ];
        engine.loadPerm(nodes, noop);
        expect(engine.countPermActive(nodes)).toBe(1);
        toggle('A', true);
        expect(engine.countPermActive(nodes)).toBe(2);
    });

    it('leaves temporary timers alone', () => {
        nodes = [];
        engine.loadPerm(nodes, noop);
        const id = engine.addTemp(1, noop);
        expect(engine.tempIsActive(id)).toBe(true);
        engine.setTempEnabled(id, false);
        expect(engine.tempIsActive(id)).toBe(false);
        engine.setTempEnabled(id, true);
        expect(engine.tempIsActive(id)).toBe(true);
        expect(engine.killTimer(id)).toBe(true);
        expect(engine.tempIsActive(id)).toBe(false);
    });
});
