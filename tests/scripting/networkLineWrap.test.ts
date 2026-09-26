// @vitest-environment node
//
// A server line longer than the main window's wrap width is stored as several
// buffer lines once its triggers have run — TBuffer::translateToPlainText wraps
// after the trigger pass — so getLines(), getLineCount() and the cursor APIs
// count the lines Mudlet counts, while the triggers still saw the whole line
// (mudlet-web#189). Same harness as triggerLinePass.test.ts.
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

const CONN = 'network-line-wrap-conn';

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

describe('network line wrap', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let seen: string[];

    const boot = async () => {
        useAppStore.setState(s => ({
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [trig({ id: 'all', name: 'all', patterns: [{ type: 'regex', text: '^(.*)$' }] })] as never },
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
    };
    const api = () => (engine as unknown as { api: { setWindowWrap: (n: string, w: number) => boolean } }).api;
    const main = () => session.consoles.get('main')!;

    // "w00xx w01xx … w29xx": 30 words of 5, 179 characters.
    const long = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, '0')}xx`).join(' ');

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Wrap', url: 'ws://localhost' }],
            }));
        }
        seen = [];
        onRunWithMatches = (_name, matches) => { seen.push(matches[0] ?? ''); };
    });

    afterEach(() => {
        onRunWithMatches = () => {};
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTriggers;
            return { connectionTriggers: rest };
        });
        useAppStore.getState().patchConnectionProfile(CONN, { outputWrapAt: undefined });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('splits an over-long server line at the wrap width after the triggers saw it whole', async () => {
        await boot();
        expect(api().setWindowWrap('main', 100)).toBe(true);
        const before = main().getLineCount() + 1;
        const rendered: string[] = [];
        session.events.on('message', (m) => { if (m !== undefined) rendered.push(typeof m === 'string' ? m : m.text); });

        engine.processFlushBatch([{ text: `${long}\nDONE\n`, type: 'mud', fromServer: true }]);

        expect(long.length).toBe(179);
        expect(seen).toEqual([long, 'DONE']);
        const lines = main().getLines(before, main().getLineCount() + 1);
        expect(lines).toHaveLength(3);
        expect(lines[0].length).toBeLessThanOrEqual(100);
        expect(lines[1]).toHaveLength(83);
        // Desktop Mudlet: the last line is 83 characters with w25xx at column
        // 55 (1-based, as string.find counts).
        expect(lines[1].indexOf('w25xx') + 1).toBe(55);
        expect(lines[2]).toBe('DONE');
        // Drawn as the lines it is stored as.
        expect(rendered).toEqual(lines);
    });

    it('leaves the line whole when no wrap width is set', async () => {
        await boot();
        const before = main().getLineCount() + 1;

        engine.processFlushBatch([{ text: `${long}\n`, type: 'mud', fromServer: true }]);

        expect(main().getLines(before, main().getLineCount() + 1)).toEqual([long]);
    });
});
