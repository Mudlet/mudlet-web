// @vitest-environment node
//
// mudlet-web#384 item 1, measured against the Mudlet PTB: an `echo` without a
// newline from outside the trigger engine (a GMCP handler, a timer) is still
// the open line when the next server line arrives. Desktop ends it first, so
// the buffer reads `E-3 | LINE A3`. Mudlet Web stored the server line above it
// and then emitted the echo again after the line — `LINE A3 | E-3` in the
// buffer and `E-3 / LINE A3 / E-3` on screen.
//
// Same harness as feedTriggersDrift358.test.ts: a stubbed LuaRuntime whose
// "scripts" are closures over the real ScriptingAPI, keyed by trigger name.
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

const CONN = 'echo-order-384-conn';

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

describe('mudlet-web#384 — an unterminated echo before a server line', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: MudSessionT;
    let api: ScriptingAPI;
    let scripts: Record<string, (matches: (string | undefined)[]) => void>;
    /** Every message the renderer is handed, as `type:text`. */
    let shown: string[];

    beforeEach(async () => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'EchoOrder384', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        onRunWithMatches = (name, matches) => scripts[name]?.(matches);
        useAppStore.setState(s => ({
            connectionTriggers: {
                ...s.connectionTriggers,
                [CONN]: [trig('a3', '^LINE A3$')] as never,
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
            if (line) shown.push(`${type}:${typeof line === 'string' ? line : line.text}`);
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

    /** Every line of the main buffer, the open one included. */
    const lines = (): string[] => api.getLines(0, api.getLineCount() + 1) ?? [];
    /** Lines from the network, the way MudClient hands them over. */
    const server = (text: string) =>
        session.events.emit('flushLines', [{ text, type: 'mud' }]);
    /** An event handler's echo: written, then flushed as after any dispatch. */
    const handlerEcho = (text: string) => {
        api.echo(text);
        api.flushOutput();
    };

    it('ends the echo\'s line before the server line, in the buffer', () => {
        handlerEcho('E-3');
        server('LINE A3\n');
        expect(lines()).toEqual(['E-3', 'LINE A3', '']);
    });

    it('draws the echo once, above the server line', () => {
        handlerEcho('E-3');
        server('LINE A3\n');
        // The partial element is finalized in place ('script' after
        // 'script-partial'), then the server line gets a row of its own.
        expect(shown).toEqual(['script-partial:E-3', 'script:E-3', 'mud:LINE A3']);
    });

    it('does the same after a prompt line', () => {
        server('P1>\n');
        handlerEcho('E-4');
        server('LINE A4\n');
        expect(lines()).toEqual(['P1>', 'E-4', 'LINE A4', '']);
        expect(shown.filter(s => s.endsWith('E-4'))).toEqual(['script-partial:E-4', 'script:E-4']);
    });

    it('keeps a trigger\'s own echo after the line it fired on', () => {
        scripts.a3 = () => api.echo(' [T]');
        handlerEcho('E-3');
        server('LINE A3\n');
        expect(lines()).toEqual(['E-3', 'LINE A3 [T]', '']);
    });

    it('leaves an echo that already ended its line alone', () => {
        handlerEcho('E-5\n');
        server('LINE A5\n');
        expect(lines()).toEqual(['E-5', 'LINE A5', '']);
        expect(shown.filter(s => s.includes('E-5'))).toHaveLength(1);
    });
});
