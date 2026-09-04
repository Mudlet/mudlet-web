// @vitest-environment node
//
// Mudlet's saveProfile([location [, saveName]]) writes the profile out as a
// Mudlet-format XML save. Host::saveProfile picks the path — an empty folder
// means the profile's own current/, an empty name means a YYYY-MM-DD#HH-mm-ss
// stamp — and TLuaInterpreter::saveProfile appends .xml to a name that lacks
// one before Host ever sees it. Getting that naming wrong stays invisible until
// Mudlet loads the profile and picks the wrong file, or none, so it is pinned
// here alongside what actually lands in the document.
//
// Node env + a stubbed LuaRuntime, the same shape host-send.test.ts uses: the
// engine boots a runtime in its constructor, and no part of the save path goes
// near Lua.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/scripting/lua/LuaRuntime', () => ({
    LuaRuntime: {
        create: () => Promise.resolve({
            load: () => {}, emitEvent: () => {}, processInput: () => false,
            runWithMatches: () => {}, destroy: () => {}, run: () => {},
            evalTriggerPattern: () => false, shiftCaptureSpans: () => {},
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
type ProfileVFS = import('../../src/scripting/vfs/ProfileVFS').ProfileVFS;

// Minimal DOM for the engine constructor, installed after the imports (pcre2
// picks node-vs-browser loading at module init — see createTestRuntime).
const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };

// The writer builds the save through DOMParser/XMLSerializer, and teardown
// sweeps the document for its own <style> tags — node has none of that.
// Borrowing a standalone happy-dom window keeps this file in the node
// environment, which pcre2 (pulled in by TriggerEngine) requires.
const { Window } = await import('happy-dom');
const domWindow = new Window();
g.document = domWindow.document;
g.DOMParser = domWindow.DOMParser;
g.XMLSerializer = domWindow.XMLSerializer;

const CONN = 'save-profile-conn';
const PROFILE_ROOT = `/profiles/${CONN}`;

/** A Map-backed VFS covering the handful of methods the save path touches. */
function fakeVfs(seed: Record<string, string> = {}) {
    const files = new Map<string, string>(Object.entries(seed));
    const vfs = {
        profilePath: PROFILE_ROOT,
        resolvePath: (p: string) => (p.startsWith('/') ? p : `${PROFILE_ROOT}/${p}`),
        exists: (p: string) => files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)),
        readFile: (p: string) => {
            const v = files.get(p);
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return v;
        },
        readdir: (p: string) => [...files.keys()]
            .filter(k => k.startsWith(`${p}/`))
            .map(k => k.slice(p.length + 1)),
        stat: () => ({ mtime: new Date(0) }),
        writeFile: (p: string, content: string) => { files.set(p, content); },
        flush: () => Promise.resolve(),
    };
    return { vfs: vfs as unknown as ProfileVFS, files };
}

describe('saveProfile — the XML save it writes', () => {
    const engines: InstanceType<typeof ScriptingEngine>[] = [];

    const makeEngine = (vfs: ProfileVFS) => {
        const engine = new ScriptingEngine(
            new MudSession(), new AliasEngine(), new TriggerEngine(),
            new TimerEngine(), new KeyEngine(), CONN, 'Test', () => undefined, vfs,
        );
        engines.push(engine);
        return engine;
    };

    beforeEach(() => {
        useAppStore.getState().hydrateConnectionData(CONN, {});
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Test', url: 'ws://localhost' }],
            }));
        }
    });

    afterEach(() => {
        // The constructor starts a timer pump; leaving it running leaks it into
        // the next test.
        while (engines.length) engines.pop()?.destroy();
    });

    it('defaults to a timestamped file in the profile current/ folder', () => {
        const { vfs, files } = fakeVfs();
        const res = makeEngine(vfs).saveProfileXml();

        expect(res.ok).toBe(true);
        const written = [...files.keys()];
        expect(written).toHaveLength(1);
        // Mudlet's stamp: YYYY-MM-DD#HH-mm-ss.xml, in current/.
        expect(written[0]).toMatch(/^current\/\d{4}-\d{2}-\d{2}#\d{2}-\d{2}-\d{2}\.xml$/);
        // The path answered back is the absolute one, as Host::saveProfile's is.
        expect(res.ok && res.path).toBe(`${PROFILE_ROOT}/${written[0]}`);
    });

    it('honours an explicit location and appends .xml to a name that lacks one', () => {
        const { vfs, files } = fakeVfs();

        expect(makeEngine(vfs).saveProfileXml('backups', 'before-refactor').ok).toBe(true);
        expect([...files.keys()]).toEqual(['backups/before-refactor.xml']);
    });

    it('does not double up the suffix on a name that already has one', () => {
        const { vfs, files } = fakeVfs();

        expect(makeEngine(vfs).saveProfileXml('backups/', 'snapshot.XML').ok).toBe(true);
        expect([...files.keys()]).toEqual(['backups/snapshot.XML']);
    });

    it('writes the live automation tree into the save', () => {
        const { vfs, files } = fakeVfs();
        useAppStore.getState().addAlias(CONN, {
            name: 'greet', enabled: true, isGroup: false, parentId: null,
            pattern: '^hi$', command: 'say hello', code: '', language: 'lua',
        });

        expect(makeEngine(vfs).saveProfileXml('out', 'x').ok).toBe(true);
        const xml = files.get('out/x.xml') ?? '';
        expect(xml).toContain('<MudletPackage');
        // A profile with no save to base on still gets a HostPackage — Mudlet
        // will not load one without it.
        expect(xml).toContain('HostPackage');
        expect(xml).toContain('greet');
    });

    it('bases the save on an existing Mudlet save, keeping what mudix does not model', () => {
        // A <Host> field mudix has no idea about has to survive the round-trip;
        // dropping it silently resets that setting in Mudlet.
        const base = '<?xml version="1.0" encoding="UTF-8"?>'
            + '<MudletPackage version="1.001"><HostPackage>'
            + '<Host mSomethingMudixNeverModels="yes"><mSomeUnmodelledField>keep me</mSomeUnmodelledField></Host>'
            + '</HostPackage><TriggerPackage/></MudletPackage>';
        const { vfs, files } = fakeVfs({ 'current/2020-01-01#00-00-00.xml': base });

        expect(makeEngine(vfs).saveProfileXml('out', 'copy').ok).toBe(true);
        const xml = files.get('out/copy.xml') ?? '';
        expect(xml).toContain('mSomethingMudixNeverModels="yes"');
        expect(xml).toContain('keep me');
    });

    it('reports a failure rather than throwing when the write is refused', () => {
        const { vfs } = fakeVfs();
        (vfs as unknown as { writeFile: () => void }).writeFile = () => {
            throw new Error('disk is full');
        };

        const res = makeEngine(vfs).saveProfileXml();
        expect(res.ok).toBe(false);
        expect(res.ok === false && res.err).toContain('disk is full');
    });
});
