// @vitest-environment node
//
// mudlet-web#238 — runtime item API drift against desktop Mudlet:
//   1. a multi-pattern perm*Trigger created inside a group is an ordinary OR
//      trigger on desktop (startPerm*Trigger only passes `patterns.size() > 1`
//      as the multiline flag at the root), but Mudlet Web made it an AND one
//      that never fired;
//   2. a trigger calling setTriggerStayOpen on ITSELF has the call overwritten
//      on desktop (`mKeepFiring = mStayOpen` after the script), so it does not
//      keep firing — Mudlet Web let it fire on every following line;
//   3. tempButton / tempButtonToolbar refuse a name that is already taken, and
//      return no value for a refusal rather than -1.
//
// Node env + a stubbed LuaRuntime for the ScriptingEngine half, as
// permItemsInModule.test.ts does. The Lua wrappers' return values are covered
// by tempButtonRefusal.test.ts, which needs the real runtime.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
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
import type { TriggerNode } from '../../src/storage/schema';
import type { TriggerMatch } from '../../src/mud/triggers/TriggerEngine';

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};

const CONN = 'runtime-item-drift-conn';

function withEngine(fn: (engine: InstanceType<typeof ScriptingEngine>,
    triggerEngine: InstanceType<typeof TriggerEngine>) => void) {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
    g.document = noopDom;
    useAppStore.setState(s => ({
        connections: s.connections.some(c => c.id === CONN)
            ? s.connections
            : [...s.connections, { id: CONN, name: 'Drift', url: 'ws://localhost' }],
        connectionTriggers: { ...s.connectionTriggers, [CONN]: [] },
        connectionButtons: { ...s.connectionButtons, [CONN]: [] },
    }));
    const triggerEngine = new TriggerEngine();
    const engine = new ScriptingEngine(
        new MudSession(), new AliasEngine(), triggerEngine, new TimerEngine(), new KeyEngine(), CONN,
    );
    try {
        fn(engine, triggerEngine);
    } finally {
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        useAppStore.setState(s => {
            const drop = <T,>(m: Record<string, T>) => { const { [CONN]: _d, ...rest } = m; return rest; };
            return {
                connectionTriggers: drop(s.connectionTriggers),
                connectionButtons: drop(s.connectionButtons),
            };
        });
        g.window = prevWindow;
        g.document = prevDocument;
    }
}

const triggers = () => (useAppStore.getState().connectionTriggers[CONN] ?? []) as TriggerNode[];
const buttons = () => useAppStore.getState().connectionButtons[CONN] ?? [];

describe('mudlet-web#238 item 1 — multi-pattern perm triggers in a group', () => {
    type Creator = 'createPermRegexTrigger' | 'createPermSubstringTrigger'
        | 'createPermBeginOfLineStringTrigger' | 'createPermExactMatchTrigger';
    const cases: [Creator, string[], string[]][] = [
        ['createPermSubstringTrigger', ['papaya', 'guava'], ['papaya one', 'a guava']],
        ['createPermRegexTrigger', ['^papaya', 'guava$'], ['papaya one', 'a guava']],
        ['createPermBeginOfLineStringTrigger', ['papaya', 'guava'], ['papaya one', 'guava two']],
        ['createPermExactMatchTrigger', ['papaya', 'guava'], ['papaya', 'guava']],
    ];

    for (const [creator, patterns, lines] of cases) {
        it(`${creator} under a group is an OR trigger that fires on each pattern`, () => {
            withEngine((engine, triggerEngine) => {
                expect(engine.createPermRegexTrigger('VG', '', [], '')).toBeGreaterThan(0);
                expect(engine[creator]('vmulti', 'VG', patterns, 'x = 1')).toBeGreaterThan(0);
                const node = triggers().find(t => t.name === 'vmulti')!;
                expect(node.multiline).toBe(false);
                expect(node.patterns.map(p => p.text)).toEqual(patterns);

                triggerEngine.loadPerm(triggers());
                for (const line of lines) {
                    const fired = triggerEngine.matchPerm(line).filter(m => m.trigger.name === 'vmulti');
                    expect(fired, `did not fire on "${line}"`).toHaveLength(1);
                }
            });
        });
    }

    it('still makes an AND trigger at the root, as desktop does', () => {
        withEngine(engine => {
            engine.createPermSubstringTrigger('vroot', '', ['papaya', 'guava'], 'x = 1');
            expect(triggers().find(t => t.name === 'vroot')!.multiline).toBe(true);
        });
    });
});

describe('mudlet-web#238 item 2 — setTriggerStayOpen on the trigger itself', () => {
    const node = (id: string, name: string, pattern: string, extra: Partial<TriggerNode> = {}): TriggerNode => ({
        id, name, isGroup: false, parentId: null, enabled: true, language: 'lua', code: 'x()',
        patterns: [{ type: 'regex', text: pattern }], fireLength: 0, multipleMatches: false,
        multiline: false, delta: 0, isFilter: false, ...extra,
    } as TriggerNode);

    /** Feed `lines`, running `script` for each firing, and list what fired where. */
    function feed(engine: InstanceType<typeof TriggerEngine>, lines: string[],
        script: (m: TriggerMatch, line: string) => void): string[] {
        const fired: string[] = [];
        for (const line of lines) {
            engine.process(line, false, m => {
                fired.push(`${m.trigger.name}@${line}`);
                script(m, line);
            });
        }
        return fired;
    }

    it('does not keep a trigger firing that opened its own window', () => {
        const engine = new TriggerEngine();
        engine.loadPerm([node('vself', 'vself', '^VOPEN')]);
        const fired = feed(engine, ['VOPEN', 'y1', 'y2'], m => {
            if (m.trigger.id === 'vself') engine.setStayOpen(['vself'], 2);
        });
        expect(fired).toEqual(['vself@VOPEN']);
    });

    it('still opens ANOTHER trigger\'s window', () => {
        const engine = new TriggerEngine();
        engine.loadPerm([node('opener', 'opener', '^VOPEN'), node('target', 'target', '^never-matches$')]);
        const fired = feed(engine, ['VOPEN', 'y1', 'y2', 'y3'], m => {
            if (m.trigger.id === 'opener') engine.setStayOpen(['target'], 2);
        });
        // The window starts on the line it was opened on; target sorts after
        // opener, so it sees that line too.
        expect(fired).toEqual(['opener@VOPEN', 'target@VOPEN', 'target@y1', 'target@y2']);
    });

    it('keeps the trigger\'s own fire length when the script re-arms itself', () => {
        const engine = new TriggerEngine();
        engine.loadPerm([node('vlen', 'vlen', '^VOPEN', { fireLength: 1 })]);
        // Only the run on the matching line re-arms: a run the fire length
        // replays is not a match, and desktop decrements mKeepFiring BEFORE
        // that run, so a call from it does stand.
        const fired = feed(engine, ['VOPEN', 'y1', 'y2', 'y3'], (m, line) => {
            if (m.trigger.id === 'vlen' && line === 'VOPEN') engine.setStayOpen(['vlen'], 3);
        });
        expect(fired).toEqual(['vlen@VOPEN', 'vlen@y1']);
    });

    it('does not keep a temporary trigger firing that opened its own window', () => {
        const engine = new TriggerEngine();
        const fired: string[] = [];
        let current = '';
        engine.addTemp('VOPEN', () => {
            fired.push(current);
            engine.setTempStayOpen('selfTemp', 2);
        }, 'substring', { name: 'selfTemp' });
        for (const line of ['VOPEN', 'y1', 'y2']) {
            current = line;
            engine.process(line, false, () => {});
        }
        expect(fired).toEqual(['VOPEN']);
    });

    it('closes a temporary trigger\'s window when it matches', () => {
        const engine = new TriggerEngine();
        const fired: string[] = [];
        let current = '';
        engine.addTemp('VOPEN', () => { fired.push(current); }, 'substring', { name: 'win' });
        expect(engine.setTempStayOpen('win', 3)).toBe(true);
        for (const line of ['y0', 'VOPEN', 'y1', 'y2']) {
            current = line;
            engine.process(line, false, () => {});
        }
        expect(fired).toEqual(['y0', 'VOPEN']);
    });
});

describe('mudlet-web#238 item 3 — tempButton / tempButtonToolbar duplicates', () => {
    it('refuses a toolbar or button name that is already taken', () => {
        withEngine(engine => {
            const toolbar = engine.createTempButtonToolbar('VT', 0, 0);
            expect(toolbar).toBeGreaterThan(0);
            expect(engine.createTempButtonToolbar('VT', 0, 0)).toBe(-1);
            const button = engine.createTempButton('VT', 'VB', 0);
            expect(button).toBeGreaterThan(0);
            expect(engine.createTempButton('VT', 'VB', 0)).toBe(-1);
            // findAction(name) is not limited to one kind: a button's name
            // blocks a toolbar and a toolbar's name blocks a button.
            expect(engine.createTempButtonToolbar('VB', 0, 0)).toBe(-1);
            expect(engine.createTempButton('VT', 'VT', 0)).toBe(-1);
            expect(engine.createTempButton('missing', 'VC', 0)).toBe(-1);
            expect(buttons().map(b => b.name)).toEqual(['VT', 'VB']);
        });
    });

});
