// @vitest-environment node
//
// Gag-and-rewrite triggers measured against the Mudlet PTB (mudlet-web#383).
// Each case is an item of the issue, with desktop's result as the expectation.
//
//  1. A second deleteLine() on the same matched line is a no-op. Mudlet Web
//     deleted the line above, one more line per extra call.
//  2. Text echoed after deleteLine() without a leading newline joins the line
//     above in the buffer — and has to reach the screen too: that line was
//     already drawn, so it must be drawn again.
//  3. insertText/cinsertText/prefix/suffix after deleteLine() append to the
//     line above, as the echo does, instead of starting a line of their own.
//
// Node env + a stubbed LuaRuntime (as triggerLinePass.test.ts does it): the
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
const { AnsiAwareBuffer } = await import('../../src/mud/text/FormatState');
type ScriptingAPI = import('../../src/scripting/ScriptingAPI').ScriptingAPI;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'gag-rewrite-383-conn';

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


describe('mudlet-web#383 — gag and rewrite parity with desktop', () => {
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

    /** GUIUtils' suffix()/prefix(), as the bundled Lua runs them. */
    const suffix = (what: string) => {
        api.moveCursor(undefined, [...(api.getCurrentLine() ?? '')].length, api.getLineNumber());
        api.insertText(what);
    };
    const prefix = (what: string) => {
        api.moveCursor(undefined, 0, api.getLineNumber());
        api.insertText(what);
    };
    /** cinsertText's xEcho loop: colour, insert, step the cursor past it. */
    const cinsertText = (segments: [number[], string][]) => {
        for (const [[r, g2, b], text] of segments) {
            api.setFgColor(r, g2, b);
            api.insertText(text);
            api.moveCursor(undefined, api.getColumnNumber() + text.length, api.getLineNumber());
        }
        api.resetFormat();
    };

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Gag', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        onRunWithMatches = (name, matches) => scripts[name]?.(matches);
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

    describe('1. gagging the same line twice', () => {
        it('two spam triggers gag only the matched line', async () => {
            await boot([
                trig({ id: 's1', name: 'spam1', patterns: [{ type: 'regex', text: '^(\\w+) spams' }] }),
                trig({ id: 's2', name: 'spam2', patterns: [{ type: 'regex', text: '^(\\w+) spams' }] }),
            ]);
            scripts.spam1 = () => api.deleteLine();
            scripts.spam2 = (m) => { api.deleteLine(); api.echo(`[spam by ${m[1]} hidden]`); };

            feed('BEGIN\nYou are in a room.\nbob spams\nnxt 1\nHP 100> \neve spams\nnxt 2\nHeader line\nnxt 3\n');

            expect(lines()).toEqual([
                'BEGIN',
                'You are in a room.[spam by bob hidden]',
                'nxt 1',
                'HP 100> [spam by eve hidden]',
                'nxt 2',
                'Header line',
                'nxt 3',
            ]);
        });

        it('one trigger calling deleteLine three times removes one line', async () => {
            await boot([trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^GAG$' }] })]);
            scripts.gag = () => { api.deleteLine(); api.deleteLine(); api.deleteLine(); };

            feed('one\ntwo\nthree\nGAG\nfour\n');

            expect(lines()).toEqual(['one', 'two', 'three', 'four']);
        });

        it('still deletes the line clearWindow() left, in a trigger that cleared the window', async () => {
            await boot([trig({ id: 'e', name: 'empty', patterns: [{ type: 'regex', text: '^EMPTY$' }] })]);
            let emptied: unknown;
            scripts.empty = () => {
                api.clearWindow();
                api.moveCursor(undefined, 0, 0);
                api.deleteLine();
                emptied = api.getLines(0, 1);
                api.echo('from inside\n');
            };

            feed('before\nEMPTY\n');

            // EmptyBufferOps_spec: the buffer is emptied outright, then the echo
            // writes into it again. An empty buffer has no line 0 to read.
            expect(emptied).toEqual([]);
            expect(lines()).toContain('from inside');
        });
    });

    describe('2. an echo after deleteLine()', () => {
        it('joins the line above and redraws it', async () => {
            await boot([
                trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^GAG$' }] }),
                trig({ id: 'l', name: 'late', patterns: [{ type: 'regex', text: '^GAG$' }] }),
            ]);
            const redrawn: string[] = [];
            const rerender = AnsiAwareBuffer.prototype.rerender;
            vi.spyOn(AnsiAwareBuffer.prototype, 'rerender').mockImplementation(function (this: InstanceType<typeof AnsiAwareBuffer>) {
                redrawn.push(this.text);
                rerender.call(this);
            });
            scripts.gag = () => { api.deleteLine(); api.echo('[R1]'); };
            scripts.late = () => api.echo('[R2]');

            feed('p1\nGAG\np2\n');

            expect(lines()).toEqual(['p1[R1][R2]', 'p2']);
            // The line above was drawn before its trigger pass started; without a
            // redraw the text it gained never reaches the screen.
            expect(redrawn).toContain('p1[R1]');
            expect(redrawn).toContain('p1[R1][R2]');
        });

        it('a newline in the echo still ends the joined line', async () => {
            await boot([trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^GAG$' }] })]);
            scripts.gag = () => { api.deleteLine(); api.echo('[R1]\n'); };

            feed('p1\nGAG\np2\n');

            expect(lines()).toEqual(['p1[R1]', 'p2']);
        });
    });

    describe('3. inserting after deleteLine()', () => {
        it('insertText joins the line above', async () => {
            await boot([trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^GAG$' }] })]);
            scripts.gag = () => { api.deleteLine(); api.insertText('ins1'); };

            feed('pre1\nGAG\npost\n');

            expect(lines()).toEqual(['pre1ins1', 'post']);
        });

        it('cinsertText joins the line above, in its colours', async () => {
            await boot([trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^GAG$' }] })]);
            scripts.gag = () => { api.deleteLine(); cinsertText([[[255, 0, 0], 'ci'], [[0, 255, 0], 'ns2']]); };

            feed('pre2\nGAG\npost\n');

            expect(lines()).toEqual(['pre2cins2', 'post']);
            api.moveCursor(undefined, 4, 0);
            api.selectSection(4, 2);
            expect(api.getFgColor()).toEqual([255, 0, 0]);
            api.selectSection(6, 3);
            expect(api.getFgColor()).toEqual([0, 255, 0]);
        });

        it('insertText from a later trigger on the gagged line joins the line above', async () => {
            await boot([
                trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^GAG$' }] }),
                trig({ id: 'l', name: 'late', patterns: [{ type: 'regex', text: '^GAG$' }] }),
            ]);
            scripts.gag = () => api.deleteLine();
            scripts.late = () => api.insertText('late3');

            feed('pre3\nGAG\npost\n');

            expect(lines()).toEqual(['pre3late3', 'post']);
            expect(api.getLineCount()).toBe(2);
        });

        it('prefix and suffix join the line above', async () => {
            await boot([trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^GAG$' }] })]);
            scripts.gag = () => { api.deleteLine(); prefix('P::'); suffix('S'); };

            feed('nxt a\nGAG\nnxt b\n');

            expect(lines()).toEqual(['nxt aP::S', 'nxt b']);
        });
    });
});
