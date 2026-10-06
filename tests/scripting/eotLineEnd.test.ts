// @vitest-environment node
//
// EOT (0x04) from the game, measured against Mudlet PTB (mudlet-web#376) and
// driven end to end like promptGaParity.test.ts: raw telnet bytes through
// session.feedTelnet → MudClient → LineAssembler → processFlushBatch, with a
// `^(.*)$` trigger recording each line and its isPrompt().
//
// Desktop's TBuffer counts EOT among the characters that commit a line
// (CHAR_IS_COMMIT_CHAR): the byte is dropped and the line is stored as an
// ordinary one. Web used to keep it in the line as a character.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TELNET_GA } from '../../src/mud/protocol/constants';

let onRunWithMatches: (name: string, matches: (string | undefined)[]) => void = () => {};
let currentLinePrompt = false;

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: (_code: string, name: string, matches: (string | undefined)[]) =>
                onRunWithMatches(name, matches),
            destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {},
            setCurrentLine: (_line: string, isPrompt: boolean) => { currentLinePrompt = isPrompt; },
            getCurrentLine: () => undefined,
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
const { LineAssembler } = await import('../../src/mud/connection/LineAssembler');

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = {
    innerWidth: 1024, innerHeight: 768, ...noopDom,
    matchMedia: () => ({ matches: false, ...noopDom }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
};
g.document = noopDom;

const CONN = 'eot-line-end-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    api: { feedTriggers(data: string, utf8Encoded?: boolean): string | null };
};

function trig(over: Record<string, unknown>) {
    return {
        isGroup: false, parentId: null, enabled: true, code: 'x', language: 'lua',
        fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
        ...over,
    };
}

/** Strip the SGR escapes a command echo is wrapped in. */
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');


describe('EOT from the game ends the line (mudlet-web#376)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    /** `line|isPrompt` for every regex trigger fire, in order. */
    let fired: string[];

    const boot = async () => {
        useAppStore.setState(s => ({
            connectionTriggers: {
                ...s.connectionTriggers,
                [CONN]: [
                    trig({ id: 'all', name: 'all', patterns: [{ type: 'regex', text: '^(.*)$' }] }),
                ] as never,
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
    };
    const main = () => session.consoles.get('main')!;
    /** Every buffer line from `from` to the last complete one. */
    const linesFrom = (from: number) => main().getLines(from, main().getLineCount() + 1).map(plain);

    beforeEach(() => {
        vi.useFakeTimers();
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'EOT', url: 'ws://localhost' }],
            }));
        }
        fired = [];
        currentLinePrompt = false;
        onRunWithMatches = (_name, matches) => {
            const line = (matches[0] ?? '').replace(/\n$/, '');
            fired.push(`${line}|${currentLinePrompt}`);
        };
    });

    afterEach(() => {
        onRunWithMatches = () => {};
        vi.useRealTimers();
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTriggers;
            return { connectionTriggers: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it.each([
        ['F1 a\x04b\r\n', ['F1 a', 'b']],
        ['F3 a\r\n\x04F3 b\r\n', ['F3 a', '', 'F3 b']],
        ['F4 a\x04\x04F4 b\r\n', ['F4 a', '', 'F4 b']],
        ['F5 a\x04\r\nF5 b\r\n', ['F5 a', '', 'F5 b']],
    ])('%j commits a line at each EOT', async (sent, lines) => {
        await boot();
        const before = main().getLineCount() + 1;

        session.feedTelnet(sent);

        expect(fired).toEqual(lines.map(l => `${l}|false`));
        expect(linesFrom(before)).toEqual(lines);
    });

    it('ends a GA-mode prompt line without a GA, as an ordinary line (F8)', async () => {
        await boot();
        session.feedTelnet('F8 setup> ' + TELNET_GA);
        const before = main().getLineCount() + 1;
        fired = [];

        session.feedTelnet('F8 hp> \x04');
        await vi.advanceTimersByTimeAsync(600);
        session.feedTelnet('F8 next\r\n');

        expect(fired).toEqual(['F8 hp> |false', 'F8 next|false']);
        expect(linesFrom(before)).toEqual(['F8 hp> ', 'F8 next']);
    });

    it('commits each EOT-ended piece before the rest of the line arrives (F9)', async () => {
        await boot();
        const before = main().getLineCount() + 1;

        session.feedTelnet('F9 x\x04y\x04');
        await vi.advanceTimersByTimeAsync(600);
        session.feedTelnet('z\r\n');

        expect(fired).toEqual(['F9 x|false', 'y|false', 'z|false']);
        expect(linesFrom(before)).toEqual(['F9 x', 'y', 'z']);
    });

    it('keeps ETX (0x03) as a character, as desktop does', async () => {
        await boot();
        const before = main().getLineCount() + 1;

        session.feedTelnet('E1 a\x03b\r\n');

        expect(linesFrom(before)).toEqual(['E1 a\x03b']);
    });

    it('ends fed lines too: feedTriggers commits on EOT as TBuffer does', async () => {
        await boot();
        const before = main().getLineCount() + 1;

        (engine as unknown as EngineInternals).api.feedTriggers('K1 a\x04K1 b\n');

        expect(fired).toEqual(['K1 a|false', 'K1 b|false']);
        expect(linesFrom(before)).toEqual(['K1 a', 'K1 b']);
    });
});

describe('EOT under undoServerWrap (mudlet-web#376)', () => {
    // 80 columns of prose that stops mid-sentence: held for a continuation
    // when a '\n' ends it. Desktop's join looks only at '\n'; an EOT is a hard
    // line end, so the segment is committed on its own.
    const segment = ('The road winds on past the old mill and down towards the quiet river '
        + 'bank where').padEnd(80, 'x');
    const assemble = (text: string) => {
        const chunks: string[] = [];
        const asm = new LineAssembler(
            { onChunk: t => chunks.push(t), onPrompt: () => {}, onIdleFlush: () => {} },
            { undoServerWrap: true, undoServerWrapWidth: 80 },
        );
        asm.feed(text, false, 0);
        asm.reset();
        return chunks.join('');
    };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a newline-ended segment at the wrap column is joined to its continuation', () => {
        expect(segment).toHaveLength(80);
        expect(assemble(segment + '\nthe ferry waits.\n')).toBe(segment + ' the ferry waits.\n');
    });

    it('an EOT-ended one is not', () => {
        expect(assemble(segment + '\x04the ferry waits.\n')).toBe(segment + '\nthe ferry waits.\n');
    });

    it('an EOT commits a held line on its own before its own line', () => {
        expect(assemble(segment + '\nthe end\x04next.\n')).toBe(segment + '\nthe end\nnext.\n');
    });
});
