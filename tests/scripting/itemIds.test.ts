// @vitest-environment node
//
// The editor's "Show Items' ID number" (desktop's `checkBox_showIdNumbers`)
// reads off the id you then pass to `enableTrigger`, `killTimer` and friends.
// mudix keys its store by UUID and hands Lua a number from a single per-profile
// sequence shared with temporary items, so the tree has to show *that* number —
// a UUID is not an id any script would accept.
//
// This pins the two halves of that: the number is stable per item and unique
// across the permanent/temporary split, and a profile's saved items are
// numbered at load rather than whenever something first happens to look at
// them, so what the editor shows does not depend on the order you opened
// things in.
//
// Node env + a stubbed LuaRuntime, as host-send.test.ts does: the engine boots a
// runtime in its constructor and none of the Lua side is needed here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {},
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
const { ItemIdSequence } = await import('../../src/mud/ItemIdSequence');

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'item-ids-conn';

const alias = (id: string, name: string) => ({
    id, name, isGroup: false, parentId: null, enabled: true,
    pattern: `^${name}$`, command: '', code: '', language: 'lua',
});
const trigger = (id: string, name: string) => ({
    id, name, isGroup: false, parentId: null, enabled: true,
    patterns: [{ type: 'substring', text: name }], code: '', language: 'lua', command: '',
});

type EngineInternals = { assignSavedItemIds: () => void };

describe('ItemIdSequence', () => {
    it('counts from one', () => {
        const seq = new ItemIdSequence();
        expect([seq.next(), seq.next(), seq.next()]).toEqual([1, 2, 3]);
    });

    // An id that arrives from outside the sequence — a restored profile — must
    // never be handed out a second time.
    it('never reissues a reserved id', () => {
        const seq = new ItemIdSequence();
        seq.reserve(10);
        expect(seq.next()).toBe(11);
    });

    it('ignores a reservation below where it already is', () => {
        const seq = new ItemIdSequence();
        seq.next();
        seq.next();
        seq.reserve(1);
        expect(seq.next()).toBe(3);
    });
});

describe('numericIdFor', () => {
    let engine: InstanceType<typeof ScriptingEngine>;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Ids', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({
            connectionAliases: { ...s.connectionAliases, [CONN]: [alias('a-uuid', 'gg'), alias('b-uuid', 'hh')] as never },
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [trigger('t-uuid', 'hello')] as never },
        }));
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
    });

    afterEach(() => {
        useAppStore.setState(s => {
            const { [CONN]: _a, ...aliases } = s.connectionAliases;
            const { [CONN]: _t, ...triggers } = s.connectionTriggers;
            return { connectionAliases: aliases, connectionTriggers: triggers };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('gives one item the same number every time it is asked', () => {
        const first = engine.numericIdFor('a-uuid');
        expect(engine.numericIdFor('a-uuid')).toBe(first);
        expect(engine.numericIdFor('a-uuid')).toBe(first);
    });

    it('gives two items different numbers', () => {
        expect(engine.numericIdFor('a-uuid')).not.toBe(engine.numericIdFor('b-uuid'));
    });

    // The pool is shared with temporary items on purpose (see ItemIdSequence):
    // a temp and a permanent item answering to one number is what `killAlias(id)`
    // could not then tell apart.
    it('draws from the same pool as a temporary item, so the two never collide', () => {
        const seen = new Set<number>([
            engine.numericIdFor('a-uuid'),
            engine.allocateItemId(),
            engine.numericIdFor('b-uuid'),
            engine.allocateItemId(),
        ]);
        expect(seen.size).toBe(4);
    });

    // Desktop numbers each item as it builds it from the profile XML, so a
    // profile's own items hold the low numbers and anything a script creates
    // carries on from there. Without this the numbers would depend on what a
    // script happened to touch — and, since the editor tree reads the same ids,
    // on whether the editor had been opened.
    it('numbers every saved item at load, in store order, before anything temporary', () => {
        (engine as unknown as EngineInternals).assignSavedItemIds();
        expect(engine.numericIdFor('t-uuid')).toBe(1);
        expect(engine.numericIdFor('a-uuid')).toBe(2);
        expect(engine.numericIdFor('b-uuid')).toBe(3);
        expect(engine.allocateItemId()).toBe(4);
    });

    it('does not renumber an item it has already numbered', () => {
        const before = engine.numericIdFor('b-uuid');
        (engine as unknown as EngineInternals).assignSavedItemIds();
        expect(engine.numericIdFor('b-uuid')).toBe(before);
    });
});
