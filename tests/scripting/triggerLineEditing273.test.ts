// @vitest-environment node
//
// Trigger-time line editing measured against the Mudlet PTB (mudlet-web#273).
// Each case is a row of the issue, with desktop's result as the expectation.
//
//  1. After deleteLine() on the matched line, a later trigger on the same line
//     is on NO line: getCurrentLine() is "ERROR: invalid line number" and
//     selectString() is -1. Mudlet Web read the line above instead, so the
//     second trigger edited the previous line.
//  2. replace() leaves the selection standing (same start, old length), so a
//     colour set straight after it lands on the replacement.
//  3. moveCursorEnd() in a trigger parks on the matched line's LAST character,
//     not one line further and one column past the end.
//  4. A multiline (AND) trigger's highlight is painted per condition, on each
//     line a pattern matched. Mudlet Web painted nothing.
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
type ScriptingAPI = import('../../src/scripting/ScriptingAPI').ScriptingAPI;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'trigger-line-editing-273-conn';

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

const MAGENTA = [255, 0, 255];

describe('mudlet-web#273 — trigger line editing parity with desktop', () => {
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

    /** The foreground colour of each character of line `y`. */
    const fgOf = (y: number): number[][] => {
        const text = lines()[y];
        const out: number[][] = [];
        for (let x = 0; x < text.length; x++) {
            api.moveCursor(undefined, x, y);
            api.selectSection(x, 1);
            out.push(api.getFgColor() ?? []);
        }
        api.deselect();
        return out;
    };

    /** The characters of line `y` painted `rgb`, as a string with gaps as '.'. */
    const paintedIn = (y: number, rgb: number[]): string => {
        const text = lines()[y];
        return fgOf(y).map((c, i) => (c.join() === rgb.join() ? text[i] : '.')).join('');
    };

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Editing', url: 'ws://localhost' }],
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

    describe('1. after deleteLine() later triggers are on no line', () => {
        it('leaves the previous line alone', async () => {
            await boot([
                trig({ id: 'p1', name: 'pdel1', patterns: [{ type: 'regex', text: '^PDEL ' }] }),
                trig({ id: 'p2', name: 'pdel2', patterns: [{ type: 'regex', text: '^PDEL ' }] }),
            ]);
            const seen: unknown[] = [];
            scripts.pdel1 = () => { api.deleteLine(); seen.push(api.getCurrentLine()); };
            scripts.pdel2 = () => {
                const p = api.selectString('end', 1);
                seen.push(p);
                if (p > -1) api.replace('XXX');
            };

            feed('MARK start end\nPDEL kill end\nother end\n');

            expect(seen).toEqual(['ERROR: invalid line number', -1]);
            expect(lines()).toEqual(['MARK start end', 'other end']);
        });

        it('a multiline trigger completing on a deleted line is on no line either', async () => {
            await boot([
                trig({ id: 'g', name: 'gag', patterns: [{ type: 'regex', text: '^MLY ' }] }),
                trig({
                    id: 'ml', name: 'ml', multiline: true, delta: 1,
                    patterns: [{ type: 'regex', text: '^MLX ' }, { type: 'regex', text: '^MLY ' }],
                }),
            ]);
            let current: unknown;
            scripts.gag = () => api.deleteLine();
            scripts.ml = () => { current = api.getCurrentLine(); };

            feed('MLX one\nMLY two\n');

            expect(current).toBe('ERROR: invalid line number');
            expect(lines()).toEqual(['MLX one']);
        });
    });

    describe('2. replace() keeps the selection', () => {
        it('so a colour set after it paints the replacement', async () => {
            await boot([trig({ id: 'r', name: 'prep', patterns: [{ type: 'regex', text: '^PREP ' }] })]);
            let sel: unknown;
            scripts.prep = () => {
                api.selectString('replace', 1);
                api.replace('rep');
                api.setFgColor(255, 0, 0);
                sel = api.getSelection();
            };

            feed('PREP after replace fg\n');

            expect(sel).toEqual({ text: 'rep fg', start: 11, length: 7 });
            expect(lines()).toEqual(['PREP after rep fg']);
            expect(paintedIn(0, [255, 0, 0])).toBe('...........rep fg');
        });
    });

    describe('3. moveCursorEnd() in a trigger', () => {
        it('lands on the last character of the matched line', async () => {
            await boot([trig({ id: 'm', name: 'me', patterns: [{ type: 'regex', text: '^ME ' }] })]);
            const seen: unknown[] = [];
            scripts.me = () => {
                api.moveCursorEnd();
                seen.push(api.getLineNumber() === api.getLineCount(), api.getColumnNumber());
                api.insertText('[ins]');
                seen.push(api.getCurrentLine());
            };

            feed('MARK\nME move end\n');

            expect(seen).toEqual([true, 10, 'ME move en[ins]d']);
            expect(lines()).toEqual(['MARK', 'ME move en[ins]d']);
        });
    });

    describe('4. multiline trigger highlight', () => {
        it('paints each condition\'s captures on its own line (delta 1)', async () => {
            await boot([trig({
                id: 'h', name: 'hm', multiline: true, delta: 1,
                highlight: { fg: '#ff00ff', bg: '#000000' },
                patterns: [{ type: 'regex', text: '^HMA (\\w+)' }, { type: 'regex', text: '^HMB (\\w+)' }],
            })]);
            let fired = 0;
            scripts.hm = () => { fired++; };

            feed('HMA one\nHMB two\n');

            expect(fired).toBe(1);
            expect(paintedIn(0, MAGENTA)).toBe('....one');
            expect(paintedIn(1, MAGENTA)).toBe('....two');
        });

        it('paints substring conditions across a line delta of 2', async () => {
            await boot([trig({
                id: 's', name: 'sub', multiline: true, delta: 2,
                highlight: { fg: '#00ff00', bg: '#0000ff' },
                patterns: [{ type: 'substring', text: 'alpha' }, { type: 'substring', text: 'beta' }],
            })]);

            feed('x alpha\nfiller\ny beta\n');

            expect(paintedIn(0, [0, 255, 0])).toBe('..alpha');
            expect(paintedIn(1, [0, 255, 0])).toBe('......');
            expect(paintedIn(2, [0, 255, 0])).toBe('..beta');
        });

        it('paints both conditions met on the same line (delta 0)', async () => {
            await boot([trig({
                id: 'z', name: 'same', multiline: true, delta: 0,
                highlight: { fg: '#ffff00' },
                patterns: [{ type: 'substring', text: 'sameA' }, { type: 'regex', text: 'sameB (\\d+)' }],
            })]);

            feed('sameA sameB 42\n');

            expect(paintedIn(0, [255, 255, 0])).toBe('sameA.......42');
        });

        it('paints a tempComplexRegexTrigger chain', async () => {
            await boot([]);
            const spec = {
                name: 'cx', code: '', multiline: true, isFilter: false, multipleMatches: false,
                fireLength: 0, delta: 1, highlight: { fg: '#ff00ff', bg: '#000000' },
            };
            engine.createTempComplexTrigger({ ...spec, patterns: [{ type: 'regex', text: '^CXA (\\w+)' }] });
            engine.createTempComplexTrigger({ ...spec, patterns: [{ type: 'regex', text: '^CXB (\\w+)' }] });
            // The store subscription that recompiles in the app is not wired here.
            (engine as unknown as EngineInternals).applyTriggersFromStore();

            feed('CXA one\nCXB two\n');

            expect(paintedIn(0, MAGENTA)).toBe('....one');
            expect(paintedIn(1, MAGENTA)).toBe('....two');
        });
    });
});
