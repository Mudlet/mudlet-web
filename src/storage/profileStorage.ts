// Erasing one profile's storage.
//
// A profile's data is spread across several browser stores, and deleting the
// connection only ever dropped the in-memory/localStorage slices. Everything
// keyed by connection id elsewhere survived — most of it an entire IndexedDB
// database per profile — with no way left to reach it, because the id is
// regenerated for the next profile. Desktop Mudlet removes the profile
// directory from disk (`mudlet::getMudletPath(profileHomePath, ...)`, deleted
// by dlgProfilePreferences' profile deletion), so the promise the confirmation
// dialog makes is kept there.
//
// Inventory of what is keyed by connection id, and how this module treats it:
//   mudix_vfs_<id>  IndexedDB database — the whole profile VFS. Deleted.
//   mudix_maps      IndexedDB, `maps` store, one record per id. Record deleted.
//   mudix_folder_handles  IndexedDB, `handles` store, one record per id.
//                   Record deleted — the linked folder itself is the user's own
//                   directory on their disk and is never touched.
//   mudix_logs      IndexedDB, sessions + entries. This profile's rows deleted.
//   localStorage    cmd.history.<id>, mudix_stopwatches_<id>, and this
//                   profile's slice of the v21 migration backup. Deleted.
//
// Every one of these is addressed by the id being deleted, so no other
// profile's data is reachable from here.

import { deleteSessionsForConnection } from './logStorage';
import { deleteMap } from './mapStorage';
import { clearFolderHandle } from '../scripting/vfs/folderHandleStore';
import { historyStorageKey } from '../ui/commandHistory';
import { stopwatchStorageKey } from '../scripting/StopwatchManager';

/** localStorage key holding the one-time v21 profile-data migration backup,
 *  a `{ [connectionId]: slices }` map consumed on each profile's next open. */
export const MIGRATION_BACKUP_KEY = 'mudix_profile_migration_v21';

/** Name of the IndexedDB database backing a profile's ZenFS mount. Must match
 *  the `storeName` ProfileVFS.doMount passes to the IndexedDB backend. */
export function profileVfsDatabaseName(connectionId: string): string {
    return `mudix_vfs_${connectionId}`;
}

/** Delete a profile's ZenFS database outright. */
function deleteProfileVfsDatabase(connectionId: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return Promise.resolve();
    return new Promise(resolve => {
        const req = indexedDB.deleteDatabase(profileVfsDatabaseName(connectionId));
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        // Something still holds the database open — another tab, or a mount this
        // tab hasn't torn down. The request stays queued and completes when that
        // connection closes; don't make the caller wait on it.
        req.onblocked = () => resolve();
    });
}

/** Drop this profile's entry from the v21 migration backup, and the key itself
 *  once it holds nothing else. */
function clearMigrationBackup(connectionId: string): void {
    try {
        const raw = localStorage.getItem(MIGRATION_BACKUP_KEY);
        if (!raw) return;
        const all = JSON.parse(raw) as Record<string, unknown>;
        if (!(connectionId in all)) return;
        delete all[connectionId];
        if (Object.keys(all).length === 0) localStorage.removeItem(MIGRATION_BACKUP_KEY);
        else localStorage.setItem(MIGRATION_BACKUP_KEY, JSON.stringify(all));
    } catch {
        /* best-effort */
    }
}

/**
 * Erase everything stored for one profile outside the app store: its VFS
 * database, its map, its linked-folder handle, its logs and its per-profile
 * localStorage keys. See the inventory at the top of this file.
 *
 * Best-effort throughout — a store that fails to open must not stop the rest,
 * and the caller (removeConnection) is synchronous and does not await this.
 */
export async function deleteProfileStorage(connectionId: string): Promise<void> {
    clearMigrationBackup(connectionId);
    try { localStorage.removeItem(historyStorageKey(connectionId)); } catch { /* best-effort */ }
    try { localStorage.removeItem(stopwatchStorageKey(connectionId)); } catch { /* best-effort */ }

    await Promise.allSettled([
        deleteProfileVfsDatabase(connectionId),
        deleteMap(connectionId),
        clearFolderHandle(connectionId),
        deleteSessionsForConnection(connectionId),
    ]);
}
