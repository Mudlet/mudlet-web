// @vitest-environment node
//
// Two things the LINE PASS has to get right, both of which the trigger engine
// alone cannot show because they live in ScriptingEngine's dispatch:
//
//  1. Blank lines go to the triggers. `TMainConsole::runTriggers` appends a
//     '\n' to every line before handing it over, so an empty one arrives as
//     "\n" and `^(.*)$` matches it with an empty capture. Mudlet Web skipped any line
//     whose plain text was empty, so a chain collecting a room description lost
//     its blank separators (mudlet-web#159).
//
//  2. A trigger enabled by another trigger's script fires on the SAME line.
//     Desktop reads `isActive()` live inside the tree walk; Mudlet Web's store
//     subscription rebuilds the engine on a microtask that cannot run until the
//     line is over, so the child only came alive on the NEXT one — which, with
//     a child that switches itself back off, is every other line
//     (mudlet-web#156).
//
// Node env + a stubbed LuaRuntime, as host-send.test.ts does it: the engine
// boots a runtime in its constructor and the Lua side is not what is under
// test. `runWithMatches` is the hook a trigger's script runs through, so the
// stub stands in for the script.
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

const CONN = 'trigger-line-pass-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
};

function trig(over: Record<string, unknown>) {
    return {
        isGroup: false, parentId: null, enabled: true, code: 'x', language: 'lua',
        fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
        ...over,
    };
}

describe('trigger line pass', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let fired: string[];

    const boot = async (triggers: Record<string, unknown>[]) => {
        useAppStore.setState(s => ({
            connectionTriggers: { ...s.connectionTriggers, [CONN]: triggers as never },
        }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        vi.spyOn(session, 'sendData').mockImplementation(() => {});
        // The engine holds its first trigger apply until the PCRE wasm is up,
        // and does it from the async profile load this harness doesn't run.
        await TriggerEngine.ready();
        const internals = engine as unknown as EngineInternals;
        internals.triggersReady = true;
        internals.applyTriggersFromStore();
    };

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Lines', url: 'ws://localhost' }],
            }));
        }
        fired = [];
        onRunWithMatches = (name, matches) => { fired.push(`${name}:${matches[0] ?? ''}`); };
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

    it('runs triggers on blank lines', async () => {
        await boot([trig({ id: 'cap', name: 'cap', patterns: [{ type: 'regex', text: '^(.*)$' }] })]);

        engine.processFlushBatch([{ text: 'first\n\nthird\n', type: 'mud', fromServer: true }]);

        // mudlet-web#159: the middle line used to be dropped before the triggers.
        expect(fired).toEqual(['cap:first', 'cap:', 'cap:third']);
    });

    it('fires a child a parent enabled on that same line', async () => {
        await boot([
            trig({ id: 'p', name: 'my_parent', patterns: [{ type: 'regex', text: '^test$' }] }),
            trig({ id: 'c', name: 'my_child', parentId: 'p', enabled: false, patterns: [{ type: 'regex', text: '^test$' }] }),
        ]);
        onRunWithMatches = (name, matches) => {
            fired.push(`${name}:${matches[0] ?? ''}`);
            // Stands in for the scripts in the issue: the parent switches the
            // child on, the child switches itself back off.
            if (name === 'my_parent') engine.toggleTriggerByName('my_child', true);
            if (name === 'my_child') engine.toggleTriggerByName('my_child', false);
        };

        engine.processFlushBatch([{ text: 'test\ntest\n', type: 'mud', fromServer: true }]);

        // mudlet-web#156: the child used to fire on every OTHER line.
        expect(fired).toEqual(['my_parent:test', 'my_child:test', 'my_parent:test', 'my_child:test']);
    });

    it('keeps the rest of a packet after an out-of-range 256-colour escape', async () => {
        await boot([trig({ id: 'probe', name: 'probe', patterns: [{ type: 'regex', text: '^(P\\d|T18) ' }] })]);

        engine.processFlushBatch([{
            text: 'T18 a\x1b[38;5;300mXX\x1b[0mb\r\nP2 samepacket\r\n'.replace(/\r/g, ''),
            type: 'mud', fromServer: true,
        }]);

        // mudlet-web#174: the escape threw while the line was being started,
        // and the throw abandoned every line behind it in the same flush.
        expect(fired).toEqual(['probe:T18 ', 'probe:P2 ']);
    });

    it('carries on with the batch when one line throws', async () => {
        await boot([trig({ id: 'cap', name: 'cap', patterns: [{ type: 'regex', text: '^(.*)$' }] })]);
        // A throw out of the line pass itself (a script error is already
        // caught further in) — the shape the out-of-range colour took.
        const internals = engine as unknown as { processLineTriggers: (plain: string, ...rest: unknown[]) => void };
        const real = internals.processLineTriggers.bind(engine);
        vi.spyOn(internals, 'processLineTriggers').mockImplementation((plain, ...rest) => {
            if (plain === 'bad') throw new Error('boom');
            real(plain, ...rest);
        });
        const printError = vi.spyOn((engine as unknown as { api: { printError: (m: string) => void } }).api, 'printError')
            .mockImplementation(() => {});

        engine.processFlushBatch([{ text: 'one\nbad\nthree\n', type: 'mud', fromServer: true }]);

        expect(fired).toEqual(['cap:one', 'cap:three']);
        expect(printError).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
});
