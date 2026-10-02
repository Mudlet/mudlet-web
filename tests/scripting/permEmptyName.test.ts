// @vitest-environment node
//
// Mudlet never validates the NAME a perm* call is given: startPermAlias,
// startPerm*Trigger, startPermTimer, startPermKey and createPermScript just
// setName() whatever arrived, so `permAlias("", "", "^x$", ...)` makes an alias
// with an empty name and returns its id. Mudlet Web used to refuse every one of
// them with -1, which the Bridge then reported as "cannot create alias (parent
// not found)" — a parent nobody had asked for (mudlet-web#291).
//
// Node env + a stubbed LuaRuntime, as itemIds.test.ts does: the creators live in
// ScriptingEngine and none of the Lua side is needed to reach them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {},
            tempItemExists: () => false, tempItemIdByName: () => null,
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

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'perm-empty-name-conn';

describe('perm* with an empty name (mudlet-web#291)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;

    const clear = () => useAppStore.setState(s => ({
        connectionAliases: { ...s.connectionAliases, [CONN]: [] },
        connectionTriggers: { ...s.connectionTriggers, [CONN]: [] },
        connectionTimers: { ...s.connectionTimers, [CONN]: [] },
        connectionKeybindings: { ...s.connectionKeybindings, [CONN]: [] },
        connectionScripts: { ...s.connectionScripts, [CONN]: [] },
    }));

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Empty', url: 'ws://localhost' }],
            }));
        }
        clear();
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
    });

    afterEach(() => {
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        clear();
    });

    it('permAlias makes the alias and returns its id', () => {
        const id = engine.createPermAlias('', '', '^ename$', 'x = 1');
        expect(id).toBeGreaterThan(0);
        expect(engine.existsByName('', 'alias')).toBe(1);
        const node = useAppStore.getState().connectionAliases[CONN].find(a => a.pattern === '^ename$');
        expect(node).toMatchObject({ name: '', isGroup: false, enabled: true });
    });

    it('each perm*Trigger makes the trigger', () => {
        expect(engine.createPermSubstringTrigger('', '', ['enamez'], 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermRegexTrigger('', '', ['^r$'], 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermBeginOfLineStringTrigger('', '', ['b'], 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermExactMatchTrigger('', '', ['e'], 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermPromptTrigger('', '', 'x = 1')).toBeGreaterThan(0);
        expect(engine.existsByName('', 'trigger')).toBe(5);
    });

    it('permTimer, permScript and permKey make their items', () => {
        expect(engine.createPermTimer('', '', 3, 'x = 1')).toBeGreaterThan(0);
        expect(engine.createPermScript('', '', 'r8es = 1')).toBeGreaterThan(0);
        expect(engine.createPermKey('', '', -1, 16777273, 'x = 1')).toBeGreaterThan(0);
        expect(engine.existsByName('', 'timer')).toBe(1);
        expect(engine.existsByName('', 'script')).toBe(1);
        expect(engine.existsByName('', 'key')).toBe(1);
    });

    // permGroup("", "alias") is permAlias("", "", "", ""): a folder, not a refusal.
    it('the permGroup shape makes an empty-named folder', () => {
        expect(engine.createPermAlias('', '', '', '')).toBeGreaterThan(0);
        expect(engine.createPermSubstringTrigger('', '', [], '')).toBeGreaterThan(0);
        expect(engine.createPermTimer('', '', 0, '')).toBeGreaterThan(0);
        expect(useAppStore.getState().connectionAliases[CONN][0]).toMatchObject({ name: '', isGroup: true });
        expect(useAppStore.getState().connectionTriggers[CONN][0]).toMatchObject({ name: '', isGroup: true });
        expect(useAppStore.getState().connectionTimers[CONN][0]).toMatchObject({ name: '', isGroup: true });
    });

    // The one refusal left is the one desktop has: a named parent that is not there.
    it('still refuses a missing parent', () => {
        expect(engine.createPermAlias('', 'nope', '^x$', '')).toBe(-1);
        expect(engine.createPermSubstringTrigger('', 'nope', ['x'], '')).toBe(-1);
        expect(engine.createPermTimer('', 'nope', 1, '')).toBe(-1);
        expect(engine.createPermScript('', 'nope', 'x = 1')).toBe(-1);
        expect(engine.createPermKey('', 'nope', -1, 16777273, '')).toBe(-1);
    });
});
