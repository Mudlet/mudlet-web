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
        useAppStore.getState().patchConnectionProfile(CONN, { outputWrapAt: undefined, outputWrapHangingIndent: undefined });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    // Desktop reads Host::mWrapAt for the NAWS width cap and NEW-ENVIRON
    // WORD_WRAP, so the session has to hear about every change to main's wrap,
    // whether a script or the Settings field made it (#286).
    it('hands main\'s wrap to the session for NAWS, from setWindowWrap and from the store', async () => {
        const wraps: number[] = [];
        const spy = vi.spyOn(MudSession.prototype, 'setWrapAt').mockImplementation((n: number) => { wraps.push(n); });
        await boot();
        expect(wraps.at(-1)).toBe(100); // the profile default, when the API comes up
        api().setWindowWrap('main', 60);
        expect(wraps.at(-1)).toBe(60);
        useAppStore.getState().patchConnectionProfile(CONN, { outputWrapAt: 80 });
        expect(wraps.at(-1)).toBe(80);
        spy.mockRestore();
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

    // Desktop wraps the main console at Host::mWrapAt, 100 unless changed, so
    // the issue's line splits the same way with no setWindowWrap at all.
    it('wraps an over-long line at 100 by default', async () => {
        await boot();
        expect((engine as unknown as { api: { getWindowWrap: (n: string) => number } }).api.getWindowWrap('main')).toBe(100);
        const before = main().getLineCount() + 1;
        const rendered: string[] = [];
        session.events.on('message', (m) => { if (m !== undefined) rendered.push(typeof m === 'string' ? m : m.text); });

        engine.processFlushBatch([{ text: `${long}\n`, type: 'mud', fromServer: true }]);

        expect(seen).toEqual([long]);
        const lines = main().getLines(before, main().getLineCount() + 1);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toHaveLength(83);
        expect(lines[1].indexOf('w25xx') + 1).toBe(55);
        expect(rendered).toEqual(lines);
    });

    it('applies a saved outputWrapAt when the profile loads', async () => {
        useAppStore.getState().patchConnectionProfile(CONN, { outputWrapAt: 60 });
        await boot();
        expect(main().getWrapWidth()).toBe(60);
        const before = main().getLineCount() + 1;

        engine.processFlushBatch([{ text: `${long}\n`, type: 'mud', fromServer: true }]);

        const lines = main().getLines(before, main().getLineCount() + 1);
        expect(lines).toHaveLength(3);
        expect(lines.every(l => l.length <= 60)).toBe(true);
    });

    // The Settings field writes the store directly, never through setWindowWrap.
    it('applies a changed outputWrapAt at once, indents included', async () => {
        await boot();
        useAppStore.getState().patchConnectionProfile(CONN, { outputWrapAt: 50, outputWrapHangingIndent: 2 });
        expect(main().getWrapWidth()).toBe(50);
        expect(main().getWrapHangingIndent()).toBe(2);
        const before = main().getLineCount() + 1;

        engine.processFlushBatch([{ text: `${long}\n`, type: 'mud', fromServer: true }]);

        const lines = main().getLines(before, main().getLineCount() + 1);
        expect(lines.length).toBeGreaterThan(3);
        expect(lines.every(l => l.length <= 50)).toBe(true);
        expect(lines.slice(1).every(l => l.startsWith('  '))).toBe(true);

        // Cleared → back to the default of 100.
        useAppStore.getState().patchConnectionProfile(CONN, { outputWrapAt: undefined, outputWrapHangingIndent: undefined });
        expect(main().getWrapWidth()).toBe(100);
        expect(main().getWrapHangingIndent()).toBe(0);
    });

    it('leaves the line whole when the Settings turned wrapping off', async () => {
        useAppStore.getState().patchConnectionProfile(CONN, { outputWrapAt: 0 });
        await boot();
        const before = main().getLineCount() + 1;

        engine.processFlushBatch([{ text: `${long}\n`, type: 'mud', fromServer: true }]);

        expect(main().getLines(before, main().getLineCount() + 1)).toEqual([long]);
    });
    // mudlet-web#364 item 1: a break that falls in a line's trailing spaces
    // leaves an empty last piece. Desktop keeps that as the next current line
    // (translateToPlainText adds none when the wrap left an empty one), so the
    // buffer holds no "" line between this line and the next.
    it('stores no empty line after a wrapped line whose trailing space overflowed', async () => {
        await boot();
        api().setWindowWrap('main', 20);
        const before = main().getLineCount() + 1;

        engine.processFlushBatch([{ text: 'prompt text that is long enough to wrap> \n-\n', type: 'mud', fromServer: true }]);

        expect(main().getLines(before, main().getLineCount() + 1))
            .toEqual(['prompt text that is ', 'long enough to wrap>', '-']);
    });

    it('stores no empty line after a wide character at width 1', async () => {
        await boot();
        api().setWindowWrap('main', 1);
        const before = main().getLineCount() + 1;

        engine.processFlushBatch([{ text: '日本\n-\nす\n-\n😀\n-\n', type: 'mud', fromServer: true }]);

        expect(main().getLines(before, main().getLineCount() + 1))
            .toEqual(['日', '本', '-', 'す', '-', '😀', '-']);
    });

    // Item 2: TBuffer::wrapLine copies the TChar the indent precedes, so the
    // hanging indent is the colour of the text it starts, not of the end of
    // the piece above.
    it('gives the hanging indent the format of the character it precedes', async () => {
        await boot();
        api().setWindowWrap('main', 20);
        (api() as unknown as { setWindowWrapHangingIndent: (n: string, i: number) => boolean })
            .setWindowWrapHangingIndent('main', 3);
        const pieces: { text: string; getSegments: () => { text: string; state?: { fg?: unknown } }[] }[] = [];
        session.events.on('message', (m) => { if (m && typeof m !== 'string') pieces.push(m as never); });

        engine.processFlushBatch([{ text: '\x1b[32mgreen first word \x1b[0mand then more text here\n', type: 'mud', fromServer: true }]);

        expect(pieces.map(p => p.text)).toEqual(['green first word and', '   then more text ', '   here']);
        const continuation = pieces[1].getSegments();
        // One run: the indent is not split off in the green of the line above.
        expect(continuation).toHaveLength(1);
        expect(continuation[0].state?.fg).toBeUndefined();
    });

    // Item 4: the line desktop opens after a game line has no timestamp.
    it('answers "" for getTimestamp on main\'s empty last line after a game line', async () => {
        await boot();
        engine.processFlushBatch([{ text: 'first\nhello\n', type: 'mud', fromServer: true }]);
        const lua = api() as unknown as { getTimestamp: (n?: number) => string | null; getLineCount: () => number };
        const last = lua.getLineCount();
        expect(lua.getTimestamp(last)).toBe('');
        expect(lua.getTimestamp(last - 1)).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d $/);
    });
});
