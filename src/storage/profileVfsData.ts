import type {
    ScriptNode,
    AliasNode,
    TriggerNode,
    TimerNode,
    KeyNode,
    ButtonNode,
    PackageManifest,
    ProfileSettings,
    ScriptEditorBounds,
    ModalBounds,
    WindowLayoutSnapshot,
    ProfileVariables,
} from './schema';
import { useAppStore, MIGRATION_BACKUP_KEY } from './appStore';
import type { WindowOpenOptions } from '../ui/windows/types';
import type { ProfileVFS } from '../scripting/vfs/ProfileVFS';

/**
 * Per-profile data is stored inside that profile's own VFS rather than the
 * shared localStorage blob — see the design notes in CLAUDE.md / the storage
 * layer. One JSON file per profile holds the bulky tree data (scripts, aliases,
 * triggers, …) AND the per-profile UI/settings/layout slices, so the only
 * per-profile state left in localStorage is the connection record itself. That
 * makes each profile single-writer (one tab owns it via the cross-tab lock),
 * eliminating the multi-tab clobber the shared blob suffered.
 *
 * The file is dot-prefixed so it stays out of the way in the user-browsable
 * file area. `ProfileVFS.writeFile` creates the `.mudix/` parent dir for us.
 */
export const PROFILE_DATA_PATH = '.mudix/profile.json';

/** Bumped if the on-disk shape changes incompatibly. (2: added the UI/layout/
 *  settings slices that used to live in localStorage.) */
const PROFILE_DATA_VERSION = 2;

export interface PersistedProfileData {
    version: number;
    // Automation trees.
    scripts: ScriptNode[];
    aliases: AliasNode[];
    triggers: TriggerNode[];
    timers: TimerNode[];
    keybindings: KeyNode[];
    buttons: ButtonNode[];
    packages: PackageManifest[];
    /** Mudlet saved-variables: the save-list + last captured values. Optional so
     *  older files (no variables) still parse. */
    variables?: ProfileVariables;
    // UI / settings / layout (one profile's entry from each shared map). Optional
    // so v1 files (automation only) still parse.
    profile?: Partial<ProfileSettings>;
    windowHints?: Record<string, WindowOpenOptions>;
    dockExtents?: Record<string, number>;
    scriptEditorBounds?: ScriptEditorBounds;
    modalBounds?: Record<string, ModalBounds>;
    layoutSnapshot?: WindowLayoutSnapshot;
}

/** One profile's slice of the v21 migration backup (see MIGRATION_BACKUP_KEY). */
type MigrationBackupEntry = Pick<PersistedProfileData,
    'profile' | 'windowHints' | 'dockExtents' | 'scriptEditorBounds' | 'modalBounds' | 'layoutSnapshot'>;

function readMigrationBackup(connectionId: string): MigrationBackupEntry | undefined {
    try {
        const raw = localStorage.getItem(MIGRATION_BACKUP_KEY);
        if (!raw) return undefined;
        const all = JSON.parse(raw) as Record<string, MigrationBackupEntry>;
        return all[connectionId];
    } catch {
        return undefined;
    }
}

/** Drop one profile from the migration backup once it's been written to its VFS;
 *  remove the key entirely when the last profile is migrated. */
function consumeMigrationBackup(connectionId: string): void {
    try {
        const raw = localStorage.getItem(MIGRATION_BACKUP_KEY);
        if (!raw) return;
        const all = JSON.parse(raw) as Record<string, MigrationBackupEntry>;
        delete all[connectionId];
        if (Object.keys(all).length === 0) localStorage.removeItem(MIGRATION_BACKUP_KEY);
        else localStorage.setItem(MIGRATION_BACKUP_KEY, JSON.stringify(all));
    } catch {
        /* best-effort */
    }
}

/**
 * Read `.mudix/profile.json` from the profile VFS and push it into the store
 * for `connectionId`. Also completes the one-time v21 migration: if this
 * profile's UI/settings/layout slices haven't moved into the VFS yet, they're
 * pulled from the migration backup, hydrated, written to the VFS, and dropped
 * from the backup. No-op for a fresh profile with nothing to load.
 */
export function loadProfileData(vfs: ProfileVFS, connectionId: string): void {
    const fileExists = vfs.exists(PROFILE_DATA_PATH);
    let fileData: Partial<PersistedProfileData> = {};
    if (fileExists) {
        try {
            fileData = JSON.parse(vfs.readFile(PROFILE_DATA_PATH)) as Partial<PersistedProfileData>;
        } catch (err) {
            console.warn('[profileVfsData] failed to parse', PROFILE_DATA_PATH, err);
            return;
        }
    }
    const backup = readMigrationBackup(connectionId);
    if (!fileExists && !backup) return; // fresh profile, nothing to load

    // The file is authoritative once migrated; the backup is the fallback for a
    // profile whose UI data hasn't moved into the VFS yet.
    useAppStore.getState().hydrateConnectionData(connectionId, {
        scripts: fileData.scripts,
        aliases: fileData.aliases,
        triggers: fileData.triggers,
        timers: fileData.timers,
        keybindings: fileData.keybindings,
        buttons: fileData.buttons,
        packages: fileData.packages,
        variables: fileData.variables,
        profile: fileData.profile ?? backup?.profile,
        windowHints: fileData.windowHints ?? backup?.windowHints,
        dockExtents: fileData.dockExtents ?? backup?.dockExtents,
        scriptEditorBounds: fileData.scriptEditorBounds ?? backup?.scriptEditorBounds,
        modalBounds: fileData.modalBounds ?? backup?.modalBounds,
        layoutSnapshot: fileData.layoutSnapshot ?? backup?.layoutSnapshot,
    });

    // First open after the v21 upgrade: persist the merged UI data into the
    // profile's VFS, then drop this profile from the one-time backup.
    if (backup) {
        saveProfileData(vfs, connectionId);
        consumeMigrationBackup(connectionId);
    }
}

/**
 * The triggers that belong in the saved profile: everything except the
 * session-scoped ones `tempComplexRegexTrigger` creates, and anything hanging
 * under them.
 *
 * The descendants matter as much as the temporaries themselves. A permanent
 * trigger can be parented to a temporary one — Mudlet allows it, and its own
 * specs do it — and that child dies with its parent at the end of the session.
 * Saving it alone would restore a trigger whose `parentId` names a node that
 * was never written, leaving it orphaned in the tree.
 */
function persistableTriggers(triggers: TriggerNode[]): TriggerNode[] {
    if (!triggers.some(t => t.temporary)) return triggers;
    const byId = new Map(triggers.map(t => [t.id, t]));
    const isTemporary = (node: TriggerNode): boolean => {
        let cur: TriggerNode | undefined = node;
        const guard = new Set<string>();
        while (cur && !guard.has(cur.id)) {
            if (cur.temporary) return true;
            guard.add(cur.id);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return false;
    };
    return triggers.filter(t => !isTemporary(t));
}

/** Serialize a profile's automation + UI slices for `connectionId` from the store. */
export function serializeProfileData(connectionId: string): string {
    const s = useAppStore.getState();
    const payload: PersistedProfileData = {
        version: PROFILE_DATA_VERSION,
        scripts: s.connectionScripts[connectionId] ?? [],
        aliases: s.connectionAliases[connectionId] ?? [],
        triggers: persistableTriggers(s.connectionTriggers[connectionId] ?? []),
        timers: s.connectionTimers[connectionId] ?? [],
        keybindings: s.connectionKeybindings[connectionId] ?? [],
        buttons: s.connectionButtons[connectionId] ?? [],
        packages: s.connectionPackages[connectionId] ?? [],
        variables: s.connectionVariables[connectionId],
        profile: s.connectionProfile[connectionId],
        windowHints: s.connectionWindowHints[connectionId],
        dockExtents: s.connectionDockExtents[connectionId],
        scriptEditorBounds: s.connectionScriptEditorBounds[connectionId],
        modalBounds: s.connectionModalBounds[connectionId],
        layoutSnapshot: s.connectionLayoutSnapshots[connectionId],
    };
    return JSON.stringify(payload);
}

/** Write the current store state for `connectionId` to the profile VFS. */
export function saveProfileData(vfs: ProfileVFS, connectionId: string): void {
    vfs.writeFile(PROFILE_DATA_PATH, serializeProfileData(connectionId));
}
