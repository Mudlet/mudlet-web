// @vitest-environment node
//
// Issue #282 item 3, and the registration half of item 1: when desktop runs a
// script's body, and how its event-handler list is registered.
//
// - ScriptUnit::enableScript only flips the active flag. A script that was
//   disabled at load was never compiled, so enabling it must not run its body
//   (Mudlet Web used to treat every disabled→enabled transition as a load).
// - ScriptUnit::compileAll, at profile load, compiles every script under an
//   active root, whatever the script's own switch says.
// - A script whose code changes is compiled (TScript::setScript), active or not.
// - Every script's handler list is registered, enabled or not, in tree order
//   with modules after the profile; whether it runs is a dispatch-time check.
//
// The Lua runtime is a recorder: what matters is what the engine asks it to do.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const loads: string[] = [];
const syncs: Array<Array<{ id: string; name: string; active: boolean; events: string[] }>> = [];

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: (_code: string, name: string) => { loads.push(name); },
            syncScriptHandlers: (entries: typeof syncs[number]) => { syncs.push(entries.map(e => ({ ...e }))); },
            emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            dispatchSendRequest: () => false, reapKilledTempItems: () => {},
            setCommand: () => {}, tempItemExists: () => false,
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

const CONN = 'script-compile-on-enable-conn';

const script = (id: string, name: string, opts: {
    enabled?: boolean; parentId?: string | null; isGroup?: boolean; events?: string[];
    code?: string; packageName?: string;
} = {}) => ({
    id, name, parentId: opts.parentId ?? null, isGroup: opts.isGroup ?? false,
    enabled: opts.enabled ?? true, code: opts.code ?? `-- ${name}`, language: 'lua',
    eventHandlers: opts.events ?? [], ...(opts.packageName ? { packageName: opts.packageName } : {}),
});

type Internals = { applyScriptsFromStore: () => void };

describe('script bodies run where desktop compiles them', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    const apply = () => (engine as unknown as Internals).applyScriptsFromStore();
    const setScripts = (list: ReturnType<typeof script>[]) =>
        useAppStore.setState(s => ({ connectionScripts: { ...s.connectionScripts, [CONN]: list as never } }));
    const lastEntryFor = (id: string) => {
        for (let i = syncs.length - 1; i >= 0; i--) {
            const hit = syncs[i].find(e => e.id === id);
            if (hit) return hit;
        }
        return undefined;
    };

    beforeEach(async () => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Compile', url: 'ws://localhost' }],
            }));
        }
        setScripts([
            script('late', 'Late', { enabled: false, events: ['evLate'] }),
            script('on', 'On', { events: ['evOn'] }),
            script('grp', 'Group', { isGroup: true, code: '' }),
            script('kid', 'Kid', { enabled: false, parentId: 'grp', events: ['evKid'] }),
            script('off', 'OffGroup', { isGroup: true, enabled: false, code: '' }),
            script('inner', 'Inner', { parentId: 'off' }),
        ]);
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        await new Promise(r => setTimeout(r, 0));
        loads.length = 0;
        syncs.length = 0;
    });

    afterEach(() => {
        useAppStore.setState(s => {
            const { [CONN]: _d, ...rest } = s.connectionScripts;
            return { connectionScripts: rest };
        });
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('compiles everything under an active root at profile load, and nothing else', () => {
        apply();
        // Kid is switched off but sits under an active root: compileAll still
        // compiles it. Late (an inactive root) and Inner (under one) are not.
        expect(loads).toEqual(['On', 'Kid']);
    });

    it('registers every handler list, inactive ones included, in tree order', () => {
        apply();
        expect(syncs).toHaveLength(1);
        expect(syncs[0]).toEqual([
            { id: 'late', name: 'Late', active: false, events: ['evLate'] },
            { id: 'on', name: 'On', active: true, events: ['evOn'] },
            { id: 'kid', name: 'Kid', active: false, events: ['evKid'] },
        ]);
    });

    it('enableScript only flips the flag — the body of a never-compiled script does not run', () => {
        apply();
        loads.length = 0;
        syncs.length = 0;
        expect(engine.toggleScriptByName('Late', true)).toBe(true);
        apply();
        expect(loads).toEqual([]);
        expect(syncs).toEqual([[{ id: 'late', name: 'Late', active: true, events: ['evLate'] }]]);
    });

    it('does not re-run a compiled script that is switched off and on again', () => {
        apply();
        engine.toggleScriptByName('On', false);
        apply();
        engine.toggleScriptByName('On', true);
        apply();
        expect(loads).toEqual(['On', 'Kid']);
        expect(lastEntryFor('on')).toEqual({ id: 'on', name: 'On', active: true, events: ['evOn'] });
    });

    it('a group switch reaches its children\'s active flags', () => {
        setScripts([
            script('grp', 'Group', { isGroup: true, code: '' }),
            script('child', 'Child', { parentId: 'grp', events: ['evC'] }),
        ]);
        apply();
        engine.toggleScriptByName('Group', false);
        apply();
        expect(lastEntryFor('child')?.active).toBe(false);
    });

    it('compiles a changed script whether or not it is active', () => {
        apply();
        loads.length = 0;
        const list = useAppStore.getState().connectionScripts[CONN] ?? [];
        useAppStore.getState().updateScript(CONN, list.find(s => s.name === 'Late')!.id, { code: 'x = 1' });
        apply();
        expect(loads).toEqual(['Late']);
    });

    it('does not run a body for a handler-list change alone', () => {
        apply();
        loads.length = 0;
        syncs.length = 0;
        useAppStore.getState().updateScript(CONN, 'on', { eventHandlers: ['evOn', 'evMore'] });
        apply();
        expect(loads).toEqual([]);
        expect(syncs).toEqual([[{ id: 'on', name: 'On', active: true, events: ['evOn', 'evMore'] }]]);
    });

    it('drops the registration of a deleted script', () => {
        apply();
        syncs.length = 0;
        setScripts((useAppStore.getState().connectionScripts[CONN] ?? []).filter(s => s.id !== 'on') as never);
        apply();
        expect(syncs).toEqual([[{ id: 'on', name: '', active: false, events: [] }]]);
    });

    it('registers module scripts after the profile\'s, though negative-priority bodies run first', () => {
        useAppStore.setState(s => ({
            connectionPackages: { ...s.connectionPackages, [CONN]: [
                { name: 'Mod', kind: 'module', priority: -1 },
            ] as never },
        }));
        try {
            setScripts([
                script('m', 'ModScript', { packageName: 'Mod', events: ['ev'] }),
                script('p', 'ProfileScript', { events: ['ev'] }),
            ]);
            apply();
            expect(syncs[0].map(e => e.name)).toEqual(['ProfileScript', 'ModScript']);
            expect(loads).toEqual(['ModScript', 'ProfileScript']);
        } finally {
            useAppStore.setState(s => {
                const { [CONN]: _d, ...rest } = s.connectionPackages;
                return { connectionPackages: rest };
            });
        }
    });
});
