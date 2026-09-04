// @vitest-environment node
//
// Issue #104: a package and a module could hold one name at the same time.
// Both installs succeeded, in either order, and each silently displaced the
// other from its own listing while both halves' items stayed in the store under
// that one name. Uninstalling either half then took both halves' items with it,
// because removal works by name alone — the user uninstalls a package and loses
// a module's triggers and scripts, unwarned.
//
// Desktop refuses both directions (`Host::installPackage`, Host.cpp:2567 and
// :2584), and deliberately exempts profile loading so a profile saved before
// the check existed goes on opening. mudix gets that exemption structurally:
// reopening a profile replays its modules through `reloadModuleFromVfs`, which
// is not an install path and reaches none of this.
//
// Mocked Lua runtime and node env for the same reasons as
// installPackageRefusal.test.ts, whose harness this follows.
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

const CONN = 'name-collision-conn';
const PROFILE = '/profiles/test';
const NAME = 'shared';
const PKG_ARCHIVE = `${PROFILE}/shared-pkg.mpackage`;
const MOD_ARCHIVE = `${PROFILE}/shared-mod.mpackage`;

/** One script apiece, so each half has an item that a wrong uninstall would
 *  take with it. */
const xml = (scriptName: string) => `<?xml version="1.0" encoding="UTF-8"?>
<MudletPackage version="1.001">
  <ScriptPackage>
    <Script isActive="yes" isFolder="no">
      <name>${scriptName}</name>
      <packageName></packageName>
      <script>echo("hi")</script>
      <eventHandlerList />
    </Script>
  </ScriptPackage>
</MudletPackage>`;

/** Both archives declare the SAME mpackage name from different file names —
 *  which is the shape that makes this worth refusing after config.lua rather
 *  than on the file name, and is how the issue was reproduced. */
function archive(scriptName: string): Uint8Array {
    return zipSync({
        'pkg.xml': strToU8(xml(scriptName)),
        'config.lua': strToU8(`mpackage = [[${NAME}]]\n`),
    });
}

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

describe('a package and a module may not share one name', () => {
    let engine: InstanceType<typeof ScriptingEngine>;
    let session: InstanceType<typeof MudSession>;
    let vfs: ProfileVFS;

    beforeEach(() => {
        if (!useAppStore.getState().connections.some(c => c.id === CONN)) {
            useAppStore.setState(s => ({
                connections: [...s.connections, { id: CONN, name: 'Collision', url: 'ws://localhost' }],
            }));
        }
        useAppStore.setState(st => ({ connectionPackages: { ...st.connectionPackages, [CONN]: [] } }));
        session = new MudSession();
        engine = new ScriptingEngine(
            session, new AliasEngine(), new TriggerEngine(), new TimerEngine(), new KeyEngine(), CONN,
        );
        vfs = stubVfs();
        (engine as unknown as { vfs: ProfileVFS }).vfs = vfs;
        vfs.writeBinaryFile(PKG_ARCHIVE, archive('fromPackage'));
        vfs.writeBinaryFile(MOD_ARCHIVE, archive('fromModule'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try { engine.destroy(); } catch { /* teardown best-effort */ }
    });

    const REFUSED_BY_PACKAGE = `A package called "${NAME}" is already installed. `
        + 'Please uninstall it first or choose a different name.';
    const REFUSED_BY_MODULE = `A module called "${NAME}" is already installed. `
        + 'Please uninstall it first or choose a different name.';

    it('refuses a module over an installed package, keeping the package listed', () => {
        expect(engine.installPackageFromVfsPath(PKG_ARCHIVE)).toEqual({ ok: true, error: null });

        expect(engine.installModuleFromPath(MOD_ARCHIVE))
            .toEqual({ ok: false, error: REFUSED_BY_PACKAGE });

        // The package used to vanish from its own listing at this point.
        expect(engine.getPackageNames()).toContain(NAME);
        expect(engine.getModuleNames()).not.toContain(NAME);
    });

    it('refuses a package over an installed module, keeping the module listed', () => {
        expect(engine.installModuleFromPath(MOD_ARCHIVE)).toEqual({ ok: true, error: null });

        expect(engine.installPackageFromVfsPath(PKG_ARCHIVE))
            .toEqual({ ok: false, error: REFUSED_BY_MODULE });

        expect(engine.getModuleNames()).toContain(NAME);
        expect(engine.getPackageNames()).not.toContain(NAME);
    });

    it('leaves the refused half\'s items out of the store', () => {
        expect(engine.installPackageFromVfsPath(PKG_ARCHIVE)).toEqual({ ok: true, error: null });
        engine.installModuleFromPath(MOD_ARCHIVE);

        // Both sets of items under one name is what makes an uninstall take the
        // other half's work with it, so the refusal has to stop them landing.
        const names = (useAppStore.getState().connectionScripts[CONN] ?? []).map(s => s.name);
        expect(names).toContain('fromPackage');
        expect(names).not.toContain('fromModule');
    });

    it('does not touch the installed half\'s files', () => {
        expect(engine.installPackageFromVfsPath(PKG_ARCHIVE)).toEqual({ ok: true, error: null });
        expect(vfs.exists(`${PROFILE}/${NAME}/pkg.xml`)).toBe(true);

        engine.installModuleFromPath(MOD_ARCHIVE);

        // The refusal is decided before commit(), so nothing was written and
        // nothing was wiped — the same property issue #101 turned on.
        expect(vfs.exists(`${PROFILE}/${NAME}/pkg.xml`)).toBe(true);
    });

    it('still allows the two halves to coexist under different names', () => {
        expect(engine.installPackageFromVfsPath(PKG_ARCHIVE)).toEqual({ ok: true, error: null });

        // A module whose config.lua names it something else is no collision.
        const other = `${PROFILE}/other.mpackage`;
        vfs.writeBinaryFile(other, zipSync({
            'pkg.xml': strToU8(xml('fromOtherModule')),
            'config.lua': strToU8('mpackage = [[otherName]]\n'),
        }));

        expect(engine.installModuleFromPath(other)).toEqual({ ok: true, error: null });
        expect(engine.getPackageNames()).toContain(NAME);
        expect(engine.getModuleNames()).toContain('otherName');
    });

    it('answers on the name config.lua settles on, not the archive\'s file name', () => {
        // The two archives are called shared-pkg / shared-mod and would not
        // collide on file name at all; only the manifest name they share does.
        expect(engine.installPackageFromVfsPath(PKG_ARCHIVE)).toEqual({ ok: true, error: null });
        expect(engine.installModuleFromPath(MOD_ARCHIVE).error).toBe(REFUSED_BY_PACKAGE);
    });
});
