// @vitest-environment node
//
// Input-pipeline drift measured against the Mudlet PTB (mudlet-web#336), with
// desktop's result as the expectation:
//  1. An alias or key added at runtime into an older group runs where it sits
//     in the tree, not after every item created since.
//  4. setConfig("inputLineStrictUnixEndings", …) governs the very next send,
//     in the same chunk, as desktop's per-send read of mUSE_UNIX_EOL does.
//
// The command-line history items (2, 3) are in
// tests/ui/commandHistoryDrift336.test.ts.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {},
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
const { inTreeOrder } = await import('../../src/storage/schema');
const { default: Pcre2 } = await import('../../src/mud/triggers/pcre/Pcre2');
type AliasNode = import('../../src/storage/schema').AliasNode;
type KeyNode = import('../../src/storage/schema').KeyNode;

const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;

const CONN = 'input-drift-336-conn';

beforeAll(async () => {
    await Pcre2.init();
});

function alias(id: string, parentId: string | null, pattern: string, isGroup = false): AliasNode {
    return {
        id, name: id, parentId, pattern, isGroup, enabled: true,
        code: '', command: '', language: 'lua',
    } as AliasNode;
}

function key(id: string, parentId: string | null, isGroup = false): KeyNode {
    return {
        id, name: id, parentId, isGroup, enabled: true,
        key: isGroup ? '' : 'F5', modifiers: [], code: '', language: 'lua',
    } as KeyNode;
}

const f5 = { code: 'F5', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as KeyboardEvent;

describe('mudlet-web#336 item 1 — runtime-added items take their tree position', () => {
    it('inTreeOrder walks each group whole, siblings in store order', () => {
        // Store order as permAlias leaves it: AGb appended after A2.
        const items = [
            alias('A1', null, 'o'), alias('AG', null, '', true), alias('AGa', 'AG', 'o'),
            alias('A2', null, 'o'), alias('AGb', 'AG', 'o'),
        ];
        expect(inTreeOrder(items).map(i => i.id)).toEqual(['A1', 'AG', 'AGa', 'AGb', 'A2']);
    });

    it('inTreeOrder keeps orphans and items caught in a parent cycle', () => {
        const items = [
            alias('x', 'missing', 'o'), alias('c1', 'c2', 'o'), alias('c2', 'c1', 'o'), alias('r', null, 'o'),
        ];
        expect(inTreeOrder(items).map(i => i.id).sort()).toEqual(['c1', 'c2', 'r', 'x']);
        expect(inTreeOrder(items)[0].id).toBe('x');
    });

    it('aliases: a child appended to an older group fires inside it, before later roots', () => {
        const engine = new AliasEngine();
        engine.loadPerm([
            alias('A1', null, 'o'), alias('AG', null, '', true), alias('AGa', 'AG', 'o'),
            alias('A2', null, 'o'), alias('AGb', 'AG', 'o'),
        ]);
        const fired: string[] = [];
        engine.process('o', hit => fired.push(hit.alias.id));
        expect(fired).toEqual(['A1', 'AGa', 'AGb', 'A2']);
        engine.destroy();
    });

    it('aliases: the seeded-tree case keeps a later root alias last', () => {
        const engine = new AliasEngine();
        engine.loadPerm([
            alias('A1', null, 'o'), alias('G1', null, '', true), alias('G1a', 'G1', 'o'),
            alias('A2', null, 'o'), alias('PA_in_G1', 'G1', 'o'), alias('PA_root', null, 'o'),
        ]);
        expect(engine.matchAllPerm('o').map(h => h.alias.id))
            .toEqual(['A1', 'G1a', 'PA_in_G1', 'A2', 'PA_root']);
        engine.destroy();
    });

    it('keys: a key added to an older group wins over a root key made before it', () => {
        const engine = new KeyEngine();
        engine.loadPerm([key('KG', null, true), key('Kroot', null), key('Kgroup', 'KG')]);
        expect(engine.matchPerm(f5)?.id).toBe('Kgroup');
        expect(engine.matchAllPerm(f5).map(k => k.id)).toEqual(['Kgroup', 'Kroot']);
        engine.destroy();
    });
});

describe('mudlet-web#336 items 1 and 4 — through the scripting API', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let aliases: InstanceType<typeof AliasEngine>;
    let keys: InstanceType<typeof KeyEngine>;

    type Api = {
        setConfig: (key: string, value: unknown) => boolean | string;
        getConfig: (key: string) => unknown;
        permAlias: (name: string, parent: string, pattern: string, code: string) => number;
        permKey: (name: string, parent: string, modifier: number, key: string | number, code: string) => number;
    };
    const api = () => (engine as unknown as { api: Api }).api;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Drift 336', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(s => ({
            connectionProfile: { ...s.connectionProfile, [CONN]: {} },
            connectionAliases: { ...s.connectionAliases, [CONN]: [] },
            connectionKeybindings: { ...s.connectionKeybindings, [CONN]: [] },
        }));
        session = new MudSession();
        aliases = new AliasEngine();
        keys = new KeyEngine();
        engine = new ScriptingEngine(session, aliases, new TriggerEngine(), new TimerEngine(), keys, CONN);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
        useAppStore.setState(s => {
            const { [CONN]: _a, ...restAliases } = s.connectionAliases;
            const { [CONN]: _k, ...restKeys } = s.connectionKeybindings;
            return { connectionAliases: restAliases, connectionKeybindings: restKeys };
        });
    });

    it('permAlias/permKey into an older group land in tree order', () => {
        api().permAlias('A1', '', 'o', 'x');
        api().permAlias('AG', '', '', '');
        api().permAlias('AGa', 'AG', 'o', 'x');
        api().permAlias('A2', '', 'o', 'x');
        api().permAlias('AGb', 'AG', 'o', 'x');
        aliases.loadPerm(useAppStore.getState().connectionAliases[CONN] ?? []);
        expect(aliases.matchAllPerm('o').map(h => h.alias.name)).toEqual(['A1', 'AGa', 'AGb', 'A2']);

        api().permKey('Kgroup-folder', '', -1, -1, '');
        api().permKey('Kroot', '', 0, 'F5', 'x');
        api().permKey('Kgroup', 'Kgroup-folder', 0, 'F5', 'x');
        keys.loadPerm(useAppStore.getState().connectionKeybindings[CONN] ?? []);
        expect(keys.matchPerm(f5)?.name).toBe('Kgroup');
    });

    it('setConfig("inputLineStrictUnixEndings") reaches the session before the next send', () => {
        const live = vi.spyOn(session, 'setInputLineStrictUnixEndings');
        expect(api().setConfig('inputLineStrictUnixEndings', true)).toBe(true);
        expect(live).toHaveBeenLastCalledWith(true);
        expect(api().getConfig('inputLineStrictUnixEndings')).toBe(true);
        expect(api().setConfig('inputLineStrictUnixEndings', false)).toBe(true);
        expect(live).toHaveBeenLastCalledWith(false);
        expect(api().getConfig('inputLineStrictUnixEndings')).toBe(false);
    });
});
