// @vitest-environment node
//
// Node env + a mocked Lua runtime, for the same reasons as
// serverGuiInstalled.test.ts: pcre2 (pulled in by TriggerEngine) can't fetch its
// WASM under happy-dom, and none of the Lua side is needed here. The installer
// itself is real — the order it does things in is exactly what's under test.
//
// Issue #101: `installPackage()` on a name that is already installed refused
// the install *after* it had wiped the package's directory, so the ordinary act
// of re-installing a package to update it left the profile with a package that
// was listed, had items in the store, and had no files behind it — and could
// not be repaired, because re-installing hit the same refusal.
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

// Minimal DOM for the engine constructor, installed after the imports (pcre2
// picks node-vs-browser loading at module init).
const noopDom = {
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
    querySelectorAll: () => [] as unknown[],
};
const g = globalThis as Record<string, unknown>;
g.window = { innerWidth: 1024, innerHeight: 768, ...noopDom, matchMedia: () => ({ matches: false, ...noopDom }) };
g.document = noopDom;
// parseMudletXml reads the package XML through DOMParser; a standalone
// happy-dom window supplies one without moving the file out of the node
// environment. Same borrowing as saveProfileXml.test.ts.
const { Window } = await import('happy-dom');
g.DOMParser = new Window().DOMParser;

const CONN = 'install-refusal-conn';
const PROFILE = '/profiles/test';
const PKG_DIR = `${PROFILE}/mypkg`;
const ARCHIVE = `${PROFILE}/mypkg.mpackage`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <ScriptPackage>
    <Script isActive="yes" isFolder="no">
      <name>hello</name>
      <packageName></packageName>
      <script>echo("hi")</script>
      <eventHandlerList />
    </Script>
  </ScriptPackage>
</MudletPackage>`;

function archive(): Uint8Array {
    return zipSync({
        'mypkg.xml': strToU8(XML),
        'config.lua': strToU8('mpackage = [[mypkg]]\n'),
        'resources/logo.txt': strToU8('a resource the package ships'),
    });
}

/** In-memory ProfileVFS stand-in with a recursive rmdir, like the real one. */
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
        writeFile: (p: string, data: string) => { files.set(p, data); },
        writeBinaryFile: (p: string, data: Uint8Array) => { files.set(p, data); },
        readFile: (p: string) => String(files.get(p) ?? ''),
        readBinaryFile: (p: string) => files.get(p) as Uint8Array,
        flush: async () => {},
    } as unknown as ProfileVFS;
}

describe('installPackage() refusing a name that is already installed', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let vfs: ProfileVFS;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Refusal', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(st => ({ connectionPackages: { ...st.connectionPackages, [CONN]: [] } }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        vfs = stubVfs();
        (engine as unknown as { vfs: ProfileVFS }).vfs = vfs;
        vfs.writeBinaryFile(ARCHIVE, archive());
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    it('keeps the installed copy\'s files when the same package is installed twice', () => {
        expect(engine.installPackageFromVfsPath(ARCHIVE)).toEqual({ ok: true, error: null });
        expect(vfs.readFile(`${PKG_DIR}/resources/logo.txt`)).toBe('a resource the package ships');

        expect(engine.installPackageFromVfsPath(ARCHIVE))
            .toEqual({ ok: false, error: 'package mypkg is already installed' });

        // The refusal is right; the wipe that used to precede it was not. The
        // package is still listed, so its files have to still be there.
        expect(engine.getPackageNames()).toContain('mypkg');
        expect(vfs.readFile(`${PKG_DIR}/resources/logo.txt`)).toBe('a resource the package ships');
        expect(vfs.exists(`${PKG_DIR}/mypkg.xml`)).toBe(true);
    });

    it('keeps them when the second install is a corrupt archive of the same name', () => {
        expect(engine.installPackageFromVfsPath(ARCHIVE)).toEqual({ ok: true, error: null });

        vfs.writeBinaryFile(ARCHIVE, strToU8('not a zip, an error page'));
        const result = engine.installPackageFromVfsPath(ARCHIVE);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('could not unzip package');
        expect(vfs.readFile(`${PKG_DIR}/resources/logo.txt`)).toBe('a resource the package ships');
    });
});
