// #438: a package's own font (MedUI ships one) was missing from
// getAvailableFonts() inside sysInstallPackage, and inside sysLoadEvent after a
// restart, so the package's own setFont silently failed — the family turned up
// a moment later. The face only went into document.fonts once
// `FontFace.load()` had resolved, and each font of a package waited for the one
// before it, while the install and load events are raised synchronously.
//
// Desktop's font database has the family as soon as `loadFont` returns. Here
// the face is added to document.fonts as its load starts, which is what
// getAvailableFonts() reads (getRegisteredFontFamilies). These tests hold the
// loads open and look at the list before anything has settled.
//
// The real fontLoader runs; FontFace and document.fonts are stubbed, and the
// family-name parser is replaced by "the file's bytes are its family", which
// packageFonts.test.ts already covers for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/fontFamilyName', async (orig) => ({
    ...(await orig<typeof import('../../src/utils/fontFamilyName')>()),
    fontFamilyName: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
}));

const { installPackageFonts, refreshPackageFonts } = await import('../../src/import/packageFonts');
const { getRegisteredFontFamilies } = await import('../../src/utils/fontLoader');
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import type { PackageManifest } from '../../src/storage/schema';

/** Every FontFace made, with the hooks to settle its load by hand. */
let faces: Array<{ family: string; resolve: () => void; reject: (e: Error) => void }>;
let fontSet: Set<{ family: string }>;

beforeEach(() => {
    faces = [];
    fontSet = new Set();
    vi.stubGlobal('FontFace', class {
        private readonly loading: Promise<this>;
        constructor(readonly family: string) {
            let resolve!: () => void;
            let reject!: (e: Error) => void;
            this.loading = new Promise<this>((res, rej) => { resolve = () => res(this); reject = rej; });
            faces.push({ family, resolve, reject });
        }
        load() { return this.loading; }
    });
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: {
            add: (f: { family: string }) => fontSet.add(f),
            delete: (f: { family: string }) => fontSet.delete(f),
            addEventListener: () => {},
            [Symbol.iterator]: () => fontSet[Symbol.iterator](),
        },
    });
});

let profileSeq = 0;

/** A VFS holding `files` (path under the profile → family), with listings. */
function stubVfs(files: Record<string, string>): ProfileVFS {
    // A fresh profile path per test: loadFontFromVfs remembers what it loaded
    // by profile + path + family, across tests.
    const root = `/profiles/early-${++profileSeq}`;
    const abs = new Map(Object.entries(files).map(([p, fam]) => [`${root}/${p}`, fam]));
    const dirs = new Set<string>();
    for (const p of abs.keys()) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return {
        profilePath: root,
        exists: (p: string) => abs.has(p) || dirs.has(p),
        readdir: (p: string) => {
            if (!dirs.has(p)) throw new Error(`ENOTDIR: ${p}`);
            const out = new Set<string>();
            for (const c of [...abs.keys(), ...dirs]) {
                if (c.startsWith(`${p}/`)) out.add(c.slice(p.length + 1).split('/')[0]);
            }
            return [...out];
        },
        readBinaryFile: (p: string) => new TextEncoder().encode(abs.get(p) ?? ''),
    } as unknown as ProfileVFS;
}

const manifest = (name: string) => ({ name, installedAt: '' }) as PackageManifest;

describe('package fonts are listed before the install and load events (#438)', () => {
    it('lists every font of a package as soon as the install registers them', async () => {
        const vfs = stubVfs({
            'MedUI/fonts/a.ttf': 'MedUI Icons',
            'MedUI/fonts/sub/b.otf': 'MedUI Text',
        });
        const done = installPackageFonts(manifest('MedUI'), vfs);
        // Nothing has loaded yet — this is where sysInstallPackage is raised.
        expect(getRegisteredFontFamilies()).toEqual(expect.arrayContaining(['MedUI Icons', 'MedUI Text']));
        for (const f of faces) f.resolve();
        expect((await done).registered.sort()).toEqual(['MedUI Icons', 'MedUI Text']);
    });

    it('lists the fonts of every installed package on profile open, before any load settles', async () => {
        const vfs = stubVfs({
            'one/f.ttf': 'First Font',
            'two/g.ttf': 'Second Font',
        });
        const done = refreshPackageFonts([manifest('one'), manifest('two')], vfs);
        // Where sysLoadEvent is raised.
        expect(getRegisteredFontFamilies()).toEqual(expect.arrayContaining(['First Font', 'Second Font']));
        for (const f of faces) f.resolve();
        expect((await done).warnings).toEqual([]);
    });

    it('does not add a second face for a font whose load is still under way', () => {
        const vfs = stubVfs({ 'pkg/f.ttf': 'Only Once' });
        void installPackageFonts(manifest('pkg'), vfs);
        void installPackageFonts(manifest('pkg'), vfs);
        expect(faces.map(f => f.family)).toEqual(['Only Once']);
    });

    it('takes a font that will not load back out, and says so', async () => {
        const vfs = stubVfs({ 'pkg/broken.ttf': 'Broken Font' });
        const done = installPackageFonts(manifest('pkg'), vfs);
        expect(getRegisteredFontFamilies()).toContain('Broken Font');
        faces[0].reject(new Error('OTS parsing error'));
        const result = await done;
        expect(getRegisteredFontFamilies()).not.toContain('Broken Font');
        expect(result.registered).toEqual([]);
        expect(result.warnings).toEqual(['the font "pkg/broken.ttf" (Broken Font) could not be loaded: OTS parsing error']);
    });
});
