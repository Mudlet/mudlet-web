// @vitest-environment node
//
// mudlet-web#343 item 1: moveCursorEnd() inside a trigger, measured against the
// Mudlet PTB. Desktop's echo always appends, wherever the cursor is, so
// `echo("\nM\n") moveCursorEnd() echo("\nN\n")` leaves a blank line between M
// and N, exactly as it does without the moveCursorEnd. Mudlet Web's
// moveCursorEnd re-armed the "matched line has no terminator yet" latch and
// swallowed that blank line — generic_mapper's print_echoes lost the empty line
// between its debug messages.
//
// Same harness as triggerLineEditing273.test.ts: a stubbed LuaRuntime whose
// "scripts" are closures over the real ScriptingAPI, keyed by trigger name.
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

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'move-cursor-end-343-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    api: ScriptingAPI;
};

function trig(over: Record<string, unknown>) {
    return {
        isGroup: false, parentId: null, enabled: true, code: 'x', language: 'lua',
        fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
        ...over,
    };
}

describe('mudlet-web#343 — moveCursorEnd() in a trigger keeps the pending blank line', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let api: ScriptingAPI;
    let scripts: Record<string, (matches: (string | undefined)[]) => void>;

    const boot = async (triggers: Record<string, unknown>[]) => {
        useAppStore.setState(s => ({
            connectionTriggers: { ...s.connectionTriggers, [CONN]: triggers as never },
        }));
        const session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        vi.spyOn(session, 'sendData').mockImplementation(() => {});
        await TriggerEngine.ready();
        const internals = engine as unknown as EngineInternals;
        internals.triggersReady = true;
        internals.applyTriggersFromStore();
        api = internals.api;
    };

    const feed = (text: string) =>
        engine.processFlushBatch([{ text, type: 'mud', fromServer: true }]);

    /** Every complete line of the main buffer. */
    const lines = (): string[] => api.getLines(0, api.getLineCount()) ?? [];

    beforeEach(async () => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'MoveCursorEnd', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        onRunWithMatches = (name, matches) => scripts[name]?.(matches);
        await boot([trig({ id: 't1', name: 't1', patterns: [{ type: 'regex', text: '^T1 ' }] })]);
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

    it('echo, moveCursorEnd, echo: the blank line between M and N stays', () => {
        scripts.t1 = () => {
            api.echo('\nM\n');
            api.moveCursorEnd('main');
            api.echo('\nN\n');
        };

        feed('T1 line\nafter T1\n');

        // Desktop: [T1 line] [M] [] [N] [after T1]
        expect(lines()).toEqual(['T1 line', 'M', '', 'N', 'after T1']);
    });

    it('matches the same echoes without moveCursorEnd', () => {
        scripts.t1 = () => {
            api.echo('\nM\n');
            api.echo('\nN\n');
        };

        feed('T1 line\nafter T1\n');

        expect(lines()).toEqual(['T1 line', 'M', '', 'N', 'after T1']);
    });

    it('moveCursorEnd before any echo still ends the matched line with the leading newline', () => {
        scripts.t1 = () => {
            api.moveCursorEnd('main');
            api.echo('\nN\n');
        };

        feed('T1 line\nafter T1\n');

        expect(lines()).toEqual(['T1 line', 'N', 'after T1']);
    });
});
