// @vitest-environment node
//
// mudlet-web#358 items 2 and 3, measured against the Mudlet PTB.
//
// 2. feedTriggers text left without a trailing newline sits in TBuffer's
//    mMudLine until later data completes it: it is not drawn meanwhile (an echo
//    made before then lands above it), the next feed or server line completes
//    it, and it is never drawn twice. Mudlet Web echoed it at once, so a later
//    echo joined it, and then re-emitted it from the next feed as well.
// 3. Output a trigger writes AFTER a nested feedTriggers follows the fed lines
//    (TConsole::echo writes onto the buffer's last line). Mudlet Web kept
//    appending it to the trigger's own line.
//
// Same harness as moveCursorEndInTrigger343.test.ts: a stubbed LuaRuntime whose
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

const CONN = 'feed-triggers-358-conn';

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

describe('mudlet-web#358 — feedTriggers placement', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: MudSessionT;
    let api: ScriptingAPI;
    let scripts: Record<string, (matches: (string | undefined)[]) => void>;
    /** The line each trigger fired on, in order. */
    let fired: string[];

    beforeEach(async () => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'FeedTriggers358', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        fired = [];
        onRunWithMatches = (name, matches) => {
            fired.push(`${name}:${matches[0] ?? ''}`);
            scripts[name]?.(matches);
        };
        useAppStore.setState(s => ({
            connectionTriggers: {
                ...s.connectionTriggers,
                [CONN]: [
                    trig('ft2', '^ft2.*$'),
                    trig('pa', '^PA.*$'),
                    trig('feedE', '^FEEDE '),
                    trig('feedP', '^FEEDP '),
                    trig('feedM', '^FEEDM '),
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
    /** Lines from the network, the way MudClient hands them over. */
    const server = (text: string) =>
        session.events.emit('flushLines', [{ text, type: 'mud' }]);

    describe('item 2: an unterminated feed', () => {
        it('is not drawn until completed, so an echo lands above it', () => {
            api.feedTriggers('ft1\nft2');
            expect(lines()).toEqual(['ft1']);
            api.echo('~E\n');
            api.feedTriggers('ZZ\n');
            // Desktop: ft1 / ~E / ft2ZZ — the fed line once, after the echo.
            expect(lines()).toEqual(['ft1', '~E', 'ft2ZZ']);
            expect(fired).toEqual(['ft2:ft2ZZ']);
        });

        it('shows nothing on screen while it is held', () => {
            const shown: string[] = [];
            session.events.on('message', (line) => {
                if (line) shown.push(typeof line === 'string' ? line : line.text);
            });
            api.feedTriggers('held only');
            expect(shown).toEqual([]);
            expect(lines()).toEqual([]);
        });

        it('is completed by the server\'s next line rather than repeated', () => {
            api.feedTriggers('PA-partial');
            server('SRV1\n');
            api.feedTriggers('QQ\n');
            // One TBuffer: the server's line finishes the fed one, and the
            // partial text appears exactly once.
            expect(lines()).toEqual(['PA-partialSRV1', 'QQ']);
            expect(lines().join('\n').match(/PA-partial/g)).toHaveLength(1);
            expect(fired).toEqual(['pa:PA-partialSRV1']);
        });

        it('keeps an escape sequence split across two feeds as one', () => {
            api.feedTriggers('SPLIT(\x1b[3');
            api.feedTriggers('1mred\x1b[0m)SPLIT\n');
            expect(lines()).toEqual(['SPLIT(red)SPLIT']);
        });
    });

    describe('item 3: output after a nested feedTriggers in a trigger', () => {
        it('an echo follows the fed line', () => {
            scripts.feedE = () => {
                api.feedTriggers('fedA\n');
                api.echo('[E1]');
            };
            server('FEEDE one\n');
            expect(lines()).toEqual(['FEEDE one', 'fedA', '[E1]']);
        });

        it('a print follows the fed line', () => {
            scripts.feedP = () => {
                api.feedTriggers('fedB\n');
                // print("[P2]") — the padded text and its newline.
                api.echo('[P2]    \n');
            };
            server('FEEDP two\n');
            expect(lines()).toEqual(['FEEDP two', 'fedB', '[P2]    ']);
        });

        it('an echo before the feed stays on the trigger line, one after follows the fed lines', () => {
            scripts.feedM = () => {
                api.echo('[pre]');
                api.feedTriggers('fedC\nfedD\n');
                api.echo('[post]');
            };
            server('FEEDM three\nnext\n');
            expect(lines()).toEqual(['FEEDM three[pre]', 'fedC', 'fedD', '[post]', 'next']);
        });
    });
});
