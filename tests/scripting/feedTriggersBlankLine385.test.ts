// @vitest-environment node
//
// mudlet-web#385 item 1, measured against the Mudlet PTB: feedTriggers commits
// one line per '\n', the last one included when it is empty. Web cut the
// batch's last '\n' off before splitting, so processFlushBatch's drop of the
// empty piece after a trailing terminator took the final blank line with it —
// feedTriggers("F1\n\n") stored only F1 and feedTriggers("\n") nothing. The
// echo package's `cecho/`decho/`hecho aliases (via cfeedTriggers and friends,
// which add a "\n" of their own) lost a blank line every time, and a `^$`
// trigger missed it.
//
// Same harness as feedTriggersDrift358.test.ts.
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

const CONN = 'feed-triggers-385-conn';

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

describe('mudlet-web#385 — feedTriggers keeps the final empty line', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: MudSessionT;
    let api: ScriptingAPI;
    /** The line each trigger fired on, in order. */
    let fired: string[];

    beforeEach(async () => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'FeedTriggers385', url: 'ws://localhost' }],
            }));
        }
        fired = [];
        onRunWithMatches = (name, matches) => { fired.push(`${name}:${matches[0] ?? ''}`); };
        useAppStore.setState(s => ({
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [trig('blank', '^$')] as never },
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

    /** Every complete line of the main buffer. */
    const lines = (): string[] => api.getLines(0, api.getLineCount()) ?? [];

    it('commits a trailing empty line', () => {
        api.feedTriggers('F1\n\n');
        expect(lines()).toEqual(['F1', '']);
        expect(fired).toEqual(['blank:']);
    });

    it('commits a lone newline as an empty line', () => {
        api.feedTriggers('\n');
        expect(lines()).toEqual(['']);
        expect(fired).toEqual(['blank:']);
    });

    it('commits every one of several trailing empty lines', () => {
        api.feedTriggers('B1\n\n\n');
        expect(lines()).toEqual(['B1', '', '']);
        expect(fired).toEqual(['blank:', 'blank:']);
    });

    it('keeps the blank line `cecho adds after its text', () => {
        // The echo package's `cecho alias runs cfeedTriggers("\n" .. s .. "\n"),
        // and cfeedTriggers feeds its text with one more "\n" on the end.
        api.feedTriggers('\nC1\n\n');
        expect(lines()).toEqual(['', 'C1', '']);
        expect(fired).toEqual(['blank:', 'blank:']);
    });

    it('still commits a single terminated line once', () => {
        api.feedTriggers('one\ntwo\n');
        expect(lines()).toEqual(['one', 'two']);
        expect(fired).toEqual([]);
    });

    it('holds an unterminated tail after a blank line, as before', () => {
        api.feedTriggers('A\n\ntail');
        expect(lines()).toEqual(['A', '']);
        api.feedTriggers('\n');
        expect(lines()).toEqual(['A', '', 'tail']);
        expect(fired).toEqual(['blank:']);
    });
});
