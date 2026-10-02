// @vitest-environment node
//
// setConfig options checked against desktop Mudlet PTB side by side
// (Mudlet/mudlet-web#290): blankLinesBehaviour has to govern what the triggers
// and the buffer see, ambiguousEAsianWidthCharacters has to change how lines
// wrap, and sysSettingChanged is raised for desktop's short list only. Same
// harness as networkLineWrap.test.ts — a real engine with a mocked Lua runtime
// whose trigger dispatch is recorded.
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
const { setAmbiguousWidthWide, isAmbiguousWidthWide } = await import('../../src/mud/text/wcwidth');

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'set-config-parity-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
};

type Api = {
    setConfig: (key: string, value: unknown) => boolean | string;
    getConfig: (key: string) => unknown;
    setWindowWrap: (name: string, width: number) => boolean;
};

function trig(over: Record<string, unknown>) {
    return {
        isGroup: false, parentId: null, enabled: true, code: 'x', language: 'lua',
        fireLength: 0, multipleMatches: false, multiline: false, delta: 0, isFilter: false,
        ...over,
    };
}

describe('setConfig parity with desktop (#290)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let seen: string[];
    let raised: [string, unknown[]][];

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
        raised = [];
        const raise = engine.raiseEvent.bind(engine);
        vi.spyOn(engine, 'raiseEvent').mockImplementation((event, args = []) => {
            raised.push([event, args]);
            raise(event, args);
        });
    };
    const api = () => (engine as unknown as { api: Api }).api;
    const main = () => session.consoles.get('main')!;
    /** The lines stored in main by `text`, fed as one server batch. */
    const feed = (text: string): string[] => {
        const before = main().getLineCount() + 1;
        engine.processFlushBatch([{ text, type: 'mud', fromServer: true }]);
        return main().getLines(before, main().getLineCount() + 1);
    };
    const settingEvents = () => raised.filter(([e]) => e === 'sysSettingChanged').map(([, a]) => a);

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Parity', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({ connectionProfile: { ...s.connectionProfile, [CONN]: {} } }));
        seen = [];
        onRunWithMatches = (_name, matches) => { seen.push(matches[0] ?? ''); };
    });

    afterEach(() => {
        onRunWithMatches = () => {};
        vi.restoreAllMocks();
        setAmbiguousWidthWide(false);
        useAppStore.setState(s => {
            const { [CONN]: _drop, ...rest } = s.connectionTriggers;
            return { connectionTriggers: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    describe('blankLinesBehaviour', () => {
        const server = 'mNa\n\nmNb\n\n\nmNc\n';

        it('"show" stores and triggers on every blank line', async () => {
            await boot();
            expect(api().setConfig('blankLinesBehaviour', 'show')).toBe(true);
            expect(feed(server)).toEqual(['mNa', '', 'mNb', '', '', 'mNc']);
            expect(seen).toEqual(['mNa', '', 'mNb', '', '', 'mNc']);
        });

        it('"hide" neither stores a blank line nor lets a trigger see it', async () => {
            await boot();
            expect(api().setConfig('blankLinesBehaviour', 'hide')).toBe(true);
            expect(feed(server)).toEqual(['mNa', 'mNb', 'mNc']);
            expect(seen).toEqual(['mNa', 'mNb', 'mNc']);
        });

        it('"replacewithspace" stores, triggers on and draws a single space', async () => {
            await boot();
            expect(api().setConfig('blankLinesBehaviour', 'replacewithspace')).toBe(true);
            const rendered: string[] = [];
            session.events.on('message', (m) => { if (m !== undefined) rendered.push(typeof m === 'string' ? m : m.text); });
            expect(feed(server)).toEqual(['mNa', ' ', 'mNb', ' ', ' ', 'mNc']);
            expect(seen).toEqual(['mNa', ' ', 'mNb', ' ', ' ', 'mNc']);
            expect(rendered).toEqual(['mNa', ' ', 'mNb', ' ', ' ', 'mNc']);
        });
    });

    describe('ambiguousEAsianWidthCharacters', () => {
        // The issue's line: 15 ±, a space and 10 °, all East Asian Ambiguous.
        const line = '±'.repeat(15) + ' ' + '°'.repeat(10);

        it('"wide" counts ambiguous characters as two columns when wrapping', async () => {
            await boot();
            expect(api().setWindowWrap('main', 20)).toBe(true);
            expect(api().setConfig('ambiguousEAsianWidthCharacters', 'wide')).toBe(true);
            expect(api().getConfig('ambiguousEAsianWidthCharacters')).toBe('wide');
            expect(isAmbiguousWidthWide()).toBe(true);
            // Desktop: [±±±±±±±±±±][±±±±± °°°°][°°°°°°]
            expect(feed(`${line}\n`)).toEqual(['±'.repeat(10), '±'.repeat(5) + ' ' + '°'.repeat(4), '°'.repeat(6)]);
        });

        it('"narrow" and "auto" (on a non-CJK encoding) count them as one', async () => {
            await boot();
            expect(api().setWindowWrap('main', 20)).toBe(true);
            for (const mode of ['narrow', 'auto']) {
                expect(api().setConfig('ambiguousEAsianWidthCharacters', mode)).toBe(true);
                expect(api().getConfig('ambiguousEAsianWidthCharacters')).toBe(mode);
                expect(isAmbiguousWidthWide()).toBe(false);
                expect(feed(`${line}\n`)).toHaveLength(2);
            }
        });

        it('"auto" is wide on a CJK server encoding, as Host::setWideAmbiguousEAsianGlyphs decides', async () => {
            await boot();
            expect(session.setServerEncoding('BIG5')).toBe(true);
            expect(api().setConfig('ambiguousEAsianWidthCharacters', 'auto')).toBe(true);
            expect(isAmbiguousWidthWide()).toBe(true);
            expect(api().getConfig('ambiguousEAsianWidthCharacters')).toBe('auto');
        });

        it('shares its state with the Settings toggle', async () => {
            await boot();
            expect(api().getConfig('ambiguousEAsianWidthCharacters')).toBe('auto');
            useAppStore.getState().patchConnectionProfile(CONN, { ambiguousWidthWide: true });
            expect(api().getConfig('ambiguousEAsianWidthCharacters')).toBe('wide');
            expect(api().setConfig('ambiguousEAsianWidthCharacters', 'narrow')).toBe(true);
            expect(useAppStore.getState().connectionProfile[CONN]?.ambiguousWidthWide).toBe(false);
        });
    });

    describe('sysSettingChanged', () => {
        it('is raised, as (key, boolean), for desktop\'s settings only', async () => {
            await boot();
            for (const key of [
                'compactInputLine', 'enableClosedCaption', 'advertiseScreenReader',
                'mapperPanelVisible', 'announceIncomingText', 'muteMediaAPI', 'muteMediaGame',
            ]) {
                raised.length = 0;
                const target = !api().getConfig(key);
                expect(api().setConfig(key, target)).toBe(true);
                expect(settingEvents()).toEqual([[key, target]]);
                // the value it already holds raises nothing
                expect(api().setConfig(key, target)).toBe(true);
                expect(settingEvents()).toHaveLength(1);
            }
        });

        it('stays silent for every other setting', async () => {
            await boot();
            raised.length = 0;
            api().setConfig('enableGMCP', !api().getConfig('enableGMCP'));
            api().setConfig('autoClearInputLine', !api().getConfig('autoClearInputLine'));
            api().setConfig('commandLineHistorySaveSize', 42);
            api().setConfig('blankLinesBehaviour', 'hide');
            api().setConfig('caretShortcut', 'f6');
            api().setConfig('showSentText', 'always');
            api().setConfig('undoServerWrap', true);
            api().setConfig('logInHTML', true);
            api().setConfig('editorAutoComplete', false);
            useAppStore.getState().patchConnectionProfile(CONN, { commandSeparator: '|' });
            expect(settingEvents()).toEqual([]);
        });
    });
});
