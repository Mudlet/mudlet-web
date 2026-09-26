// @vitest-environment node
//
// An item whose code (or pattern) fails to compile is inactive on desktop
// (mudlet-web#192): compiling it sets mOK_code / mOK_init false, and
// Tree::canBeActivated then refuses it — it never matches or fires, its
// command is not sent, a trigger's children are not looked at, an alias lets
// the input through to the game, and isActive reports 0 whatever its switch
// says. Fixing the code brings it back.
//
// The engine is wired to a stubbed runtime, as host-send.test.ts does, except
// for the one thing under test: the compile check is the real Lua runtime's.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

type Run = { kind: 'run' | 'match'; name: string; chunkName?: string };

const hooks = vi.hoisted(() => ({
    syntaxError: (_code: string, _chunk: string): string | null => null,
    runs: [] as Run[],
}));

vi.mock('../../src/scripting/lua/LuaRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/scripting/lua/LuaRuntime')>();
    return {
        RealLuaRuntime: actual.LuaRuntime,
        LuaRuntime: {
            create: () => Promise.resolve({
                load: () => {}, emitEvent: () => {}, processInput: () => false,
                destroy: () => {}, evalTriggerPattern: () => false, startSpeedWalk: () => {},
                dispatchSendRequest: () => false, reapKilledTempItems: () => {},
                setCommand: () => {}, setCurrentLine: () => {}, getCurrentLine: () => undefined,
                tempItemExists: () => false, tempItemIdByName: () => null,
                syntaxError: (code: string, chunk: string) => hooks.syntaxError(code, chunk),
                run: (_code: string, name: string, chunkName?: string) => {
                    hooks.runs.push({ kind: 'run', name, chunkName });
                },
                runWithMatches: (_code: string, name: string, ...rest: unknown[]) => {
                    hooks.runs.push({ kind: 'match', name, chunkName: rest[7] as string | undefined });
                },
            }),
        },
    };
});

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingAPI } = await import('../../src/scripting/ScriptingAPI');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
const { inactiveButtons } = await import('../../src/ui/buttons/inactiveButtons');
const { buildEffectivelyEnabledIds } = await import('../../src/storage/schema');
const { RealLuaRuntime } = await import('../../src/scripting/lua/LuaRuntime') as unknown as {
    RealLuaRuntime: typeof import('../../src/scripting/lua/LuaRuntime').LuaRuntime;
};

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };

const CONN = 'uncompilable-items-conn';

type EngineInternals = {
    runtimeReady: Promise<unknown>;
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    applyAliasesFromStore: () => void;
    applyTimersFromStore: () => void;
    applyKeybindingsFromStore: () => void;
    applyButtonsFromStore: () => void;
    api: { printError: (msg: string) => void };
};

const base = { isGroup: false, parentId: null, enabled: true, language: 'lua' };
const trig = (over: Record<string, unknown>) => ({
    ...base, code: '', command: '', fireLength: 0, multipleMatches: false, multiline: false,
    delta: 0, isFilter: false, ...over,
});

/** The re-verification items from the issue. */
const V_BAD = trig({ id: 'vBad', name: 'vBad', patterns: [{ type: 'substring', text: 'LINE A' }],
    code: 'x = = 3', command: 'RESULT vBad cmd' });
const V_CHILD = trig({ id: 'vChild', name: 'vChild', parentId: 'vBad',
    patterns: [{ type: 'substring', text: 'LINE' }], command: 'RESULT vChild fired' });
const V_AL = { ...base, id: 'vAl', name: 'vAl', pattern: '^ec$', code: 'x = = 4', command: 'RESULT ec cmd' };

const keyEvent = (code: string) => ({
    code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
} as KeyboardEvent);

type Slices = {
    connectionTriggers?: unknown[]; connectionAliases?: unknown[];
    connectionTimers?: unknown[]; connectionKeybindings?: unknown[];
    connectionButtons?: unknown[];
};
const SLICES = [
    'connectionTriggers', 'connectionAliases', 'connectionTimers', 'connectionKeybindings', 'connectionButtons',
] as const;

const toolbar = (over: Record<string, unknown>) => ({
    ...base, isGroup: true, orientation: 'horizontal', location: 'top', columns: 0,
    isPushDown: false, buttonState: false, code: '', ...over,
});
const button = (over: Record<string, unknown>) => ({
    ...base, orientation: 'horizontal', location: 'top', columns: 0,
    isPushDown: false, buttonState: false, code: '', ...over,
});
const B_BAR = toolbar({ id: 'bBar', name: 'bBar' });
const B_BAD = button({ id: 'bBad', name: 'bBad', parentId: 'bBar', code: 'x = = 7', command: 'RESULT bBad',
    isPushDown: true, buttonState: true });
const B_OK = button({ id: 'bOk', name: 'bOk', parentId: 'bBar', code: 'x = 7', command: 'RESULT bOk' });

describe('items whose code or pattern will not compile are inactive (mudlet-web#192)', () => {
    let real: Awaited<ReturnType<typeof RealLuaRuntime.create>>;
    let realApi: InstanceType<typeof ScriptingAPI>;
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let wire: string[];
    let errors: string[];

    beforeAll(async () => {
        realApi = new ScriptingAPI(new MudSession(), new AliasEngine(), new TriggerEngine(),
            new TimerEngine(), new KeyEngine(), CONN);
        real = await RealLuaRuntime.create(realApi, null, () => undefined);
        hooks.syntaxError = (code, chunk) => real.syntaxError(code, chunk);
        // Only now: a `document` switches wasmoon to browser-mode loading, and
        // the engine's constructor needs one.
        g.document = noopDom;
    });

    afterAll(() => {
        try { real.destroy(); } catch { /* best-effort */ }
        try { realApi.destroy(); } catch { /* best-effort */ }
    });

    const internals = () => engine as unknown as EngineInternals;

    const boot = async (slices: Slices) => {
        useAppStore.setState(s => {
            const next: Record<string, unknown> = {};
            for (const k of SLICES) next[k] = { ...s[k], [CONN]: (slices[k] ?? []) as never };
            return next as never;
        });
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        vi.spyOn(session, 'sendData').mockImplementation((text: string) => { wire.push(text); });
        vi.spyOn(session, 'echoCommand').mockImplementation(() => {});
        await internals().runtimeReady;
        vi.spyOn(internals().api, 'printError').mockImplementation((msg: string) => { errors.push(msg); });
        await TriggerEngine.ready();
        internals().triggersReady = true;
        internals().applyTriggersFromStore();
        internals().applyAliasesFromStore();
        internals().applyTimersFromStore();
        internals().applyKeybindingsFromStore();
        internals().applyButtonsFromStore();
    };

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Compile', url: 'ws://localhost' }],
            }));
        }
        wire = [];
        errors = [];
        hooks.runs = [];
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        useAppStore.setState(s => {
            const next: Record<string, unknown> = {};
            for (const k of SLICES) {
                const { [CONN]: _drop, ...rest } = s[k];
                next[k] = rest;
            }
            return next as never;
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        inactiveButtons.clear(CONN);
    });

    const buttons = () => useAppStore.getState().connectionButtons[CONN] ?? [];
    const click = (id: string, next = true) => engine.executeButton(buttons().find(b => b.id === id)!, next);
    /** What the button bar puts on screen: active, with every ancestor active. */
    const shownButtons = () => buildEffectivelyEnabledIds(buttons(), inactiveButtons.get(CONN));

    const line = (text: string) =>
        engine.processFlushBatch([{ text: `${text}\n`, type: 'mud', fromServer: true }]);

    it('a trigger with bad code neither sends its command nor runs its children', async () => {
        await boot({ connectionTriggers: [V_BAD, V_CHILD] });

        expect(engine.isActiveByName('vBad', 'trigger', false)).toBe(0);
        expect(engine.isActiveByName('vChild', 'trigger', false)).toBe(1);
        expect(engine.isActiveByName('vChild', 'trigger', true)).toBe(0);
        line('LINE A here');
        expect(wire).toEqual([]);
        expect(hooks.runs).toEqual([]);
        // The switch is left alone: it is still on, just unable to take effect.
        expect(useAppStore.getState().connectionTriggers[CONN]?.find(t => t.id === 'vBad')?.enabled).toBe(true);
    });

    it('reports the compile error once, under the item\'s chunk name', async () => {
        await boot({ connectionTriggers: [V_BAD, V_CHILD] });
        line('LINE A here');
        internals().applyTriggersFromStore();

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^\[trigger "vBad"\] Lua syntax error: \[string "Trigger: vBad"\]:1: /);
    });

    it('comes back once its code is fixed', async () => {
        await boot({ connectionTriggers: [V_BAD, V_CHILD] });
        useAppStore.setState(s => ({
            connectionTriggers: {
                ...s.connectionTriggers,
                [CONN]: [{ ...V_BAD, code: 'x = 3' }, V_CHILD] as never,
            },
        }));
        internals().applyTriggersFromStore();

        expect(engine.isActiveByName('vBad', 'trigger', false)).toBe(1);
        line('LINE A here');
        expect(wire).toEqual(['RESULT vBad cmd', 'RESULT vChild fired']);
        expect(hooks.runs).toEqual([{ kind: 'match', name: 'vBad', chunkName: 'Trigger: vBad' }]);
    });

    it('an alias with bad code lets the input go to the game', async () => {
        await boot({ connectionAliases: [V_AL] });

        expect(engine.isActiveByName('vAl', 'alias', false)).toBe(0);
        engine.sendCommand('ec');
        expect(wire).toEqual(['ec']);
        expect(hooks.runs).toEqual([]);
    });

    it('an alias with a pattern PCRE rejects reports inactive', async () => {
        await boot({ connectionAliases: [{ ...V_AL, pattern: '^(ec$', code: '' }] });

        expect(engine.isActiveByName('vAl', 'alias', false)).toBe(0);
        engine.sendCommand('ec');
        expect(wire).toEqual(['ec']);
    });

    it('a trigger with one invalid regex is inactive, its valid pattern included', async () => {
        await boot({ connectionTriggers: [
            trig({ id: 'r', name: 'rx', command: 'RESULT rx', patterns: [
                { type: 'regex', text: '^(LINE' }, { type: 'substring', text: 'LINE' },
            ] }),
            trig({ id: 'ok', name: 'ok', command: 'RESULT ok', patterns: [{ type: 'regex', text: '^LINE' }] }),
        ] });

        expect(engine.isActiveByName('rx', 'trigger', false)).toBe(0);
        expect(engine.isActiveByName('ok', 'trigger', false)).toBe(1);
        line('LINE B');
        expect(wire).toEqual(['RESULT ok']);
    });

    it('a trigger whose Lua-function pattern will not compile is inactive', async () => {
        await boot({ connectionTriggers: [
            trig({ id: 'lf', name: 'lf', command: 'RESULT lf',
                patterns: [{ type: 'luaFunction', text: 'return = true' }] }),
        ] });

        expect(engine.isActiveByName('lf', 'trigger', false)).toBe(0);
        expect(errors.join('\n')).toContain('Error: in item 1, lua function "return = true" failed to compile');
    });

    it('a timer with bad code does not fire, and reports inactive', async () => {
        vi.useFakeTimers();
        await boot({ connectionTimers: [
            { ...base, id: 'tBad', name: 'tBad', seconds: 1, repeat: true, code: 'x = = 5', command: 'RESULT tBad' },
            { ...base, id: 'tOk', name: 'tOk', seconds: 1, repeat: false, code: 'x = 5', command: 'RESULT tOk' },
        ] });

        expect(engine.isActiveByName('tBad', 'timer', false)).toBe(0);
        expect(engine.isActiveByName('tOk', 'timer', false)).toBe(1);
        vi.advanceTimersByTime(2500);
        expect(wire).toEqual(['RESULT tOk']);
        expect(hooks.runs).toEqual([{ kind: 'run', name: 'timer "tOk"', chunkName: 'Timer: tOk' }]);
    });

    it('a key with bad code does not send its command', async () => {
        await boot({ connectionKeybindings: [
            { ...base, id: 'kBad', name: 'kBad', key: 'F6', modifiers: [], code: 'x = = 6', command: 'RESULT kBad' },
            { ...base, id: 'kOk', name: 'kOk', key: 'F7', modifiers: [], code: 'x = 6', command: 'RESULT kOk' },
        ] });

        expect(engine.isActiveByName('kBad', 'key', false)).toBe(0);
        expect(engine.processKey(keyEvent('F6'))).toBe(false);
        expect(engine.processKey(keyEvent('F7'))).toBe(true);
        expect(wire).toEqual(['RESULT kOk']);
        expect(hooks.runs).toEqual([{ kind: 'run', name: 'key "kOk"', chunkName: 'Key: kOk' }]);
    });

    it('compiles the code as a function body, as desktop does', async () => {
        // A top-level `...` is fine in a chunk but not inside
        // `function Trigger5() ... end`, which is what desktop compiles.
        await boot({ connectionTriggers: [
            trig({ id: 'va', name: 'va', code: 'print(...)', patterns: [{ type: 'substring', text: 'x' }] }),
        ] });

        expect(engine.isActiveByName('va', 'trigger', false)).toBe(0);
        expect(errors[0]).toContain("cannot use '...' outside a vararg function");
    });

    it('a button with bad code is left off its toolbar and does nothing', async () => {
        await boot({ connectionButtons: [B_BAR, B_BAD, B_OK] });

        expect(inactiveButtons.get(CONN)).toEqual(new Set(['bBad']));
        expect(shownButtons()).toEqual(new Set(['bBar', 'bOk']));
        expect(engine.isActiveByName('bBad', 'button', false)).toBe(0);
        expect(engine.isActiveByName('bOk', 'button', true)).toBe(1);
        click('bBad', false);
        click('bOk');
        expect(wire).toEqual(['RESULT bOk']);
        expect(hooks.runs).toEqual([{ kind: 'run', name: 'button "bOk"', chunkName: 'Button: bOk' }]);
        // getButtonState reads the stored state, active or not, as desktop's does.
        expect(engine.getButtonStateByName('bBad')).toBe(true);
        expect(buttons().find(b => b.id === 'bBad')?.enabled).toBe(true);
        internals().applyButtonsFromStore();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^\[button "bBad"\] Lua syntax error: \[string "Button: bBad"\]:1: /);
    });

    it('a button comes back once its code is fixed, its switch untouched', async () => {
        await boot({ connectionButtons: [B_BAR, B_BAD, B_OK] });
        useAppStore.getState().updateButton(CONN, 'bBad', { code: 'x = 8' });
        internals().applyButtonsFromStore();

        expect(inactiveButtons.get(CONN).size).toBe(0);
        expect(shownButtons()).toEqual(new Set(['bBar', 'bBad', 'bOk']));
        expect(engine.isActiveByName('bBad', 'button', false)).toBe(1);
        click('bBad', false);
        expect(wire).toEqual(['RESULT bBad']);
        expect(hooks.runs).toEqual([{ kind: 'run', name: 'button "bBad"', chunkName: 'Button: bBad' }]);
    });

    it('a toolbar with bad code takes its buttons with it', async () => {
        await boot({ connectionButtons: [{ ...B_BAR, code: 'x = = 9' }, B_OK] });

        expect(inactiveButtons.get(CONN)).toEqual(new Set(['bBar']));
        expect(shownButtons().size).toBe(0);
        expect(engine.isActiveByName('bBar', 'button', false)).toBe(0);
        // The button's own code is fine; only its toolbar is not.
        expect(engine.isActiveByName('bOk', 'button', false)).toBe(1);
        expect(engine.isActiveByName('bOk', 'button', true)).toBe(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('[string "Button: bBar"]:1:');
    });
});
