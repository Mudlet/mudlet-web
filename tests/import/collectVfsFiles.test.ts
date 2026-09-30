// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { configure, InMemory, mkdirSync, writeFileSync } from '@zenfs/core';
import { strFromU8 } from 'fflate';
import { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';
import { collectVfsFiles } from '../../src/import/collectProfileExport';

/**
 * Issue #261: "Export profiles…" carried none of the profile folder's files —
 * the walk listed the ZenFS root (`readdir('/')`) instead of the profile, so
 * packages, modules and script-written data were all left behind. Driven over
 * a real ProfileVFS on an in-memory ZenFS so path resolution is the real one.
 */

const ID = 'export-walk';
const PROFILE = `/profiles/${ID}`;

describe('collectVfsFiles — the profile folder in an export', () => {
    let vfs: ProfileVFS;

    beforeAll(async () => {
        await configure({ mounts: { '/': InMemory } });
        mkdirSync(PROFILE, { recursive: true });
        // Another profile's files sit beside this one at the ZenFS root; none
        // of them may leak in.
        mkdirSync('/profiles/other', { recursive: true });
        writeFileSync('/profiles/other/secret.txt', 'not mine');
        const Ctor = ProfileVFS as unknown as new (id: string, fs: unknown, source: string) => ProfileVFS;
        vfs = new Ctor(ID, {}, 'idb');
        vfs.writeFile('mydata.txt', 'hello');
        vfs.writeFile('sub/t.lua', 'return 1');
        vfs.writeFile('generic_mapper/generic_mapper.xml', '<MudletPackage/>');
        vfs.writeFile('mudlet-base-ui/config.lua', 'mpackage = "x"');
        vfs.writeBinaryFile('mudlet-base-ui/img/bg.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        vfs.writeFile('mymodule.xml', '<MudletPackage/>');
        vfs.writeFile('.mudlet/profile.json', '{}');
        vfs.writeFile('.mudix/profile.json', '{}');
    });

    it('carries packages, modules and script-written data, relative to the profile root', () => {
        const files = collectVfsFiles(vfs);
        expect(Object.keys(files).sort()).toEqual([
            'generic_mapper/generic_mapper.xml',
            'mudlet-base-ui/config.lua',
            'mudlet-base-ui/img/bg.png',
            'mydata.txt',
            'mymodule.xml',
            'sub/t.lua',
        ]);
        expect(strFromU8(files['mydata.txt'])).toBe('hello');
        expect([...files['mudlet-base-ui/img/bg.png']]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('does not depend on the Lua working directory', () => {
        expect(vfs.chdir('sub')).toBeNull();
        try {
            expect(Object.keys(collectVfsFiles(vfs))).toContain('mydata.txt');
        } finally {
            vfs.chdir(PROFILE);
        }
    });
});
