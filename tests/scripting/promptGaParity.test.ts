// @vitest-environment node
//
// Prompt handling measured against Mudlet PTB (mudlet-web#288), driven end to
// end: raw telnet bytes through session.feedTelnet → MudClient → LineAssembler
// → ScriptingEngine.processFlushBatch, with a `^(.*)$` regex trigger recording each
// line and its isPrompt(), a permanent prompt-type trigger, and the buffer read
// back with getLines. Same harness as networkLineWrap.test.ts.
//
// 1. A command sent while a GA prompt is the last line is written onto that
//    prompt line and stored nowhere else (TConsole::printCommand's insertInLine
//    branch). The web buffer used to hold it twice: once on the prompt line,
//    where the renderer appended it into the shared buffer, and once more on a
//    line of its own.
// 2. A GA/EOR with nothing in front of it ends an empty line flagged as the
//    prompt (TBuffer::commitLineData on '\xff'), and prompt triggers fire on it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TELNET_GA, TELNET_EOR } from '../../src/mud/protocol/constants';

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

const CONN = 'prompt-ga-parity-conn';

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

/** Strip the SGR escapes a command echo is wrapped in. */
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('GA/EOR prompts vs. Mudlet (mudlet-web#288)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    /** `line|isPrompt` for every regex trigger fire, `PROMPT:line` for every
     *  prompt-trigger fire, in order. */
    let fired: string[];

    const boot = async () => {
        useAppStore.setState(s => ({
            connectionTriggers: {
                ...s.connectionTriggers,
                [CONN]: [
                    trig({ id: 'all', name: 'all', patterns: [{ type: 'regex', text: '^(.*)$' }] }),
                    trig({ id: 'prompt', name: 'prompt', patterns: [{ type: 'prompt', text: '' }] }),
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
    const lineAt = (n: number) =>
        (main() as unknown as { history: { isPrompt: boolean }[] }).history[n];
    /** Every buffer line from `from` to the last complete one. */
    const linesFrom = (from: number) => main().getLines(from, main().getLineCount() + 1).map(plain);

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Prompt', url: 'ws://localhost' }],
            }));
        }
        fired = [];
        currentLinePrompt = false;
        onRunWithMatches = (name, matches) => {
            const line = (matches[0] ?? '').replace(/\n$/, '');
            fired.push(name === 'prompt' ? `PROMPT:${line}` : `${line}|${currentLinePrompt}`);
        };
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

    describe('1. a command sent at a GA prompt', () => {
        it('is stored once, on the prompt line', async () => {
            await boot();
            const before = main().getLineCount() + 1;

            session.feedTelnet('B2 hp> ' + TELNET_GA);
            session.send('cmdX');
            session.feedTelnet('B2 reply\r\n');

            // Desktop: [B2 hp> cmdX] [B2 reply]
            expect(linesFrom(before)).toEqual(['B2 hp> cmdX', 'B2 reply']);
            // The line it joined is no longer a prompt — only the first command
            // after a prompt joins it.
            expect(lineAt(before)?.isPrompt).toBe(false);
        });

        it('joins only the first command; a second goes on its own line', async () => {
            await boot();
            const before = main().getLineCount() + 1;

            session.feedTelnet('G1 hp> ' + TELNET_GA);
            session.send('glance');
            session.send('look');
            session.feedTelnet('G1 reply\r\nG1 hp> ' + TELNET_GA);

            expect(linesFrom(before)).toEqual(['G1 hp> glance', 'look', 'G1 reply', 'G1 hp> ']);
        });

        it('stays on its own line when sent from inside the trigger engine', async () => {
            // printCommand's mTriggerEngineMode branch appends a new line even
            // after a prompt.
            await boot();
            const before = main().getLineCount() + 1;

            session.feedTelnet('T1 hp> ' + TELNET_GA);
            session.scriptEchoDeferred = true;
            session.echoCommand('fromTrigger');
            session.scriptEchoDeferred = false;

            expect(linesFrom(before)).toEqual(['T1 hp> ', 'fromTrigger']);
        });

        it('goes on its own line when there is no GA prompt', async () => {
            await boot();
            const before = main().getLineCount() + 1;

            session.feedTelnet('N1 line\r\n');
            session.send('cmdY');

            expect(linesFrom(before)).toEqual(['N1 line', 'cmdY']);
        });
    });

    describe('2. a bare GA/EOR', () => {
        it('after a newline in one packet makes an empty prompt line and fires prompt triggers', async () => {
            await boot();
            const before = main().getLineCount() + 1;

            session.feedTelnet('B3 l1\r\n' + TELNET_GA + 'B3 l2\r\n');

            expect(fired).toEqual(['B3 l1|false', '|true', 'PROMPT:', 'B3 l2|false']);
            expect(linesFrom(before)).toEqual(['B3 l1', '', 'B3 l2']);
        });

        it('after every line makes an empty prompt line each time', async () => {
            await boot();
            const before = main().getLineCount() + 1;

            session.feedTelnet('B5 a\r\n' + TELNET_GA);
            session.feedTelnet('B5 b\r\n' + TELNET_GA);
            session.feedTelnet('B5 c\r\n' + TELNET_GA);

            expect(linesFrom(before)).toEqual(['B5 a', '', 'B5 b', '', 'B5 c', '']);
            expect(fired.filter(f => f.startsWith('PROMPT:'))).toHaveLength(3);
        });

        it('on its own makes an empty prompt line; EOR does the same', async () => {
            await boot();
            const before = main().getLineCount() + 1;

            session.feedTelnet(TELNET_GA);
            session.feedTelnet(TELNET_EOR);

            expect(fired).toEqual(['|true', 'PROMPT:', '|true', 'PROMPT:']);
            expect(linesFrom(before)).toEqual(['', '']);
            expect(lineAt(before)?.isPrompt).toBe(true);
        });

        it('does not make the next ordinary line a prompt', async () => {
            await boot();

            session.feedTelnet('R1 room\r\n');
            session.feedTelnet(TELNET_GA);
            session.feedTelnet('R1 next\r\n');

            expect(fired).toEqual(['R1 room|false', '|true', 'PROMPT:', 'R1 next|false']);
        });
    });

    // TBuffer::commitLineData applies blankLinesBehaviour to the empty line
    // before it looks at the prompt marker, so the empty prompt line a bare
    // GA ends is subject to it like any other blank server line (#290).
    describe('3. a bare GA/EOR under blankLinesBehaviour', () => {
        const setConfig = (key: string, value: unknown) =>
            (engine as unknown as { api: { setConfig: (k: string, v: unknown) => unknown } }).api.setConfig(key, value);

        it('"hide" drops the empty prompt line, and no prompt trigger sees it', async () => {
            await boot();
            setConfig('blankLinesBehaviour', 'hide');
            const before = main().getLineCount() + 1;

            session.feedTelnet('H1 l1\r\n' + TELNET_GA + 'H1 l2\r\n');

            expect(fired).toEqual(['H1 l1|false', 'H1 l2|false']);
            expect(linesFrom(before)).toEqual(['H1 l1', 'H1 l2']);
        });

        it('"replacewithspace" stores a single-space prompt line and fires prompt triggers on it (they capture nothing)', async () => {
            await boot();
            setConfig('blankLinesBehaviour', 'replacewithspace');
            const before = main().getLineCount() + 1;

            session.feedTelnet('S1 l1\r\n' + TELNET_GA + 'S1 l2\r\n');

            expect(fired).toEqual(['S1 l1|false', ' |true', 'PROMPT:', 'S1 l2|false']);
            expect(linesFrom(before)).toEqual(['S1 l1', ' ', 'S1 l2']);
            expect(lineAt(before + 1)?.isPrompt).toBe(true);
        });
    });
});
