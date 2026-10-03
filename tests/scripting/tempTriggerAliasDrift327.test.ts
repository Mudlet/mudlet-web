// @vitest-environment node
//
// Temp trigger/alias drift measured against the Mudlet PTB (mudlet-web#327).
// Each case is a row of the issue, with desktop's result as the expectation.
//
//  1. tempLineTrigger(from, n) armed outside a line pass (alias, timer, event
//     handler) skips `from` lines before firing. Mudlet Web treated 0 and 1
//     alike and fired one line early.
//  2. A match-all tempComplexRegexTrigger highlight paints every occurrence,
//     and only the groups when there are any.
//  3. Its colour names are Qt's (SVG keywords), not color_table's.
//  4. One that is killed — by its own script, a sibling's, or its expireAfter
//     running out — stops on the next line, not after the rest of the packet.
//  5. Temp and permanent aliases run interleaved in creation order.
//
// Node env + a stubbed LuaRuntime (as triggerLineEditing273.test.ts does it):
// the "scripts" are closures over the real engine, keyed by item name. The
// tempComplexRegexTrigger rows go through the real Lua binding's colour
// resolution by calling it with a fake `lua.global`.
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
const { installAutomationBindings } = await import('../../src/scripting/lua/bindings/automation');
type ScriptingAPI = import('../../src/scripting/ScriptingAPI').ScriptingAPI;
type TempComplexTriggerSpec = import('../../src/scripting/EngineHost').TempComplexTriggerSpec;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'temp-drift-327-conn';

type EngineInternals = {
    triggersReady: boolean;
    applyTriggersFromStore: () => void;
    applyAliasesFromStore: () => void;
    scheduleTriggerApply: () => void;
    api: ScriptingAPI;
};

function alias<T extends Record<string, unknown>>(over: T) {
    return {
        isGroup: false, parentId: null, enabled: true, code: 'x', language: 'lua', command: '',
        ...over,
    };
}

describe('mudlet-web#327 — temp trigger/alias parity with desktop', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let internals: EngineInternals;
    let api: ScriptingAPI;
    let aliases: InstanceType<typeof AliasEngine>;
    let triggers: InstanceType<typeof TriggerEngine>;
    let scripts: Record<string, (matches: (string | undefined)[]) => void>;
    let out: string[];
    let unsubscribe: () => void = () => {};

    const boot = async (savedAliases: Record<string, unknown>[] = []) => {
        useAppStore.setState(s => ({
            connectionTriggers: { ...s.connectionTriggers, [CONN]: [] },
            connectionAliases: { ...s.connectionAliases, [CONN]: savedAliases as never },
        }));
        const session = new MudSession();
        aliases = new AliasEngine();
        triggers = new TriggerEngine();
        engine = new ScriptingEngine(session, aliases, triggers, new TimerEngine(), new KeyEngine(), CONN);
        vi.spyOn(session, 'sendData').mockImplementation(() => {});
        await TriggerEngine.ready();
        internals = engine as unknown as EngineInternals;
        internals.triggersReady = true;
        internals.applyTriggersFromStore();
        internals.applyAliasesFromStore();
        api = internals.api;
        // The store subscription the profile load attaches, reduced to the two
        // slices under test: triggers reload on the coalesced microtask (which
        // a mid-packet removal has to drain itself), aliases synchronously.
        unsubscribe = useAppStore.subscribe((state, prev) => {
            if (state.connectionTriggers[CONN] !== prev.connectionTriggers[CONN]) internals.scheduleTriggerApply();
            if (state.connectionAliases[CONN] !== prev.connectionAliases[CONN]) internals.applyAliasesFromStore();
        });
    };

    const feed = (text: string) =>
        engine.processFlushBatch([{ text, type: 'mud', fromServer: true }]);

    const lines = (): string[] => api.getLines(0, api.getLineCount()) ?? [];

    /** The characters of line `y` whose colour (fg or bg) is `rgb`, gaps as '.'. */
    const paintedIn = (y: number, rgb: number[], which: 'fg' | 'bg' = 'fg'): string => {
        const text = lines()[y];
        let s = '';
        for (let x = 0; x < text.length; x++) {
            api.moveCursor(undefined, x, y);
            api.selectSection(x, 1);
            const c = (which === 'fg' ? api.getFgColor() : api.getBgColor()) ?? [];
            s += c.slice(0, 3).join() === rgb.join() ? text[x] : '.';
        }
        api.deselect();
        return s;
    };

    /** tempComplexRegexTrigger's highlight arguments, through the real Lua
     *  binding: what it hands the engine for these two colour arguments. */
    const viaBinding = (hlFg: unknown, hlBg: unknown, rest: Partial<TempComplexTriggerSpec> & { name: string; regex: string }) => {
        let fn: ((...a: unknown[]) => number) | undefined;
        const lua = { global: { set: (k: string, v: unknown) => { if (k === '__mudlet_tempComplexTrigger') fn = v as never; } } };
        installAutomationBindings({ lua, api } as never);
        return fn!(rest.name, `regex\x02${rest.regex}`, rest.code ?? '', false, false,
            rest.multipleMatches ?? false, 0, 0, hlFg, hlBg);
    };

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
            }));
        }
        scripts = {};
        out = [];
        onRunWithMatches = (name, matches) => scripts[name]?.(matches);
    });

    afterEach(() => {
        unsubscribe();
        onRunWithMatches = () => {};
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _t, ...restT } = s.connectionTriggers;
            const { [CONN]: _a, ...restA } = s.connectionAliases;
            return { connectionTriggers: restT, connectionAliases: restA };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    describe('1. tempLineTrigger armed outside a line pass', () => {
        it('from an alias, (1, 2) captures the second and third lines', async () => {
            await boot();
            aliases.addTemp('^grab$', () => {
                triggers.addTempLine(1, 2, m => out.push(`got ${m[0]}`));
            });
            engine.processInput('grab');
            feed('A1\nA2\nA3\nA4\n');
            expect(out).toEqual(['got A2', 'got A3']);
        });

        it('(1, 3) armed before a prompt counts the prompt as the skipped line', async () => {
            await boot();
            triggers.addTempLine(1, 3, m => out.push(m[0] ?? ''));
            engine.processFlushBatch([{ text: 'hp>', type: 'prompt', fromServer: true }]);
            feed('P2\nP3\nP4\nP5\n');
            expect(out).toEqual(['P2', 'P3', 'P4']);
        });

        it('inside a trigger, (1, 1) still fires on the next line', async () => {
            await boot();
            triggers.addTemp('^arm$', () => {
                triggers.addTempLine(1, 1, m => out.push(m[0] ?? ''));
            });
            feed('arm\nT1\nT2\n');
            expect(out).toEqual(['T1']);
        });
    });

    describe('2/3. tempComplexRegexTrigger highlight', () => {
        it('paints every match-all occurrence, and only the group when there is one', async () => {
            await boot();
            viaBinding('red', 'blue', { name: 'h1', regex: 'o', multipleMatches: true });
            viaBinding('green', 'black', { name: 'h2', regex: '(\\d)x', multipleMatches: true });
            viaBinding('cyan', 'black', { name: 'h4', regex: 'wo+', multipleMatches: true });
            viaBinding(0, 'white', { name: 'h5', regex: 'mm', multipleMatches: true });
            feed('foo boo zoo\nab 1x 2x 3x\nwo woo wooo\nmm a mm\n');

            expect(paintedIn(0, [255, 0, 0])).toBe('.oo..oo..oo');
            expect(paintedIn(1, [0, 128, 0])).toBe('...1..2..3.');
            expect(paintedIn(2, [0, 255, 255])).toBe('wo.woo.wooo');
            expect(paintedIn(3, [255, 255, 255], 'bg')).toBe('mm...mm');
        });

        it.each([
            ['green', [0, 128, 0]],
            ['gray', [128, 128, 128]],
            ['grey', [128, 128, 128]],
            ['purple', [128, 0, 128]],
            ['maroon', [128, 0, 0]],
            ['olive', [128, 128, 0]],
            ['lime', [0, 255, 0]],
            ['teal', [0, 128, 128]],
            ['black', [0, 0, 0]],
            ['#ff8000', [255, 128, 0]],
        ])('resolves %s as QColor does', async (name, rgb) => {
            await boot();
            viaBinding(name, 0, { name: 'col', regex: 'paint' });
            feed('xx paint xx\n');
            expect(paintedIn(0, rgb as number[])).toContain('paint');
        });
    });

    describe('4. a removed tempComplexRegexTrigger stops on the next line of the packet', () => {
        it('whether a sibling kills it, it kills itself, or its expiry runs out', async () => {
            await boot();
            const make = (name: string) => engine.createTempComplexTrigger({
                name, patterns: [{ type: 'regex', text: '^kq' }], code: 'x',
                multiline: false, isFilter: false, multipleMatches: false, fireLength: 0, delta: 0,
            });
            make('sibName');
            make('selfName');
            const exp1 = make('exp1');
            let killerFired = false;
            triggers.addTemp('^kq', () => {
                if (killerFired) return;
                killerFired = true;
                api.killByName('trigger', 'sibName');
            });
            scripts.sibName = m => out.push(`sib ${m[0]}`);
            scripts.selfName = m => out.push(`self ${m[0]} ${api.killByName('trigger', 'selfName')}`);
            // expireAfter = 1, as the Bridge.lua wrapper spends it: kill by id
            // once the body has run.
            scripts.exp1 = m => { out.push(`exp1 ${m[0]}`); api.removeTemporaryTrigger(exp1); };

            feed('kq 1\nkq 2\nkq 3\n');

            expect(out).toEqual(['sib kq', 'self kq true', 'exp1 kq']);
        });
    });

    describe('5. temp and permanent aliases interleave in creation order', () => {
        const permAlias = (id: string, name: string, extra: Record<string, unknown> = {}) =>
            useAppStore.setState(s => ({
                connectionAliases: {
                    ...s.connectionAliases,
                    [CONN]: [...(s.connectionAliases[CONN] ?? []), alias({ id, name, pattern: '^r10ord', ...extra })] as never,
                },
            }));

        it('runs temp1, perm, temp2 in the order they were made', async () => {
            await boot();
            scripts.r10permA = () => out.push('A perm');
            aliases.addTemp('^r10ord', () => out.push('A temp1'));
            permAlias('pa', 'r10permA');
            aliases.addTemp('^r10ord', () => out.push('A temp2'));

            expect(engine.processInput('r10ord')).toBe(true);
            expect(out).toEqual(['A temp1', 'A perm', 'A temp2']);
        });

        it('puts a package alias where it was installed, too', async () => {
            await boot();
            scripts.r10profile = () => out.push('PERM profile');
            scripts.r10pkg = () => out.push('PKG ALIAS');
            aliases.addTemp('^r10ord', () => out.push('TEMP before'));
            permAlias('pp', 'r10profile');
            permAlias('pk', 'r10pkg', { packageName: 'r10package' });
            aliases.addTemp('^r10ord', () => out.push('TEMP after'));

            engine.processInput('r10ord');
            expect(out).toEqual(['TEMP before', 'PERM profile', 'PKG ALIAS', 'TEMP after']);
        });

        it('keeps saved aliases ahead of temps a script makes at load time', async () => {
            await boot();
            useAppStore.setState(s => ({
                connectionAliases: { ...s.connectionAliases, [CONN]: [] },
            }));
            // A fresh engine whose saved aliases are reserved before the
            // profile scripts run, as the load does, and loaded only after.
            const saved = [alias({ id: 'sv', name: 'saved', pattern: '^r10ord' })];
            const fresh = new AliasEngine();
            fresh.reserveOrder(saved);
            fresh.addTemp('^r10ord', () => out.push('load-time temp'));
            fresh.loadPerm(saved as never);
            fresh.process('r10ord', hit => out.push(hit.alias.name));
            expect(out).toEqual(['saved', 'load-time temp']);
        });
    });
});
