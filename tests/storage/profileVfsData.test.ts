import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore, MIGRATION_BACKUP_KEY } from '../../src/storage/appStore';
import {
    loadProfileData,
    saveProfileData,
    PROFILE_DATA_PATH,
} from '../../src/storage/profileVfsData';
import type { ProfileVFS } from '../../src/scripting/vfs/ProfileVFS';

// profileVfsData only touches three ProfileVFS methods, so a Map-backed stub is
// enough to exercise the store <-> JSON round-trip without ZenFS/IndexedDB.
function fakeVfs(): ProfileVFS {
    const files = new Map<string, string>();
    return {
        exists: (p: string) => files.has(p),
        readFile: (p: string) => {
            const v = files.get(p);
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return v;
        },
        writeFile: (p: string, content: string) => { files.set(p, content); },
    } as unknown as ProfileVFS;
}

const CONN = 'test-conn';

describe('profileVfsData', () => {
    beforeEach(() => {
        useAppStore.getState().hydrateConnectionData(CONN, {});
        localStorage.removeItem(MIGRATION_BACKUP_KEY);
    });

    it('round-trips automation + UI slices through the profile VFS', () => {
        const vfs = fakeVfs();
        const store = useAppStore.getState();

        store.addAlias(CONN, {
            name: 'greet', enabled: true, isGroup: false, parentId: null,
            pattern: '^hi$', command: 'say hello', code: '', language: 'lua',
        });
        store.addButton(CONN, {
            name: 'attack', enabled: true, isGroup: false, parentId: null,
            orientation: 'horizontal', location: 'top', columns: 0,
            isPushDown: false, buttonState: false, code: '', language: 'lua',
            command: 'kill rat',
        });
        // UI/settings/layout slices now live in the same file.
        store.patchConnectionProfile(CONN, { fontSize: 18, theme: 'amber' });
        store.saveDockExtents(CONN, { left: 240 });

        saveProfileData(vfs, CONN);
        expect(vfs.exists(PROFILE_DATA_PATH)).toBe(true);
        const parsed = JSON.parse(vfs.readFile(PROFILE_DATA_PATH));
        expect(parsed.version).toBe(3);
        expect(parsed.aliases).toHaveLength(1);
        expect(parsed.buttons).toHaveLength(1);
        expect(parsed.profile).toMatchObject({ fontSize: 18, theme: 'amber' });
        expect(parsed.dockExtents).toEqual({ left: 240 });

        // Wipe in-memory state, then reload from the VFS.
        useAppStore.getState().hydrateConnectionData(CONN, {});
        useAppStore.setState(s => ({
            connectionProfile: { ...s.connectionProfile, [CONN]: {} },
            connectionDockExtents: { ...s.connectionDockExtents, [CONN]: {} },
        }));
        expect(useAppStore.getState().connectionAliases[CONN]).toEqual([]);

        loadProfileData(vfs, CONN);
        const after = useAppStore.getState();
        expect(after.connectionAliases[CONN]).toHaveLength(1);
        expect(after.connectionAliases[CONN][0].command).toBe('say hello');
        expect(after.connectionButtons[CONN]).toHaveLength(1);
        expect(after.connectionButtons[CONN][0].name).toBe('attack');
        expect(after.connectionProfile[CONN]).toMatchObject({ fontSize: 18, theme: 'amber' });
        expect(after.connectionDockExtents[CONN]).toEqual({ left: 240 });
    });

    it('migrates UI slices from the backup key on first open, then drains it', () => {
        const vfs = fakeVfs();
        // A v1-style file (automation only) + a backup entry for this profile.
        useAppStore.getState().hydrateConnectionData(CONN, {});
        saveProfileData(vfs, CONN); // writes a file without UI slices...
        // ...simulate it being a pre-migration file by stripping the UI keys.
        const bare = JSON.parse(vfs.readFile(PROFILE_DATA_PATH));
        delete bare.profile; delete bare.dockExtents;
        vfs.writeFile(PROFILE_DATA_PATH, JSON.stringify(bare));
        localStorage.setItem(MIGRATION_BACKUP_KEY, JSON.stringify({
            [CONN]: { profile: { fontSize: 22 }, dockExtents: { right: 300 } },
        }));

        loadProfileData(vfs, CONN);

        // Backup data is applied...
        const after = useAppStore.getState();
        expect(after.connectionProfile[CONN]).toMatchObject({ fontSize: 22 });
        expect(after.connectionDockExtents[CONN]).toEqual({ right: 300 });
        // ...written into the VFS file...
        const reparsed = JSON.parse(vfs.readFile(PROFILE_DATA_PATH));
        expect(reparsed.profile).toMatchObject({ fontSize: 22 });
        // ...and the backup entry consumed (last profile → key removed).
        expect(localStorage.getItem(MIGRATION_BACKUP_KEY)).toBeNull();
    });

    it('widens a pre-v3 multiline trigger whose delta meant "no limit"', () => {
        const vfs = fakeVfs();
        // A v2 file: `delta: 0` there meant an unbounded AND chain, while from
        // v3 on it carries Mudlet's meaning (all conditions on the one line).
        const trigger = (id: string, multiline: boolean, delta: number) => ({
            id, name: id, enabled: true, isGroup: false, parentId: null,
            patterns: [{ type: 'regex', text: '^a$' }], code: '', language: 'lua',
            fireLength: 0, multipleMatches: false, multiline, delta, isFilter: false,
        });
        vfs.writeFile(PROFILE_DATA_PATH, JSON.stringify({
            version: 2,
            triggers: [trigger('and0', true, 0), trigger('and5', true, 5), trigger('or0', false, 0)],
        }));

        loadProfileData(vfs, CONN);

        const loaded = useAppStore.getState().connectionTriggers[CONN];
        expect(loaded.find(t => t.id === 'and0')!.delta).toBe(99);
        expect(loaded.find(t => t.id === 'and5')!.delta).toBe(5);   // an explicit delta is kept
        expect(loaded.find(t => t.id === 'or0')!.delta).toBe(0);    // not an AND trigger, untouched

        // The rewrite is stamped straight back so a deliberate 0 saved later
        // isn't widened again on the next open.
        const written = JSON.parse(vfs.readFile(PROFILE_DATA_PATH));
        expect(written.version).toBe(3);
        expect(written.triggers.find((t: { id: string }) => t.id === 'and0').delta).toBe(99);

        useAppStore.getState().updateTrigger(CONN, 'and0', { delta: 0 });
        saveProfileData(vfs, CONN);
        loadProfileData(vfs, CONN);
        expect(useAppStore.getState().connectionTriggers[CONN].find(t => t.id === 'and0')!.delta).toBe(0);
    });

    it('loadProfileData is a no-op when the file is absent', () => {
        const vfs = fakeVfs();
        useAppStore.getState().addAlias(CONN, {
            name: 'keep', enabled: true, isGroup: false, parentId: null,
            pattern: 'x', command: 'y', code: '', language: 'lua',
        });
        loadProfileData(vfs, CONN); // no .mudix/profile.json present
        // Absent file must not clobber existing in-memory state.
        expect(useAppStore.getState().connectionAliases[CONN]).toHaveLength(1);
    });

    it('loadProfileData ignores a corrupt file', () => {
        const vfs = fakeVfs();
        vfs.writeFile(PROFILE_DATA_PATH, '{ not json');
        expect(() => loadProfileData(vfs, CONN)).not.toThrow();
        expect(useAppStore.getState().connectionAliases[CONN]).toEqual([]);
    });
});
