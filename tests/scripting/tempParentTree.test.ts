// @vitest-environment node
//
// Temporary and permanent items of a kind live in ONE tree, as on desktop
// Mudlet: a perm*() call resolves its parent by name among both, so a
// permanent item can hang off a temporary one. Desktop's behaviour, which each
// case below pins:
//
//  - the child is created (permRegexTrigger(name, tostring(tempId), …) works);
//  - it is reached only through its parent: a trigger child only on lines the
//    temporary parent matched, never while the parent is switched off;
//  - killing the temporary parent takes the child out of exists / isActive /
//    findItems at once (pendingDeletion walks the ancestors), while
//    getProfileStats still counts both until the deferred cleanup frees the
//    whole subtree;
//  - killTrigger(child) refuses a permanent item;
//  - the child is never saved (XMLexport skips a temporary root's subtree)
//    and the script editor does not show it.
//
// Node env + a stubbed LuaRuntime, as tempDrift371.test.ts does it: the
// "scripts" are closures over the real engine, keyed by item name.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let onRunWithMatches: (name: string, matches: (string | undefined)[]) => void = () => {};

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: (_code: string, name: string, matches: (string | undefined)[]) =>
                onRunWithMatches(name, matches),
            destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {}, setCurrentLine: () => {}, getCurrentLine: () => undefined,
            shiftCaptureSpans: () => {}, tempItemExists: () => false,
        }),
    },
}));

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
const { serializeProfileData } = await import('../../src/storage/profileVfsData');
const { visibleTreeNodes, tempParentRef } = await import('../../src/storage/schema');
type ScriptingAPI = import('../../src/scripting/ScriptingAPI').ScriptingAPI;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'temp-parent-tree-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    applyTimersFromStore: () => void;
    scheduleTriggerApply: () => void;
    api: ScriptingAPI;
};

describe('a permanent item under a temporary one', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let internals: EngineInternals;
    let api: ScriptingAPI;
    let triggers: InstanceType<typeof TriggerEngine>;
    let timers: InstanceType<typeof TimerEngine>;
    let scripts: Record<string, (matches: (string | undefined)[]) => void>;
    let out: string[];
    let unsubscribe: () => void = () => {};

    const boot = async () => {
        useAppStore.setState(s => ({
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [] },
            connectionTimers: { ...s.connectionTimers, [CONN]: [] },
        }));
        const session = new MudSession();
        triggers = new TriggerEngine();
        timers = new TimerEngine();
        engine = new ScriptingEngine(session, new AliasEngine(), triggers, timers, new KeyEngine(), CONN);
        vi.spyOn(session, 'sendData').mockImplementation(() => {});
        await TriggerEngine.ready();
        internals = engine as unknown as EngineInternals;
        api = internals.api;
        internals.triggersReady = true;
        internals.applyTriggersFromStore();
        unsubscribe = useAppStore.subscribe((state, prev) => {
            if (state.connectionTriggers[CONN] !== prev.connectionTriggers[CONN]) internals.scheduleTriggerApply();
            if (state.connectionTimers[CONN] !== prev.connectionTimers[CONN]) internals.applyTimersFromStore();
        });
    };

    const feed = (text: string) =>
        engine.processFlushBatch([{ text, type: 'mud', fromServer: true }]);
    const storeTriggers = () => useAppStore.getState().connectionTriggers[CONN] ?? [];
    const storeTimers = () => useAppStore.getState().connectionTimers[CONN] ?? [];
    /** A temp trigger as tempRegexTrigger makes it: an id from the shared sequence. */
    const tempRegex = (pattern: string, onFire: () => void) =>
        triggers.createTemp(pattern, onFire, 'regex', { id: engine.allocateItemId() });

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Tree', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        out = [];
        onRunWithMatches = (name, matches) => scripts[name]?.(matches);
    });

    afterEach(() => {
        unsubscribe();
        unsubscribe = () => {};
        onRunWithMatches = () => {};
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _t, ...restT } = s.connectionTriggers;
            const { [CONN]: _m, ...restM } = s.connectionTimers;
            return { connectionTriggers: restT, connectionTimers: restM };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    describe('triggers', () => {
        it('can be created under a temporary trigger, which it names by id', async () => {
            await boot();
            const parent = tempRegex('^P', () => out.push('parent'));
            const child = engine.createPermRegexTrigger('ptChild', String(parent), ['C'], 'x');
            expect(child).toBeGreaterThan(parent);
            const node = storeTriggers().find(t => t.name === 'ptChild')!;
            expect(node.parentId).toBe(tempParentRef(parent));
            // A child with a parent is never multiline, as startPermRegexTrigger.
            expect(node.multiline).toBe(false);
            expect(engine.existsByName(child, 'trigger')).toBe(1);
            expect(engine.ancestorsById(child, 'trigger')).toEqual([
                { id: parent, name: String(parent), node: 'item', isActive: true },
            ]);
        });

        it('fires only on lines its temporary parent matched, and not while it is off', async () => {
            await boot();
            const parent = tempRegex('^P', () => out.push('parent'));
            engine.createPermRegexTrigger('ptChain', String(parent), ['C'], 'x');
            scripts.ptChain = () => out.push('child');

            feed('C only\nP and C\n');
            expect(out).toEqual(['parent', 'child']);

            out = [];
            engine.toggleTriggerByName(String(parent), false);
            feed('P and C\n');
            expect(out).toEqual([]);
        });

        it('is gone with its killed parent at once, and freed by the cleanup', async () => {
            await boot();
            const parent = tempRegex('^P', () => {});
            const child = engine.createPermRegexTrigger('ptKill', String(parent), ['C'], 'x');
            const before = engine.getProfileStats().triggers as { total: number; temp: number };

            expect(engine.killByName('trigger', 'ptKill')).toBe(false);
            expect(api.killByName('trigger', String(parent))).toBe(true);

            expect(engine.existsByName(child, 'trigger')).toBe(0);
            expect(engine.existsByName('ptKill', 'trigger')).toBe(0);
            expect(engine.isActiveByName(child, 'trigger', false)).toBe(0);
            expect(engine.findItemsByName('ptKill', 'trigger', true, true)).toEqual([]);
            // Counted until freed, but the killed parent no longer as active.
            expect(engine.getProfileStats().triggers).toMatchObject({ total: before.total, temp: before.temp });

            feed('anything\n');
            await Promise.resolve();
            expect(storeTriggers().some(t => t.name === 'ptKill')).toBe(false);
            const after = engine.getProfileStats().triggers as { total: number; temp: number };
            expect(after.total).toBe(before.total - 2);
            expect(after.temp).toBe(before.temp - 1);
        });

        it('is not saved and not shown in the editor', async () => {
            await boot();
            engine.createPermRegexTrigger('ptKept', '', ['K'], 'x');
            const parent = tempRegex('^P', () => {});
            engine.createPermRegexTrigger('ptGroup', String(parent), [], '');
            engine.createPermRegexTrigger('ptGrandchild', 'ptGroup', ['G'], 'x');

            const saved = JSON.parse(serializeProfileData(CONN)) as { triggers: { name: string }[] };
            expect(saved.triggers.map(t => t.name)).toEqual(['ptKept']);
            expect(visibleTreeNodes(storeTriggers()).map(t => t.name)).toEqual(['ptKept']);
        });

        it('resolves its parent to the newest same-named item, temporary or permanent', async () => {
            await boot();
            engine.createPermRegexTrigger('ptShared', '', [], '');
            const temp = triggers.createTempComplex({
                name: 'ptShared', isGroup: false, patterns: [{ type: 'regex', text: '^S' }], code: 'x',
                language: 'lua', fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
            }, { id: engine.allocateItemId() });
            engine.createPermRegexTrigger('ptUnderNewest', 'ptShared', ['U'], 'x');
            expect(storeTriggers().find(t => t.name === 'ptUnderNewest')!.parentId).toBe(tempParentRef(temp));
            expect(engine.existsByName('ptShared', 'trigger')).toBe(2);
        });

        it('chains through a tempComplexRegexTrigger filter as through a permanent one', async () => {
            await boot();
            const parent = engine.createTempComplexTrigger({
                name: 'ptFilter', patterns: [{ type: 'regex', text: '^hit (\\w+)' }], code: 'x',
                multiline: false, isFilter: true, multipleMatches: false, fireLength: 0, delta: 0,
            });
            engine.createPermRegexTrigger('ptFiltered', 'ptFilter', ['^orc$'], 'x');
            scripts.ptFiltered = m => out.push(`child ${m[0]}`);
            feed('hit orc\nhit elf\norc\n');
            expect(out).toEqual(['child orc']);
            expect(engine.existsByName(parent, 'trigger')).toBe(1);
        });
    });

    describe('tempComplexRegexTrigger in the engine tree', () => {
        it('a name re-used extends and replaces the live namesake, and a self-re-creating one is stopped as a runaway', async () => {
            await boot();
            const reports: string[] = [];
            triggers.setRunawayReporter(t => reports.push(t));
            let fires = 0;
            const make = () => engine.createTempComplexTrigger({
                name: 'ptWatcher', patterns: [{ type: 'regex', text: '^watched$' }], code: 'x',
                multiline: false, isFilter: false, multipleMatches: false, fireLength: 0, delta: 0,
            });
            const first = make();
            const second = make();
            // One live trigger under the name, carrying both pattern lists.
            expect(engine.existsByName('ptWatcher', 'trigger')).toBe(1);
            expect(engine.existsByName(first, 'trigger')).toBe(0);
            expect(triggers.tempPatterns(second)).toHaveLength(2);

            scripts.ptWatcher = () => { fires++; make(); };
            feed('watched\n');
            expect(reports).toHaveLength(1);
            expect(reports[0]).toContain("trigger 'ptWatcher'");
            expect(fires).toBeGreaterThan(1000);
        });
    });

    describe('timers', () => {
        it('is an offset timer its temporary parent never arms; enabling it runs it once', async () => {
            await boot();
            const parent = timers.addTemp(600, () => {});
            const child = engine.createPermTimer('ptOffset', String(parent), 1, 'x');
            expect(child).toBeGreaterThan(parent);
            expect(storeTimers().find(t => t.name === 'ptOffset')!.parentId).toBe(tempParentRef(parent));
            expect(engine.existsByName(child, 'timer')).toBe(1);
            // Created inactive, as every permTimer is.
            expect(engine.isActiveByName(child, 'timer', false)).toBe(0);
            expect(timers.remainingTime('ptOffset')).toBe(-1);

            engine.toggleTimerByName('ptOffset', true);
            expect(timers.remainingTime('ptOffset')).toBeGreaterThan(0);
            expect(timers.pumpDue(Date.now() + 2000)).toBe(1);
            // One fire, then it is spent: nothing re-arms it.
            expect(timers.remainingTime('ptOffset')).toBe(-1);
            expect(timers.pumpDue(Date.now() + 4000)).toBe(0);
        });

        it('is gone with its killed parent at once, and freed by the cleanup', async () => {
            await boot();
            const parent = timers.addTemp(600, () => {});
            const child = engine.createPermTimer('ptTimerKill', String(parent), 600, 'x');
            const before = engine.getProfileStats().timers as { total: number; temp: number };
            expect(timers.killTimer(parent)).toBe(true);
            expect(engine.existsByName(child, 'timer')).toBe(0);
            expect(engine.existsByName('ptTimerKill', 'timer')).toBe(0);
            expect(engine.isActiveByName(child, 'timer', false)).toBe(0);
            expect(engine.findItemsByName('ptTimerKill', 'timer', true, true)).toEqual([]);
            expect(engine.getProfileStats().timers).toMatchObject({ total: before.total, temp: before.temp });

            feed('anything\n');
            await Promise.resolve();
            expect(storeTimers().some(t => t.name === 'ptTimerKill')).toBe(false);
            expect((engine.getProfileStats().timers as { total: number }).total).toBe(before.total - 2);
        });
    });
});
