// Persists FileSystemDirectoryHandle objects per connection in a separate IDB
// from the IndexedDB-backed ZenFS stores so handle lifetime is independent of
// VFS contents. Handles are structured-cloneable, but permission must be
// re-confirmed on each page load via queryPermission/requestPermission.

// File System Access API surface that lib.dom doesn't expose yet.
type PermissionDescriptor = { mode?: 'read' | 'readwrite' };
type PermissionState = 'granted' | 'denied' | 'prompt';
interface FsAccessHandle {
    queryPermission?: (desc?: PermissionDescriptor) => Promise<PermissionState>;
    requestPermission?: (desc?: PermissionDescriptor) => Promise<PermissionState>;
}
interface ShowDirectoryPickerOptions { mode?: 'read' | 'readwrite' }
declare global {
    interface Window {
        showDirectoryPicker?: (options?: ShowDirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
    }
}

import { whenIdbNamesMigrated } from '../../storage/storageMigration';

const DB_NAME = 'mudlet_folder_handles';
const STORE_NAME = 'handles';

export type FolderPermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported';

async function openDb(): Promise<IDBDatabase> {
    // Was `mudix_folder_handles` before the storage namespace rename.
    await whenIdbNamesMigrated();
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function isFolderLinkSupported(): boolean {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function saveFolderHandle(connectionId: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, connectionId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadFolderHandle(connectionId: string): Promise<FileSystemDirectoryHandle | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(connectionId);
        req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
        req.onerror = () => reject(req.error);
    });
}

export async function clearFolderHandle(connectionId: string): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(connectionId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function checkFolderPermission(handle: FileSystemDirectoryHandle): Promise<FolderPermissionState> {
    const h = handle as FileSystemDirectoryHandle & FsAccessHandle;
    if (typeof h.queryPermission !== 'function') return 'unsupported';
    try {
        return (await h.queryPermission({ mode: 'readwrite' })) as FolderPermissionState;
    } catch {
        return 'denied';
    }
}

export async function requestFolderPermission(handle: FileSystemDirectoryHandle): Promise<FolderPermissionState> {
    const h = handle as FileSystemDirectoryHandle & FsAccessHandle;
    if (typeof h.requestPermission !== 'function') return 'unsupported';
    try {
        return (await h.requestPermission({ mode: 'readwrite' })) as FolderPermissionState;
    } catch {
        return 'denied';
    }
}
