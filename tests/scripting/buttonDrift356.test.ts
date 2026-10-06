// @vitest-environment node
//
// mudlet-web#356: buttons against desktop, driven through the whole profile
// open (ScriptingEngine's start(), with the real Lua runtime).
//
// 1. A push-down button's own script reading getButtonState("<its name>")
//    sees the state the click just put it in: desktop's slot_pressed sets
//    mButtonState before TAction::execute runs the button.
// 2. While the profile loads, every active push-down button runs once in its
//    saved state — menus' too — and plain buttons do not
//    (TToolBar/TEasyButtonBar::addActionButtons, mIsProfileLoadingSequence).
// 3. setButtonStyleSheet styles every action with that name, toolbars and
//    menus included (ActionUnit::findItems).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/scripting/lua/LuaRuntime')>();
    return {
        LuaRuntime: {
            // A `document` switches wasmoon to browser-mode loading, and the
            // engine's constructor needs one: hide it while the runtime loads.
            create: async (...args: Parameters<typeof actual.LuaRuntime.create>) => {
                const g = globalThis as Record<string, unknown>;
                const doc = g.document;
                delete g.document;
                try { return await actual.LuaRuntime.create(...args); } finally { g.document = doc; }
            },
        },
    };
});

const { MudSession } = await import('../../src/mud/MudSession');
const { AliasEngine } = await import('../../src/mud/aliases/AliasEngine');
const { TriggerEngine } = await import('../../src/mud/triggers/TriggerEngine');
const { TimerEngine } = await import('../../src/mud/timers/TimerEngine');
const { KeyEngine } = await import('../../src/mud/keybindings/KeyEngine');
const { ScriptingEngine } = await import('../../src/scripting/ScriptingEngine');
const { useAppStore } = await import('../../src/storage/appStore');
import type { ButtonNode } from '../../src/storage/schema';

const noopDom = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', hidden: false };
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'button-drift-356';

type Internals = {
    runtimeReady: Promise<{ lua: { doStringSync: (code: string) => unknown } }>;
};

const node = (p: Partial<ButtonNode> & { id: string; name: string }): ButtonNode => ({
    enabled: true, isGroup: false, parentId: null, code: '', language: 'lua',
    orientation: 'horizontal', location: 'top', columns: 0, isPushDown: false, buttonState: false, ...p,
});

describe('buttons match desktop (mudlet-web#356)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    const lua = async (code: string) =>
        (await (engine as unknown as Internals).runtimeReady).lua.doStringSync(code);
    const buttons = () => useAppStore.getState().connectionButtons[CONN] ?? [];
    const click = (name: string) => {
        const b = buttons().find(x => x.name === name && !x.isGroup)!;
        engine.executeButton(b, b.isPushDown ? !b.buttonState : true);
    };

    /** Open the profile the way the app does. A script defines the L() logger
     *  every button writes to, so it exists before the buttons run at load. */
    const boot = async (list: ButtonNode[]) => {
        useAppStore.setState(s => ({
            connectionScripts: {
                ...s.connectionScripts,
                [CONN]: [{
                    id: 'setup', name: 'setup', code: 'LOG = {}; function L(s) LOG[#LOG + 1] = s end',
                    parentId: null, isGroup: false, enabled: true, language: 'lua', eventHandlers: [],
                }] as never,
            },
            connectionButtons: { ...s.connectionButtons, [CONN]: list },
        }));
        const session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        await (engine as unknown as Internals).runtimeReady;
        session.markOutputReady();
        await engine.whenScriptsLoaded();
    };
    const log = async () => String(await lua('return table.concat(LOG, "|")')).split('|').filter(Boolean);

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
            }));
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
        useAppStore.setState(s => {
            const { [CONN]: _s, ...scripts } = s.connectionScripts;
            const { [CONN]: _b, ...btns } = s.connectionButtons;
            return { connectionScripts: scripts, connectionButtons: btns };
        });
        try { engine.destroy(); } catch { /* best-effort */ }
    });

    it('1. a push-down script sees its own new state by name', async () => {
        await boot([
            node({ id: 'tb', name: 'TB', isGroup: true }),
            node({
                id: 'b2', name: 'B2', parentId: 'tb', isPushDown: true,
                code: `if LOG then L('gbs=' .. getButtonState() .. ' named=' .. tostring(getButtonState('B2'))) end`,
            }),
        ]);
        await lua('LOG = {}');
        click('B2');
        click('B2');
        expect(await log()).toEqual(['gbs=2 named=true', 'gbs=1 named=false']);
        expect(buttons().find(b => b.id === 'b2')!.buttonState).toBe(false);
    });

    it('2. push-down buttons run once at load in their saved state, menus included', async () => {
        await boot([
            node({ id: 'tb', name: 'TB', isGroup: true }),
            node({
                id: 'pb', name: 'PB', parentId: 'tb', isPushDown: true, buttonState: false,
                code: `L('PB ' .. getButtonState() .. ' ' .. tostring(getButtonState('PB')))`,
            }),
            node({
                id: 'pc', name: 'PC', parentId: 'tb', isPushDown: true, buttonState: true,
                code: `L('PC ' .. getButtonState() .. ' ' .. tostring(getButtonState('PC')))`,
            }),
            node({ id: 'plain', name: 'PLAIN', parentId: 'tb', code: `L('PLAIN')` }),
            node({ id: 'menu', name: 'MENU', parentId: 'tb', isGroup: true }),
            node({ id: 'm2', name: 'M2', parentId: 'menu', isPushDown: true, code: `L('M2')` }),
            node({ id: 'off', name: 'OFF', parentId: 'tb', isPushDown: true, enabled: false, code: `L('OFF')` }),
        ]);
        expect(await log()).toEqual(['PB 1 false', 'PC 2 true', 'M2']);
        // The run leaves the saved states as they were.
        expect(buttons().find(b => b.id === 'pb')!.buttonState).toBe(false);
        expect(buttons().find(b => b.id === 'pc')!.buttonState).toBe(true);
    });

    it('3. setButtonStyleSheet styles toolbars, menus and every duplicate', async () => {
        await boot([
            node({ id: 'tb', name: 'TB', isGroup: true }),
            node({ id: 'menu', name: 'MENU', parentId: 'tb', isGroup: true }),
            node({ id: 'd1', name: 'DUP', parentId: 'tb' }),
            node({ id: 'd2', name: 'DUP', parentId: 'tb' }),
        ]);
        expect(await lua(`return setButtonStyleSheet('TB', 'color: red;')`)).toBe(true);
        expect(await lua(`return setButtonStyleSheet('MENU', 'color: blue;')`)).toBe(true);
        expect(await lua(`return setButtonStyleSheet('DUP', 'color: green;')`)).toBe(true);
        expect(await lua(`return select(2, setButtonStyleSheet('NOPE', 'x'))`)).toBe("no button named 'NOPE' found");
        const sheet = (id: string) => buttons().find(b => b.id === id)!.styleSheet;
        expect(sheet('tb')).toBe('color: red;');
        expect(sheet('menu')).toBe('color: blue;');
        expect(sheet('d1')).toBe('color: green;');
        expect(sheet('d2')).toBe('color: green;');
    });
});
