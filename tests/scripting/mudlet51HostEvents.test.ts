// @vitest-environment node
//
// Host-side behaviour Mudlet 5.0/5.1 added that lives outside any Lua binding:
// setConfig("mapperButton") taking over the client's map button
// (Host::interceptMapperButton → sysMapperButtonAction), the application focus
// event (mudlet::slot_applicationStateChanged → sysApplicationFocusChangeEvent),
// and a module removed from the package manager raising sysUninstallModule
// (Host::uninstallPackage with PackageModuleType::ModuleFromUI).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {}, setGmcpValue: () => {},
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

// A window that remembers its listeners, so the test can blur and focus it.
const windowListeners = new Map<string, Set<() => void>>();
let pageHasFocus = true;
const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = {
    innerWidth: 1024, innerHeight: 768,
    ...noopDom,
    addEventListener(type: string, fn: () => void) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) { windowListeners.get(type)?.delete(fn); },
    matchMedia: () => ({ matches: false, ...noopDom }),
};
g.document = { ...noopDom, hasFocus: () => pageHasFocus };
const fire = (type: string) => { for (const fn of windowListeners.get(type) ?? []) fn(); };

const CONN = 'mudlet51-host-events-conn';

type EngineInternals = {
    raiseEvent: (event: string, args: unknown[]) => void;
    api: { setConfig: (key: string, value: unknown) => boolean | string };
};

describe('Mudlet 5.x host events', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let raised: string[];

    beforeEach(() => {
        vi.useFakeTimers();
        windowListeners.clear();
        pageHasFocus = true;
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Five', url: 'ws://localhost' }],
            }));
        }
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        raised = [];
        vi.spyOn(engine as unknown as EngineInternals, 'raiseEvent')
            .mockImplementation((event: string, args: unknown[] = []) => { raised.push(`${event}:${args.join(',')}`); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const setConfig = (key: string, value: unknown) =>
        (engine as unknown as EngineInternals).api.setConfig(key, value);

    describe('mapperButton', () => {
        it('leaves the map button to the client by default', () => {
            expect(engine.mapperButtonMode()).toBe('default');
            expect(engine.interceptMapperButton()).toBe(false);
            expect(raised).toEqual([]);
        });

        it('turns a press into sysMapperButtonAction when "scripted"', () => {
            expect(setConfig('mapperButton', 'scripted')).toBe(true);
            expect(engine.interceptMapperButton()).toBe(true);
            expect(raised).toEqual(['sysMapperButtonAction:']);
        });

        it('swallows a press without an event when "disabled"', () => {
            setConfig('mapperButton', 'disabled');
            expect(engine.interceptMapperButton()).toBe(true);
            expect(raised).toEqual([]);
        });

        it('tells the toolbar when the mode changes, and stops once unsubscribed', () => {
            const seen: string[] = [];
            const off = engine.onMapperButtonModeChange(() => seen.push(engine.mapperButtonMode()));
            setConfig('mapperButton', 'disabled');
            setConfig('mapperButton', 'default');
            off();
            setConfig('mapperButton', 'scripted');
            expect(seen).toEqual(['disabled', 'default']);
        });

        it('keeps the mode it had when given a value it refuses', () => {
            setConfig('mapperButton', 'scripted');
            expect(setConfig('mapperButton', 'sideways')).not.toBe(true);
            expect(engine.mapperButtonMode()).toBe('scripted');
        });
    });

    describe('sysApplicationFocusChangeEvent', () => {
        const focusEvents = () => raised.filter(e => e.startsWith('sysApplicationFocusChangeEvent'));

        it('is raised with false when the page loses focus and true when it gets it back', () => {
            pageHasFocus = false;
            fire('blur');
            vi.runOnlyPendingTimers();
            pageHasFocus = true;
            fire('focus');
            vi.runOnlyPendingTimers();
            expect(focusEvents()).toEqual(['sysApplicationFocusChangeEvent:false', 'sysApplicationFocusChangeEvent:true']);
        });

        it('is raised only on a change', () => {
            fire('focus');
            vi.runOnlyPendingTimers();
            pageHasFocus = false;
            fire('blur');
            fire('blur');
            vi.runOnlyPendingTimers();
            expect(focusEvents()).toEqual(['sysApplicationFocusChangeEvent:false']);
        });

        it('is not raised when focus only moves into a frame inside the page', () => {
            // The window blurs, but the document still holds focus.
            fire('blur');
            vi.runOnlyPendingTimers();
            expect(focusEvents()).toEqual([]);
        });

        it('stops listening once the engine is destroyed', () => {
            engine.destroy();
            expect(windowListeners.get('focus')?.size ?? 0).toBe(0);
            expect(windowListeners.get('blur')?.size ?? 0).toBe(0);
        });
    });

    describe('uninstall events', () => {
        it('raises sysUninstallPackage for a package', () => {
            engine.notifyPackageUninstalled('Pkg');
            expect(raised).toEqual(['sysUninstall:Pkg', 'sysUninstallPackage:Pkg']);
        });

        it('raises sysUninstallModule for a module removed from the package manager', () => {
            engine.notifyPackageUninstalled('Mod', 'module');
            expect(raised).toEqual(['sysUninstall:Mod', 'sysUninstallModule:Mod']);
        });
    });
});
