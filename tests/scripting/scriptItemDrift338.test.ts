// @vitest-environment node
//
// mudlet-web#338: script items against desktop, driven through the whole
// profile open (ScriptingEngine's start(), with the real Lua runtime).
//
// 1. permScript/setScript/appendScript run the new body once, not twice.
// 2. ScriptUnit::compileAll asks each root whether it is active when it gets
//    to it, so a body that runs earlier can switch a later script on or off,
//    replace its code (which then does not run again) — and event dispatch
//    follows those switches at once.
// 3. A script whose body failed (syntax or runtime) is inactive (mOK_code),
//    and so is everything under it, until a compile succeeds.
// 4. The handler named by a script is `return <name>`, called whatever it is.
// 5. Perm timers report active while script bodies run at load, and stay so
//    after one of those bodies disables some other timer.
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

const noopDom = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', hidden: false };
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'script-item-drift-338';

type Internals = {
    runtimeReady: Promise<{ lua: { doStringSync: (code: string) => unknown } }>;
    applyScriptsFromStore: () => void;
    applyTimersFromStore: () => void;
    api: { printError: (msg: string) => void };
};

const script = (id: string, name: string, code: string, opts: {
    enabled?: boolean; parentId?: string | null; isGroup?: boolean; events?: string[];
} = {}) => ({
    id, name, code, parentId: opts.parentId ?? null, isGroup: opts.isGroup ?? false,
    enabled: opts.enabled ?? true, language: 'lua', eventHandlers: opts.events ?? [],
});

describe('script items match desktop (mudlet-web#338)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let errors: string[];
    const internals = () => engine as unknown as Internals;
    const lua = async (code: string) => (await internals().runtimeReady).lua.doStringSync(code);

    /** Open the profile the way the app does: the whole of ScriptingEngine's
     *  start(), store subscription and sysLoadEvent included. The first root
     *  script defines the L() logger every other body writes to. */
    const boot = async (scripts: ReturnType<typeof script>[], timers: unknown[] = []) => {
        useAppStore.setState(s => ({
            connectionScripts: {
                ...s.connectionScripts,
                [CONN]: [script('setup', 'setup', 'LOG = {}; function L(s) LOG[#LOG + 1] = s end'), ...scripts] as never,
            },
            connectionTimers: { ...s.connectionTimers, [CONN]: timers as never },
        }));
        const session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        await internals().runtimeReady;
        vi.spyOn(internals().api, 'printError').mockImplementation((msg: string) => { errors.push(msg); });
        session.markOutputReady();
        await engine.whenScriptsLoaded();
    };
    const log = async () => String(await lua('return table.concat(LOG, "|")')).split('|').filter(Boolean);

    beforeEach(() => {
        errors = [];
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
            const { [CONN]: _t, ...timers } = s.connectionTimers;
            return { connectionScripts: scripts, connectionTimers: timers };
        });
        try { engine.destroy(); } catch { /* best-effort */ }
    });

    describe('1. permScript, setScript and appendScript run the body once', () => {
        const BODY = `[[PSruns = (PSruns or 0) + 1
            registerAnonymousEventHandler("evP", function() L("PS anon handler") end)]]`;

        it('permScript', async () => {
            await boot([]);
            await lua(`permScript("PS", "", ${BODY}); raiseEvent("evP")`);
            expect(await lua('return PSruns')).toBe(1);
            expect(await log()).toEqual(['PS anon handler']);
        });

        it('setScript, also when the code is unchanged', async () => {
            await boot([script('ps', 'PS', '')]);
            await lua(`setScript("PS", ${BODY}); raiseEvent("evP")`);
            expect(await lua('return PSruns')).toBe(1);
            expect(await log()).toEqual(['PS anon handler']);
            await lua(`setScript("PS", (getScript("PS")))`);
            expect(await lua('return PSruns')).toBe(2);
        });

        it('appendScript', async () => {
            await boot([script('ps', 'PS', 'local x = 1')]);
            await lua(`appendScript("PS", ${BODY})`);
            expect(await lua('return PSruns')).toBe(1);
        });

        it('a permScript body called during profile load', async () => {
            await boot([script('maker', 'maker', `permScript("PS", "", ${BODY})`)]);
            expect(await lua('return PSruns')).toBe(1);
        });

        it('a setScript body that raises runs once and is rolled back', async () => {
            await boot([script('ps', 'PS', 'local x = 1')]);
            await lua(`ok, err = pcall(setScript, "PS", [[SSruns = (SSruns or 0) + 1; error("set" .. " boom")]])`);
            expect(await lua('return SSruns')).toBe(1);
            expect(await lua('return ok')).toBe(false);
            expect(await lua('return err')).toContain('set boom');
            expect(await lua('return (getScript("PS"))')).toBe('local x = 1');
        });

        it('a permScript body that raises creates nothing and says why', async () => {
            await boot([]);
            await lua(`ok1, e1 = pcall(permScript, "X1", "", [[X1runs = (X1runs or 0) + 1; error({})]])
                       ok2, e2 = pcall(permScript, "X2", "", [[error("w2a " .. "boom")]])`);
            expect(await lua('return X1runs')).toBe(1);
            expect(await lua('return e1')).toContain('(the body raised when it was run: error object is a table value)');
            expect(await lua('return e2')).toContain('w2a boom');
            expect(await lua('return exists("X1", "script") + exists("X2", "script")')).toBe(0);
        });
    });

    describe('2. script-tree changes made by a body during profile load', () => {
        const tree = () => [
            script('first', 'first', `disableScript("R1"); enableScript("R2"); setScript("R3", "L('R3 v2 body')")`),
            script('r1', 'R1', `L('R1 top'); function R1(e, a) L('R1 h '..e..' '..tostring(a)) end`,
                { events: ['evS', 'sysLoadEvent'] }),
            script('r2', 'R2', `L('R2 top'); function R2(e, a) L('R2 h '..e..' '..tostring(a)) end`,
                { enabled: false, events: ['evS', 'sysLoadEvent'] }),
            script('r3', 'R3', `L('R3 v1 body')`),
            script('last', 'last', `L('last'); raiseEvent('evS', 'load')`),
        ];

        it('are honoured by the rest of the load', async () => {
            await boot(tree());
            expect(await log()).toEqual([
                'R3 v2 body', 'R2 top', 'last', 'R2 h evS load', 'R2 h sysLoadEvent true',
            ]);
            expect(await lua(`return isActive("R1", "script") .. isActive("R2", "script")`)).toBe('01');
        });

        it('and by event dispatch for the rest of the session', async () => {
            await boot(tree());
            await lua(`LOG = {}; raiseEvent('evS', 'go')`);
            expect(await log()).toEqual(['R2 h evS go']);
        });

        it('a script a body removes is not compiled', async () => {
            await boot([
                script('first', 'first', `__mudlet_removeScriptById((select(2, getScript("Gone"))))`),
                script('gone', 'Gone', `L('Gone ran')`),
                script('kept', 'Kept', `L('Kept ran')`),
            ]);
            expect(await log()).toEqual(['Kept ran']);
        });
    });

    describe('3. a script whose body failed is inactive', () => {
        const tree = () => [
            script('syn', 'Syn', `function Syn() L('Syn h') end x = = 1`, { events: ['evF'] }),
            script('rt', 'Rt', `function Rt() L('Rt h') end error('boom')`, { events: ['evF'] }),
            script('gbad', 'Gbad', `error('gboom')`, { isGroup: true }),
            script('kid', 'Kid', `function Kid() L('Kid h') end`, { parentId: 'gbad', events: ['evF'] }),
            script('ok', 'Ok', `function Ok() L('Ok h') end`, { events: ['evF'] }),
        ];

        it('reports inactive, and enabling it does not change that', async () => {
            await boot(tree());
            expect(await lua(`return isActive("Syn", "script") .. isActive("Rt", "script")
                .. isActive("Gbad", "script")`)).toBe('000');
            await lua('enableScript("Rt")');
            expect(await lua('return isActive("Rt", "script")')).toBe(0);
        });

        it('neither it nor anything under it handles events', async () => {
            await boot(tree());
            await lua(`raiseEvent("evF")`);
            expect(await log()).toEqual(['Ok h']);
            expect(await lua(`return isAncestorsActive((select(2, getScript("Kid"))), "script")`)).toBe(false);
            expect(await lua('return isActive("Kid", "script", true)')).toBe(0);
            expect(await lua('return isActive("Kid", "script")')).toBe(1);
        });

        it('comes back once setScript gives it a body that runs', async () => {
            await boot(tree());
            await lua(`setScript("Rt", "function Rt() L('Rt fixed h') end")
                       setScript("Gbad", "")`);
            expect(await lua(`return isActive("Rt", "script") .. isActive("Gbad", "script")
                .. isActive("Kid", "script", true)`)).toBe('111');
            await lua(`raiseEvent("evF")`);
            expect(await log()).toEqual(['Rt fixed h', 'Kid h', 'Ok h']);
        });
    });

    it('4. the handler is whatever `return <script name>` evaluates to', async () => {
        await boot([
            script('ct', 'CallT', `CallT = setmetatable({}, {__call = function(_, e) L('CallT '..e) end})`,
                { events: ['ev4'] }),
            script('h1', 'H[1]', `H = { function(e) L('H[1] '..e) end }`, { events: ['ev4'] }),
            script('tf', 'tbl.fn', `tbl = { fn = function(e) L('tbl.fn '..e) end }`, { events: ['ev4'] }),
            script('sp', 'Sp ace', `_G['Sp ace'] = function(e) L('Sp ace '..e) end`, { events: ['ev4'] }),
        ]);
        await lua(`raiseEvent('ev4')`);
        expect(await log()).toEqual(['CallT ev4', 'H[1] ev4', 'tbl.fn ev4']);
        expect(errors).toEqual([]);
    });

    describe('5. perm timers report active while scripts load', () => {
        const timer = (id: string, name: string, seconds: number) => ({
            id, name, isGroup: false, parentId: null, enabled: true, seconds, code: '', language: 'lua', repeat: true,
        });
        const TIMERS = [timer('tl', 'ptL', 1), timer('ta', 'ptA', 3600), timer('other', 'other', 100)];

        it('as the bodies run', async () => {
            await boot([script('a', 'A', `L(isActive('ptL', 'timer') .. isActive('ptA', 'timer'))`)], TIMERS);
            expect(await log()).toEqual(['11']);
        });

        it('after a body disables another timer', async () => {
            await boot([script('a', 'A', `disableTimer('other'); L(isActive('ptL', 'timer') .. isActive('ptA', 'timer'))`)],
                TIMERS);
            expect(await log()).toEqual(['11']);
            expect(await lua(`return isActive('ptL', 'timer') .. isActive('ptA', 'timer') .. isActive('other', 'timer')`))
                .toBe('110');
        });
    });
});
