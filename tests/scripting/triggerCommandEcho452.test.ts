// @vitest-environment node
//
// mudlet-web#452 item 3: a command a trigger sends was drawn ABOVE the line
// that fired it. The trigger runs before its line is rendered, and
// MudSession.echoCommand emitted its 'echo' message straight away, while a
// trigger's echo() output waits for flushDeferredEcho. Desktop (and the buffer
// here all along) has `line a / You are hungry. / EAT / line b`; the screen
// showed `line a / EAT / You are hungry. / line b`.
//
// Same harness as echoBeforeServerLine384.test.ts.
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
            shiftCaptureSpans: () => {},
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
type ScriptingAPI = import('../../src/scripting/ScriptingAPI').ScriptingAPI;
type MudSessionT = InstanceType<typeof MudSession>;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'cmd-echo-452-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    api: ScriptingAPI;
};

function trig(id: string, pattern: string) {
    return {
        id, name: id, patterns: [{ type: 'regex', text: pattern }],
        isGroup: false, parentId: null, enabled: true, code: 'x', language: 'lua',
        fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
    };
}

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('mudlet-web#452 — a trigger\'s command echo follows its line', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: MudSessionT;
    let api: ScriptingAPI;
    let scripts: Record<string, (matches: (string | undefined)[]) => void>;
    /** Every message the renderer is handed, as `type:text`. */
    let shown: string[];

    beforeEach(async () => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'CmdEcho452', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        onRunWithMatches = (name, matches) => scripts[name]?.(matches);
        useAppStore.setState(s => ({
            connectionTriggers: {
                ...s.connectionTriggers,
                [CONN]: [trig('hungry', '^You are hungry'), trig('prompt', '^HP>$')] as never,
            },
        }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        vi.spyOn(session, 'sendData').mockImplementation(() => {});
        await TriggerEngine.ready();
        const internals = engine as unknown as EngineInternals;
        internals.triggersReady = true;
        internals.applyTriggersFromStore();
        api = internals.api;
        shown = [];
        session.events.on('message', (line, type) => {
            if (line) shown.push(`${type}:${plain(typeof line === 'string' ? line : line.text)}`);
        });
    });

    afterEach(() => {
        onRunWithMatches = () => {};
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTriggers;
            return { connectionTriggers: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const lines = (): string[] => api.getLines(0, api.getLineCount() + 1) ?? [];
    const server = (text: string) =>
        session.events.emit('flushLines', [{ text, type: 'mud' }]);

    it('draws the command after the line that fired it, as the buffer has it', () => {
        scripts.hungry = () => api.send('EAT');
        server('line a\nYou are hungry.\nline b\n');
        expect(lines()).toEqual(['line a', 'You are hungry.', 'EAT', 'line b', '']);
        expect(shown).toEqual(['mud:line a', 'mud:You are hungry.', 'echo:EAT', 'mud:line b']);
    });

    it('keeps the command in order among the trigger\'s own echoes', () => {
        scripts.hungry = () => {
            api.echo('\nbefore\n');
            api.send('EAT');
            api.echo('after\n');
        };
        server('You are hungry.\nline b\n');
        const order = shown.filter(s => /before|EAT|after|hungry|line b/.test(s)).map(s => s.split(':')[1]);
        expect(order).toEqual(['You are hungry.', 'before', 'EAT', 'after', 'line b']);
    });

    it('puts a command sent on a prompt line below it, not onto it', () => {
        // printCommand's trigger branch always gives the command a line of its
        // own; the prompt keeps its flag, which is how the renderer knows.
        scripts.prompt = () => api.send('EAT');
        server('HP>\n');
        expect(lines()).toEqual(['HP>', 'EAT', '']);
        expect(shown).toEqual(['mud:HP>', 'echo:EAT']);
    });

    it('still echoes a command typed outside any trigger at once', () => {
        session.send('look');
        expect(shown).toEqual(['echo:look']);
    });
});
