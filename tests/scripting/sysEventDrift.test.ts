// @vitest-environment node
//
// System events checked against desktop Mudlet PTB side by side
// (Mudlet/mudlet-web#260), at the engine level: what Lua's installModule
// raises, when closeMudlet raises sysExitEvent, and the main console's
// sysFontChangeEvent; and from #354, resetProfile's answer and stopwatches,
// and the protocol events' argument. The Lua-side halves are
// sysEventDriftLua.test.ts and sysEventDrift354.test.ts.
//
// Mocked Lua runtime and node env, following packageModuleNameCollision.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
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
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;
const { Window } = await import('happy-dom');
g.DOMParser = new Window().DOMParser;

const CONN = 'sys-event-drift-conn';
const PROFILE = '/profiles/test';
const MOD_ARCHIVE = `${PROFILE}/vmod.mpackage`;

const moduleArchive = () => zipSync({
    'vmod.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <ScriptPackage>
    <Script isActive="yes" isFolder="no">
      <name>vmodScript</name>
      <packageName></packageName>
      <script>x = 1</script>
      <eventHandlerList />
    </Script>
  </ScriptPackage>
</MudletPackage>`),
    'config.lua': strToU8('mpackage = [[vmod]]\n'),
});

function stubVfs() {
    const files = new Map<string, string | Uint8Array>();
    const dirs = new Set<string>();
    const under = (p: string, q: string) => q === p || q.startsWith(`${p}/`);
    return {
        profilePath: PROFILE,
        exists: (p: string) => dirs.has(p) || files.has(p),
        mkdir: (p: string) => { dirs.add(p.replace(/\/$/, '')); },
        rmdir: (p: string) => {
            for (const d of [...dirs]) if (under(p, d)) dirs.delete(d);
            for (const f of [...files.keys()]) if (under(p, f)) files.delete(f);
        },
        rename: (from: string, to: string) => {
            for (const d of [...dirs]) if (under(from, d)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
            for (const f of [...files.keys()]) if (under(from, f)) { files.set(to + f.slice(from.length), files.get(f)!); files.delete(f); }
        },
        writeFile: (p: string, data: string) => { files.set(p, data); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, data); },
        readFile: (p: string) => String(files.get(p) ?? ''),
        readBinaryFile: (p: string) => files.get(p) as Uint8Array,
        flush: async () => {},
    } as unknown as ProfileVFS;
}

describe('system events match desktop (#260)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let raised: [string, unknown[]][];

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(st => ({ connectionPackages: { ...st.connectionPackages, [CONN]: [] } }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        raised = [];
        const raise = engine.raiseEvent.bind(engine);
        vi.spyOn(engine, 'raiseEvent').mockImplementation((event, args = []) => {
            raised.push([event, args]);
            raise(event, args);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const names = () => raised.map(([e]) => e);

    it('installModule raises sysInstall and sysLuaInstallModule only', () => {
        const vfs = stubVfs();
        (engine as unknown as { vfs: ProfileVFS }).vfs = vfs;
        vfs.writeBinaryFile(MOD_ARCHIVE, moduleArchive());

        expect(engine.installModuleFromPath(MOD_ARCHIVE)).toEqual({ ok: true, error: null });

        const installs = raised.filter(([e]) => /Install/.test(e));
        expect(installs).toEqual([
            ['sysInstall', ['vmod']],
            ['sysLuaInstallModule', ['vmod', MOD_ARCHIVE]],
        ]);
    });

    it('closeMudlet raises sysExitEvent while still connected, and only once', () => {
        const order: string[] = [];
        vi.spyOn(session, 'disconnect').mockImplementation(() => { order.push('disconnect'); });
        const closed = vi.fn(() => order.push('close'));
        engine.setCloseProfileCallback(closed);
        raised.length = 0;
        vi.mocked(engine.raiseEvent).mockImplementation((event) => { order.push(event); });

        vi.useFakeTimers();
        try {
            const api = (engine as unknown as { api: { closeMudlet(): void } }).api;
            api.closeMudlet();
            // Armed, not run: desktop's closeMudlet returns before anything
            // closes, so the rest of the calling script still runs (#354).
            expect(order).toEqual([]);
            api.closeMudlet();
            vi.runAllTimers();
        } finally {
            vi.useRealTimers();
        }
        expect(order).toEqual(['sysExitEvent', 'disconnect', 'close']);

        engine.destroy();
        expect(order.filter(e => e === 'sysExitEvent')).toHaveLength(1);
    });

    it('resetProfile answers true once armed, and the reset drops non-persistent stopwatches (#354)', async () => {
        const api = (engine as unknown as { api: { stopwatches: import('../../src/scripting/StopwatchManager').StopwatchManager } }).api;
        api.stopwatches.create('swN', true);
        api.stopwatches.create('swPers', true);
        api.stopwatches.setPersistence('swPers', true);

        expect(engine.resetProfile()).toBe(true);
        // One already in progress is folded into, as Host::resetProfile_phase1 refuses it.
        expect(engine.resetProfile()).toBe(false);

        await vi.waitFor(() => expect(names()).toContain('sysLoadEvent'));
        expect(api.stopwatches.getTime('swN')).toEqual({ refused: "stopwatch with name 'swN' not found" });
        expect(typeof api.stopwatches.getTime('swPers')).toBe('number');
        api.stopwatches.setPersistence('swPers', false);
    });

    it('sysEchoAnomalyDetected and sysCharacterModeDetected carry one empty string (#354)', () => {
        session.events.emit('telnet.echo.anomaly');
        session.events.emit('charmode.detected');
        expect(raised.filter(([e]) => e === 'sysEchoAnomalyDetected' || e === 'sysCharacterModeDetected'))
            .toEqual([['sysEchoAnomalyDetected', ['']], ['sysCharacterModeDetected', ['']]]);
    });

    it('a change to the main console font raises sysFontChangeEvent("main", family, size)', () => {
        useAppStore.getState().patchConnectionProfile(CONN, { fontSize: 17 });
        const family = (engine as unknown as { api: { getFont(): string | null } }).api.getFont();
        const fontEvents = raised.filter(([e]) => e === 'sysFontChangeEvent');
        expect(fontEvents).toEqual([['sysFontChangeEvent', ['main', family, 17]]]);
        // Before the setting report, as TConsole::setFont precedes updateConsolesFont.
        expect(names().indexOf('sysFontChangeEvent'))
            .toBeLessThan(raised.findIndex(([e, a]) => e === 'sysSettingChanged' && a[0] === 'main window font'));

        raised.length = 0;
        useAppStore.getState().patchConnectionProfile(CONN, { fontSize: 17 });
        expect(names()).not.toContain('sysFontChangeEvent');
    });
});
