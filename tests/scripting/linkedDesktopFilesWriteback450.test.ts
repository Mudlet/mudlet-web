// @vitest-environment node
//
// Issue #450: a linked Mudlet folder gets this client's server encoding, TLS
// and character name written back to desktop's own files for them, in
// desktop's format, alongside the save write-back. Harness as
// savedVariableDrift360.test.ts: an in-memory VFS and a mocked Lua runtime.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, startSpeedWalk: () => {},
            restoreVariables: () => {}, captureVariables: () => [],
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
const { decodeProfileData, encodeProfileData } = await import('../../src/import/qtProfileData');
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
const domWindow = new Window();
g.DOMParser = domWindow.DOMParser;
g.XMLSerializer = domWindow.XMLSerializer;

const CONN = 'linked-files-450';
const PROFILE = '/profiles/test';
const SAVE = 'current/2026-06-26#11-57-29.xml';
const XML = '<?xml version="1.0" encoding="UTF-8"?><MudletPackage version="1.001"><HostPackage><Host>'
    + '<name>Desk</name><url>game.example</url><port>4000</port></Host></HostPackage></MudletPackage>';

function stubVfs(initial: Record<string, string | Uint8Array>) {
    const files = new Map<string, Uint8Array>();
    const rel = (p: string) => (p.startsWith(`${PROFILE}/`) ? p.slice(PROFILE.length + 1) : p);
    for (const [k, v] of Object.entries(initial)) files.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v);
    const vfs = {
        profilePath: PROFILE,
        exists: (p: string) => files.has(rel(p)) || [...files.keys()].some(k => k.startsWith(`${rel(p)}/`)),
        mkdir: () => {},
        writeFile: (p: string, data: string) => { files.set(rel(p), new TextEncoder().encode(data)); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(rel(p), data); },
        readBinaryFile: (p: string) => {
            const v = files.get(rel(p));
            if (!v) throw new Error(`ENOENT: ${p}`);
            return v;
        },
        readFile: (p: string) => {
            const v = files.get(rel(p));
            if (!v) throw new Error(`ENOENT: ${p}`);
            return new TextDecoder().decode(v);
        },
        readdir: (p: string) => [...new Set([...files.keys()]
            .filter(k => k.startsWith(`${rel(p)}/`))
            .map(k => k.slice(rel(p).length + 1).split('/')[0]))],
        stat: () => ({ mtime: new Date(0) }),
        resolvePath: (p: string) => (p.startsWith('/') ? p : `${PROFILE}/${p}`),
        flush: async () => {},
    };
    return { vfs: vfs as unknown as ProfileVFS, files };
}

describe('linked folder profile-file write-back (mudlet-web#450)', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let files: Map<string, Uint8Array>;
    const flush = () => (engine as unknown as { flushProfileData(): void }).flushProfileData();
    const text = (name: string) => (files.has(name) ? decodeProfileData(files.get(name)!) : undefined);

    async function setUp(linked: boolean, initial: Record<string, string | Uint8Array>) {
        useAppStore.setState(s => ({
            connections: [
                ...s.connections.filter(c => c.id !== CONN),
                { id: CONN, name: 'Desk', mode: 'mud', host: 'game.example', port: 4000, ...(linked ? { mudletLinked: true } : {}) },
            ],
        }));
        useAppStore.getState().hydrateConnectionData(CONN, {});
        engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        await (engine as unknown as { runtimeReady: Promise<unknown> }).runtimeReady;
        let vfs: ProfileVFS;
        ({ vfs, files } = stubVfs({ [SAVE]: XML, ...initial }));
        (engine as unknown as { vfs: ProfileVFS }).vfs = vfs;
        vi.spyOn(engine, 'raiseEvent').mockImplementation(() => {});
    }

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('writes the encoding, TLS and character name in desktop\'s format', async () => {
        await setUp(true, { ssl_tsl: encodeProfileData('0'), password: encodeProfileData('secret123') });
        useAppStore.getState().patchConnection(CONN, { tls: true, charLoginAccount: 'Hero' });
        useAppStore.getState().patchConnectionProfile(CONN, { serverEncoding: 'ISO 8859-1' });
        flush();
        expect(text('ssl_tsl')).toBe('2');
        expect(text('login')).toBe('Hero');
        expect(text('encoding')).toBe('ISO 8859-1');
        // The password file is desktop's, and left exactly as it was.
        expect(files.get('password')).toEqual(encodeProfileData('secret123'));
    });

    it('leaves a Mudlet Web profile that only called saveProfile() alone (#259)', async () => {
        await setUp(false, {});
        useAppStore.getState().patchConnection(CONN, { tls: true, charLoginAccount: 'Hero' });
        flush();
        expect(files.has('ssl_tsl')).toBe(false);
        expect(files.has('login')).toBe(false);
    });
});
