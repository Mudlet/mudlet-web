// @vitest-environment node
//
// ScriptingEngine.hostSend is the port of Mudlet's
// `Host::send(cmd, wantPrint = true, dontExpandAliases = false)`, which is the
// single path a typed command and every item's built-in `command` field take.
// It does three things, in this order, and the order is the whole point:
//
//   1. echo the WHOLE, unsplit text under the showSentText mode,
//   2. split it on the profile's command separator (SkipEmptyParts),
//   3. run each part through the aliases, wire-send what no alias consumed.
//
// mudix used to do none of it in one place: item commands passed `echo = false`
// (pinning them to "never echo" whatever the user configured), the separator was
// split only for typed input, the echo happened per-part *after* the alias pass
// — so a line an alias swallowed was never echoed at all — and an item's command
// never saw the aliases.
//
// Lua `send()` is the same thing with dontExpandAliases = true: echoed, split,
// but never alias-expanded. That lives in ScriptingAPI.send and is pinned here
// too, since it shares the split and the echo.
//
// Node env + a stubbed LuaRuntime, for the same reason server-media-gate does
// it: the engine boots a runtime in its constructor and none of the Lua side is
// needed to observe what reaches the echo and the wire.
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

// Minimal DOM for the engine constructor, installed after the imports (pcre2
// picks node-vs-browser loading at module init — see createTestRuntime).
const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'host-send-conn';

type EngineInternals = {
    api: {
        printError: (msg: string) => void;
        send: (text: string, echo?: boolean) => void;
        setCmdLineAction: (fn: ((text: string) => void) | null) => void;
    };
    executePermTrigger: (trigger: unknown, matches: (string | undefined)[], matchedText: string) => void;
    applyTimersFromStore: () => void;
};

const keyEvent = (code: string) => ({
    code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
} as KeyboardEvent);

const KEY = {
    id: 'k1', name: 'North', isGroup: false, parentId: null, enabled: true,
    key: 'Numpad8', modifiers: [], code: '', language: 'lua', command: 'north',
};
const BUTTON = {
    id: 'b1', name: 'Look', isGroup: false, parentId: null, enabled: true,
    orientation: 'horizontal', location: 'top', columns: 0,
    isPushDown: false, buttonState: false, code: '', language: 'lua', command: 'look',
};
const TRIGGER = {
    id: 'tr1', name: 'Greet', isGroup: false, parentId: null, enabled: true,
    patterns: [{ type: 'substring', text: 'hello' }], code: '', language: 'lua', command: 'wave',
};
const TIMER = {
    id: 'tm1', name: 'Tick', isGroup: false, parentId: null, enabled: true,
    seconds: 1, code: '', language: 'lua', repeat: false, command: 'score',
};
/** `gg` → `north`, the shape of a plain command-only alias. */
const ALIAS = {
    id: 'a1', name: 'gg', isGroup: false, parentId: null, enabled: true,
    pattern: '^gg$', command: 'north', code: '', language: 'lua',
};

describe('hostSend — Mudlet Host::send', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let aliasEngine: InstanceType<typeof AliasEngine>;
    let keyEngine: InstanceType<typeof KeyEngine>;
    let timerEngine: InstanceType<typeof TimerEngine>;
    /** Everything echoed locally, in order. */
    let echoed: string[];
    /** Everything that reached the wire, in order — the far side of the split
     *  and the alias pass. */
    let wire: string[];

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Echo', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({
            connectionTimers: { ...s.connectionTimers, [CONN]: [TIMER as never] },
        }));
        useAppStore.getState().patchConnectionProfile(CONN, { commandSeparator: ';;' });
        session = new MudSession();
        aliasEngine = new AliasEngine();
        keyEngine = new KeyEngine();
        timerEngine = new TimerEngine();
        engine = new ScriptingEngine(
            session, aliasEngine, new TriggerEngine(), timerEngine, keyEngine, CONN,
        );
        echoed = [];
        wire = [];
        vi.spyOn(session, 'echoCommand').mockImplementation((text: string) => { echoed.push(text); });
        vi.spyOn(session, 'sendData').mockImplementation((text: string) => { wire.push(text); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTimers;
            return { connectionTimers: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    /** Fire the perm timer's execute callback without waiting a second: capture
     *  the callback loadPerm is handed and call it directly. */
    const fireTimer = () => {
        let execute: ((t: unknown) => void) | undefined;
        vi.spyOn(timerEngine, 'loadPerm').mockImplementation((_timers, fn) => { execute = fn as never; });
        (engine as unknown as EngineInternals).applyTimersFromStore();
        expect(execute).toBeDefined();
        execute!(TIMER);
    };

    describe('stage 1 — the echo', () => {
        it('echoes an item command in the default script-controlled mode', () => {
            keyEngine.loadPerm([KEY as never]);
            expect(session.showSentText).toBe('script');
            expect(engine.processKey(keyEvent('Numpad8'))).toBe(true);
            expect(echoed).toEqual(['north']);
            expect(wire).toEqual(['north']);
        });

        it('echoes button, trigger and timer commands too', () => {
            engine.executeButton(BUTTON as never, false);
            (engine as unknown as EngineInternals).executePermTrigger(TRIGGER, ['hello'], 'hello');
            fireTimer();
            expect(echoed).toEqual(['look', 'wave', 'score']);
        });

        it('stays silent when the user turned command echo off', () => {
            session.showSentText = 'never';
            keyEngine.loadPerm([KEY as never]);
            engine.processKey(keyEvent('Numpad8'));
            engine.executeButton(BUTTON as never, false);
            fireTimer();
            engine.sendCommand('look');
            expect(echoed).toEqual([]);
            // Silenced, not swallowed: every command still reaches the game.
            expect(wire).toEqual(['north', 'look', 'score', 'look']);
        });

        it('lets a setCmdLineAction handler pre-empt the whole pipeline', () => {
            // Mudlet checks the action in TCommandLine, before Host::send is
            // ever called — so the handler sees the whole unsplit line and
            // nothing is echoed, split, aliased or sent.
            const seen: string[] = [];
            const api = (engine as unknown as EngineInternals).api;
            api.setCmdLineAction((text: string) => { seen.push(text); });
            aliasEngine.loadPerm([ALIAS as never]);
            engine.sendCommand('gg;;north');
            api.setCmdLineAction(null);
            expect(seen).toEqual(['gg;;north']);
            expect(echoed).toEqual([]);
            expect(wire).toEqual([]);
        });

        it('echoes the typed line even when an alias swallows it', () => {
            // Mudlet prints the command at the top of Host::send, before the
            // alias unit ever sees it — so both the typed text and the alias's
            // own command show up, in that order.
            aliasEngine.loadPerm([ALIAS as never]);
            engine.sendCommand('gg');
            expect(echoed).toEqual(['gg', 'north']);
            expect(wire).toEqual(['north']);
        });
    });

    describe('stage 2 — the command separator split', () => {
        it('echoes the whole line once but sends each command', () => {
            engine.sendCommand('north;;south');
            expect(echoed).toEqual(['north;;south']);
            expect(wire).toEqual(['north', 'south']);
        });

        it('skips empty parts, the way Qt::SkipEmptyParts does', () => {
            engine.sendCommand('north;;;;south');
            expect(wire).toEqual(['north', 'south']);
        });

        it('sends a blank line for empty input, without consulting aliases', () => {
            // Mudlet's "allow sending blank commands" branch returns before the
            // alias loop, so pressing Enter on an empty command line always
            // reaches the game (menus, more-prompts).
            aliasEngine.loadPerm([{ ...ALIAS, pattern: '^$', command: 'nope' } as never]);
            engine.sendCommand('');
            engine.sendCommand(';;');
            expect(wire).toEqual(['', '']);
        });

        it('splits an item command too, not just typed input', () => {
            keyEngine.loadPerm([{ ...KEY, command: 'north;;look' } as never]);
            engine.processKey(keyEvent('Numpad8'));
            expect(echoed).toEqual(['north;;look']);
            expect(wire).toEqual(['north', 'look']);
        });
    });

    describe('stage 3 — the alias pass', () => {
        it('expands an alias named by an item command', () => {
            // TKey::execute takes Host::send's dontExpandAliases = false, so a
            // keybinding bound to "gg" fires the gg alias rather than sending
            // the literal text.
            aliasEngine.loadPerm([ALIAS as never]);
            keyEngine.loadPerm([{ ...KEY, command: 'gg' } as never]);
            engine.processKey(keyEvent('Numpad8'));
            expect(echoed).toEqual(['gg', 'north']);
            expect(wire).toEqual(['north']);
        });

        it('cuts a self-feeding alias loop instead of wedging the tab', () => {
            // Mudlet has no cap here — it recurses until the C++ stack gives
            // out. mudix stops and says so.
            const errors: string[] = [];
            vi.spyOn((engine as unknown as EngineInternals).api, 'printError')
                .mockImplementation((msg: string) => { errors.push(msg); });
            aliasEngine.loadPerm([{ ...ALIAS, command: 'gg' } as never]);
            engine.sendCommand('gg');
            expect(errors.length).toBe(1);
            expect(errors[0]).toContain('an alias is very likely feeding itself');
            expect(wire).toEqual([]);
        });

        it('leaves Lua send() unexpanded — sendRaw passes dontExpandAliases', () => {
            aliasEngine.loadPerm([ALIAS as never]);
            (engine as unknown as EngineInternals).api.send('gg');
            expect(echoed).toEqual(['gg']);
            // The literal text goes to the game; the alias does not fire.
            expect(wire).toEqual(['gg']);
        });

        it('still splits a Lua send() on the separator', () => {
            (engine as unknown as EngineInternals).api.send('north;;south');
            expect(echoed).toEqual(['north;;south']);
            expect(wire).toEqual(['north', 'south']);
        });
    });
});
